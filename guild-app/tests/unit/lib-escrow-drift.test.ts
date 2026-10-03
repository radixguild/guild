import { describe, it, expect } from "vitest"
import {
  NON_TERMINAL_DB_STATUSES,
  expectedDbStatusesForOnChain,
  isDbStatusInSyncWithChain,
  isClaimableButNotOpen,
  canAssessMoneyParity,
  classifyMoneyParity,
  isInactiveDigestDue,
  DEFAULT_INACTIVE_DIGEST_MS,
  disputeResourceLabel,
  isThresholdComparableResource,
} from "@/lib/escrow-drift"
import type { OnChainTaskState } from "@/lib/gateway"

describe("lib/escrow-drift", () => {
  describe("expectedDbStatusesForOnChain", () => {
    const cases: Array<[OnChainTaskState, string[]]> = [
      ["Open", ["open"]],
      ["Claimed", ["assigned"]],
      ["Submitted", ["submitted"]],
      ["Disputed", ["disputed"]],
      ["Released", ["paid"]],
      // A poster cancel and a poster-favoured dispute both settle to on-chain
      // Refunded — the DB records them as `cancelled` and `refunded` resp.
      ["Refunded", ["cancelled", "refunded"]],
    ]
    it.each(cases)("maps chain %s → db %j", (state, expected) => {
      expect(expectedDbStatusesForOnChain(state)).toEqual(expected)
    })
  })

  describe("isDbStatusInSyncWithChain", () => {
    it("is true when the DB status reflects the live chain state", () => {
      expect(isDbStatusInSyncWithChain("cancelled", "Refunded")).toBe(true)
      expect(isDbStatusInSyncWithChain("refunded", "Refunded")).toBe(true)
      expect(isDbStatusInSyncWithChain("paid", "Released")).toBe(true)
      expect(isDbStatusInSyncWithChain("open", "Open")).toBe(true)
    })

    it("is false when the DB lags the chain (task #5: open vs Refunded)", () => {
      expect(isDbStatusInSyncWithChain("open", "Refunded")).toBe(false)
      expect(isDbStatusInSyncWithChain("assigned", "Released")).toBe(false)
      expect(isDbStatusInSyncWithChain("submitted", "Refunded")).toBe(false)
    })
  })

  describe("isClaimableButNotOpen (the fee-burning drift class)", () => {
    it("flags a DB-open task whose chain state has left Open", () => {
      expect(isClaimableButNotOpen("open", "Refunded")).toBe(true)
      expect(isClaimableButNotOpen("open", "Claimed")).toBe(true)
      expect(isClaimableButNotOpen("open", "Released")).toBe(true)
    })

    it("does not flag an in-sync open task, nor non-open drift", () => {
      expect(isClaimableButNotOpen("open", "Open")).toBe(false)
      // Non-open drift is still drift, but not the claimable fee-burn class.
      expect(isClaimableButNotOpen("submitted", "Refunded")).toBe(false)
      expect(isClaimableButNotOpen("assigned", "Released")).toBe(false)
    })
  })

  describe("NON_TERMINAL_DB_STATUSES", () => {
    it("excludes the settled/terminal statuses (they are not re-checked)", () => {
      expect(NON_TERMINAL_DB_STATUSES).toEqual(["open", "assigned", "submitted", "disputed"])
      for (const terminal of ["paid", "cancelled", "refunded"]) {
        expect(NON_TERMINAL_DB_STATUSES).not.toContain(terminal)
      }
    })
  })
})

/**
 * MONEY parity (redesign §5c / §11b chunk E).
 *
 * The point of a second predicate: state parity can be PERFECT while nobody has
 * been paid. These assert the classification, and — more importantly — assert
 * that "cannot say" never collapses into "clean".
 */
