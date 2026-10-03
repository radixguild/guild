import type { OnChainTaskState, PartyOutstanding } from "@/lib/gateway"
import { autoResolvePayout } from "@/lib/dispute-outcome"
import { formatXrdUsd } from "@/lib/format-xrd-usd"

/** The operator ceremony the dispute alert points at. Named once so a rename of
 *  the harness cannot leave a dead command sitting in a money-path alert. */
const ARBITER_HARNESS = "scripts/arbiter-harness.mjs"

// Escrow drift classification — the pure half of the state-parity drift watcher
// (scripts/escrow-drift-watch.mjs). Kept side-effect-free so it can be unit
// tested without the Gateway or DB.
//
// The watcher exists because the event-replay reconciler (reconcile-escrow.mjs)
// is BLIND to a whole class of drift: when on_chain_task_id collides across an
// escrow-component cutover, it resolves a chain event to the wrong DB row and
// skips the heal (a stale `open` task whose on-chain escrow was actually
// refunded stays `open`, and keeps burning claimers' lock fees). Comparing the
// DB status to the task's LIVE on-chain state catches exactly that.

// DB statuses that are NOT yet terminal — the ones the live chain state can
// still legitimately be ahead of, so the ones a lost confirm can strand.
//
// ⚠️ This list scopes the STATE-parity pass ONLY, and that scoping stopped being
// sufficient under PULL. It used to carry the line "terminal rows are settled;
// the watcher leaves them alone" — true when `Released` meant the money had
// moved. It does not any more: a task is `paid` in the DB and `Released` on
// chain while the worker's funds sit in the component, unwithdrawn (§5c).
// **Lifecycle-terminal is no longer money-terminal.**
//
// So the MONEY-parity predicates below deliberately do NOT use this list — they
// must look at exactly the rows it excludes. Widening it instead would be the
// wrong fix twice over: it would make the state pass tolerate a lagging status
// (the drift it exists to catch), and it still would not look at entitlements.
export const NON_TERMINAL_DB_STATUSES = [
  "open",
  "assigned",
  "submitted",
  "disputed",
] as const

// Live on-chain TaskState → the DB status(es) that correctly reflect it.
// `Refunded` maps to BOTH `cancelled` (poster cancel of an open/claimed task)
// and `refunded` (poster-favoured dispute auto-resolve) — the blueprint
// collapses both outcomes to the same on-chain state.
//
// The mapping is deliberately STRICT: each on-chain state maps ONLY to the DB
// status(es) that already reflect it, never to the earlier statuses a
// not-yet-confirmed transition would still show. That is the point — a task
// whose DB status lags its chain state IS the drift we exist to catch (task #5:
// db `open`, chain `Refunded`). Broadening the mapping to tolerate lagging
// statuses would mask exactly that. The cost is a rare, self-clearing false
// positive if the watcher runs in the seconds between an on-chain tx and its
// client confirm; that is accepted on purpose, because the watcher is stateless
// (it re-derives from chain every run) and so has NO false-negative risk — the
// property that matters most for a money-path safety alert.
const EXPECTED_DB_STATUS: Record<OnChainTaskState, readonly string[]> = {
  Open: ["open"],
  Claimed: ["assigned"],
  Submitted: ["submitted"],
  Disputed: ["disputed"],
  Released: ["paid"],
  Refunded: ["cancelled", "refunded"],
}

/** DB status(es) that correctly reflect a given live on-chain state. */
export function expectedDbStatusesForOnChain(
  state: OnChainTaskState,
): readonly string[] {
  return EXPECTED_DB_STATUS[state] ?? []
}

/** True when the DB status already reflects the live on-chain state. */
export function isDbStatusInSyncWithChain(
  dbStatus: string,
  state: OnChainTaskState,
): boolean {
  return expectedDbStatusesForOnChain(state).includes(dbStatus)
}

/**
 * The dangerous drift class: the DB still presents the task as claimable
 * (`open`) while the chain has left `Open`. A worker — human or agent — who
 * acts on that signal sends a claim that reverts on the blueprint's
 * `must be Open` assert and burns the lock fee. The watcher escalates this
 * flavour so an operator (and the claim guard) can heal the row.
 */
