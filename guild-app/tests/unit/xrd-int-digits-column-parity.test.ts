import { describe, it, expect } from "vitest"
import { XRD_MAX_INT_DIGITS, REWARD_SHAPE_RE } from "@/lib/marketplace"
import { tasks, fundingPools, taskContributions } from "@/db/schema"

/**
 * XRD_MAX_INT_DIGITS is not a taste number — it is `precision - scale` of the
 * columns these amounts land in. This reads that pair off the REAL drizzle
 * column metadata and fails if the constant stops equalling it.
 *
 * Why a gate and not a comment: the unbounded regex it replaced was written
 * beside a correct description of the column and still disagreed with it, which
 * is exactly the failure a comment cannot catch. If a migration widens
 * `numeric(38,18)` to `numeric(40,18)`, the constant is now too strict and this
 * goes red; if it narrows the column, the constant is now too loose — the
 * dangerous direction, the one that returns a 500 — and this goes red too.
 *
 * MUTATION-PROVEN 2026-09-18, in both directions: setting XRD_MAX_INT_DIGITS to
 * 19 or to 21 in marketplace.ts turns "matches every column" red naming the
 * column; changing `tasks.rewardXrd` to numeric(40,18) turns it red naming
 * `tasks.reward_xrd`. The regex round-trip below is what would have gone red
 * for the actual shipped defect: with the pre-fix `^\d+(\.\d{1,8})?$` the
 * constant still equalled 20 and every column check still passed, while the
 * regex accepted 21 digits.
 */

/** Every numeric XRD column a USER-SUPPLIED amount reaches through a schema
 *  that shares XRD_MAX_INT_DIGITS. Derived columns (pooled_xrd, insurance_xrd,
 *  refunded_xrd) are computed from these, never posted, so they are not the
 *  boundary this constant guards. */
const GUARDED_COLUMNS = [
  { label: "tasks.reward_xrd", column: tasks.rewardXrd },
  { label: "funding_pools.target_xrd", column: fundingPools.targetXrd },
  { label: "task_contributions.amount_xrd", column: taskContributions.amountXrd },
] as const

describe("XRD_MAX_INT_DIGITS is derived from the column, not chosen", () => {
  it.each(GUARDED_COLUMNS.map((c) => [c.label, c]))(
    "%s: precision - scale === XRD_MAX_INT_DIGITS",
    (_label, entry) => {
      const col = entry.column as unknown as { precision: number; scale: number }
      expect(typeof col.precision).toBe("number")
      expect(typeof col.scale).toBe("number")
      expect(col.precision - col.scale).toBe(XRD_MAX_INT_DIGITS)
    },
  )

  it("the columns agree with each other, so ONE constant is the right shape", () => {
    const widths = GUARDED_COLUMNS.map((c) => {
      const col = c.column as unknown as { precision: number; scale: number }
      return `${col.precision},${col.scale}`
    })
    expect(new Set(widths).size).toBe(1)
  })

  it("REWARD_SHAPE_RE enforces exactly that many integer digits", () => {
    // The round-trip the constant alone cannot prove: the shipped defect had a
    // correct constant beside a regex that ignored it.
    expect(REWARD_SHAPE_RE.test("9".repeat(XRD_MAX_INT_DIGITS))).toBe(true)
    expect(REWARD_SHAPE_RE.test("9".repeat(XRD_MAX_INT_DIGITS + 1))).toBe(false)
  })
})
