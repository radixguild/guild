import { eq, ne, and, or, isNull, isNotNull, gt, lt, count, sql, inArray, notInArray } from "drizzle-orm"
import { db, type DbExecutor } from "@/db"
import { tasks, submissions } from "@/db/schema"
import type { TaskStatus } from "@/lib/types"
import { getTestAccounts } from "@/lib/test-accounts"
import {
  type TaskSort,
  decodeTaskCursor,
  encodeTaskCursor,
  taskKeysetWhere,
  taskOrderBy,
} from "@/db/task-cursor"

// R3-1 soft-hide read filter: exclude rows the unfunded-create sweep has hidden,
// but ONLY while they are still a stale OPEN, UNLINKED create — i.e. hide iff
// `hidden_at IS NOT NULL AND status='open' AND on_chain_task_id IS NULL`. Written
// as the KEEP condition so it drops into a WHERE `and(...)`. This mirrors the
// sweep's own target exactly, so the row reappears the moment it leaves that state
// by ANY path, with no un-hide write: a late create-confirm/resync sets
// on_chain_task_id (isNotNull clause), OR it advances off-chain open→submitted or
// is cancelled (ne(status,'open') clause). See src/lib/prune-unfunded.ts.
// Exported so the working-group member feed applies the IDENTICAL predicate
// rather than a second copy that can drift — a feed showing rows the board
// hides (or vice versa) is the same task looking like two different states.
export const notHiddenStale = or(
  isNull(tasks.hiddenAt),
  ne(tasks.status, "open"),
  isNotNull(tasks.onChainTaskId),
)

// R6 public-board hygiene (2026-09-10 operator ruling): a cancelled task is
// dead weight on the board, not privacy-sensitive state — 30 of 66 live rows
// were cancelled at launch review. Exported for the same "one predicate, not
// a second copy that can drift" reason as notHiddenStale above. See the
// comment inside listTasks for the exact scope this is applied at.
export const notCancelledByDefault = ne(tasks.status, "cancelled")

// The per-row cancelled-visibility predicate, shared by both call sites
// below (the non-project `status=cancelled` gate and the project-scoped
// gate) so there is exactly one copy of the guard logic rather than two that
// can drift apart. Mirrors `isCancelledTaskVisibleTo` (public-task-text.ts)
// EXACTLY — an explicit `!= null` check, not a truthiness check, so a real
// but falsy-looking viewerId (e.g. `""`, however unlikely) is compared for
// equality like any other id instead of being silently treated as
// anonymous. The two predicates must stay in step: changing one without the
// matching change in the other reintroduces the inconsistency this closed.
function cancelledVisibilityClause(viewerId: string | null | undefined) {
  const id = viewerId ?? null
  return id != null ? or(eq(tasks.creatorId, id), eq(tasks.assigneeId, id)) : sql`false`
}

interface TaskFilters {
  status?: TaskStatus
  creatorId?: string
  assigneeId?: string
  projectId?: number
  cursor?: string
  limit?: number
  sort?: "newest" | "reward" | "deadline"
  // Funded-on-chain only: a task is funded once the create-confirm captures the
  // blueprint id (onChainTaskId IS NOT NULL — the same signal captureEscrowIdIfUnset
  // sets). Powers the x402 funded-tasks discovery endpoint (§4.1).
  fundedOnly?: boolean
  // Explicit, caller-decided bypass of the notHiddenStale keep-filter for a
  // creator/assignee-scoped view. Deliberately NOT inferred from creatorId /
  // assigneeId being present — see the comment at the call site below for why
  // that was the bug. The CALLER (the HTTP route) is responsible for setting
  // this only once it has verified, server-side, that the viewer actually IS
  // the creator/assignee being queried (e.g. an authenticated session whose
  // userId matches the requested creatorId/assigneeId). This module does no
  // auth of its own — it trusts whatever the caller passes, on purpose, so the
  // query layer stays a plain query layer and the one place that can get authz
  // wrong is the route, where it's reviewable in one place.
  includeHiddenStale?: boolean
  // The requesting session's own userId (or null/undefined if anonymous),
  // used ONLY to gate cancelled-row visibility — either under an explicit
  // `status=cancelled` filter on the default (non-project) view, or
  // unconditionally on a project-scoped view (whose kanban funnel shows
  // every other status regardless) — see the two conditions below.
  // Unlike `includeHiddenStale` (a route-verified "session matches the
  // REQUESTED creator/assignee id" bypass, scoped to whatever creatorId/
  // assigneeId filter is also on the call), this is compared per-row against
  // that row's OWN creatorId/assigneeId, so it works even with no creator/
  // assignee filter at all. Same trust contract as includeHiddenStale: this
  // module does no auth, it trusts whatever the route already verified.
  viewerId?: string | null
}

