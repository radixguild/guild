// "≈US$" beside an XRD ask on the swap pages (src/lib/nft-swap-usd.ts).
// Display only, and fail-soft: with no usable quote the answer is null, so the
// page shows no dollar text at all — never a zero, never a guess.
import { describe, it, expect } from "vitest"
import { approxUsd, usdTitle } from "@/lib/nft-swap-usd"

describe("approxUsd", () => {
  it("prices an XRD amount at the rate, to the cent, with a fixed US$ label", () => {
    expect(approxUsd("5000", { rate: 0.0006 })).toBe("≈US$3.00")
    expect(approxUsd("12.5", { rate: 0.04 })).toBe("≈US$0.50")
    expect(approxUsd("1000000", { rate: 0.05 })).toBe("≈US$50,000.00")
  })

  it("never rounds a real amount to US$0.00", () => {
    expect(approxUsd("1", { rate: 0.0006 })).toBe("<US$0.01")
    expect(approxUsd("0.000000000000000001", { rate: 0.0006 })).toBe("<US$0.01")
  })

  it.each([
    ["no rate", { rate: null }],
    ["an undefined rate", { rate: undefined }],
    ["a zero rate", { rate: 0 }],
    ["a negative rate", { rate: -1 }],
    ["a NaN rate", { rate: Number.NaN }],
    ["an infinite rate", { rate: Number.POSITIVE_INFINITY }],
    ["a stale quote, even with a normal-looking rate", { rate: 0.0006, stale: true }],
  ])("says nothing for %s", (_label, quote) => {
    expect(approxUsd("5000", quote)).toBeNull()
  })

  it.each(["0", "0.0", "", "abc", "-5", "1e3", "5,000", " 5", "5 "])("says nothing for the amount %j", (amount) => {
    expect(approxUsd(amount, { rate: 0.0006 })).toBeNull()
  })

  it("says nothing for an amount so large the product is not a price", () => {
    expect(approxUsd("123456789012345678901234567890", { rate: 0.0006 })).toBeNull()
    expect(approxUsd("9".repeat(400), { rate: 0.0006 })).toBeNull()
  })
})

describe("usdTitle", () => {
  it("says display only, XRD-settled, where the rate is from and how old it is", () => {
    const t = usdTitle("astrolescent", "3 min")
    expect(t).toContain("Display only")
    expect(t).toContain("set and paid in XRD")
    expect(t).toContain("Astrolescent")
    expect(t).toContain("updated 3 min ago")
    expect(usdTitle("coingecko", "moments")).toContain("CoinGecko")
  })

  it("does not name a source it does not know, and omits an unknown age", () => {
    const t = usdTitle("someone-else", null)
    expect(t).not.toContain("someone-else")
    expect(t).toContain("the site's price feed")
    expect(t).not.toContain("updated")
    expect(usdTitle(null, null)).toContain("the site's price feed")
  })
})
