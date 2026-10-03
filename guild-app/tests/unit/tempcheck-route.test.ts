/**
 * Route-level HTTP tests for GET/POST /api/v1/tempcheck/[checkId] — the
 * /lights-on temperature-check voting endpoint (shipped 2026-09-05).
 *
 * tempcheck-tally.test.ts already pins the query layer's pure tally shaping
 * and the upsert's generated SQL directly. This file drives the route
 * handlers themselves the way an HTTP client would — mocking only the
 * DB-touching query functions (getVotesForCheck/getVoterChoice/upsertVote)
 * while keeping tallyVotes/countSigned REAL, so a tally-shape assertion here
 * proves the route composes them correctly end to end, not just that it
 * calls a mock. Mocking/handler-invocation style follows tasks-id-route.test.ts
 * (vi.hoisted mocks, Promise-wrapped params ctx) and quote-xrd-usd-route.test.ts
 * (import-after-mocks, one describe block per behavior).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

process.env.DATABASE_URL ??= "postgres://dummy:dummy@127.0.0.1:5432/dummy"

const { mockGetVotesForCheck, mockGetVoterChoice, mockUpsertVote } = vi.hoisted(() => ({
  mockGetVotesForCheck: vi.fn(),
  mockGetVoterChoice: vi.fn(),
  mockUpsertVote: vi.fn(),
}))

vi.mock("@/db/queries/tempcheck", async () => {
  const actual = await vi.importActual<typeof import("@/db/queries/tempcheck")>("@/db/queries/tempcheck")
  return {
    ...actual,
    getVotesForCheck: mockGetVotesForCheck,
    getVoterChoice: mockGetVoterChoice,
    upsertVote: mockUpsertVote,
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
import { GET, POST } from "@/app/api/v1/tempcheck/[checkId]/route"

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

function postReq(rawBody: string | null, cookieValue?: string) {
  return {
    text: async () => rawBody ?? "",
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
  mockUpsertVote.mockResolvedValue(undefined)
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

describe("POST /api/v1/tempcheck/[checkId] — unknown checkId", () => {
  it("400s before touching the body or the DB", async () => {
    const res = await POST(postReq(JSON.stringify({ option: "all_three" })), ctx("nope"))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("UNKNOWN_CHECK")
    expect(mockUpsertVote).not.toHaveBeenCalled()
  })
})

describe("POST /api/v1/tempcheck/[checkId] — vote validation", () => {
  it("400s VALIDATION_ERROR on a missing body", async () => {
    const res = await POST(postReq(null), ctx("q1"))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("VALIDATION_ERROR")
    expect(mockUpsertVote).not.toHaveBeenCalled()
  })

  it("400s INVALID_BODY on malformed JSON", async () => {
    const res = await POST(postReq("{not json"), ctx("q1"))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("INVALID_BODY")
    expect(mockUpsertVote).not.toHaveBeenCalled()
  })

  it("400s VALIDATION_ERROR when option is missing from an otherwise-valid JSON body", async () => {
    const res = await POST(postReq(JSON.stringify({})), ctx("q1"))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("VALIDATION_ERROR")
    expect(mockUpsertVote).not.toHaveBeenCalled()
  })

  it("400s VALIDATION_ERROR when option is the wrong type", async () => {
    const res = await POST(postReq(JSON.stringify({ option: 42 })), ctx("q1"))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("VALIDATION_ERROR")
    expect(mockUpsertVote).not.toHaveBeenCalled()
  })

  it("400s BODY_TOO_LARGE before even attempting to parse an oversized body", async () => {
    const res = await POST(postReq(JSON.stringify({ option: "a".repeat(2000) })), ctx("q1"))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("BODY_TOO_LARGE")
    expect(mockUpsertVote).not.toHaveBeenCalled()
  })

  it("400s UNKNOWN_OPTION for a well-formed option that isn't one of the check's real options", async () => {
    const res = await POST(postReq(JSON.stringify({ option: "not_a_real_option" })), ctx("q1"))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("UNKNOWN_OPTION")
    expect(mockUpsertVote).not.toHaveBeenCalled()
  })

  it("does not gate on Content-Type — a JSON body is parsed the same regardless of header", async () => {
    // The route reads raw text and JSON.parse()s it; it never inspects
    // req.headers for content-type. Pinned here so the assumption isn't
    // silently relied on elsewhere — there is no wrong-content-type 400 to
    // trigger because the route has no such check.
    const res = await POST(postReq(JSON.stringify({ option: "all_three" })), ctx("q1"))
    expect(res.status).toBe(200)
  })
})

describe("POST /api/v1/tempcheck/[checkId] — voter identity + idempotency", () => {
  // vi.clearAllMocks() in the top-level beforeEach clears call history but
  // does not undo a vi.spyOn's replacement implementation, so a spy left in
  // place by one test would otherwise leak a fixed randomUUID() into the next.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("mints a fresh UUID and sets the tc_voter cookie on a browser's first vote", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(VALID_UUID as ReturnType<typeof crypto.randomUUID>)
    const res = await POST(postReq(JSON.stringify({ option: "all_three" })), ctx("q1"))
    expect(res.status).toBe(200)
    expect(mockUpsertVote).toHaveBeenCalledWith(
      expect.objectContaining({ checkId: "q1", optionKey: "all_three", voterKey: VALID_UUID }),
    )
    expect(res.cookies.get(VOTER_COOKIE)?.value).toBe(VALID_UUID)
  })

  it("reuses the SAME voterKey on a repeat vote from the same browser — no new identity minted", async () => {
    const randomUUIDSpy = vi.spyOn(crypto, "randomUUID")
    const res = await POST(postReq(JSON.stringify({ option: "no" }), VALID_UUID), ctx("q1"))
    expect(res.status).toBe(200)
    expect(randomUUIDSpy).not.toHaveBeenCalled()
    expect(mockUpsertVote).toHaveBeenCalledWith(expect.objectContaining({ voterKey: VALID_UUID, optionKey: "no" }))
    expect(res.cookies.get(VOTER_COOKIE)?.value).toBe(VALID_UUID)
  })

  it("changing a vote upserts the new option under the same voterKey (re-vote-replaces, not a second row)", async () => {
    const res1 = await POST(postReq(JSON.stringify({ option: "all_three" }), VALID_UUID), ctx("q1"))
    const res2 = await POST(postReq(JSON.stringify({ option: "no" }), VALID_UUID), ctx("q1"))
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
    expect(mockUpsertVote).toHaveBeenCalledTimes(2)
    expect(mockUpsertVote).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ voterKey: VALID_UUID, optionKey: "all_three" }),
    )
    expect(mockUpsertVote).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ voterKey: VALID_UUID, optionKey: "no" }),
    )
    const body2 = await res2.json()
    expect(body2.data.yourVote).toBe("no")
  })

  it("treats a malformed existing cookie as absent and mints a new identity instead of trusting it", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(VALID_UUID as ReturnType<typeof crypto.randomUUID>)
    const res = await POST(postReq(JSON.stringify({ option: "all_three" }), "not-a-uuid"), ctx("q1"))
    expect(mockUpsertVote).toHaveBeenCalledWith(expect.objectContaining({ voterKey: VALID_UUID }))
    expect(res.cookies.get(VOTER_COOKIE)?.value).toBe(VALID_UUID)
  })
})

describe("POST /api/v1/tempcheck/[checkId] — auth is optional, not required", () => {
  it("accepts an anonymous vote (no session) — signed:false, userId:null, no 401", async () => {
    mockGetSessionUser.mockResolvedValue(null)
    const res = await POST(postReq(JSON.stringify({ option: "all_three" })), ctx("q1"))
    expect(res.status).toBe(200)
    expect(mockUpsertVote).toHaveBeenCalledWith(expect.objectContaining({ signed: false, userId: null }))
  })

  it("stamps signed:true and the session's userId when the voter is signed in", async () => {
    mockGetSessionUser.mockResolvedValue({ userId: "account_rdx1voter" })
    const res = await POST(postReq(JSON.stringify({ option: "all_three" })), ctx("q1"))
    expect(res.status).toBe(200)
    expect(mockUpsertVote).toHaveBeenCalledWith(
      expect.objectContaining({ signed: true, userId: "account_rdx1voter" }),
    )
  })

  it("GET never calls getSessionUser at all — no auth gate on the read path", async () => {
    const res = await GET(getReq(), ctx("q1"))
    expect(res.status).toBe(200)
    expect(mockGetSessionUser).not.toHaveBeenCalled()
  })
})

// This route never touches the Radix Gateway (it is pure DB + cookie state),
// so there is no halt-era pinned-read behavior to exercise here — see
// reference_gateway_pinned_reads_during_halt for the routes that DO.
