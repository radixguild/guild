/**
 * Exhaustive transition coverage for the community-funding state machine
 * (src/lib/funding-state-machine.ts). See that module's top-of-file doc for
 * why "funded" exists as its own app-layer state and why "expired" is
 * derived from the clock rather than stored eagerly.
 *
 * The six edge cases named in this feature's brief are each their own
 * `describe` block below so a reviewer can find them by name:
 *   - exact-target hit
 *   - over-target
 *   - deadline passes with target unmet
 *   - deadline passes with target met but unfinalized
 *   - double-pledge from one account
 *   - refund-after-refund
 * Everything else in the file is boundary/invariant coverage the same
 * mechanisms need to be trustworthy (gap guard, minimum floor, finalize/
 * refund window edges, idempotency of the clock-derived transition).
 */
import { describe, it, expect } from "vitest"
import {
  applyPledge,
  claimRefund,
  evaluateDeadline,
  finalize,
  graceExpiresAt,
  isTerminal,
  recordContribution,
  wouldExactlyOrPartiallyFund,
  FundingStateError,
  type ContributionEntry,
  type FundingPoolState,
} from "@/lib/funding-state-machine"

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const GRACE_SECS = 7 * 24 * 60 * 60 // 7d, matches funding-config's default

const NOW = new Date("2026-09-01T00:00:00.000Z")
const DEADLINE = new Date(NOW.getTime() + 14 * DAY)

function pool(overrides: Partial<FundingPoolState> = {}): FundingPoolState {
  return {
    status: "pledging",
    targetXrd: "1000",
    pooledXrd: "0",
    deadline: DEADLINE,
    graceWindowSecs: GRACE_SECS,
    fundedAt: null,
    finalizedAt: null,
    expiredAt: null,
    expiredReason: null,
    ...overrides,
  }
}

const MIN = { minContributionXrd: "1" }

function entry(overrides: Partial<ContributionEntry> = {}): ContributionEntry {
  return {
    contributorId: "account_rdx1contributor",
    amountXrd: "0",
    refundedAt: null,
    refundedXrd: null,
    ...overrides,
  }
}

// ── exact-target hit ─────────────────────────────────────────────────────────

describe("exact-target hit", () => {
  it("flips pledging -> funded and stamps fundedAt when a pledge lands EXACTLY on the target", () => {
    const p = pool({ pooledXrd: "990" })
    const result = applyPledge(p, "10", NOW, MIN)
    expect(result.status).toBe("funded")
    expect(result.pooledXrd).toBe("1000")
    expect(result.fundedAt).toEqual(NOW)
  })

  it("a single pledge that exactly equals the whole target from zero also funds", () => {
    const result = applyPledge(pool(), "1000", NOW, MIN)
    expect(result.status).toBe("funded")
  })

  it("a pledge landing short of the target leaves the pool pledging, fundedAt untouched", () => {
    const result = applyPledge(pool({ pooledXrd: "990" }), "9", NOW, MIN)
    expect(result.status).toBe("pledging")
    expect(result.pooledXrd).toBe("999")
    expect(result.fundedAt).toBeNull()
  })
})

// ── over-target ──────────────────────────────────────────────────────────────

describe("over-target (D1 — the chain refuses over-funding)", () => {
  it("rejects a pledge that would exceed remaining, even by the smallest unit", () => {
    const p = pool({ pooledXrd: "990" })
    expect(() => applyPledge(p, "10.000000000000000001", NOW, MIN)).toThrow(FundingStateError)
    try {
      applyPledge(p, "10.000000000000000001", NOW, MIN)
    } catch (e) {
      expect((e as FundingStateError).code).toBe("OVER_TARGET")
    }
  })

  it("rejects a wildly over-target pledge against an empty pool", () => {
    expect(() => applyPledge(pool(), "1000.01", NOW, MIN)).toThrow(FundingStateError)
  })

  it("does not mutate pooledXrd on a rejected over-target pledge", () => {
    const p = pool({ pooledXrd: "990" })
    expect(() => applyPledge(p, "11", NOW, MIN)).toThrow()
    expect(p.pooledXrd).toBe("990") // the input object itself, untouched
  })
})

