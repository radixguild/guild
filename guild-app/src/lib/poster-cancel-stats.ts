/**
 * Poster-side cancel-after-claim history.
 *
 * docs/PROJECT-STATE.md's 2026-09-01 §20 design packet — an unnumbered
 * "Also in §20" bullet, NOT §20.4 (that's an unrelated, still-open
 * expire-bounty poster leak) — names this a SHIPPABLE-NOW app-side item, no
 * ruling needed: "show workers a poster's cancels-after-claim count BEFORE
 * claim + a claim-time disclosure that the bond returns but the time does
 * not." This module is the pure half of that — the DB aggregation lives
 * in src/db/queries/poster-cancel-stats.ts, same split as src/lib/trust.ts /
 * src/db/queries/trust.ts.
 *
 * No migration: both counts read straight off tasks.status and
 * tasks.assignee_id, which already exist and are already written by the
 * escrow confirm core. See the DB query for how a cancel-after-claim is told
 * apart from an ordinary open-task cancel using only those two columns.
 */

export interface PosterCancelStats {
  /** Every task this identity has ever created, any status. */
  totalPosted: number
  /** Of those, cancelled via cancel_task_by_poster_after_claim — i.e. a
   *  worker had already claimed it when the poster cancelled. */
  cancelledAfterClaim: number
}

export const EMPTY_POSTER_CANCEL_STATS: PosterCancelStats = {
  totalPosted: 0,
  cancelledAfterClaim: 0,
}

/**
 * cancelledAfterClaim ÷ totalPosted. `null` when the poster has posted
 * nothing — should not occur for a real task's creator (they posted at least
 * this one task), but the type stays honest about the empty case rather than
 * silently reporting a 0% rate for a poster with no history at all.
 */
export function cancelAfterClaimRate(
  stats: Pick<PosterCancelStats, "totalPosted" | "cancelledAfterClaim">,
): number | null {
  return stats.totalPosted > 0 ? stats.cancelledAfterClaim / stats.totalPosted : null
}
