/**
 * Unit tests for GET /api/v1/tasks/[id]/escrow/claim-check (P3-3b) — the
 * pre-signature self-claim guard.
 *
 * Before this route existed, the only self-claim check ran POST-hoc inside
 * applyEscrowConfirm (escrow-confirm.ts's SELF_CLAIM branch, exercised by
 * escrow-confirm.test.ts) — after the claim tx already burned its lock fee.
 * This route is the genuine pre-flight: a real HTTP 403, reachable before
 * any chain interaction, mirroring SELF_SUBMIT's shape
 * (tests/integration/api-lifecycle.test.ts's SELF_SUBMIT case).
 *
 * Mutation coverage: the "refuses" test below fails if the guard is removed
 * (200/allowed instead of 403), and the "allows" test fails if the guard is
 * made unconditional (403 for every caller, not just the creator) — the two
 * together pin the guard to exactly the creatorId === caller comparison, not
 * "always allow" or "always deny".
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// withAuth normally reads + verifies the JWT cookie; inject a fixed caller
// (same pattern as escrow-route.test.ts). Unauthenticated behavior (401,
// handler never invoked, nothing leaked) is generic to withAuth itself and
// already pinned at tests/unit/lib-auth.test.ts ("should return 401 when not
// authenticated") — every withAuth-wrapped route, this one included, inherits
// that guarantee without needing a per-route duplicate.
vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: "account_rdx1caller" } }),
}))

const { mockFindTaskById } = vi.hoisted(() => ({ mockFindTaskById: vi.fn() }))
vi.mock("@/db/queries/tasks", () => ({ findTaskById: mockFindTaskById }))

// No @/lib/gateway mock is registered at all. If the route ever grew a
// Gateway import, the unmocked module would need real env/network to load
// and this file would fail at import time — that absence is itself part of
// what proves the guard is a pure DB-field comparison, costing no Gateway
// call in either direction.

import { GET } from "@/app/api/v1/tasks/[id]/escrow/claim-check/route"

const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never
const req = {} as never

describe("GET /api/v1/tasks/[id]/escrow/claim-check", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("refuses a self-claim before any chain interaction (403 SELF_CLAIM)", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1,
      creatorId: "account_rdx1caller", // === the injected caller
      status: "open",
    })

    const res = await GET(req, ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json).toMatchObject({ ok: false, error: { code: "SELF_CLAIM" } })
    expect(mockFindTaskById).toHaveBeenCalledWith(1)
    expect(mockFindTaskById).toHaveBeenCalledTimes(1) // no retry, no extra lookup
  })

  it("allows a non-creator caller to check claim eligibility (200 allowed)", async () => {
    mockFindTaskById.mockResolvedValue({
      id: 1,
      creatorId: "account_rdx1poster", // different from the injected caller
      status: "open",
    })

    const res = await GET(req, ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, data: { allowed: true } })
  })

  it("does not gate on DB status — 'assigned' (expired-claim retry) is not treated as a guaranteed failure", async () => {
    // ALLOWED_FROM.claim (escrow-confirm.ts) explicitly includes "assigned" as
    // a valid claim-from state. If this route hard-blocked on status, an
    // honest expired-claim retry would 403 here before the real on-chain Open
    // read (which already handles this race) ever ran.
    mockFindTaskById.mockResolvedValue({
      id: 1,
      creatorId: "account_rdx1poster",
      status: "assigned",
    })

    const res = await GET(req, ctx("1"))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, data: { allowed: true } })
  })

  it("404s for a missing task without evaluating self-claim", async () => {
    mockFindTaskById.mockResolvedValue(null)

    const res = await GET(req, ctx("999"))
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.error.code).toBe("NOT_FOUND")
  })

  it("400s for a non-numeric id before touching the DB", async () => {
    const res = await GET(req, ctx("not-a-number"))
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error.code).toBe("INVALID_ID")
    expect(mockFindTaskById).not.toHaveBeenCalled()
  })
})
