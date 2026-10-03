import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * /groups/[slug] — the not-found path (scaled-MVP item 2, Rulings Board N2).
 * A real Server Component: when `getWorkingGroupBySlug` resolves to null, the
 * route must produce Next's genuine notFound() — never a 200 with a soft "not
 * found" card, which is exactly the trap the sibling API route
 * (/api/v1/projects/[slug], see tests/unit/projects.test.ts's "404s on unknown
 * slug" case) already guards on the projects side.
 *
 * Mirrors tests/unit/gift-guard.test.tsx's notFound-mocking shape: mock
 * `next/navigation` to throw a recognizable error instead of doing Next's real
 * (test-incompatible) redirect-by-exception, then assert the page function
 * rejects with it.
 */

const H = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getWorkingGroupBySlug: vi.fn(),
  listGroupsFeed: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ getSessionUser: H.getSessionUser }))
vi.mock("@/db/queries/working-groups", () => ({
  getWorkingGroupBySlug: H.getWorkingGroupBySlug,
  listGroupsFeed: H.listGroupsFeed,
}))

const liveGroup = {
  id: 7,
  slug: "scrypto",
  name: "Scrypto",
  description: "Chain work",
  sortOrder: 10,
  isActive: true,
  memberCount: 3,
  openTaskCount: 1,
  viewerLevel: null as string | null,
}

describe("/groups/[slug] route guard", () => {
  beforeEach(() => {
    vi.resetModules()
    H.getSessionUser.mockReset().mockResolvedValue(null)
    H.getWorkingGroupBySlug.mockReset()
    H.listGroupsFeed.mockReset().mockResolvedValue({ data: [], hasMore: false, cursor: null })
    vi.doMock("next/navigation", () => ({
      notFound: () => {
        throw new Error("NEXT_NOT_FOUND")
      },
    }))
  })

  afterEach(() => {
    vi.doUnmock("next/navigation")
  })

  it("404s when the slug resolves to no group", async () => {
    H.getWorkingGroupBySlug.mockResolvedValue(null)
    const { default: GroupPage } = await import("@/app/groups/[slug]/page")
    await expect(
      GroupPage({ params: Promise.resolve({ slug: "does-not-exist" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND")
    // Never got far enough to ask for the group's task feed.
    expect(H.listGroupsFeed).not.toHaveBeenCalled()
  })

  it("renders (does not 404) once the slug resolves — proves the guard isn't unconditional", async () => {
    H.getWorkingGroupBySlug.mockResolvedValue(liveGroup)
    const { default: GroupPage } = await import("@/app/groups/[slug]/page")
    await expect(
      GroupPage({ params: Promise.resolve({ slug: "scrypto" }) }),
    ).resolves.toBeTruthy()
    expect(H.listGroupsFeed).toHaveBeenCalledWith([7], { limit: 30 })
  })

  it("still 404s for a SOFT-ARCHIVED group's slug when the lookup itself finds nothing (deleted, never archived)", async () => {
    // getWorkingGroupBySlug resolves archived groups too (see its own
    // docblock) — this test is not about isActive, it just confirms the page
    // has no separate archived-branch that skips notFound(). A slug that
    // simply does not exist in the catalog at all must still 404.
    H.getWorkingGroupBySlug.mockResolvedValue(null)
    const { default: GroupPage } = await import("@/app/groups/[slug]/page")
    await expect(
      GroupPage({ params: Promise.resolve({ slug: "long-gone" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND")
  })

  it("passes the signed-in viewer's id through so viewerLevel resolves for them, not anonymous", async () => {
    H.getSessionUser.mockResolvedValue({ userId: "account_rdx1alice" })
    H.getWorkingGroupBySlug.mockResolvedValue({ ...liveGroup, viewerLevel: "watching" })
    const { default: GroupPage } = await import("@/app/groups/[slug]/page")
    await GroupPage({ params: Promise.resolve({ slug: "scrypto" }) })
    expect(H.getWorkingGroupBySlug).toHaveBeenCalledWith("scrypto", "account_rdx1alice")
  })

  it("passes undefined viewerId for a signed-out visitor rather than a falsy placeholder", async () => {
    H.getWorkingGroupBySlug.mockResolvedValue(liveGroup)
    const { default: GroupPage } = await import("@/app/groups/[slug]/page")
    await GroupPage({ params: Promise.resolve({ slug: "scrypto" }) })
    expect(H.getWorkingGroupBySlug).toHaveBeenCalledWith("scrypto", undefined)
  })
})
