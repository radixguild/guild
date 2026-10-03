import { eq, ne, and, inArray, desc, sql, count } from "drizzle-orm"
import { db } from "@/db"
import { tasks, workingGroups, userWorkingGroups, workingGroupProposals } from "@/db/schema"
import type { NotificationLevel } from "@/db/schema"
import { notHiddenStale } from "@/db/queries/tasks"

// Working groups — Model A queries (docs/design/working-groups-model-a.md).
//
// The feed is fanout-on-READ: one indexed join, no materialization. At this
// scale a new task fans to at most hundreds of subscribers, so a notifications
// table would be a consistency liability bought for nothing. The ONE place
// fanout-on-write is correct is the push set (listGroupWatchers), which is a
// tiny query run once per task insert.

/** Catalog row as the UI needs it: the group, its size, its live work, and —
 *  when a viewer is known — that viewer's own membership level. */
export interface WorkingGroupSummary {
  id: number
  slug: string
  name: string
  description: string
  sortOrder: number
  isActive: boolean
  /** Every membership row. A `muted` member is still subscribed — leaving is a
   *  DELETE, muting is a level — so they count here. */
  memberCount: number
  /** Open tasks routed to this group, under the board's own visibility rule. */
  openTaskCount: number
  /** null = the viewer has not joined (or there is no viewer). */
  viewerLevel: NotificationLevel | null
}

// ⚠️ These correlated subqueries use RAW, TABLE-QUALIFIED identifiers on purpose.
// Drizzle renders `${table.column}` inside a `sql` template as a BARE column
// name — no table qualifier — so the natural-looking
//   sql`... from ${tasks} where ${tasks.workingGroupId} = ${workingGroups.id}`
// compiles to `where "working_group_id" = "id"`, and inside a subquery over
// `tasks` that `"id"` resolves to **tasks.id**, not working_groups.id. The
// subquery silently correlates to itself and returns a plausible-but-wrong
// number. Measured: openTaskCount returned 0 where the answer was 2, while
// memberCount happened to be CORRECT for the same code — because
// user_working_groups has no `id` column, so the bare name fell through to the
// outer scope. One of the two was right by accident, which is exactly why this
// is written explicitly rather than left to name resolution.
// Table and column names here are fixed literals, never user input; the one
// user-supplied value (viewerId) stays a bound parameter below.
const memberCountSql = sql<number>`(
  select count(*)::int from user_working_groups m
  where m.working_group_id = working_groups.id
)`

// `status = 'open'` already excludes every non-open row, so the sweep predicate
// reduces to its two live branches: a row is visible if it was never swept, or
// if it has since been funded on-chain (which is what un-sweeps it).
const openTaskCountSql = sql<number>`(
  select count(*)::int from tasks t
  where t.working_group_id = working_groups.id
    and t.status = 'open'
    and (t.hidden_at is null or t.on_chain_task_id is not null)
)`

/**
 * The group catalog. `includeInactive` exists for the admin surface only —
 * soft-archived groups stay out of the public browse by default, which is the
 * whole point of archiving them.
 */
export async function listWorkingGroups(
  viewerId?: string,
  opts: { includeInactive?: boolean } = {},
): Promise<WorkingGroupSummary[]> {
  const rows = await db
    .select({
      id: workingGroups.id,
      slug: workingGroups.slug,
      name: workingGroups.name,
      description: workingGroups.description,
      sortOrder: workingGroups.sortOrder,
      isActive: workingGroups.isActive,
      memberCount: memberCountSql,
      openTaskCount: openTaskCountSql,
      viewerLevel: viewerId
        ? sql<NotificationLevel | null>`(
            select v.level from user_working_groups v
            where v.working_group_id = working_groups.id
              and v.user_id = ${viewerId}
          )`
        : sql<NotificationLevel | null>`null`,
    })
    .from(workingGroups)
    .where(opts.includeInactive ? undefined : eq(workingGroups.isActive, true))
    .orderBy(workingGroups.sortOrder, workingGroups.id)

  return rows
}

export async function getWorkingGroupBySlug(slug: string, viewerId?: string) {
  const rows = await listWorkingGroups(viewerId, { includeInactive: true })
  return rows.find((g) => g.slug === slug) ?? null
}

/**
 * Existence + routability check for one group id (step 4's create-task leg).
 *
 * Deliberately NOT `listWorkingGroups(...).find(...)`: that runs the whole
 * catalog with two correlated subqueries per row to answer a one-row question
 * on the task-create path. This is a single indexed lookup.
 *
 * Returns the row only when the group is ACTIVE. A soft-archived group must
 * not accept new routing — archiving is how a group is retired, and letting a
 * task land in one would strand it in a feed nobody reads. Callers treat null
 * as 404: "does not exist" and "is archived" are the same answer to a poster.
 */
