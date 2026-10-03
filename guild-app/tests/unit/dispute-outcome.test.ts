/**
 * The dispute-payout numbers, pinned against the blueprint.
 *
 * These assertions exist because SIX shipped strings got this wrong and each
 * one was written by hand. The point of the module under test is that the
 * numbers are derived; the point of this file is that the derivation matches
 * `credit_split_for_parties` in escrow/.../src/lib.rs and cannot quietly stop
 * matching it.
 *
 * Each case names the lib.rs behaviour it encodes, so a reader can check the
 * test against the Rust rather than against the TypeScript it is testing.
 */
import { describe, it, expect } from "vitest"
import {
  AUTO_RESOLVE_DEFAULT,
  AUTO_RESOLVE_WORKER_REWARD_PCT,
  autoResolveCredits,
  posterCostOnAutoResolve,
} from "@/lib/dispute-outcome"
import { INSURANCE_RATE } from "@/lib/marketplace"

describe("auto-resolved dispute credits", () => {
  it("the live default is SplitEvenly and it governs the reward at 50%", () => {
    // lib.rs: AutoResolveDefault::SplitEvenly => DisputeRuling::Split {
    //           worker_pct: dec!("0.5"), poster_pct: dec!("0.5") }
    expect(AUTO_RESOLVE_DEFAULT).toBe("SplitEvenly")
    expect(AUTO_RESOLVE_WORKER_REWARD_PCT).toBe(0.5)
  })

  it("the insurance NEVER reaches the worker — it is hardcoded RefundPoster", () => {
    // lib.rs auto_resolve_dispute passes `&DisputeRuling::RefundPoster` as the
    // insurance_ruling, and worker_share(RefundPoster, _) === Decimal::ZERO.
    // This is the anti-griefing property, so it is asserted at several sizes
    // rather than once: the worker's credit must equal HALF THE REWARD exactly,
    // with no insurance component, whatever the insurance is.
    for (const [reward, insurance] of [
      [100, 5],
      [1500, 75],
      [3, 1],
      [100, 500], // absurd insurance: still none of it moves
    ]) {
      const c = autoResolveCredits(reward, insurance)
      expect(c.worker).toBe(reward / 2)
      expect(c.poster).toBe(reward / 2 + insurance)
    }
  })

  it("the worked example the /money page quotes: 100 XRD + 5 XRD insurance", () => {
    // The shipped copy said "~52 XRD of exposure" — that is half of the
    // COMBINED 105, i.e. exactly the error of splitting both vaults. The true
    // figure is 50: the poster gets half the reward AND all of the insurance.
    const c = autoResolveCredits(100, 5)
    expect(c.funded).toBe(105)
    expect(c.worker).toBe(50)
    expect(c.poster).toBe(55)
    expect(c.posterCost).toBe(50)
    expect(c.posterCost).not.toBe(52.5)
  })

  it("derives the insurance from INSURANCE_RATE when it is not supplied", () => {
    // create_task's floor is min_insurance_fraction = 0.05 and the app rounds
    // up (escrow-utils.ts: Math.ceil(reward * INSURANCE_RATE)), so a 30 XRD
    // task carries 2 XRD, not 1.5.
    expect(INSURANCE_RATE).toBe(0.05)
    expect(autoResolveCredits(30).insurance).toBe(2)
    expect(autoResolveCredits(100).insurance).toBe(5)
  })

  it("value is conserved — credits always sum to what was funded", () => {
    // The poster's share is the REMAINDER of the combined bucket in lib.rs, so
    // nothing can be stranded or minted by this arithmetic.
    for (const reward of [1, 7, 33, 100, 999, 1500]) {
      const c = autoResolveCredits(reward)
      expect(c.worker + c.poster).toBe(c.funded)
    }
  })

  it("posterCostOnAutoResolve equals the worker's credit, by construction", () => {
    // If these two ever diverge, the insurance has started moving and the
    // anti-griefing property is gone.
    for (const reward of [10, 100, 1500]) {
      expect(posterCostOnAutoResolve(reward)).toBe(autoResolveCredits(reward).worker)
    }
  })
})
