/**
 * Unit tests for the P2 cron halt guard (docs/design/security-hardening.md §2):
 * scripts/lib/network-halt-guard.mjs's pure `evaluateHalt` / `formatHaltLine`,
 * plus a thin wiring check on the async `checkNetworkHalt`.
 *
 * `evaluateHalt` deliberately mirrors src/app/api/v1/network/status/route.ts's
 * `halted` computation — the SAME posture the site banner takes, not the
 * stricter one src/lib/alerts.ts's evaluateNetworkHalt uses for its own
 * incident-tracking purposes (that one treats a `stale` re-served tip as
 * "unknown" absent the operator lever; the site banner, and this guard, do
 * not special-case `stale` — see the "stale tip flagged" case below).
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { privateInputs } from "../support/private-input"

// scripts/lib/ stays EXCLUDE at the open-source flip, so this whole file
// skips in the public export and still runs (throwing if the input vanishes
// for any other reason) in the private tree.
const PRIV = privateInputs("guild-app/scripts/lib/network-halt-guard.mjs")
// A variable specifier (not a string literal) keeps Vite's import analyzer
// from resolving this at transform time in the public export, where the
// file doesn't exist — a literal `import("../../scripts/lib/network-halt-guard.mjs")`
// fails to build even inside the PRIV.skip branch (same reason the two
// dynamic imports in the "checkNetworkHalt (wiring)" tests below use it too).
const NETWORK_HALT_GUARD_SPEC = "../../scripts/lib/network-halt-guard.mjs"
const networkHaltGuard = PRIV.skip ? null : await import(/* @vite-ignore */ NETWORK_HALT_GUARD_SPEC)
const evaluateHalt: any = (networkHaltGuard as any)?.evaluateHalt
const formatHaltLine: any = (networkHaltGuard as any)?.formatHaltLine

const HALT_AFTER = 600 // matches NETWORK_HALT_AFTER_SECONDS's default
const NOW = Date.parse("2026-09-07T12:00:00.000Z")

function tipAgeSeconds(ageSeconds: number, opts: { stale?: boolean; stateVersion?: number } = {}) {
  return {
    stateVersion: opts.stateVersion ?? 12345,
    tipIso: new Date(NOW - ageSeconds * 1000).toISOString(),
    ageSeconds, // deliberately possibly stale/wrong here — evaluateHalt recomputes from tipIso+now, never trusts this
    stale: opts.stale ?? false,
  }
}

describe.skipIf(PRIV.skip)("evaluateHalt", () => {
  it("halted by age: a reachable tip older than the threshold halts, lever off", () => {
    const tip = tipAgeSeconds(700, { stateVersion: 557840622 })
    const result = evaluateHalt({ tip, operatorHalt: false, now: NOW, haltAfterSeconds: HALT_AFTER })
    expect(result.halted).toBe(true)
    expect(result.reason).toBe("stale-tip")
    expect(result.stateVersion).toBe(557840622)
    expect(result.ageSeconds).toBe(700)
  })

  it("halted by lever: the operator lever halts regardless of a fresh tip", () => {
    const tip = tipAgeSeconds(5) // well inside the threshold
    const result = evaluateHalt({ tip, operatorHalt: true, now: NOW, haltAfterSeconds: HALT_AFTER })
    expect(result.halted).toBe(true)
    expect(result.reason).toBe("operator-lever")
  })

  it("halted by lever: also halts with no tip at all (cold start, Gateway never reached)", () => {
    const result = evaluateHalt({ tip: null, operatorHalt: true, now: NOW, haltAfterSeconds: HALT_AFTER })
    expect(result.halted).toBe(true)
    expect(result.reason).toBe("operator-lever")
    expect(result.stateVersion).toBeNull()
    expect(result.ageSeconds).toBeNull()
  })

  it("fresh tip: age under the threshold and lever off is NOT halted", () => {
    const tip = tipAgeSeconds(30)
    const result = evaluateHalt({ tip, operatorHalt: false, now: NOW, haltAfterSeconds: HALT_AFTER })
    expect(result.halted).toBe(false)
    expect(result.reason).toBe("fresh")
  })

  it("null tip, lever off → halted: null (unknown), NOT true — must fail OPEN", () => {
    const result = evaluateHalt({ tip: null, operatorHalt: false, now: NOW, haltAfterSeconds: HALT_AFTER })
    expect(result.halted).toBeNull()
    expect(result.stateVersion).toBeNull()
    expect(result.ageSeconds).toBeNull()
  })

  it("stale tip flagged: a re-served last-known tip past the threshold still halts — `stale` does not suppress it (site-banner posture, not the stricter alerts.ts one)", () => {
    const tip = tipAgeSeconds(900, { stale: true, stateVersion: 42 })
    const result = evaluateHalt({ tip, operatorHalt: false, now: NOW, haltAfterSeconds: HALT_AFTER })
    expect(result.halted).toBe(true)
    expect(result.reason).toBe("stale-tip")
  })

  it("a stale-but-fresh-enough re-served tip does NOT halt — `stale` alone is not the signal, age past the threshold is", () => {
    const tip = tipAgeSeconds(30, { stale: true })
    const result = evaluateHalt({ tip, operatorHalt: false, now: NOW, haltAfterSeconds: HALT_AFTER })
    expect(result.halted).toBe(false)
  })

  it("recomputes age from tipIso against `now`, never trusting a stale tip.ageSeconds field on the object itself", () => {
    // tip.ageSeconds claims 10s (fresh); the real gap between tipIso and `now` is 1000s.
    const tip = { stateVersion: 1, tipIso: new Date(NOW - 1000 * 1000).toISOString(), ageSeconds: 10, stale: false }
    const result = evaluateHalt({ tip, operatorHalt: false, now: NOW, haltAfterSeconds: HALT_AFTER })
    expect(result.ageSeconds).toBe(1000)
    expect(result.halted).toBe(true)
  })

  it("age exactly AT the threshold does not halt (strictly greater-than, matching the site route)", () => {
    const tip = tipAgeSeconds(HALT_AFTER)
    const result = evaluateHalt({ tip, operatorHalt: false, now: NOW, haltAfterSeconds: HALT_AFTER })
    expect(result.halted).toBe(false)
  })
})