export async function findRoutableWorkingGroupById(id: number) {
  const [row] = await db
    .select({ id: workingGroups.id, slug: workingGroups.slug, name: workingGroups.name })
    .from(workingGroups)
    .where(and(eq(workingGroups.id, id), eq(workingGroups.isActive, true)))
    .limit(1)
  return row ?? null
}

/**
 * Join, or change level on an existing membership — one upsert, because they
 * are the same write. A first join defaults to `normal` at the API layer.
 */
export async function setMembership(
  userId: string,
  workingGroupId: number,
  level: NotificationLevel,
) {
  const [row] = await db
    .insert(userWorkingGroups)
    .values({ userId, workingGroupId, level })
    .onConflictDoUpdate({
      target: [userWorkingGroups.userId, userWorkingGroups.workingGroupId],
      set: { level },
    })
    .returning()
  return row
}

/** Leave = delete the row. Idempotent: leaving twice is not an error. */
export async function leaveWorkingGroup(userId: string, workingGroupId: number) {
  const deleted = await db
    .delete(userWorkingGroups)
    .where(
      and(
        eq(userWorkingGroups.userId, userId),
        eq(userWorkingGroups.workingGroupId, workingGroupId),
      ),
    )
    .returning()
  return deleted.length > 0
}

/** The viewer's memberships, for profile chips and the create-task picker. */
export async function listUserMemberships(userId: string) {
  return db
    .select({
      workingGroupId: userWorkingGroups.workingGroupId,
      level: userWorkingGroups.level,
      slug: workingGroups.slug,
      name: workingGroups.name,
    })
    .from(userWorkingGroups)
    .innerJoin(workingGroups, eq(workingGroups.id, userWorkingGroups.workingGroupId))
    .where(eq(userWorkingGroups.userId, userId))
    .orderBy(workingGroups.sortOrder, workingGroups.id)
}

export interface FeedPage<T> {
  data: T[]
  hasMore: boolean
  cursor: { createdAt: Date; id: number } | null
}

/**
 * Shared implementation behind listMemberFeed and listAgentFeed (step 7) — ONE
 * definition rather than two hand-kept copies, which is this codebase's own
 * drift lesson (see src/lib/agent-lane.ts). Both feeds are "tasks from groups
 * you joined, minus muted ones, keyset-paged"; they differ only in whether the
 * result is narrowed to currently-open (claimable) work.
 *
 *  - `ne(level, 'muted')` is the ONLY level logic here: tracking/watching differ
 *    in how you are *notified*, never in what the feed contains.
 *  - `notHiddenStale` is imported from the task queries, not re-expressed, so
 *    the feed and the public board can never disagree about what exists.
 *  - Keyset paging on (createdAt, id), not OFFSET: a feed that gains rows while
 *    being paged would otherwise repeat or skip them.
 */
async function memberFeedQuery(
  userId: string,
  opts: { limit?: number; before?: { createdAt: Date; id: number }; onlyOpen?: boolean } = {},
): Promise<
  FeedPage<{
    id: number
    title: string
    description: string
    status: string
    rewardXrd: string
    xpReward: number
    creatorId: string
    assigneeId: string | null
    onChainTaskId: number | null
    createdAt: Date
    groupId: number
    groupSlug: string
    groupName: string
  }>
> {
  const limit = Math.min(opts.limit ?? 20, 100)

  const conditions = [
    eq(userWorkingGroups.userId, userId),
    ne(userWorkingGroups.level, "muted"),
    notHiddenStale,
  ]
  if (opts.onlyOpen) conditions.push(eq(tasks.status, "open"))
  if (opts.before) {
    conditions.push(
      sql`(${tasks.createdAt}, ${tasks.id}) < (${opts.before.createdAt.toISOString()}::timestamptz, ${opts.before.id})`,
    )
  }

  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      rewardXrd: tasks.rewardXrd,
      xpReward: tasks.xpReward,
      creatorId: tasks.creatorId,
      assigneeId: tasks.assigneeId,
      onChainTaskId: tasks.onChainTaskId,
      createdAt: tasks.createdAt,
      groupId: workingGroups.id,
      groupSlug: workingGroups.slug,
      groupName: workingGroups.name,
    })
    .from(tasks)
    // INNER join on the membership: a task in no group, or in a group the
    // viewer has not joined, is simply not in this feed.
    .innerJoin(
      userWorkingGroups,
      eq(userWorkingGroups.workingGroupId, tasks.workingGroupId),
    )
    .innerJoin(workingGroups, eq(workingGroups.id, userWorkingGroups.workingGroupId))
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const data = hasMore ? rows.slice(0, limit) : rows
  const last = data[data.length - 1]
  return {
    data,
    hasMore,
    cursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
  }
}

