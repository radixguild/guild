import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import {
  createRateLimiter,
  getClientIp,
  rateLimitResponse,
} from "@/lib/rate-limit"

describe("lib/rate-limit", () => {
  describe("createRateLimiter", () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it("allows requests under the limit", () => {
      const limit = createRateLimiter({ windowMs: 1000, max: 3 })
      expect(limit("k").ok).toBe(true)
      expect(limit("k").ok).toBe(true)
      expect(limit("k").ok).toBe(true)
    })

    it("blocks the request that exceeds max", () => {
      const limit = createRateLimiter({ windowMs: 1000, max: 2 })
      expect(limit("k").ok).toBe(true)
      expect(limit("k").ok).toBe(true)
      const blocked = limit("k")
      expect(blocked.ok).toBe(false)
      expect(blocked.retryAfter).toBeGreaterThan(0)
    })

    it("isolates keys", () => {
      const limit = createRateLimiter({ windowMs: 1000, max: 1 })
      expect(limit("a").ok).toBe(true)
      expect(limit("a").ok).toBe(false)
      expect(limit("b").ok).toBe(true)
    })

    it("recovers after the window passes", () => {
      const limit = createRateLimiter({ windowMs: 1000, max: 1 })
      expect(limit("k").ok).toBe(true)
      expect(limit("k").ok).toBe(false)
      vi.advanceTimersByTime(1001)
      expect(limit("k").ok).toBe(true)
    })

    it("returns a non-zero retryAfter in seconds", () => {
      const limit = createRateLimiter({ windowMs: 60_000, max: 1 })
      limit("k")
      const blocked = limit("k")
      expect(blocked.retryAfter).toBeGreaterThanOrEqual(1)
      expect(blocked.retryAfter).toBeLessThanOrEqual(60)
    })
  })

  describe("getClientIp", () => {
    function makeReq(headers: Record<string, string>): NextRequest {
      return { headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } } as unknown as NextRequest
    }

    it("reads first IP from x-forwarded-for", () => {
      expect(getClientIp(makeReq({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBe("1.2.3.4")
    })

    it("trims whitespace", () => {
      expect(getClientIp(makeReq({ "x-forwarded-for": "  1.2.3.4  , 10.0.0.1" }))).toBe("1.2.3.4")
    })

    it("falls back to x-real-ip when xff is missing", () => {
      expect(getClientIp(makeReq({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8")
    })

    it("returns 'unknown' when no headers present", () => {
      expect(getClientIp(makeReq({}))).toBe("unknown")
    })

    // ── The two REAL topologies, named. ──────────────────────────────────────
    // The four tests above pin the mechanics and would be equally satisfied by
    // an accident. These pin the REASONING, which is what a 2026-09-02 audit
    // got wrong: it read `split(",")[0]` as "trusts a client-supplied value"
    // and a rightmost-entry fix was drafted before anyone checked Caddy.
    //
    // Verified from Caddy's docs and its addForwardedHeaders source, not
    // assumed. See the long comment on getClientIp.

    it("today: Caddy without trusted_proxies REPLACES a forged header, so there is no bypass", () => {
      // A client sends `X-Forwarded-For: 9.9.9.9` hoping for a fresh bucket.
      // Caddy has no trusted_proxies (ops/caddy/Caddyfile), so it ignores that
      // value entirely and Header.Set()s its own observed peer. What reaches
      // this function is single-valued and true.
      expect(getClientIp(makeReq({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7")
    })

    it("CDN future: with trusted_proxies set Caddy APPENDS, and the client stays leftmost", () => {
      // Caddy does Header.Set(prior + ", " + clientIP) once the peer is
      // trusted — standard XFF order: original client first, each hop's own
      // relay address appended on the right.
      //
      // THIS IS THE REGRESSION GUARD for the fix that was nearly shipped.
      // Reading the rightmost entry returns the CDN edge address, collapsing
      // every user behind one PoP into a single 10/min bucket on the sign-in
      // routes — a lockout an attacker triggers just by using the same PoP.
      // Change getClientIp to `.at(-1)` and this test goes red.
      expect(getClientIp(makeReq({ "x-forwarded-for": "203.0.113.7, 198.51.100.4" }))).toBe(
        "203.0.113.7",
      )
    })
  })

  describe("createRateLimiter eviction", () => {
    it("evicts keys whose window has fully expired once the map grows past the sweep threshold", () => {
      // `hits` had NO eviction until 2026-09-02: a key whose entries all
      // expired stayed in the map forever, because check() only ever filters
      // the one key it was handed. One permanent entry per distinct client.
      const limiter = createRateLimiter({ windowMs: 1000, max: 5 })
      for (let i = 0; i < 6000; i++) limiter(`k${i}`)
      expect(limiter._size()).toBe(6000)

      vi.useFakeTimers()
      try {
        vi.setSystemTime(Date.now() + 60_000) // every window long expired
        limiter("trigger-the-sweep")
        // Falsifying input, named: delete the sweep() call and this stays at
        // 6001 forever. The old code did exactly that.
        expect(limiter._size()).toBeLessThan(100)
      } finally {
        vi.useRealTimers()
      }
    })

    it("does NOT evict a key that is still inside its window", () => {
      const limiter = createRateLimiter({ windowMs: 60_000, max: 5 })
      for (let i = 0; i < 6000; i++) limiter(`k${i}`)
      limiter("still-live")
      // Nothing expired, so the sweep must keep everything — an eviction that
      // drops live keys would hand attackers a fresh budget on demand.
      expect(limiter._size()).toBe(6001)
    })
  })

  describe("rateLimitResponse", () => {
    it("returns 429 with canonical error envelope", async () => {
      const res = rateLimitResponse(30)
      expect(res.status).toBe(429)
      expect(res.headers.get("Retry-After")).toBe("30")
      expect(await res.json()).toMatchObject({
        ok: false,
        error: { code: "RATE_LIMITED", message: "Too many requests" },
      })
    })
  })
})
