/**
 * Public-text gate wiring for GET /api/v1/projects/[slug] (2026-09-10
 * operator ruling, closed 2026-09-13; existence-hiding added 2026-09-14).
 * src/lib/public-task-text.ts carries the scrubbing rules and their own unit
 * tests; this file pins that the PROJECT route runs every task in its
 * embedded task list through the gate with the right viewer identity —
 * mirroring tasks-route-public-text.test.ts for the sibling list route. PR
 * #564 wired the gate into GET /api/v1/tasks and GET /api/v1/tasks/[id] but
 * missed this route, which returns `{ ...project, tasks }` straight from
 * listTasks() — this file is the regression guard for that gap.
 *
 * 2026-09-14: listTasks() deliberately returns every status for a
 * project-scoped query (the kanban funnel needs the whole board — see
 * `isProjectScopedView` in db/queries/tasks.ts), cancelled included. But the
 * SAME hardening that stops a stranger fetching a cancelled task directly by
 * id (tasks-id-route-public-text.test.ts) has to apply to one embedded here
 * too, or the id gate is just a detour — see the second describe block
 * below.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockGetSessionUser } = vi.hoisted(() => ({
  mockGetSessionUser: vi.fn(),
}))
vi.mock("@/lib/auth", () => ({
  getSessionUser: mockGetSessionUser,
  // The route file gained a PATCH export wrapped in withAuth, so this mock has
  // to provide it even though these tests only exercise GET — vitest throws on
  // any import the factory omits. Pass-through: it hands the handler a stub
  // session, and nothing here calls PATCH.
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: "test-user" } }),
}))

const { mockFindProjectBySlug } = vi.hoisted(() => ({
  mockFindProjectBySlug: vi.fn(),
}))
vi.mock("@/db/queries/projects", () => ({
  findProjectBySlug: mockFindProjectBySlug,
}))

const { mockListTasks } = vi.hoisted(() => ({
  mockListTasks: vi.fn(),
}))
vi.mock("@/db/queries/tasks", () => ({
  listTasks: mockListTasks,
}))

// Import AFTER mocks are registered.
import { GET } from "@/app/api/v1/projects/[slug]/route"

const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) }) as never

const project = { id: 3, name: "Wallet Upgrade", slug: "wallet-upgrade" }

// Status is deliberately "open", not "cancelled" — this fixture exercises
// the TEXT scrub only. See the "cancelled-task existence gate" describe
// block below for the status-based hiding behaviour.
const posterTask = {
  id: 61,
  creatorId: "account_rdx1poster",
  status: "open",
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

describe("GET /api/v1/projects/[slug] — public-text gate (2026-09-10 ruling)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindProjectBySlug.mockResolvedValue(project)
    mockListTasks.mockResolvedValue({ data: [posterTask, otherTask], cursor: null, hasMore: false })
  })

  it("scrubs the poster's own task in the embedded list for an anonymous caller, leaving an unrelated task's ordinary text untouched", async () => {
    mockGetSessionUser.mockResolvedValue(null)
    const res = await GET({} as never, ctx("wallet-upgrade"))
    const body = await res.json()

    const [row1, row2] = body.data.tasks
    expect(row1.description).toBe("Done when verified.")
    expect(row1.description).not.toContain("/opt")
    expect(row1.description).not.toContain("ssh ")
    // Ordinary text with nothing to scrub round-trips byte-identical.
    expect(row2.description).toBe(otherTask.description)
    // The project row itself passes through untouched.
    expect(body.data.slug).toBe("wallet-upgrade")
  })

  it("gives the verified poster their OWN task raw, while a co-listed task from someone else stays scrubbed", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1poster" })
    const res = await GET({} as never, ctx("wallet-upgrade"))
    const body = await res.json()

    const mine = body.data.tasks.find((t: { id: number }) => t.id === 61)
    const theirs = body.data.tasks.find((t: { id: number }) => t.id === 40)
    expect(mine.description).toBe(posterTask.description)
    expect(mine.description).toContain("/opt/guild-saas/backups")
    expect(theirs.description).toBe(otherTask.description)
  })

  it("a signed-in viewer who is neither task's poster gets both tasks scrubbed", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1bystander" })
    const res = await GET({} as never, ctx("wallet-upgrade"))
    const body = await res.json()

    const mine = body.data.tasks.find((t: { id: number }) => t.id === 61)
    expect(mine.description).toBe("Done when verified.")
  })

  it("a session-read failure degrades to the scrubbed public view rather than 500ing", async () => {
    mockGetSessionUser.mockRejectedValue(new Error("cookie store unavailable"))
    const res = await GET({} as never, ctx("wallet-upgrade"))
    expect(res.status).toBe(200)
    const body = await res.json()
    const mine = body.data.tasks.find((t: { id: number }) => t.id === 61)
    expect(mine.description).not.toContain("/opt")
  })

  it("an unknown slug still 404s before the gate ever runs", async () => {
    mockFindProjectBySlug.mockResolvedValue(null)
    mockGetSessionUser.mockResolvedValue(null)
    const res = await GET({} as never, ctx("nope"))
    expect(res.status).toBe(404)
    expect(mockListTasks).not.toHaveBeenCalled()
  })
})

describe("GET /api/v1/projects/[slug] — cancelled-task existence gate (2026-09-14)", () => {
  const cancelledTask = {
    id: 36,
    creatorId: "account_rdx1poster",
    assigneeId: null,
    status: "cancelled",
    title: "Both scripts copied verbatim",
    description: "Both scripts copied verbatim (via ssh guild-vps read-only)",
  }
  const openTask = {
    id: 40,
    creatorId: "account_rdx1other_poster",
    status: "open",
    title: "Fix the countdown chip",
    description: "The chip should show hh:mm:ss, not just minutes.",
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockFindProjectBySlug.mockResolvedValue(project)
    mockListTasks.mockResolvedValue({ data: [cancelledTask, openTask], cursor: null, hasMore: false })
  })

  it("drops the cancelled task from the embedded list for an anonymous caller, keeping the open one", async () => {
    mockGetSessionUser.mockResolvedValue(null)
    const res = await GET({} as never, ctx("wallet-upgrade"))
    const body = await res.json()

    expect(body.data.tasks).toHaveLength(1)
    expect(body.data.tasks[0].id).toBe(40)
  })

  it("drops the cancelled task for a signed-in viewer who is neither its creator nor assignee", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1bystander" })
    const res = await GET({} as never, ctx("wallet-upgrade"))
    const body = await res.json()

    expect(body.data.tasks.map((t: { id: number }) => t.id)).toEqual([40])
  })

  it("keeps the cancelled task, scrubbed, for its own creator", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1poster" })
    const res = await GET({} as never, ctx("wallet-upgrade"))
    const body = await res.json()

    expect(body.data.tasks).toHaveLength(2)
    const mine = body.data.tasks.find((t: { id: number }) => t.id === 36)
    expect(mine.description).toBe(cancelledTask.description)
  })

  it("keeps the cancelled task for its assignee", async () => {
    mockListTasks.mockResolvedValue({
      data: [{ ...cancelledTask, assigneeId: "account_rdx1assignee" }, openTask],
      cursor: null,
      hasMore: false,
    })
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1assignee" })
    const res = await GET({} as never, ctx("wallet-upgrade"))
    const body = await res.json()

    expect(body.data.tasks.map((t: { id: number }) => t.id)).toEqual([36, 40])
  })

  it("a session-read failure degrades to dropping the cancelled task, not 500ing or leaking it", async () => {
    mockGetSessionUser.mockRejectedValue(new Error("cookie store unavailable"))
    const res = await GET({} as never, ctx("wallet-upgrade"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.tasks.map((t: { id: number }) => t.id)).toEqual([40])
  })
})

describe("GET /api/v1/projects/[slug] — passes viewerId into listTasks (PR #580 review finding)", () => {
  // The per-row isCancelledTaskVisibleTo filter above is defense in depth —
  // the actual gate now lives in listTasks() at the query layer (2026-09-14,
  // third pass: db/queries/tasks.ts `isProjectScopedView` branch), and it
  // only works if the route hands listTasks the SAME session it reads for
  // the text gate. The regression this closes: the route used to call
  // listTasks() before reading the session at all, so viewerId was never in
  // the call — every cancelled row silently vanished for every caller,
  // including its own creator/assignee, via listTasks' own fail-closed
  // `sql`false`` default. These cases pin the call argument directly rather
  // than only the response shape, so a future edit that drops viewerId from
  // the call fails a test even if some other filter happens to mask it.
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindProjectBySlug.mockResolvedValue(project)
    mockListTasks.mockResolvedValue({ data: [], cursor: null, hasMore: false })
  })

  it("passes the signed-in session's userId as viewerId", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1poster" })
    await GET({} as never, ctx("wallet-upgrade"))

    expect(mockListTasks).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: project.id, viewerId: "account_rdx1poster" }),
    )
  })

  it("passes undefined viewerId for an anonymous caller", async () => {
    mockGetSessionUser.mockResolvedValue(null)
    await GET({} as never, ctx("wallet-upgrade"))

    expect(mockListTasks).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: project.id, viewerId: undefined }),
    )
  })

  it("passes undefined viewerId when the session read itself fails", async () => {
    mockGetSessionUser.mockRejectedValue(new Error("cookie store unavailable"))
    await GET({} as never, ctx("wallet-upgrade"))

    expect(mockListTasks).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: project.id, viewerId: undefined }),
    )
  })
})
