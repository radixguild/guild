import { db } from "@/db"
import type { DbExecutor } from "@/db"
import { updateTaskIfStatus, captureEscrowIdIfUnset } from "@/db/queries/tasks"
import { recordConfirmedEscrowTx, findEscrowByTask } from "@/db/queries/escrow"
import { awardTaskCompletion } from "@/db/queries/users"
import { getTierForReward } from "@/lib/incentives"
import { pointsForTaskCompletion } from "@/lib/reputation"
import { ESCROW_COMPONENT, ESCROW_CLAIM_RECEIPT_RESOURCE } from "@/lib/config"
import { emitNotification } from "@/lib/notifications"
import { checkFundedReward, describeFundedRewardMismatch } from "@/lib/funded-reward"
import { workBriefHashHex } from "@/lib/work-brief"
import { storedTermsBlock } from "@/lib/work-brief-stored"
import {
  readEscrowTaskCreated,
  readDisputeRaised,
  readDisputeAutoResolved,
  readDisputeResolved,
  verifyEscrowEvent,
  readOnChainClaimInfo,
  holdsClaimReceipt,
  type OnChainClaimInfo,
} from "@/lib/gateway"
import type { tasks } from "@/db/schema"

// Escrow confirm core — the single transition engine for DB escrow state.
//
// Extracted from POST /api/v1/tasks/[id]/escrow (which is now a thin HTTP
// shell over this) so two callers can share one money path:
//   • the confirm route  (actor = user): a signed-in client confirms its own
//     committed tx right after the wallet returns
//   • the reconciler     (actor = reconciler): the keyless half of the keeper
//     (scripts/reconcile-escrow.mjs) — heals the DB from chain history when a
//     client dropped off after its tx committed. It signs NOTHING.
//
// Actor semantics:
//   user       — caller-authz is enforced per kind: create = task creator,
//                dispute = poster or worker, cancel = creator, claim = the
//                caller must hold the task's LIVE on-chain Claim Receipt
//                (current_claim_receipt_id — an orphan receipt left behind by
//                expire_claim does not count).
//   reconciler — caller-authz is SKIPPED, deliberately: the reconciler never
//                acts on anyone's claim of identity — it only mirrors events
//                the chain itself proves (same fail-closed emitter pin as
//                gateway.ts), so "who is calling" is meaningless for it.
//                Everything else still applies fail-closed for EVERY actor:
//                the NOT_FUNDED check, the ALLOWED_FROM lifecycle gate,
//                per-kind on-chain event verification, and the atomic
//                status+ledger writes. `create` is never reconcilable and
//                returns NOT_RECONCILABLE:
//                  create — a TaskCreatedEvent has no DB linkage (the DB row
//                           only gets its onChainTaskId FROM the create
//                           confirm), so tying an unconfirmed create to a
//                           row requires the poster's intent. Out of scope.
//                `claim` IS reconcilable, but only with a resolved assignee:
//                  claim  — a user actor proves identity by holding the claim
//                           receipt; the reconciler instead passes
//                           `resolvedAssignee`, the on-chain worker_account it
//                           read for the live claim (see reconcile-escrow.mjs).
//                           The TaskClaimedEvent is still verified. Absent a
//                           resolved assignee (resolution failed) claim stays
//                           NOT_RECONCILABLE, surfaced for the operator.
//
// Each kind verifies the matching on-chain event from the deployed escrow
// component before mutating, so DB escrow state can't be advanced without a
// real committed tx:
//   create  — poster funded: capture the on-chain task_id (TaskCreatedEvent)
//   claim   — worker claimed  (TaskClaimedEvent + caller holds the LIVE claim
//             receipt): set assignee + status=assigned
//   submit  — worker submitted (WorkSubmittedEvent): status=submitted
//   approve — poster released (TaskReleasedEvent):  status=paid
//   dispute — poster/worker disputed (DisputeRaisedEvent): submitted → disputed
//   resolve — dispute auto-resolved (DisputeAutoResolvedEvent): disputed →
//             paid (worker-favoured) or refunded (poster-favoured)
//   cancel  — poster cancelled (TaskCancelledEvent on an open task, or
//             TaskCancelledAfterClaimEvent on a claimed one): → cancelled
//
// The two payout kinds (approve, worker-favoured resolve) also credit the
// assignee's XP/reputation (see completionAward) in the same transaction as
// the release ledger row, gated on that row's first physical insert — the
// (taskId, txType) unique index makes the award exactly-once across replays.
export const KINDS = [
  "create",
  "claim",
  "submit",
  "approve",
  "dispute",
  "resolve",
  // The ARBITER's ruling (resolve_dispute), distinct from the 72h timeout.
  "arbitrate",
  "cancel",
  "expire",
] as const
export type EscrowConfirmKind = (typeof KINDS)[number]

/**
 * The kinds a client may confirm DIRECTLY on POST /tasks/[id]/escrow.
 *
 * `expire` is deliberately absent. `expire_claim` is PUBLIC on-chain — anyone
 * may send it once a claim lapses — so the confirming party is not necessarily
 * the poster, the worker, or anyone with a session at all. Rather than open a
 * new public write path into the lifecycle engine to match, expiry heals the
 * same way every other chain-grounded divergence does: through resync, with the
 * reconciler actor, gated on a verified ClaimExpiredEvent.
 */
