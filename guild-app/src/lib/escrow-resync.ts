import { GATEWAY, ESCROW_COMPONENT } from "@/lib/config"
import {
  applyEscrowConfirm,
  classifyEscrowEvent,
  ALLOWED_FROM,
  type EscrowConfirmKind,
} from "@/lib/escrow-confirm"
import { readOnChainClaimInfo } from "@/lib/gateway"
import { decideClaimHeal } from "@/lib/reconcile-claim"
import { findEscrowByTask, recordEntitlementLedgerRow } from "@/db/queries/escrow"
import {
  ENTITLEMENT_EVENT_NAMES,
  parseEntitlementEvent,
  type EntitlementLedgerRow,
} from "@/lib/escrow-entitlements"
import { findUserById } from "@/db/queries/users"
import type { tasks } from "@/db/schema"

// Per-task chain resync — the self-service half of the reconciler.
//
// WHY: the DB only advances when a client confirms its own tx; a dropped
// confirm (closed tab, stale session, network blip) strands the task behind
// chain truth until the operator runs the reconciler. This walks ONE task's
// on-chain lifecycle from its funding tx forward and replays every event the
// DB is missing through applyEscrowConfirm — the same fail-closed transition
// core as the confirm route and the reconciler, so nothing here can write
// state the chain doesn't prove.
//
// Actor split per event kind (mirrors scripts/reconcile-escrow.mjs):
//   claim       — the CALLER's user actor first: holding the task's on-chain
//                 Claim Receipt is the strongest proof of claimership. When
//                 that fails NOT_CLAIMER — submit BURNS the receipt, so for
//                 any lifecycle at/past Submitted even the true worker fails
//                 it — fall back to the reconciler's chain-derived
//                 attribution: the live TaskState's worker_account via
//                 decideClaimHeal, the SAME triage the cron runs
//                 (design/reconciler-claim-heal-boundary-2026-07-16.md). The
//                 caller cannot influence the resolved assignee, so any authed
//                 user still only moves the DB toward chain truth.
//   everything  — applied with the reconciler actor: chain-verified events
//   else          need no caller identity (dispute reads the raiser from the
//                 event; cancel/approve were receipt-authorized on-chain).
//
// `create` never appears here: a task without onChainTaskId can't be located
// on chain at all (the linkage IS the create confirm), and one with it has
// its create reflected by definition.

type TaskRow = typeof tasks.$inferSelect

export const EVENT_TO_KIND: Record<string, EscrowConfirmKind> = {
  TaskClaimedEvent: "claim",
  WorkSubmittedEvent: "submit",
  TaskReleasedEvent: "approve",
  DisputeRaisedEvent: "dispute",
  DisputeAutoResolvedEvent: "resolve",
  // The ARBITER's ruling. Absent from this map until 2026-08-25, which is what
  // made a human arbitration permanently invisible: resolve_dispute also emits
  // TaskReleasedEvent/TaskRefundedEvent, and TaskReleasedEvent maps to `approve`
  // whose ALLOWED_FROM excludes `disputed` — so the ruling classified as
  // `superseded` and, with nothing pending behind it, counted as `reflected`.
  // The row stayed `disputed` forever and the resync reported success.
  DisputeResolvedEvent: "arbitrate",
  // NB TaskRefundedEvent is deliberately NOT mapped. It is emitted by BOTH
  // resolve_dispute (lib.rs, its `TaskState::Refunded` arm) and
  // auto_resolve_dispute (lib.rs, its matching `TaskState::Refunded` arm), so
  // mapping it to `arbitrate` would make every AUTO-resolve tx look for a
  // DisputeResolvedEvent that is not there and report a spurious blocked event.
  // It needs no mapping: DisputeResolvedEvent is emitted OUTSIDE the
  // Released/Refunded match (lib.rs, right after `resolve_dispute`'s match
  // closes), so it covers both arbiter outcomes
  // on its own and carries the amounts either way.
  TaskCancelledEvent: "cancel",
  TaskCancelledAfterClaimEvent: "cancel",
  // A lapsed claim expired on-chain: task back to Open, assignee cleared.
  // TWO writers reach this transition, both with the reconciler actor: this
  // per-task resync (on demand) and scripts/reconcile-escrow.mjs, which SPREADS
  // this exported map and runs unattended from cron (15,45 * * * * --apply, so
  // ≤30 min). It stays off the PUBLIC confirm route by design (see ROUTE_KINDS),
  // because expire_claim is public on-chain and its sender need not be a party.
  // NOTE: removing or renaming this entry silently disarms the cron reconciler
  // too — that coupling is the point (it kept a hand-typed copy and drifted).
  ClaimExpiredEvent: "expire",
}

