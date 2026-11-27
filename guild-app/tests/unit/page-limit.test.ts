import { describe, it, expect } from "vitest"
import { clampPageLimit } from "@/db/queries/page-limit"

describe("clampPageLimit", () => {
  it("defaults missing, zero and NaN to 20", () => {
    expect(clampPageLimit(undefined)).toBe(20)
    expect(clampPageLimit(0)).toBe(20)
    expect(clampPageLimit(Number.NaN)).toBe(20)
    expect(clampPageLimit(Number.POSITIVE_INFINITY)).toBe(20)
  })
  it("floors negatives at 1 and caps at 100", () => {
    expect(clampPageLimit(-5)).toBe(1)
    expect(clampPageLimit(-0.5)).toBe(20) // truncates to 0 → default
    expect(clampPageLimit(101)).toBe(100)
  })
  it("passes valid values through, truncating fractions", () => {
    expect(clampPageLimit(1)).toBe(1)
    expect(clampPageLimit(50)).toBe(50)
    expect(clampPageLimit(7.9)).toBe(7)
  })
})
