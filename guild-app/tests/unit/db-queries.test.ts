import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq, ne, and, or, isNull, isNotNull, desc, asc, gt, lt, sql } from 'drizzle-orm'
import { findUserById, createUser, findOrCreateUser, updateUser } from '@/db/queries/users'
import { listTasks, getTaskStats, findTaskById, findTaskByOnChainIdOnComponent, createTask, updateTask, updateTaskIfStatus, captureEscrowIdIfUnset, cancelTask, getSubmissionCount, findPrunableUnfundedTasks, hideUnfundedTaskIfStillOpen } from '@/db/queries/tasks'
import { listSubmissionsByTask, findSubmissionById, createSubmission, reviewSubmission, findLatestSubmissionByTaskAndUser, countSubmissionsByTask } from '@/db/queries/submissions'
import { decodeTaskCursor } from '@/db/task-cursor'
import { findEscrowByTask, recordConfirmedEscrowTx } from '@/db/queries/escrow'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { escrowTransactions } from '@/db/schema/escrow-transactions'

// Mock the database instance — hoisted so vi.mock factories can reference it
const { mockDb, mockQuery } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    query: {
      users: { findFirst: vi.fn() },
      tasks: { findFirst: vi.fn() },
      submissions: { findFirst: vi.fn() },
    },
  }
  const mockQuery = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
  }
  return { mockDb, mockQuery }
})

// Mock the db module
vi.mock('@/db', () => ({
  db: mockDb
}))