export interface ResyncApplied {
  kind: EscrowConfirmKind
  intentHash: string
  /** Task status after this confirm applied. */
  status: string
}

export interface ResyncPending {
  kind: EscrowConfirmKind
  intentHash: string
  reason: string
}

export type ResyncResult =
  | {
      ok: true
      task: TaskRow
      /** Confirms applied this call, in ledger order. */
      applied: ResyncApplied[]
      /** Chain events the DB is still behind on, with why they couldn't apply. */
      pending: ResyncPending[]
      /** Events already reflected in (or superseded by) the DB state. */
      reflected: number
      /**
       * Settle/withdraw legs physically written this call (§5c). Replays return 0
       * — the row already existed — so this counts new ledger facts, not events
       * seen. Non-zero on a `paid` task means money moved that the DB had not
       * recorded, which is the whole point of ingesting these.
       */
      entitlementsRecorded: number
      scannedTxs: number
    }
  | { ok: false; code: string; httpStatus: number; message: string }

const fail = (code: string, httpStatus: number, message: string): ResyncResult => ({
  ok: false,
  code,
  httpStatus,
  message,
})

/** State version of a committed tx — the scan anchor (null = not committed/visible). */
async function fetchTxStateVersion(intentHash: string): Promise<number | null> {
  try {
    const resp = await fetch(`${GATEWAY}/transaction/committed-details`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent_hash: intentHash }),
    })
    if (!resp.ok) return null
    const json = await resp.json()
    if (json?.transaction?.transaction_status !== "CommittedSuccess") return null
    const sv = json?.transaction?.state_version
    return Number.isInteger(sv) && sv > 0 ? sv : null
  } catch {
    return null
  }
}

/**
 * Page the Gateway tx stream from `fromStateVersion`, pinned to the task's
 * escrow component, and return this task's lifecycle events in ledger order.
 * Same fail-closed emitter pin as src/lib/gateway.ts: a look-alike event from a
 * foreign component never counts. `escrowComponent` is the task's stored
 * component (on_chain_task_id collides across the cutover, so the component is
 * what disambiguates which stream + emitter to trust).
 */