export function isClaimableButNotOpen(
  dbStatus: string,
  state: OnChainTaskState,
): boolean {
  return dbStatus === "open" && state !== "Open"
}

// ── MONEY parity (redesign §5c / §11b chunk E) ────────────────────────────────
//
// A SECOND predicate, deliberately independent of DB status. Under pull, state
// parity can be perfect — DB `paid`, chain `Released`, the two agree — while the
// worker has not been paid at all. The state pass would report OK, correctly and
// uselessly, on precisely the condition that costs someone money.
//
// ⚠️ The obvious fix is a regression, which is why this is a separate pass and
// not a widened mapping. Adding `settled` to `EXPECTED_DB_STATUS.Released` makes
// the watcher ACCEPT the unpaid state as in-sync, and the affected rows are
// terminal so `NON_TERMINAL_DB_STATUSES` never loads them anyway. Both halves of
// that fix fail in the same direction: silently.

/** How long a settled entitlement may sit uncollected before it is worth a nudge. */
export const DEFAULT_UNCOLLECTED_GRACE_MS = 24 * 60 * 60 * 1000

/**
 * Whether the money check can run at all against this component.
 *
 * ⚠️ Load-bearing, and the quietest trap in this chunk. A PRE-PULL escrow
 * carries no entitlement fields, so every amount reads "0" — indistinguishable
 * from a task that settled and was fully collected. A check that treated that
 * as "nothing owed" would be permanently silent against such a component
 * **and would look exactly like a healthy watcher.** (Written when the deployed
 * escrow was pre-pull; the live Wave B component carries the fields, and the
 * guard stays for any retired component still read.) `gateway.ts`
 * returns null rather than "0" for exactly this reason; this is the other half.
 */
export function canAssessMoneyParity(info: { entitlementsPresent: boolean }): boolean {
  return info.entitlementsPresent
}

export type MoneyParityVerdict =
  /** The component cannot report entitlements — the check did NOT run. Never "clean". */
  | { kind: "unassessable" }
  /** Entitlements readable and everything owed has been collected. */
  | { kind: "settled" }
  /** Owed but recent — inside the grace window, so not yet worth waking anyone. */
  | { kind: "uncollected-recent"; outstanding: PartyOutstanding }
  /** Owed and stale. Someone's money is sitting in the component. */
  | { kind: "uncollected-stale"; outstanding: PartyOutstanding }

/**
 * Classify one party's position on a settled task.
 *
 * `outstanding` is the PER-LANE pair from gateway.outstandingForParty — null
 * meaning "cannot say", NOT zero. Each lane is compared as a scaled BigInt so an
 * amount with 18 decimal places (past what a double holds) can never round to
 * zero and report as settled.
 *
 * ⚠️ The lanes are tested INDEPENDENTLY and never added. They are different
 * resources — reward is the task's reward token, bond is always XRD — and this
 * function previously received their sum, which both of its callers then
 * labelled "XRD". "Owed" means EITHER lane is positive; a task can owe a bond
 * refund and nothing else, and that must still alert.
 */
export function classifyMoneyParity(
  outstanding: PartyOutstanding | null,
  settledAt: Date | null,
  now: Date,
  graceMs: number = DEFAULT_UNCOLLECTED_GRACE_MS,
): MoneyParityVerdict {
  if (outstanding === null) return { kind: "unassessable" }
  const owed = isPositiveDecimal(outstanding.reward) || isPositiveDecimal(outstanding.bondXrd)
  if (!owed) return { kind: "settled" }
  // No timestamp = no way to tell recent from stale. Treat as stale: this is a
  // money-path alert, so the failure direction has to be "tell someone".
  const ageMs = settledAt ? now.getTime() - settledAt.getTime() : Number.POSITIVE_INFINITY
  return ageMs >= graceMs
    ? { kind: "uncollected-stale", outstanding }
    : { kind: "uncollected-recent", outstanding }
}

