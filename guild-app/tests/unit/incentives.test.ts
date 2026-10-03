import { describe, it, expect } from "vitest"
import {
  getTierForReward,
  calculateBonus,
  INCENTIVE_TIERS,
} from "@/lib/incentives"

describe("getTierForReward", () => {
  it("returns easy tier for small rewards", () => {
    expect(getTierForReward(1).difficulty).toBe("easy")
    expect(getTierForReward(5).difficulty).toBe("easy")
  })

  it("returns medium tier for mid-range rewards", () => {
    expect(getTierForReward(10).difficulty).toBe("medium")
    expect(getTierForReward(30).difficulty).toBe("medium")
  })

  it("returns hard tier for large rewards", () => {
    expect(getTierForReward(50).difficulty).toBe("hard")
    expect(getTierForReward(100).difficulty).toBe("hard")
  })

  it("returns expert tier for very large rewards", () => {
    expect(getTierForReward(200).difficulty).toBe("expert")
    expect(getTierForReward(1000).difficulty).toBe("expert")
  })

  it("returns easy tier for zero reward", () => {
    expect(getTierForReward(0).difficulty).toBe("easy")
  })

  it("returns easy tier for negative reward", () => {
    expect(getTierForReward(-1).difficulty).toBe("easy")
  })
})

describe("calculateBonus", () => {
  it("returns base reward with no bonuses when no opts match", () => {
    const result = calculateBonus(100, {})
    expect(result.total).toBe(100)
    expect(result.bonuses).toHaveLength(0)
  })

  it("applies 20% fast completion bonus when ratio <= 0.25", () => {
    const result = calculateBonus(100, { estimatedHours: 10, actualHours: 2 })
    expect(result.total).toBe(120)
    expect(result.bonuses).toContain("Fast completion (+20%)")
  })

  it("applies 10% fast completion bonus when ratio <= 0.5", () => {
    const result = calculateBonus(100, { estimatedHours: 10, actualHours: 5 })
    expect(result.total).toBe(110)
    expect(result.bonuses).toContain("Fast completion (+10%)")
  })

  it("does not apply fast completion bonus when ratio > 0.5", () => {
    const result = calculateBonus(100, { estimatedHours: 10, actualHours: 8 })
    expect(result.total).toBe(100)
    expect(result.bonuses).toHaveLength(0)
  })

  it("applies streak bonus when consecutiveCompleted >= threshold", () => {
    const result = calculateBonus(100, { consecutiveCompleted: 5 })
    expect(result.total).toBe(110)
    expect(result.bonuses[0]).toContain("Streak")
  })

  it("applies both bonuses when both conditions met", () => {
    const result = calculateBonus(100, {
      estimatedHours: 10,
      actualHours: 2,
      consecutiveCompleted: 5,
    })
    // 100 * 1.2 * 1.1 = 132
    expect(result.total).toBe(132)
    expect(result.bonuses).toHaveLength(2)
  })

  it("handles estimatedHours = 0 without division by zero", () => {
    const result = calculateBonus(100, { estimatedHours: 0, actualHours: 5 })
    expect(result.total).toBe(100)
    expect(result.bonuses).toHaveLength(0)
  })

  it("rounds to 2 decimal places", () => {
    const result = calculateBonus(33, { estimatedHours: 10, actualHours: 2 })
    // 33 * 1.2 = 39.6
    expect(result.total).toBe(39.6)
  })
})