/**
 * THE MEMBER FEED — the core value of the whole feature.
 * Tasks from every group the viewer has joined, minus the ones they muted, in
 * ANY status (the human feed is a life-cycle view, not just "what can I claim").
 */
export async function listMemberFeed(
  userId: string,
  opts: { limit?: number; before?: { createdAt: Date; id: number } } = {},
) {
  return memberFeedQuery(userId, opts)
}

/**
 * THE AGENT FEED (Model A §5a / build step 7) — same shape as the member feed,
 * narrowed to `status = 'open'`: an agent polls this for work it can actually
 * claim, not the full history of tasks in its groups. Everything else
 * (membership, muted filter, visibility rule, keyset paging) is identical to
 * the human feed on purpose — one query, one place either could drift from the
 * board's own truth.
 */
export async function listAgentFeed(
  userId: string,
  opts: { limit?: number; before?: { createdAt: Date; id: number } } = {},
) {
  return memberFeedQuery(userId, { ...opts, onlyOpen: true })
}

/**
 * CUSTOM-FEED BROWSE (build step 5) — "the same query with `working_group_id
 * IN (:selected)` and no membership join", per the spec's own build order.
 * A preview of what a group's feed looks like BEFORE joining it, so it takes
 * group ids directly rather than reading them off a viewer's memberships, and
 * needs no auth: nothing here is gated by membership, so there is nothing to
 * be a viewer of. `notHiddenStale` still applies — a preview must not disagree
 * with the public board about what exists.
 */
export async function listGroupsFeed(
  workingGroupIds: number[],
  opts: { limit?: number; before?: { createdAt: Date; id: number } } = {},
): Promise<
  FeedPage<{
    id: number
    title: string
    description: string
    status: string
    rewardXrd: string
    xpReward: number
    creatorId: string
    assigneeId: string | null
    onChainTaskId: number | null
    createdAt: Date
    groupId: number
    groupSlug: string
    groupName: string
  }>
> {
  const limit = Math.min(opts.limit ?? 20, 100)
  // Empty selection → empty page, not "every task everywhere": /tasks is
  // already that view, and silently falling back to it here would make an
  // empty filter look like a much bigger feed than the caller asked for.
  if (workingGroupIds.length === 0) return { data: [], hasMore: false, cursor: null }

  const conditions = [inArray(tasks.workingGroupId, workingGroupIds), notHiddenStale]
  if (opts.before) {
    conditions.push(
      sql`(${tasks.createdAt}, ${tasks.id}) < (${opts.before.createdAt.toISOString()}::timestamptz, ${opts.before.id})`,
    )
  }

  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      rewardXrd: tasks.rewardXrd,
      xpReward: tasks.xpReward,
      creatorId: tasks.creatorId,
      assigneeId: tasks.assigneeId,
      onChainTaskId: tasks.onChainTaskId,
      createdAt: tasks.createdAt,
      groupId: workingGroups.id,
      groupSlug: workingGroups.slug,
      groupName: workingGroups.name,
    })
    .from(tasks)
    // INNER join, same trap as the member feed: a LEFT join would leak
    // ungrouped tasks (workingGroupId null never matches inArray anyway, but
    // an INNER join keeps that invariant structural rather than incidental).
    .innerJoin(workingGroups, eq(workingGroups.id, tasks.workingGroupId))
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const data = hasMore ? rows.slice(0, limit) : rows
  const last = data[data.length - 1]
  return {
    data,
    hasMore,
    cursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
  }
}

/** Resolve browse-filter slugs to ids, silently dropping any slug that does not
 *  exist — an unknown slug in a shareable `?groups=` URL should just contribute
 *  nothing to the filter, not 400 the whole preview. Archived groups resolve
 *  too: their existing feed is still worth previewing, only NEW membership is
 *  what archiving blocks. */
export async function findWorkingGroupIdsBySlugs(slugs: string[]): Promise<number[]> {
  if (slugs.length === 0) return []
  const rows = await db
    .select({ id: workingGroups.id })
    .from(workingGroups)
    .where(inArray(workingGroups.slug, slugs))
  return rows.map((r) => r.id)
}

