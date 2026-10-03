import { eq, sql } from "drizzle-orm"
import { db } from "@/db"
import { tasks } from "@/db/schema"
import { EMPTY_POSTER_CANCEL_STATS, type PosterCancelStats } from "@/lib/poster-cancel-stats"

/**
 * Poster-side cancel-after-claim history, read straight off existing columns
 * (docs/PROJECT-STATE.md's 2026-09-01 §20 design packet, unnumbered
 * "Also in §20" bullet — NOT §20.4, an unrelated open bug — SHIPPABLE-NOW,
 * no migration, no ruling needed).
 *
 * `cancel_task` (Open → cancelled) and `cancel_task_by_poster_after_claim`
 * (Claimed → cancelled) both confirm to the exact same `tasks.status =
 * 'cancelled'` write (escrow-confirm.ts's `cancel` branch —
 * `casUpdateTask(task.id, kind, { status: "cancelled" })`, gated by
 * `ALLOWED_FROM.cancel = ["open", "assigned", "cancelled"]`). That branch
 * never touches `assignee_id`. `assignee_id` is set only by the claim
 * confirm and cleared only by `expire_claim` (never by cancel) — so a
 * `cancelled` row that still carries a non-null `assignee_id` can only have
 * left the Claimed state, i.e. it was cancelled AFTER a worker claimed it.
 * That is the entire signal this query reads; there is no separate
 * "cancel reason" column, and none is added here.
 */
export async function getPosterCancelStats(posterId: string): Promise<PosterCancelStats> {
  const [row] = await db
    .select({
      totalPosted: sql<number>`count(*)::int`,
      cancelledAfterClaim: sql<number>`count(*) filter (
        where ${tasks.status} = 'cancelled' and ${tasks.assigneeId} is not null
      )::int`,
    })
    .from(tasks)
    .where(eq(tasks.creatorId, posterId))

  return row ?? EMPTY_POSTER_CANCEL_STATS
}
