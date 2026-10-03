/**
 * The halt gate exercised through a real route handler, not in isolation.
 *
 * `chain-halt-gate.test.ts` proves the gate decides correctly and that the right routes
 * contain the call. Neither proves the call actually RUNS before the work — a gate placed
 * after `createTask()` would pass both of those and still create the unfundable task this
 * whole change exists to prevent. So this drives POST /api/v1/tasks end-to-end.
 *
 * Mutation coverage: the halted case fails if the gate is removed or moved below the DB
 * write (createTask would be called); the advancing case fails if the gate is made
 * unconditional (every post 503s, which would be worse than no gate at all).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: "account_rdx1poster" } }),
  getSessionUser: vi.fn(),
}))

const { mockOperatorHalt, mockReadLedgerTip, mockCreateTask, mockListTasks } = vi.hoisted(() => ({
  mockOperatorHalt: vi.fn(),
  mockReadLedgerTip: vi.fn(),
  mockCreateTask: vi.fn(),
  mockListTasks: vi.fn(),
}))

vi.mock("@/lib/gateway", () => ({
  NETWORK_HALT_AFTER_SECONDS: 900,
  operatorHaltEngaged: mockOperatorHalt,
  readLedgerTip: mockReadLedgerTip,
}))

vi.mock("@/db/queries/tasks", () => ({ createTask: mockCreateTask, listTasks: mockListTasks }))

import { POST } from "@/app/api/v1/tasks/route"

const HALTED = { stateVersion: 557_840_622, tipIso: "2026-08-31T21:19:06Z", ageSeconds: 646_000, stale: false }
const ADVANCING = { stateVersion: 600_000_000, tipIso: "2026-09-08T09:00:00Z", ageSeconds: 12, stale: false }

const post = () =>
  ({ json: async () => ({ title: "A task nobody could fund", reward_xrd: 100 }) }) as never

beforeEach(() => {
  mockOperatorHalt.mockReset().mockReturnValue(false)
  mockReadLedgerTip.mockReset()
  mockCreateTask.mockReset()
})

describe("POST /api/v1/tasks under a halt", () => {
  it("refuses with 503 CHAIN_HALTED and never touches the database", async () => {
    mockReadLedgerTip.mockResolvedValue(HALTED)

    const res = await POST(post(), {} as never)

    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe("CHAIN_HALTED")
    // The point of the gate: no row is written that could never be funded on-chain.
    expect(mockCreateTask).not.toHaveBeenCalled()
  })

  it("does not block while the chain is advancing", async () => {
    mockReadLedgerTip.mockResolvedValue(ADVANCING)

    const res = await POST(post(), {} as never)

    // Whatever this request's fate is downstream (validation, rate limit, DB), it is not
    // the halt gate's doing — an unconditional gate would 503 here.
    expect(res.status).not.toBe(503)
  })
})