export async function listTasks(filters: TaskFilters = {}) {
  const limit = Math.min(filters.limit || 20, 100)
  const conditions = []

  if (filters.status) conditions.push(eq(tasks.status, filters.status))
  if (filters.creatorId) conditions.push(eq(tasks.creatorId, filters.creatorId))
  if (filters.assigneeId) conditions.push(eq(tasks.assigneeId, filters.assigneeId))
  if (filters.projectId !== undefined) conditions.push(eq(tasks.projectId, filters.projectId))
  if (filters.fundedOnly) conditions.push(isNotNull(tasks.onChainTaskId))

  // Hide swept stale-unfunded creates from the default/public board — but NOT
  // from a project-scoped view (a project's task funnel has no single "owner"
  // whose privacy this filter protects; showing the whole board is the point
  // of that surface) and NOT when the caller has verified `includeHiddenStale`
  // (a poster must still see their own stuck row — e.g. a funded-but-
  // unconfirmed create — to notice/recover it).
  //
  // ⚠️ 2026-08-26 (adversarial screen on PR #459): this used to also bypass
  // the filter for ANY creatorId/assigneeId filter, on the theory that a
  // creator/assignee-scoped query IS the owner looking at their own tasks.
  // That reasoning only holds if the caller is authenticated AND the
  // caller-supplied creatorId/assigneeId actually matches who they are — and
  // GET /api/v1/tasks is unauthenticated. So `?creator=<anyone>` let any
  // anonymous visitor read a poster's soft-hidden, possibly-still-funded rows
  // (see prune-unfunded.ts's SOFT-HIDE note — those rows can hold real
  // escrow). `includeHiddenStale` replaces that inference: the route sets it
  // only after checking a verified session against the requested identity, so
  // trusting a boolean here is trusting the route, never the request.
  const isProjectScopedView = filters.projectId !== undefined
  if (!isProjectScopedView && !filters.includeHiddenStale) conditions.push(notHiddenStale)

  // R6 public-board hygiene (2026-09-10 operator ruling): hide cancelled tasks
  // from the DEFAULT listing. Same scope as notHiddenStale directly above —
  // a project's kanban funnel intentionally shows every status (see the
  // comment on GET /api/v1/projects/[slug]: "the kanban funnel needs all
  // statuses at once"), and a route-verified owner/assignee view
  // (includeHiddenStale — the SAME session-vs-identity check, reused rather
  // than inventing a second one) should see their own cancelled tasks with
  // no `&status=cancelled` of their own — PLUS skip this whenever the caller
  // names a status explicitly: `?status=cancelled` must still return
  // cancelled rows (ANDing `!= cancelled` onto an explicit `= cancelled`
  // filter would 0-row it forever), and any other explicit status already
  // excludes cancelled on its own, so this would be a redundant AND at best.
  if (!isProjectScopedView && !filters.includeHiddenStale && !filters.status) {
    conditions.push(notCancelledByDefault)
  }

  // 2026-09-14 hardening: an explicit `status=cancelled` filter bypasses
  // `notCancelledByDefault` above on purpose (an owner/assignee must be able
  // to reach their own cancelled tasks with a bare `?status=cancelled`, no
  // creator/assignee param of their own) — but measured live on deploy
  // 50c2528, that bypass let ANY anonymous or non-party caller list every
  // cancelled row's existence via `?status=cancelled` (41/41 returned, text
  // scrubbed but ids/timestamps intact), even though the same row is a 404
  // from GET /api/v1/tasks/[id] and dropped from the project embed for that
  // exact caller. Same `isCancelledTaskVisibleTo` rule (public-task-text.ts),
  // expressed here as a WHERE clause instead of a per-row filter so
  // pagination/cursor math stays honest instead of counting rows that get
  // discarded after the fact. `viewerId` null/undefined (anonymous, or a
  // session read that failed) means no row can match — `sql`false`` rather
  // than `eq(tasks.assigneeId, viewerId)` with a null viewerId, because
  // Postgres would otherwise need `assigneeId IS NULL`, which is TRUE for
  // every unassigned cancelled task and would leak exactly the rows this is
  // meant to hide. Scope is `cancelled` + non-project-view only: the project
  // kanban funnel's own carve-out (isProjectScopedView, above) is untouched,
  // and every other status is unaffected (already excludes cancelled via its
  // own `eq(status, X)`).
  if (!isProjectScopedView && filters.status === "cancelled") {
    conditions.push(cancelledVisibilityClause(filters.viewerId))
  }

  // 2026-09-14 hardening, second pass: the isProjectScopedView carve-out above
  // is right that a project's kanban funnel needs every STATUS at once — but
  // it was also skipping BOTH cancelled-row gates above wholesale, so
  // `GET /api/v1/tasks?project=<id>` (with or without `&status=cancelled`)
  // handed an anonymous or non-party caller every cancelled row's existence,
  // the exact class of leak just closed for the non-project view. Same
  // `isCancelledTaskVisibleTo` predicate (public-task-text.ts, and already
  // applied per-row in GET /api/v1/projects/[slug]) — expressed here as
  // `status != cancelled OR viewer-is-party` rather than ANDing an exclusion,
  // so it is trivially true for every non-cancelled row and leaves the
  // open/claimed/paid columns exactly as-is; only rows that ARE cancelled
  // fall through to the viewer check. Runs unconditionally for a project
  // view (not just when `status` is unset) so `?project=&status=cancelled`
  // is covered too: that combination ANDs this with `eq(status,'cancelled')`,
  // which collapses to "cancelled AND viewer is party" — an anonymous caller
  // gets zero rows instead of the whole cancelled column. `viewerId`
  // null/undefined again means no cancelled row can match — `sql`false``,
  // not `eq(assigneeId, viewerId)`, for the same NULL-assignee reason as
  // the non-project condition above.
  if (isProjectScopedView) {
    conditions.push(or(ne(tasks.status, "cancelled"), cancelledVisibilityClause(filters.viewerId)))
  }

  const sort: TaskSort = filters.sort ?? "newest"

  // Compound (sortKey, id) keyset — the cursor keys off the SAME column the sort
  // orders by, not a bare id, so paging a reward/deadline sort can't skip or
  // repeat rows (M6). A malformed/legacy cursor decodes to null → ignored.
  if (filters.cursor) {
    const cur = decodeTaskCursor(filters.cursor)
    if (cur) {
      const keyset = taskKeysetWhere(sort, cur)
      if (keyset) conditions.push(keyset)
    }
  }

  const rows = await db
    .select()
    .from(tasks)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...taskOrderBy(sort))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const data = hasMore ? rows.slice(0, limit) : rows
  const cursor = hasMore && data.length > 0 ? encodeTaskCursor(data[data.length - 1], sort) : null

  return { data, cursor, hasMore }
}

