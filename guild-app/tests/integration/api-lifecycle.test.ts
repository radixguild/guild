/**
 * Handler-level integration test for the off-chain task lifecycle:
 *   create → list/detail → submit → review (decision only) → cancel guards.
 *
 * The REAL route handlers run end-to-end — real zod validation, real
 * tier/trust helpers, real authz + state-machine checks. Only the edges are
 * mocked: auth (switchable user), rate limiting, the badge gateway, and the
 * db query layer. The query layer is a small stateful in-memory fake
 * (vi.fn-wrapped so calls can be asserted), so state written by one handler
 * is exactly what the next handler reads — unlike the per-route unit tests,
 * the lifecycle here flows through one shared store.
 *
 * Status vocabulary is the app's real enum only: open / assigned / submitted /
 * paid / cancelled / disputed / refunded ("verified" was retired — Decision #3,
 * docs/OVERHAUL-HANDOFF.md). On-chain transitions (assign-on-claim, paid,
 * disputed, refunded) advance SOLELY via the escrow-confirm route (covered in
 * escrow-confirm.test.ts); where the lifecycle needs one, the test seeds the
 * store with what that confirm would have written and asserts the guards that
 * protect the funded lane.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Switchable authed user (same withAuth mock as the unit route tests, but
// the lifecycle alternates between poster, worker, and outsider) ─────────────
const auth = vi.hoisted(() => ({ userId: "account_rdx1poster" }))
vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: auth.userId } }),
  // GET /api/v1/tasks reads this directly now (unauthenticated route,
  // optional session — see the includeHiddenStale gate, PR #459 defect 2).
  // No listing call in this file scopes by creator/assignee, so a static
  // "no session" is faithful; tests/unit/tasks-creator-filter.test.ts covers
  // the session-matching behaviour itself.
  getSessionUser: vi.fn().mockResolvedValue(null),
}))

const POSTER = "account_rdx1poster"
const WORKER = "account_rdx1worker"
const OUTSIDER = "account_rdx1outsider"
const asUser = (userId: string) => {
  auth.userId = userId
}

// ── Stateful in-memory query layer ───────────────────────────────────────────
// Faithful to the real modules where the ROUTES depend on it: createTask
// applies the pg schema defaults (status "open", null assignee/escrow linkage),
// reviewSubmission maps revision_requested → pending. The drizzle where-clause
// mechanics of the real query layer are covered in db-queries.test.ts.
const fake = vi.hoisted(() => {
  type TaskRow = {
    id: number
    title: string
    description: string
    status: "open" | "assigned" | "submitted" | "paid" | "cancelled" | "disputed" | "refunded"
    rewardXrd: string
    creatorId: string
    assigneeId: string | null
    xpReward: number
    onChainTaskId: number | null
    escrowComponent: string | null
    projectId: number | null
    deadline: Date | null
    terms: unknown
    createdAt: Date
    updatedAt: Date
  }
  type SubmissionRow = {
    id: number
    taskId: number
    submitterId: string
    content: string
    status: "pending" | "approved" | "rejected" | "revision_requested"
    reviewerId: string | null
    reviewNote: string | null
    declineReason: string | null
    declinedAt: Date | null
    approvedAt: Date | null
    createdAt: Date
    updatedAt: Date
  }

  const tasks: TaskRow[] = []
  const submissions: SubmissionRow[] = []
  let nextTaskId = 1
  let nextSubmissionId = 1

  const reset = () => {
    tasks.length = 0
    submissions.length = 0
    nextTaskId = 1
    nextSubmissionId = 1
  }

  const createTask = vi.fn(async (data: Partial<TaskRow>) => {
    const now = new Date()
    const task: TaskRow = {
      id: nextTaskId++,
      title: "",
      description: "",
      status: "open", // pg schema default — the create route relies on it
      rewardXrd: "0",
      creatorId: "",
      assigneeId: null,
      xpReward: 0,
      onChainTaskId: null,
      escrowComponent: null,
      projectId: null,
      deadline: null,
      terms: null,
      createdAt: now,
      updatedAt: now,
      ...data,
    }
    tasks.push(task)
    return task
  })

  const findTaskById = vi.fn(
    async (id: number) => tasks.find((t) => t.id === id) ?? null,
  )

  const updateTask = vi.fn(async (id: number, data: Partial<TaskRow>) => {
    const task = tasks.find((t) => t.id === id)
    if (!task) return undefined
    Object.assign(task, data, { updatedAt: new Date() })
    return task
  })

  // Compare-and-swap: applies only while the row's current status is in
  // fromStatuses (the ALLOWED_FROM gate pushed into the WHERE clause). Returns
  // null when the predicate misses — faithful to the real query.
  const updateTaskIfStatus = vi.fn(
    async (id: number, data: Partial<TaskRow>, fromStatuses: readonly string[]) => {
      const task = tasks.find((t) => t.id === id)
      if (!task || !fromStatuses.includes(task.status)) return null
      Object.assign(task, data, { updatedAt: new Date() })
      return task
    },
  )

  const cancelTask = vi.fn(async (id: number) => updateTask(id, { status: "cancelled" }))

  const getSubmissionCount = vi.fn(
    async (taskId: number) => submissions.filter((s) => s.taskId === taskId).length,
  )

  const listTasks = vi.fn(
    async (
      filters: {
        status?: string
        creatorId?: string
        assigneeId?: string
        projectId?: number
        cursor?: string
        limit?: number
        sort?: string
      } = {},
    ) => {
      const limit = Math.min(filters.limit || 20, 100)
      const rows = tasks
        .filter(
          (t) =>
            (!filters.status || t.status === filters.status) &&
            (!filters.creatorId || t.creatorId === filters.creatorId) &&
            (!filters.assigneeId || t.assigneeId === filters.assigneeId) &&
            (filters.projectId === undefined || t.projectId === filters.projectId),
        )
        .sort((a, b) => b.id - a.id) // newest-first default
      const hasMore = rows.length > limit
      const data = hasMore ? rows.slice(0, limit) : rows
      return {
        data,
        cursor: hasMore && data.length > 0 ? String(data[data.length - 1].id) : null,
        hasMore,
      }
    },
  )

  const createSubmission = vi.fn(
    async (data: { taskId: number; submitterId: string; content: string }) => {
      const now = new Date()
      const submission: SubmissionRow = {
        id: nextSubmissionId++,
        status: "pending", // pg schema default
        reviewerId: null,
        reviewNote: null,
        declineReason: null,
        declinedAt: null,
        approvedAt: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      }
      submissions.push(submission)
      return submission
    },
  )

  const listSubmissionsByTask = vi.fn(async (taskId: number) =>
    submissions.filter((s) => s.taskId === taskId),
  )

  const findSubmissionById = vi.fn(
    async (id: number) => submissions.find((s) => s.id === id) ?? null,
  )

  // Latest attempt (highest id) by this submitter on this task — the resubmit
  // gate reads it.
  const findLatestSubmissionByTaskAndUser = vi.fn(
    async (taskId: number, submitterId: string) =>
      submissions
        .filter((s) => s.taskId === taskId && s.submitterId === submitterId)
        .sort((a, b) => b.id - a.id)[0] ?? null,
  )

  // Transactional + guarded, faithful to the real query: the owning task must
  // be `submitted` (re-checked under the row lock) and the submission row only
  // accepts a decision while `pending`. Returns the tagged-union result shape
  // the review route now reads.
  const reviewSubmission = vi.fn(
    async (
      id: number,
      taskId: number,
      reviewerId: string,
      decision: {
        status: "approved" | "rejected" | "revision_requested"
        reviewNote?: string
        declineReason?: string
      },
    ) => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task || task.status !== "submitted") {
        return { ok: false as const, code: "TASK_NOT_SUBMITTED" as const, taskStatus: task?.status }
      }
      const submission = submissions.find((s) => s.id === id)
      if (!submission || submission.status !== "pending") {
        return { ok: false as const, code: "ALREADY_REVIEWED" as const }
      }
      const rejected = decision.status === "rejected"
      Object.assign(submission, {
        status: decision.status, // revision_requested now stored as itself
        reviewerId,
        reviewNote: decision.reviewNote ?? null,
        approvedAt: decision.status === "approved" ? new Date() : null,
        declineReason: rejected ? (decision.declineReason ?? null) : null,
        declinedAt: rejected ? new Date() : null,
        updatedAt: new Date(),
      })
      return { ok: true as const, submission }
    },
  )

  return {
    tasks,
    submissions,
    reset,
    createTask,
    findTaskById,
    updateTask,
    updateTaskIfStatus,
    cancelTask,
    getSubmissionCount,
    listTasks,
    createSubmission,
    listSubmissionsByTask,
    findSubmissionById,
    findLatestSubmissionByTaskAndUser,
    reviewSubmission,
  }
})

vi.mock("@/db/queries/tasks", () => ({
  listTasks: fake.listTasks,
  createTask: fake.createTask,
  findTaskById: fake.findTaskById,
  updateTask: fake.updateTask,
  updateTaskIfStatus: fake.updateTaskIfStatus,
  cancelTask: fake.cancelTask,
  getSubmissionCount: fake.getSubmissionCount,
}))

vi.mock("@/db/queries/submissions", () => ({
  listSubmissionsByTask: fake.listSubmissionsByTask,
  createSubmission: fake.createSubmission,
  findSubmissionById: fake.findSubmissionById,
  findLatestSubmissionByTaskAndUser: fake.findLatestSubmissionByTaskAndUser,
  reviewSubmission: fake.reviewSubmission,
}))

const {
  mockFindProjectById,
  mockGetTrustStats,
  mockGetPosterCancelStats,
  mockLoadUserBadge,
  mockRecordConfirmedEscrowTx,
} = vi.hoisted(() => ({
  mockFindProjectById: vi.fn(),
  mockGetTrustStats: vi.fn(),
  mockGetPosterCancelStats: vi.fn(),
  mockLoadUserBadge: vi.fn(),
  mockRecordConfirmedEscrowTx: vi.fn(),
}))
vi.mock("@/db/queries/projects", () => ({ findProjectById: mockFindProjectById }))
vi.mock("@/db/queries/trust", () => ({ getTrustStats: mockGetTrustStats }))
// PROJECT-STATE.md's 2026-09-01 §20 design packet (unnumbered "Also in §20"
// bullet — NOT §20.4, an unrelated open bug) — GET /tasks/[id] also reads
// the poster's cancel-after-claim history now. Same mocking shape as
// getTrustStats above: the real route handler runs, only its DB call is
// faked.
vi.mock("@/db/queries/poster-cancel-stats", () => ({ getPosterCancelStats: mockGetPosterCancelStats }))
// The halt gate (P1 write side) now runs first in every task-lifecycle write, and it reads
// the live Gateway. Pin an advancing chain so this suite stays offline and deterministic —
// without it these tests reach mainnet and correctly 503 during the real halt. The gate's
// own behaviour is pinned in tests/unit/chain-halt-gate.test.ts; keeping the REAL gate in
// the path here (rather than stubbing the module) means these routes still execute it.
vi.mock("@/lib/gateway", () => ({
  loadUserBadge: mockLoadUserBadge,
  NETWORK_HALT_AFTER_SECONDS: 900,
  operatorHaltEngaged: () => false,
  readLedgerTip: async () => ({
    stateVersion: 600_000_000,
    tipIso: "2026-09-08T09:00:00Z",
    ageSeconds: 12,
    stale: false,
  }),
}))

// Tripwire (same as review-route.test.ts): none of these handlers may touch
// the escrow ledger — money moves via the on-chain confirm route only.
vi.mock("@/db/queries/escrow", () => ({
  recordConfirmedEscrowTx: mockRecordConfirmedEscrowTx,
  findEscrowByTask: vi.fn(),
}))

// Pin the member badge and keep the agent badge dormant (prod default) so the
// gate does exactly one deterministic lookup; the agent-badge fallback is
// covered in submissions-route.test.ts.
const MEMBER_BADGE = "resource_rdx1memberbadge"
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  BADGE_NFT: "resource_rdx1memberbadge",
  AGENT_BADGE_NFT: "",
}))

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => () => ({ ok: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}))

// Import AFTER mocks are registered.
import { GET as listTasksRoute, POST as createTaskRoute } from "@/app/api/v1/tasks/route"
import {
  GET as getTaskRoute,
  PATCH as updateTaskRoute,
  DELETE as deleteTaskRoute,
} from "@/app/api/v1/tasks/[id]/route"
import {
  GET as listSubmissionsRoute,
  POST as submitWorkRoute,
} from "@/app/api/v1/tasks/[id]/submissions/route"
import { PATCH as reviewRoute } from "@/app/api/v1/submissions/[id]/review/route"

const jsonReq = (body: unknown) => ({ json: async () => body }) as never
const urlReq = (query = "") => ({ url: `http://localhost/api/v1/tasks${query}` }) as never
const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) }) as never

const EMPTY_TRUST = {
  completed: 0,
  claimed: 0,
  failed: 0,
  disputesRaised: 0,
  disputesAgainst: 0,
  deadlineSubmits: 0,
  onTimeSubmits: 0,
}

/** Create a task through the real handler; returns the created row's id. */
async function createTaskAs(creator: string, overrides: Record<string, unknown> = {}) {
  asUser(creator)
  const res = await createTaskRoute(
    jsonReq({
      title: "Port the docs widget",
      description: "Port the widget to the new stack",
      reward_amount: "25",
      ...overrides,
    }),
    {} as never,
  )
  const json = await res.json()
  return { res, json, taskId: json?.data?.id as number }
}

