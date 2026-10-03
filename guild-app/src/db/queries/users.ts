import { eq, sql, desc, or, gt, and, notInArray } from "drizzle-orm"
import { db, type DbExecutor } from "@/db"
import { users } from "@/db/schema"
import { trustTierFor, type TrustTier } from "@/lib/trust"
import { getTestAccounts } from "@/lib/test-accounts"

export async function findUserById(id: string) {
  return (await db.query.users.findFirst({ where: eq(users.id, id) })) ?? null
}

export interface LeaderboardRow {
  id: string
  displayName: string | null
  badgeTier: string | null
  reputation: number
  xp: number
  tasksCompleted: number
  tasksThisMonth: number
  xrdEarned: string
  xrdEarnedThisMonth: string
  disputesAgainst: number
  deadlineSubmits: number
  onTimeSubmits: number
  /** Derived per row from the columns above (src/lib/trust.ts). */
  trustTier: TrustTier
}

// Build the leaderboard query. Extracted from getLeaderboard (rather than inlined)
// so leaderboard-sql.test.ts can assert the generated SQL via `.toSQL()` without a DB.
//
// The correlated subqueries below reference the outer row as the literal `users.id`,
// NOT `${users.id}`: Drizzle renders an interpolated column unqualified ("id") inside a
// `.select()` projection, and an unqualified "id" binds to each subquery's own table
// (tasks.id / escrow_transactions.id — both integer), producing `text = integer`
// (Postgres 42883 — the /leaderboard 500). The literal `users.id` is unambiguous: neither
// subquery's FROM has a `users` table, so it correlates to the outer users row (text).
// `excluded` (G-508): account addresses filtered OUT of the public leaderboard —
// test/operator fleet accounts whose smoke payouts credited real XP/reputation.
// Defaults to the GUILD_TEST_ACCOUNTS env list; empty => no filtering (unchanged
// SQL), so the leaderboard-sql `.toSQL()` shape test stays green with no env set.
export function leaderboardQuery(limit = 50, excluded: string[] = getTestAccounts()) {
  const active = or(gt(users.reputation, 0), gt(users.xp, 0))
  const where =
    excluded.length > 0 ? and(active, notInArray(users.id, excluded)) : active
  return db
    .select({
      id: users.id,
      displayName: users.displayName,
      badgeTier: users.badgeTier,
      reputation: users.reputation,
      xp: users.xp,
      tasksCompleted: sql<number>`(
        SELECT count(*)::int FROM tasks
        WHERE tasks.assignee_id = users.id
        AND tasks.status = 'paid'
      )`,
      tasksThisMonth: sql<number>`(
        SELECT count(*)::int FROM tasks
        WHERE tasks.assignee_id = users.id
        AND tasks.status = 'paid'
        AND tasks.updated_at >= date_trunc('month', now())
      )`,
      xrdEarned: sql<string>`COALESCE((
        SELECT sum(amount_xrd)::text FROM escrow_transactions
        WHERE to_user_id = users.id
        AND tx_type = 'release'
        AND status = 'confirmed'
      ), '0')`,
      xrdEarnedThisMonth: sql<string>`COALESCE((
        SELECT sum(amount_xrd)::text FROM escrow_transactions
        WHERE to_user_id = users.id
        AND tx_type = 'release'
        AND status = 'confirmed'
        AND created_at >= date_trunc('month', now())
      ), '0')`,
      // Trust-tier inputs (src/lib/trust.ts) — same literal users.id rule. The
      // aliased joins (e/s/t) keep their own names; users stays unambiguous.
      disputesAgainst: sql<number>`(
        SELECT count(*)::int FROM escrow_transactions e
        JOIN tasks t ON t.id = e.task_id
        WHERE e.tx_type = 'dispute' AND e.status = 'confirmed'
        AND e.from_user_id != users.id
        AND (t.assignee_id = users.id OR t.creator_id = users.id)
      )`,
      deadlineSubmits: sql<number>`(
        SELECT count(*)::int FROM submissions s
        JOIN tasks t ON t.id = s.task_id
        WHERE s.submitter_id = users.id AND t.deadline IS NOT NULL
      )`,
      onTimeSubmits: sql<number>`(
        SELECT count(*)::int FROM submissions s
        JOIN tasks t ON t.id = s.task_id
        WHERE s.submitter_id = users.id AND t.deadline IS NOT NULL
        AND s.created_at <= t.deadline
      )`,
    })
    .from(users)
    .where(where)
    .orderBy(desc(users.reputation), desc(users.xp))
    .limit(limit)
}

export async function getLeaderboard(limit = 50): Promise<LeaderboardRow[]> {
  const rows = await leaderboardQuery(limit)
  return rows.map((row) => ({
    ...row,
    trustTier: trustTierFor({ completed: row.tasksCompleted, ...row }),
  }))
}

