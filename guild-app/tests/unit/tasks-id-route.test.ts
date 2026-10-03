/**
 * Funded-task guard for PATCH /api/v1/tasks/[id] (assessment H2).
 *
 * A task funded on-chain (onChainTaskId set) holds real escrow funds, and its
 * committed brief is bound to an on-chain work-brief hash. Editing its
 * reward/terms off-chain would desync the DB from the chain and drive a wrong
 * payout manifest (the release TAKE_FROM_WORKTOP reads the DB reward). A funded
 * task stays status='open' until claimed, so the existing status check does NOT
 * cover this — PATCH must additionally refuse once funded, mirroring DELETE's
 * `onChainTaskId != null` guard.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: "account_rdx1poster" } }),
}))

const { mockFindTaskById, mockUpdateTask } = vi.hoisted(() => ({
  mockFindTaskById: vi.fn(),
  mockUpdateTask: vi.fn(),
}))
vi.mock("@/db/queries/tasks", () => ({
  findTaskById: mockFindTaskById,
  updateTask: mockUpdateTask,
  cancelTask: vi.fn(),
  getSubmissionCount: vi.fn(),
}))
vi.mock("@/db/queries/projects", () => ({ findProjectById: vi.fn() }))
vi.mock("@/db/queries/trust", () => ({ getTrustStats: vi.fn() }))

// Import AFTER mocks are registered.
import { PATCH } from "@/app/api/v1/tasks/[id]/route"

const makeReq = (body: unknown) => ({ json: async () => body }) as never
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never

const baseTask = {
  id: 1,
  creatorId: "account_rdx1poster",
  status: "open",
  onChainTaskId: null,
  rewardXrd: "500",
}

describe("PATCH /api/v1/tasks/[id] — funded-task guard (H2)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateTask.mockResolvedValue({ ...baseTask, rewardXrd: "50" })
  })

  it("blocks editing a funded-but-open task (onChainTaskId set) — 409, no DB write", async () => {
    mockFindTaskById.mockResolvedValue({ ...baseTask, onChainTaskId: 7 })
    const res = await PATCH(makeReq({ reward_amount: "50" }), ctx("1"))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe("ON_CHAIN_ESCROW")
    expect(mockUpdateTask).not.toHaveBeenCalled()
  })

  it("still allows editing an unfunded open task — 200, write happens", async () => {
    mockFindTaskById.mockResolvedValue({ ...baseTask, onChainTaskId: null })
    const res = await PATCH(makeReq({ reward_amount: "50" }), ctx("1"))
    expect(res.status).toBe(200)
    expect(mockUpdateTask).toHaveBeenCalledOnce()
  })

  it("rejects a non-creator — 403, no write", async () => {
    mockFindTaskById.mockResolvedValue({ ...baseTask, creatorId: "account_rdx1other" })
    const res = await PATCH(makeReq({ reward_amount: "50" }), ctx("1"))
    expect(res.status).toBe(403)
    expect(mockUpdateTask).not.toHaveBeenCalled()
  })

  it("rejects an already-claimed task via the status check — 400, no write", async () => {
    mockFindTaskById.mockResolvedValue({ ...baseTask, status: "claimed", onChainTaskId: 7 })
    const res = await PATCH(makeReq({ reward_amount: "50" }), ctx("1"))
    expect(res.status).toBe(400)
    expect(mockUpdateTask).not.toHaveBeenCalled()
  })
})