export const ROUTE_KINDS = KINDS.filter((k) => k !== "expire")
/**
 * What the confirm route accepts — narrower than EscrowConfirmKind by exactly
 * `expire`, and enforced by the compiler: passing a plain EscrowConfirmKind to
 * ROUTE_KINDS.includes() is a type error, so the route cannot accidentally
 * widen back to the full set.
 */
export type RouteConfirmKind = (typeof ROUTE_KINDS)[number]

// Statuses each post-create kind may be confirmed FROM. verifyEscrowEvent
// proves an event happened in tx history, NOT that it is the task's current
// on-chain state — so a verified-but-replayed intentHash (e.g. a real
// WorkSubmittedEvent re-confirmed against a paid task) must never regress a
// later or terminal status. Confirms only advance the lifecycle, or no-op on
// an idempotent retry of the state they already produced.
export const ALLOWED_FROM: Record<string, readonly string[]> = {
  claim: ["open", "assigned"], // assigned = retry / expired-claim re-claim
  submit: ["assigned", "submitted"], // submitted = retry
  approve: ["submitted", "paid"], // paid = retry (ledger write is idempotent)
  dispute: ["submitted"],
  // paid/refunded = retry. Safe: a DisputeAutoResolvedEvent only exists if the
  // dispute actually settled on-chain (an approve-paid task can't have one),
  // and the ledger writes are idempotent on (taskId, txType).
  resolve: ["disputed", "paid", "refunded"],
  // Same lifecycle positions as `resolve`: both settle a live dispute, and both
  // ledger writes are idempotent on (taskId, txType), so paid/refunded are retries.
  arbitrate: ["disputed", "paid", "refunded"],
  // open = cancel_task (unclaimed); assigned = cancel_task_by_poster_after_claim
  // (claimed, not yet submitted); cancelled = retry (ledger write is idempotent).
  // No cancel from submitted onward — the blueprint requires Open/Claimed state
  // (a submitted task can only be released or disputed).
  cancel: ["open", "assigned", "cancelled"],
  // assigned = the live case (a claim lapsed and was expired on-chain);
  // open = idempotent retry, and also the state a re-claimed-then-expired task
  // passes through. Deliberately NOT from submitted onward: the blueprint
  // requires Claimed to expire, so a submitted task's claim can no longer lapse.
  expire: ["assigned", "open"],
}

// Statuses in which a kind's transition is ALREADY reflected in the DB — the
// idempotent-retry tail of ALLOWED_FROM. Shared by the reconciler script and
// the per-task resync (escrow-resync.ts) to classify chain events against the
// DB row.
export const REFLECTED_IN: Record<string, readonly string[]> = {
  claim: ["assigned"],
  submit: ["submitted"],
  approve: ["paid"],
  dispute: ["disputed"],
  resolve: ["paid", "refunded"],
  // ⚠️ ADDED 2026-08-26. `arbitrate` shipped with a KINDS entry and an
  // ALLOWED_FROM entry and no REFLECTED_IN entry, which is the same omission the
  // `expire` note below was written about. Without it, `REFLECTED_IN.arbitrate`
  // is undefined, the reflected test can never be true, and classification falls
  // through to ALLOWED_FROM.arbitrate — which deliberately lists `paid`/`refunded`
  // for idempotent retries. So an arbitration that ALREADY settled classifies
  // `healable` on every resync: escrow-resync has no persisted cursor, so each
  // call re-walks the whole history, re-verifies the event against the Gateway,
  // re-opens a DB transaction, and reports the settled ruling as newly `applied`
  // — forever, for a task that will never change again. The unique index on
  // (taskId, txType) is what keeps that from double-paying; it is not what keeps
  // it from happening.
  arbitrate: ["paid", "refunded"],
  cancel: ["cancelled"],
  // Already reopened = this expiry is in the DB. Without this the row would
  // classify as `healable` on every resync (ALLOWED_FROM.expire also lists
  // "open", for idempotency) and re-apply the same confirm forever, reporting
  // it as newly `applied` each time. A task RE-CLAIMED after expiring is
  // "assigned", so it still classifies healable there — correct, because the
  // ordered walk re-applies the later claim event right after.
  expire: ["open"],
}

export type EscrowEventVerdict = "reflected" | "healable" | "superseded"

/**
 * Classify a chain event against the task's current DB row:
 *   reflected  — the transition is already in the DB; nothing to do
 *   healable   — the DB is behind this event; a confirm could advance it
 *   superseded — the lifecycle moved PAST the event (stale history)
 *
 * `claim` is special-cased on the ASSIGNEE, not status: the claim confirm is
 * what records assigneeId, so a task whose lifecycle moved past `assigned`
 * with assigneeId still null had its claim confirm lost — earnings would be
 * unattributed. Status-only classification buckets exactly that case as
 * "superseded → skip" (the mainnet smoke's stuck-claim finding); keying on the
 * assignee surfaces it as healable so callers report it, never silently skip.
 */