/**
 * True for a decimal string strictly greater than zero, at full 18dp precision.
 *
 * Exported so the withdraw UI (chunk G) decides "is anything owed" with the
 * SAME predicate the watcher alerts on. A second copy is how the two would
 * drift into disagreeing about whether a worker is owed money — which is
 * exactly the class of split-definition bug this phase keeps finding.
 */
export function isPositiveDecimal(v: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(v)) return false
  const [whole, frac = ""] = v.split(".")
  return BigInt(whole + frac.padEnd(18, "0").slice(0, 18)) > BigInt(0)
}

// ── Reward-resource flip prep (dispute alert labelling) ───────────────────────
//
// The live-dispute scan (escrow-drift-watch.mjs) reads a task's escrowed value
// straight from the component's per-task vault BALANCE, which carries no
// resource address — so the only place that knows the reward resource is the
// DB row (tasks.reward_resource, NULL = XRD), looked up by the same
// (onChainTaskId, escrowComponent) pin the rest of the watcher uses to stay
// collision-safe across component cutovers. Kept here, not inline in the
// script, for the same reason as the rest of this module: pure and
// unit-testable without the Gateway or DB.

/**
 * Resolve a disputed task's DB row into a display unit, or null when unknown.
 *
 * A found row is trusted per `reward_resource`'s own contract (NULL = XRD).
 * An unmatched row (pre-backfill, or genuinely absent) returns null so the
 * caller omits the unit entirely rather than guess — the same rule
 * describeOwed() already follows when it has no resource signal.
 */
export function disputeResourceLabel(
  dbTask: { rewardResource: string | null } | null | undefined,
): string | null {
  return dbTask ? (dbTask.rewardResource ?? "XRD") : null
}

/**
 * Whether a dispute's value should be compared against the XRD-denominated
 * ALERT_MIN_XRD paging threshold at all.
 *
 * That threshold is a plain number of XRD. A stablecoin dispute's amount is
 * not the same magnitude, and there is no price feed to convert one into the
 * other — so comparing them directly would silently mis-page once the reward
 * resource flips. A KNOWN non-XRD resource must therefore always page
 * (never threshold-gated); only XRD or an unmatched/unknown resource (the
 * conservative default) is comparable to the threshold at all.
 */
export function isThresholdComparableResource(resource: string | null): boolean {
  return resource === null || resource === "XRD"
}

/** How often the "money check inactive" condition is worth re-stating. */
export const DEFAULT_INACTIVE_DIGEST_MS = 24 * 60 * 60 * 1000

/**
 * Is the "money check inactive" digest due?
 *
 * ⚠️ This exists because the inactive condition was reported ONLY as a `log()`
 * line: no alert, no effect on the exit code. So the cron exited 0 every 30
 * minutes into a logfile nobody reads, and a run where the money half did
 * nothing at all was byte-indistinguishable from a clean one. Silence read as
 * health, which is the exact failure the money-parity pass was built to end.
 *
 * The original reasoning for not alerting was RIGHT and is preserved: against
 * the pre-pull component this condition holds on every row on every run, so an
 * unconditional alert fires 48× a day, gets the channel muted, and takes the
 * real drift alert down with it. A rate limit keeps the condition audible
 * without that.
 *
 * Fails toward TELLING SOMEONE: an unreadable or malformed stamp is treated as
 * due rather than as recently-sent, because the failure mode being fixed here is
 * a condition that goes unmentioned. Over-reporting is visible and gets fixed;
 * under-reporting is what produced this defect.
 */
export function isInactiveDigestDue(
  lastSentIso: string | null,
  now: Date,
  intervalMs: number = DEFAULT_INACTIVE_DIGEST_MS,
): boolean {
  if (lastSentIso === null) return true
  const last = new Date(lastSentIso).getTime()
  if (!Number.isFinite(last)) return true
  // A stamp in the future is a clock change or a corrupt file, not a recent
  // send. Treat it as due rather than letting it suppress alerts indefinitely.
  if (last > now.getTime()) return true
  return now.getTime() - last >= intervalMs
}