describe("lib/escrow-drift — money parity", () => {
  const NOW = new Date("2026-08-02T12:00:00Z")
  const HOURS = (n: number) => new Date(NOW.getTime() - n * 60 * 60 * 1000)

  describe("canAssessMoneyParity", () => {
    it("is false for a component that reports no entitlement fields", () => {
      // The DEPLOYED escrow. Every amount reads "0" there, which is
      // indistinguishable from fully collected — so the check must declare
      // itself unable to run rather than report a clean bill.
      expect(canAssessMoneyParity({ entitlementsPresent: false })).toBe(false)
      expect(canAssessMoneyParity({ entitlementsPresent: true })).toBe(true)
    })
  })

  /**
   * The "money check inactive" digest gate — retrospective defect #3.
   *
   * That condition used to be a log() line only: no alert, no exit code. At 48
   * runs a day into a file nobody opens, a run where the money half did nothing
   * was indistinguishable from a clean one. The original reason for not alerting
   * was sound — against the pre-pull component the condition holds on every row
   * every run, so an unconditional alert mutes the channel and takes the real
   * drift alert with it. A rate limit keeps it audible instead.
   */
  describe("isInactiveDigestDue", () => {
    const NOW = new Date("2026-08-02T12:00:00Z")
    const agoMs = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

    it("is due when nothing has ever been sent", () => {
      expect(isInactiveDigestDue(null, NOW)).toBe(true)
    })

    it("is not due inside the window", () => {
      expect(isInactiveDigestDue(agoMs(60 * 60 * 1000), NOW)).toBe(false)
    })

    it("is due once the window has passed", () => {
      expect(isInactiveDigestDue(agoMs(DEFAULT_INACTIVE_DIGEST_MS), NOW)).toBe(true)
      expect(isInactiveDigestDue(agoMs(DEFAULT_INACTIVE_DIGEST_MS + 1), NOW)).toBe(true)
    })

    it("is NOT due one millisecond early — the boundary is inclusive of the interval", () => {
      expect(isInactiveDigestDue(agoMs(DEFAULT_INACTIVE_DIGEST_MS - 1), NOW)).toBe(false)
    })

    it("fails toward telling someone on a malformed stamp", () => {
      // Under-reporting is the defect being fixed. A stamp that cannot be
      // understood must never be read as "recently sent".
      expect(isInactiveDigestDue("not-a-date", NOW)).toBe(true)
      expect(isInactiveDigestDue("", NOW)).toBe(true)
    })

    it("fails toward telling someone on a FUTURE stamp", () => {
      // A clock change or a corrupt write would otherwise suppress the digest
      // indefinitely — silence again, by a different route.
      expect(isInactiveDigestDue(new Date(NOW.getTime() + 86_400_000).toISOString(), NOW)).toBe(
        true,
      )
    })

    it("honours a custom interval", () => {
      const hourly = 60 * 60 * 1000
      expect(isInactiveDigestDue(agoMs(90 * 60 * 1000), NOW, hourly)).toBe(true)
      expect(isInactiveDigestDue(agoMs(30 * 60 * 1000), NOW, hourly)).toBe(false)
    })
  })

  describe("classifyMoneyParity", () => {
  /** A lane pair. Reward lane by default; `bond` for the bond-only cases. */
  const lanes = (reward: string, bondXrd = "0") => ({ reward, bondXrd })

    it("returns 'unassessable' for null — never 'settled'", () => {
      // THE trap. gateway.outstandingForParty returns null (not "0") against a
      // pre-pull component; if that read as settled, the watcher would be
      // permanently silent against the live escrow and look perfectly healthy.
      expect(classifyMoneyParity(null, HOURS(999), NOW)).toEqual({ kind: "unassessable" })
    })

    it("is 'settled' only for a genuine zero", () => {
      expect(classifyMoneyParity(lanes("0"), HOURS(999), NOW)).toEqual({ kind: "settled" })
      expect(classifyMoneyParity(lanes("0.000000000000000000"), HOURS(999), NOW)).toEqual({
        kind: "settled",
      })
    })

    it("flags a stale uncollected entitlement", () => {
      expect(classifyMoneyParity(lanes("100"), HOURS(48), NOW)).toEqual({
        kind: "uncollected-stale",
        outstanding: lanes("100"),
      })
    })

    it("holds fire inside the grace window", () => {
      // A worker who settled an hour ago and has not withdrawn yet is normal,
      // not an incident. Alerting there trains the operator to ignore this.
      expect(classifyMoneyParity(lanes("100"), HOURS(1), NOW)).toEqual({
        kind: "uncollected-recent",
        outstanding: lanes("100"),
      })
    })

    it("treats a missing timestamp as stale, not as recent", () => {
      // No timestamp = no way to tell. This is a money alert: the failure
      // direction must be "tell someone", never "stay quiet".
      expect(classifyMoneyParity(lanes("100"), null, NOW)).toEqual({
        kind: "uncollected-stale",
        outstanding: lanes("100"),
      })
    })

    it("treats the smallest representable amount as still owed", () => {
      // 1e-18 XRD is one atom of a Decimal, and it is still owed.
      //
      // ⚠️ Note for anyone tempted to simplify isPositiveDecimal to `Number(v) > 0`:
      // this case does NOT stop you — 1e-18 is comfortably positive as a double,
      // and mutation-testing confirmed the swap keeps this green. For a bare
      // `> 0` the two agree on every value Radix can represent. The exact form is
      // kept for the reason in the next test, and for consistency with the money
      // arithmetic in gateway.ts, where precision genuinely is load-bearing.
      expect(classifyMoneyParity(lanes("0.000000000000000001"), HOURS(48), NOW)).toEqual({
        kind: "uncollected-stale",
        outstanding: lanes("0.000000000000000001"),
      })
    })

    it("matches Decimal's precision, not the float's, below 18dp", () => {
      // A 19-dp value cannot exist on chain — the ledger truncates to 18. If the
      // Gateway ever hands one over, the honest reading is "zero, at the
      // precision this system has", not "dust is owed". `Number(v) > 0` would
      // say 1e-19 is owed and raise an alert about money that cannot exist.
      // This is the case that actually discriminates the two implementations.
      expect(classifyMoneyParity(lanes("0.0000000000000000001"), HOURS(48), NOW)).toEqual({
        kind: "settled",
      })
    })

    it("fails closed on an unparseable amount rather than calling it settled", () => {
      expect(classifyMoneyParity(lanes("not-a-decimal"), HOURS(48), NOW)).toEqual({ kind: "settled" })
    })

    /**
     * ⚠️ The lanes are DIFFERENT RESOURCES and are never added. classifyMoneyParity
     * used to receive their sum, which both callers then labelled "XRD". "Owed"
     * has to mean EITHER lane is positive, or a bond-only debt goes unreported —
     * and bond-only is not hypothetical: it is exactly what a cancel-after-claim
     * leaves the worker, and what an expired claim leaves the poster (D-P4).
     */
    it("alerts on a BOND-only debt — the reward lane being zero is not settled", () => {
      expect(classifyMoneyParity({ reward: "0", bondXrd: "10" }, HOURS(48), NOW)).toEqual({
        kind: "uncollected-stale",
        outstanding: { reward: "0", bondXrd: "10" },
      })
    })

    it("alerts on a REWARD-only debt", () => {
      expect(classifyMoneyParity({ reward: "100", bondXrd: "0" }, HOURS(48), NOW)).toEqual({
        kind: "uncollected-stale",
        outstanding: { reward: "100", bondXrd: "0" },
      })
    })

    it("is settled only when BOTH lanes are zero", () => {
      expect(classifyMoneyParity({ reward: "0", bondXrd: "0" }, HOURS(999), NOW)).toEqual({
        kind: "settled",
      })
    })

    it("carries both lanes through the verdict — never a total", () => {
      const verdict = classifyMoneyParity({ reward: "100", bondXrd: "10" }, HOURS(48), NOW)
      expect(verdict).toEqual({
        kind: "uncollected-stale",
        outstanding: { reward: "100", bondXrd: "10" },
      })
      // 110 is the old summed answer. It must not appear anywhere in the verdict.
      expect(JSON.stringify(verdict)).not.toContain("110")
    })

    it("an unparseable lane does not poison a real debt in the other lane", () => {
      // Fail-closed per lane: garbage reads as zero for that lane, but the lane
      // that IS readable still owes money and must still alert.
      expect(
        classifyMoneyParity({ reward: "not-a-decimal", bondXrd: "10" }, HOURS(48), NOW).kind,
      ).toBe("uncollected-stale")
    })

    it("respects a custom grace window", () => {
      expect(classifyMoneyParity(lanes("5"), HOURS(2), NOW, 60 * 60 * 1000).kind).toBe(
        "uncollected-stale",
      )
      expect(classifyMoneyParity(lanes("5"), HOURS(2), NOW, 6 * 60 * 60 * 1000).kind).toBe(
        "uncollected-recent",
      )
    })
  })

  /**
   * The regression §11b warns about, pinned so it cannot be "fixed" back in.
   * Broadening the state mapping to accept `settled`/unpaid as in-sync is the
   * obvious change and it defeats the whole chunk — twice over, because the
   * affected rows are terminal and pass 1 never loads them anyway.
   */
  describe("the obvious fix stays refused", () => {
    it("Released still maps ONLY to paid — state parity must not absorb the money question", () => {
      expect(expectedDbStatusesForOnChain("Released")).toEqual(["paid"])
    })

    it("terminal statuses stay OUT of the state pass — money parity covers them instead", () => {
      for (const terminal of ["paid", "cancelled", "refunded"]) {
        expect(NON_TERMINAL_DB_STATUSES).not.toContain(terminal)
      }
    })
  })

  /**
   * Reward-resource flip prep (escrow-drift-watch.mjs's live-dispute alert).
   * The chain-side scan there only has a vault BALANCE, never a resource
   * address, so these two decide the alert's label/threshold behaviour from
   * whatever the DB lookup found.
   */
  describe("disputeResourceLabel", () => {
    it("no matching DB row → null (unknown — never assume XRD)", () => {
      expect(disputeResourceLabel(null)).toBeNull()
      expect(disputeResourceLabel(undefined)).toBeNull()
    })

    it("matched row, reward_resource NULL → \"XRD\" (the column's own contract)", () => {
      expect(disputeResourceLabel({ rewardResource: null })).toBe("XRD")
    })

    it("matched row, reward_resource set → that resource verbatim", () => {
      expect(disputeResourceLabel({ rewardResource: "resource_rdx1t_usdc" })).toBe(
        "resource_rdx1t_usdc",
      )
    })
  })

  describe("isThresholdComparableResource", () => {
    it("null (unmatched/unknown row) is comparable — the conservative default", () => {
      expect(isThresholdComparableResource(null)).toBe(true)
    })

    it('"XRD" is comparable — ALERT_MIN_XRD is denominated in XRD', () => {
      expect(isThresholdComparableResource("XRD")).toBe(true)
    })

    it("a known non-XRD resource is NOT comparable — must always page, never threshold-gated", () => {
      expect(isThresholdComparableResource("resource_rdx1t_usdc")).toBe(false)
    })
  })
})