export function classifyEscrowEvent(
  kind: EscrowConfirmKind,
  task: { status: string; assigneeId: string | null },
): EscrowEventVerdict {
  if (kind === "claim") {
    return task.assigneeId != null ? "reflected" : "healable"
  }
  if (REFLECTED_IN[kind]?.includes(task.status)) return "reflected"
  if (ALLOWED_FROM[kind]?.includes(task.status)) return "healable"
  return "superseded"
}

export type EscrowActor =
  | { kind: "user"; userId: string }
  // The reconciler mirrors what the chain proves. For `claim` it additionally
  // carries `resolvedAssignee` — the on-chain worker_account it read for the live
  // claim — since the event itself names no account. Absent it (resolution
  // failed) claim stays NOT_RECONCILABLE.
  | { kind: "reconciler"; resolvedAssignee?: string }

type TaskRow = typeof tasks.$inferSelect

export type EscrowConfirmResult =
  | { ok: true; task: TaskRow }
  | { ok: false; code: string; httpStatus: number; message: string }

const fail = (code: string, httpStatus: number, message: string): EscrowConfirmResult => ({
  ok: false,
  code,
  httpStatus,
  message,
})

// XP/reputation credited to the assignee when a task pays out (approve, or a
// worker-favoured resolve). XP prefers the task's stored xpReward; tasks
// created before the create route populated that field carry the 0 default,
// so fall back to the incentive tier derived from the XRD reward — otherwise
// every pre-existing task would award +0 and the leaderboard would stay
// empty. Reputation always comes from the tier's completion points: it is
// platform-scored, never poster-set.
function completionAward(task: TaskRow): { xp: number; reputation: number } {
  const tier = getTierForReward(Number(task.rewardXrd))
  return {
    xp: task.xpReward > 0 ? task.xpReward : tier.xpReward,
    reputation: pointsForTaskCompletion(tier.difficulty),
  }
}

// Thrown (inside a db.transaction, so the paired ledger write rolls back too)
// when the CAS status predicate matched 0 rows: a concurrent confirm advanced
// the task between our in-memory gate check and the write. Translated to a
// CONFLICT result at the applyEscrowConfirm boundary — never escapes to callers.
class ConfirmStateConflict extends Error {}

// Status-advancing write with the kind's ALLOWED_FROM gate pushed into the
// UPDATE's WHERE clause. The in-memory gate check (line ~241) is kept for the
// cheap early 409, but this is the one that holds under concurrency: two
// racing confirms (e.g. dispute + approve on the same submitted task)
// serialize on the row lock and exactly one wins. ALLOWED_FROM already
// includes each kind's retry/target states, so idempotent replays still match.
async function casUpdateTask(
  taskId: number,
  kind: EscrowConfirmKind,
  data: Parameters<typeof updateTaskIfStatus>[1],
  tx?: DbExecutor,
) {
  const next = await updateTaskIfStatus(taskId, data, ALLOWED_FROM[kind] ?? [], tx)
  if (next === null) {
    throw new ConfirmStateConflict(
      `Task status changed while confirming '${kind}' — a concurrent transition won; reload and retry`,
    )
  }
  return next
}

/**
 * Apply a verified escrow lifecycle confirm to the DB. Contains everything the
 * confirm route does after body parsing: caller-authz (user actors only), the
 * NOT_FUNDED check, the ALLOWED_FROM lifecycle gate (checked in memory for the
 * early 409, enforced in the UPDATE's WHERE clause for concurrency), on-chain
 * event verification and the atomic status+ledger writes. Throws only on
 * unexpected failures (DB/network) — expected rejections come back as { ok: false }.
 */
export async function applyEscrowConfirm(
  task: TaskRow,
  kind: EscrowConfirmKind,
  intentHash: string,
  actor: EscrowActor,
): Promise<EscrowConfirmResult> {
  try {
    return await applyEscrowConfirmInner(task, kind, intentHash, actor)
  } catch (err) {
    if (err instanceof ConfirmStateConflict) return fail("CONFLICT", 409, err.message)
    throw err
  }
}

