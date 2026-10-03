import { describe, it, expect } from "vitest"
import {
  trustTierFor,
  completionRate,
  onTimeRate,
  meetsMinTier,
  TRUST_THRESHOLDS,
  EMPTY_TRUST_STATS,
  type TrustStats,
} from "../../src/lib/trust"

// Tier thresholds are pilot-tunable config (TASK-TERMS-DESIGN §4.1 / §7 Q3) —
// these tests pin today's boundaries so a retune is a deliberate edit here too.

const stats = (overrides: Partial<TrustStats>): TrustStats => ({
  ...EMPTY_TRUST_STATS,
  ...overrides,
})

describe("trustTierFor — ladder boundaries", () => {
  it("a fresh identity is new", () => {
    expect(trustTierFor(EMPTY_TRUST_STATS)).toBe("new")
  })

  it("established at exactly 5 completed, not 4", () => {
    expect(trustTierFor(stats({ completed: 4 }))).toBe("new")
    expect(trustTierFor(stats({ completed: 5 }))).toBe("established")
  })

  it("top rated at exactly 15 completed, not 14", () => {
    expect(trustTierFor(stats({ completed: 14 }))).toBe("established")
    expect(trustTierFor(stats({ completed: 15 }))).toBe("top_rated")
  })

  it("any dispute-against pins the identity at new (until arbiters exist)", () => {
    expect(trustTierFor(stats({ completed: 20, disputesAgainst: 1 }))).toBe("new")
  })

  it("disputes RAISED do not block tiers (raising is a right, not a smell)", () => {
    expect(trustTierFor(stats({ completed: 15, disputesRaised: 3 }))).toBe("top_rated")
  })

  it("top rated requires ≥95% on-time when deadline data exists", () => {
    // 18/20 = 90% → capped at established; 19/20 = 95% → top rated.
    expect(
      trustTierFor(stats({ completed: 15, deadlineSubmits: 20, onTimeSubmits: 18 })),
    ).toBe("established")
    expect(
      trustTierFor(stats({ completed: 15, deadlineSubmits: 20, onTimeSubmits: 19 })),
    ).toBe("top_rated")
  })

  it("no deadlined work at all does not block top rated (absence ≠ lateness)", () => {
    expect(trustTierFor(stats({ completed: 15, deadlineSubmits: 0 }))).toBe("top_rated")
  })

  it("reads thresholds from the exported config", () => {
    expect(
      trustTierFor(stats({ completed: TRUST_THRESHOLDS.established.minCompleted })),
    ).toBe("established")
  })
})

describe("rates", () => {
  it("completionRate uses terminal outcomes only and nulls on no record", () => {
    expect(completionRate(stats({}))).toBeNull()
    // 3 paid, 1 refunded, claims in flight don't dilute the rate.
    expect(completionRate(stats({ completed: 3, failed: 1, claimed: 10 }))).toBe(0.75)
  })

  it("onTimeRate nulls when no deadlined submissions exist", () => {
    expect(onTimeRate(stats({}))).toBeNull()
    expect(onTimeRate(stats({ deadlineSubmits: 4, onTimeSubmits: 3 }))).toBe(0.75)
  })
})

describe("meetsMinTier — the claim-gate comparison (terms setting 18)", () => {
  it("orders new < established < top_rated", () => {
    expect(meetsMinTier("new", "established")).toBe(false)
    expect(meetsMinTier("established", "established")).toBe(true)
    expect(meetsMinTier("established", "top_rated")).toBe(false)
    expect(meetsMinTier("top_rated", "established")).toBe(true)
    expect(meetsMinTier("new", "new")).toBe(true)
  })
})
