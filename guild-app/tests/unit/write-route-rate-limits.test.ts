/**
 * Rate limits on the two mutating routes the 2026-09-26 sweep found without
 * one: PATCH/DELETE /api/v1/tasks/[id] (edit / cancel) and
 * PATCH /api/v1/notifications/read. Both were already ownership-gated, so this
 * was a coverage gap, not an open hole — these tests pin the wiring.
 *
 * Deliberately runs the REAL limiter from @/lib/rate-limit (every other route
 * test mocks it out), so deleting a route's `limit` check fails here. The
 * limiter's own window/eviction behaviour is covered in lib-rate-limit.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// withAuth → the session user is whoever `session.userId` names at call time,
// so the per-user keying can be exercised with two accounts in one file.
const session = vi.hoisted(() => ({ userId: "account_rdx1poster" }))
vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: session.userId } }),
  getSessionUser: vi.fn(),
}))

const { mockFindTaskById, mockUpdateTask, mockCancelTask, mockGetSubmissionCount } = vi.hoisted(() => ({
  mockFindTaskById: vi.fn(),
  mockUpdateTask: vi.fn(),
  mockCancelTask: vi.fn(),
  mockGetSubmissionCount: vi.fn(),
}))
vi.mock("@/db/queries/tasks", () => ({
  findTaskById: mockFindTaskById,
  updateTask: mockUpdateTask,
  cancelTask: mockCancelTask,
  getSubmissionCount: mockGetSubmissionCount,
}))
vi.mock("@/db/queries/projects", () => ({ findProjectById: vi.fn() }))
vi.mock("@/db/queries/trust", () => ({ getTrustStats: vi.fn() }))

const { mockIsEnabled, mockMarkNotificationsRead } = vi.hoisted(() => ({
  mockIsEnabled: vi.fn(),
  mockMarkNotificationsRead: vi.fn(),
}))
vi.mock("@/lib/features", () => ({ isEnabled: mockIsEnabled }))
vi.mock("@/db/queries/notifications", () => ({ markNotificationsRead: mockMarkNotificationsRead }))

// Import AFTER mocks are registered.
import { PATCH as PATCH_TASK, DELETE as DELETE_TASK } from "@/app/api/v1/tasks/[id]/route"
import { PATCH as PATCH_READ } from "@/app/api/v1/notifications/read/route"

const jsonReq = (body: unknown) => ({ json: async () => body }) as never
const taskCtx = { params: Promise.resolve({ id: "1" }) } as never
const readCtx = { params: Promise.resolve({}) } as never

const openTask = (creatorId: string) => ({
  id: 1,
  creatorId,
  status: "open",
  onChainTaskId: null,
  rewardXrd: "500",
})

beforeEach(() => {
  vi.clearAllMocks()
  mockUpdateTask.mockResolvedValue(openTask(session.userId))
  mockGetSubmissionCount.mockResolvedValue(0)
  mockIsEnabled.mockReturnValue(true)
  mockMarkNotificationsRead.mockResolvedValue(1)
})

describe("PATCH/DELETE /api/v1/tasks/[id] — one write budget per session user", () => {
  it("allows 10 writes a minute, then 429s with Retry-After before touching the DB", async () => {
    session.userId = "account_rdx1poster"
    mockFindTaskById.mockResolvedValue(openTask(session.userId))

    for (let i = 0; i < 10; i++) {
      const res = await PATCH_TASK(jsonReq({ reward_amount: "50" }), taskCtx)
      expect(res.status).toBe(200)
    }
    const res = await PATCH_TASK(jsonReq({ reward_amount: "50" }), taskCtx)
    expect(res.status).toBe(429)
    expect((await res.json()).error.code).toBe("RATE_LIMITED")
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1)
    expect(mockFindTaskById).toHaveBeenCalledTimes(10)
  })

  it("shares that budget with DELETE, so cancel is not a second, separate lane", async () => {
    // Its own account, spending the budget here — no dependence on the test above.
    session.userId = "account_rdx1canceller"
    mockFindTaskById.mockResolvedValue(openTask(session.userId))
    for (let i = 0; i < 10; i++) {
      expect((await PATCH_TASK(jsonReq({ reward_amount: "50" }), taskCtx)).status).toBe(200)
    }
    mockFindTaskById.mockClear()
    const res = await DELETE_TASK(jsonReq(undefined), taskCtx)
    expect(res.status).toBe(429)
    expect(mockFindTaskById).not.toHaveBeenCalled()
    expect(mockCancelTask).not.toHaveBeenCalled()
  })

  it("keys on the session user — another account is unaffected", async () => {
    session.userId = "account_rdx1other"
    mockFindTaskById.mockResolvedValue(openTask(session.userId))
    const res = await DELETE_TASK(jsonReq(undefined), taskCtx)
    expect(res.status).toBe(200)
    expect(mockCancelTask).toHaveBeenCalledOnce()
  })
})

describe("PATCH /api/v1/notifications/read — per-user budget", () => {
  it("allows 60 a minute (one per dropdown click), then 429s without writing", async () => {
    session.userId = "account_rdx1reader"
    for (let i = 0; i < 60; i++) {
      const res = await PATCH_READ(jsonReq({ ids: [i + 1] }), readCtx)
      expect(res.status).toBe(200)
    }
    const res = await PATCH_READ(jsonReq({ ids: [61] }), readCtx)
    expect(res.status).toBe(429)
    expect((await res.json()).error.code).toBe("RATE_LIMITED")
    expect(mockMarkNotificationsRead).toHaveBeenCalledTimes(60)
  })

  it("still 503s when the flag is off, whatever the budget says", async () => {
    session.userId = "account_rdx1reader"
    mockIsEnabled.mockReturnValue(false)
    const res = await PATCH_READ(jsonReq({}), readCtx)
    expect(res.status).toBe(503)
  })
})
