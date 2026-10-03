/**
 * The reward floor, at the two routes that can WRITE a reward — proven at the
 * route, not just the schema, because the defect was a DB row, not a parse.
 *
 * The live escrow registered XRD with min_amount 1 and `create_task` asserts
 * `reward_amount >= min_amount` ("reward below per-token minimum"). Until
 * 2026-09-17 a reward in (0, 1) XRD — "0.5" — passed the create form, passed
 * POST /api/v1/tasks, and became a task row whose funding tx could only revert:
 * a poster stranded with a task nobody can ever fund. The form half is pinned
 * in create-task-blockers.test.ts; this file is the half a direct API caller
 * or the agent client reaches.
 *
 * TWO routes, because a floor on create alone has a side door: PATCH
 * /api/v1/tasks/[id] edits the reward of an UNFUNDED open task — exactly the
 * row a sub-minimum edit would strand (post at "1", PATCH to "0.5").
 *
 * What is asserted is the absence of the WRITE (`createTask` / `updateTask`
 * never called), not only the status code: a 400 that arrives after the row
 * exists would still be the defect.
 *
 * FALSIFIABLE, separately per route: remove the `.refine(...)` from
 * validation.ts's rewardAmountSchema and every "refuses" case here goes red
 * (201/200, write called); point only updateTaskSchema back at a bare regex
 * and only the PATCH block does. Both mutations were run when this was
 * written — see the PR.
 *
 * What this does NOT prove: that 1 is the number the chain enforces
 * (escrow-address-drift.test.ts ties the constant to the registry; nothing in
 * CI reads the ledger), or anything about non-XRD rewards — no route accepts a
 * reward token today, so there is no such request to send.
 *
 * Same real-route-handler mocking shape as tasks-route-scrub-unstable.test.ts
 * and tasks-id-route.test.ts: auth, halt gate, rate limiter and DB are mocked;
 * createTaskSchema / updateTaskSchema run for real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { MIN_REWARD_XRD } from "@/lib/marketplace"

vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: "account_rdx1poster" } }),
  getSessionUser: vi.fn(),
}))

const { mockOperatorHalt, mockReadLedgerTip, mockCreateTask, mockFindTaskById, mockUpdateTask } = vi.hoisted(() => ({
  mockOperatorHalt: vi.fn(),
  mockReadLedgerTip: vi.fn(),
  mockCreateTask: vi.fn(),
  mockFindTaskById: vi.fn(),
  mockUpdateTask: vi.fn(),
}))

vi.mock("@/lib/gateway", () => ({
  NETWORK_HALT_AFTER_SECONDS: 900,
  operatorHaltEngaged: mockOperatorHalt,
  readLedgerTip: mockReadLedgerTip,
}))
vi.mock("@/db/queries/tasks", () => ({
  createTask: mockCreateTask,
  listTasks: vi.fn(),
  findTaskById: mockFindTaskById,
  updateTask: mockUpdateTask,
  cancelTask: vi.fn(),
  getSubmissionCount: vi.fn(),
}))
vi.mock("@/db/queries/projects", () => ({ findProjectById: vi.fn() }))
vi.mock("@/db/queries/working-groups", () => ({ findRoutableWorkingGroupById: vi.fn() }))
vi.mock("@/db/queries/trust", () => ({ getTrustStats: vi.fn() }))
vi.mock("@/db/queries/poster-cancel-stats", () => ({ getPosterCancelStats: vi.fn() }))
vi.mock("@/db/queries/escrow", () => ({ findSettlementHistoryForTask: vi.fn() }))
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => () => ({ ok: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}))

// Import AFTER mocks are registered.
import { POST } from "@/app/api/v1/tasks/route"
import { PATCH } from "@/app/api/v1/tasks/[id]/route"

const ADVANCING = { stateVersion: 600_000_000, tipIso: "2026-09-17T08:00:00Z", ageSeconds: 12, stale: false }
const req = (body: unknown) => ({ json: async () => body }) as never
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never

const TASK = { title: "Write the provisioning runbook", description: "Document the steps end to end." }
const UNFUNDED_OPEN = { id: 1, creatorId: "account_rdx1poster", status: "open", onChainTaskId: null, rewardXrd: "500" }

/** Positive, well-formed, and below the escrow minimum: the stranded-row band. */
const UNFUNDABLE = [["0.5"], ["0.99999999"], ["0.00000001"]]

beforeEach(() => {
  mockOperatorHalt.mockReset().mockReturnValue(false)
  mockReadLedgerTip.mockReset().mockResolvedValue(ADVANCING)
  mockCreateTask.mockReset().mockImplementation(async (data: { rewardXrd: string }) => ({ id: 1, ...data }))
  mockFindTaskById.mockReset().mockResolvedValue(UNFUNDED_OPEN)
  mockUpdateTask.mockReset().mockImplementation(async (_id: number, data: object) => ({ ...UNFUNDED_OPEN, ...data }))
})

describe("POST /api/v1/tasks — refuses a reward the escrow cannot fund", () => {
  it.each(UNFUNDABLE)("400s VALIDATION_ERROR on reward_amount %s, naming the minimum, and creates NO row", async (reward) => {
    const res = await POST(req({ ...TASK, reward_amount: reward }), {} as never)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe("VALIDATION_ERROR")
    expect(body.error.message).toContain(`at least ${MIN_REWARD_XRD} XRD`)
    expect(mockCreateTask).not.toHaveBeenCalled()
  })

  it("the floor is inclusive: exactly MIN_REWARD_XRD is created, with that reward", async () => {
    const res = await POST(req({ ...TASK, reward_amount: MIN_REWARD_XRD }), {} as never)

    expect(res.status).toBe(201)
    expect(mockCreateTask).toHaveBeenCalledOnce()
    expect(mockCreateTask.mock.calls[0][0].rewardXrd).toBe(MIN_REWARD_XRD)
  })

  // Deliberate — see validation.ts rewardAmountSchema. "0" is the unfunded
  // off-chain lane (never sent to create_task; exempt by decision F3), so it is
  // not a row stranded at funding. Pinned so that closing it is a decision
  // someone makes, not a side effect of tightening the floor.
  it("still creates a zero-reward (unfunded off-chain lane) task", async () => {
    const res = await POST(req({ ...TASK, reward_amount: "0" }), {} as never)

    expect(res.status).toBe(201)
    expect(mockCreateTask).toHaveBeenCalledOnce()
  })
})

describe("PATCH /api/v1/tasks/[id] — the same floor, so an edit cannot strand an unfunded task", () => {
  it.each(UNFUNDABLE)("400s VALIDATION_ERROR on reward_amount %s, naming the minimum, and writes NOTHING", async (reward) => {
    const res = await PATCH(req({ reward_amount: reward }), ctx("1"))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("VALIDATION_ERROR")
    expect(body.error.message).toContain(`at least ${MIN_REWARD_XRD} XRD`)
    expect(mockUpdateTask).not.toHaveBeenCalled()
  })

  it("the floor is inclusive: an edit to exactly MIN_REWARD_XRD is written", async () => {
    const res = await PATCH(req({ reward_amount: MIN_REWARD_XRD }), ctx("1"))

    expect(res.status).toBe(200)
    expect(mockUpdateTask).toHaveBeenCalledOnce()
    expect(mockUpdateTask.mock.calls[0][1]).toEqual({ rewardXrd: MIN_REWARD_XRD })
  })

  it("an edit that does not touch the reward is unaffected", async () => {
    const res = await PATCH(req({ title: "A better title" }), ctx("1"))

    expect(res.status).toBe(200)
    expect(mockUpdateTask).toHaveBeenCalledOnce()
  })
})
