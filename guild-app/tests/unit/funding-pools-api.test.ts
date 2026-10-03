/**
 * Regression tests for the PR #455 adversarial-screen fixes:
 *
 *  - FIX 2 (money-adjacent): the stored `insurance_xrd` must come from exact
 *    decimal arithmetic (src/lib/xrd-decimal.ts's ceilXrdMultiple), never
 *    `Math.ceil(Number(target_xrd) * FUNDING_INSURANCE_FRACTION)` — that
 *    float path silently rounds a full-18dp target BEFORE the multiply.
 *  - FIX 4 (NaN limit): `?limit=abc` on both the funding-pools list and its
 *    leaderboard must 400 with a typed error, the same pattern
 *    /api/v1/game/leaderboard already uses — not reach the query builder as
 *    `.limit(NaN)` and surface a generic 500.
 *
 * FIX 3 (target_xrd="0" positivity) is covered directly in
 * tests/unit/validation.test.ts, at the schema boundary the fix actually
 * lives in.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const SESSION = "account_rdx1poster"

// The halt gate (P1 write side) now runs first in every task-lifecycle write, and it reads
// the live Gateway. Pin an advancing chain so this suite stays offline and deterministic —
// without it these tests reach mainnet and correctly 503 during the real halt. The gate's
// own behaviour is pinned in tests/unit/chain-halt-gate.test.ts; keeping the REAL gate in
// the path here (rather than stubbing the module) means these routes still execute it.
vi.mock("@/lib/gateway", () => ({
  NETWORK_HALT_AFTER_SECONDS: 900,
  operatorHaltEngaged: () => false,
  readLedgerTip: async () => ({
    stateVersion: 600_000_000,
    tipIso: "2026-09-08T09:00:00Z",
    ageSeconds: 12,
    stale: false,
  }),
}))

vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: SESSION } }),
}))

const { mockIsEnabled } = vi.hoisted(() => ({ mockIsEnabled: vi.fn() }))
vi.mock("@/lib/features", () => ({ isEnabled: mockIsEnabled }))

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => () => ({ ok: true }),
  rateLimitResponse: () =>
    new Response(JSON.stringify({ ok: false, error: { code: "RATE_LIMITED" } }), {
      status: 429,
    }),
}))

const { mockListFundingPools, mockCreateFundingPool, mockGetPatronLeaderboard } = vi.hoisted(() => ({
  mockListFundingPools: vi.fn(),
  mockCreateFundingPool: vi.fn(),
  mockGetPatronLeaderboard: vi.fn(),
}))
vi.mock("@/db/queries/funding-pools", () => ({
  listFundingPools: mockListFundingPools,
  createFundingPool: mockCreateFundingPool,
  getPatronLeaderboard: mockGetPatronLeaderboard,
}))

// Import AFTER mocks are registered.
import { GET as LIST, POST as CREATE } from "@/app/api/v1/funding-pools/route"
import { GET as LEADERBOARD } from "@/app/api/v1/funding-pools/leaderboard/route"

const listReq = (qs = "") => ({ url: `http://t/api/v1/funding-pools${qs}` }) as never
const createReq = (body: unknown) =>
  ({
    url: "http://t/api/v1/funding-pools",
    json: async () => body,
  }) as never
const leaderboardReq = (qs = "") =>
  ({ url: `http://t/api/v1/funding-pools/leaderboard${qs}` }) as never
const ctx = { params: Promise.resolve({}) } as never

beforeEach(() => {
  vi.clearAllMocks()
  mockIsEnabled.mockReturnValue(true)
  mockListFundingPools.mockResolvedValue({ data: [], cursor: null, hasMore: false })
  mockCreateFundingPool.mockImplementation(async (input) => ({ id: 1, ...input }))
  mockGetPatronLeaderboard.mockResolvedValue([])
})

describe("GET /api/v1/funding-pools — limit validation (FIX 4)", () => {
  // A negative limit is FINITE, so an isFinite-only guard let it through to
  // `.limit(limit + 1)` = `.limit(-4)`, which Postgres rejects — surfacing as
  // the same generic 500 the typed 400 exists to replace. The route's message
  // promised "a positive integer" long before it enforced one.
  it.each(["-5", "0"])("400s on a non-positive limit (%s)", async (bad) => {
    const res = await LIST(listReq(`?limit=${bad}`), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("INVALID_LIMIT")
  })

  it("400s on a non-numeric limit instead of forwarding NaN", async () => {
    const res = await LIST(listReq("?limit=abc"), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("INVALID_LIMIT")
    expect(mockListFundingPools).not.toHaveBeenCalled()
  })

  it("passes a valid numeric limit through untouched", async () => {
    await LIST(listReq("?limit=10"), ctx)
    expect(mockListFundingPools).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 }),
    )
  })

  it("passes undefined when no limit is given", async () => {
    await LIST(listReq(""), ctx)
    expect(mockListFundingPools).toHaveBeenCalledWith(
      expect.objectContaining({ limit: undefined }),
    )
  })
})

describe("GET /api/v1/funding-pools/leaderboard — limit validation (FIX 4)", () => {
  it.each(["-5", "0"])("400s on a non-positive limit (%s)", async (bad) => {
    const res = await LEADERBOARD(leaderboardReq(`?limit=${bad}`), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("INVALID_LIMIT")
  })

  it("400s on a non-numeric limit instead of forwarding NaN", async () => {
    const res = await LEADERBOARD(leaderboardReq("?limit=abc"), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("INVALID_LIMIT")
    expect(mockGetPatronLeaderboard).not.toHaveBeenCalled()
  })

  it("passes a valid numeric limit through untouched", async () => {
    await LEADERBOARD(leaderboardReq("?limit=5"), ctx)
    expect(mockGetPatronLeaderboard).toHaveBeenCalledWith(5)
  })
})

describe("POST /api/v1/funding-pools — exact-decimal insurance (FIX 2)", () => {
  const base = {
    title: "Repave the docs site",
    description: "Community-funded infra work.",
  }

  it("derives insurance_xrd from a full-precision target WITHOUT float rounding", async () => {
    // 100000000000000001 has 18 significant digits — one past a JS double's
    // ~15-17 digit precision, so `Number(target)` silently rounds it down to
    // 100000000000000000 before anything multiplies. That is a genuine
    // UNDER-insurance bug, not a cosmetic rounding difference: the float
    // path's insurance figure is BELOW the required 5% floor.
    const target = "100000000000000001"
    await CREATE(createReq({ ...base, target_xrd: target }), ctx)

    expect(mockCreateFundingPool).toHaveBeenCalledTimes(1)
    const call = mockCreateFundingPool.mock.calls[0][0]
    expect(call.targetXrd).toBe(target)
    // Exact: ceil(100000000000000001 * 0.05) = ceil(5000000000000000.05)
    //      = 5000000000000001
    expect(call.insuranceXrd).toBe("5000000000000001")
    // The float path (what the original `Math.ceil(Number(target) *
    // FUNDING_INSURANCE_FRACTION)` line computed) rounds the target to
    // 100000000000000000 first and lands ONE WHOLE XRD SHORT of the exact
    // floor — pinning both values here documents exactly what regresses if
    // `Number()` creeps back into this line.
    expect(Math.ceil(Number(target) * 0.05)).toBe(5000000000000000)
    expect(Math.ceil(Number(target) * 0.05)).not.toBe(Number(call.insuranceXrd))
  })

  it("still ceils a simple target to a whole XRD figure", async () => {
    await CREATE(createReq({ ...base, target_xrd: "100" }), ctx)
    const call = mockCreateFundingPool.mock.calls[0][0]
    expect(call.insuranceXrd).toBe("5")
  })
})
