/**
 * Route-level HTTP tests for the notification substrate's read API:
 *   GET   /api/v1/notifications
 *   PATCH /api/v1/notifications/read
 *
 * Mocking/handler-invocation style follows tests/unit/game-api.test.ts
 * (withAuth → fixed session user, isEnabled mock for the HIGH-003 503 case)
 * and tests/unit/tempcheck-route.test.ts (vi.hoisted mocks, import-after-
 * mocks, one describe block per behavior) — the two styles this PR was asked
 * to follow.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const SESSION = "account_rdx1me"

// withAuth → inject a fixed session user (identity never comes from the
// request) — same idiom as game-api.test.ts.
vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: SESSION } }),
}))

const { mockIsEnabled } = vi.hoisted(() => ({ mockIsEnabled: vi.fn() }))
vi.mock("@/lib/features", () => ({ isEnabled: mockIsEnabled }))

const { mockListNotificationsForUser, mockCountUnreadForUser, mockMarkNotificationsRead } = vi.hoisted(() => ({
  mockListNotificationsForUser: vi.fn(),
  mockCountUnreadForUser: vi.fn(),
  mockMarkNotificationsRead: vi.fn(),
}))
vi.mock("@/db/queries/notifications", () => ({
  listNotificationsForUser: mockListNotificationsForUser,
  countUnreadForUser: mockCountUnreadForUser,
  markNotificationsRead: mockMarkNotificationsRead,
}))

// Import AFTER mocks are registered.
import { GET } from "@/app/api/v1/notifications/route"
import { PATCH } from "@/app/api/v1/notifications/read/route"

const getReq = (qs = "") => ({ url: `http://t/api/v1/notifications${qs}` }) as never
const patchReq = (body?: unknown) =>
  ({
    json: async () => {
      if (body === undefined) throw new Error("Unexpected end of JSON input")
      return body
    },
  }) as never
const ctx = { params: Promise.resolve({}) } as never

beforeEach(() => {
  vi.clearAllMocks()
  mockIsEnabled.mockReturnValue(true) // flag ON by default; OFF cases override
  mockListNotificationsForUser.mockResolvedValue({ data: [], cursor: null, hasMore: false })
  mockCountUnreadForUser.mockResolvedValue(0)
  mockMarkNotificationsRead.mockResolvedValue(0)
})

describe("GET /api/v1/notifications", () => {
  it("503s when the notifications flag is off, without touching the query layer (H-003)", async () => {
    mockIsEnabled.mockReturnValue(false)
    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe("FEATURE_DISABLED")
    expect(mockListNotificationsForUser).not.toHaveBeenCalled()
    expect(mockCountUnreadForUser).not.toHaveBeenCalled()
  })

  it("reads the SESSION user's own inbox, never an address from the request (identity parity with game/state)", async () => {
    await GET(getReq(), ctx)
    expect(mockListNotificationsForUser).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ limit: undefined, cursor: undefined, unreadOnly: false }),
    )
    expect(mockCountUnreadForUser).toHaveBeenCalledWith(SESSION)
  })

  it("parses limit/cursor/unreadOnly query params through to the query layer", async () => {
    await GET(getReq("?limit=5&cursor=42&unreadOnly=true"), ctx)
    expect(mockListNotificationsForUser).toHaveBeenCalledWith(SESSION, {
      limit: 5,
      cursor: "42",
      unreadOnly: true,
    })
  })

  it("400s INVALID_LIMIT on a non-numeric limit, before touching the query layer", async () => {
    const res = await GET(getReq("?limit=abc"), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("INVALID_LIMIT")
    expect(mockListNotificationsForUser).not.toHaveBeenCalled()
  })

  it("returns data/cursor/hasMore from the query layer plus the TRUE unread count", async () => {
    mockListNotificationsForUser.mockResolvedValue({
      data: [{ id: 1, event: "task_claimed" }],
      cursor: "1",
      hasMore: true,
    })
    mockCountUnreadForUser.mockResolvedValue(7)
    const res = await GET(getReq(), ctx)
    const body = await res.json()
    expect(body).toEqual({
      ok: true,
      data: [{ id: 1, event: "task_claimed" }],
      cursor: "1",
      hasMore: true,
      unreadCount: 7,
    })
  })

  it("unreadCount reflects the TOTAL unread, independent of an unreadOnly=false page (the header badge must not undercount)", async () => {
    // The page itself is the unfiltered (mixed read/unread) view...
    mockListNotificationsForUser.mockResolvedValue({ data: [], cursor: null, hasMore: false })
    // ...but the badge count is unaffected by that filter — it's a separate query.
    mockCountUnreadForUser.mockResolvedValue(3)
    const res = await GET(getReq("?unreadOnly=false"), ctx)
    const body = await res.json()
    expect(body.unreadCount).toBe(3)
    expect(mockCountUnreadForUser).toHaveBeenCalledWith(SESSION)
  })
})

describe("PATCH /api/v1/notifications/read", () => {
  it("503s when the notifications flag is off, without touching the query layer (H-003)", async () => {
    mockIsEnabled.mockReturnValue(false)
    const res = await PATCH(patchReq({}), ctx)
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe("FEATURE_DISABLED")
    expect(mockMarkNotificationsRead).not.toHaveBeenCalled()
  })

  it("marks ALL of the session user's unread notifications read when the body has no ids", async () => {
    mockMarkNotificationsRead.mockResolvedValue(4)
    const res = await PATCH(patchReq({}), ctx)
    expect(res.status).toBe(200)
    expect(mockMarkNotificationsRead).toHaveBeenCalledWith(SESSION, undefined)
    expect((await res.json()).data).toEqual({ updated: 4 })
  })

  it("marks ALL when the body can't even be parsed (no body sent) — never a 400 for the common 'mark all' call", async () => {
    mockMarkNotificationsRead.mockResolvedValue(2)
    const res = await PATCH(patchReq(undefined), ctx)
    expect(res.status).toBe(200)
    expect(mockMarkNotificationsRead).toHaveBeenCalledWith(SESSION, undefined)
  })

  it("marks exactly the given ids, scoped to the SESSION user (never another address)", async () => {
    mockMarkNotificationsRead.mockResolvedValue(2)
    const res = await PATCH(patchReq({ ids: [1, 2] }), ctx)
    expect(res.status).toBe(200)
    expect(mockMarkNotificationsRead).toHaveBeenCalledWith(SESSION, [1, 2])
    expect((await res.json()).data).toEqual({ updated: 2 })
  })

  it("400s VALIDATION_ERROR on a non-array ids", async () => {
    const res = await PATCH(patchReq({ ids: "1" }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
    expect(mockMarkNotificationsRead).not.toHaveBeenCalled()
  })

  it("400s VALIDATION_ERROR on a non-positive id in the array", async () => {
    const res = await PATCH(patchReq({ ids: [1, -2] }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
    expect(mockMarkNotificationsRead).not.toHaveBeenCalled()
  })

  it("400s VALIDATION_ERROR when ids exceeds the 100 cap", async () => {
    const res = await PATCH(patchReq({ ids: Array.from({ length: 101 }, (_, i) => i + 1) }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
    expect(mockMarkNotificationsRead).not.toHaveBeenCalled()
  })

  it("an explicit empty ids array marks nothing (not 'mark all')", async () => {
    mockMarkNotificationsRead.mockResolvedValue(0)
    const res = await PATCH(patchReq({ ids: [] }), ctx)
    expect(res.status).toBe(200)
    expect(mockMarkNotificationsRead).toHaveBeenCalledWith(SESSION, [])
    expect((await res.json()).data).toEqual({ updated: 0 })
  })
})
