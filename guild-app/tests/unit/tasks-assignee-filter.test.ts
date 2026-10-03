/**
 * Route-wiring tests for the `assignee` filter on GET /api/v1/tasks (R1 bot
 * unification: the profile page and the TG bot read tasks-by-assignee through
 * this param instead of the retired bot /contributors surface).
 *
 * Mocks the query layer to pin the param → filter mapping; the where-clause
 * behaviour of listTasks itself is covered in db-queries.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: "account_rdx1poster" } }),
  // GET reads this directly (unauthenticated route, optional session) to
  // decide includeHiddenStale — see tasks-creator-filter.test.ts for that
  // behaviour. No session here; these tests are about the assignee param
  // wiring, not the hidden-stale gate.
  getSessionUser: vi.fn().mockResolvedValue(null),
}))

const { mockListTasks } = vi.hoisted(() => ({
  mockListTasks: vi.fn(),
}))
vi.mock("@/db/queries/tasks", () => ({
  listTasks: mockListTasks,
  createTask: vi.fn(),
}))

vi.mock("@/db/queries/projects", () => ({
  findProjectById: vi.fn(),
}))

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => () => ({ ok: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}))

// Import AFTER mocks are registered.
import { GET } from "@/app/api/v1/tasks/route"

const makeReq = (query = "") =>
  ({ url: `http://localhost/api/v1/tasks${query}` }) as never

describe("GET /api/v1/tasks — assignee filter", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListTasks.mockResolvedValue({ data: [], cursor: null, hasMore: false })
  })

  it("passes the assignee param to the query layer as assigneeId", async () => {
    const res = await GET(makeReq("?assignee=account_rdx1worker"))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(mockListTasks).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeId: "account_rdx1worker" }),
    )
  })

  it("omits assigneeId when the param is absent", async () => {
    await GET(makeReq())

    expect(mockListTasks).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeId: undefined }),
    )
  })

  it("combines with the status filter and keeps the paginated envelope", async () => {
    // description + creatorId included: real task rows always carry both
    // (NOT NULL columns), and the route now runs every row through the
    // public-text gate (src/lib/public-task-text.ts) before responding — an
    // ordinary description has nothing for it to scrub, so the row still
    // round-trips unchanged, but the fields must be present to exercise the
    // real code path this test is pinning (see tasks-creator-filter.test.ts
    // for the gate's own ownership-scrubbing behaviour).
    const rows = [
      {
        id: 7,
        title: "Port the widget",
        description: "Ship the widget port to prod.",
        status: "paid",
        creatorId: "account_rdx1poster",
      },
    ]
    mockListTasks.mockResolvedValue({ data: rows, cursor: null, hasMore: false })

    const res = await GET(makeReq("?assignee=account_rdx1worker&status=paid"))
    const json = await res.json()

    expect(mockListTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        assigneeId: "account_rdx1worker",
        status: "paid",
      }),
    )
    // `ownerView: false` — this file's getSessionUser mock is anonymous, so
    // the route reports the public view (see tasks-creator-filter.test.ts's
    // ownerView block for the full matrix).
    expect(json).toEqual({ ok: true, data: rows, cursor: null, hasMore: false, ownerView: false })
  })
})
