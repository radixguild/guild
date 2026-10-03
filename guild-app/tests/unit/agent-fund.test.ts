/**
 * Fund & activate, the pure rules (A2.3): the manifest cross-check that runs
 * before the wallet opens, the confirm loop's predicate and its schedule.
 *
 * The cross-check is tested against the REAL pairAgentManifest output, not a
 * hand-written string, so a change to the builder that this reader does not
 * follow fails here rather than at the wallet.
 */
import { describe, it, expect } from "vitest"
import {
  checkPairManifest,
  classifyFunded,
  describePairManifest,
  forgetPendingFund,
  fundPollDelay,
  readPendingFund,
  rememberPendingFund,
  sameXrd,
} from "@/lib/agent-fund"
import { pairAgentManifest } from "@/lib/manifests"
import { MANAGER } from "@/lib/config"
import { XRD_ADDRESS } from "@/lib/radix"
import { CHAIN_HALTED_CODE } from "@/lib/chain-halt-gate"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const OWNER = "account_rdx12yepj6wme9ehcnmffk9fvelhumrfskzqyxdy6zde8ltn5zxy42mrcz"
const AGENT = "account_rdx128m9cmv5gyrdzeqh4r3sp8x3rymkz8wflznqxmyagrcrfsrsf9jwfx"
const REAL = pairAgentManifest(MANAGER, OWNER, AGENT, "scout", "200")
const WANT = { manager: MANAGER, owner: OWNER, agentAccount: AGENT, labelNorm: "scout", floatXrd: "200" }

describe("describePairManifest", () => {
  it("reads the real pairing transaction back exactly", () => {
    expect(describePairManifest(REAL)).toEqual({ from: OWNER, resource: XRD_ADDRESS, amountXrd: "200", manager: MANAGER, labelNorm: "scout", to: AGENT })
  })

  it("refuses any other shape: an extra instruction, a reorder, a different method", () => {
    const extra = `${REAL}\nCALL_METHOD\n  Address("${OWNER}")\n  "lock_fee"\n  Decimal("10")\n;`
    expect(describePairManifest(extra)).toBeNull()
    const [w, m, d] = REAL.split(";").map((s) => s.trim())
    expect(describePairManifest(`${m};\n${w};\n${d};`)).toBeNull()
    expect(describePairManifest(REAL.replace('"withdraw"', '"withdraw_non_fungibles"'))).toBeNull()
    expect(describePairManifest(REAL.replace("try_deposit_batch_or_abort", "deposit_batch"))).toBeNull()
    expect(describePairManifest("")).toBeNull()
  })
})

describe("checkPairManifest — the last check before the wallet opens", () => {
  it("passes the real transaction for exactly what the page is about to show", () => {
    expect(checkPairManifest(REAL, WANT)).toEqual({ ok: true })
    // the same amount written differently is the same amount
    expect(checkPairManifest(pairAgentManifest(MANAGER, OWNER, AGENT, "scout", "200.5"), { ...WANT, floatXrd: "200.50" })).toEqual({ ok: true })
  })

  it.each([
    ["another owner's XRD", { ...WANT, owner: AGENT }],
    ["a different amount", { ...WANT, floatXrd: "20" }],
    ["a different badge name", { ...WANT, labelNorm: "scout2" }],
    ["a different recipient", { ...WANT, agentAccount: OWNER }],
    ["a badge minter that is not the Guild's", { ...WANT, manager: "component_rdx1cz0000000000000000000000000000000000000000000000000000" }],
  ])("🔴 refuses %s", (_what, want) => {
    expect(checkPairManifest(REAL, want).ok).toBe(false)
  })

  it("🔴 refuses a token that is not XRD, and a manifest it cannot read", () => {
    const notXrd = REAL.replace(XRD_ADDRESS, "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxnotxrd")
    expect(checkPairManifest(notXrd, WANT)).toEqual({ ok: false, reason: "it would move a token that is not XRD" })
    expect(checkPairManifest("CALL_METHOD;", WANT).ok).toBe(false)
  })

  it("🔴 an amount past 18 decimal places is refused — never a throw that skips the refusal", () => {
    const tooFine = REAL.replace('Decimal("200")', 'Decimal("200.1234567890123456789")')
    expect(() => checkPairManifest(tooFine, WANT)).not.toThrow()
    expect(checkPairManifest(tooFine, WANT).ok).toBe(false)
    expect(checkPairManifest(REAL, { ...WANT, floatXrd: "200.1234567890123456789" }).ok).toBe(false)
  })
})

describe("sameXrd", () => {
  it("equal amounts written differently; never throws on junk", () => {
    expect(sameXrd("200", "200.000")).toBe(true)
    expect(sameXrd("200", "200.1")).toBe(false)
    for (const junk of ["", "-1", "1e3", "200.1234567890123456789", "abc"]) {
      expect(() => sameXrd(junk, "200")).not.toThrow()
      expect(sameXrd(junk, "200")).toBe(false)
    }
  })
})

