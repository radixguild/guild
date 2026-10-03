/**
 * Pure math for the poster cancel-after-claim disclosure (PROJECT-STATE.md's
 * 2026-09-01 §20 design packet, unnumbered "Also in §20" bullet — NOT §20.4,
 * an unrelated open bug). The DB aggregation that produces these numbers is
 * proven separately in tests/integration/poster-cancel-stats.pg.test.ts;
 * this file only proves the rate arithmetic on top of it.
 */
import { describe, it, expect } from "vitest"
import { cancelAfterClaimRate, EMPTY_POSTER_CANCEL_STATS } from "@/lib/poster-cancel-stats"

describe("cancelAfterClaimRate", () => {
  it("a poster with 0 cancels-after-claim out of some posted tasks rates 0", () => {
    expect(cancelAfterClaimRate({ totalPosted: 5, cancelledAfterClaim: 0 })).toBe(0)
  })

  it("a poster with 1 cancel-after-claim out of their posted tasks rates 1/totalPosted", () => {
    expect(cancelAfterClaimRate({ totalPosted: 4, cancelledAfterClaim: 1 })).toBe(0.25)
  })

  it("a poster with 3 cancels-after-claim out of their posted tasks rates 3/totalPosted", () => {
    expect(cancelAfterClaimRate({ totalPosted: 6, cancelledAfterClaim: 3 })).toBe(0.5)
  })

  it("every cancel-after-claim count is bounded by totalPosted, so a poster who has cancelled after claim on every task they ever posted rates 1", () => {
    expect(cancelAfterClaimRate({ totalPosted: 3, cancelledAfterClaim: 3 })).toBe(1)
  })

  it("null when the poster has posted nothing — never occurs for a real task's creator, but the type stays honest", () => {
    expect(cancelAfterClaimRate({ totalPosted: 0, cancelledAfterClaim: 0 })).toBeNull()
    expect(cancelAfterClaimRate(EMPTY_POSTER_CANCEL_STATS)).toBeNull()
  })
})