// Mock schema
vi.mock('@/db/schema', () => ({
  users: {
    id: 'users.id',
    telegramId: 'users.telegram_id',
    createdAt: 'users.created_at',
  },
  tasks: {
    id: 'tasks.id',
    title: 'tasks.title',
    status: 'tasks.status',
    creatorId: 'tasks.creator_id',
    assigneeId: 'tasks.assignee_id',
    createdAt: 'tasks.created_at',
    rewardXrd: 'tasks.reward_xrd',
    deadline: 'tasks.deadline',
    onChainTaskId: 'tasks.on_chain_task_id',
    escrowComponent: 'tasks.escrow_component',
    hiddenAt: 'tasks.hidden_at',
    projectId: 'tasks.project_id',
  },
  submissions: {
    id: 'submissions.id',
    taskId: 'submissions.task_id',
    submitterId: 'submissions.submitter_id',
    status: 'submissions.status',
    createdAt: 'submissions.created_at',
  },
  escrowTransactions: {
    id: 'escrow_transactions.id',
    taskId: 'escrow_transactions.task_id',
    txType: 'escrow_transactions.tx_type',
    status: 'escrow_transactions.status',
    fromUserId: 'escrow_transactions.from_user_id',
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  // Re-bind chainable mock methods — vi.clearAllMocks() resets implementations
  mockQuery.from.mockReturnValue(mockQuery)
  mockQuery.where.mockReturnValue(mockQuery)
  mockQuery.orderBy.mockReturnValue(mockQuery)
  mockQuery.limit.mockReturnValue(mockQuery)
  mockQuery.offset.mockReturnValue(mockQuery)
  mockQuery.groupBy.mockReturnValue(mockQuery)
  mockQuery.returning.mockReturnValue(mockQuery)
  mockQuery.set.mockReturnValue(mockQuery)
  mockQuery.values.mockReturnValue(mockQuery)
  mockQuery.onConflictDoNothing.mockReturnValue(mockQuery)
  mockDb.select.mockReturnValue(mockQuery)
  mockDb.insert.mockReturnValue(mockQuery)
  mockDb.update.mockReturnValue(mockQuery)
  mockDb.delete.mockReturnValue(mockQuery)
})

describe('User Queries', () => {
  it('should find user by ID', async () => {
    const mockUser = { id: 'account_rdx123', username: 'testuser' }
    mockDb.query.users.findFirst.mockResolvedValue(mockUser)

    const result = await findUserById('account_rdx123')

    expect(mockDb.query.users.findFirst).toHaveBeenCalledWith({
      where: eq('users.id', 'account_rdx123')
    })
    expect(result).toEqual(mockUser)
  })

  it('should return null when user not found', async () => {
    mockDb.query.users.findFirst.mockResolvedValue(undefined)

    const result = await findUserById('nonexistent')

    expect(result).toBeNull()
  })

  it('should create user successfully', async () => {
    const mockUser = {
      id: 'account_rdx123',
      createdAt: expect.any(Number)
    }
    mockQuery.returning.mockResolvedValue([mockUser])

    const result = await createUser('account_rdx123')

    expect(mockDb.insert).toHaveBeenCalled()
    expect(mockQuery.values).toHaveBeenCalledWith({ id: 'account_rdx123' })
    expect(mockQuery.returning).toHaveBeenCalled()
    expect(result).toEqual(mockUser)
  })

  it('should find or create user - existing user', async () => {
    const mockUser = { id: 'account_rdx123' }
    mockQuery.onConflictDoNothing.mockReturnValue(mockQuery)
    mockDb.query.users.findFirst.mockResolvedValue(mockUser)

    const result = await findOrCreateUser('account_rdx123')

    expect(mockDb.insert).toHaveBeenCalled()
    expect(mockQuery.onConflictDoNothing).toHaveBeenCalled()
    expect(mockDb.query.users.findFirst).toHaveBeenCalled()
    expect(result).toEqual(mockUser)
  })

  it('should update user', async () => {
    const mockUser = { id: 'account_rdx123', updatedAt: expect.any(Date) }
    mockQuery.returning.mockResolvedValue([mockUser])

    const result = await updateUser('account_rdx123', { username: 'newname' })

    expect(mockDb.update).toHaveBeenCalled()
    expect(mockQuery.set).toHaveBeenCalledWith({
      username: 'newname',
      updatedAt: expect.any(Date)
    })
    expect(result).toEqual(mockUser)
  })
})

describe('Task Queries', () => {

  it('should find task by ID', async () => {
    const mockTask = { id: 1, title: 'Test Task', status: 'open' }
    mockDb.query.tasks.findFirst.mockResolvedValue(mockTask)

    const result = await findTaskById(1)

    expect(mockDb.query.tasks.findFirst).toHaveBeenCalledWith({
      where: eq('tasks.id', 1)
    })
    expect(result).toEqual(mockTask)
  })

  it('should return null when task not found', async () => {
    mockDb.query.tasks.findFirst.mockResolvedValue(undefined)

    const result = await findTaskById(999)

    expect(result).toBeNull()
  })

  it('finds a task by (on-chain id, escrow component) — scoped past the cutover collision', async () => {
    const mockTask = { id: 5, onChainTaskId: 1, escrowComponent: 'component_rdx1cr690h', status: 'assigned' }
    mockDb.query.tasks.findFirst.mockResolvedValue(mockTask)

    const result = await findTaskByOnChainIdOnComponent(1, 'component_rdx1cr690h')

    // The lookup must be scoped by BOTH columns — on_chain_task_id alone
    // collides across the old→vNext escrow cutover.
    expect(mockDb.query.tasks.findFirst).toHaveBeenCalledWith({
      where: and(
        eq('tasks.on_chain_task_id', 1),
        eq('tasks.escrow_component', 'component_rdx1cr690h'),
      ),
    })
    expect(result).toEqual(mockTask)
  })

  it('returns null when no task matches the (on-chain id, component) pair', async () => {
    mockDb.query.tasks.findFirst.mockResolvedValue(undefined)

    const result = await findTaskByOnChainIdOnComponent(1, 'component_rdx1legacy')

    expect(result).toBeNull()
  })

  it('should list tasks with status filter', async () => {
    const mockTasks = [
      { id: 1, title: 'Task 1', status: 'open' },
      { id: 2, title: 'Task 2', status: 'open' }
    ]
    mockQuery.limit.mockResolvedValue(mockTasks)

    const result = await listTasks({ status: 'open' })

    expect(mockDb.select).toHaveBeenCalled()
    expect(result.data).toEqual(mockTasks)
    expect(result.hasMore).toBe(false)
    expect(result.cursor).toBeNull()
  })

  it('should list tasks with creator filter', async () => {
    const mockTasks = [{ id: 1, title: 'Task 1', creatorId: 'user123' }]
    mockQuery.limit.mockResolvedValue(mockTasks)

    const result = await listTasks({ creatorId: 'user123' })

    expect(result.data).toEqual(mockTasks)
  })

  it('should list tasks with assignee filter', async () => {
    const mockTasks = [{ id: 3, title: 'Task 3', assigneeId: 'account_rdx1worker' }]
    mockQuery.limit.mockResolvedValue(mockTasks)

    const result = await listTasks({ assigneeId: 'account_rdx1worker' })

    // Must scope by tasks.assignee_id (tasks_assignee_idx backs this filter).
    // ANDed with the hide filter too — see the includeHiddenStale tests below
    // (PR #459 screen) for why assigneeId alone no longer bypasses it. ANDed
    // with the cancelled default-hide filter too (R6, 2026-09-10 ruling) —
    // see the dedicated block further down for that behaviour's own tests.
    expect(mockQuery.where).toHaveBeenCalledWith(
      and(
        eq('tasks.assignee_id', 'account_rdx1worker'),
        or(isNull('tasks.hidden_at'), ne('tasks.status', 'open'), isNotNull('tasks.on_chain_task_id')),
        ne('tasks.status', 'cancelled'),
      )
    )
    expect(result.data).toEqual(mockTasks)
  })

  it('should ignore a legacy/malformed cursor rather than throw (degrade to page 1)', async () => {
    const mockTasks = [{ id: 5, title: 'Task 5' }]
    mockQuery.limit.mockResolvedValue(mockTasks)

    // A bare-integer cursor from the pre-M6 format no longer decodes → ignored.
    const result = await listTasks({ cursor: '10' })

    expect(result.data).toEqual(mockTasks)
  })

  it('emits a compound (sortKey, id) cursor — not a bare id — so reward/deadline paging is stable (M6)', async () => {
    const t1 = new Date('2026-07-03T00:00:00Z')
    const t2 = new Date('2026-07-02T00:00:00Z')
    const t3 = new Date('2026-07-01T00:00:00Z')
    const mockTasks = [
      { id: 1, title: 'Task 1', createdAt: t1 },
      { id: 2, title: 'Task 2', createdAt: t2 },
      { id: 3, title: 'Task 3', createdAt: t3 }, // 3 rows when limit is 2 → hasMore
    ]
    mockQuery.limit.mockResolvedValue(mockTasks)

    const result = await listTasks({ limit: 2 })

    expect(result.data).toHaveLength(2)
    expect(result.hasMore).toBe(true)
    // The cursor carries BOTH the primary sort value (createdAt of the last
    // returned row) and its id — the fix for the id-only keyset bug.
    expect(decodeTaskCursor(result.cursor!)).toEqual({ k: t2.toISOString(), id: 2 })
  })

  it('orders newest by (createdAt DESC, id DESC) — id tiebreaker present (M6)', async () => {
    mockQuery.limit.mockResolvedValue([{ id: 2, createdAt: new Date('2026-07-01T00:00:00Z') }])

    await listTasks({ sort: 'newest' })

    expect(mockQuery.orderBy).toHaveBeenCalledWith(desc('tasks.created_at'), desc('tasks.id'))
  })

  it('orders reward by (rewardXrd DESC, id DESC) — cursor keys off reward, not bare id (M6)', async () => {
    mockQuery.limit.mockResolvedValue([{ id: 1, rewardXrd: '100' }])

    await listTasks({ sort: 'reward' })

    expect(mockQuery.orderBy).toHaveBeenCalledWith(desc('tasks.reward_xrd'), desc('tasks.id'))
  })

  it('orders deadline by (deadline ASC, id ASC) — id tiebreaker present (M6)', async () => {
    mockQuery.limit.mockResolvedValue([{ id: 1, deadline: new Date('2026-07-10T00:00:00Z') }])

    await listTasks({ sort: 'deadline' })

    expect(mockQuery.orderBy).toHaveBeenCalledWith(asc('tasks.deadline'), asc('tasks.id'))
  })

  it('should create task successfully', async () => {
    const mockTask = { id: 1, title: 'New Task', status: 'open' }
    mockQuery.returning.mockResolvedValue([mockTask])

    const result = await createTask({
      title: 'New Task',
      description: 'Task description',
      rewardXrd: 10,
      creatorId: 'user123'
    })

    expect(mockDb.insert).toHaveBeenCalled()
    expect(mockQuery.values).toHaveBeenCalled()
    expect(mockQuery.returning).toHaveBeenCalled()
    expect(result).toEqual(mockTask)
  })

  it('should update task', async () => {
    const mockTask = { id: 1, status: 'assigned' }
    mockQuery.returning.mockResolvedValue([mockTask])

    const result = await updateTask(1, { status: 'assigned' })

    expect(mockDb.update).toHaveBeenCalled()
    expect(mockQuery.set).toHaveBeenCalledWith({
      status: 'assigned',
      updatedAt: expect.any(Date)
    })
    expect(result).toEqual(mockTask)
  })

  it('should update task via CAS when the status predicate matches', async () => {
    const mockTask = { id: 1, status: 'paid' }
    mockQuery.returning.mockResolvedValue([mockTask])

    const result = await updateTaskIfStatus(1, { status: 'paid' }, ['submitted', 'paid'])

    expect(mockDb.update).toHaveBeenCalled()
    expect(mockQuery.set).toHaveBeenCalledWith({
      status: 'paid',
      updatedAt: expect.any(Date)
    })
    expect(result).toEqual(mockTask)
  })

  it('should return null from the CAS update when the status predicate misses', async () => {
    mockQuery.returning.mockResolvedValue([]) // concurrent transition won the row

    const result = await updateTaskIfStatus(1, { status: 'paid' }, ['submitted', 'paid'])

    expect(result).toBeNull()
  })

  it('captures the escrow id via compare-and-swap and returns the row', async () => {
    const mockTask = { id: 1, onChainTaskId: 42, escrowComponent: 'component_rdx1escrow' }
    mockQuery.returning.mockResolvedValue([mockTask])

    const result = await captureEscrowIdIfUnset(1, 42, 'component_rdx1escrow')

    expect(mockDb.update).toHaveBeenCalled()
    expect(mockQuery.set).toHaveBeenCalledWith({
      onChainTaskId: 42,
      escrowComponent: 'component_rdx1escrow',
      updatedAt: expect.any(Date),
    })
    expect(result).toEqual(mockTask)
  })

  it('returns null from the escrow-id capture when the row is already funded with a different id', async () => {
    mockQuery.returning.mockResolvedValue([]) // WHERE (unset OR same id) matched nothing

    const result = await captureEscrowIdIfUnset(1, 43, 'component_rdx1escrow')

    expect(result).toBeNull()
  })

  it('maps the unique-index violation (23505) to a null conflict instead of throwing', async () => {
    // Cross-row case: another task row already owns this (onChainTaskId, component)
    // pair, so the partial uniqueIndex rejects THIS row's bind. Treated as the
    // same conflict a CAS-miss signals → caller turns null into a 409, not a 500.
    mockQuery.returning.mockRejectedValueOnce(
      Object.assign(new Error('duplicate key value'), {
        code: '23505',
        constraint_name: 'tasks_onchain_component_unique',
      }),
    )

    const result = await captureEscrowIdIfUnset(1, 42, 'component_rdx1escrow')

    expect(result).toBeNull()
  })

  it('rethrows a non-unique-violation DB error from the escrow-id capture', async () => {
    mockQuery.returning.mockRejectedValueOnce(
      Object.assign(new Error('connection reset'), { code: '08006' }),
    )

    await expect(captureEscrowIdIfUnset(1, 42, 'component_rdx1escrow')).rejects.toThrow(
      'connection reset',
    )
  })

  it('should cancel task', async () => {
    const mockTask = { id: 1, status: 'cancelled' }
    mockQuery.returning.mockResolvedValue([mockTask])

    const result = await cancelTask(1)

    expect(mockDb.update).toHaveBeenCalled()
    expect(result).toEqual(mockTask)
  })

  it('selects prunable unfunded tasks (candidate query)', async () => {
    const rows = [{ id: 1, status: 'open', onChainTaskId: null, rewardXrd: '50' }]
    mockQuery.where.mockResolvedValue(rows) // terminal .where() awaited

    const result = await findPrunableUnfundedTasks(new Date('2026-07-07T12:00:00Z'))

    expect(mockDb.select).toHaveBeenCalled()
    expect(result).toEqual(rows)
  })

  it('soft-hides an unfunded task via CAS, setting hidden_at only (NON-terminal, updatedAt untouched)', async () => {
    const mockTask = { id: 1, status: 'open', hiddenAt: expect.any(Date) }
    mockQuery.returning.mockResolvedValue([mockTask])

    const result = await hideUnfundedTaskIfStillOpen(1)

    expect(mockDb.update).toHaveBeenCalled()
    // Money-safety: status is NOT changed and no escrow field is touched — only
    // hidden_at is written, and updatedAt is deliberately NOT bumped.
    expect(mockQuery.set).toHaveBeenCalledWith({ hiddenAt: expect.any(Date) })
    expect(result).toEqual(mockTask)
  })

  it('MONEY SAFETY: hide CAS returns null when the row is no longer open+unlinked', async () => {
    // A create-confirm linked the row (or a cancel/claim moved it) between the
    // candidate select and this write — the WHERE (open AND on_chain_task_id
    // IS NULL AND hidden_at IS NULL) misses, so a now-claimable task is NOT hidden.
    mockQuery.returning.mockResolvedValue([])

    const result = await hideUnfundedTaskIfStillOpen(1)

    expect(result).toBeNull()
  })

  // The reversible keep-filter: show unless the row is STILL a stale open+unlinked
  // create — hidden_at IS NULL OR status != 'open' OR on_chain_task_id IS NOT NULL.
  // The middle clause un-hides a row that advanced off-chain (open→submitted) or
  // was cancelled; the last clause un-hides a late-linked (funded) row.
  const notHiddenStaleExpr = () =>
    or(isNull('tasks.hidden_at'), ne('tasks.status', 'open'), isNotNull('tasks.on_chain_task_id'))
  // R6 (2026-09-10 operator ruling): the default/public listing also excludes
  // cancelled rows — see the dedicated describe block below this one for the
  // full set of overrides (explicit status filter, includeHiddenStale,
  // project scope).
  const notCancelledExpr = () => ne('tasks.status', 'cancelled')

  it('default/public board excludes swept stale-unfunded AND cancelled rows', async () => {
    mockQuery.limit.mockResolvedValue([])

    await listTasks({}) // unscoped firehose

    expect(mockQuery.where).toHaveBeenCalledWith(and(notHiddenStaleExpr(), notCancelledExpr()))
  })

  it('status-only board is NOT a scoped view — still applies the hide filter alongside the status predicate', async () => {
    mockQuery.limit.mockResolvedValue([])

    await listTasks({ status: 'open' })

    // Load-bearing: a status filter must not exempt the board from decluttering.
    expect(mockQuery.where).toHaveBeenCalledWith(
      and(eq('tasks.status', 'open'), notHiddenStaleExpr()),
    )
  })

  // 2026-08-26 adversarial screen on PR #459: creatorId/assigneeId alone used
  // to bypass the hide filter unconditionally (`isScopedView`), on the theory
  // that a creator-scoped query IS the owner looking at their own tasks. That
  // is only true when the caller has been authenticated as that creator — and
  // GET /api/v1/tasks (the only caller that can supply an arbitrary creatorId)
  // is unauthenticated, so `?creator=<anyone>` let any visitor read that
  // poster's soft-hidden rows. The two tests below pin the FIXED contract:
  // the DB layer only bypasses when the route has explicitly verified the
  // viewer and passed `includeHiddenStale: true` — never off creatorId's mere
  // presence. See tests/unit/tasks-creator-filter.test.ts for the route-level
  // half of this (who gets to set that flag).
  it('creator-scoped view WITHOUT includeHiddenStale still hides the owner-unverified stale AND cancelled rows', async () => {
    mockQuery.limit.mockResolvedValue([])

    await listTasks({ creatorId: 'user123' })

    // Same shape as a status-only board: the creator predicate ANDed with
    // both hide filters, because nothing here has verified 'user123' is the
    // caller — an unverified `?creator=` must not leak a poster's own
    // cancelled tasks any more than it leaks their soft-hidden stale ones.
    expect(mockQuery.where).toHaveBeenCalledWith(
      and(eq('tasks.creator_id', 'user123'), notHiddenStaleExpr(), notCancelledExpr()),
    )
  })

  it('creator-scoped view WITH includeHiddenStale (route-verified owner) shows stale rows', async () => {
    mockQuery.limit.mockResolvedValue([])

    await listTasks({ creatorId: 'user123', includeHiddenStale: true })

    // Verified-owner view: only the creator predicate, no hidden-stale filter.
    expect(mockQuery.where).toHaveBeenCalledWith(and(eq('tasks.creator_id', 'user123')))
  })

  it('assignee-scoped view WITHOUT includeHiddenStale still hides stale AND cancelled rows', async () => {
    mockQuery.limit.mockResolvedValue([])

    await listTasks({ assigneeId: 'account_rdx1worker' })

    expect(mockQuery.where).toHaveBeenCalledWith(
      and(eq('tasks.assignee_id', 'account_rdx1worker'), notHiddenStaleExpr(), notCancelledExpr()),
    )
  })

  // Project scope exempts notHiddenStale AND the R6 cancelled-hide filter
  // (below) — a project's kanban funnel needs every status at once (see the
  // comment on GET /api/v1/projects/[slug]) — but it does NOT exempt
  // per-row cancelled-row visibility: see the "project-scoped cancelled
  // visibility (2026-09-14, second pass)" block below for that gate, added
  // after this bypass was found to leak every cancelled row's existence to
  // an anonymous `?project=<id>` caller too.
  it('project-scoped view bypasses the stale-hide and default cancelled-hide filters (no single owner to gate on)', async () => {
    mockQuery.limit.mockResolvedValue([])

    await listTasks({ projectId: 5 })

    // No notHiddenStale, no notCancelledByDefault — only the project-id
    // predicate and the per-row cancelled-visibility gate (anonymous here,
    // so its OR collapses to `sql`false`` on the viewer side).
    expect(mockQuery.where).toHaveBeenCalledWith(
      and(eq('tasks.project_id', 5), or(ne('tasks.status', 'cancelled'), sql`false`)),
    )
  })

  // R6 (2026-09-10 operator ruling): default listing hides cancelled tasks.
  // The notHiddenStale tests above already cover project-scope and
  // includeHiddenStale bypassing BOTH filters identically (same `if` gate in
  // listTasks) — this block pins the one behaviour that is NOT shared with
  // notHiddenStale: an explicit `status` filter must win outright, including
  // `status: 'cancelled'` itself.
  describe('cancelled-hide default (R6)', () => {
    it('an explicit status=cancelled filter returns cancelled rows — no 0-row conflict with the default hide', async () => {
      mockQuery.limit.mockResolvedValue([])

      await listTasks({ status: 'cancelled' })

      // The default cancelled-hide must NOT also fire (no `= cancelled`
      // ANDed with `!= cancelled`, which would 0-row it forever) — but with
      // no viewerId, the 2026-09-14 visibility gate below adds its OWN
      // always-false clause, so an anonymous/unverified caller still gets
      // zero rows overall. See the "cancelled-visibility gate" block below
      // for the viewerId-present shape, and
      // tests/integration/task-list-cancelled-visibility.pg.test.ts for the
      // real-row behavioural proof (this suite only pins the WHERE shape —
      // the mock hands back its canned array regardless of the clause).
      expect(mockQuery.where).toHaveBeenCalledWith(
        and(eq('tasks.status', 'cancelled'), notHiddenStaleExpr(), sql`false`),
      )
    })

    it('any OTHER explicit status filter also skips the redundant cancelled-hide clause', async () => {
      mockQuery.limit.mockResolvedValue([])

      await listTasks({ status: 'paid' })

      expect(mockQuery.where).toHaveBeenCalledWith(
        and(eq('tasks.status', 'paid'), notHiddenStaleExpr()),
      )
    })
  })

  // 2026-09-14 hardening: an explicit `status=cancelled` filter bypasses
  // notCancelledByDefault above on purpose (an owner/assignee must reach
  // their own cancelled tasks via a bare `?status=cancelled`), but that
  // bypass had no viewer check of its own — measured live on deploy
  // 50c2528, `?status=cancelled` anonymously returned all 41 cancelled rows
  // (ids/timestamps intact). This mirrors `isCancelledTaskVisibleTo`
  // (src/lib/public-task-text.ts), which already gates the single-task GET
  // and the project-embedded list, as a WHERE clause instead of a per-row
  // filter — see the file-level docblock for why this needs a REAL-postgres
  // proof rather than only these mocked shape assertions.
  describe('cancelled-visibility gate under an explicit status filter (2026-09-14)', () => {
    it('a viewerId scopes the explicit status=cancelled filter to that viewer\'s own creator/assignee rows', async () => {
      mockQuery.limit.mockResolvedValue([])

      await listTasks({ status: 'cancelled', viewerId: 'account_rdx1viewer' })

      expect(mockQuery.where).toHaveBeenCalledWith(
        and(
          eq('tasks.status', 'cancelled'),
          notHiddenStaleExpr(),
          or(
            eq('tasks.creator_id', 'account_rdx1viewer'),
            eq('tasks.assignee_id', 'account_rdx1viewer'),
          ),
        ),
      )
    })

    // 2026-09-14, third pass: the guard used to be `filters.viewerId ? or(...)
    // : sql`false`` — a TRUTHINESS check, inconsistent with
    // `isCancelledTaskVisibleTo` (public-task-text.ts), which has always used
    // `viewerId != null`. Fixed via the shared `cancelledVisibilityClause`
    // helper above `listTasks`. This pins the one input where the two checks
    // actually disagree: an empty-string viewerId is falsy (old code: treated
    // as anonymous, `sql`false``) but not `== null` (new code, matching
    // `isCancelledTaskVisibleTo`: compared for equality like any other id —
    // and harmlessly so, since a real Radix address is never `""`).
    it('an empty-string viewerId is compared for equality, not treated as anonymous — matches isCancelledTaskVisibleTo(task, \'\')', async () => {
      mockQuery.limit.mockResolvedValue([])

      await listTasks({ status: 'cancelled', viewerId: '' })

      expect(mockQuery.where).toHaveBeenCalledWith(
        and(
          eq('tasks.status', 'cancelled'),
          notHiddenStaleExpr(),
          or(eq('tasks.creator_id', ''), eq('tasks.assignee_id', '')),
        ),
      )
    })

    it('no viewerId (anonymous, or a failed session read) yields an always-false clause, not a leaky OR', async () => {
      mockQuery.limit.mockResolvedValue([])

      await listTasks({ status: 'cancelled' })

      // Deliberately NOT `or(eq(assigneeId, null), ...)`: Postgres reads
      // `assignee_id = NULL` as `assignee_id IS NULL`-shaped nonsense only
      // via `IS NULL`, and `eq(col, null)` here would need to become an
      // explicit IS NULL to even parse — which would wrongly match every
      // UNASSIGNED cancelled task. `sql`false`` has no such trap.
      expect(mockQuery.where).toHaveBeenCalledWith(
        and(eq('tasks.status', 'cancelled'), notHiddenStaleExpr(), sql`false`),
      )
    })

    it('any OTHER explicit status filter is untouched — the gate only fires for status=cancelled', async () => {
      mockQuery.limit.mockResolvedValue([])

      await listTasks({ status: 'open', viewerId: 'account_rdx1viewer' })

      expect(mockQuery.where).toHaveBeenCalledWith(
        and(eq('tasks.status', 'open'), notHiddenStaleExpr()),
      )
    })

    // 2026-09-14, second pass: this used to assert the OPPOSITE — that a
    // project-scoped `?status=cancelled` was unaffected — until the reviewer
    // on #580 found that combination handed an anonymous/non-party caller
    // every cancelled row in a project (`isProjectScopedView` skipped this
    // status-filter gate the same way it skipped the default hide). See the
    // dedicated describe block below for the fix's full WHERE-shape coverage.
    it('a project-scoped view with status=cancelled now gets the SAME per-row cancelled-visibility gate as the default view', async () => {
      mockQuery.limit.mockResolvedValue([])

      await listTasks({ status: 'cancelled', projectId: 5 })

      expect(mockQuery.where).toHaveBeenCalledWith(
        and(
          eq('tasks.status', 'cancelled'),
          eq('tasks.project_id', 5),
          or(ne('tasks.status', 'cancelled'), sql`false`),
        ),
      )
    })

    it('includeHiddenStale alone does not bypass the new gate — a caller must actually pass viewerId', async () => {
      mockQuery.limit.mockResolvedValue([])

      // A route-verified owner view still sets viewerId alongside
      // includeHiddenStale (see GET /api/v1/tasks) — this pins that the two
      // flags are independent in this module, so a future call site that
      // forgets viewerId doesn't accidentally inherit a free pass.
      await listTasks({ status: 'cancelled', creatorId: 'user123', includeHiddenStale: true })

      expect(mockQuery.where).toHaveBeenCalledWith(
        and(eq('tasks.status', 'cancelled'), eq('tasks.creator_id', 'user123'), sql`false`),
      )
    })
  })

  // 2026-09-14, second pass (PR #580 review finding): `isProjectScopedView`
  // was right to exempt notHiddenStale and notCancelledByDefault above — a
  // project's kanban funnel genuinely needs every status — but it was ALSO,
  // as a side effect of the same `if`, exempting cancelled rows from any
  // per-row visibility check at all. `GET /api/v1/tasks?project=<id>`, with
  // or without `&status=cancelled`, handed an anonymous or non-party caller
  // every cancelled task's existence in that project — the same class of
  // leak the "cancelled-visibility gate" block above closed for the
  // non-project view, using the identical `isCancelledTaskVisibleTo`
  // predicate (already applied per-row in GET /api/v1/projects/[slug]).
  // Expressed as `status != cancelled OR viewer-is-party` rather than an
  // AND-exclusion, so it is trivially true for every non-cancelled row —
  // the kanban's open/claimed/paid columns are provably unaffected — and
  // only narrows the cancelled column itself.
  describe('project-scoped cancelled visibility (2026-09-14, second pass)', () => {
    it('no viewerId: the gate is `status != cancelled OR false` — same always-false-on-cancelled shape as the non-project gate', async () => {
      mockQuery.limit.mockResolvedValue([])

      await listTasks({ projectId: 5 })

      expect(mockQuery.where).toHaveBeenCalledWith(
        and(eq('tasks.project_id', 5), or(ne('tasks.status', 'cancelled'), sql`false`)),
      )
    })

    it('viewerId present: the gate is `status != cancelled OR viewer is creator/assignee` — non-cancelled rows stay unconditionally visible', async () => {
      mockQuery.limit.mockResolvedValue([])

      await listTasks({ projectId: 5, viewerId: 'account_rdx1viewer' })

      expect(mockQuery.where).toHaveBeenCalledWith(
        and(
          eq('tasks.project_id', 5),
          or(
            ne('tasks.status', 'cancelled'),
            or(
              eq('tasks.creator_id', 'account_rdx1viewer'),
              eq('tasks.assignee_id', 'account_rdx1viewer'),
            ),
          ),
        ),
      )
    })

    it('project + explicit status=cancelled + viewerId: ANDing the two collapses to "cancelled AND viewer is party"', async () => {
      mockQuery.limit.mockResolvedValue([])

      await listTasks({ projectId: 5, status: 'cancelled', viewerId: 'account_rdx1viewer' })

      expect(mockQuery.where).toHaveBeenCalledWith(
        and(
          eq('tasks.status', 'cancelled'),
          eq('tasks.project_id', 5),
          or(
            ne('tasks.status', 'cancelled'),
            or(
              eq('tasks.creator_id', 'account_rdx1viewer'),
              eq('tasks.assignee_id', 'account_rdx1viewer'),
            ),
          ),
        ),
      )
    })

    it('every non-cancelled status filter is unaffected in shape — the OR is added but is trivially satisfied by the eq(status,X) already ANDed in', async () => {
      mockQuery.limit.mockResolvedValue([])

      await listTasks({ projectId: 5, status: 'open' })

      expect(mockQuery.where).toHaveBeenCalledWith(
        and(
          eq('tasks.status', 'open'),
          eq('tasks.project_id', 5),
          or(ne('tasks.status', 'cancelled'), sql`false`),
        ),
      )
    })
  })

  it('getTaskStats excludes swept stale-unfunded rows so the open count is not inflated', async () => {
    mockQuery.groupBy.mockResolvedValue([{ status: 'open', count: 2, totalXrd: '0' }])

    await getTaskStats()

    expect(mockQuery.where).toHaveBeenCalledWith(notHiddenStaleExpr())
  })

  it('should get submission count', async () => {
    mockQuery.where.mockResolvedValue([{ count: 3 }])

    const result = await getSubmissionCount(1)

    expect(mockDb.select).toHaveBeenCalled()
    expect(result).toBe(3)
  })

  it('should return 0 when no submissions found', async () => {
    mockQuery.where.mockResolvedValue([])

    const result = await getSubmissionCount(1)

    expect(result).toBe(0)
  })
})

describe('Submission Queries', () => {

  it('should find submissions by task ID', async () => {
    const mockSubmissions = [
      { id: 1, taskId: 1, status: 'submitted' },
      { id: 2, taskId: 1, status: 'approved' }
    ]
    mockQuery.where.mockResolvedValue(mockSubmissions)

    const result = await listSubmissionsByTask(1)

    expect(mockDb.select).toHaveBeenCalled()
    expect(mockQuery.where).toHaveBeenCalledWith(eq('submissions.task_id', 1))
    expect(result).toEqual(mockSubmissions)
  })

  it('should find submission by ID', async () => {
    const mockSubmission = { id: 1, taskId: 1, status: 'submitted' }
    mockDb.query.submissions.findFirst.mockResolvedValue(mockSubmission)

    const result = await findSubmissionById(1)

    expect(mockDb.query.submissions.findFirst).toHaveBeenCalledWith({
      where: eq('submissions.id', 1)
    })
    expect(result).toEqual(mockSubmission)
  })

  it('should return null when submission not found', async () => {
    mockDb.query.submissions.findFirst.mockResolvedValue(undefined)

    const result = await findSubmissionById(999)

    expect(result).toBeNull()
  })

  it('should create submission successfully', async () => {
    const mockSubmission = { id: 1, taskId: 1, status: 'pending' }
    mockQuery.returning.mockResolvedValue([mockSubmission])

    const result = await createSubmission({
      taskId: 1,
      submitterId: 'user123',
      deliverableUrl: 'https://github.com/user/repo/pull/1'
    })

    expect(mockDb.insert).toHaveBeenCalled()
    expect(mockQuery.values).toHaveBeenCalled()
    expect(mockQuery.returning).toHaveBeenCalled()
    expect(result).toEqual(mockSubmission)
  })

  // reviewSubmission is transactional and guarded: the owning task is re-read
  // FOR UPDATE (must be `submitted`) and the decision UPDATE carries a
  // status='pending' predicate — one decision per row (R3-a/b + the R3.3 race).
  const makeReviewTx = (taskStatus: string | null, updatedRows: unknown[]) => {
    const set = vi.fn()
    const returning = vi.fn().mockResolvedValue(updatedRows)
    set.mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) })
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            for: vi.fn().mockResolvedValue(taskStatus === null ? [] : [{ status: taskStatus }]),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({ set }),
    }
    mockDb.transaction.mockImplementation(async (callback: (t: unknown) => unknown) => callback(tx))
    return { tx, set }
  }

  it('should review submission as approved (stamps approvedAt, clears decline fields)', async () => {
    const mockSubmission = { id: 1, status: 'approved' }
    const { set } = makeReviewTx('submitted', [mockSubmission])

    const result = await reviewSubmission(1, 1, 'reviewer123', {
      status: 'approved',
      reviewNote: 'Good work!',
    })

    expect(set).toHaveBeenCalledWith({
      status: 'approved',
      reviewerId: 'reviewer123',
      reviewNote: 'Good work!',
      approvedAt: expect.any(Date),
      declineReason: null,
      declinedAt: null,
      updatedAt: expect.any(Date),
    })
    expect(result).toEqual({ ok: true, submission: mockSubmission })
  })

  it('should review submission as rejected with a structured decline reason', async () => {
    const mockSubmission = { id: 1, status: 'rejected' }
    const { set } = makeReviewTx('submitted', [mockSubmission])

    const result = await reviewSubmission(1, 1, 'reviewer123', {
      status: 'rejected',
      reviewNote: 'Needs work',
      declineReason: 'quality_issues',
    })

    expect(set).toHaveBeenCalledWith({
      status: 'rejected',
      reviewerId: 'reviewer123',
      reviewNote: 'Needs work',
      approvedAt: null,
      declineReason: 'quality_issues',
      declinedAt: expect.any(Date),
      updatedAt: expect.any(Date),
    })
    expect(result).toEqual({ ok: true, submission: mockSubmission })
  })

  it('should store revision_requested as itself (no more mapping to pending)', async () => {
    const mockSubmission = { id: 1, status: 'revision_requested' }
    const { set } = makeReviewTx('submitted', [mockSubmission])

    const result = await reviewSubmission(1, 1, 'reviewer123', {
      status: 'revision_requested',
      reviewNote: 'Please fix X',
    })

    expect(set).toHaveBeenCalledWith({
      status: 'revision_requested',
      reviewerId: 'reviewer123',
      reviewNote: 'Please fix X',
      approvedAt: null,
      declineReason: null,
      declinedAt: null,
      updatedAt: expect.any(Date),
    })
    expect(result).toEqual({ ok: true, submission: mockSubmission })
  })

  it('should refuse a second decision on an already-reviewed row (0 rows matched)', async () => {
    makeReviewTx('submitted', []) // status='pending' predicate matched nothing

    const result = await reviewSubmission(1, 1, 'reviewer123', { status: 'approved' })

    expect(result).toEqual({ ok: false, code: 'ALREADY_REVIEWED' })
  })

  it('should refuse the decision when the task left submitted under the row lock', async () => {
    const { tx } = makeReviewTx('disputed', [])

    const result = await reviewSubmission(1, 1, 'reviewer123', { status: 'approved' })

    expect(result).toEqual({ ok: false, code: 'TASK_NOT_SUBMITTED', taskStatus: 'disputed' })
    expect(tx.update).not.toHaveBeenCalled() // bounced before the decision write
  })

  it('should return the latest submission for a task+submitter pair', async () => {
    const latest = { id: 9, taskId: 1, submitterId: 'user123', status: 'revision_requested' }
    mockQuery.limit.mockResolvedValue([latest])

    const result = await findLatestSubmissionByTaskAndUser(1, 'user123')

    expect(mockDb.select).toHaveBeenCalled()
    expect(mockQuery.orderBy).toHaveBeenCalled()
    expect(result).toEqual(latest)
  })

  it('should count submissions by task', async () => {
    mockQuery.where.mockResolvedValue([{ count: 5 }])

    const result = await countSubmissionsByTask(1)

    expect(mockDb.select).toHaveBeenCalled()
    expect(result).toBe(5)
  })

  it('should return 0 when no submissions to count', async () => {
    mockQuery.where.mockResolvedValue([])

    const result = await countSubmissionsByTask(1)

    expect(result).toBe(0)
  })
})