export async function findTaskById(id: number) {
  return (await db.query.tasks.findFirst({ where: eq(tasks.id, id) })) ?? null
}

// Reverse linkage for the escrow reconciler / resync / drift watcher: chain
// events carry the blueprint's u64 task_id, captured onto tasks.on_chain_task_id
// by the create confirm. That id is NOT unique on its own — each escrow
// component numbers its tasks from 1, so it collides across the old→vNext §8b
// cutover. tasks.escrow_component records WHICH component funded the row (set by
// the create confirm, backfilled for historic rows), so scope the lookup by
// (onChainTaskId, escrowComponent) to land on the exact row. One row at most for
// that pair (a component's task_ids are unique within it). This is the "proper
// fix" that supersedes the interim fund-tx-hash binding from PR #196.
export async function findTaskByOnChainIdOnComponent(
  onChainTaskId: number,
  escrowComponent: string,
) {
  return (
    (await db.query.tasks.findFirst({
      where: and(
        eq(tasks.onChainTaskId, onChainTaskId),
        eq(tasks.escrowComponent, escrowComponent),
      ),
    })) ?? null
  )
}

// Public marketplace pulse (homepage widget + the bot's /bounty stats after
// R1): one group-by over tasks. Counts are zero-filled across the full status
// enum so absent statuses still render as 0; totalPaidXrd is the released
// money total as numeric-safe ::text (same convention as projects.ts).
export async function getTaskStats(excluded: string[] = getTestAccounts()) {
  // G-508: drop tasks whose poster OR worker is a test/operator account so the
  // public pulse (paid count + totalPaidXrd) is not inflated by smoke payouts.
  // assignee_id is nullable — an unclaimed task keeps its NULL, so guard with
  // isNull before the NOT IN (NULL NOT IN (...) is NULL, which would drop it).
  const notTestAccount =
    excluded.length > 0
      ? and(
          notInArray(tasks.creatorId, excluded),
          or(isNull(tasks.assigneeId), notInArray(tasks.assigneeId, excluded)),
        )
      : undefined
  const rows = await db
    .select({
      status: tasks.status,
      count: sql<number>`count(*)::int`,
      totalXrd: sql<string>`coalesce(sum(${tasks.rewardXrd}), 0)::text`,
    })
    .from(tasks)
    // Exclude swept stale-unfunded creates so the public `open` count is not
    // inflated by abandoned drafts (same reversible filter as the board). With
    // no exclusion list this stays exactly `notHiddenStale` (unchanged SQL).
    .where(notTestAccount ? and(notHiddenStale, notTestAccount) : notHiddenStale)
    .groupBy(tasks.status)

  const counts: Record<TaskStatus, number> = {
    open: 0,
    assigned: 0,
    submitted: 0,
    paid: 0,
    cancelled: 0,
    disputed: 0,
    refunded: 0,
  }
  let totalPaidXrd = "0"
  for (const row of rows) {
    counts[row.status] = row.count
    if (row.status === "paid") totalPaidXrd = row.totalXrd
  }

  return { counts, totalPaidXrd }
}