// ── Live-dispute escalation (pass 3) ────────────────────────────────────────
//
// Pass 3 pages a human about a live dispute. It used to page on EVERY run for
// the whole 72h window — up to 144 identical messages for one incident — on the
// stated reasoning that "being noisy is the safe direction". That reasoning
// holds for a LAPSED window and nothing else: pre-lapse, a message whose only
// changing part is a countdown does not make anyone act sooner, it trains them
// to swipe the channel away and takes the lapsed alert that matters with it.
//
// This logic lives here rather than inline in escrow-drift-watch.mjs for the
// same reason everything else in this file does: it decides whether a
// money-path alert fires, so it has to be testable without a Gateway.

/**
 * Escalation stages, in order. Each fires ONCE per on-chain task — except
 * `lapsed`, see `isDisputeStageNew`.
 */
export const DISPUTE_STAGES = ["raised", "half", "closing", "lapsed"] as const
export type DisputeStage = (typeof DISPUTE_STAGES)[number]

/**
 * Which stage a dispute is in, from the time left before the auto-resolve
 * window closes.
 *
 * ⚠️ `msLeft === null` means the deadline is UNREADABLE (no `disputed_at` on
 * chain) and maps to `lapsed` — NOT to `closing`. `lapsed` is the only stage
 * that keeps re-firing, and a deadline nobody can measure must never end up
 * quieter than one they can. The first version of this mapped it to `closing`
 * under the comment "unknown deadline reads as urgent"; that stamped it as sent
 * and then went permanently silent on the one dispute with no clock on it.
 */
export function disputeStageFor(msLeft: number | null, windowMs: number): DisputeStage {
  if (msLeft === null) return "lapsed"
  if (msLeft <= 0) return "lapsed"
  // A non-positive or non-finite window would divide to Infinity/NaN and
  // silently classify every dispute as `raised` — the quietest stage. Same
  // rule as above: unmeasurable is never quiet.
  if (!(windowMs > 0)) return "lapsed"
  const frac = msLeft / windowMs
  if (frac <= 0.1) return "closing"
  if (frac <= 0.5) return "half"
  return "raised"
}

/**
 * Is this stage worth a message, given the highest stage already sent?
 *
 * `lapsed` is the deliberate exception and always returns true. Past the window
 * the outcome becomes a RACE, not a theft: `auto_resolve_dispute` is PUBLIC
 * with no auth, so the first caller locks in the fixed default — while
 * `resolve_dispute` asserts only `state == Disputed` (its own state assert) and has
 * NO window check, so an arbiter can still rule right up until someone triggers
 * that default. Nagging until the task leaves `Disputed` is therefore correct:
 * the lapse is the moment the operator's judgment becomes overridable by any
 * passer-by, not the moment it stops being possible.
 *
 * ⚠️ It is NOT correct to say the pot becomes drainable. Under the deployed
 * PULL component `auto_resolve_dispute` returns VOID and credits entitlements
 * to payees pinned at create/claim (via `credit_split_for_parties`); a stranger who
 * calls it performs the accounting and receives nothing. That was true of the
 * pre-PULL component and the belief has outlived it in several comments.
 */
export function isDisputeStageNew(seen: string | null | undefined, stage: DisputeStage): boolean {
  if (stage === "lapsed") return true
  // indexOf on an unknown/absent `seen` gives -1, so any real stage is newer.
  return DISPUTE_STAGES.indexOf(stage) > DISPUTE_STAGES.indexOf(seen as DisputeStage)
}

/** XRD escrowed against one task — the two per-task vaults on the component. */
export interface DisputeValue {
  reward: number
  insurance: number
}

/**
 * Is this dispute worth paging a human, or only worth a log line?
 *
 * ⚠️ `value === null` means UNREADABLE, never zero, and always pages. A Gateway
 * hiccup must not be able to silence a 30,000 XRD dispute: never silence what
 * you cannot price.
 */
export function isDisputeWorthPaging(value: DisputeValue | null, minXrd: number): boolean {
  if (!value) return true
  if (!Number.isFinite(value.reward) || !Number.isFinite(value.insurance)) return true
  // A non-finite threshold (a typo'd env var parses to NaN) must not silence
  // everything — NaN comparisons are false, so test it explicitly.
  if (!Number.isFinite(minXrd)) return true
  return value.reward + value.insurance >= minXrd
}