describe.skipIf(PRIV.skip)("formatHaltLine", () => {
  it("names the operator lever and the last-known tip when one is available", () => {
    const line = formatHaltLine({ halted: true, reason: "operator-lever", stateVersion: 557840622, ageSeconds: 700 })
    expect(line).toContain("operator lever")
    expect(line).toContain("GUILD_HALT")
    expect(line).toContain("557840622")
  })

  it("names the operator lever without a tip when none was ever read", () => {
    const line = formatHaltLine({ halted: true, reason: "operator-lever", stateVersion: null, ageSeconds: null })
    expect(line).toContain("operator lever")
    expect(line).not.toContain("null")
  })

  it("names the stopped state_version and age for a stale-tip halt", () => {
    const line = formatHaltLine({ halted: true, reason: "stale-tip", stateVersion: 557840622, ageSeconds: 700 })
    expect(line).toContain("557840622")
    expect(line).toContain("700")
    expect(line.toLowerCase()).toContain("halt")
  })
})

describe.skipIf(PRIV.skip)("checkNetworkHalt (wiring)", () => {
  afterEach(() => {
    vi.doUnmock("../../src/lib/gateway")
    vi.resetModules()
  })

  it("wires readLedgerTip + operatorHaltEngaged + NETWORK_HALT_AFTER_SECONDS into evaluateHalt", async () => {
    // resetModules FIRST: this file's top-level static import already loaded
    // network-halt-guard.mjs (and, transitively, the REAL gateway.ts) before
    // any test ran. Without clearing that cache, the dynamic import below
    // would resolve to the already-evaluated module instead of a fresh one
    // built against the mock — and checkNetworkHalt would hit the real
    // Gateway over the network instead of the stub.
    vi.resetModules()
    vi.doMock("../../src/lib/gateway", () => ({
      readLedgerTip: async () => ({
        stateVersion: 9,
        tipIso: new Date(NOW - 5000 * 1000).toISOString(),
        ageSeconds: 5000,
        stale: false,
      }),
      operatorHaltEngaged: () => false,
      NETWORK_HALT_AFTER_SECONDS: 600,
    }))
    const { checkNetworkHalt } = await import(/* @vite-ignore */ NETWORK_HALT_GUARD_SPEC)
    const result = await checkNetworkHalt({ now: NOW })
    expect(result.halted).toBe(true)
    expect(result.reason).toBe("stale-tip")
    expect(result.stateVersion).toBe(9)
  })

  it("fails open when the wired readLedgerTip returns null and the lever is off", async () => {
    vi.resetModules()
    vi.doMock("../../src/lib/gateway", () => ({
      readLedgerTip: async () => null,
      operatorHaltEngaged: () => false,
      NETWORK_HALT_AFTER_SECONDS: 600,
    }))
    const { checkNetworkHalt } = await import(/* @vite-ignore */ NETWORK_HALT_GUARD_SPEC)
    const result = await checkNetworkHalt({ now: NOW })
    expect(result.halted).toBeNull()
  })
})
