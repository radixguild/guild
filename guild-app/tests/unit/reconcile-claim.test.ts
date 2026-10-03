/**
 * Unit tests for the reconciler's claim-heal decision (src/lib/reconcile-claim.ts)
 * — the money-path WHO/what choice the .mjs script (and the resync fallback)
 * delegate. Pinned here because a regression that heals to the wrong account
 * (or heals an expired/abandoned claim) mis-attributes another user's earnings,
 * and the .mjs itself is not directly unit-tested.
 *
 * The heal gate is the full worker-retaining state set (Claimed / Submitted /
 * Disputed / Released / dispute-loss Refunded): the blueprint clears
 * worker_account ONLY on expire_claim and cancel-after-claim, so whenever it is
 * present it names the account the escrow pays / paid / would pay — including
 * the client-vanished backlog whose lifecycle completed on-chain within one
 * cursor window (design/reconciler-claim-heal-boundary-2026-07-16.md).
 */
import { describe, it, expect } from "vitest"
import { decideClaimHeal, classifyHealResult } from "@/lib/reconcile-claim"

const W = "account_rdx1worker"

describe("decideClaimHeal", () => {
  it("heals a live Claimed task in the open window to worker_account", () => {
    expect(decideClaimHeal({ dbStatus: "open", onChainState: "Claimed", workerAccount: W })).toEqual({
      action: "heal",
      assignee: W,
    })
  })

  it("heals a live Claimed task in the assigned window (assignee re-set)", () => {
    expect(decideClaimHeal({ dbStatus: "assigned", onChainState: "Claimed", workerAccount: W })).toEqual({
      action: "heal",
      assignee: W,
    })
  })

  // ── the client-vanished backlog (the closed BOUNDARY) ──────────────────────
  // The lifecycle moved past Claimed on-chain before any heal ran. The chain
  // still retains worker_account in all of these states, so the claim heals and
  // the reconciler's in-order replay converges the row to parity.

  it("heals a Submitted backlog (claim+submit landed in one cursor window)", () => {
    expect(decideClaimHeal({ dbStatus: "open", onChainState: "Submitted", workerAccount: W })).toEqual({
      action: "heal",
      assignee: W,
    })
  })

  it("heals a Released backlog (the full claim→submit→approve client-vanished lifecycle)", () => {
    expect(decideClaimHeal({ dbStatus: "open", onChainState: "Released", workerAccount: W })).toEqual({
      action: "heal",
      assignee: W,
    })
  })

  it("heals a Disputed backlog (worker on record while the dispute is live)", () => {
    expect(decideClaimHeal({ dbStatus: "open", onChainState: "Disputed", workerAccount: W })).toEqual({
      action: "heal",
      assignee: W,
    })
  })

  it("heals a dispute-loss Refunded backlog (worker retained — they claimed and lost, still the assignee)", () => {
    // cancel paths ALSO end Refunded but clear worker_account (→ skip below);
    // a Refunded WITH a worker is only reachable via the dispute path.
    expect(decideClaimHeal({ dbStatus: "open", onChainState: "Refunded", workerAccount: W })).toEqual({
      action: "heal",
      assignee: W,
    })
  })

  // ── attribution safety (unchanged invariants) ──────────────────────────────

  it("SKIPS an expired claim: state back to Open, worker_account cleared — never heals the abandoner", () => {
    // The core R3-2 attribution-safety invariant: an expired claim (on-chain
    // Open, worker_account None) must NOT heal to the worker who walked away.
    const d = decideClaimHeal({ dbStatus: "open", onChainState: "Open", workerAccount: null })
    expect(d.action).toBe("skip")
  })

  it("SKIPS a refunded/cancelled claim (no worker_account on record)", () => {
    expect(decideClaimHeal({ dbStatus: "open", onChainState: "Refunded", workerAccount: null }).action).toBe("skip")
  })

  it("SKIPS when the on-chain state is unreadable and no worker on record", () => {
    expect(decideClaimHeal({ dbStatus: "assigned", onChainState: null, workerAccount: null }).action).toBe("skip")
  })

  it("never heals without a worker_account, even if on-chain still shows Claimed (fail closed)", () => {
    expect(decideClaimHeal({ dbStatus: "open", onChainState: "Claimed", workerAccount: null }).action).toBe("skip")
  })

  it("SURFACES a live Claimed task whose DB status is already past the healable window", () => {
    const d = decideClaimHeal({ dbStatus: "submitted", onChainState: "Claimed", workerAccount: W })
    expect(d).toMatchObject({ action: "surface", assignee: W })
  })

  it("SURFACES a Released task whose DB status is past the healable window — never heals over it", () => {
    const d = decideClaimHeal({ dbStatus: "paid", onChainState: "Released", workerAccount: W })
    expect(d).toMatchObject({ action: "surface", assignee: W })
  })

  it("SURFACES (never heals) an Open state that impossibly retains a worker — inconsistent read", () => {
    // expire_claim clears worker_account when returning a task to Open; a
    // worker on an Open task is a shape/parse anomaly, not a heal source.
    const d = decideClaimHeal({ dbStatus: "open", onChainState: "Open", workerAccount: W })
    expect(d).toMatchObject({ action: "surface", assignee: W })
    expect(d.action).not.toBe("heal")
  })

  it("SURFACES (never heals) an unreadable state that still carries a worker", () => {
    const d = decideClaimHeal({ dbStatus: "open", onChainState: null, workerAccount: W })
    expect(d).toMatchObject({ action: "surface", assignee: W })
  })
})

describe("classifyHealResult", () => {
  it("healed on ok", () => {
    expect(classifyHealResult({ ok: true })).toBe("healed")
  })

  it("retry (hold cursor) on a 422 — event re-verification failed = transient for the reconciler", () => {
    // The event was already read from the committed-tx stream, so a failed
    // re-read must retry, not advance the cursor past the unhealed row.
    expect(classifyHealResult({ ok: false, httpStatus: 422 })).toBe("retry")
  })

  it("unreconcilable on a terminal rejection (lifecycle 409 / authz 403 / 501)", () => {
    expect(classifyHealResult({ ok: false, httpStatus: 409 })).toBe("unreconcilable")
    expect(classifyHealResult({ ok: false, httpStatus: 403 })).toBe("unreconcilable")
    expect(classifyHealResult({ ok: false, httpStatus: 501 })).toBe("unreconcilable")
  })
})