export async function createTask(data: typeof tasks.$inferInsert) {
  const [task] = await db.insert(tasks).values(data).returning()
  return task
}

// `executor` lets a caller run the update inside an enclosing transaction
// (escrow confirms pair this with a ledger write — see the escrow route).
export async function updateTask(
  id: number,
  data: Partial<typeof tasks.$inferInsert>,
  executor: DbExecutor = db,
) {
  const [task] = await executor
    .update(tasks)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(tasks.id, id))
    .returning()
  return task
}

// Compare-and-swap variant of updateTask: applies only while the row's
// CURRENT status is in `fromStatuses` — the ALLOWED_FROM lifecycle gate pushed
// into the UPDATE itself. Two racing confirms serialize on the row lock and
// the loser's WHERE re-evaluates against the winner's committed status, so an
// in-memory gate check can no longer be stale by write time. Returns null when
// the predicate missed; the caller owns conflict semantics.
export async function updateTaskIfStatus(
  id: number,
  data: Partial<typeof tasks.$inferInsert>,
  fromStatuses: readonly string[],
  executor: DbExecutor = db,
) {
  const [task] = await executor
    .update(tasks)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(tasks.id, id), inArray(tasks.status, [...fromStatuses] as (typeof tasks.$inferSelect)["status"][])))
    .returning()
  return task ?? null
}

