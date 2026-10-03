/**
 * Exact fixed-point decimal-string arithmetic (src/lib/xrd-decimal.ts).
 * Pinned separately from funding-state-machine.test.ts because this is the
 * layer that must never regress to a JS `number` — see the float-bug
 * regression test below, which is the exact case
 * docs/design/funding-pool-blueprint.md §9 calls out by number.
 */
import { describe, it, expect } from "vitest"
import {
  addXrd,
  subXrd,
  compareXrd,
  eqXrd,
  ltXrd,
  lteXrd,
  gtXrd,
  gteXrd,
  isPositiveXrd,
  isAtLeastXrd,
  normalizeXrd,
  ceilXrdMultiple,
  InvalidXrdAmountError,
} from "@/lib/xrd-decimal"

describe("addXrd / subXrd", () => {
  it("adds exactly at 18dp", () => {
    expect(addXrd("0.000000000000000001", "0.000000000000000001")).toBe(
      "0.000000000000000002",
    )
  })

  it("THE FLOAT-BUG REGRESSION: 839.42 + 141.78 + 18.80 === 1000, exactly", () => {
    // `839.42 + 141.78 + 18.80` in native JS number arithmetic is
    // 999.9999999999999 (off in the 13th decimal place) — the exact bug
    // funding-pool-blueprint.md §9 names as the reason this module exists.
    const sum = addXrd(addXrd("839.42", "141.78"), "18.80")
    expect(sum).toBe("1000")
    expect(eqXrd(sum, "1000")).toBe(true)
    // Demonstrate the bug this guards against, so the guard can't silently
    // stop meaning anything if someone "simplifies" the module to `Number()`.
    expect(839.42 + 141.78 + 18.8).not.toBe(1000)
  })

  it("subtracts exactly, including into negative (no clamping)", () => {
    expect(subXrd("5", "5")).toBe("0")
    expect(subXrd("5", "7")).toBe("-2")
  })

  it("round-trips a value with more fractional digits than the operands started with", () => {
    expect(addXrd("0.1", "0.2")).toBe("0.3")
  })
})

describe("compareXrd / eq / lt / lte / gt / gte", () => {
  it("treats differently-padded equal values as equal", () => {
    expect(compareXrd("5", "5.000")).toBe(0)
    expect(eqXrd("5.0", "5")).toBe(true)
  })
  it("orders correctly across magnitudes", () => {
    expect(compareXrd("9.999999999999999999", "10")).toBe(-1)
    expect(ltXrd("9.999999999999999999", "10")).toBe(true)
    expect(gtXrd("10", "9.999999999999999999")).toBe(true)
  })
  it("lte/gte are inclusive at equality", () => {
    expect(lteXrd("5", "5")).toBe(true)
    expect(gteXrd("5", "5")).toBe(true)
  })
  it("handles negatives correctly", () => {
    expect(ltXrd("-1", "0")).toBe(true)
    expect(gtXrd("0", "-0.000000000000000001")).toBe(true)
  })
})

describe("isPositiveXrd", () => {
  it("is true only for a syntactically valid, strictly positive amount", () => {
    expect(isPositiveXrd("0.000000000000000001")).toBe(true)
    expect(isPositiveXrd("1")).toBe(true)
  })
  it("is false for zero, negative, and garbage — never throws", () => {
    expect(isPositiveXrd("0")).toBe(false)
    expect(isPositiveXrd("0.000")).toBe(false)
    expect(isPositiveXrd("-1")).toBe(false)
    expect(isPositiveXrd("NaN")).toBe(false)
    expect(isPositiveXrd("1e10")).toBe(false)
    expect(isPositiveXrd("")).toBe(false)
    expect(isPositiveXrd("abc")).toBe(false)
  })
})

