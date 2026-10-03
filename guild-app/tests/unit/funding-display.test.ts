/**
 * The community-funding presentation layer (src/lib/funding-display.ts).
 *
 * The point of these tests is NOT that a progress bar renders — it is that the
 * page's answers and the API's answers are the same answers. `describePledge`
 * exists so the form previews a pledge by running the server's own
 * `applyPledge`; if that indirection ever gets "optimised" into a local
 * comparison, the GAP_TOO_SMALL and OVER_TARGET cases below are what fail.
 *
 * Deliberate coverage choices:
 *   - the gap guard gets its own block, because it is the refusal a user hits
 *     by accident (pledging near the top of a pool) and the one a hand-rolled
 *     form always gets wrong;
 *   - `deadlineSummary` is tested on a FUNDED pool past its deadline, because
 *     that pool is racing the grace window (D5) and showing it as "closed"
 *     would be a lie the state machine itself does not tell;
 *   - `toPoolState`'s NULL grace fallback is tested, since a row predating the
 *     column must inherit the shared default rather than 0 seconds — a 0 would
 *     make every funded pool look instantly expired.
 */
import { describe, it, expect } from "vitest"
import {
  deadlineSummary,
  describePledge,
  maxLegalPledge,
  poolProgressPercent,
  statusPresentation,
  timeRemaining,
  toPoolState,
  type FundingPoolJson,
} from "@/lib/funding-display"
import type { FundingPoolState, FundingPoolStatus } from "@/lib/funding-state-machine"

const GRACE = 7 * 24 * 3600
const MIN = "5"
const NOW = new Date("2026-09-08T12:00:00Z")
const LATER = (secs: number) => new Date(NOW.getTime() + secs * 1000)

function pool(over: Partial<FundingPoolState> = {}): FundingPoolState {
  return {
    status: "pledging",
    targetXrd: "100",
    pooledXrd: "0",
    deadline: LATER(14 * 24 * 3600),
    graceWindowSecs: GRACE,
    fundedAt: null,
    finalizedAt: null,
    expiredAt: null,
    expiredReason: null,
    ...over,
  }
}

describe("poolProgressPercent", () => {
  it("reports the pledged share of the target", () => {
    expect(poolProgressPercent("25", "100")).toBe(25)
    expect(poolProgressPercent("100", "100")).toBe(100)
  })

  it("refuses to divide by a zero or negative target", () => {
    expect(poolProgressPercent("10", "0")).toBe(0)
  })

  it("clamps rather than overflowing the bar", () => {
    // The DB CHECK makes an over-target row impossible, so this is defence
    // against a bad payload, not a real state — it must not render a 340%-wide
    // div either way.
    expect(poolProgressPercent("340", "100")).toBe(100)
  })
})

describe("statusPresentation", () => {
  const all: FundingPoolStatus[] = ["pledging", "funded", "finalized", "expired", "refunding"]

  it("covers every status the state machine can produce", () => {
    for (const s of all) {
      const p = statusPresentation(s)
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.meaning.length).toBeGreaterThan(0)
    }
  })

  it("does not describe a finalised pool as having paid anyone", () => {
    // status="finalized" with finalizedTaskId still NULL means "this app
    // marked itself finalized before the blueprint existed" (schema doc). The
    // copy must not read as a payout.
    const meaning = statusPresentation("finalized").meaning.toLowerCase()
    expect(meaning).not.toMatch(/paid|payout|released to|sent/)
  })
})

describe("timeRemaining", () => {
  it("returns null once the boundary has passed", () => {
    expect(timeRemaining(LATER(-1), NOW)).toBeNull()
    expect(timeRemaining(NOW, NOW)).toBeNull()
  })

  it("scales the unit with the distance", () => {
    expect(timeRemaining(LATER(30 * 60), NOW)).toBe("30 min")
    expect(timeRemaining(LATER(5 * 3600), NOW)).toBe("5h")
    expect(timeRemaining(LATER(5 * 24 * 3600), NOW)).toBe("5 days")
  })
})

describe("deadlineSummary", () => {
  it("counts down to the deadline while pledging", () => {
    const s = deadlineSummary(pool({ deadline: LATER(3 * 24 * 3600) }), NOW)
    expect(s.label).toBe("Open for")
    expect(s.remaining).toBe("3 days")
  })

  it("counts a funded pool down to the GRACE boundary, not the deadline", () => {
    // Deadline is two days gone, but a funded pool has deadline + 7d to
    // finalise. Reporting it as closed would contradict evaluateDeadline.
    const s = deadlineSummary(
      pool({ status: "funded", pooledXrd: "100", deadline: LATER(-2 * 24 * 3600), fundedAt: LATER(-3 * 24 * 3600) }),
      NOW,
    )
    expect(s.label).toBe("Finalise within")
    expect(s.remaining).toBe("5 days")
  })

  it("derives expiry from the clock for a stored-as-pledging pool", () => {
    // The row still says "pledging"; the clock says otherwise. The summary must
    // follow the clock, exactly as evaluateDeadline does.
    const s = deadlineSummary(pool({ deadline: LATER(-3600) }), NOW)
    expect(s.label).toBe("Expired")
    expect(s.remaining).toBeNull()
  })

  it("flags the last 48 hours as urgent", () => {
    expect(deadlineSummary(pool({ deadline: LATER(24 * 3600) }), NOW).urgent).toBe(true)
    expect(deadlineSummary(pool({ deadline: LATER(6 * 24 * 3600) }), NOW).urgent).toBe(false)
  })
})

