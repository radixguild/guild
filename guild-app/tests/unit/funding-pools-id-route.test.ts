/**
 * Route-level HTTP tests for GET /api/v1/funding-pools/[id].
 *
 * Fixes the hardening-sweep MEDIUM finding: the route was fully
 * unauthenticated and returned every contributor's wallet address and their
 * exact pledge amount to anyone who could guess a pool id — database-only
 * PII with no on-chain component to justify it (unlike escrow, which mirrors
 * real chain state). The fix splits the response by who is asking:
 *   - anyone (including anonymous): the pool plus aggregate counts only.
 *   - a signed-in caller: also their OWN contribution, in full.
 *   - the pool's poster (fundingPools.posterId — this repo's existing
 *     notion of "pool owner"): also the full per-contributor list.
 *
 * Mocking/handler-invocation style follows tests/unit/tempcheck-route.test.ts
 * (vi.hoisted mocks, Promise-wrapped params ctx, optional-auth via a mocked
 * getSessionUser rather than withAuth) and tests/unit/funding-pools-api.test.ts
 * (mocking @/lib/features' isEnabled, import-after-mocks).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockIsEnabled } = vi.hoisted(() => ({ mockIsEnabled: vi.fn() }))
vi.mock("@/lib/features", () => ({ isEnabled: mockIsEnabled }))

const { mockGetSessionUser } = vi.hoisted(() => ({ mockGetSessionUser: vi.fn() }))
vi.mock("@/lib/auth", () => ({ getSessionUser: mockGetSessionUser }))

const { mockGetFundingPoolById, mockListPoolContributions } = vi.hoisted(() => ({
  mockGetFundingPoolById: vi.fn(),
  mockListPoolContributions: vi.fn(),
}))
vi.mock("@/db/queries/funding-pools", () => ({
  getFundingPoolById: mockGetFundingPoolById,
  listPoolContributions: mockListPoolContributions,
}))

// Import AFTER mocks are registered.
import { GET } from "@/app/api/v1/funding-pools/[id]/route"

const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never
const req = () => ({}) as never

const POSTER = "account_rdx1poster"
const ALICE = "account_rdx1alice"
const BOB = "account_rdx1bob"
const CAROL = "account_rdx1carol" // signed in, but neither poster nor a contributor

const BASE_POOL = {
  id: 1,
  posterId: POSTER,
  title: "Run a community node",
  description: "Keep a full node online for a quarter.",
  targetXrd: "1000",
  pooledXrd: "300",
  insuranceXrd: "50",
  // A string, not a Date: NextResponse.json round-trips through
  // JSON.stringify, so a real query result's Date column would come back out
  // of res.json() as this same ISO string anyway — this fixture matches what
  // the route actually returns rather than what the DB layer's type says.
  deadline: "2027-01-01T00:00:00.000Z",
  graceWindowSecs: null,
  status: "pledging",
  fundedAt: null,
  finalizedAt: null,
  finalizedTaskId: null,
  expiredAt: null,
  expiredReason: null,
}

// Amounts deliberately distinct from targetXrd/pooledXrd/remainingXrd (700)
// so a substring check for "did an amount leak" can't false-pass or
// false-fail on an unrelated aggregate number that legitimately appears.
const ALICE_ROW = { contributorId: ALICE, amountXrd: "123.456", refundedAt: null, refundedXrd: null }
const BOB_ROW = { contributorId: BOB, amountXrd: "654.321", refundedAt: null, refundedXrd: null }

beforeEach(() => {
  vi.clearAllMocks()
  mockIsEnabled.mockReturnValue(true)
  mockGetFundingPoolById.mockResolvedValue(BASE_POOL)
  mockListPoolContributions.mockResolvedValue([ALICE_ROW, BOB_ROW])
  mockGetSessionUser.mockResolvedValue(null) // anonymous by default
})

describe("GET /api/v1/funding-pools/[id] — guards", () => {
  it("503s when the crowdfund feature is disabled, before touching the DB", async () => {
    mockIsEnabled.mockReturnValue(false)
    const res = await GET(req(), ctx("1"))
    expect(res.status).toBe(503)
    expect(mockGetFundingPoolById).not.toHaveBeenCalled()
  })

  it("400s INVALID_ID on a non-numeric id", async () => {
    const res = await GET(req(), ctx("not-a-number"))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("INVALID_ID")
  })

  it("404s NOT_FOUND when the pool doesn't exist, before listing contributions", async () => {
    mockGetFundingPoolById.mockResolvedValue(null)
    const res = await GET(req(), ctx("999"))
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe("NOT_FOUND")
    expect(mockListPoolContributions).not.toHaveBeenCalled()
  })
})

describe("GET /api/v1/funding-pools/[id] — unauthenticated caller (REGRESSION for the PII leak)", () => {
  it("gets a 200 with the aggregate only — no wallet addresses, no per-contributor amounts, no 401", async () => {
    // This is the direct regression test for the hardening-sweep finding.
    // Against the pre-fix route (which returned `contributions` unconditionally)
    // every assertion below fails: the array is present, and both addresses
    // and both amounts appear verbatim in the response body.
    mockGetSessionUser.mockResolvedValue(null)
    const res = await GET(req(), ctx("1"))
    expect(res.status).toBe(200) // never 401 — auth is optional, not required

    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data.contributions).toBeUndefined() // key absent, not just empty
    expect(body.data.contributorCount).toBe(2)
    expect(body.data.remainingXrd).toBe("700")
    expect(body.data.yourContribution).toBeNull()
    expect(body.data.pool).toEqual(BASE_POOL)

    // Belt-and-suspenders: no contributor identity or amount anywhere in the
    // serialized payload, not just absent from the one field we expect it in.
    const raw = JSON.stringify(body)
    expect(raw).not.toContain(ALICE)
    expect(raw).not.toContain(BOB)
    expect(raw).not.toContain(ALICE_ROW.amountXrd)
    expect(raw).not.toContain(BOB_ROW.amountXrd)
  })
})

describe("GET /api/v1/funding-pools/[id] — signed-in caller who is neither poster nor a contributor", () => {
  it("sees no per-contributor data either — same as anonymous, not a lesser leak", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: CAROL })
    const res = await GET(req(), ctx("1"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.contributions).toBeUndefined()
    expect(body.data.yourContribution).toBeNull()

    const raw = JSON.stringify(body)
    expect(raw).not.toContain(ALICE)
    expect(raw).not.toContain(BOB)
  })
})

describe("GET /api/v1/funding-pools/[id] — an authenticated contributor", () => {
  it("sees their OWN contribution in full, but not the full list and not the other contributor's row", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: ALICE })
    const res = await GET(req(), ctx("1"))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.data.yourContribution).toEqual(ALICE_ROW)
    expect(body.data.contributions).toBeUndefined() // not the poster — no full list

    const raw = JSON.stringify(body)
    expect(raw).not.toContain(BOB) // Bob's address never appears
    expect(raw).not.toContain(BOB_ROW.amountXrd) // nor Bob's amount
  })
})

describe("GET /api/v1/funding-pools/[id] — the pool's poster", () => {
  it("sees the full contributor list — wallet addresses and exact amounts included", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: POSTER })
    const res = await GET(req(), ctx("1"))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.data.contributions).toEqual([ALICE_ROW, BOB_ROW])
    // The poster didn't pledge into their own pool in this fixture — the two
    // fields are independent, not aliases of each other.
    expect(body.data.yourContribution).toBeNull()
  })

  it("a poster who ALSO contributed sees both the full list and their own row", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: POSTER })
    const posterRow = { contributorId: POSTER, amountXrd: "10", refundedAt: null, refundedXrd: null }
    mockListPoolContributions.mockResolvedValue([ALICE_ROW, BOB_ROW, posterRow])
    const res = await GET(req(), ctx("1"))
    const body = await res.json()
    expect(body.data.contributions).toEqual([ALICE_ROW, BOB_ROW, posterRow])
    expect(body.data.yourContribution).toEqual(posterRow)
  })
})
