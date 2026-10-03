/**
 * Gating test for the off-chain submission review (PATCH /api/v1/submissions/[id]/review).
 *
 * The on-chain approve_and_release tx + the escrow-confirm route are the ONLY
 * path that moves money and advances a task to a terminal state. Review
 * records the submission decision only — it must never write the escrow
 * ledger or change task status (else it double-pays / fabricates a `confirmed`
 * ledger row with no real tx). The legacy escrow-off branch (off-chain release
 * + status flips) was removed 2026-06-10 along with the releaseEscrow/
 * refundEscrow fabricators; these tests pin that it stays gone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// The halt gate (P1 write side) now runs first in every task-lifecycle write, and it reads
// the live Gateway. Pin an advancing chain so this suite stays offline and deterministic —
// without it these tests reach mainnet and correctly 503 during the real halt. The gate's
// own behaviour is pinned in tests/unit/chain-halt-gate.test.ts; keeping the REAL gate in
// the path here (rather than stubbing the module) means these routes still execute it.
vi.mock("@/lib/gateway", () => ({
  NETWORK_HALT_AFTER_SECONDS: 900,
  operatorHaltEngaged: () => false,
  readLedgerTip: async () => ({
    stateVersion: 600_000_000,
    tipIso: "2026-09-08T09:00:00Z",
    ageSeconds: 12,
    stale: false,
  }),
}))

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
}))

const { mockFindSubmissionById, mockReviewSubmission } = vi.hoisted(() => ({
  mockFindSubmissionById: vi.fn(),
  mockReviewSubmission: vi.fn(),
}))
vi.mock("@/db/queries/submissions", () => ({
  findSubmissionById: mockFindSubmissionById,
  reviewSubmission: mockReviewSubmission,
}))

// The route must not touch the escrow ledger at all; if a release-on-approve
// path is ever reintroduced, this spy catches the call.
const { mockRecordConfirmedEscrowTx } = vi.hoisted(() => ({
  mockRecordConfirmedEscrowTx: vi.fn(),
}))
vi.mock("@/db/queries/escrow", () => ({
  recordConfirmedEscrowTx: mockRecordConfirmedEscrowTx,
  findEscrowByTask: vi.fn(),
}))

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => () => ({ ok: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}))

// Import AFTER mocks are registered.
import { PATCH } from "@/app/api/v1/submissions/[id]/review/route"

const makeReq = (body: unknown) => ({ json: async () => body }) as never
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never

describe("PATCH /api/v1/submissions/[id]/review — decision only, no money path", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindSubmissionById.mockResolvedValue({
      id: 5,
      taskId: 1,
      submitterId: "account_rdx1worker",
      status: "pending",
    })
    mockFindTaskById.mockResolvedValue({
      id: 1,
      creatorId: "account_rdx1poster",
      status: "submitted",
    })
    mockReviewSubmission.mockResolvedValue({ ok: true, submission: { id: 5, status: "approved" } })
  })

  it("approval records the decision but does NOT write the ledger or change task status", async () => {
    const res = await PATCH(makeReq({ status: "approved" }), ctx("5"))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    // Decision recorded via the guarded transactional write (submission id,
    // the owning task id for the in-tx status re-check, reviewer, decision).
    expect(mockReviewSubmission).toHaveBeenCalledWith(5, 1, "account_rdx1poster", {
      status: "approved",
      reviewNote: undefined,
      declineReason: undefined,
    })
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled() // money path is on-chain only
    expect(mockUpdateTask).not.toHaveBeenCalled() // status driven by the confirm route
  })

  it("rejection records the decision (structured reason passthrough) and leaves the task untouched", async () => {
    mockReviewSubmission.mockResolvedValue({ ok: true, submission: { id: 5, status: "rejected" } })

    const res = await PATCH(
      makeReq({ status: "rejected", decline_reason: "incomplete_delivery" }),
      ctx("5"),
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(mockReviewSubmission).toHaveBeenCalledWith(5, 1, "account_rdx1poster", {
      status: "rejected",
      reviewNote: undefined,
      declineReason: "incomplete_delivery",
    })
    expect(mockRecordConfirmedEscrowTx).not.toHaveBeenCalled()
    expect(mockUpdateTask).not.toHaveBeenCalled()
  })

  it("409s ALREADY_REVIEWED when the row already carries a decision (one decision per row)", async () => {
    mockReviewSubmission.mockResolvedValue({ ok: false, code: "ALREADY_REVIEWED" })

    const res = await PATCH(makeReq({ status: "approved" }), ctx("5"))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error.code).toBe("ALREADY_REVIEWED")
  })

  it("409s when the task left 'submitted' between the snapshot and the guarded write", async () => {
    mockReviewSubmission.mockResolvedValue({ ok: false, code: "TASK_NOT_SUBMITTED", taskStatus: "disputed" })

    const res = await PATCH(makeReq({ status: "approved" }), ctx("5"))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error.code).toBe("INVALID_STATUS")
    expect(json.error.message).toContain("disputed")
  })
})