describe("isAtLeastXrd", () => {
  it("is an exact, INCLUSIVE floor — a tie at 18dp is decided correctly", () => {
    expect(isAtLeastXrd("1", "1")).toBe(true)
    expect(isAtLeastXrd("1.000", "1")).toBe(true)
    expect(isAtLeastXrd("1.000000000000000001", "1")).toBe(true)
    expect(isAtLeastXrd("0.999999999999999999", "1")).toBe(false) // Number() rounds this to 1
    expect(isAtLeastXrd("0.5", "1")).toBe(false)
    expect(isAtLeastXrd("0", "1")).toBe(false)
  })
  it("is false for garbage VALUES — never throws (it runs inside a zod refine on unvalidated input)", () => {
    for (const v of ["abc", "", "1e3", "NaN", " 5", "-1", "1.0000000000000000001"]) {
      expect(() => isAtLeastXrd(v, "1")).not.toThrow()
    }
    expect(isAtLeastXrd("abc", "1")).toBe(false)
    expect(isAtLeastXrd("1e3", "1")).toBe(false)
  })
  it("THROWS on a malformed `min` — that is a repo constant, and a bad one must be loud, not reject-everything", () => {
    expect(() => isAtLeastXrd("5", "one")).toThrow(InvalidXrdAmountError)
  })
})

describe("ceilXrdMultiple", () => {
  it("ceils a plain multiply to a whole XRD figure", () => {
    expect(ceilXrdMultiple("100", "0.05")).toBe("5")
    expect(ceilXrdMultiple("101", "0.05")).toBe("6") // 5.05 -> ceil -> 6
    expect(ceilXrdMultiple("40", "0.05")).toBe("2") // exact multiple, no bump
  })

  it("THE INSURANCE-FIGURE FLOAT-BUG REGRESSION: an 18-significant-digit " +
     "target must not round through Number() before the multiply", () => {
    // 100000000000000001 has one more significant digit than a JS double can
    // hold exactly — `Number(...)` silently rounds it down to
    // 100000000000000000 before any multiply runs, exactly the failure
    // src/app/api/v1/funding-pools/route.ts:114 had.
    const target = "100000000000000001"
    expect(ceilXrdMultiple(target, "0.05")).toBe("5000000000000001")
    // Demonstrate the float bug this guards against, so the guard can't
    // silently stop meaning anything if someone "simplifies" this back to
    // `Math.ceil(Number(target) * 0.05)`.
    expect(Math.ceil(Number(target) * 0.05)).toBe(5000000000000000)
  })

  it("supports a non-zero `decimals` for callers that don't want whole-unit rounding", () => {
    expect(ceilXrdMultiple("10", "0.05", 2)).toBe("0.5")
    expect(ceilXrdMultiple("1", "0.333333333333333333", 4)).toBe("0.3334")
  })

  it("does not bump an already-exact result", () => {
    expect(ceilXrdMultiple("0", "0.05")).toBe("0")
  })

  it("rejects a fractional-digit count outside the module's 0-18 range", () => {
    expect(() => ceilXrdMultiple("1", "0.05", 19)).toThrow(RangeError)
    expect(() => ceilXrdMultiple("1", "0.05", -1)).toThrow(RangeError)
  })
})

describe("normalizeXrd", () => {
  it("strips trailing zeros and normalizes representation", () => {
    expect(normalizeXrd("5.000")).toBe("5")
    expect(normalizeXrd("05.10")).toBe("5.1")
    expect(normalizeXrd("0.00")).toBe("0")
  })
})

describe("invalid input", () => {
  it("throws InvalidXrdAmountError for non-decimal-string input, not NaN-poisoning", () => {
    expect(() => addXrd("abc", "1")).toThrow(InvalidXrdAmountError)
    expect(() => addXrd("1e10", "1")).toThrow(InvalidXrdAmountError)
    expect(() => addXrd("Infinity", "1")).toThrow(InvalidXrdAmountError)
    expect(() => addXrd("1.", "1")).toThrow(InvalidXrdAmountError)
  })
  it("throws for more than 18 fractional digits rather than silently truncating", () => {
    expect(() => addXrd("1.0000000000000000001", "0")).toThrow(InvalidXrdAmountError)
  })
})