// ── deadline passes with target unmet ────────────────────────────────────────

describe("deadline passes with target unmet", () => {
  it("evaluateDeadline derives pledging -> expired(NotFunded) once now > deadline", () => {
    const p = pool({ pooledXrd: "500" })
    const after = new Date(DEADLINE.getTime() + 1)
    const result = evaluateDeadline(p, after)
    expect(result.status).toBe("expired")
    expect(result.expiredReason).toBe("NotFunded")
    expect(result.expiredAt).toEqual(after)
  })

  it("does NOT expire at exactly the deadline instant (contribute-style: now < deadline is the live window)", () => {
    const p = pool({ pooledXrd: "500" })
    expect(evaluateDeadline(p, DEADLINE).status).toBe("pledging")
  })

  it("a pledge attempted after the deadline is refused, not silently accepted", () => {
    const p = pool({ pooledXrd: "500" })
    const after = new Date(DEADLINE.getTime() + 1)
    expect(() => applyPledge(p, "10", after, MIN)).toThrow(FundingStateError)
    try {
      applyPledge(p, "10", after, MIN)
    } catch (e) {
      expect((e as FundingStateError).code).toBe("NOT_ACCEPTING_PLEDGES")
    }
  })

  it("a pledge exactly AT the deadline instant is still accepted (last legal instant)", () => {
    const p = pool({ pooledXrd: "500" })
    const result = applyPledge(p, "10", DEADLINE, MIN)
    expect(result.status).toBe("pledging")
    expect(result.pooledXrd).toBe("510")
  })
})

// ── deadline passes with target met but unfinalized ──────────────────────────

describe("deadline passes with target met but unfinalized (D5's liveness escape)", () => {
  const funded = pool({ status: "funded", pooledXrd: "1000", fundedAt: NOW })

  it("stays funded through the deadline itself — finalize has no reason to race the deadline", () => {
    expect(evaluateDeadline(funded, DEADLINE).status).toBe("funded")
  })

  it("stays funded up to and including deadline + grace (inclusive boundary)", () => {
    const atGraceEdge = graceExpiresAt(funded)
    expect(evaluateDeadline(funded, atGraceEdge).status).toBe("funded")
    expect(finalize(funded, atGraceEdge).status).toBe("finalized")
  })

  it("expires with reason GraceExpired the instant AFTER deadline + grace", () => {
    const justAfterGrace = new Date(graceExpiresAt(funded).getTime() + 1)
    const result = evaluateDeadline(funded, justAfterGrace)
    expect(result.status).toBe("expired")
    expect(result.expiredReason).toBe("GraceExpired")
  })

  it("finalize() after grace expiry fails closed rather than silently succeeding", () => {
    const justAfterGrace = new Date(graceExpiresAt(funded).getTime() + 1)
    expect(() => finalize(funded, justAfterGrace)).toThrow(FundingStateError)
    try {
      finalize(funded, justAfterGrace)
    } catch (e) {
      expect((e as FundingStateError).code).toBe("NOT_FUNDED")
    }
  })

  it("a funded pool whose grace has expired can still be refunded (money is not stuck)", () => {
    const justAfterGrace = new Date(graceExpiresAt(funded).getTime() + 1)
    const e = entry({ amountXrd: "1000" })
    const { pool: after } = claimRefund(funded, e, justAfterGrace)
    expect(after.status).toBe("refunding")
  })
})

// ── double-pledge from one account ───────────────────────────────────────────

describe("double-pledge from one account", () => {
  it("recordContribution ACCUMULATES into the same ledger entry, not a second row", () => {
    const first = recordContribution(null, "account_rdx1alice", "100")
    const second = recordContribution(first, "account_rdx1alice", "50")
    expect(second.contributorId).toBe("account_rdx1alice")
    expect(second.amountXrd).toBe("150")
  })

  it("three pledges from the same account sum exactly, including fractional amounts", () => {
    let e: ContributionEntry | null = null
    e = recordContribution(e, "account_rdx1alice", "10.10")
    e = recordContribution(e, "account_rdx1alice", "0.05")
    e = recordContribution(e, "account_rdx1alice", "0.005")
    expect(e.amountXrd).toBe("10.155")
  })

  it("a pool accepts a repeat pledge from the same account like any other (pool total, not per-account, gates acceptance)", () => {
    let p = pool({ pooledXrd: "0" })
    p = applyPledge(p, "100", NOW, MIN)
    p = applyPledge(p, "50", NOW, MIN) // same caller in practice, pool doesn't know identity
    expect(p.pooledXrd).toBe("150")
  })

  it("does not mutate the entry passed in — returns a new object", () => {
    const first = recordContribution(null, "account_rdx1alice", "100")
    const second = recordContribution(first, "account_rdx1alice", "50")
    expect(first.amountXrd).toBe("100") // original untouched
    expect(second).not.toBe(first)
  })
})

