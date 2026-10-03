import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

/**
 * Every authenticated money-path route must throttle per account.
 *
 * 🔴 Three of these shipped with NO limiter at all, found 2026-09-18 while
 * assessing readiness for the first ungated launch:
 *
 *   • tasks/[id]/escrow          — the shared lifecycle confirm (create, claim,
 *     submit, approve, dispute, resolve, cancel). Every accepted call verifies
 *     the matching on-chain event, so each one costs a Gateway round trip. This
 *     is the one that scales with an ungated announcement.
 *   • tasks/[id]/dispute-evidence — persists operator-readable free text.
 *   • tasks/[id]/escrow/claim-check — authenticated DB read.
 *
 * All three sit behind withAuth, so abuse costs an attacker a ROLA session
 * rather than nothing — which is why this was a real gap and not an open door.
 * The point of the limiter is to bound what ONE authenticated session can
 * spend of the Gateway budget and the DB's attention.
 *
 * Why a SOURCE test: the defect was an ABSENCE. A behavioural test of any one
 * route passes whether or not its siblings are throttled, and passes forever
 * once written — it cannot observe a route that was never wired up. The thing
 * to pin is that no route on this list is missing its limiter, including
 * routes added later.
 *
 * To mutate-prove this file: delete the `createRateLimiter` line from any route
 * below and both assertions for that route must fail.
 */

const ROUTES = [
  "src/app/api/v1/tasks/route.ts",
  "src/app/api/v1/tasks/[id]/escrow/route.ts",
  "src/app/api/v1/tasks/[id]/escrow/claim-check/route.ts",
  "src/app/api/v1/tasks/[id]/escrow/resync/route.ts",
  "src/app/api/v1/tasks/[id]/dispute-evidence/route.ts",
  "src/app/api/v1/tasks/[id]/submissions/route.ts",
  "src/app/api/v1/submissions/[id]/review/route.ts",
]

describe("money-path routes are rate limited per account", () => {
  it("every listed route file exists (vacuous-pass guard)", () => {
    // Without this, a renamed or moved route silently drops out of the sweep
    // below and the suite still reads green — the exact failure class this
    // file exists to prevent.
    const missing = ROUTES.filter((r) => !existsSync(join(process.cwd(), r)))
    expect(missing).toEqual([])
  })

  it.each(ROUTES)("%s builds a limiter", (route) => {
    const src = readFileSync(join(process.cwd(), route), "utf8")
    expect(src).toContain("createRateLimiter(")
  })

  it.each(ROUTES)("%s rejects over-limit callers", (route) => {
    const src = readFileSync(join(process.cwd(), route), "utf8")
    // The limiter must actually gate the handler, not merely be constructed.
    expect(src).toMatch(/rateLimitResponse\(\s*limit\.retryAfter!?\s*\)/)
  })

  it.each(ROUTES)("%s keys on the authenticated account, not the IP", (route) => {
    const src = readFileSync(join(process.cwd(), route), "utf8")
    // getClientIp is correct for the two unauthenticated auth routes and wrong
    // here: keying a signed-in money route on IP buckets everyone behind one
    // NAT or PoP together, which is a lockout dressed as a hardening.
    expect(src).toMatch(/Limiter\(\s*user\.userId\s*\)/)
    expect(src).not.toContain("getClientIp")
  })
})