/**
 * Drop stamp entries for tasks that are no longer disputed.
 *
 * Without this the stamp grows without bound, and — worse — a task id that
 * somehow re-entered `Disputed` would stay suppressed at whatever stage it last
 * reached. Pruning to the currently-live set means the file only ever records
 * disputes that are open right now, which is the only thing it decides.
 */
export function pruneDisputeStamp<T>(
  stamp: Record<string, T>,
  liveKeys: readonly string[],
): Record<string, T> {
  const live = new Set(liveKeys)
  return Object.fromEntries(Object.entries(stamp).filter(([k]) => live.has(k)))
}

/**
 * The stamp's key for one dispute — COMPONENT-QUALIFIED, deliberately.
 *
 * ⚠️ The first version keyed on the bare on-chain task id, and this repo has
 * already been bitten by exactly that. `on_chain_task_id` restarts at 0 on every
 * new escrow component, so ids COLLIDE across a cutover — the defect that made
 * the event-replay reconciler heal the wrong DB row, fixed for DB rows by adding
 * `tasks.escrow_component` (PR #197). Pass 1 of this same watcher pins every
 * task to its component for the same reason.
 *
 * Unqualified, a stamp reading `{"3": "lapsed"}` from a retired component
 * silences the NEW component's task 3 through raised → half → closing, because
 * `lapsed` outranks all three. The dispute would then get its first message only
 * once its own window had already closed — the alert arriving exactly when it
 * has stopped being actionable, which is the failure the keeper's +10min buffer
 * was originally criticised for.
 */
export function disputeStampKey(escrowComponent: string, onChainTaskId: number): string {
  return `${escrowComponent}:${onChainTaskId}`
}

/** One live dispute, as the alert needs to describe it. */
export interface DisputeAlertItem {
  onChainTaskId: number
  raisedBy: "poster" | "worker" | null
  /** When the auto-resolve window closes. Null when `disputed_at` is unreadable. */
  deadline: Date | null
  /** Time left on that window; null = unreadable, which reads as lapsed. */
  msLeft: number | null
  /** Escrowed XRD; null = unreadable, which always pages. */
  value: DisputeValue | null
  stage: DisputeStage
}

/**
 * The operator's message.
 *
 * ⚠️ THE CONTENT FIX IS WORTH MORE THAN THE FREQUENCY FIX, so it is built here
 * where it can be tested rather than inline in the cron script. The message this
 * replaces said "the blueprint's default ruling fires" — which tells a reader
 * nothing about whether to act — and then gave one fixed command regardless of
 * whether the window had already closed.
 *
 * Three properties are pinned by tests, because each was wrong in production:
 *   1. it names what the default ruling PAYS EACH PARTY, or says it could not
 *      compute it — never the ruling's name alone, which is how "SplitEvenly
 *      means 60/60" came to be believed;
 *   2. it names the next ACTION, and that action changes once the window has
 *      lapsed (arbitration is still possible, but it has become a race);
 *   3. it never describes a lapsed window as a drain. Under the deployed PULL
 *      component settlement credits entitlements to payees pinned at
 *      create/claim, so a stranger who fires it moves no money to themselves.
 */
