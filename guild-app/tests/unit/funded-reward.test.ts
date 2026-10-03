import { describe, it, expect } from "vitest"
import { checkFundedReward, describeFundedRewardMismatch } from "@/lib/funded-reward"
import { XRD_ADDRESS } from "@/lib/radix"

/**
 * Funding parity — the reward a task row advertises vs what its escrow holds.
 * Called by the create confirm (refuses to link on anything but a match) and by
 * the drift watcher's pass 1 (alerts on a mismatch). The 2026-09-23 audit found
 * every live row in parity; these pin the check that keeps it that way.
 */
describe("checkFundedReward", () => {
  const OTHER = "resource_rdx1notxrdnotxrdnotxrdnotxrd"

  it("matches across decimal spellings: numeric(38,18) column vs the chain's Decimal", () => {
    expect(
      checkFundedReward(
        { rewardXrd: "765.000000000000000000", rewardResource: null },
        { rewardAmount: "765", rewardToken: XRD_ADDRESS },
      ),
    ).toEqual({ kind: "match", funded: "765" })
  })

  it("treats a missing rewardResource like NULL (= XRD)", () => {
    expect(
      checkFundedReward({ rewardXrd: "10.5" }, { rewardAmount: "10.5", rewardToken: XRD_ADDRESS }).kind,
    ).toBe("match")
  })

  it("flags an under-funded escrow — the row advertises more than is held", () => {
    expect(
      checkFundedReward({ rewardXrd: "6400" }, { rewardAmount: "1", rewardToken: XRD_ADDRESS }),
    ).toEqual({
      kind: "mismatch",
      advertised: "6400",
      advertisedToken: XRD_ADDRESS,
      funded: "1",
      fundedToken: XRD_ADDRESS,
    })
  })

  it("flags an over-funded escrow too — any difference, not just a shortfall", () => {
    expect(
      checkFundedReward({ rewardXrd: "500" }, { rewardAmount: "6400", rewardToken: XRD_ADDRESS }).kind,
    ).toBe("mismatch")
  })

  it("compares exactly at the 18th decimal place (a float compare would call these equal)", () => {
    expect(Number("1.000000000000000001") === Number("1")).toBe(true) // the trap
    expect(
      checkFundedReward({ rewardXrd: "1.000000000000000001" }, { rewardAmount: "1", rewardToken: XRD_ADDRESS })
        .kind,
    ).toBe("mismatch")
  })

  it("flags the right amount in the wrong token", () => {
    expect(
      checkFundedReward({ rewardXrd: "765", rewardResource: null }, { rewardAmount: "765", rewardToken: OTHER })
        .kind,
    ).toBe("mismatch")
  })

  it("accepts a non-XRD reward only when reward_resource names that exact resource", () => {
    expect(
      checkFundedReward({ rewardXrd: "5", rewardResource: OTHER }, { rewardAmount: "5", rewardToken: OTHER }).kind,
    ).toBe("match")
    expect(
      checkFundedReward({ rewardXrd: "5", rewardResource: OTHER }, { rewardAmount: "5", rewardToken: XRD_ADDRESS })
        .kind,
    ).toBe("mismatch")
  })

  it("is unreadable — never a match, never a mismatch — when the chain side is missing", () => {
    expect(checkFundedReward({ rewardXrd: "765" }, { rewardAmount: null, rewardToken: XRD_ADDRESS }).kind).toBe(
      "unreadable",
    )
    expect(checkFundedReward({ rewardXrd: "765" }, { rewardAmount: "765", rewardToken: null }).kind).toBe(
      "unreadable",
    )
  })

  it("is unreadable when a caller OMITS the chain fields (undefined), not a token called 'undefined'", () => {
    const omitted = { rewardAmount: "765" } as unknown as { rewardAmount: string; rewardToken: string | null }
    expect(checkFundedReward({ rewardXrd: "765" }, omitted).kind).toBe("unreadable")
  })

  it("is unreadable on a malformed decimal rather than throwing", () => {
    expect(checkFundedReward({ rewardXrd: "1e3" }, { rewardAmount: "1000", rewardToken: XRD_ADDRESS }).kind).toBe(
      "unreadable",
    )
  })
})

describe("describeFundedRewardMismatch", () => {
  it("names both amounts in canonical form and XRD by symbol", () => {
    const v = checkFundedReward(
      { rewardXrd: "6400.000000000000000000" },
      { rewardAmount: "1", rewardToken: XRD_ADDRESS },
    )
    if (v.kind !== "mismatch") throw new Error("expected a mismatch")
    expect(describeFundedRewardMismatch(v)).toBe("advertises 6400 XRD but the escrow holds 1 XRD")
  })

  it("prints a non-XRD token as its address rather than guessing a symbol", () => {
    const other = "resource_rdx1notxrdnotxrdnotxrdnotxrd"
    const v = checkFundedReward({ rewardXrd: "765" }, { rewardAmount: "765", rewardToken: other })
    if (v.kind !== "mismatch") throw new Error("expected a mismatch")
    expect(describeFundedRewardMismatch(v)).toBe(`advertises 765 XRD but the escrow holds 765 ${other}`)
  })
})
