/**
 * Route-level HTTP tests for GET /api/v1/tempcheck/[checkId] — the
 * /lights-on temperature-check tally endpoint (shipped 2026-09-05; the vote
 * handler was REMOVED on 2026-10-12 when the poll closed with no votes, so
 * the POST blocks that used to sit below the GET ones went with it, and the
 * last test in this file is the one that keeps it gone).
 *
 * tempcheck-tally.test.ts already pins the query layer's pure tally shaping
 * and the upsert's generated SQL directly. This file drives the route
 * handlers themselves the way an HTTP client would — mocking only the
 * DB-touching query functions (getVotesForCheck/getVoterChoice)
 * while keeping tallyVotes/countSigned REAL, so a tally-shape assertion here
 * proves the route composes them correctly end to end, not just that it
 * calls a mock. Mocking/handler-invocation style follows tasks-id-route.test.ts
 * (vi.hoisted mocks, Promise-wrapped params ctx) and quote-xrd-usd-route.test.ts
 * (import-after-mocks, one describe block per behavior).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

process.env.DATABASE_URL ??= "postgres://dummy:dummy@127.0.0.1:5432/dummy"

const { mockGetVotesForCheck, mockGetVoterChoice } = vi.hoisted(() => ({
  mockGetVotesForCheck: vi.fn(),
  mockGetVoterChoice: vi.fn(),
}))

vi.mock("@/db/queries/tempcheck", async () => {
  const actual = await vi.importActual<typeof import("@/db/queries/tempcheck")>("@/db/queries/tempcheck")
  return {
    ...actual,
    getVotesForCheck: mockGetVotesForCheck,
    getVoterChoice: mockGetVoterChoice,
  }
})

const { mockGetSessionUser } = vi.hoisted(() => ({ mockGetSessionUser: vi.fn() }))
vi.mock("@/lib/auth", () => ({ getSessionUser: mockGetSessionUser }))

// Bypass the real limiter — its own coverage lives in lib-rate-limit.test.ts —
// same idiom as game-api.test.ts.
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => () => ({ ok: true }),
  getClientIp: () => "127.0.0.1",
  rateLimitResponse: (retryAfter: number) =>
    new Response(
      JSON.stringify({ ok: false, error: { code: "RATE_LIMITED", message: "Too many requests" } }),
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    ),
}))

// Import AFTER mocks are registered.
import * as route from "@/app/api/v1/tempcheck/[checkId]/route"

const { GET } = route

const VOTER_COOKIE = "tc_voter"
const VALID_UUID = "11111111-1111-1111-1111-111111111111"

function ctx(checkId: string) {
  return { params: Promise.resolve({ checkId }) } as never
}

function getReq(cookieValue?: string) {
  return {
    cookies: {
      get: (name: string) => (name === VOTER_COOKIE && cookieValue ? { value: cookieValue } : undefined),
    },
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetSessionUser.mockResolvedValue(null) // anonymous by default
  mockGetVotesForCheck.mockResolvedValue([])
  mockGetVoterChoice.mockResolvedValue(null)
})

describe("GET /api/v1/tempcheck/[checkId] — unknown checkId", () => {
  it("400s with the repo's error envelope for a checkId that isn't in TEMP_CHECKS", async () => {
    // The plan for this lane assumed 404 for an unknown id; the route as
    // shipped treats an invalid checkId as a bad request (400/UNKNOWN_CHECK),
    // consistently on both GET and POST. Pinning the actual behavior rather
    // than the assumed one — see the PR body for the note.
    const res = await GET(getReq(), ctx("not-a-real-check"))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ ok: false, error: { code: "UNKNOWN_CHECK", message: "Unknown temperature check" } })
    expect(mockGetVotesForCheck).not.toHaveBeenCalled()
  })
})

describe("GET /api/v1/tempcheck/[checkId] — tally shape", () => {
  it("returns checkId/total/signed/options/yourVote, with options tallied from the real vote rows", async () => {
    mockGetVotesForCheck.mockResolvedValue([
      { optionKey: "all_three", signed: true },
      { optionKey: "all_three", signed: false },
      { optionKey: "no", signed: false },
    ])
    const res = await GET(getReq(), ctx("q1"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data.checkId).toBe("q1")
    expect(body.data.total).toBe(3)
    expect(body.data.signed).toBe(1)
    expect(body.data.options).toEqual([
      { key: "all_three", count: 2 },
      { key: "current_and_gateway", count: 0 },
      { key: "successor_only", count: 0 },
      { key: "no", count: 1 },
    ])
    expect(body.data.yourVote).toBeNull()
    expect(mockGetVotesForCheck).toHaveBeenCalledWith("q1")
  })

  it("reports every option at 0 for a check with no votes yet, rather than omitting them", async () => {
    const res = await GET(getReq(), ctx("q2"))
    const body = await res.json()
    expect(body.data.total).toBe(0)
    expect(body.data.signed).toBe(0)
    expect(body.data.options).toEqual([
      { key: "guild", count: 0 },
      { key: "new_association", count: 0 },
      { key: "dao", count: 0 },
      { key: "none", count: 0 },
    ])
  })

  it("looks up yourVote from the httpOnly cookie when it's a well-formed UUID", async () => {
    mockGetVoterChoice.mockResolvedValue("all_three")
    const res = await GET(getReq(VALID_UUID), ctx("q1"))
    const body = await res.json()
    expect(mockGetVoterChoice).toHaveBeenCalledWith("q1", VALID_UUID)
    expect(body.data.yourVote).toBe("all_three")
  })

  it("ignores a cookie value that isn't UUID-shaped — never looks it up, never trusts it", async () => {
    const res = await GET(getReq("not-a-uuid"), ctx("q1"))
    const body = await res.json()
    expect(mockGetVoterChoice).not.toHaveBeenCalled()
    expect(body.data.yourVote).toBeNull()
  })
})

describe("/api/v1/tempcheck/[checkId] — the poll is closed", () => {
  it("exports no vote handler at all: the write path is gone, not disabled", () => {
    // The page stopped rendering the widget on 2026-10-12 and this endpoint
    // stopped accepting votes in the same change. Asserting the ABSENCE of
    // the export is what keeps a later refactor from quietly restoring a
    // write path to a poll nobody reads: a reinstated POST fails here.
    expect("POST" in route).toBe(false)
    expect(Object.keys(route).sort()).toEqual(["GET"])
  })

  it("still reads tallies, so the recorded zero stays checkable", async () => {
    mockGetVotesForCheck.mockResolvedValue([])
    mockGetVoterChoice.mockResolvedValue(null)
    const res = await GET(getReq(), ctx("q1"))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.total).toBe(0)
    expect(body.data.options.every((o: { count: number }) => o.count === 0)).toBe(true)
  })
})