async function submitWorkAs(worker: string, taskId: number, content = "PR #42: done") {
  asUser(worker)
  const res = await submitWorkRoute(jsonReq({ content }), ctx(taskId))
  return { res, json: await res.json() }
}

describe("API lifecycle: create → list → submit → review (off-chain lane)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fake.reset()
    asUser(POSTER)
    mockFindProjectById.mockResolvedValue(null)
    mockGetTrustStats.mockResolvedValue(EMPTY_TRUST)
    mockGetPosterCancelStats.mockResolvedValue({ totalPosted: 0, cancelledAfterClaim: 0 })
    mockLoadUserBadge.mockResolvedValue({ id: "#1#", tier: "member", status: "active" })
  })

  it("walks the full off-chain happy path: create → list → detail → submit → approve", async () => {
    // 1. Poster creates the task (201, status open, platform-derived XP tier).
    const { res: createRes, json: created, taskId } = await createTaskAs(POSTER)
    expect(createRes.status).toBe(201)
    expect(created.ok).toBe(true)
    expect(created.data).toMatchObject({
      id: taskId,
      status: "open",
      creatorId: POSTER,
      rewardXrd: "25",
      xpReward: 25, // real getTierForReward: 25 XRD → medium tier → 25 XP
    })
    expect(fake.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ creatorId: POSTER, rewardXrd: "25", xpReward: 25 }),
    )

    // 2. The listing reflects it with the paginated envelope.
    const listRes = await listTasksRoute(urlReq("?status=open"))
    const listed = await listRes.json()
    expect(listRes.status).toBe(200)
    expect(listed.ok).toBe(true)
    expect(listed.data).toHaveLength(1)
    expect(listed.data[0]).toMatchObject({ id: taskId, status: "open" })
    expect(listed).toMatchObject({ cursor: null, hasMore: false })
    expect(fake.listTasks).toHaveBeenCalledWith(expect.objectContaining({ status: "open" }))

    // 3. Detail: zero submissions, no project, no assignee yet.
    const detailRes = await getTaskRoute(urlReq(), ctx(taskId))
    const detail = await detailRes.json()
    expect(detailRes.status).toBe(200)
    expect(detail.data).toMatchObject({
      id: taskId,
      status: "open",
      submissionCount: 0,
      project: null,
      assigneeTrust: null,
    })

    // 4. A badged worker submits: 201, badge resolved server-side, and the
    //    off-chain task (no onChainTaskId) flips to "submitted".
    const { res: submitRes, json: submitted } = await submitWorkAs(WORKER, taskId)
    expect(submitRes.status).toBe(201)
    expect(submitted.ok).toBe(true)
    expect(submitted.data).toMatchObject({ taskId, submitterId: WORKER, status: "pending" })
    expect(mockLoadUserBadge).toHaveBeenCalledWith(WORKER, MEMBER_BADGE)
    expect(fake.createSubmission).toHaveBeenCalledWith({
      taskId,
      submitterId: WORKER,
      content: "PR #42: done",
    })
    expect(fake.updateTaskIfStatus).toHaveBeenCalledWith(taskId, { status: "submitted" }, ["open", "assigned"])

    // 5. Detail now shows the submitted state written in step 4.
    const detail2 = await (await getTaskRoute(urlReq(), ctx(taskId))).json()
    expect(detail2.data).toMatchObject({ status: "submitted", submissionCount: 1 })

    // 6. The poster approves — decision recorded, but NO money/status movement:
    //    paid is reachable only through the escrow-confirm route.
    const submissionId = submitted.data.id as number
    asUser(POSTER)
    const reviewRes = await reviewRoute(
      jsonReq({ status: "approved", reviewer_notes: "Great work" }),
      ctx(submissionId),
    )
    const reviewed = await reviewRes.json()
    expect(reviewRes.status).toBe(200)
    expect(reviewed.ok).toBe(true)
    expect(reviewed.data).toMatchObject({ id: submissionId, status: "approved" })
    expect(fake.reviewSubmission).toHaveBeenCalledWith(
      submissionId,
      taskId,
      POSTER,
      { status: "approved", reviewNote: "Great work", declineReason: undefined },
    )
    expect(fake.tasks[0].status).toBe("submitted") // review never advances the task
    expect(fake.updateTaskIfStatus).toHaveBeenCalledTimes(1) // only the step-4 flip
    expect(fake.updateTask).not.toHaveBeenCalled() // review touches no task row
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled() // ledger untouched
  })

  it("rejects an invalid create payload and a create against a missing project", async () => {
    const { res: invalidRes, json: invalid } = await createTaskAs(POSTER, { title: "" })
    expect(invalidRes.status).toBe(400)
    expect(invalid.ok).toBe(false)
    expect(invalid.error.code).toBe("VALIDATION_ERROR")
    expect(fake.createTask).not.toHaveBeenCalled()

    const { res: orphanRes, json: orphan } = await createTaskAs(POSTER, { project_id: 99 })
    expect(orphanRes.status).toBe(404)
    expect(orphan.error.code).toBe("PROJECT_NOT_FOUND")
    expect(fake.createTask).not.toHaveBeenCalled()
  })

  it("rejects the retired 'verified' status as a list filter (Decision #3)", async () => {
    const res = await listTasksRoute(urlReq("?status=verified"))
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json).toMatchObject({ ok: false, error: { code: "INVALID_STATUS" } })
    expect(fake.listTasks).not.toHaveBeenCalled()
  })

  it("blocks the creator from submitting to their own task (SELF_SUBMIT)", async () => {
    const { taskId } = await createTaskAs(POSTER)

    const { res, json } = await submitWorkAs(POSTER, taskId)
    expect(res.status).toBe(403)
    expect(json.error.code).toBe("SELF_SUBMIT")
    expect(mockLoadUserBadge).not.toHaveBeenCalled() // authz precedes the gateway hit
    expect(fake.createSubmission).not.toHaveBeenCalled()
    expect(fake.tasks[0].status).toBe("open") // nothing moved
  })

  it("lets only the assignee submit once a task is assigned (NOT_ASSIGNEE)", async () => {
    const { taskId } = await createTaskAs(POSTER)
    // Assignment happens via the on-chain claim → escrow-confirm route; seed
    // exactly what that confirm writes.
    Object.assign(fake.tasks[0], { status: "assigned", assigneeId: WORKER })

    const { res: outsiderRes, json: outsider } = await submitWorkAs(OUTSIDER, taskId)
    expect(outsiderRes.status).toBe(403)
    expect(outsider.error.code).toBe("NOT_ASSIGNEE")
    expect(mockLoadUserBadge).not.toHaveBeenCalled() // cheap check short-circuits
    expect(fake.createSubmission).not.toHaveBeenCalled()

    const { res: assigneeRes } = await submitWorkAs(WORKER, taskId)
    expect(assigneeRes.status).toBe(201)
    expect(fake.createSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, submitterId: WORKER }),
    )
  })

  it("surfaces the assignee's ledger-derived trust tier on the task detail", async () => {
    const { taskId } = await createTaskAs(POSTER)
    Object.assign(fake.tasks[0], { status: "assigned", assigneeId: WORKER })
    // 6 completed, clean record → real trustTierFor says "established".
    mockGetTrustStats.mockResolvedValue({ ...EMPTY_TRUST, completed: 6, claimed: 8 })

    const res = await getTaskRoute(urlReq(), ctx(taskId))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(mockGetTrustStats).toHaveBeenCalledWith(WORKER)
    expect(json.data.assigneeTrust).toEqual({ tier: "established" })
  })

  it("surfaces the poster's cancel-after-claim history on the task detail", async () => {
    const { taskId } = await createTaskAs(POSTER)
    // 1 of 4 posted tasks cancelled after a worker had already claimed —
    // distinct from the beforeEach default so a round-trip failure can't
    // hide behind the zero-value default.
    mockGetPosterCancelStats.mockResolvedValue({ totalPosted: 4, cancelledAfterClaim: 1 })

    const res = await getTaskRoute(urlReq(), ctx(taskId))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(mockGetPosterCancelStats).toHaveBeenCalledWith(POSTER)
    expect(json.data.posterCancelStats).toEqual({ totalPosted: 4, cancelledAfterClaim: 1 })
  })

  it("fails closed when the submitter holds no badge (NO_BADGE)", async () => {
    const { taskId } = await createTaskAs(POSTER)
    mockLoadUserBadge.mockResolvedValue(null) // no badge OR gateway error

    const { res, json } = await submitWorkAs(WORKER, taskId)
    expect(res.status).toBe(403)
    expect(json.error.code).toBe("NO_BADGE")
    expect(mockLoadUserBadge).toHaveBeenCalledTimes(1) // agent badge dormant here
    expect(fake.createSubmission).not.toHaveBeenCalled()
    expect(fake.tasks[0].status).toBe("open")
  })

  it("lets the worker resubmit after a revision request, as a new attempt (R3-a)", async () => {
    const { taskId } = await createTaskAs(POSTER)
    const { json: submitted } = await submitWorkAs(WORKER, taskId)
    const submissionId = submitted.data.id as number

    // Poster requests changes: the row is now revision_requested (stored as
    // itself — no longer masked as pending) and the task stays submitted.
    asUser(POSTER)
    const reviewRes = await reviewRoute(
      jsonReq({ status: "revision_requested", reviewer_notes: "Please add tests" }),
      ctx(submissionId),
    )
    expect(reviewRes.status).toBe(200)
    expect(fake.reviewSubmission).toHaveBeenCalledWith(
      submissionId,
      taskId,
      POSTER,
      { status: "revision_requested", reviewNote: "Please add tests", declineReason: undefined },
    )
    expect(fake.submissions[0].status).toBe("revision_requested")
    expect(fake.tasks[0].status).toBe("submitted")

    // The worker CAN now post revised work — a NEW row per attempt (the
    // decision audit trail); the task stays submitted (no on-chain resubmit).
    const { res: resubmitRes, json: resubmit } = await submitWorkAs(WORKER, taskId, "PR #42 v2")
    expect(resubmitRes.status).toBe(201)
    expect(resubmit.data).toMatchObject({ taskId, submitterId: WORKER, status: "pending" })
    expect(fake.createSubmission).toHaveBeenCalledTimes(2)
    expect(fake.submissions).toHaveLength(2)
    expect(fake.tasks[0].status).toBe("submitted")

    // Re-reviewing the OLD (already-decided) row is refused — one decision per
    // row (R3-b). The poster reviews the new pending attempt instead.
    asUser(POSTER)
    const staleReview = await reviewRoute(jsonReq({ status: "approved" }), ctx(submissionId))
    const staleJson = await staleReview.json()
    expect(staleReview.status).toBe(409)
    expect(staleJson.error.code).toBe("ALREADY_REVIEWED")
  })

  it("never flips the DB status of an escrow-funded task on submission", async () => {
    const { taskId } = await createTaskAs(POSTER)
    // Funded + claimed on-chain: the confirm route wrote the linkage.
    Object.assign(fake.tasks[0], {
      status: "assigned",
      assigneeId: WORKER,
      onChainTaskId: 7,
      escrowComponent: "component_rdx1escrow",
    })

    const { res } = await submitWorkAs(WORKER, taskId)
    expect(res.status).toBe(201)
    expect(fake.createSubmission).toHaveBeenCalled()
    // Status is mirrored from verified chain events ONLY for funded tasks.
    expect(fake.updateTask).not.toHaveBeenCalled()
    expect(fake.tasks[0].status).toBe("assigned")
  })

  it("lets only the task creator review a submission (FORBIDDEN)", async () => {
    const { taskId } = await createTaskAs(POSTER)
    const { json: submitted } = await submitWorkAs(WORKER, taskId)
    const submissionId = submitted.data.id as number

    for (const nonCreator of [WORKER, OUTSIDER]) {
      asUser(nonCreator)
      const res = await reviewRoute(jsonReq({ status: "approved" }), ctx(submissionId))
      const json = await res.json()
      expect(res.status).toBe(403)
      expect(json.error.code).toBe("FORBIDDEN")
    }
    expect(fake.reviewSubmission).not.toHaveBeenCalled()
    expect(fake.submissions[0].status).toBe("pending") // decision untouched
  })

  it("404s a review of a submission that does not exist", async () => {
    asUser(POSTER)
    const res = await reviewRoute(jsonReq({ status: "approved" }), ctx(123))
    const json = await res.json()
    expect(res.status).toBe(404)
    expect(json.error.code).toBe("NOT_FOUND")
  })

  it("blocks review once the task has left 'submitted' (terminal-state guard)", async () => {
    const { taskId } = await createTaskAs(POSTER)
    const { json: submitted } = await submitWorkAs(WORKER, taskId)
    const submissionId = submitted.data.id as number
    // The on-chain approve_and_release confirm advanced the task to paid.
    Object.assign(fake.tasks[0], { status: "paid", assigneeId: WORKER, onChainTaskId: 7 })

    asUser(POSTER)
    const res = await reviewRoute(jsonReq({ status: "approved" }), ctx(submissionId))
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.error.code).toBe("INVALID_STATUS")
    expect(fake.reviewSubmission).not.toHaveBeenCalled()
  })

  it("restricts task edits to the creator and to the open state", async () => {
    const { taskId } = await createTaskAs(POSTER)

    asUser(OUTSIDER)
    const forbidden = await updateTaskRoute(jsonReq({ title: "Hijacked" }), ctx(taskId))
    expect(forbidden.status).toBe(403)
    expect((await forbidden.json()).error.code).toBe("FORBIDDEN")

    asUser(POSTER)
    const ok = await updateTaskRoute(jsonReq({ title: "Port the docs widget v2" }), ctx(taskId))
    expect(ok.status).toBe(200)
    expect((await ok.json()).data).toMatchObject({ title: "Port the docs widget v2" })
    expect(fake.tasks[0].title).toBe("Port the docs widget v2")

    // Once work has arrived the task has left "open" — edits are frozen.
    await submitWorkAs(WORKER, taskId)
    asUser(POSTER)
    const frozen = await updateTaskRoute(jsonReq({ title: "Too late" }), ctx(taskId))
    expect(frozen.status).toBe(400)
    expect((await frozen.json()).error.code).toBe("INVALID_STATUS")
    expect(fake.tasks[0].title).toBe("Port the docs widget v2")
  })

  it("guards cancellation: funded tasks 409, tasks with submissions 400, pristine tasks cancel", async () => {
    // Funded: cancel/refund must go through the escrow contract.
    const { taskId: fundedId } = await createTaskAs(POSTER)
    Object.assign(fake.tasks[0], { onChainTaskId: 3, escrowComponent: "component_rdx1escrow" })
    asUser(POSTER)
    const funded = await deleteTaskRoute(urlReq(), ctx(fundedId))
    expect(funded.status).toBe(409)
    expect((await funded.json()).error.code).toBe("ON_CHAIN_ESCROW")

    // Defensive guard: an open task that somehow has submissions cannot be
    // cancelled (normal off-chain flow flips status on the first submission,
    // so this state is seeded directly).
    const { taskId: busyId } = await createTaskAs(POSTER)
    fake.submissions.push({
      id: 99,
      taskId: busyId,
      submitterId: WORKER,
      content: "wip",
      status: "pending",
      reviewerId: null,
      reviewNote: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    asUser(POSTER)
    const busy = await deleteTaskRoute(urlReq(), ctx(busyId))
    expect(busy.status).toBe(400)
    expect((await busy.json()).error.code).toBe("HAS_SUBMISSIONS")
    expect(fake.cancelTask).not.toHaveBeenCalled()

    // Pristine open task: cancels cleanly, no ledger write (never funded).
    const { taskId: cleanId } = await createTaskAs(POSTER)
    asUser(POSTER)
    const clean = await deleteTaskRoute(urlReq(), ctx(cleanId))
    expect(clean.status).toBe(200)
    expect(await clean.json()).toEqual({ ok: true, data: null })
    expect(fake.cancelTask).toHaveBeenCalledWith(cleanId)
    expect(fake.tasks.find((t) => t.id === cleanId)?.status).toBe("cancelled")
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
  })

  it("keeps submissions private to the creator and submitters", async () => {
    const { taskId } = await createTaskAs(POSTER)
    await submitWorkAs(WORKER, taskId)

    asUser(OUTSIDER)
    const outsider = await listSubmissionsRoute(urlReq(), ctx(taskId))
    expect(outsider.status).toBe(403)
    expect((await outsider.json()).error.code).toBe("FORBIDDEN")

    asUser(POSTER)
    const poster = await listSubmissionsRoute(urlReq(), ctx(taskId))
    const posterJson = await poster.json()
    expect(poster.status).toBe(200)
    expect(posterJson.data).toHaveLength(1)
    expect(posterJson.data[0]).toMatchObject({ taskId, submitterId: WORKER })

    asUser(WORKER)
    const submitter = await listSubmissionsRoute(urlReq(), ctx(taskId))
    expect(submitter.status).toBe(200)
  })
})
