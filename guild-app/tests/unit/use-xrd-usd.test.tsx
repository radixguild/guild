/**
 * Tests for src/lib/use-xrd-usd.tsx — the client-side XRD/USD rate provider.
 *
 * Pinned here: the 2026-09-03 fix (board note M5 / ruling R1). The hook used
 * to derive `stale` from `staleness_seconds` (how long ago WE polled) against
 * a 5-minute bar — a metric that stays near-zero forever because the route
 * caches for only 60s, so `stale` was effectively always false even while the
 * route's own `primary_frozen` said the served price had been dead since
 * before the 2026-08-31 halt. The hook now reads the route's own `stale` /
 * `age_seconds` fields (computed from the PRICE's age, not our fetch clock)
 * instead of re-deriving a weaker signal from the wrong one.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { renderHook, waitFor, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { XrdUsdProvider, useXrdUsd } from "@/lib/use-xrd-usd"

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("useXrdUsd", () => {
  it("a fresh quote (stale:false) surfaces the rate, source and age", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          rate: 0.00095,
          source: "astrolescent",
          staleness_seconds: 0,
          stale: false,
          age_seconds: 12,
        }),
      ),
    )

    const { result } = renderHook(() => useXrdUsd(), { wrapper: XrdUsdProvider })

    await waitFor(() => expect(result.current.rate).toBe(0.00095))
    expect(result.current.stale).toBe(false)
    expect(result.current.source).toBe("astrolescent")
    expect(result.current.ageSeconds).toBe(12)
  })

  it("a quote the route marks stale surfaces stale:true even though the fetch itself just succeeded", async () => {
    // This is the exact halt-era shape: staleness_seconds (our fetch clock)
    // is 0 because we just polled successfully, but the route's own
    // price-age computation says the underlying rate is old.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          rate: 0.000616181090623589,
          source: "astrolescent",
          staleness_seconds: 0,
          stale: true,
          age_seconds: 3600,
          primary_frozen: true,
        }),
      ),
    )

    const { result } = renderHook(() => useXrdUsd(), { wrapper: XrdUsdProvider })

    await waitFor(() => expect(result.current.rate).toBe(0.000616181090623589))
    expect(result.current.stale).toBe(true)
    expect(result.current.ageSeconds).toBe(3600)
  })

  it("a 503 (both feeds down, fail-closed) fails open to the empty/null state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "price_feed_unavailable" }, false)))

    const { result } = renderHook(() => useXrdUsd(), { wrapper: XrdUsdProvider })

    await waitFor(() => expect(result.current).toEqual({ rate: null, stale: false, ageSeconds: null, source: null }))
  })

  it("a network failure fails open to the empty/null state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")))

    const { result } = renderHook(() => useXrdUsd(), { wrapper: XrdUsdProvider })

    await waitFor(() => expect(result.current).toEqual({ rate: null, stale: false, ageSeconds: null, source: null }))
  })

  it("reading the hook with no provider mounted returns the same empty state", () => {
    const { result } = renderHook(() => useXrdUsd())
    expect(result.current).toEqual({ rate: null, stale: false, ageSeconds: null, source: null })
  })
})