export function formatDisputeAlert(
  due: readonly DisputeAlertItem[],
  opts: { ruling: string | null; minXrd: number; quietCount?: number },
): string {
  const { ruling, minXrd, quietCount = 0 } = opts
  // The site-wide XRD display standard, not a local helper — see
  // tests/unit/xrd-display-standard.test.ts for why that rule is enforced
  // rather than asked for. No rate here: a Telegram alert is not the place to
  // depend on a price feed, and XRD is the unit the operator acts in.
  //
  // `xrdDecimals` is capped DELIBERATELY, which the standard requires you to be
  // explicit about. These figures reach this function as doubles (the watcher
  // reads vault balances and multiplies by the ruling), so digits past ~1e-7
  // are float artefact, not chain truth — 0.1 + 0.2 would otherwise print
  // 0.30000000000000004 in a message about someone's money. The authoritative
  // amounts are the on-chain ones; where exactness IS the point, the BigInt
  // path in escrow-entitlements.ts is the one to use.
  const xrd = (n: number) => formatXrdUsd(n, null, { xrdDecimals: 6 }).replace(/ XRD$/, "")

  const left = (d: DisputeAlertItem) => {
    if (d.msLeft === null) return "⏰ window UNKNOWN (disputed_at unreadable) — treated as lapsed"
    if (d.msLeft <= 0) return "🔴 WINDOW LAPSED — anyone can now fire the default ruling"
    const h = Math.floor(d.msLeft / 3600_000)
    const m = Math.floor((d.msLeft % 3600_000) / 60_000)
    return `${h < 6 ? "🔴" : h < 24 ? "🟠" : "🟡"} ${h}h ${m}m left to arbitrate`
  }

  const outcome = (d: DisputeAlertItem) => {
    if (!ruling) return "   if nobody arbitrates: ruling UNREADABLE from chain — treat as urgent"
    if (!d.value) return `   if nobody arbitrates: ${ruling} fires (escrowed amount unreadable)`
    const escrowed = `   escrowed ${xrd(d.value.reward)} reward + ${xrd(d.value.insurance)} insurance XRD`
    const p = autoResolvePayout(ruling, d.raisedBy, d.value.reward, d.value.insurance)
    // A payout we cannot compute is stated as such. Printing the ruling's name
    // and letting the reader infer the split is how the wrong belief was made.
    if (!p) {
      return (
        `${escrowed}\n   if nobody arbitrates: ${ruling} fires — payout NOT COMPUTED ` +
        `(unrecognised ruling, or raiser unknown under FavorDisputeRaiser)`
      )
    }
    return (
      `${escrowed}\n` +
      `   if nobody arbitrates: ${ruling} → worker ${xrd(p.worker)}, poster ${xrd(p.poster)} XRD` +
      (ruling === "SplitEvenly" ? " (insurance always returns to the poster)" : "")
    )
  }

  const lines = due.map(
    (d) =>
      `• on-chain task ${d.onChainTaskId} — raised by ${d.raisedBy ?? "unknown"} — ${left(d)}` +
      (d.deadline
        ? `\n   ${d.stage === "lapsed" ? "window closed" : "auto-resolves"} ${d.deadline.toISOString()}`
        : "") +
      `\n${outcome(d)}` +
      `\n   [stage: ${d.stage}]`,
  )

  const belowNote =
    quietCount > 0
      ? `\n(${quietCount} further dispute(s) below the ${minXrd} XRD threshold — see the log.)`
      : ""

  // WHAT TO DO, not just what happened — and a lapsed window changes the
  // instruction, so the instruction changes with it.
  const action = due.some((d) => d.stage === "lapsed")
    ? `\nWHAT TO DO — the window is past on at least one of these. An arbiter can STILL\n` +
      `rule (resolve_dispute asserts only "must be Disputed", no deadline), but anyone\n` +
      `may now call auto_resolve_dispute and lock in the default instead. First one wins.\n` +
      `Nobody can steal the pot: settlement credits entitlements to the accounts pinned\n` +
      `at create/claim, so a stranger who fires it pays the fee and moves no money.\n` +
      `  cd guild-app && bun ${ARBITER_HARNESS} resolve --task <id> --ruling <r>\n` +
      `Or accept the default and let it fire. Either way each party then withdraws their\n` +
      `own credit — settlement credits, it does not deposit.`
    : `\nWHAT TO DO — decide before the window closes, or the default above fires.\n` +
      `To override it (operator ceremony, signs from the wallet holding the arbiter badge):\n` +
      `  cd guild-app && bun ${ARBITER_HARNESS} resolve --task <id> --ruling <r>\n` +
      `(dry-run first — it prints the manifest to sign.)\n` +
      `To accept the default: do nothing. It fires on its own and pays as shown above.`

  return (
    `⚖️ Guild escrow: ${due.length} dispute(s) need a decision.\n` +
    lines.join("\n") +
    belowNote +
    action
  )
}
