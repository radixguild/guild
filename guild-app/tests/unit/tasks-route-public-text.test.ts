/**
 * Public-text gate wiring for GET /api/v1/tasks (2026-09-10 operator ruling).
 * src/lib/public-task-text.ts carries the scrubbing rules and their own unit
 * tests; this file pins that the LIST route runs every returned row through
 * the gate with the right viewer identity, and does so PER ROW — a mixed
 * page (some rows the caller posted, some they didn't) must scrub only the
 * ones that aren't theirs.
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

vi.mock("@/db/queries/projects", () => ({ findProjectById: vi.fn() }))

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => () => ({ ok: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}))

// Import AFTER mocks are registered.
import { GET } from "@/app/api/v1/tasks/route"

const makeReq = (query = "") => ({ url: `http://localhost/api/v1/tasks${query}` }) as never

const posterTask = {
  id: 61,
  creatorId: "account_rdx1poster",
  status: "cancelled",
  title: "Provision the Hetzner offsite box",
  description: "ssh guild-vps 'ls /opt/guild-saas/backups'\nDone when verified.",
}
const otherTask = {
  id: 40,
  creatorId: "account_rdx1other_poster",
  status: "open",
  title: "Fix the countdown chip",
  description: "The chip should show hh:mm:ss, not just minutes.",
}

describe("GET /api/v1/tasks — public-text gate (2026-09-10 ruling)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListTasks.mockResolvedValue({ data: [posterTask, otherTask], cursor: null, hasMore: false })
  })

  it("scrubs the poster's own row for an anonymous viewer, and leaves an unrelated row's ordinary text untouched", async () => {
    mockGetSessionUser.mockResolvedValue(null)
    const res = await GET(makeReq())
    const body = await res.json()

    const [row1, row2] = body.data
    expect(row1.description).toBe("Done when verified.")
    expect(row1.description).not.toContain("/opt")
    expect(row1.description).not.toContain("ssh ")
    // Ordinary text with nothing to scrub round-trips byte-identical.
    expect(row2.description).toBe(otherTask.description)
  })

  it("gives the verified poster their OWN row raw, while a co-listed row from someone else stays scrubbed", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1poster" })
    const res = await GET(makeReq())
    const body = await res.json()

    const mine = body.data.find((t: { id: number }) => t.id === 61)
    const theirs = body.data.find((t: { id: number }) => t.id === 40)
    expect(mine.description).toBe(posterTask.description)
    expect(mine.description).toContain("/opt/guild-saas/backups")
    expect(theirs.description).toBe(otherTask.description)
  })

  it("a signed-in viewer who is neither row's poster gets both rows scrubbed", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1bystander" })
    const res = await GET(makeReq())
    const body = await res.json()

    const mine = body.data.find((t: { id: number }) => t.id === 61)
    expect(mine.description).toBe("Done when verified.")
  })

  it("a session-read failure degrades to the scrubbed public view rather than 500ing", async () => {
    mockGetSessionUser.mockRejectedValue(new Error("cookie store unavailable"))
    const res = await GET(makeReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    const mine = body.data.find((t: { id: number }) => t.id === 61)
    expect(mine.description).not.toContain("/opt")
  })

  it("an empty result set never touches the gate (no crash on zero rows)", async () => {
    mockListTasks.mockResolvedValue({ data: [], cursor: null, hasMore: false })
    mockGetSessionUser.mockResolvedValue(null)
    const res = await GET(makeReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual([])
  })
})
