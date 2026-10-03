import { describe, expect, test } from "vitest"
import { FUNDING_INSURANCE_FRACTION } from "@/lib/funding-config"
import { ceilXrdMultiple } from "@/lib/xrd-decimal"

/**
 * These pin a cross-file coupling that is invisible at the call site.
 *
 * `POST /api/v1/funding-pools` computes stored insurance as
 * `ceilXrdMultiple(target_xrd, String(FUNDING_INSURANCE_FRACTION))`. That
 * `String(...)` is a JS double -> decimal-string conversion, and
 * `ceilXrdMultiple` REJECTS strings it cannot parse as fixed-point.
 * `Number#toString` switches to exponential notation below 1e-6 ("5e-7"), and
 * `toFixedPoint` also rejects more than 18 fractional digits.
 *
 * So editing this constant in funding-config.ts — a file with no obvious tie to
 * the money path — can break every pool creation at runtime. This asserts the
 * coupling holds, so that edit fails here instead of in production.
 */
describe("FUNDING_INSURANCE_FRACTION is safe to stringify into ceilXrdMultiple", () => {
  test("its string form is plain decimal, never exponential", () => {
    const asString = String(FUNDING_INSURANCE_FRACTION)
    expect(asString).not.toMatch(/e/i)
    expect(asString).toMatch(/^\d+(\.\d{1,18})?$/)
  })

  test("ceilXrdMultiple accepts that string form rather than throwing", () => {
    expect(() => ceilXrdMultiple("100", String(FUNDING_INSURANCE_FRACTION))).not.toThrow()
  })

  test("the fraction is a real fraction — insurance must never exceed the target", () => {
    expect(FUNDING_INSURANCE_FRACTION).toBeGreaterThan(0)
    expect(FUNDING_INSURANCE_FRACTION).toBeLessThanOrEqual(1)
  })
})
