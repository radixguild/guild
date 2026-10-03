import "server-only"
import { NextRequest, NextResponse } from "next/server"

export interface RateLimitOptions {
  windowMs: number
  max: number
}

export interface RateLimitResult {
  ok: boolean
  retryAfter?: number
  remaining?: number
}

export type RateLimiter = ((key: string) => RateLimitResult) & {
  /** Test-only: live key count, so the eviction sweep below is falsifiable.
   *  Without it the sweep is a memory property no assertion can observe, and
   *  an unobservable fix is an unproven one. */
  _size: () => number
}

// Prune when the map exceeds this many keys — a simple size-threshold sweep,
// added because the live limiter had no eviction at all until 2026-09-02 (see
// below).
const CREATE_LIMITER_SWEEP_AT = 5000

export function createRateLimiter(opts: RateLimitOptions): RateLimiter {
  const hits = new Map<string, number[]>()

  // ⚠️ `hits` had NO eviction at all until 2026-09-02. A key whose entries all
  // expire is still a live Map entry with an empty array in it, kept forever —
  // `check()` only ever filters the ONE key it was handed. So the map grew by
  // one entry per distinct client, permanently, for the process's lifetime.
  //
  // Slow on a small site and unbounded either way, and the asymmetry is the
  // tell: a parallel, uncalled `rateLimit()` convenience API in this same file
  // had a threshold sweep, while this one — which backs both live auth routes
  // — had none. The hardened path was the dead one. (That parallel API was
  // itself removed 2026-09-30 as unreachable dead code with a drifted, green
  // test suite — see git history for guild-app/src/lib/rate-limit.ts.)
  const sweep = (now: number) => {
    if (hits.size <= CREATE_LIMITER_SWEEP_AT) return
    const cutoff = now - opts.windowMs
    for (const [k, times] of hits) {
      // Only the newest timestamp matters: if that is expired, every earlier
      // one is too, and the key cannot affect any future decision.
      if (times.length === 0 || times[times.length - 1] <= cutoff) hits.delete(k)
    }
  }

  const check = function check(key: string): RateLimitResult {
    const now = Date.now()
    sweep(now)
    const cutoff = now - opts.windowMs
    const list = (hits.get(key) ?? []).filter((t) => t > cutoff)
    if (list.length >= opts.max) {
      const retryAfter = Math.ceil((list[0] + opts.windowMs - now) / 1000)
      hits.set(key, list)
      return { ok: false, retryAfter: Math.max(retryAfter, 1) }
    }
    list.push(now)
    hits.set(key, list)
    return { ok: true, remaining: opts.max - list.length }
  } as RateLimiter
  check._size = () => hits.size
  return check
}

/**
 * The rate-limit key for the two UNAUTHENTICATED routes
 * (GET /api/v1/auth/challenge, POST /api/v1/auth/verify). Every other limiter
 * in the app keys on a verified JWT `user.userId` and never reaches this.
 *
 * ⚠️ LEFTMOST IS CORRECT. This was audited on 2026-09-02 as "spoofable — the
 * leftmost X-Forwarded-For entry is client-supplied", and a fix to read the
 * RIGHTMOST entry was drafted before the reasoning was checked. It would have
 * been actively harmful. Both halves of that are recorded here because the
 * code alone cannot show them, and the next person to read `split(",")[0]`
 * will have exactly the same instinct.
 *
 * What was verified, from Caddy's docs AND its source (addForwardedHeaders in
 * modules/caddyhttp/reverseproxy/reverseproxy.go), not assumed:
 *
 *   • With NO `trusted_proxies` — which is what ops/caddy/Caddyfile runs, it
 *     has no such directive — Caddy IGNORES whatever X-Forwarded-For the
 *     client sent and does `Header.Set(clientIP)`: a REPLACE, not an append.
 *     Docs: "by default, the proxy will ignore their values from incoming
 *     requests, to prevent spoofing." So the header arriving here is
 *     single-valued and equals the peer Caddy actually saw. There is no live
 *     spoofing bypass, and leftmost == rightmost == the truth.
 *
 *   • With `trusted_proxies` set (the future CDN case) Caddy does
 *     `Header.Set(prior + ", " + clientIP)`. That is standard XFF append
 *     order: the ORIGINAL CLIENT stays LEFTMOST and each hop appends its own
 *     relay address on the RIGHT. So leftmost is still the client — this code
 *     self-heals when a CDN appears and needs no edit.
 *
 * Reading the rightmost entry would break precisely that future: it would
 * resolve to the CDN edge address, collapsing every user behind one PoP into a
 * single 10/min bucket. No spoofing required to weaponise it — an attacker
 * just uses the same PoP as their target and the victim is locked out of
 * sign-in. A lockout dressed as a hardening.
 *
 * The real exposure is elsewhere and is an OPS property, not a code one: if
 * anything is ever put in front of Caddy WITHOUT adding it to
 * `trusted_proxies`, Caddy replaces XFF with that thing's egress address and
 * every user behind it shares one bucket. Nothing this function can do detects
 * that. It belongs in the Caddy config review, not here.
 *
 * `x-real-ip` is unreachable in this topology (Caddy sets only
 * X-Forwarded-For/-Proto/-Host) and is kept solely for a direct-to-Next
 * deployment. It is trusted unconditionally, so it is only as good as the
 * assumption that nothing untrusted can reach the app directly.
 */
export function getClientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for")
  if (xff) return xff.split(",")[0].trim()
  return req.headers.get("x-real-ip") ?? "unknown"
}

export function rateLimitResponse(retryAfter: number) {
  return NextResponse.json(
    {
      ok: false,
      error: { code: "RATE_LIMITED", message: "Too many requests" },
    },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfter) },
    },
  )
}
