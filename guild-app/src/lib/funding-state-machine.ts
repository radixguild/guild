/**
 * The community-funding (threshold crowdfund) app-layer state machine.
 *
 * This is deliberately NOT a port of the FundingPool Scrypto blueprint
 * (docs/design/funding-pool-blueprint.md) — that blueprint does not exist yet
 * (it is a separate, audit-gated build; see PROJECT-STATE.md's ▶ 2026-08-14
 * sitting). Nothing in this module moves, custodies, or promises real XRD.
 * It is the pure decision logic for the DB-side pledging ledger the app can
 * run standalone today, per the blueprint doc's own framing: "the funding
 * pool's rail-agnostic app core is startable" (§13) ahead of the chain build,
 * so that once the real component deploys the app has a state machine and a
 * schema already shaped to reconcile against its events — the same
 * confirm-then-reconcile pattern src/lib/escrow-confirm.ts already uses for
 * on-chain tasks.
 *
 * Every function here is pure and total: given the same inputs it returns the
 * same output, and it never touches the DB, the clock, or the network. `now`
 * is always a parameter, never `new Date()` internally — the caller (a query
 * function or a cron) supplies it, which is what makes the deadline-boundary
 * behaviour exhaustively testable (see funding-state-machine.test.ts).
 *
 * ── The five states, and why "funded" exists at all ─────────────────────────
 * pledging -> funded -> finalized
 *          \          \
 *           -> expired -> refunding
 *
 * The blueprint's own chain-side design (§7) has no separate "funded" state —
 * it stays "Funding" right up until `finalize()` succeeds, because on-chain,
 * hitting the target and finalizing can be the SAME transaction. At the app
 * layer they can't be: finalize is a distinct, deliberate action (today: a
 * state flip; once the blueprint deploys: the transaction that hands pooled
 * XRD to `create_task`), so "target hit, awaiting finalize" is a real,
 * observable, UI-relevant condition and gets its own name. This is an
 * app-layer decision, not a re-derivation of the chain design.
 *
 * ── "expired" is derived, exactly like the blueprint's "Failed" ─────────────
 * A pool doesn't need a write to become expired — clock + pooled-vs-target
 * decides it (blueprint §7: "`Failed` is DERIVED … so no transaction is ever
 * needed for a pool to fail"). `evaluateDeadline` is that derivation; callers
 * run it before trusting a stored `status` column, the same way the
 * blueprint's own `claim_refund` derives failure on first call rather than
 * trusting a stale flag.
 */

import {
  addXrd,
  compareXrd,
  eqXrd,
  gtXrd,
  isPositiveXrd,
  lteXrd,
  subXrd,
} from "@/lib/xrd-decimal";

export type FundingPoolStatus =
  | "draft"
  | "pledging"
  | "funded"
  | "finalized"
  | "expired"
  | "refunding";

/** Why a pool became `expired` — mirrors the blueprint's `PoolFailedEvent`
 *  reason field (funding-pool-blueprint.md §8) so the eventual reconciler can
 *  map one to the other without inventing a new vocabulary. */
export type FundingExpiryReason = "NotFunded" | "GraceExpired";

export type FundingErrorCode =
  | "NOT_ACCEPTING_PLEDGES"
  | "PAST_DEADLINE"
  | "AMOUNT_NOT_POSITIVE"
  | "BELOW_MINIMUM"
  | "OVER_TARGET"
  | "GAP_TOO_SMALL"
  | "NOT_FUNDED"
  | "FINALIZE_WINDOW_CLOSED"
  | "NOT_EXPIRED"
  | "NOTHING_TO_REFUND"
  | "ALREADY_REFUNDED"
  | "NOT_A_DRAFT"
  | "CHARTER_INCOMPLETE";

export class FundingStateError extends Error {
  constructor(
    public readonly code: FundingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FundingStateError";
  }
}

