import { sql } from "drizzle-orm"
import { db } from "@/db"
import { EMPTY_TRUST_STATS, type TrustStats } from "@/lib/trust"

/**
 * One round-trip of correlated scalar subqueries (the getUserProfileSummary
 * shape) over tasks + escrow_transactions + submissions — the trust ledger
 * (TASK-TERMS-DESIGN §4.1). Notes on the source of truth:
 *
 * - `status = 'paid'` is release-row-equivalent: the confirm core writes both
 *   in one transaction, so counting task rows avoids a join and stays indexed.
 * - Dispute attribution: the confirm core sets the dispute row's from_user_id
 *   to the chain-derived raiser (DisputeRaisedEvent.raised_by), so
 *   "against X" = a confirmed dispute on X's task raised by someone else.
 * - On-time uses submissions.created_at (server receipt) vs the task deadline;
 *   tasks without a deadline are excluded from the rate entirely.
 *
 * Pre-slice-2 disputes lack marker rows (0 affected at time of writing) — they
 * simply don't count, which fails toward leniency, not toward false accusals.
 */
export async function getTrustStats(address: string): Promise<TrustStats> {
  const [row] = await db
    .select({
      completed: sql<number>`(
        SELECT count(*)::int FROM tasks
        WHERE assignee_id = ${address} AND status = 'paid'
      )`,
      claimed: sql<number>`(
        SELECT count(*)::int FROM tasks WHERE assignee_id = ${address}
      )`,
      failed: sql<number>`(
        SELECT count(*)::int FROM tasks
        WHERE assignee_id = ${address} AND status IN ('cancelled', 'refunded')
      )`,
      disputesRaised: sql<number>`(
        SELECT count(*)::int FROM escrow_transactions
        WHERE tx_type = 'dispute' AND status = 'confirmed'
        AND from_user_id = ${address}
      )`,
      disputesAgainst: sql<number>`(
        SELECT count(*)::int FROM escrow_transactions e
        JOIN tasks t ON t.id = e.task_id
        WHERE e.tx_type = 'dispute' AND e.status = 'confirmed'
        AND e.from_user_id != ${address}
        AND (t.assignee_id = ${address} OR t.creator_id = ${address})
      )`,
      deadlineSubmits: sql<number>`(
        SELECT count(*)::int FROM submissions s
        JOIN tasks t ON t.id = s.task_id
        WHERE s.submitter_id = ${address} AND t.deadline IS NOT NULL
      )`,
      onTimeSubmits: sql<number>`(
        SELECT count(*)::int FROM submissions s
        JOIN tasks t ON t.id = s.task_id
        WHERE s.submitter_id = ${address} AND t.deadline IS NOT NULL
        AND s.created_at <= t.deadline
      )`,
      avgDeliveryDays: sql<number | null>`(
        SELECT AVG(EXTRACT(EPOCH FROM (s.approved_at - s.created_at)) / 86400.0)::float8 FROM submissions s
        WHERE s.submitter_id = ${address} AND s.status = 'approved'
        AND s.approved_at IS NOT NULL
      )`,
    })
    .from(sql`(SELECT 1) AS trust_anchor`)

  // The constant-row FROM always yields exactly one row; the fallback only
  // guards a future refactor away from it.
  return row ?? EMPTY_TRUST_STATS
}