describe("the pending transaction, remembered across close and reload", () => {
  const TX = "txid_rdx1funding00000000000000000000000000000000000000000000000"
  const mem = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
  }

  it("is kept per agent for a day, then forgotten", () => {
    const store = mem()
    rememberPendingFund(store, 7, TX, 1_000)
    expect(readPendingFund(store, 7, 1_000 + 60_000)).toBe(TX)
    expect(readPendingFund(store, 8, 1_000)).toBeNull()
    expect(readPendingFund(store, 7, 1_000 + 24 * 3600_000 + 1)).toBeNull()
    forgetPendingFund(store, 7)
    expect(readPendingFund(store, 7, 1_000)).toBeNull()
  })

  it("ignores anything that is not a transaction id, and a store that throws or is missing", () => {
    const store = mem()
    store.setItem("guild:agent-fund:7", JSON.stringify({ intentHash: "javascript:alert(1)", at: 1 }))
    expect(readPendingFund(store, 7, 2)).toBeNull()
    store.setItem("guild:agent-fund:7", "{not json")
    expect(readPendingFund(store, 7, 2)).toBeNull()
    const broken = { getItem: () => { throw new Error("blocked") }, setItem: () => { throw new Error("blocked") }, removeItem: () => { throw new Error("blocked") } }
    expect(() => rememberPendingFund(broken, 7, TX, 1)).not.toThrow()
    expect(readPendingFund(broken, 7, 1)).toBeNull()
    expect(() => forgetPendingFund(broken, 7)).not.toThrow()
    expect(readPendingFund(null, 7, 1)).toBeNull()
  })
})

describe("classifyFunded — the confirm loop's predicate", () => {
  it("200 is done", () => {
    expect(classifyFunded(200, { ok: true, data: {} })).toEqual({ kind: "active" })
  })

  it("not landed yet, an unreadable chain, a 5xx or no answer at all → ask again", () => {
    expect(classifyFunded(409, { ok: false, error: { code: "FUNDING_PENDING", message: "m" } }).kind).toBe("retry")
    expect(classifyFunded(503, { ok: false, error: { code: "GATEWAY_UNAVAILABLE", message: "m" } }).kind).toBe("retry")
    expect(classifyFunded(500, null).kind).toBe("retry")
    expect(classifyFunded(0, null).kind).toBe("retry")
  })

  it("a 429 pauses for its Retry-After, never gives up", () => {
    expect(classifyFunded(429, { ok: false }, "7")).toEqual({ kind: "retry", code: "RATE_LIMITED", message: "Checking too often; pausing.", retryAfterSec: 7 })
  })

  it.each(["FUNDING_TX_FAILED", "FUNDING_FLOAT_SHORT", "FUNDING_BADGE_MISSING", "LABEL_TAKEN", "FUNDING_NOT_FOUND", "AGENT_WRONG_STATE"])(
    "%s is final for this attempt, with the server's message",
    (code) => {
      expect(classifyFunded(409, { ok: false, error: { code, message: "why" } })).toEqual({ kind: "stop", code, message: "why" })
    },
  )

  it("🔴 has no chain-halt branch: the funded route is never halt-gated, so the loop never stops for a halt", () => {
    // Only the manifest route is halt-gated (chain-halt-gate.ts). The predicate
    // must not name the halt code — a future edit adding one would stop a
    // confirmation the owner has already signed.
    const src = readFileSync(join(process.cwd(), "src/lib/agent-fund.ts"), "utf8")
    const predicate = src.slice(src.indexOf("export function classifyFunded"), src.indexOf("export function fundPollDelay"))
    expect(predicate).not.toContain(CHAIN_HALTED_CODE)
    expect(predicate).not.toMatch(/halted|isHalt|chainWriteGate/)
  })
})

describe("fundPollDelay", () => {
  it("every 4 s for the first 30 s, then every 10 s, then stop asking at 3 minutes", () => {
    expect(fundPollDelay(0)).toBe(4_000)
    expect(fundPollDelay(29_999)).toBe(4_000)
    expect(fundPollDelay(30_000)).toBe(10_000)
    expect(fundPollDelay(179_999)).toBe(10_000)
    expect(fundPollDelay(180_000)).toBeNull()
  })

  it("never asks more than 11 times in any minute — inside the funded route's 20/min limit", () => {
    const times: number[] = []
    for (let t = 0, d = fundPollDelay(0); d !== null; d = fundPollDelay(t)) {
      times.push(t)
      t += d
    }
    const busiest = Math.max(...times.map((t0) => times.filter((t) => t >= t0 && t < t0 + 60_000).length))
    expect(busiest).toBe(11)
    expect(busiest).toBeLessThan(20)
  })
})