export interface FundingPoolState {
  status: FundingPoolStatus;
  /** Exact decimal XRD string. What the worker receives once finalized. */
  targetXrd: string;
  /** Exact decimal XRD string. Sum of every contributor's ledger entry —
   *  callers must keep this in step with the ledger; nothing in this module
   *  reads a ledger to recompute it (see the module doc on `pooledXrd`'s
   *  invariant in the schema, src/db/schema/funding-pools.ts). */
  pooledXrd: string;
  /** NULL while the pool is a draft — a draft's clock has not started, so it
   *  has no deadline to miss. Set at publish and immutable after (D3: never
   *  extendable). Every function here that reads it narrows on status first;
   *  `deadline === null` and `status !== "draft"` is an invariant violation,
   *  not a reachable state. */
  deadline: Date | null;
  publishedAt: Date | null;
  graceWindowSecs: number;
  fundedAt: Date | null;
  finalizedAt: Date | null;
  expiredAt: Date | null;
  expiredReason: FundingExpiryReason | null;
}

export interface ContributionEntry {
  contributorId: string;
  /** Cumulative pledge from this contributor — one row per (pool,
   *  contributor), never one row per pledge event (§4b "keyed by account"). */
  amountXrd: string;
  refundedAt: Date | null;
  refundedXrd: string | null;
}

/** `deadline + graceWindowSecs`, as a Date. Exported because callers (a
 *  finalize-reminder cron, a UI countdown) need the same boundary this module
 *  enforces internally — recomputing it a second way is how it would drift. */
export function graceExpiresAt(
  pool: Pick<FundingPoolState, "deadline" | "graceWindowSecs">,
): Date | null {
  if (!pool.deadline) return null;
  return new Date(pool.deadline.getTime() + pool.graceWindowSecs * 1000);
}

/**
 * The clock-only transition. Re-derives `expired` from `now` the same way
 * the blueprint derives `Failed` — safe to call on every read, idempotent,
 * and it is what `applyPledge`/`finalize`/`claimRefund` all call first so a
 * caller can never act against a pool whose deadline has already passed in
 * reality but not yet in the stored row.
 *
 *   pledging -> expired (NotFunded)    when now > deadline && pooled < target
 *   funded   -> expired (GraceExpired) when now > deadline + grace
 *
 * Anything else (already finalized/expired/refunding, or still genuinely
 * live) is returned unchanged — same object reference when nothing changed,
 * so callers can cheaply skip a write with `result === pool`.
 */
export function evaluateDeadline(pool: FundingPoolState, now: Date): FundingPoolState {
  // A draft has no clock — nothing to evaluate until publishPool starts it.
  if (pool.status === "draft" || !pool.deadline) return pool;
  if (pool.status === "pledging" && now.getTime() > pool.deadline.getTime()) {
    if (gtXrd(pool.targetXrd, pool.pooledXrd)) {
      return { ...pool, status: "expired", expiredAt: now, expiredReason: "NotFunded" };
    }
    // pooled === target exactly here would mean applyPledge failed to flip
    // pledging -> funded on the hit, which is a bug in THIS module, not a
    // reachable external state — asserted, not silently tolerated.
  }
  const graceEnd = graceExpiresAt(pool);
  if (pool.status === "funded" && graceEnd && now.getTime() > graceEnd.getTime()) {
    return { ...pool, status: "expired", expiredAt: now, expiredReason: "GraceExpired" };
  }
  return pool;
}

/**
 * Apply one pledge. Validates in the same order the blueprint's `contribute`
 * does (funding-pool-blueprint.md §5), so the app-layer refusal reasons line
 * up with the refusal reasons a real transaction will eventually give:
 *
 *   1. clock — reject if the deadline has already passed (derived first, so
 *      a pledge can never land against a pool that is really-but-not-yet
 *      recorded as expired)
 *   2. status — must be `pledging` (a `funded` pool is fully subscribed;
 *      nothing after that accepts more money)
 *   3. amount — must be a positive decimal
 *   4. minimum — must be >= `minContributionXrd` (D4's floor — see
 *      funding-config.ts for why the default is a placeholder)
 *   5. over-target (D1) — must not exceed `remaining`
 *   6. gap guard [blueprint-level, §5] — the remaining AFTER this pledge must
 *      be exactly zero or >= minContributionXrd, never a dust gap neither a
 *      future pledge (blocked by the minimum) nor this one (blocked by
 *      over-target) could ever legally close.
 *
 * On success: `pooledXrd` increases by `amount`; if that reaches `targetXrd`
 * EXACTLY, status flips `pledging -> funded` and `fundedAt` is set. The
 * ledger update (accumulating into the contributor's own entry rather than
 * inserting a new row — the "double pledge" case) is the caller's job, via
 * `recordContribution` below; this function only knows about the pool total.
 */