/**
 * The one fanout-on-WRITE set: who gets pushed about a new task in this group.
 * Only `watching` — `tracking` is an in-app badge the client resolves on read,
 * and `normal`/`muted` are never pushed.
 */
export async function listGroupWatchers(workingGroupId: number): Promise<string[]> {
  const rows = await db
    .select({ userId: userWorkingGroups.userId })
    .from(userWorkingGroups)
    .where(
      and(
        eq(userWorkingGroups.workingGroupId, workingGroupId),
        eq(userWorkingGroups.level, "watching"),
      ),
    )
  return rows.map((r) => r.userId)
}

/** Group count, for the agent groups-joined cap (Model A §5a). */
export async function countUserMemberships(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(userWorkingGroups)
    .where(eq(userWorkingGroups.userId, userId))
  return row?.n ?? 0
}

// ── the propose-queue (build step 6) ────────────────────────────────────────
// "Add a 'propose a group' submission → admin queue; never auto-create." A
// proposal is a request the admin curates by hand (scripts/review-group-
// proposals.mjs); nothing here writes workingGroups directly except
// approveProposal, and only from inside this module.

export type WorkingGroupProposal = typeof workingGroupProposals.$inferSelect

/** POST /api/v1/groups/propose — any signed-in user, always lands `pending`. */
export async function createProposal(
  userId: string,
  name: string,
  description: string,
): Promise<WorkingGroupProposal> {
  const [row] = await db
    .insert(workingGroupProposals)
    .values({ proposedBy: userId, name, description })
    .returning()
  return row
}

/** "My proposals" — self-only, mirrors listUserMemberships' own justification:
 *  this is the proposer's own submission history, not a public roster.
 *
 *  `id` breaks createdAt ties, as in the feed queries above: `created_at`
 *  defaults to now() and is NOT unique, so two proposals submitted inside the
 *  same clock tick would otherwise come back in whatever order the plan
 *  happened to produce — a real non-determinism the user's own list would show
 *  (and which flaked this suite in CI). The identity column is monotonic in
 *  insert order, so desc(id) IS "newest first" for the tied rows. */
export async function listProposalsByUser(userId: string): Promise<WorkingGroupProposal[]> {
  return db
    .select()
    .from(workingGroupProposals)
    .where(eq(workingGroupProposals.proposedBy, userId))
    .orderBy(desc(workingGroupProposals.createdAt), desc(workingGroupProposals.id))
}

/** The admin queue itself — pending only, oldest first (FIFO curation). Called
 *  from scripts/review-group-proposals.mjs, never from an HTTP route: there is
 *  no admin-authenticated surface in this app to serve it from (see the schema
 *  comment on workingGroupProposals for why that is deliberate, not a gap). */
export async function listPendingProposals(): Promise<WorkingGroupProposal[]> {
  return db
    .select()
    .from(workingGroupProposals)
    .where(eq(workingGroupProposals.status, "pending"))
    .orderBy(workingGroupProposals.createdAt, workingGroupProposals.id)
}

export type ApproveProposalResult =
  | { ok: true; group: typeof workingGroups.$inferSelect; proposal: WorkingGroupProposal }
  | { ok: false; code: "NOT_FOUND" | "ALREADY_DECIDED" | "SLUG_TAKEN" }

/**
 * Approve: create the real working_groups row from the proposal's name/
 * description and mark the proposal decided, atomically — a proposal must
 * never end up `approved` with no group behind it (or a group with no
 * `resultingGroupId` traceable back to why it exists).
 *
 * Both the "already decided" and "slug taken" checks are re-verified INSIDE
 * the transaction (the pending-status predicate on the row lock, and a fresh
 * slug lookup) rather than trusted from a caller's earlier read — the queue is
 * small and hand-curated, but a script re-run on a stale listing must not
 * double-create.
 */