async function collectTaskEvents(
  onChainTaskId: number,
  fromStateVersion: number,
  escrowComponent: string,
): Promise<{
  events: { kind: EscrowConfirmKind; intentHash: string }[]
  entitlements: { rows: EntitlementLedgerRow[]; intentHash: string }[]
  scannedTxs: number
} | { truncated: true } | null> {
  const events: { kind: EscrowConfirmKind; intentHash: string }[] = []
  // PULL settle/withdraw legs (§5c). Collected in the SAME pass and pinned by the
  // same emitter check, but kept in their own list: they carry no lifecycle
  // transition, so they must never enter the kind loop below.
  const entitlements: { rows: EntitlementLedgerRow[]; intentHash: string }[] = []
  let scannedTxs = 0
  let cursor: string | null = null
  let pinnedSv: number | null = null
  let pages = 0
  // A single task's lifecycle is ≤ a handful of txs; 20 pages (~2k component
  // txs) is a generous bound that still caps a runaway scan.
  const MAX_PAGES = 20

  do {
    const body: Record<string, unknown> = {
      from_ledger_state: { state_version: fromStateVersion },
      order: "Asc",
      limit_per_page: 100,
      affected_global_entities_filter: [escrowComponent],
      opt_ins: { receipt_events: true },
    }
    if (cursor) {
      body.cursor = cursor
      // Pin pagination to the first page's snapshot so pages stay consistent.
      body.at_ledger_state = { state_version: pinnedSv }
    }
    const resp = await fetch(`${GATEWAY}/stream/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!resp.ok) return null
    const page = await resp.json()
    pinnedSv = pinnedSv ?? page?.ledger_state?.state_version ?? fromStateVersion

    for (const tx of page?.items ?? []) {
      if (tx?.transaction_status !== "CommittedSuccess") continue
      scannedTxs++
      for (const ev of tx?.receipt?.events ?? []) {
        const name = ev?.name as string
        const kind = EVENT_TO_KIND[name]
        const isEntitlement = (ENTITLEMENT_EVENT_NAMES as readonly string[]).includes(name)
        if (!kind && !isEntitlement) continue
        if (ev?.emitter?.entity?.entity_address !== escrowComponent) continue
        const fields = ev?.data?.programmatic_json?.fields ?? ev?.data?.fields
        if (!Array.isArray(fields)) continue
        const tid = fields.find((f: { field_name?: string }) => f?.field_name === "task_id")?.value
        if (tid === undefined || Number(tid) !== onChainTaskId) continue
        if (typeof tx?.intent_hash !== "string") continue
        if (isEntitlement) {
          const rows = parseEntitlementEvent(name, fields)
          if (rows.length > 0) entitlements.push({ rows, intentHash: tx.intent_hash })
          continue
        }
        events.push({ kind: kind as EscrowConfirmKind, intentHash: tx.intent_hash })
      }
    }
    cursor = page?.next_cursor ?? null
    pages++
  } while (cursor && pages < MAX_PAGES)

  // A cursor still set here means the cap cut the walk short. A prefix of the
  // history is not a smaller truth: applied in order, it can land the row on a
  // past state (an expire whose re-claim sits past the cap) and silently drop
  // every later settle/withdraw leg — while reporting ok. Refuse instead (GM-8).
  if (cursor) return { truncated: true }

  return { events, entitlements, scannedTxs }
}

/**
 * Persist the settle/withdraw legs seen in the scan. Ledger-only: no task status
 * is read or written here, deliberately — a withdrawal is proven by its chain
 * event, and gating it on DB status would drop real collections whenever the row
 * was in an unexpected state.
 *
 * Returns how many rows were physically inserted (replays return 0), so the
 * caller can report ingestion without double-counting across repeated resyncs.
 */
/**
 * EXPORTED so the cron reconciler uses this exact function rather than growing
 * its own copy.
 *
 * The writer's docstring in db/queries/escrow.ts has always said "the per-task
 * resync AND the cron reconciler both replay the same chain events" — and the
 * reconciler had NO entitlement handling at all, so that described a system
 * that did not exist. Until this was wired up, a withdrawal made by an agent,
 * the CLI, or a wallet was recorded only if a human later clicked "Resync from
 * chain" on that exact task.
 *
 * Sharing the implementation rather than duplicating it is deliberate: the
 * defect this phase's retrospective ranked CRITICAL was an ingestion wire with
 * no coverage, and a second hand-written copy in a .mjs script is that defect
 * again, one file over and harder to test. One function, one set of tests, both
 * callers.
 */
export async function ingestEntitlements(
  task: TaskRow,
  entitlements: { rows: EntitlementLedgerRow[]; intentHash: string }[],
): Promise<number> {
  let inserted = 0
  for (const { rows, intentHash } of entitlements) {
    for (const row of rows) {
      // Payee attribution without an extra lookup: funds always originate from
      // the poster's escrow, and the collecting side is whichever party the event
      // names. A worker leg on a task whose claim was never recorded resolves to
      // null rather than guessing — toUserId is nullable for exactly that case.
      const toUserId = row.party === "poster" ? task.creatorId : task.assigneeId
      const result = await recordEntitlementLedgerRow({
        taskId: task.id,
        txType: row.txType,
        party: row.party,
        lane: row.lane,
        fromUserId: task.creatorId,
        toUserId,
        amountXrd: row.amountXrd,
        txHash: intentHash,
        destination: row.destination,
      })
      if (result.inserted) inserted++
    }
  }
  return inserted
}

/**
 * Re-sync one task's DB state from its on-chain lifecycle. `callerUserId` is
 * the authed session user — used ONLY as the user actor for claim confirms
 * (the core proves claimership via the on-chain claim receipt, fail-closed).
 * Everything applied goes through applyEscrowConfirm; this function holds no
 * write logic of its own.
 */
export async function resyncTaskFromChain(
  task: TaskRow,
  callerUserId: string,
): Promise<ResyncResult> {
  if (task.onChainTaskId == null) {
    return fail(
      "NOT_FUNDED",
      409,
      "Task has no on-chain escrow id — there is no chain history to resync from",
    )
  }

  // The fund row's txHash anchors the scan: every later lifecycle event for
  // this task sits at a higher state version. (onChainTaskId is only ever set
  // together with the fund row, atomically, by the create confirm.)
  const fundRow = (await findEscrowByTask(task.id)).find((r) => r.txType === "fund")
  if (!fundRow?.txHash) {
    return fail(
      "NO_FUND_ROW",
      409,
      "Escrow ledger has no funding record for this task — cannot anchor the chain scan",
    )
  }

  const anchorSv = await fetchTxStateVersion(fundRow.txHash)
  if (anchorSv === null) {
    return fail("GATEWAY_ERROR", 502, "Could not resolve the funding tx on the Gateway")
  }

  // Scan on the task's own funding component; pre-backfill rows (null) fall
  // back to the current component, exactly as this scan behaved before.
  const scan = await collectTaskEvents(
    task.onChainTaskId,
    anchorSv,
    task.escrowComponent ?? ESCROW_COMPONENT,
  )
  if (scan === null) {
    return fail("GATEWAY_ERROR", 502, "Gateway transaction stream unavailable")
  }
  if ("truncated" in scan) {
    return fail(
      "SCAN_TRUNCATED",
      502,
      "This task's chain history is longer than one resync can scan, so nothing was applied — a partial history could set the task to a past state",
    )
  }

  const applied: ResyncApplied[] = []
  const pending: ResyncPending[] = []
  let reflected = 0
  let current = task

  for (const { kind, intentHash } of scan.events) {
    const verdict = classifyEscrowEvent(kind, current)

    if (verdict === "reflected") {
      reflected++
      continue
    }

    if (verdict === "superseded") {
      // Only a true skip when the DB is AHEAD of the event. If an earlier
      // event is stuck pending (e.g. a claim only the worker can heal), later
      // events sit BEHIND a too-early status — report them as blocked, never
      // silently absorb them.
      if (pending.length > 0) {
        pending.push({
          kind,
          intentHash,
          reason: "Blocked behind an earlier step that could not be re-synced",
        })
      } else {
        reflected++
      }
      continue
    }

    // healable
    if (kind === "claim") {
      if (!ALLOWED_FROM.claim.includes(current.status)) {
        // Assignee was never recorded and the lifecycle has already moved on —
        // nothing a self-service caller can do; earnings need operator review.
        pending.push({
          kind,
          intentHash,
          reason:
            "The claim was never recorded before the task moved on — an operator must re-attribute it",
        })
        continue
      }
      // The caller's own claim receipt proves a claim only for the worker. The
      // POSTER can never be the claimer (the blueprint asserts worker !=
      // poster), and the user actor refuses them with SELF_CLAIM — which used
      // to land here as a pending entry, skipping the fallback below. A poster's
      // resync of an expire → re-claim history then left the row open and
      // unassigned while the chain said Claimed (GM-3). The poster goes
      // straight to the chain-derived attribution instead.
      if (callerUserId !== current.creatorId) {
        const result = await applyEscrowConfirm(current, "claim", intentHash, {
          kind: "user",
          userId: callerUserId,
        })
        if (result.ok) {
          applied.push({ kind, intentHash, status: result.task.status })
          current = result.task
          continue
        }
        if (result.code !== "NOT_CLAIMER") {
          pending.push({ kind, intentHash, reason: result.message })
          continue
        }
      }
      // The receipt can't prove it (burned at submit, or the caller isn't the
      // worker) — fall back to the chain-derived attribution the cron uses:
      // the live TaskState's worker_account, triaged by decideClaimHeal. The
      // read fails soft here (unlike the cron, which must hold its cursor):
      // a Gateway blip becomes a pending entry and the caller retries.
      let claimInfo: Awaited<ReturnType<typeof readOnChainClaimInfo>>
      try {
        claimInfo = await readOnChainClaimInfo(
          current.onChainTaskId!,
          current.escrowComponent ?? ESCROW_COMPONENT,
        )
      } catch {
        pending.push({
          kind,
          intentHash,
          reason: "Live on-chain claim state unreadable (Gateway) — retry the resync",
        })
        continue
      }
      const decision = decideClaimHeal({
        dbStatus: current.status,
        onChainState: claimInfo.state,
        workerAccount: claimInfo.workerAccount,
      })
      if (decision.action === "skip") {
        // No worker on record (the claim later expired / was cancelled) — the
        // event is stale history and the DB state already matches the chain.
        reflected++
        continue
      }
      if (decision.action === "surface") {
        // Inconsistent chain shape (e.g. a worker_account in a state that
        // can't carry one) — report it, never absorb it as in-sync.
        pending.push({ kind, intentHash, reason: decision.reason })
        continue
      }
      const worker = await findUserById(decision.assignee)
      if (!worker) {
        pending.push({
          kind,
          intentHash,
          reason: `Chain names worker ${decision.assignee}, who has no guild account yet — resync again once they sign in`,
        })
        continue
      }
      const healed = await applyEscrowConfirm(current, "claim", intentHash, {
        kind: "reconciler",
        resolvedAssignee: decision.assignee,
      })
      if (healed.ok) {
        applied.push({ kind, intentHash, status: healed.task.status })
        current = healed.task
      } else {
        pending.push({ kind, intentHash, reason: healed.message })
      }
      continue
    }

    const result = await applyEscrowConfirm(current, kind, intentHash, { kind: "reconciler" })
    if (result.ok) {
      applied.push({ kind, intentHash, status: result.task.status })
      current = result.task
    } else {
      pending.push({ kind, intentHash, reason: result.message })
    }
  }

  // AFTER the lifecycle loop, so `current` carries any assignee the claim confirm
  // just recorded — a worker withdrawal ingested before that would attribute to a
  // null toUserId and stay that way.
  const entitlementsRecorded = await ingestEntitlements(current, scan.entitlements)

  return {
    ok: true,
    task: current,
    applied,
    pending,
    reflected,
    entitlementsRecorded,
    scannedTxs: scan.scannedTxs,
  }
}