// ── refund-after-refund ───────────────────────────────────────────────────────

describe("refund-after-refund", () => {
  const expired = pool({ status: "expired", pooledXrd: "500", expiredAt: NOW, expiredReason: "NotFunded" })

  it("the first claim succeeds, flips the pool to refunding, and stamps the entry", () => {
    const e = entry({ amountXrd: "100" })
    const { pool: after, entry: refunded } = claimRefund(expired, e, NOW)
    expect(after.status).toBe("refunding")
    expect(refunded.refundedAt).toEqual(NOW)
    expect(refunded.refundedXrd).toBe("100")
  })

  it("a SECOND claim on the same already-refunded entry is rejected, not paid again", () => {
    const already = entry({ amountXrd: "100", refundedAt: NOW, refundedXrd: "100" })
    expect(() => claimRefund(expired, already, new Date(NOW.getTime() + HOUR))).toThrow(
      FundingStateError,
    )
    try {
      claimRefund(expired, already, new Date(NOW.getTime() + HOUR))
    } catch (e) {
      expect((e as FundingStateError).code).toBe("ALREADY_REFUNDED")
    }
  })

  it("a second DIFFERENT contributor can still claim after the pool is already 'refunding'", () => {
    const refunding = pool({ status: "refunding", pooledXrd: "500" })
    const bob = entry({ contributorId: "account_rdx1bob", amountXrd: "200" })
    const { pool: after, entry: refunded } = claimRefund(refunding, bob, NOW)
    expect(after.status).toBe("refunding") // stays, doesn't re-flip or error
    expect(refunded.refundedXrd).toBe("200")
  })

  it("claiming a zero-amount / nonexistent entry is refused rather than paying nothing silently", () => {
    const e = entry({ amountXrd: "0" })
    expect(() => claimRefund(expired, e, NOW)).toThrow(FundingStateError)
    try {
      claimRefund(expired, e, NOW)
    } catch (err) {
      expect((err as FundingStateError).code).toBe("NOTHING_TO_REFUND")
    }
  })
})

// ── additional invariants (below-minimum, gap guard, refund-window gating) ────

describe("minimum contribution floor", () => {
  it("rejects a pledge below the minimum", () => {
    expect(() => applyPledge(pool(), "0.5", NOW, { minContributionXrd: "1" })).toThrow(
      FundingStateError,
    )
    try {
      applyPledge(pool(), "0.5", NOW, { minContributionXrd: "1" })
    } catch (e) {
      expect((e as FundingStateError).code).toBe("BELOW_MINIMUM")
    }
  })
  it("accepts a pledge exactly at the minimum", () => {
    const result = applyPledge(pool(), "1", NOW, { minContributionXrd: "1" })
    expect(result.pooledXrd).toBe("1")
  })
  it("rejects a non-positive pledge before the minimum check even runs", () => {
    expect(() => applyPledge(pool(), "0", NOW, MIN)).toThrow(FundingStateError)
    try {
      applyPledge(pool(), "-5", NOW, MIN)
    } catch (e) {
      expect((e as FundingStateError).code).toBe("AMOUNT_NOT_POSITIVE")
    }
  })
})

