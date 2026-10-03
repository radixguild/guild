/**
 * P3-24 (task 91, 2026-09-15): POST /api/v1/tasks refuses to create a task
 * whose title/description the public-text scrub (src/lib/public-task-text.ts)
 * would rewrite — the posting-time half of the fix for task 90's on-chain
 * `submit_task` revert ("brief_hash does not match the task's committed
 * work_brief_hash"). A task whose text the scrub touches could be claimed
 * (the open board scrubs it for every not-yet-party claim candidate) but its
 * eventual assignee's committed hash can never match what the scrubbed text
 * would rehash to — so refusing it here, before a single DB row exists, is
 * cheaper and more honest than letting it ship and fail on-chain later.
 *
 * Follows the same real-route-handler mocking shape as
 * tasks-route-halt-gate.test.ts: mock only the halt gate, rate limiter, and
 * DB writer — createTaskSchema, chainWriteGate's real "advancing" behaviour,
 * and (the point of this file) scrubWouldChange all run for real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: "account_rdx1poster" } }),
  getSessionUser: vi.fn(),
}))

const { mockOperatorHalt, mockReadLedgerTip, mockCreateTask } = vi.hoisted(() => ({
  mockOperatorHalt: vi.fn(),
  mockReadLedgerTip: vi.fn(),
  mockCreateTask: vi.fn(),
}))

vi.mock("@/lib/gateway", () => ({
  NETWORK_HALT_AFTER_SECONDS: 900,
  operatorHaltEngaged: mockOperatorHalt,
  readLedgerTip: mockReadLedgerTip,
}))

vi.mock("@/db/queries/tasks", () => ({ createTask: mockCreateTask, listTasks: vi.fn() }))
vi.mock("@/db/queries/projects", () => ({ findProjectById: vi.fn() }))
vi.mock("@/db/queries/working-groups", () => ({ findRoutableWorkingGroupById: vi.fn() }))
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => () => ({ ok: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}))

import { POST } from "@/app/api/v1/tasks/route"

const ADVANCING = { stateVersion: 600_000_000, tipIso: "2026-09-15T09:00:00Z", ageSeconds: 12, stale: false }

const post = (body: unknown) => ({ json: async () => body }) as never

beforeEach(() => {
  mockOperatorHalt.mockReset().mockReturnValue(false)
  mockReadLedgerTip.mockReset().mockResolvedValue(ADVANCING)
  mockCreateTask.mockReset().mockResolvedValue({ id: 1 })
})

describe("POST /api/v1/tasks — refuses scrub-unstable text (P3-24)", () => {
  it("400s SCRUB_UNSTABLE_TEXT on a description the scrub would rewrite, and never calls createTask", async () => {
    const res = await POST(
      post({
        title: "Write the provisioning runbook",
        description: "Verified it manually (via ssh guild-vps read-only). Budget: 30 XRD.",
        reward_amount: "30",
      }),
      {} as never,
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("SCRUB_UNSTABLE_TEXT")
    expect(body.error.message).toContain("description")
    expect(mockCreateTask).not.toHaveBeenCalled()
  })

  it("400s SCRUB_UNSTABLE_TEXT on a title the scrub would rewrite", async () => {
    const res = await POST(
      post({
        title: "ssh into guild-vps to fix it",
        description: "Ordinary description with nothing to scrub, long enough to be real.",
        reward_amount: "30",
      }),
      {} as never,
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("SCRUB_UNSTABLE_TEXT")
    expect(mockCreateTask).not.toHaveBeenCalled()
  })

  it("creates the task normally when the text has nothing the scrub would touch", async () => {
    const res = await POST(
      post({
        title: "Design the escrow claim UI",
        description: "Add a countdown chip and a claim button to the task detail page.",
        reward_amount: "30",
      }),
      {} as never,
    )

    expect(res.status).toBe(201)
    expect(mockCreateTask).toHaveBeenCalledTimes(1)
  })

  it("runs the scrub check BEFORE the project/working-group lookups — a bad text 400s even with an unresolvable project_id", async () => {
    const findProjectById = (await import("@/db/queries/projects")).findProjectById as ReturnType<typeof vi.fn>
    findProjectById.mockResolvedValue(null) // would itself 404 if the scrub check didn't run first

    const res = await POST(
      post({
        title: "ssh guild-vps 'reboot'",
        description: "Ordinary description, long enough to be real and unaffected by the scrub.",
        reward_amount: "30",
        project_id: 999_999,
      }),
      {} as never,
    )

    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("SCRUB_UNSTABLE_TEXT")
    expect(findProjectById).not.toHaveBeenCalled()
  })
})