export async function approveProposal(
  id: number,
  input: { slug: string; sortOrder?: number; decidedBy?: string },
): Promise<ApproveProposalResult> {
  return db.transaction(async (tx) => {
    const [proposal] = await tx
      .select()
      .from(workingGroupProposals)
      .where(eq(workingGroupProposals.id, id))
      .for("update")
    if (!proposal) return { ok: false, code: "NOT_FOUND" }
    if (proposal.status !== "pending") return { ok: false, code: "ALREADY_DECIDED" }

    const [clash] = await tx
      .select({ id: workingGroups.id })
      .from(workingGroups)
      .where(eq(workingGroups.slug, input.slug))
      .limit(1)
    if (clash) return { ok: false, code: "SLUG_TAKEN" }

    const [group] = await tx
      .insert(workingGroups)
      .values({
        slug: input.slug,
        name: proposal.name,
        description: proposal.description,
        sortOrder: input.sortOrder ?? 0,
      })
      .returning()

    const [updated] = await tx
      .update(workingGroupProposals)
      .set({
        status: "approved",
        resultingGroupId: group.id,
        decidedBy: input.decidedBy ?? null,
        decidedAt: new Date(),
      })
      .where(eq(workingGroupProposals.id, id))
      .returning()

    return { ok: true, group, proposal: updated }
  })
}

/** Reject: the CAS predicate (`status = 'pending'`) is the whole safety
 *  property — a proposal decided a second time (by a re-run on a stale list,
 *  or a second operator) matches 0 rows instead of silently overwriting the
 *  first decision, the same shape as submissions.reviewSubmission. */
export async function rejectProposal(
  id: number,
  input: { reviewNote?: string; decidedBy?: string },
): Promise<WorkingGroupProposal | null> {
  const [row] = await db
    .update(workingGroupProposals)
    .set({
      status: "rejected",
      reviewNote: input.reviewNote ?? null,
      decidedBy: input.decidedBy ?? null,
      decidedAt: new Date(),
    })
    .where(and(eq(workingGroupProposals.id, id), eq(workingGroupProposals.status, "pending")))
    .returning()
  return row ?? null
}

// ── auto-archive (build step 6) ─────────────────────────────────────────────
// "Auto-flag + soft-archive a group with no new task in N days." Soft only —
// isActive=false, same as a manual archive — never a delete, for the same
// reason listWorkingGroups' isActive comment already gives: a hard delete
// would cascade every membership away and orphan the tasks that routed there.

export interface StaleGroupCandidate {
  id: number
  slug: string
  name: string
  createdAt: Date
  /** Newest task ever routed here, or null if none ever were. */
  lastTaskAt: Date | null
}

/**
 * Active groups whose last activity predates `cutoff`. "Last activity" =
 * newest task.created_at in the group, falling back to the group's OWN
 * created_at when it has never had one — a freshly seeded group is not stale
 * on day one just because nothing has posted into it yet.
 *
 * ⚠️ Written as a correlated SUBQUERY on purpose, not a LEFT JOIN + GROUP BY —
 * see the memberCountSql/openTaskCountSql warning above this file. `tasks` and
 * `working_groups` BOTH have a `created_at` column, which is exactly the shape
 * that bug needs: a join here would put two same-named columns in scope for
 * one aggregate expression. The subquery below never interpolates a drizzle
 * `${table.column}` reference — every identifier is a fixed literal, scoped to
 * its own alias (`t`) or the single outer table — so there is no bare name for
 * SQL to resolve against the wrong table in the first place.
 */
export async function findStaleActiveWorkingGroups(cutoff: Date): Promise<StaleGroupCandidate[]> {
  const lastTaskAtSql = sql<string | null>`(
    select max(t.created_at) from tasks t where t.working_group_id = working_groups.id
  )`

  const rows = await db
    .select({
      id: workingGroups.id,
      slug: workingGroups.slug,
      name: workingGroups.name,
      createdAt: workingGroups.createdAt,
      lastTaskAt: lastTaskAtSql,
    })
    .from(workingGroups)
    .where(
      and(
        eq(workingGroups.isActive, true),
        sql`coalesce(
          (select max(t.created_at) from tasks t where t.working_group_id = working_groups.id),
          working_groups.created_at
        ) < ${cutoff.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(workingGroups.sortOrder, workingGroups.id)

  return rows.map((r) => ({ ...r, lastTaskAt: r.lastTaskAt ? new Date(r.lastTaskAt) : null }))
}

/** Race-safe soft-archive: only while the group is STILL active, re-checked
 *  inside the UPDATE — mirrors hideUnfundedTaskIfStillOpen. A membership join
 *  or a task routed into the group between the candidate select and this write
 *  does not block the archive (a group is retired by staleness, not by a
 *  head-count), but an operator who already un-archived it manually wins: the
 *  WHERE misses and this is a no-op. */
export async function archiveGroupIfStillActive(id: number) {
  const [row] = await db
    .update(workingGroups)
    .set({ isActive: false })
    .where(and(eq(workingGroups.id, id), eq(workingGroups.isActive, true)))
    .returning()
  return row ?? null
}
