import { describe, it, expect } from "vitest"
import {
  getReputationLevel,
  getReputationLabel,
  pointsForTaskCompletion,
  pointsToNextLevel,
  canClaimDifficulty,
  checkNewBadges,
  type ContributorStats,
} from "@/lib/reputation"

describe("getReputationLevel", () => {
  it("returns newcomer for 0", () => {
    expect(getReputationLevel(0)).toBe("newcomer")
  })

  it("returns newcomer for 50", () => {
    expect(getReputationLevel(50)).toBe("newcomer")
  })

  it("returns contributor for 51", () => {
    expect(getReputationLevel(51)).toBe("contributor")
  })

  it("returns builder for 201", () => {
    expect(getReputationLevel(201)).toBe("builder")
  })

  it("returns expert for 501", () => {
    expect(getReputationLevel(501)).toBe("expert")
  })

  it("returns master for 1001", () => {
    expect(getReputationLevel(1001)).toBe("master")
  })

  it("returns newcomer for negative score", () => {
    expect(getReputationLevel(-10)).toBe("newcomer")
  })
})

describe("getReputationLabel", () => {
  it("returns correct label for each level", () => {
    expect(getReputationLabel(0)).toBe("Newcomer")
    expect(getReputationLabel(100)).toBe("Contributor")
    expect(getReputationLabel(300)).toBe("Builder")
    expect(getReputationLabel(600)).toBe("Expert")
    expect(getReputationLabel(1500)).toBe("Master")
  })
})

describe("pointsForTaskCompletion", () => {
  it("returns base * multiplier for each difficulty", () => {
    expect(pointsForTaskCompletion("easy")).toBe(10)
    expect(pointsForTaskCompletion("medium")).toBe(20)
    expect(pointsForTaskCompletion("hard")).toBe(40)
    expect(pointsForTaskCompletion("expert")).toBe(80)
  })
})

describe("pointsToNextLevel", () => {
  it("returns progress to next level for newcomer", () => {
    const result = pointsToNextLevel(25)
    expect(result.currentLevel).toBe("newcomer")
    expect(result.nextLevel).toBe("contributor")
    expect(result.pointsNeeded).toBe(26)
    expect(result.progress).toBeGreaterThan(0)
  })

  it("returns null nextLevel and 100% progress for master", () => {
    const result = pointsToNextLevel(2000)
    expect(result.currentLevel).toBe("master")
    expect(result.nextLevel).toBeNull()
    expect(result.pointsNeeded).toBe(0)
    expect(result.progress).toBe(100)
  })

  it("returns 0 progress at level boundary start", () => {
    const result = pointsToNextLevel(0)
    expect(result.currentLevel).toBe("newcomer")
    expect(result.progress).toBe(0)
  })
})

describe("canClaimDifficulty", () => {
  it("allows newcomer to claim easy tasks", () => {
    expect(canClaimDifficulty(0, "easy")).toBe(true)
  })

  it("prevents newcomer from claiming medium tasks", () => {
    expect(canClaimDifficulty(0, "medium")).toBe(false)
  })

  it("allows master to claim any difficulty", () => {
    expect(canClaimDifficulty(1500, "easy")).toBe(true)
    expect(canClaimDifficulty(1500, "expert")).toBe(true)
  })

  it("allows exact level boundary", () => {
    expect(canClaimDifficulty(51, "medium")).toBe(true)
  })
})

describe("checkNewBadges", () => {
  const baseStats: ContributorStats = {
    tasksCompleted: 0,
    reviewsCompleted: 0,
    streak: 0,
    categoryCounts: {},
    votesCount: 0,
    disputesArbitrated: 0,
  }

  it("returns first_task badge when 1 task completed", () => {
    const badges = checkNewBadges({ ...baseStats, tasksCompleted: 1 }, [])
    expect(badges.some((b) => b.badge === "first_task")).toBe(true)
  })

  it("does not return already-earned badges", () => {
    const badges = checkNewBadges({ ...baseStats, tasksCompleted: 1 }, ["first_task"])
    expect(badges.some((b) => b.badge === "first_task")).toBe(false)
  })

  it("returns streak badge when streak >= 5", () => {
    const badges = checkNewBadges({ ...baseStats, streak: 5 }, [])
    expect(badges.some((b) => b.badge === "streak_five")).toBe(true)
  })

  it("returns governor badge when votes >= 10", () => {
    const badges = checkNewBadges({ ...baseStats, votesCount: 10 }, [])
    expect(badges.some((b) => b.badge === "governor")).toBe(true)
  })
})
