/**
 * Route-level test for GET /api/v1/users/leaderboard (T4 / audit MEDIUM-002).
 *
 * Mirrors game-api.test.ts's convention: mock the query module, import the
 * route handler, invoke it with a minimal fake NextRequest. getLeaderboard()
 * itself is mocked here (and keeps returning full ids elsewhere — see
 * leaderboard-exclusion.pg.test.ts) — this file only proves the ROUTE
 * truncates the address before it reaches an unauthenticated caller, the
 * same way GET /api/v1/game/leaderboard already does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { formatAddress } from "@/lib/marketplace-utils"

const { mockGetLeaderboard } = vi.hoisted(() => ({ mockGetLeaderboard: vi.fn() }))
vi.mock("@/db/queries/users", () => ({ getLeaderboard: mockGetLeaderboard }))

// Import AFTER the mock is registered.
import { GET as BOARD } from "@/app/api/v1/users/leaderboard/route"

const boardReq = (qs = "") =>
  ({ url: `http://t/api/v1/users/leaderboard${qs}` }) as never

const ROW = {
  id: "account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw",
  displayName: "Alice",
  badgeTier: "member",
  reputation: 40,
  xp: 300,
  tasksCompleted: 3,
  tasksThisMonth: 1,
  xrdEarned: "300",
  xrdEarnedThisMonth: "100",
  disputesAgainst: 0,
  deadlineSubmits: 2,
  onTimeSubmits: 2,
  trustTier: "established",
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("GET /api/v1/users/leaderboard", () => {
  it("caps the limit at 100", async () => {
    mockGetLeaderboard.mockResolvedValue([])
    await BOARD(boardReq("?limit=999"))
    expect(mockGetLeaderboard).toHaveBeenCalledWith(100)
  })

  it("defaults the limit to 50", async () => {
    mockGetLeaderboard.mockResolvedValue([])
    await BOARD(boardReq(""))
    expect(mockGetLeaderboard).toHaveBeenCalledWith(50)
  })

  it("400s on a non-numeric limit", async () => {
    const res = await BOARD(boardReq("?limit=abc"))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("INVALID_LIMIT")
  })

  it("400s on a non-positive limit", async () => {
    const res = await BOARD(boardReq("?limit=0"))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("INVALID_LIMIT")
  })

  it("truncates the wallet address via the shared formatAddress helper so the full address never leaves the server (MEDIUM-002 / T4)", async () => {
    mockGetLeaderboard.mockResolvedValue([ROW])
    const json = await (await BOARD(boardReq(""))).json()

    expect(json.ok).toBe(true)
    expect(json.data[0].id).toBe(formatAddress(ROW.id))
    expect(json.data[0].id).not.toBe(ROW.id)
    expect(json.data[0].id).toBe("account_rdx1...k9u5mw")
  })

  it("leaves every other field on the row untouched", async () => {
    mockGetLeaderboard.mockResolvedValue([ROW])
    const json = await (await BOARD(boardReq(""))).json()

    expect(json.data[0]).toMatchObject({
      displayName: "Alice",
      badgeTier: "member",
      reputation: 40,
      xp: 300,
      tasksCompleted: 3,
      tasksThisMonth: 1,
      xrdEarned: "300",
      xrdEarnedThisMonth: "100",
      trustTier: "established",
    })
  })

  it("short addresses (below formatAddress's truncation threshold) pass through unchanged", async () => {
    mockGetLeaderboard.mockResolvedValue([{ ...ROW, id: "short_addr" }])
    const json = await (await BOARD(boardReq(""))).json()
    expect(json.data[0].id).toBe("short_addr")
  })
})