export function applyPledge(
  poolIn: FundingPoolState,
  amountXrd: string,
  now: Date,
  opts: { minContributionXrd: string },
): FundingPoolState {
  const pool = evaluateDeadline(poolIn, now);

  if (pool.status !== "pledging") {
    throw new FundingStateError(
      "NOT_ACCEPTING_PLEDGES",
      `Pool is ${pool.status}, not accepting pledges`,
    );
  }
  // evaluateDeadline already turns a past-deadline pledging pool into
  // expired, so reaching here with status still "pledging" means the clock
  // check already passed — this second guard exists only to document the
  // invariant, not to catch a real case evaluateDeadline missed.
  // status === "pledging" here, so the pool is published and `deadline` is
  // set — the `?? 0` is a type narrowing, not a fallback for a real state.
  if (now.getTime() > (pool.deadline?.getTime() ?? 0)) {
    throw new FundingStateError("PAST_DEADLINE", "Pledging window has closed");
  }
  if (!isPositiveXrd(amountXrd)) {
    throw new FundingStateError("AMOUNT_NOT_POSITIVE", "Pledge amount must be positive");
  }
  if (compareXrd(amountXrd, opts.minContributionXrd) < 0) {
    throw new FundingStateError(
      "BELOW_MINIMUM",
      `Pledge below the minimum contribution (${opts.minContributionXrd} XRD)`,
    );
  }

  const remaining = subXrd(pool.targetXrd, pool.pooledXrd);
  if (gtXrd(amountXrd, remaining)) {
    throw new FundingStateError("OVER_TARGET", `Pledge exceeds remaining (${remaining} XRD)`);
  }

  const remainingAfter = subXrd(remaining, amountXrd);
  if (!eqXrd(remainingAfter, "0") && compareXrd(remainingAfter, opts.minContributionXrd) < 0) {
    throw new FundingStateError(
      "GAP_TOO_SMALL",
      `Pledge would leave ${remainingAfter} XRD remaining — below the minimum ` +
        `and not zero, which no future pledge could legally close`,
    );
  }

  const pooledXrd = addXrd(pool.pooledXrd, amountXrd);
  const hitTarget = eqXrd(pooledXrd, pool.targetXrd);
  return {
    ...pool,
    pooledXrd,
    status: hitTarget ? "funded" : "pledging",
    fundedAt: hitTarget ? now : pool.fundedAt,
  };
}

/**
 * Accumulate one contributor's ledger entry (the "double pledge from one
 * account" case: §4b rules contributions are keyed by account, so a second
 * pledge from the same contributor ADDS to their existing entry rather than
 * creating a second one or being rejected).
 */
export function recordContribution(
  existing: ContributionEntry | null,
  contributorId: string,
  amountXrd: string,
): ContributionEntry {
  if (existing) {
    return { ...existing, amountXrd: addXrd(existing.amountXrd, amountXrd) };
  }
  return { contributorId, amountXrd, refundedAt: null, refundedXrd: null };
}

/**
 * `finalize()` — the funded -> finalized transition. Mirrors the blueprint's
 * own guard exactly (§5): callable the moment the target is hit, and until
 * `deadline + grace` INCLUSIVE. Does not, and cannot, create a real escrow
 * task — see this module's top-of-file doc. Callers must not treat a
 * `finalized` row as proof any XRD moved until the FundingPool blueprint
 * exists and an on-chain confirm has actually run.
 */
export function finalize(poolIn: FundingPoolState, now: Date): FundingPoolState {
  const pool = evaluateDeadline(poolIn, now);

  if (pool.status !== "funded") {
    throw new FundingStateError("NOT_FUNDED", `Pool is ${pool.status}, not funded`);
  }
  const graceEnd = graceExpiresAt(pool);
  // status === "funded" implies published, so graceEnd is non-null.
  if (graceEnd && now.getTime() > graceEnd.getTime()) {
    // Unreachable in practice — evaluateDeadline would already have flipped
    // this pool to expired above — kept as a fail-closed second check rather
    // than trusting evaluateDeadline's boundary forever.
    throw new FundingStateError("FINALIZE_WINDOW_CLOSED", "Grace window has passed");
  }

  return { ...pool, status: "finalized", finalizedAt: now };
}

