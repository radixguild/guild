/**
 * Tests for the public marketplace stats surface (R1 bot unification):
 * getTaskStats (one group-by over tasks) and GET /api/v1/tasks/stats.
 *
 * Mocks the Drizzle db module at the chain level so the same mock serves the
 * query layer and the route handler that calls through it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockGroupBy } = vi.hoisted(() => ({
  mockGroupBy: vi.fn(),
}))

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        // getTaskStats now filters out swept stale-unfunded rows (notHiddenStale)
        // before the group-by, so the chain is select→from→where→groupBy.
        where: vi.fn(() => ({
          groupBy: mockGroupBy,
        })),
      })),
    })),
  },
}))

// Import AFTER mocking
import { getTaskStats } from "@/db/queries/tasks"
import { GET } from "@/app/api/v1/tasks/stats/route"

describe("getTaskStats", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("zero-fills every status and takes totalPaidXrd from the paid group", async () => {
    mockGroupBy.mockResolvedValue([
      { status: "open", count: 3, totalXrd: "450.00000000" },
      { status: "paid", count: 2, totalXrd: "125.50000000" },
      { status: "disputed", count: 1, totalXrd: "10.00000000" },
    ])

    const stats = await getTaskStats()

    expect(stats.counts).toEqual({
      open: 3,
      assigned: 0,
      submitted: 0,
      paid: 2,
      cancelled: 0,
      disputed: 1,
      refunded: 0,
    })
    // Only the released (paid) group's sum counts as money paid out.
    expect(stats.totalPaidXrd).toBe("125.50000000")
  })

  it("returns all-zero counts and '0' paid on an empty tasks table", async () => {
    mockGroupBy.mockResolvedValue([])

    const stats = await getTaskStats()

    expect(Object.values(stats.counts)).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(stats.totalPaidXrd).toBe("0")
  })
})

describe("GET /api/v1/tasks/stats — public, envelope shape", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns the stats in the { ok, data } envelope with no auth", async () => {
    mockGroupBy.mockResolvedValue([
      { status: "paid", count: 4, totalXrd: "200.00000000" },
    ])

    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.data.counts.paid).toBe(4)
    expect(json.data.counts.open).toBe(0)
    expect(json.data.totalPaidXrd).toBe("200.00000000")
  })

  it("maps a query failure to the standard 500 error envelope", async () => {
    mockGroupBy.mockRejectedValue(new Error("connection refused"))

    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.ok).toBe(false)
    expect(json.error.code).toBe("INTERNAL_ERROR")
  })
})