describe('Escrow Queries', () => {

  it('should find escrow transactions by task ID', async () => {
    const mockEscrow = [
      { id: 1, taskId: 1, txType: 'fund', status: 'pending' },
      { id: 2, taskId: 1, txType: 'release', status: 'confirmed' }
    ]
    mockQuery.where.mockResolvedValue(mockEscrow)

    const result = await findEscrowByTask(1)

    expect(mockDb.select).toHaveBeenCalled()
    expect(mockQuery.where).toHaveBeenCalledWith(eq('escrow_transactions.task_id', 1))
    expect(result).toEqual(mockEscrow)
  })

  it("records a confirmed escrow tx when none exists for (taskId, txType)", async () => {
    const row = { id: 10, taskId: 1, txType: "fund", status: "confirmed", txHash: "txid_rdx1x" }
    mockDb.transaction.mockImplementation(async (callback) => {
      const mockTx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]), // no existing row
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([row]),
            }),
          }),
        }),
      }
      return callback(mockTx)
    })

    const result = await recordConfirmedEscrowTx({
      taskId: 1,
      txType: "fund",
      fromUserId: "account_rdx1poster",
      amountXrd: "10.5",
      txHash: "txid_rdx1x",
    })

    // inserted=true marks the FIRST physical write — the confirm core keys
    // once-only side effects (the XP award) on it.
    expect(result).toEqual({ row, inserted: true })
  })

  it("returns the winner's row when a concurrent confirm wins the unique-index race", async () => {
    // Both writers pass the existence check; the loser's INSERT hits the
    // unique (task_id, tx_type) index, ON CONFLICT DO NOTHING returns no row,
    // and the fall-through re-select returns the committed winner.
    const winner = { id: 11, taskId: 1, txType: "release", status: "confirmed", txHash: "txid_rdx1w" }
    const whereMock = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([winner])
    mockDb.transaction.mockImplementation(async (callback) => {
      const mockTx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({ where: whereMock }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]), // conflict: nothing inserted
            }),
          }),
        }),
      }
      return callback(mockTx)
    })

    const result = await recordConfirmedEscrowTx({
      taskId: 1,
      txType: "release",
      fromUserId: "account_rdx1poster",
      toUserId: "account_rdx1worker",
      amountXrd: "10.5",
      txHash: "txid_rdx1loser",
    })

    // The loser reports inserted=false — only the winner's confirm may fire
    // insert-keyed side effects.
    expect(result).toEqual({ row: winner, inserted: false })
    expect(whereMock).toHaveBeenCalledTimes(2)
  })

  it("escrow_transactions enforces the one-row-per-(task, txType) ledger invariant in the DB", () => {
    // Renamed and made PARTIAL by the PULL migration so settle/withdraw rows —
    // legitimately many-per-task — fall outside it. Its coverage of the original
    // four types is unchanged, and that is what keeps the XP award exactly-once
    // (gated on the first physical insert of the (task_id, 'release') row).
    const { indexes } = getTableConfig(escrowTransactions)
    const unique = indexes.find((i) => i.config.name === "escrow_legacy_task_tx_type_unique")
    expect(unique).toBeDefined()
    expect(unique!.config.unique).toBe(true)
    expect(unique!.config.columns.map((c) => (c as { name: string }).name)).toEqual([
      "task_id",
      "tx_type",
    ])
    expect(unique!.config.where).toBeDefined()
  })

  it("escrow_transactions keys entitlement rows per (tx, type, party, lane)", () => {
    // Every column here is load-bearing, and dropping any ONE of them silently
    // loses or blocks a real money row:
    //   no tx_hash  → a legitimate repeat (claim→expire→re-claim→expire credits
    //                 (task, poster, bond) twice) is rejected as a duplicate.
    //   no lane     → the 2nd leg of one withdraw tx is swallowed; in production
    //                 both lanes are XRD, so the resource cannot tell them apart.
    //   no tx_type  → "cancel and refund myself" is ONE poster-signed manifest
    //                 emitting a credit AND a collection for the same (party,
    //                 lane) under one tx_hash; the collection is swallowed and
    //                 the ledger claims the poster is still owed.
    const { indexes } = getTableConfig(escrowTransactions)
    const ent = indexes.find((i) => i.config.name === "escrow_entitlement_unique")
    expect(ent).toBeDefined()
    expect(ent!.config.unique).toBe(true)
    expect(ent!.config.columns.map((c) => (c as { name: string }).name)).toEqual([
      "tx_hash",
      "task_id",
      "tx_type",
      "party",
      "lane",
    ])
    expect(ent!.config.where).toBeDefined()
  })

  it("escrow_transactions guards the entitlement columns with paired-null CHECKs", () => {
    // Without these, one NULL in the unique index's columns makes an entitlement
    // row unconstrained (Postgres treats NULLs as DISTINCT) — the guard would
    // still exist and enforce nothing.
    const { checks } = getTableConfig(escrowTransactions)
    const names = checks.map((c) => c.name).sort()
    expect(names).toEqual([
      "escrow_entitlement_fields_present",
      "escrow_legacy_rows_have_no_entitlement_fields",
    ])
  })

  it("is idempotent: returns the existing row without inserting a duplicate", async () => {
    const existing = { id: 10, taskId: 1, txType: "release", status: "confirmed" }
    const insertSpy = vi.fn()
    mockDb.transaction.mockImplementation(async (callback) => {
      const mockTx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([existing]), // row already present
          }),
        }),
        insert: insertSpy,
      }
      return callback(mockTx)
    })

    const result = await recordConfirmedEscrowTx({
      taskId: 1,
      txType: "release",
      fromUserId: "account_rdx1poster",
      toUserId: "account_rdx1worker",
      amountXrd: "10.5",
      txHash: "txid_rdx1y",
    })

    expect(result).toEqual({ row: existing, inserted: false })
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it("runs on a caller-supplied tx handle without opening its own transaction", async () => {
    const row = { id: 12, taskId: 1, txType: "fund", status: "confirmed", txHash: "txid_rdx1z" }
    const callerTx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]), // no existing row
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([row]),
          }),
        }),
      }),
    }

    const result = await recordConfirmedEscrowTx(
      {
        taskId: 1,
        txType: "fund",
        fromUserId: "account_rdx1poster",
        amountXrd: "10.5",
        txHash: "txid_rdx1z",
      },
      callerTx as never,
    )

    expect(result).toEqual({ row, inserted: true })
    expect(callerTx.insert).toHaveBeenCalled()
    // The write must commit/roll back with the caller's transaction — opening
    // a nested one here would break the confirm route's atomicity.
    expect(mockDb.transaction).not.toHaveBeenCalled()
  })
})