describe("describePledge", () => {
  it("treats an unfinished input as form state, not a rule violation", () => {
    for (const bad of ["", "  ", "abc", "1.2.3", "-5"]) {
      const r = describePledge(pool(), bad, NOW, MIN)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe("INVALID_AMOUNT")
    }
  })

  it("accepts a legal pledge and reports what is left after it", () => {
    const r = describePledge(pool({ pooledXrd: "20" }), "30", NOW, MIN)
    expect(r).toEqual({ ok: true, remainingAfterXrd: "50", wouldMeetTarget: false })
  })

  it("recognises the pledge that closes the pool", () => {
    const r = describePledge(pool({ pooledXrd: "70" }), "30", NOW, MIN)
    expect(r).toEqual({ ok: true, remainingAfterXrd: "0", wouldMeetTarget: true })
  })

  it("refuses below the minimum, and names the minimum", () => {
    const r = describePledge(pool(), "1", NOW, MIN)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe("BELOW_MINIMUM")
      expect(r.message).toContain("5 XRD")
    }
  })

  it("refuses over-funding, and names what is actually needed", () => {
    const r = describePledge(pool({ pooledXrd: "90" }), "20", NOW, MIN)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe("OVER_TARGET")
      expect(r.message).toContain("10 XRD")
    }
  })

  describe("the gap guard", () => {
    it("refuses a pledge that would leave an uncloseable remainder", () => {
      // 100 target, 90 pooled, 10 left. Pledging 8 leaves 2 — under the 5 XRD
      // minimum and not zero, so no legal pledge could ever finish the pool.
      const r = describePledge(pool({ pooledXrd: "90" }), "8", NOW, MIN)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe("GAP_TOO_SMALL")
    })

    it("explains the way out instead of just refusing", () => {
      const r = describePledge(pool({ pooledXrd: "90" }), "8", NOW, MIN)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message).toContain("2 XRD")   // the remainder it would strand
        expect(r.message).toContain("10 XRD")  // pledging this finishes the pool
      }
    })

    it("still allows the pledge that lands exactly on the target", () => {
      expect(describePledge(pool({ pooledXrd: "90" }), "10", NOW, MIN).ok).toBe(true)
    })
  })

  it("refuses once the deadline has passed, even on a row still marked pledging", () => {
    const r = describePledge(pool({ deadline: LATER(-60) }), "10", NOW, MIN)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("NOT_ACCEPTING_PLEDGES")
  })

  it("refuses on a pool that already met its target", () => {
    const r = describePledge(pool({ status: "funded", pooledXrd: "100" }), "5", NOW, MIN)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("NOT_ACCEPTING_PLEDGES")
  })
})

describe("maxLegalPledge", () => {
  it("offers the whole remainder when that is legal", () => {
    expect(maxLegalPledge(pool({ pooledXrd: "40" }), NOW, MIN)).toBe("60")
  })

  it("offers nothing on a full pool", () => {
    expect(maxLegalPledge(pool({ status: "funded", pooledXrd: "100" }), NOW, MIN)).toBeNull()
  })

  it("offers nothing once pledging has closed", () => {
    expect(maxLegalPledge(pool({ deadline: LATER(-60) }), NOW, MIN)).toBeNull()
  })

  it("never offers an amount its own preview would reject", () => {
    // The invariant that makes "Fund the rest" safe to click: whatever it
    // returns must pass describePledge. A remainder under the minimum is the
    // interesting case — the button must disappear, not pre-fill a refusal.
    const tiny = pool({ pooledXrd: "98" })
    const offer = maxLegalPledge(tiny, NOW, MIN)
    if (offer !== null) expect(describePledge(tiny, offer, NOW, MIN).ok).toBe(true)
  })
})

describe("toPoolState", () => {
  const json: FundingPoolJson = {
    id: 1,
    posterId: "account_rdx_poster",
    title: "t",
    description: "d",
    targetXrd: "100",
    pooledXrd: "10",
    insuranceXrd: "5",
    deadline: LATER(3600).toISOString(),
    graceWindowSecs: null,
    status: "pledging",
    fundedAt: null,
    finalizedAt: null,
    finalizedTaskId: null,
    expiredAt: null,
    expiredReason: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  }

  it("falls back to the shared default when the row carries no grace window", () => {
    expect(toPoolState(json, GRACE).graceWindowSecs).toBe(GRACE)
  })

  it("prefers the row's own window when it has one", () => {
    expect(toPoolState({ ...json, graceWindowSecs: 3600 }, GRACE).graceWindowSecs).toBe(3600)
  })

  it("revives ISO timestamps as Dates the state machine can compare", () => {
    expect(toPoolState(json, GRACE).deadline).toBeInstanceOf(Date)
  })
})
