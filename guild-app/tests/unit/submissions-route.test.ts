/**
 * Builder-gate test for POST /api/v1/tasks/[id]/submissions.
 *
 * Submitting work requires (a) the caller to be the assigned worker when a task
 * is already claimed, and (b) the caller to hold a Guild member badge on-chain.
 * The badge is resolved server-side and fail-closed (loadUserBadge returns null
 * for no badge OR a gateway error) so the client gate can't be bypassed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: "account_rdx1worker" } }),
}))

const { mockFindTaskById, mockUpdateTaskIfStatus } = vi.hoisted(() => ({
  mockFindTaskById: vi.fn(),
  mockUpdateTaskIfStatus: vi.fn(),
}))
vi.mock("@/db/queries/tasks", () => ({
  findTaskById: mockFindTaskById,
  updateTaskIfStatus: mockUpdateTaskIfStatus,
}))

const { mockListSubmissionsByTask, mockCreateSubmission, mockFindLatestSubmissionByTaskAndUser } =
  vi.hoisted(() => ({
    mockListSubmissionsByTask: vi.fn(),
    mockCreateSubmission: vi.fn(),
    mockFindLatestSubmissionByTaskAndUser: vi.fn(),
  }))
vi.mock("@/db/queries/submissions", () => ({
  listSubmissionsByTask: mockListSubmissionsByTask,
  createSubmission: mockCreateSubmission,
  findLatestSubmissionByTaskAndUser: mockFindLatestSubmissionByTaskAndUser,
}))

const { mockLoadUserBadge } = vi.hoisted(() => ({ mockLoadUserBadge: vi.fn() }))
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

// Pin both badge resources so the agent-badge fallback path is ACTIVE in this
// file (in prod it is dormant until NEXT_PUBLIC_AGENT_BADGE_NFT is set).
const MEMBER_BADGE = "resource_rdx1memberbadge"
const AGENT_BADGE = "resource_rdx1agentbadge"
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  BADGE_NFT: "resource_rdx1memberbadge",
  AGENT_BADGE_NFT: "resource_rdx1agentbadge",
}))

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => () => ({ ok: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}))

// Import AFTER mocks are registered.
import { POST } from "@/app/api/v1/tasks/[id]/submissions/route"

const makeReq = (body: unknown) => ({ json: async () => body }) as never
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never

describe("POST /api/v1/tasks/[id]/submissions — builder gate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindTaskById.mockResolvedValue({
      id: 1,
      creatorId: "account_rdx1poster",
      assigneeId: null,
      status: "open",
    })
    mockLoadUserBadge.mockResolvedValue({ id: "#1#", tier: "member", status: "active" })
    mockCreateSubmission.mockResolvedValue({ id: 7, taskId: 1, submitterId: "account_rdx1worker" })
    mockUpdateTaskIfStatus.mockResolvedValue({ id: 1, status: "submitted" })
    mockFindLatestSubmissionByTaskAndUser.mockResolvedValue(null)
  })

  it("rejects a submitter with no Guild badge (403, fail-closed)", async () => {
    mockLoadUserBadge.mockResolvedValue(null) // no badge OR gateway error

    const res = await POST(makeReq({ content: "my work" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json.error.code).toBe("NO_BADGE")
    expect(mockCreateSubmission).not.toHaveBeenCalled()
  })

  it("rejects a non-assignee when the task is assigned to someone else (403)", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1,
      creatorId: "account_rdx1poster",
      assigneeId: "account_rdx1other",
      status: "assigned",
    })

    const res = await POST(makeReq({ content: "my work" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json.error.code).toBe("NOT_ASSIGNEE")
    expect(mockLoadUserBadge).not.toHaveBeenCalled() // cheap check short-circuits before the gateway call
    expect(mockCreateSubmission).not.toHaveBeenCalled()
  })

  it("accepts a badged worker assigned to the task and creates the submission", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1,
      creatorId: "account_rdx1poster",
      assigneeId: "account_rdx1worker",
      status: "assigned",
    })

    const res = await POST(makeReq({ content: "my work" }), ctx("1"))

    expect(res.status).toBe(201)
    expect(mockCreateSubmission).toHaveBeenCalledWith({
      taskId: 1,
      submitterId: "account_rdx1worker",
      content: "my work",
    })
  })

  it("accepts a badged worker on an open (unassigned) task", async () => {
    const res = await POST(makeReq({ content: "my work" }), ctx("1"))

    expect(res.status).toBe(201)
    expect(mockCreateSubmission).toHaveBeenCalled()
  })

  // ── Agent-badge fallback (P4): an agent badge is builder-equivalent ────────

  it("accepts an agent-badged caller with no member badge", async () => {
    mockLoadUserBadge.mockImplementation((_addr: string, resource: string) =>
      Promise.resolve(resource === AGENT_BADGE ? { id: "#9#", status: "active" } : null),
    )

    const res = await POST(makeReq({ content: "agent work" }), ctx("1"))

    expect(res.status).toBe(201)
    expect(mockLoadUserBadge).toHaveBeenCalledWith("account_rdx1worker", MEMBER_BADGE)
    expect(mockLoadUserBadge).toHaveBeenCalledWith("account_rdx1worker", AGENT_BADGE)
    expect(mockCreateSubmission).toHaveBeenCalled()
  })

  it("does not look up the agent badge when the member badge already passes", async () => {
    const res = await POST(makeReq({ content: "my work" }), ctx("1"))

    expect(res.status).toBe(201)
    expect(mockLoadUserBadge).toHaveBeenCalledTimes(1)
    expect(mockLoadUserBadge).toHaveBeenCalledWith("account_rdx1worker", MEMBER_BADGE)
  })

  it("still fails closed when BOTH badge lookups return null", async () => {
    mockLoadUserBadge.mockResolvedValue(null)

    const res = await POST(makeReq({ content: "my work" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json.error.code).toBe("NO_BADGE")
    expect(mockLoadUserBadge).toHaveBeenCalledTimes(2) // both resources tried
    expect(mockCreateSubmission).not.toHaveBeenCalled()
  })

  // ── Escrow-live status guard (smoke finding 2) ─────────────────────────────
  // While escrow is live for a task (onChainTaskId set), the DB status is
  // mirrored from verified chain events ONLY — posting the submission content
  // must never flip it (that stranded a task at `submitted` with the on-chain
  // state still Claimed during the mainnet smoke).

  it("does NOT touch status when the task is escrow-funded (onChainTaskId set)", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1,
      creatorId: "account_rdx1poster",
      assigneeId: "account_rdx1worker",
      status: "assigned",
      onChainTaskId: 7,
    })

    const res = await POST(makeReq({ content: "my work" }), ctx("1"))

    expect(res.status).toBe(201)
    expect(mockCreateSubmission).toHaveBeenCalled()
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
  })

  it("still flips an off-chain task (no onChainTaskId) to submitted — compare-and-swap on open/assigned", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1,
      creatorId: "account_rdx1poster",
      assigneeId: "account_rdx1worker",
      status: "assigned",
      onChainTaskId: null,
    })

    const res = await POST(makeReq({ content: "my work" }), ctx("1"))

    expect(res.status).toBe(201)
    expect(mockUpdateTaskIfStatus).toHaveBeenCalledWith(1, { status: "submitted" }, ["open", "assigned"])
  })

  // ── Revision resubmission (R3-a): `submitted` accepts exactly one more case ─

  it("accepts a resubmission while the caller's latest attempt is revision_requested", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1,
      creatorId: "account_rdx1poster",
      assigneeId: "account_rdx1worker",
      status: "submitted",
      onChainTaskId: null,
    })
    mockFindLatestSubmissionByTaskAndUser.mockResolvedValue({
      id: 7,
      taskId: 1,
      submitterId: "account_rdx1worker",
      status: "revision_requested",
    })

    const res = await POST(makeReq({ content: "my work v2" }), ctx("1"))

    expect(res.status).toBe(201)
    // A NEW row per attempt — the decision audit trail.
    expect(mockCreateSubmission).toHaveBeenCalledWith({
      taskId: 1,
      submitterId: "account_rdx1worker",
      content: "my work v2",
    })
    // The off-chain flip has nothing to do (task already `submitted`): the
    // CAS predicate ["open","assigned"] wouldn't match — and the route's own
    // status condition never calls it.
    expect(mockUpdateTaskIfStatus).not.toHaveBeenCalled()
  })

  it("still blocks a submitted task when the latest attempt is NOT revision_requested", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1,
      creatorId: "account_rdx1poster",
      assigneeId: "account_rdx1worker",
      status: "submitted",
      onChainTaskId: null,
    })
    mockFindLatestSubmissionByTaskAndUser.mockResolvedValue({
      id: 7,
      taskId: 1,
      submitterId: "account_rdx1worker",
      status: "pending", // awaiting review — no resubmit lane
    })

    const res = await POST(makeReq({ content: "my work v2" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error.code).toBe("INVALID_STATUS")
    expect(mockCreateSubmission).not.toHaveBeenCalled()
  })

  it("blocks a resubmission from anyone but the assignee on an assigned-then-submitted task", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1,
      creatorId: "account_rdx1poster",
      assigneeId: "account_rdx1other", // someone else's task
      status: "submitted",
      onChainTaskId: null,
    })

    const res = await POST(makeReq({ content: "hijack attempt" }), ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error.code).toBe("INVALID_STATUS")
    // Ownership short-circuits before the latest-submission lookup.
    expect(mockFindLatestSubmissionByTaskAndUser).not.toHaveBeenCalled()
    expect(mockCreateSubmission).not.toHaveBeenCalled()
  })

  // ── Agent-lane kill switch (AGENT_LANE_LIVE — 2026-07-31 triage) ───────────
  // The work-record write is the lane's entry into review/payout, so it is
  // gated server-side. Agents and humans share auth by design (decision #2),
  // so OFF pauses submission for all callers — a narrower "agents only" gate
  // would be fake (no server-side discriminator exists). Default (env unset)
  // = LIVE: every other test in this file runs unstubbed and proves it.
  describe("agent-lane kill switch", () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it("503s with AGENT_LANE_OFF when AGENT_LANE_LIVE=false — before badge or DB work", async () => {
      vi.stubEnv("AGENT_LANE_LIVE", "false")

      const res = await POST(makeReq({ content: "my work" }), ctx("1"))
      const json = await res.json()

      expect(res.status).toBe(503)
      expect(json.error.code).toBe("AGENT_LANE_OFF")
      // The gate is the FIRST check: no task load, no gateway badge lookup,
      // no write happens while the lane is off.
      expect(mockFindTaskById).not.toHaveBeenCalled()
      expect(mockLoadUserBadge).not.toHaveBeenCalled()
      expect(mockCreateSubmission).not.toHaveBeenCalled()
    })

    it("stays live for any value but the literal \"false\" (\"0\" does not disarm)", async () => {
      vi.stubEnv("AGENT_LANE_LIVE", "0")

      const res = await POST(makeReq({ content: "my work" }), ctx("1"))

      expect(res.status).toBe(201)
      expect(mockCreateSubmission).toHaveBeenCalled()
    })

    it("explicit AGENT_LANE_LIVE=true behaves exactly like the default", async () => {
      vi.stubEnv("AGENT_LANE_LIVE", "true")

      const res = await POST(makeReq({ content: "my work" }), ctx("1"))

      expect(res.status).toBe(201)
      expect(mockCreateSubmission).toHaveBeenCalled()
    })
  })
})
