/**
 * Route-level regression test for the 2026-08-26 adversarial screen on
 * PR #459 (DEFECT 2, HIGH): GET /api/v1/tasks is unauthenticated, and its
 * `?creator=`/`?assignee=` filters used to bypass the notHiddenStale keep
 * filter for ANY value — so any anonymous visitor could read another
 * poster's soft-hidden, stale/abandoned rows via `?creator=<their address>`
 * (guild-app/src/app/profile/[address]/page.tsx is the first caller that
 * exposed this, but the bug was always reachable directly against the API).
 * Those rows can hold real, still-locked escrow (prune-unfunded.ts's
 * SOFT-HIDE ruling) — this is a privacy/money-state leak, not cosmetic.
 *
 * The fix moves the decision to the route: `includeHiddenStale` is passed to
 * listTasks ONLY when a verified session's userId matches the requested
 * creator/assignee. This file pins that the ROUTE computes the flag
 * correctly from session vs. query-param identity; db-queries.test.ts pins
 * that listTasks actually honours the flag in its WHERE clause.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockGetSessionUser } = vi.hoisted(() => ({
  mockGetSessionUser: vi.fn(),
}))
vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: "account_rdx1poster" } }),
  getSessionUser: mockGetSessionUser,
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

describe("GET /api/v1/tasks — includeHiddenStale gate (PR #459 screen, defect 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListTasks.mockResolvedValue({ data: [], cursor: null, hasMore: false })
  })

  it("an unauthenticated caller querying ?creator=<anyone> does NOT get includeHiddenStale", async () => {
    mockGetSessionUser.mockResolvedValue(null)

    await GET(makeReq("?creator=account_rdx1poster"))

    expect(mockListTasks).toHaveBeenCalledWith(
      expect.objectContaining({ creatorId: "account_rdx1poster", includeHiddenStale: undefined }),
    )
  })

  it("a caller signed in as a DIFFERENT address querying ?creator=<victim> does NOT get includeHiddenStale", async () => {
    // The attack this defect enabled: any logged-in (or logged-out) visitor
    // browsing someone ELSE's profile could read that poster's hidden rows.
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1attacker" })

    await GET(makeReq("?creator=account_rdx1victim"))

    expect(mockListTasks).toHaveBeenCalledWith(
      expect.objectContaining({ creatorId: "account_rdx1victim", includeHiddenStale: undefined }),
    )
  })

  it("a caller whose verified session matches ?creator= DOES get includeHiddenStale", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1poster" })

    await GET(makeReq("?creator=account_rdx1poster"))

    expect(mockListTasks).toHaveBeenCalledWith(
      expect.objectContaining({ creatorId: "account_rdx1poster", includeHiddenStale: true }),
    )
  })

  it("a caller whose verified session matches ?assignee= DOES get includeHiddenStale", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1worker" })

    await GET(makeReq("?assignee=account_rdx1worker"))

    expect(mockListTasks).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeId: "account_rdx1worker", includeHiddenStale: true }),
    )
  })

  it("session identity matching creator does NOT leak into an unrelated assignee-scoped request", async () => {
    // Same person, but the query asks about someone else's assignee slot —
    // must not accidentally inherit includeHiddenStale from the creator match.
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1poster" })

    await GET(makeReq("?assignee=account_rdx1someone_else"))

    expect(mockListTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        assigneeId: "account_rdx1someone_else",
        includeHiddenStale: undefined,
      }),
    )
  })

  it("a session read failure (getSessionUser throws) degrades to the public, filtered view rather than 500ing", async () => {
    mockGetSessionUser.mockRejectedValue(new Error("cookie store unavailable"))

    const res = await GET(makeReq("?creator=account_rdx1poster"))

    expect(res.status).toBe(200)
    expect(mockListTasks).toHaveBeenCalledWith(
      expect.objectContaining({ includeHiddenStale: undefined }),
    )
  })
})

/**
 * The envelope-level twin of the gate above (2026-09-14, profile Archived
 * section): the route now REPORTS whether it granted the owner's view, as
 * `ownerView`, so a client whose httpOnly guild_session has lapsed can tell
 * "the server filtered my archive out" from "I have no archived tasks" (see
 * src/lib/owner-view.ts and tests/unit/profile-archived-session.test.tsx).
 * It must track includeHiddenStale exactly — never true unless listTasks was
 * actually asked for the owner's rows — and be an explicit `false`, not
 * absent, in every public-view case, so the client's strict `=== false`
 * check can act on it.
 */
describe("GET /api/v1/tasks — ownerView envelope flag (profile Archived section, 2026-09-14)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListTasks.mockResolvedValue({ data: [], cursor: null, hasMore: false })
  })

  const bodyOf = async (query: string) => (await GET(makeReq(query))).json()

  it("is true when the verified session matches ?creator=", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1poster" })
    expect((await bodyOf("?creator=account_rdx1poster")).ownerView).toBe(true)
    expect(mockListTasks).toHaveBeenCalledWith(expect.objectContaining({ includeHiddenStale: true }))
  })

  it("is true when the verified session matches ?assignee=", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1worker" })
    expect((await bodyOf("?assignee=account_rdx1worker")).ownerView).toBe(true)
  })

  it("is an explicit false for an anonymous ?creator= read — the lapsed-cookie shape", async () => {
    mockGetSessionUser.mockResolvedValue(null)
    const body = await bodyOf("?creator=account_rdx1poster")
    expect(body.ownerView).toBe(false)
    expect(mockListTasks).toHaveBeenCalledWith(expect.objectContaining({ includeHiddenStale: undefined }))
  })

  it("is false for a session that does not match the requested identity", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1attacker" })
    expect((await bodyOf("?creator=account_rdx1victim")).ownerView).toBe(false)
  })

  it("is false when a session exists but no creator/assignee filter was given — nothing to be the owner of", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1poster" })
    expect((await bodyOf("")).ownerView).toBe(false)
    expect((await bodyOf("?status=open")).ownerView).toBe(false)
  })

  it("is false — not absent, not a 500 — when the session read throws", async () => {
    mockGetSessionUser.mockRejectedValue(new Error("cookie store unavailable"))
    const res = await GET(makeReq("?creator=account_rdx1poster"))
    expect(res.status).toBe(200)
    expect((await res.json()).ownerView).toBe(false)
  })

  it("keeps the rest of the paginated envelope intact alongside the flag", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1poster" })
    mockListTasks.mockResolvedValue({ data: [], cursor: "abc", hasMore: true })
    expect(await bodyOf("?creator=account_rdx1poster")).toEqual({
      ok: true,
      data: [],
      cursor: "abc",
      hasMore: true,
      ownerView: true,
    })
  })
})