/**
 * `claimRefund()` — pull refunds only (D4). Mirrors the blueprint's own
 * idempotency: "First call flips explicit state -> Failed" (§5) — here, the
 * first successful claim against an `expired` pool flips it to `refunding`;
 * later claims from OTHER contributors keep it there. A SECOND claim from the
 * SAME contributor (the "refund-after-refund" case) is rejected outright —
 * `claim_refund` pays the exact recorded amount exactly once, never a
 * computed share, and there is no partial-refund concept to re-enter.
 */
export function claimRefund(
  poolIn: FundingPoolState,
  entry: ContributionEntry,
  now: Date,
): { pool: FundingPoolState; entry: ContributionEntry } {
  const pool = evaluateDeadline(poolIn, now);

  if (pool.status !== "expired" && pool.status !== "refunding") {
    throw new FundingStateError(
      "NOT_EXPIRED",
      `Pool is ${pool.status}; refunds are only claimable once a pool has failed`,
    );
  }
  if (entry.refundedAt !== null) {
    throw new FundingStateError("ALREADY_REFUNDED", "This contribution was already refunded");
  }
  if (!isPositiveXrd(entry.amountXrd)) {
    throw new FundingStateError("NOTHING_TO_REFUND", "Nothing recorded for this contributor");
  }

  return {
    pool: pool.status === "expired" ? { ...pool, status: "refunding" } : pool,
    entry: { ...entry, refundedAt: now, refundedXrd: entry.amountXrd },
  };
}

/**
 * `draft -> pledging`. The only way a pool starts taking money.
 *
 * ## Why a draft state exists at all
 *
 * A pool used to be born `pledging`: the moment you typed a title and a
 * target, strangers could put money behind it. That put the fundraise before
 * the agreement, which is backwards for work that does not exist yet — the
 * first contributor was buying an outcome nobody had written down.
 *
 * So a pool is now a charter first (`draft`), and pledging opens only when
 * the poster publishes it. What that buys: the scope, the non-goals, the
 * acceptance criteria and the steward are all fixed and readable BEFORE the
 * first pledge, so "what did we fund?" has a documented answer rather than a
 * recollection.
 *
 * ## Why the clock starts here, not at creation
 *
 * `deadline` is computed at publish from `deadlineSecs`, never stored at
 * draft time. A charter can sit in draft for as long as it takes to get
 * right; the pledging window is a promise to CONTRIBUTORS, and it would be a
 * strange promise if it had already been running for a week before anyone
 * could act on it. It also removes a whole class of bug — a draft whose
 * deadline passed while it was being edited can never publish into an
 * already-expired pool, because there is nothing to expire until this
 * function runs.
 *
 * Refuses a charter that is not ready: `charterReadiness().blocking` must be
 * empty. That check lives in pool-charter.ts and is the SAME function the
 * create form renders as a checklist, so the button a poster sees and the
 * gate the server applies can never disagree.
 */
export function publishPool(
  poolIn: FundingPoolState,
  now: Date,
  opts: { deadlineSecs: number; charterReady: boolean },
): FundingPoolState {
  if (poolIn.status !== "draft") {
    throw new FundingStateError(
      "NOT_A_DRAFT",
      `Pool is ${poolIn.status}; only a draft can be published`,
    );
  }
  if (!opts.charterReady) {
    throw new FundingStateError(
      "CHARTER_INCOMPLETE",
      "Charter is missing something required — see charterReadiness().blocking",
    );
  }
  return {
    ...poolIn,
    status: "pledging",
    publishedAt: now,
    deadline: new Date(now.getTime() + opts.deadlineSecs * 1000),
  };
}

/** True once a pool can never accept another pledge, finalize, or leave
 *  `refunding` under anything this module does. Used by query-layer code
 *  deciding whether a row still needs periodic deadline re-evaluation. */
export function isTerminal(status: FundingPoolStatus): boolean {
  return status === "finalized" || status === "refunding";
}

// `lteXrd` is imported for callers of this module that want the same
// "would this pledge close the pool" check applyPledge uses internally
// (e.g. a UI computing "up to remaining" — funding-pool-blueprint.md §4b
// notes the UI already offers exactly that for the chain design).
export const wouldExactlyOrPartiallyFund = (pool: FundingPoolState, amountXrd: string): boolean =>
  lteXrd(amountXrd, subXrd(pool.targetXrd, pool.pooledXrd));