// Capture the blueprint-assigned on-chain id + component on create-confirm,
// compare-and-swap so this is the SINGLE writer of onChainTaskId that it
// claims to be. The WHERE matches only while the row is still unfunded
// (onChainTaskId IS NULL) OR is already pinned to the SAME id+component — so a
// legitimate idempotent create-retry (same TaskCreatedEvent) still succeeds,
// but a second confirm carrying a DIFFERENT on-chain id can't overwrite the
// first (which would peg the row to an id its fund ledger row doesn't match
// and make it unfindable by reconciliation). Returns null on a genuine
// conflict; the caller turns that into a 409.
export async function captureEscrowIdIfUnset(
  id: number,
  onChainTaskId: number,
  escrowComponent: string,
  executor: DbExecutor = db,
) {
  try {
    const [task] = await executor
      .update(tasks)
      .set({ onChainTaskId, escrowComponent, updatedAt: new Date() })
      .where(
        and(
          eq(tasks.id, id),
          or(
            isNull(tasks.onChainTaskId),
            and(eq(tasks.onChainTaskId, onChainTaskId), eq(tasks.escrowComponent, escrowComponent)),
          ),
        ),
      )
      .returning()
    return task ?? null
  } catch (err) {
    // The per-row CAS above only stops THIS row being re-bound; the partial
    // uniqueIndex(onChainTaskId, escrowComponent) is what stops a DIFFERENT row
    // binding an id another row already owns. When it fires, treat the
    // unique-violation as the same conflict a CAS-miss signals (caller turns
    // null into a 409) rather than letting a raw Postgres 23505 surface as a
    // 500. `tasks` has exactly one unique index, so match its constraint name
    // when the driver provides it and fall back to the code otherwise.
    //
    // drizzle-orm >=0.44 wraps every driver error in DrizzleQueryError — the
    // `postgres` driver's own error (with `.code`/`.constraint_name`) is now
    // one level down at `.cause`, not on the caught error itself. Unwrap it,
    // falling back to the caught error in case some path still throws raw.
    const cause = (err as { cause?: unknown })?.cause
    const e = (cause ?? err) as { code?: string; constraint_name?: string }
    if (e?.code === "23505" && (!e.constraint_name || e.constraint_name === "tasks_onchain_component_unique")) {
      return null
    }
    throw err
  }
}

export async function cancelTask(id: number) {
  return updateTask(id, { status: "cancelled" })
}

// R3-1 unfunded-create sweep (scripts/prune-unfunded.mjs). Candidates are aged,
// never-linked creates: still `open`, no on-chain linkage (onChainTaskId NULL), a
// real reward set, created before the TTL cutoff, and not already swept
// (hiddenAt NULL, so re-runs are idempotent and cheap). The reward>0 filter
// excludes off-chain/XP tasks that are legitimately unfunded.
export async function findPrunableUnfundedTasks(cutoff: Date) {
  return db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "open"),
        isNull(tasks.onChainTaskId),
        isNull(tasks.hiddenAt),
        gt(tasks.rewardXrd, "0"),
        lt(tasks.createdAt, cutoff),
      ),
    )
}

// Race-safe soft-hide write: set `hidden_at` on a stale unfunded create, but ONLY
// while the row is STILL `open`, STILL unlinked (onChainTaskId IS NULL), and not
// already hidden — re-checked inside the UPDATE, not in memory. The onChainTaskId
// IS NULL guard keeps a genuinely claimable, funded-and-linked task from ever
// being hidden if a create-confirm lands between the candidate select and this
// write (the WHERE re-evaluates against the committed row → no-op, returns null).
// This is deliberately NON-terminal and touches no escrow state (see the
// SOFT-HIDE note in src/lib/prune-unfunded.ts): it only declutters the board.
// hidden_at is the sole field written; updatedAt is left untouched (a background
// sweep must not perturb the disputedAt/updatedAt window fallback), matching the
// escrow_component backfill convention.
export async function hideUnfundedTaskIfStillOpen(id: number, executor: DbExecutor = db) {
  const [task] = await executor
    .update(tasks)
    .set({ hiddenAt: new Date() })
    .where(
      and(
        eq(tasks.id, id),
        eq(tasks.status, "open"),
        isNull(tasks.onChainTaskId),
        isNull(tasks.hiddenAt),
      ),
    )
    .returning()
  return task ?? null
}

export async function getSubmissionCount(taskId: number) {
  const [result] = await db
    .select({ count: count() })
    .from(submissions)
    .where(eq(submissions.taskId, taskId))
  return result?.count ?? 0
}