describe("gap guard [blueprint-level] — the last gap may never fall in (0, min)", () => {
  it("rejects a pledge that would leave a sub-minimum, non-zero remainder", () => {
    // target 1000, pooled 998.5, min 1 -> a pledge of 1 would leave 0.5
    // remaining: not zero, and below the 1 XRD floor. No future pledge could
    // legally close it (below min) and no larger one could either (over
    // target) — so it must be refused NOW, at the pledge that would create it.
    const p = pool({ targetXrd: "1000", pooledXrd: "998.5" })
    expect(() => applyPledge(p, "1", NOW, { minContributionXrd: "1" })).toThrow(FundingStateError)
    try {
      applyPledge(p, "1", NOW, { minContributionXrd: "1" })
    } catch (e) {
      expect((e as FundingStateError).code).toBe("GAP_TOO_SMALL")
    }
  })
  it("allows a pledge that leaves EXACTLY zero remaining (the funding pledge itself)", () => {
    const p = pool({ targetXrd: "1000", pooledXrd: "998.5" })
    const result = applyPledge(p, "1.5", NOW, { minContributionXrd: "1" })
    expect(result.status).toBe("funded")
  })
  it("allows a pledge that leaves remaining >= the minimum", () => {
    const p = pool({ targetXrd: "1000", pooledXrd: "0" })
    const result = applyPledge(p, "998", NOW, { minContributionXrd: "1" })
    expect(result.pooledXrd).toBe("998")
    expect(result.status).toBe("pledging")
  })
})

describe("refund gating — only reachable once a pool has actually failed", () => {
  it("refuses a refund claim against a live pledging pool", () => {
    expect(() => claimRefund(pool(), entry({ amountXrd: "10" }), NOW)).toThrow(FundingStateError)
    try {
      claimRefund(pool(), entry({ amountXrd: "10" }), NOW)
    } catch (e) {
      expect((e as FundingStateError).code).toBe("NOT_EXPIRED")
    }
  })
  it("refuses a refund claim against a funded-but-still-live pool (within grace)", () => {
    const funded = pool({ status: "funded", pooledXrd: "1000" })
    expect(() => claimRefund(funded, entry({ amountXrd: "10" }), NOW)).toThrow(FundingStateError)
  })
  it("refuses a refund claim against an already-finalized pool", () => {
    const finalized = pool({ status: "finalized", pooledXrd: "1000", finalizedAt: NOW })
    expect(() => claimRefund(finalized, entry({ amountXrd: "10" }), NOW)).toThrow(
      FundingStateError,
    )
  })
})

describe("evaluateDeadline idempotency", () => {
  it("returns the SAME object reference when nothing changes (cheap no-write signal)", () => {
    const p = pool()
    expect(evaluateDeadline(p, NOW)).toBe(p)
  })
  it("re-evaluating an already-expired pool is a no-op, not a re-stamp", () => {
    const expired = pool({ status: "expired", expiredAt: NOW, expiredReason: "NotFunded" })
    const later = new Date(NOW.getTime() + DAY)
    expect(evaluateDeadline(expired, later)).toBe(expired)
  })
  it("re-evaluating an already-finalized pool never reverts it, even past the deadline", () => {
    const finalized = pool({ status: "finalized", pooledXrd: "1000", finalizedAt: NOW })
    const wayAfter = new Date(DEADLINE.getTime() + 365 * DAY)
    expect(evaluateDeadline(finalized, wayAfter).status).toBe("finalized")
  })
})

describe("isTerminal", () => {
  it("finalized and refunding are terminal; pledging/funded/expired are not", () => {
    expect(isTerminal("finalized")).toBe(true)
    expect(isTerminal("refunding")).toBe(true)
    expect(isTerminal("pledging")).toBe(false)
    expect(isTerminal("funded")).toBe(false)
    // "expired" itself is NOT terminal in this module's vocabulary: it is a
    // waiting room for claimRefund to move it into "refunding" — see
    // refund-after-refund's third case above, where a pool sits "refunding"
    // across multiple claims.
    expect(isTerminal("expired")).toBe(false)
  })
})

describe("wouldExactlyOrPartiallyFund", () => {
  it("true for any amount up to and including remaining, false just over it", () => {
    const p = pool({ pooledXrd: "900" })
    expect(wouldExactlyOrPartiallyFund(p, "100")).toBe(true)
    expect(wouldExactlyOrPartiallyFund(p, "50")).toBe(true)
    expect(wouldExactlyOrPartiallyFund(p, "100.000000000000000001")).toBe(false)
  })
})