export async function createUser(address: string) {
  const [user] = await db.insert(users).values({ id: address }).returning()
  return user
}

// `onConflictDoNothing` means an existing row's columns are never touched by
// this call — including `suspendedAt`/`suspendedReason` (P1-14 app-level
// suspension). A suspended address signing in again is returned AS
// suspended, never silently reactivated; see auth/verify/route.ts, which
// checks `user.suspendedAt` on the row this function returns before minting
// a session.
export async function findOrCreateUser(address: string) {
  await db.insert(users).values({ id: address }).onConflictDoNothing()
  const user = await db.query.users.findFirst({ where: eq(users.id, address) })
  return user!
}

// Credit a worker's task-completion XP/reputation. Called by the escrow
// confirm core inside the release transaction (pass its `executor`) so the
// award commits or rolls back with the ledger write. Increments are SQL-side
// (xp = xp + n), never read-modify-write, so concurrent awards for different
// tasks can't lose updates.
export async function awardTaskCompletion(
  userId: string,
  award: { xp: number; reputation: number },
  executor: DbExecutor = db,
) {
  const [user] = await executor
    .update(users)
    .set({
      xp: sql`${users.xp} + ${award.xp}`,
      reputation: sql`${users.reputation} + ${award.reputation}`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning()
  return user
}

export async function updateUser(id: string, data: Partial<typeof users.$inferInsert>) {
  const [user] = await db
    .update(users)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning()
  return user
}

export interface UserProfileSummary {
  address: string
  displayName: string | null
  badgeTier: string | null
  xp: number
  reputation: number
  isAgent: boolean
  tasksCreated: number
  tasksAssigned: number
  tasksCompleted: number
  submissionsTotal: number
  submissionsApproved: number
  submissionsRejected: number
  xrdEarned: string
  xrdEarnedThisMonth: string
  xrdSpent: string
  createdAt: string
  updatedAt: string
}

export async function getUserProfileSummary(address: string): Promise<UserProfileSummary | null> {
  const user = await db.query.users.findFirst({ where: eq(users.id, address) })
  if (!user) return null

  const [agg] = await db
    .select({
      tasksCreated: sql<number>`(
        SELECT count(*)::int FROM tasks WHERE creator_id = ${address}
      )`,
      tasksAssigned: sql<number>`(
        SELECT count(*)::int FROM tasks WHERE assignee_id = ${address}
      )`,
      tasksCompleted: sql<number>`(
        SELECT count(*)::int FROM tasks
        WHERE assignee_id = ${address} AND status = 'paid'
      )`,
      submissionsTotal: sql<number>`(
        SELECT count(*)::int FROM submissions WHERE submitter_id = ${address}
      )`,
      submissionsApproved: sql<number>`(
        SELECT count(*)::int FROM submissions
        WHERE submitter_id = ${address} AND status = 'approved'
      )`,
      submissionsRejected: sql<number>`(
        SELECT count(*)::int FROM submissions
        WHERE submitter_id = ${address} AND status = 'rejected'
      )`,
      xrdEarned: sql<string>`COALESCE((
        SELECT sum(amount_xrd)::text FROM escrow_transactions
        WHERE to_user_id = ${address}
        AND tx_type = 'release'
        AND status = 'confirmed'
      ), '0')`,
      xrdEarnedThisMonth: sql<string>`COALESCE((
        SELECT sum(amount_xrd)::text FROM escrow_transactions
        WHERE to_user_id = ${address}
        AND tx_type = 'release'
        AND status = 'confirmed'
        AND created_at >= date_trunc('month', now())
      ), '0')`,
      xrdSpent: sql<string>`COALESCE((
        SELECT sum(amount_xrd)::text FROM escrow_transactions
        WHERE from_user_id = ${address}
        AND tx_type = 'fund'
        AND status = 'confirmed'
      ), '0')`,
    })
    .from(users)
    .where(eq(users.id, address))

  return {
    address: user.id,
    displayName: user.displayName,
    badgeTier: user.badgeTier,
    xp: user.xp,
    reputation: user.reputation,
    isAgent: user.isAgent,
    tasksCreated: agg.tasksCreated,
    tasksAssigned: agg.tasksAssigned,
    tasksCompleted: agg.tasksCompleted,
    submissionsTotal: agg.submissionsTotal,
    submissionsApproved: agg.submissionsApproved,
    submissionsRejected: agg.submissionsRejected,
    xrdEarned: agg.xrdEarned,
    xrdEarnedThisMonth: agg.xrdEarnedThisMonth,
    xrdSpent: agg.xrdSpent,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  }
}
