/**
 * GET /api/v1/agents/codes/{code} (A2.2, review round 3): the owner's
 * "has my agent used THIS code yet?" — read from the code's own row, never
 * inferred from the agent list. Owner-only, and no oracle for anyone else.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const S = vi.hoisted(() => ({ userId: "account_rdx1owner00000000000000000000000000000000000000000000001" }))
// Every /api/v1/agents/* route sits behind the agentsAdd flag (behindAgentsFlag,
// src/lib/agent-api.ts); these tests exercise the routes as they behave with it
// on. The off side is tests/unit/agents-api-flag-gate.test.ts.
vi.mock("@/lib/features", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/features")>()
  return { ...actual, isEnabled: (f: Parameters<typeof actual.isEnabled>[0]) => f === "agentsAdd" || actual.isEnabled(f) }
})

vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: S.userId } }),
}))
const Q = vi.hoisted(() => ({ findOwnedPairingCode: vi.fn() }))
vi.mock("@/db/queries/agents", () => ({ findOwnedPairingCode: Q.findOwnedPairingCode }))
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => () => ({ ok: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}))

import { GET } from "@/app/api/v1/agents/codes/[code]/route"

const ctx = (code: string) => ({ params: Promise.resolve({ code }) }) as never
const row = (over: Record<string, unknown> = {}) => ({
  code: "ABCDEFGH",
  ownerId: S.userId,
  label: "Scout",
  labelNorm: "scout",
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 10 * 60_000),
  redeemedAt: null,
  redeemedBy: null,
  ...over,
})

beforeEach(() => Q.findOwnedPairingCode.mockReset())

describe("GET /agents/codes/{code}", () => {
  it.each([
    ["open", row()],
    ["redeemed", row({ redeemedAt: new Date(), redeemedBy: "account_rdx1agent" })],
    ["expired", row({ expiresAt: new Date(Date.now() - 1) })],
    // redeemed wins over expiry: a code used in time stays "redeemed" forever
    ["redeemed", row({ redeemedAt: new Date(Date.now() - 60_000), redeemedBy: "a", expiresAt: new Date(Date.now() - 1) })],
  ])("→ %s, from the code's own row", async (status, r) => {
    Q.findOwnedPairingCode.mockResolvedValue(r)
    const res = await GET({} as never, ctx("abcd-efgh"))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ code: "ABCD-EFGH", status })
  })

  it("looks the code up normalised AND scoped to the session owner", async () => {
    Q.findOwnedPairingCode.mockResolvedValue(row())
    await GET({} as never, ctx(" abcd-efgh "))
    expect(Q.findOwnedPairingCode).toHaveBeenCalledWith("ABCDEFGH", S.userId)
  })

  it("🔴 someone else's code, a missing one and a malformed one are the same 404 — no oracle", async () => {
    Q.findOwnedPairingCode.mockResolvedValue(null)
    const missing = await GET({} as never, ctx("ABCD-EFGH"))
    const malformed = await GET({} as never, ctx("not a code"))
    for (const r of [missing, malformed]) {
      expect(r.status).toBe(404)
      expect((await r.json()).error.code).toBe("CODE_NOT_FOUND")
    }
    expect(Q.findOwnedPairingCode).toHaveBeenCalledTimes(1) // a malformed code never reaches the DB
  })
})
