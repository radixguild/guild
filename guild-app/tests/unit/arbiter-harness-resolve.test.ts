// arbiter-harness-resolve.test.ts — the SEAM between chain-derived arbiter
// discovery (readArbiterBadgeResource / findLiveArbiterBadge, both Gateway
// calls) and manifest composition (buildResolveManifest, pure). Every LIVE
// run of `arbiter-harness.mjs resolve` either refuses (task not Disputed,
// bad split, wrong preview verdict) or performs a real one-shot resolution —
// so without exercising buildResolveManifest directly here, the one code
// path that actually moves money on a resolved dispute would be covered by
// nothing. Same rationale as poster-harness.mjs's buildWithdrawManifest and
// its tests/unit/poster-harness-withdraw.test.ts.
//
// parseRuling's client-side split-sum check is exercised here too — it turns
// the chain's cryptic "split worker_pct + poster_pct must equal 1" assert
// into a readable refusal before a --live signature is ever considered.

import { describe, expect, it } from "vitest"
import { buildResolveManifest, parseRuling } from "../../scripts/arbiter-harness.mjs"

const COMPONENT = "component_rdx1cz468eqyr0fklyrlcsznadrwfnqnesw37vlm9j0xmq2s7427akd82f"
const ARBITER_ACCOUNT = "account_rdx12ynlx369jmpfg23n709g0w7fuk0wwe0lft6h5r0m8sksdjpg858g0z"
const ARBITER_BADGE = "resource_rdx1nf229dxvw72cqzrrkgqvn6zxxjmjpf3hx0zhulsfz4tka5kgnvakn3"

const discovery = {
  arbiterBadgeResource: ARBITER_BADGE,
  arbiterBadgeLocalId: "<arbiter_bigdev>",
  arbiterAccount: ARBITER_ACCOUNT,
}

describe("buildResolveManifest — composition seam", () => {
  it("presents the CHAIN-DERIVED badge account and local id, not a caller-typed one", () => {
    const m = buildResolveManifest(discovery, { component: COMPONENT, taskId: 4, ruling: { kind: "PayWorker" } })
    expect(m).toContain(ARBITER_ACCOUNT)
    expect(m).toContain(ARBITER_BADGE)
    expect(m).toContain("<arbiter_bigdev>")
    expect(m).toContain('"resolve_dispute"')
    expect(m).toContain("4u64")
  })

  it("PayWorker encodes Enum<0u8>()", () => {
    const m = buildResolveManifest(discovery, { component: COMPONENT, taskId: 1, ruling: { kind: "PayWorker" } })
    expect(m).toContain("Enum<0u8>()")
  })

  it("RefundPoster encodes Enum<1u8>()", () => {
    const m = buildResolveManifest(discovery, { component: COMPONENT, taskId: 1, ruling: { kind: "RefundPoster" } })
    expect(m).toContain("Enum<1u8>()")
  })

  it("Split encodes Enum<2u8>(Decimal, Decimal)", () => {
    const ruling = parseRuling("split", "0.6", "0.4")
    const m = buildResolveManifest(discovery, { component: COMPONENT, taskId: 1, ruling })
    expect(m).toContain('Enum<2u8>(Decimal("0.6"), Decimal("0.4"))')
  })

  it("touches ONLY the arbiter's own account — no other party account appears", () => {
    const m = buildResolveManifest(discovery, { component: COMPONENT, taskId: 1, ruling: { kind: "PayWorker" } })
    // resolve_dispute credits worker/poster entitlements INSIDE the component
    // (PULL §5c) and returns only the fee — the badge is a Proof since fa8c15e
    // and never comes back. The arbiter account legitimately appears TWICE
    // (PROOF SOURCE, deposit destination — not a withdraw: the Wave B badge is
    // non-transferable, so a withdraw leg here would abort on chain), but every
    // occurrence must be the SAME account. A second, DIFFERENT account_rdx
    // would mean a routing leg crept back in.
    const accounts = m.match(/account_rdx[a-z0-9]+/g) ?? []
    expect(accounts.length).toBeGreaterThan(0)
    expect(new Set(accounts)).toEqual(new Set([ARBITER_ACCOUNT]))
    expect(m).toContain("deposit_batch")
  })
})

describe("parseRuling", () => {
  it("maps the three CLI strings to the DisputeRuling shapes resolveDisputeManifest expects", () => {
    expect(parseRuling("pay-worker")).toEqual({ kind: "PayWorker" })
    expect(parseRuling("refund-poster")).toEqual({ kind: "RefundPoster" })
    expect(parseRuling("split", "0.3", "0.7")).toEqual({ kind: "Split", workerPct: "0.3", posterPct: "0.7" })
  })

  it("refuses a split that does not sum to 1 — BEFORE the chain ever sees it", () => {
    expect(() => parseRuling("split", "0.5", "0.6")).toThrow(/must sum to exactly 1/)
  })

  it("refuses split with a missing percentage", () => {
    expect(() => parseRuling("split", "0.5", undefined)).toThrow(/needs --worker-pct AND --poster-pct/)
  })

  it("refuses an unknown ruling string", () => {
    expect(() => parseRuling("favor-worker")).toThrow(/pay-worker\|refund-poster\|split/)
  })
})