async function applyEscrowConfirmInner(
  task: TaskRow,
  kind: EscrowConfirmKind,
  intentHash: string,
  actor: EscrowActor,
): Promise<EscrowConfirmResult> {
  // Reconciler bounds (see header): `create` can never be healed from chain
  // events alone, and `claim` can only be healed with an assignee the caller
  // resolved off-chain (badge→account). Checked first — no chain reads for a
  // kind/actor we can never apply.
  if (actor.kind === "reconciler") {
    if (kind === "create") {
      return fail(
        "NOT_RECONCILABLE",
        501,
        "Cannot reconcile 'create': linking an unconfirmed create to a DB task requires the poster's intent",
      )
    }
    if (kind === "claim" && !actor.resolvedAssignee) {
      return fail(
        "NOT_RECONCILABLE",
        501,
        "Cannot reconcile 'claim' without a resolved assignee: the event names no account (badge→account resolution failed)",
      )
    }
  }

  // create — capture the on-chain task_id assigned by the blueprint, and record
  // the verified funded amount into the escrow ledger (the `fund` row). The
  // confirm core is the SINGLE writer of escrow_transactions.
  if (kind === "create") {
    if (actor.kind === "user" && task.creatorId !== actor.userId) {
      return fail("FORBIDDEN", 403, "Only the task creator can confirm funding")
    }
    const created = await readEscrowTaskCreated(intentHash, ESCROW_COMPONENT)
    if (created === null) {
      return fail(
        "EVENT_NOT_FOUND",
        422,
        "TaskCreatedEvent not found (tx not committed, or wrong escrow component)",
      )
    }
    // Binding: WHO funded, and WHAT they funded. A create tx's intent hash is
    // public on the Gateway, so without these two pins any signed-in user could
    // POST someone else's unlinked create (a lost confirm, or a race) against a
    // row of their own with the same reward, and that row would read Funded —
    // with a brief no submit_task can ever match (lib.rs asserts brief_hash ==
    // work_brief_hash at submit), so a worker who claims it can only lose the
    // bond. Checked BEFORE the reward parity below, whose refusal tells the
    // caller the escrowed funds are theirs — only true once the poster matches.
    //
    //   poster        — the event's `poster` must be the row's creator (user ids
    //                   ARE account addresses). 409: deterministic, never retried.
    //   work brief    — the event's `work_brief_hash` must be the hash of THIS
    //                   row's stored title/description/terms/deadline, through
    //                   the same derivation the fund and submit buttons hash with
    //                   (src/lib/work-brief.ts). Stored, unscrubbed text — never
    //                   publicTaskView's output.
    //
    // Either field unreadable → 422 with its own code, the same fail-closed
    // posture as FUNDED_REWARD_UNREADABLE: linking there would assert a binding
    // nobody checked.
    if (created.poster === null) {
      return fail(
        "CREATE_POSTER_UNREADABLE",
        422,
        "TaskCreatedEvent carries no readable poster account — cannot verify who funded it; the task was not linked",
      )
    }
    if (created.poster !== task.creatorId) {
      return fail(
        "CREATE_POSTER_MISMATCH",
        409,
        `Task ${task.id}: that funding transaction names a different poster account than this task's creator — refusing to link it`,
      )
    }
    if (created.workBriefHash === null) {
      return fail(
        "WORK_BRIEF_UNREADABLE",
        422,
        "TaskCreatedEvent carries no readable work_brief_hash — cannot verify which brief was funded; the task was not linked",
      )
    }
    const rowBriefHash = await workBriefHashHex(
      task.title,
      task.description,
      storedTermsBlock(task.terms, task.deadline),
    )
    if (created.workBriefHash !== rowBriefHash) {
      return fail(
        "WORK_BRIEF_MISMATCH",
        409,
        `Task ${task.id}: that funding transaction committed to a different work brief than this task's stored text and terms — refusing to list it as funded. ` +
          `The escrowed funds are still yours: cancel that on-chain task with its Task Receipt, then withdraw.`,
      )
    }
    // Funding parity. This link is what makes the row FUNDED — listed under
    // `?funded=true`, claimable on the board — so the reward the row advertises
    // must be the reward this tx escrowed, in the same token. Refused on any
    // difference, and on an unreadable amount or token: linking there would
    // assert funding nobody checked (this used to fall back to the row's own
    // figure). Nothing is written, so the row stays unfunded on the board; the
    // escrowed funds stay the poster's (cancel_task with the Task Receipt, then
    // withdraw_poster, returns reward + insurance in full). src/lib/funded-reward.ts.
    const funded = checkFundedReward(task, created)
    if (funded.kind === "unreadable") {
      return fail(
        "FUNDED_REWARD_UNREADABLE",
        422,
        "TaskCreatedEvent carries no readable reward amount/token — cannot verify what was escrowed; the task was not linked",
      )
    }
    // 409, not 422: every client retries a 422 as "event not indexed yet"
    // (confirmEscrowTx, agent-client and the poster scripts), and a mismatch is
    // deterministic — retrying it only delays the answer.
    if (funded.kind === "mismatch") {
      return fail(
        "FUNDED_REWARD_MISMATCH",
        409,
        `Task ${task.id} ${describeFundedRewardMismatch(funded)} — refusing to list it as funded. ` +
          `The escrowed funds are still yours: cancel that on-chain task with its Task Receipt, then withdraw.`,
      )
    }
    // One transaction: a crash must not leave the on-chain id captured
    // without its fund row (or the reverse) — every confirm kind below pairs
    // its status update + ledger write the same way.
    const updated = await db.transaction(async (tx) => {
      // Pin the component alongside the on-chain id: the two together are what
      // disambiguates this row from a collision-numbered task on another escrow
      // component (readEscrowTaskCreated already verified the event came from
      // ESCROW_COMPONENT's emitter, so it is authoritative here).
      //
      // Compare-and-swap on "still unfunded, or already this exact id": the
      // create branch is the single writer of onChainTaskId, so a second
      // confirm carrying a DIFFERENT verified TaskCreatedEvent must not
      // overwrite the first (that would leave the row pinned to an id its
      // fund ledger row doesn't match — unfindable by reconciliation). A
      // same-id idempotent retry still matches and returns the row.
      const next = await captureEscrowIdIfUnset(task.id, created.taskId, ESCROW_COMPONENT, tx)
      if (next === null) {
        throw new ConfirmStateConflict(
          `Task ${task.id} is already funded with a different on-chain id — refusing to overwrite with ${created.taskId}; reload`,
        )
      }
      // Amount = the on-chain reward_amount, verified equal to the row's reward
      // by the parity check above.
      await recordConfirmedEscrowTx(
        {
          taskId: task.id,
          txType: "fund",
          fromUserId: task.creatorId,
          amountXrd: funded.funded,
          txHash: intentHash,
        },
        tx,
      )
      return next
    })
    return { ok: true, task: updated }
  }

  // claim / submit / approve / dispute / resolve / cancel — require the
  // on-chain task_id captured
  if (task.onChainTaskId == null) {
    return fail("NOT_FUNDED", 409, "Task has no on-chain escrow id — confirm 'create' first")
  }

  // Lifecycle gate: reject confirms that would regress the current status
  // (see ALLOWED_FROM). Fails closed for any kind without an entry.
  if (!ALLOWED_FROM[kind]?.includes(task.status)) {
    return fail("INVALID_STATE", 409, `Cannot confirm '${kind}' on a '${task.status}' task`)
  }

  // dispute — the poster (via Task Receipt) or worker (via Guild badge) raised a
  // dispute on a submitted task. Verify the on-chain DisputeRaisedEvent, then
  // flip submitted → disputed. No funds move (the blueprint only records the
  // dispute + starts the auto-resolve window); settlement happens at
  // auto-resolve. Only the task's two parties may confirm it (user actors);
  // the lifecycle gate above already pins the transition to the current
  // `submitted` status.
  if (kind === "dispute") {
    if (actor.kind === "user" && task.creatorId !== actor.userId && task.assigneeId !== actor.userId) {
      return fail("FORBIDDEN", 403, "Only the task poster or worker can confirm a dispute")
    }
    // Both actor paths verify via readDisputeRaised (it carries the same
    // fail-closed emitter + task_id pin verifyEscrowEvent did, plus the
    // raised_by parse the finalize flow will need from this tx anyway), and
    // it surfaces the tx's consensus timestamp — the on-chain disputed_at the
    // blueprint's 72h auto-resolve window keys off.
    const raised = await readDisputeRaised(intentHash, ESCROW_COMPONENT, task.onChainTaskId)
    if (raised === null) {
      return fail(
        "EVENT_NOT_VERIFIED",
        422,
        `DisputeRaisedEvent for task ${task.onChainTaskId} not found in tx`,
      )
    }
    let raiserId: string
    if (actor.kind === "user") {
      raiserId = actor.userId
    } else {
      // Reconciler: no caller to attribute the marker row to — attribute
      // from the verified event's raised_by.
      if (raised.raisedBy === "Worker" && !task.assigneeId) {
        // A submitted task should always have an assignee; don't fail a
        // chain-verified dispute — attribute to the poster and flag it.
        console.warn(`Task ${task.id} dispute raised by worker but no assignee — attributed to poster`)
      }
      raiserId = raised.raisedBy === "Worker" ? (task.assigneeId ?? task.creatorId) : task.creatorId
    }
    // 0-amount marker row: no funds move, but the finalize (resolve) flow
    // re-reads the DisputeRaisedEvent's raised_by from this txHash to route
    // the auto-resolve payout. Single-writer invariant holds (this core).
    // disputedAt: persist the on-chain time so window countdowns don't lean
    // on updatedAt (display-only — the chain still enforces the real window).
    // Confirm time is the fallback; for a reconciler healing an old tx it can
    // run late, but never EARLY — the unsafe direction for a finalize prompt.
    const updated = await db.transaction(async (tx) => {
      await recordConfirmedEscrowTx(
        {
          taskId: task.id,
          txType: "dispute",
          fromUserId: raiserId,
          amountXrd: "0",
          txHash: intentHash,
        },
        tx,
      )
      return casUpdateTask(
        task.id,
        kind,
        { status: "disputed", disputedAt: raised.confirmedAt ?? new Date() },
        tx,
      )
    })
    // Notify the OTHER party — the raiser already knows they raised it. Fired
    // after the transaction above has committed (never inside it): a failed
    // notification write must not undo a chain-verified dispute. Skipped, not
    // failed, if there's no other party to tell (the no-assignee edge case
    // warned about above — nothing to notify).
    const otherPartyId = raiserId === task.creatorId ? task.assigneeId : task.creatorId
    if (otherPartyId) {
      await emitNotification({
        recipientId: otherPartyId,
        event: "dispute_raised",
        taskId: task.id,
        payload: { taskTitle: task.title, actorId: raiserId },
      })
    }
    return { ok: true, task: updated }
  }

  // cancel — the poster cancelled the task on-chain. Two blueprint paths,
  // confirmed identically: cancel_task (Open → TaskCancelledEvent) burns the
  // Task Receipt and returns reward + insurance to the poster;
  // cancel_task_by_poster_after_claim (Claimed → TaskCancelledAfterClaimEvent)
  // additionally voids the worker's claim, with the manifest routing the
  // worker's claim bond back to the worker. The bond was never escrow money
  // (worker's own collateral, returned in full), so the ledger records only
  // the poster's reward+insurance refund. Only the poster may confirm (mirrors
  // their on-chain receipt auth — the cancel tx itself required it, so a
  // reconciler mirroring the event needs no caller check); accept whichever
  // cancel event the tx emitted.
  if (kind === "cancel") {
    if (actor.kind === "user" && task.creatorId !== actor.userId) {
      return fail("FORBIDDEN", 403, "Only the task creator can confirm a cancel")
    }
    const verified =
      (await verifyEscrowEvent(intentHash, "TaskCancelledEvent", ESCROW_COMPONENT, task.onChainTaskId)) ||
      (await verifyEscrowEvent(intentHash, "TaskCancelledAfterClaimEvent", ESCROW_COMPONENT, task.onChainTaskId))
    if (!verified) {
      return fail(
        "EVENT_NOT_VERIFIED",
        422,
        `No TaskCancelledEvent or TaskCancelledAfterClaimEvent for task ${task.onChainTaskId} found in tx`,
      )
    }
    // Refund row: reward + insurance back to the poster. Amount sources from
    // the verified fund row captured at create (exact on-chain deposit),
    // falling back to the task's recorded reward — mirrors how approve
    // sources its release amount. Cannot collide with a resolve-written
    // refund row: cancelled (open/assigned) and disputed lifecycles are
    // disjoint, and the writer is idempotent on (taskId, txType) anyway.
    const fundRow = (await findEscrowByTask(task.id)).find((r) => r.txType === "fund")
    const updated = await db.transaction(async (tx) => {
      await recordConfirmedEscrowTx(
        {
          taskId: task.id,
          txType: "refund",
          fromUserId: task.creatorId,
          toUserId: task.creatorId,
          amountXrd: fundRow?.amountXrd ?? task.rewardXrd,
          txHash: intentHash,
        },
        tx,
      )
      return casUpdateTask(task.id, kind, { status: "cancelled" }, tx)
    })
    return { ok: true, task: updated }
  }

  // expire — a claim lapsed and `expire_claim` was sent on-chain. The blueprint
  // resets the task to Open, clears worker_account / claim_deadline /
  // current_claim_receipt_id, and forfeits the claim bond to the operator; the
  // reward + insurance stay locked in escrow, so the task is claimable again by
  // anyone. The DB must follow, or the row keeps naming a worker who no longer
  // holds the claim — and a DIFFERENT worker can legitimately claim it on-chain
  // while the row still points at the abandoner.
  //
  // RECONCILER ACTOR ONLY. expire_claim is public on-chain, so the sender is not
  // necessarily any party to the task and may hold no session; there is nobody
  // whose authz would mean anything here. The verified ClaimExpiredEvent IS the
  // gate — the same trust basis as `resolve` above — and ROUTE_KINDS keeps this
  // kind off the public confirm route so the only way in is resync.
  //
  // No ledger row: reward and insurance did not move (they stay in escrow for
  // the next claimer), and the forfeited bond is the worker's stake, not a
  // task settlement leg — escrow_transactions has no type for it, and a task
  // may expire more than once, which the (taskId, txType) unique index would
  // reject. The bond forfeiture is recorded on-chain in the event.
  if (kind === "expire") {
    if (actor.kind === "user") {
      return fail(
        "NOT_CONFIRMABLE",
        403,
        "'expire' is not confirmable directly — expire_claim is public on-chain; resync the task from chain instead",
      )
    }
    const verified = await verifyEscrowEvent(
      intentHash,
      "ClaimExpiredEvent",
      ESCROW_COMPONENT,
      task.onChainTaskId,
    )
    if (!verified) {
      return fail(
        "EVENT_NOT_VERIFIED",
        422,
        `ClaimExpiredEvent for task ${task.onChainTaskId} not found in tx`,
      )
    }
    // Clearing assigneeId is the point of this branch: the on-chain claim is
    // gone, so leaving it set would misattribute the next claimer's work — and
    // would let the abandoner's stale receipt look like the live one.
    const updated = await casUpdateTask(task.id, kind, { status: "open", assigneeId: null })
    return { ok: true, task: updated }
  }

  // resolve — the dispute auto-resolved on-chain (public, time-gated keeper
  // call: ANYONE may send it after the 72h window, so there is deliberately
  // no party check for ANY actor — the verified DisputeAutoResolvedEvent is
  // the gate). Ledger rows are written from the VERIFIED event amounts, never
  // from DB-recorded values.
  //
  // ⚠️ CORRECTED 2026-08-25: this said "with the deployed FavorDisputeRaiser
  // default exactly one side is > 0". The live component reads SplitEvenly
  // (chain-read), under which BOTH sides are > 0 on every auto-resolve. The
  // code already handled that; only the comment's premise was wrong — but it is
  // the premise a reader would reason from, and the same stale belief reached an
  // operator-facing alert.
  if (kind === "resolve" || kind === "arbitrate") {
    // Two on-chain routes settle a dispute and they must book IDENTICALLY:
    //   resolve   — auto_resolve_dispute, the 72h timeout, DisputeAutoResolvedEvent
    //   arbitrate — resolve_dispute, a human arbiter, DisputeResolvedEvent
    // Both events carry worker_amount/poster_amount, so one handler serves both
    // and they cannot drift. The arbiter event additionally carries the fee.
    const resolved =
      kind === "arbitrate"
        ? await readDisputeResolved(intentHash, ESCROW_COMPONENT, task.onChainTaskId)
        : await readDisputeAutoResolved(intentHash, ESCROW_COMPONENT, task.onChainTaskId)
    if (resolved === null) {
      return fail(
        "EVENT_NOT_VERIFIED",
        422,
        `${kind === "arbitrate" ? "DisputeResolvedEvent" : "DisputeAutoResolvedEvent"} ` +
          `for task ${task.onChainTaskId} not found in tx`,
      )
    }
    // parseFloat is used ONLY for the >0 test; the exact decimal strings
    // from the event pass through to the ledger untouched.
    const workerWon = parseFloat(resolved.workerAmount) > 0
    const posterRefunded = parseFloat(resolved.posterAmount) > 0
    // ⚠️ THE ARBITER FEE HAS NO LEDGER ROW, AND CANNOT SILENTLY GROW ONE.
    // `resolve_dispute` takes `arbiter_fee_pct * insurance` out of the insurance
    // vault before splitting (lib.rs, `resolve_dispute` body) and hands it to the
    // arbiter. Nothing here books it: only worker_amount and poster_amount become
    // escrow_transactions rows. That is harmless TODAY and only today —
    // `arbiter_fee_pct` is a write-once instantiate arg fixed at 0 on the live
    // component, so the fee is always "0". The moment a swapped component sets it
    // above zero (the dispute-economics track, E5, contemplates exactly that),
    // worker + poster would legitimately be LESS than reward + insurance with
    // nothing in the DB explaining the difference — which reads as unexplained
    // drift to the money-parity watcher and to anyone reconciling the books.
    // Loud rather than silent until there is a row to write.
    // Only the arbiter event carries a fee; the auto-resolve event has no such
    // field, hence the narrowing rather than a cast.
    const arbiterFee =
      "arbiterFee" in resolved && typeof resolved.arbiterFee === "string"
        ? resolved.arbiterFee
        : "0"
    if (parseFloat(arbiterFee) > 0) {
      console.warn(
        `Task ${task.id}: arbiter took a fee of ${arbiterFee} on settlement and the ` +
          `ledger has no row for it — worker+poster will not reconcile to reward+insurance. ` +
          `An arbiter-fee ledger type is needed before arbiter_fee_pct ships above zero.`,
      )
    }
    if (workerWon && !task.assigneeId) {
      // Mirrors the approve path: don't fail a chain-verified settlement —
      // record it unattributed and flag for the operator.
      console.warn(`Task ${task.id} auto-resolved to the worker with no assignee — earnings unattributed`)
    }
    const updated = await db.transaction(async (tx) => {
      if (workerWon) {
        const release = await recordConfirmedEscrowTx(
          {
            taskId: task.id,
            txType: "release",
            fromUserId: task.creatorId,
            toUserId: task.assigneeId,
            amountXrd: resolved.workerAmount,
            txHash: intentHash,
          },
          tx,
        )
        // Award XP/reputation with the payout, in the same transaction. Keyed
        // on the FIRST insert of the (taskId, 'release') row — the unique
        // index guarantees a single insert ever, so a replayed confirm
        // (inserted=false) can never double-award. A poster-favoured resolve
        // writes no release row and earns the worker nothing.
        if (release.inserted && task.assigneeId) {
          await awardTaskCompletion(task.assigneeId, completionAward(task), tx)
        }
      }
      if (posterRefunded) {
        await recordConfirmedEscrowTx(
          {
            taskId: task.id,
            txType: "refund",
            fromUserId: task.creatorId,
            toUserId: task.creatorId,
            amountXrd: resolved.posterAmount,
            txHash: intentHash,
          },
          tx,
        )
      }
      // Worker getting paid = the task counts as completed/earnings (`paid`);
      // otherwise the poster got their funds back (`refunded`).
      return casUpdateTask(task.id, kind, { status: workerWon ? "paid" : "refunded" }, tx)
    })
    return { ok: true, task: updated }
  }

  const eventName =
    kind === "claim"
      ? "TaskClaimedEvent"
      : kind === "submit"
        ? "WorkSubmittedEvent"
        : "TaskReleasedEvent"
  const verified = await verifyEscrowEvent(intentHash, eventName, ESCROW_COMPONENT, task.onChainTaskId)
  if (!verified) {
    return fail(
      "EVENT_NOT_VERIFIED",
      422,
      `${eventName} for task ${task.onChainTaskId} not found in tx`,
    )
  }

  // Bind the DB assignee. verifyEscrowEvent proved the task was claimed in this
  // tx, but TaskClaimedEvent carries only claimer_badge_id (no account) — it
  // does NOT name who the assignee is. The two actors close that gap
  // differently, both fail-closed:
  //   • user       — must PROVE they are the claimer by holding the task's
  //                  LIVE claim receipt (current_claim_receipt_id). A task_id
  //                  match alone is NOT proof: expire_claim resets
  //                  current_claim_receipt_id without burning the previous
  //                  worker's receipt, so after expire→re-claim the walked-away
  //                  worker's ORPHAN receipt still matches on task_id and could
  //                  seize the assignee slot (on-chain funds stay safe — the
  //                  live-receipt assert gates submit/payout — but the
  //                  off-chain assignee and later earnings attribution would be
  //                  spoofable). Mirrors the blueprint's own submit gate.
  //   • reconciler — trusts the assignee it already resolved from the chain (the
  //                  live claim's on-chain worker_account; guaranteed non-null by
  //                  the top-of-function guard).
  if (kind === "claim") {
    let assigneeId: string
    if (actor.kind === "user") {
      // Self-claim: refuse before the Gateway read. The blueprint already
      // asserts `worker != task.poster` (lib.rs `claim_task`'s "self-claim not
      // allowed" assert), so a self-claim can never
      // commit — but nothing on this side said so, and the UI happily rendered
      // the Claim button to the poster. The result was a user signing a
      // transaction guaranteed to land as CommittedFailure and burning the fee
      // for it. The app blocks self-SUBMIT already (403 SELF_SUBMIT in
      // tasks/[id]/submissions/route.ts) — this is the same rule, one step
      // earlier, where it is free.
      //
      // Deliberately NOT applied to the reconciler branch: its job is to move
      // the DB toward chain truth, and refusing there would strand a row it
      // could otherwise heal. If a self-claim ever DOES appear on chain it means
      // the M5 spoof was used (`poster` is a free parameter of create_task, so a
      // decoy address bypasses the blueprint gate) — that is a chain-side fix,
      // and the reconciler recording reality is the correct response to it.
      if (task.creatorId === actor.userId) {
        return fail("SELF_CLAIM", 403, "Cannot claim your own task")
      }
      let live: OnChainClaimInfo
      try {
        live = await readOnChainClaimInfo(
          task.onChainTaskId,
          task.escrowComponent ?? ESCROW_COMPONENT,
        )
      } catch {
        // Fail closed but RETRYABLE: an unreadable live state must not mint an
        // assignee, and a Gateway blip must not be mislabelled as an authz
        // verdict (403) — 422 matches the other transient verification lanes.
        return fail(
          "CLAIM_STATE_UNREADABLE",
          422,
          "Could not read the live on-chain claim to verify the receipt — retry",
        )
      }
      if (live.currentClaimReceiptId === null) {
        return fail(
          "NOT_CLAIMER",
          403,
          "No live claim on-chain for this task (the claim expired, was cancelled, or already submitted)",
        )
      }
      const holds = await holdsClaimReceipt(
        actor.userId,
        ESCROW_CLAIM_RECEIPT_RESOURCE,
        live.currentClaimReceiptId,
      )
      if (!holds) {
        return fail(
          "NOT_CLAIMER",
          403,
          "Caller does not hold the active claim receipt for this task (a receipt from an expired claim does not count)",
        )
      }
      assigneeId = actor.userId
    } else {
      // Reconciler: the null case was already bounced at the top guard; this is
      // a fail-closed backstop so a future refactor can't heal without an
      // assignee.
      if (!actor.resolvedAssignee) {
        return fail("NOT_RECONCILABLE", 501, "Cannot reconcile 'claim' without a resolved assignee")
      }
      assigneeId = actor.resolvedAssignee
    }
    const updated = await casUpdateTask(task.id, kind, { status: "assigned", assigneeId })
    // Tell the poster their task was claimed — today the only way they'd know
    // is by revisiting the page. After the write, never inside it (see the
    // module doc on src/lib/notifications.ts).
    await emitNotification({
      recipientId: task.creatorId,
      event: "task_claimed",
      taskId: task.id,
      payload: { taskTitle: task.title, actorId: assigneeId },
    })
    return { ok: true, task: updated }
  }

  // approve — release verified. Record the release into the ledger (single
  // writer: real txHash + the funded amount) before advancing to the terminal
  // `paid` state. Amount comes from the verified `fund` row captured at create.
  // No caller-authz for ANY actor (parity with the live route): the release tx
  // itself required the poster's Task Receipt, and the verified event +
  // lifecycle gate bound what a confirm can do with it.
  if (kind === "approve") {
    const fundRow = (await findEscrowByTask(task.id)).find((r) => r.txType === "fund")
    if (!task.assigneeId) {
      // assigneeId is set at claim-confirm; a release with no assignee can't be
      // attributed for earnings. Don't fail the on-chain-verified release — flag it.
      console.warn(`Task ${task.id} released with no assignee — earnings unattributed`)
    }
    const updated = await db.transaction(async (tx) => {
      const release = await recordConfirmedEscrowTx(
        {
          taskId: task.id,
          txType: "release",
          fromUserId: task.creatorId,
          toUserId: task.assigneeId,
          amountXrd: fundRow?.amountXrd ?? task.rewardXrd,
          txHash: intentHash,
        },
        tx,
      )
      // Award the worker's XP/reputation atomically with the payout. Keyed on
      // the FIRST insert of the (taskId, 'release') row (unique index = single
      // insert ever): the approve→paid retry allowed by ALLOWED_FROM replays
      // the ledger write as a no-op (inserted=false), so it can never
      // double-award. No assignee → nothing to credit (warned above).
      if (release.inserted && task.assigneeId) {
        await awardTaskCompletion(task.assigneeId, completionAward(task), tx)
      }
      return casUpdateTask(task.id, kind, { status: "paid" }, tx)
    })
    return { ok: true, task: updated }
  }

  // submit — status-only sync (no ledger row; no caller-authz, parity with the
  // live route: the submit tx itself required the worker's claim receipt).
  const updated = await casUpdateTask(task.id, kind, { status: "submitted" })
  return { ok: true, task: updated }
}
