import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * §22 option A — the write-time honest-copy gate on project text.
 *
 * The honest-copy CI gate scans SOURCE, so it cannot see project copy, which
 * lives in Postgres. That blind spot let /projects advertise 195,200 XRD of
 * "rewards" beside 22,900 XRD actually paid+locked until the 2026-09-18 sweep.
 * These tests pin that POST and PATCH /api/v1/projects now refuse a banned
 * claim at write time.
 *
 * The most important fixture here is LIVE_P4: the real shape of the
 * description that motivated this gate. A gate that refused "trustless" but
 * let that through would pass every other test and still miss the defect.
 *
 * To mutate-prove: delete the `bannedClaimIn` call from either route and that
 * route's refusal tests fail; delete the unbacked-reward-total rule from
 * BANNED and the LIVE_P4 tests fail.
 */

const { mockCreateProject, mockUpdateProject, mockFindProjectBySlug } = vi.hoisted(() => ({
  mockCreateProject: vi.fn(),
  mockUpdateProject: vi.fn(),
  mockFindProjectBySlug: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({
  getSessionUser: vi.fn(),
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: "commissioner-1" } }),
}))
vi.mock("@/db/queries/projects", () => ({
  createProject: mockCreateProject,
  updateProject: mockUpdateProject,
  findProjectBySlug: mockFindProjectBySlug,
  listProjectsWithProgress: vi.fn(),
}))
vi.mock("@/db/queries/tasks", () => ({ listTasks: vi.fn() }))
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => () => ({ ok: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}))

import { bannedClaimIn } from "@/lib/project-copy-gate"
import { POST } from "@/app/api/v1/projects/route"
import { PATCH } from "@/app/api/v1/projects/[slug]/route"

// The real shape of the live P4 description that motivated this gate.
const LIVE_P4 =
  "Tools an outside agent can actually run. — Catalogue: 20 tasks · 67,100 XRD in rewards " +
  "(docs/guild-task-board.json, project P4). — Done when: an outside agent completes a task."

const CLEAN = "Small, well-scoped tasks for agents and people. Paid in XRD through the escrow."

const post = (body: unknown) =>
  POST(
    new Request("http://x/api/v1/projects", { method: "POST", body: JSON.stringify(body) }) as never,
    {} as never,
  )
const patch = (body: unknown) =>
  PATCH(
    new Request("http://x/api/v1/projects/p4", { method: "PATCH", body: JSON.stringify(body) }) as never,
    { params: Promise.resolve({ slug: "p4" }) } as never,
  )

describe("bannedClaimIn — the gate itself", () => {
  it("refuses the live P4 description that motivated this gate", () => {
    const hit = bannedClaimIn({ description: LIVE_P4 })
    expect(hit).not.toBeNull()
    expect(hit!.field).toBe("description")
    expect(hit!.fragment).toContain("XRD in rewards")
  })

  it("refuses a banned claim in the name, and names the field", () => {
    expect(bannedClaimIn({ name: "The trustless agent board" })?.field).toBe("name")
  })

  it("passes clean copy", () => {
    expect(bannedClaimIn({ name: "Agent tools", description: CLEAN })).toBeNull()
  })

  it("skips an absent field — so a name-only PATCH is never judged on a stored description", () => {
    expect(bannedClaimIn({ name: "Agent tools" })).toBeNull()
  })

  it("skips null and non-string fields rather than refusing them (schema owns shape)", () => {
    expect(bannedClaimIn({ name: null, description: undefined })).toBeNull()
    expect(bannedClaimIn({ name: 42 as unknown as string })).toBeNull()
  })
})

describe("POST /api/v1/projects — refuses at write time", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateProject.mockResolvedValue({ id: 1, slug: "p" })
  })

  it("400s BANNED_CLAIM on the live P4 description, and stores NOTHING", async () => {
    const res = await post({ name: "Agent tools", description: LIVE_P4 })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe("BANNED_CLAIM")
    expect(json.error.field).toBe("description")
    expect(json.error.fragment).toContain("XRD in rewards")
    // The point of write-time: the claim never becomes a row.
    expect(mockCreateProject).not.toHaveBeenCalled()
  })

  it("still creates a project with clean copy (the gate is not a blanket refusal)", async () => {
    const res = await post({ name: "Agent tools", description: CLEAN })
    expect(res.status).toBe(201)
    expect(mockCreateProject).toHaveBeenCalledOnce()
  })
})

describe("PATCH /api/v1/projects/[slug] — refuses at write time", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindProjectBySlug.mockResolvedValue({ id: 4, slug: "p4", commissionerId: "commissioner-1" })
    mockUpdateProject.mockResolvedValue({ id: 4, slug: "p4" })
  })

  it("400s BANNED_CLAIM when the edit introduces a banned claim, and updates NOTHING", async () => {
    const res = await patch({ description: LIVE_P4 })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe("BANNED_CLAIM")
    expect(mockUpdateProject).not.toHaveBeenCalled()
  })

  it("lets a name-only edit through — it is not judged on the description it did not touch", async () => {
    const res = await patch({ name: "Agent tools" })
    expect(res.status).toBe(200)
    expect(mockUpdateProject).toHaveBeenCalledOnce()
  })

  it("lets a clean correction through — which is how a live false row gets FIXED", async () => {
    const res = await patch({ description: CLEAN })
    expect(res.status).toBe(200)
  })
})

describe("both routes are actually wired (vacuous-pass guard)", () => {
  // Without this, removing the call from a route and ALSO deleting its route
  // tests would leave the gate module green while guarding nothing.
  it.each([
    "src/app/api/v1/projects/route.ts",
    "src/app/api/v1/projects/[slug]/route.ts",
  ])("%s calls bannedClaimIn", (route) => {
    const src = readFileSync(join(process.cwd(), route), "utf8")
    expect(/bannedClaimIn\(/.test(src)).toBe(true)
  })
})
