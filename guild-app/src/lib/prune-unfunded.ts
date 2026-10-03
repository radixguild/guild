// Pure decision logic for the unfunded-create sweep (R3-1), extracted so the
// candidate predicate is unit-testable without the DB (mirrors the
// src/lib/reconcile-claim.ts + src/lib/escrow-drift.ts precedent). The sweep
// script (scripts/prune-unfunded.mjs) does the I/O — select candidates, re-check
// each under a race-safe CAS, set hidden_at — and delegates the WHAT/whether here.
//
// WHY: POST /tasks writes reward_xrd at create; on_chain_task_id only lands when
// the poster signs the create_task manifest and its confirm posts back. If they
// abandon the create (close the tab, never sign), the row sits `open` forever,
// cluttering the public board and inflating the open-count stat.
//
// SOFT-HIDE, NOT CANCEL (money-safety, ruled 2026-07-08): the sweep does NOT
// cancel these rows. `on_chain_task_id IS NULL` does NOT mean "unfunded" — a
// poster who funded on-chain but whose create-confirm was lost ALSO sits at
// open + NULL id (the escrow holds real XRD; chain state is Open), and the
// reconciler cannot heal `create` (no DB linkage — see escrow-confirm.ts), so
// that row is indistinguishable from a never-signed one and persists indefinitely.
// Terminal-cancelling it would strand real escrow and lose the linkage forever.
// Instead the sweep sets a reversible `hidden_at` marker that only DECLUTTERS the
// board/stats; the row stays `open`, escrow is untouched, and a late confirm/resync
// (which sets on_chain_task_id) auto-un-hides it via the read filter.

/** Default age after which an unfunded, never-linked create is swept (hidden). */
export const UNFUNDED_TTL_MS = 24 * 60 * 60 * 1000 // 24h

export interface UnfundedPruneCandidate {
  status: string
  onChainTaskId: number | null
  rewardXrd: string // numeric column → string
  createdAt: Date
}

/**
 * True when a task is an abandoned, never-linked create old enough to sweep
 * (hide). Pure + total. All four conditions must hold:
 *   • status === "open"          — untouched; a claim/cancel already moved it on.
 *   • onChainTaskId === null     — no DB→chain linkage yet. NOT a proof of
 *                                  "unfunded" (see the SOFT-HIDE note above) —
 *                                  which is exactly why the action is a reversible
 *                                  hide, never a cancel.
 *   • rewardXrd > 0              — a 0-reward row is an off-chain/XP task that was
 *                                  never meant to be funded; not a stale create.
 *   • createdAt older than ttl   — grace window for a poster mid-signing.
 *
 * `now`/`ttlMs` are injected so callers pass a single consistent clock and the
 * TTL is overridable (--ttl-hours). The age test is STRICT (age > ttl), matching
 * the candidate query's `created_at < now-ttl` exactly so this belt-and-suspenders
 * re-check can never diverge from the SQL gate at the boundary.
 */
export function isPrunableUnfunded(
  task: UnfundedPruneCandidate,
  now: Date,
  ttlMs: number = UNFUNDED_TTL_MS,
): boolean {
  if (task.status !== "open") return false
  if (task.onChainTaskId !== null) return false
  if (!(parseFloat(task.rewardXrd) > 0)) return false
  return now.getTime() - task.createdAt.getTime() > ttlMs
}

/** The `created_at` cutoff for the candidate query: rows created before this are old enough. */
export function unfundedCutoff(now: Date, ttlMs: number = UNFUNDED_TTL_MS): Date {
  return new Date(now.getTime() - ttlMs)
}
