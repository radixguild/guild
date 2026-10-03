/**
 * Route-level audit assertions for /api/v1/game/* :
 *  - CRITICAL-001: identity is the session user; no [address] in any path.
 *  - CRITICAL-004: the roll endpoint accepts NO client parameters.
 *  - HIGH-001:    no rolls remaining → 429 (the atomic guard's null path).
 *  - HIGH-003:    every route hard-503s when the game flag is off.
 *  - MEDIUM-002/003 (opportunistic): leaderboard truncates addresses + caps limit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { formatAddress } from "@/lib/marketplace-utils"

const SESSION = "account_rdx1me"

// withAuth → inject a fixed session user (identity never comes from the request).
vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: SESSION } }),
}))

const { mockIsEnabled } = vi.hoisted(() => ({ mockIsEnabled: vi.fn() }))
vi.mock("@/lib/features", () => ({ isEnabled: mockIsEnabled }))

const { mockRollOnce, mockGetGameState, mockGameLeaderboard } = vi.hoisted(() => ({
  mockRollOnce: vi.fn(),
  mockGetGameState: vi.fn(),
  mockGameLeaderboard: vi.fn(),
}))
vi.mock("@/db/queries/game", () => ({
  rollOnce: mockRollOnce,
  getGameState: mockGetGameState,
  gameLeaderboard: mockGameLeaderboard,
}))

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => () => ({ ok: true }),
  rateLimitResponse: () =>
    new Response(JSON.stringify({ ok: false, error: { code: "RATE_LIMITED" } }), {
      status: 429,
    }),
}))

// Import AFTER mocks are registered.
import { POST as ROLL } from "@/app/api/v1/game/roll/route"
import { GET as STATE } from "@/app/api/v1/game/state/route"
import { GET as BOARD } from "@/app/api/v1/game/leaderboard/route"

const rollReq = (body = "") => ({ text: async () => body }) as never
const stateReq = {} as never
const boardReq = (qs = "") =>
  ({ url: `http://t/api/v1/game/leaderboard${qs}` }) as never
const ctx = { params: Promise.resolve({}) } as never

beforeEach(() => {
  vi.clearAllMocks()
  mockIsEnabled.mockReturnValue(true) // flag ON by default; OFF cases override
})

describe("POST /api/v1/game/roll", () => {
  it("503s when the game flag is off, without touching the roll logic (H-003)", async () => {
    mockIsEnabled.mockReturnValue(false)
    const res = await ROLL(rollReq(""), ctx)
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe("FEATURE_DISABLED")
    expect(mockRollOnce).not.toHaveBeenCalled()
  })

  it("rejects any non-empty body and never rolls (C-004 — no client params)", async () => {
    const res = await ROLL(rollReq('{"roll":6,"bonus_xp":100}'), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("BODY_NOT_ALLOWED")
    expect(mockRollOnce).not.toHaveBeenCalled()
  })

  it("returns 429 when no rolls remain today (H-001 null path)", async () => {
    mockRollOnce.mockResolvedValue(null)
    const res = await ROLL(rollReq(""), ctx)
    expect(res.status).toBe(429)
    expect((await res.json()).error.code).toBe("NO_ROLLS")
  })

  it("rolls for the SESSION user only, never an address from the request (C-001)", async () => {
    mockRollOnce.mockResolvedValue({
      roll: 6,
      bonus: 100,
      jackpot: true,
      state: { totalRolls: 3, totalBonusXp: 175, streakDays: 2, availableRolls: 1 },
    })
    const res = await ROLL(rollReq(""), ctx)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(mockRollOnce).toHaveBeenCalledTimes(1)
    expect(mockRollOnce).toHaveBeenCalledWith(SESSION)
    expect(json.data).toMatchObject({
      roll: 6,
      bonus_xp: 100,
      jackpot: true,
      total_bonus_xp: 175,
      available_rolls_remaining: 1,
    })
  })

  it("accepts an empty JSON object body", async () => {
    mockRollOnce.mockResolvedValue({
      roll: 1,
      bonus: 0,
      jackpot: false,
      state: { totalRolls: 1, totalBonusXp: 0, streakDays: 1, availableRolls: 2 },
    })
    const res = await ROLL(rollReq("{}"), ctx)
    expect(res.status).toBe(200)
    expect(mockRollOnce).toHaveBeenCalledWith(SESSION)
  })
})

describe("GET /api/v1/game/state", () => {
  it("503s when the flag is off (H-003)", async () => {
    mockIsEnabled.mockReturnValue(false)
    const res = await STATE(stateReq, ctx)
    expect(res.status).toBe(503)
    expect(mockGetGameState).not.toHaveBeenCalled()
  })

  it("returns zeros for a player with no row", async () => {
    mockGetGameState.mockResolvedValue(null)
    const res = await STATE(stateReq, ctx)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.data.total_rolls).toBe(0)
    expect(json.data.available_rolls_remaining).toBe(0)
    expect(mockGetGameState).toHaveBeenCalledWith(SESSION)
  })

  it("maps the stored row for the session user", async () => {
    mockGetGameState.mockResolvedValue({
      totalRolls: 9,
      totalBonusXp: 240,
      streakDays: 4,
      lastRollValue: 6,
      jackpots: 2,
      availableRolls: 1,
    })
    const json = await (await STATE(stateReq, ctx)).json()
    expect(json.data).toMatchObject({
      total_rolls: 9,
      total_bonus_xp: 240,
      streak_days: 4,
      last_roll_value: 6,
      jackpots: 2,
      available_rolls_remaining: 1,
    })
  })
})

describe("GET /api/v1/game/leaderboard", () => {
  it("503s when the flag is off (H-003)", async () => {
    mockIsEnabled.mockReturnValue(false)
    const res = await BOARD(boardReq(""), ctx)
    expect(res.status).toBe(503)
    expect(mockGameLeaderboard).not.toHaveBeenCalled()
  })

  it("caps the limit at 100 (M-003)", async () => {
    mockGameLeaderboard.mockResolvedValue([])
    await BOARD(boardReq("?limit=999"), ctx)
    expect(mockGameLeaderboard).toHaveBeenCalledWith(100)
  })

  it("defaults the limit to 50", async () => {
    mockGameLeaderboard.mockResolvedValue([])
    await BOARD(boardReq(""), ctx)
    expect(mockGameLeaderboard).toHaveBeenCalledWith(50)
  })

  it("400s on a non-numeric limit", async () => {
    const res = await BOARD(boardReq("?limit=abc"), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("INVALID_LIMIT")
  })

  it("truncates addresses so full addresses don't leak (M-002), via the shared formatAddress helper (T4)", async () => {
    const full = "account_rdx1verylongaddress0123456789abcdef"
    mockGameLeaderboard.mockResolvedValue([
      { userId: full, displayName: "Alice", totalBonusXp: 100, totalRolls: 5, jackpots: 1, streakDays: 2 },
    ])
    const json = await (await BOARD(boardReq(""), ctx)).json()
    expect(json.data[0].rank).toBe(1)
    expect(json.data[0].address).toBe(formatAddress(full))
    expect(json.data[0].address).not.toBe(full)
    expect(json.data[0].display_name).toBe("Alice")
  })
})
