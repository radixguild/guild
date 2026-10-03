import { describe, it, expect } from "vitest"
import {
  parseSettlementCreditedEvent,
  parseWithdrawalEvent,
  parseEntitlementEvent,
  entitlementEventTaskId,
  netEntitlements,
  ENTITLEMENT_EVENT_NAMES,
} from "@/lib/escrow-entitlements"

/**
 * PULL entitlement ingestion (redesign §5c) — the decode half.
 *
 * These payloads are the Gateway's programmatic_json shape: struct fields carry
 * `field_name` + `value`, and Scrypto enums put the variant on `variant_name`
 * (same convention gateway.ts already reads for TaskState / raised_by).
 */

const XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"

function withdrawal(over: Record<string, unknown> = {}) {
  const base = {
    task_id: "7",
    party: "Worker",
    lane: "Reward",
    resource: XRD,
    amount: "100",
    destination: "account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw",
    ...over,
  }
  return [
    { field_name: "task_id", value: base.task_id },
    { field_name: "party", variant_name: base.party },
    { field_name: "lane", variant_name: base.lane },
    { field_name: "resource", value: base.resource },
    { field_name: "amount", value: base.amount },
    { field_name: "destination", value: base.destination },
  ]
}

function settlement(over: Record<string, string> = {}) {
  const base = {
    worker_entitled: "100",
    poster_entitled: "5",
    worker_bond_entitled: "0",
    poster_bond_entitled: "0",
    ...over,
  }
  return [
    { field_name: "task_id", value: "7" },
    { field_name: "worker_entitled", value: base.worker_entitled },
    { field_name: "poster_entitled", value: base.poster_entitled },
    { field_name: "worker_bond_entitled", value: base.worker_bond_entitled },
    { field_name: "poster_bond_entitled", value: base.poster_bond_entitled },
  ]
}

describe("parseWithdrawalEvent", () => {
  it("decodes a full withdrawal leg", () => {
    expect(parseWithdrawalEvent(withdrawal())).toEqual({
      txType: "withdraw",
      party: "worker",
      lane: "reward",
      amountXrd: "100",
      destination: "account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw",
    })
  })

  /**
   * THE trap this whole chunk is keyed around. `deposit_both_lanes` calls
   * `take_lane` twice in ONE transaction, and in production the reward token IS
   * XRD — so these two events are identical in (task_id, party, resource) and
   * differ only in `lane` and `amount`. Anything de-duplicating on the resource
   * silently drops a leg, and the party is then short-paid in the ledger while
   * the chain says they collected.
   */
  it("distinguishes the two lanes of ONE tx that share a resource", () => {
    const reward = parseWithdrawalEvent(withdrawal({ lane: "Reward", amount: "100" }))
    const bond = parseWithdrawalEvent(withdrawal({ lane: "Bond", amount: "5" }))
    expect(reward!.lane).toBe("reward")
    expect(bond!.lane).toBe("bond")
    // Same party, same resource — only the lane tells them apart.
    expect(reward!.party).toBe(bond!.party)
    expect(reward).not.toEqual(bond)
  })

  it("fails closed on an unknown party or lane variant", () => {
    expect(parseWithdrawalEvent(withdrawal({ party: "Arbiter" }))).toBeNull()
    expect(parseWithdrawalEvent(withdrawal({ lane: "Insurance" }))).toBeNull()
  })

  it("fails closed on a missing or malformed amount", () => {
    expect(parseWithdrawalEvent(withdrawal({ amount: undefined }))).toBeNull()
    expect(parseWithdrawalEvent(withdrawal({ amount: "1.2.3" }))).toBeNull()
    // A negative amount is a shape we do not understand; never guess at money.
    expect(parseWithdrawalEvent(withdrawal({ amount: "-5" }))).toBeNull()
  })

  it("fails closed on a non-array payload", () => {
    expect(parseWithdrawalEvent(null)).toBeNull()
    expect(parseWithdrawalEvent({})).toBeNull()
    expect(parseWithdrawalEvent("nope")).toBeNull()
  })

  it("tolerates a missing destination rather than dropping the row", () => {
    // The payee pin is audit metadata; losing it must not lose the money fact.
    const row = parseWithdrawalEvent(withdrawal({ destination: undefined }))
    expect(row).not.toBeNull()
    expect(row!.destination).toBeNull()
    expect(row!.amountXrd).toBe("100")
  })
})

describe("parseSettlementCreditedEvent", () => {
  it("emits one row per non-zero lane", () => {
    expect(parseSettlementCreditedEvent(settlement())).toEqual([
      { txType: "settle", party: "worker", lane: "reward", amountXrd: "100", destination: null },
      { txType: "settle", party: "poster", lane: "reward", amountXrd: "5", destination: null },
    ])
  })

  /**
   * The blueprint reports ALL four amounts including zeros — `expire_claim`
   * credits only the bond, so its reward lanes read {0, 0}: "a settlement event
   * stating that nothing settled". A zero entitlement is not a ledger fact.
   */
  it("drops zero lanes — the expire_claim shape", () => {
    const rows = parseSettlementCreditedEvent(
      settlement({
        worker_entitled: "0",
        poster_entitled: "0",
        poster_bond_entitled: "5",
      }),
    )
    expect(rows).toEqual([
      { txType: "settle", party: "poster", lane: "bond", amountXrd: "5", destination: null },
    ])
  })

  it("treats 0.000 as zero, not as a row", () => {
    const rows = parseSettlementCreditedEvent(
      settlement({ worker_entitled: "0.000", poster_entitled: "0" }),
    )
    expect(rows).toEqual([])
  })

  it("returns [] for an unreadable payload instead of throwing", () => {
    // A malformed event must not abort a resync that has real events after it.
    expect(parseSettlementCreditedEvent(null)).toEqual([])
    expect(parseSettlementCreditedEvent([{ field_name: "task_id", value: "7" }])).toEqual([])
  })
})

describe("parseEntitlementEvent / dispatch", () => {
  it("routes by event name and ignores everything else", () => {
    expect(parseEntitlementEvent("WithdrawalEvent", withdrawal())).toHaveLength(1)
    expect(parseEntitlementEvent("SettlementCreditedEvent", settlement())).toHaveLength(2)
    // A lifecycle event must never be decoded as an entitlement.
    expect(parseEntitlementEvent("TaskReleasedEvent", withdrawal())).toEqual([])
  })

  it("the exported name list matches what dispatch actually handles", () => {
    // Guards the resync scanner, which filters on this list before decoding: a
    // name here that dispatch ignores would be collected and silently dropped.
    for (const name of ENTITLEMENT_EVENT_NAMES) {
      const payload = name === "WithdrawalEvent" ? withdrawal() : settlement()
      expect(parseEntitlementEvent(name, payload).length).toBeGreaterThan(0)
    }
  })

  it("reads the task id for stream filtering", () => {
    expect(entitlementEventTaskId(withdrawal())).toBe(7)
    expect(entitlementEventTaskId(null)).toBeNull()
  })
})

describe("netEntitlements — settled vs withdrawn", () => {
  it("reports outstanding money on a task that is already 'paid'", () => {
    // The §5c condition: released on chain, worker not actually paid.
    const net = netEntitlements([
      { txType: "settle", party: "worker", amountXrd: "100" },
      { txType: "settle", party: "poster", amountXrd: "5" },
    ])
    expect(net.worker).toEqual({ credited: "100", collected: "0", outstanding: "100" })
    expect(net.poster.outstanding).toBe("5")
  })

  it("nets to zero once both lanes are collected", () => {
    const net = netEntitlements([
      { txType: "settle", party: "worker", amountXrd: "100" },
      { txType: "settle", party: "worker", amountXrd: "5" },
      { txType: "withdraw", party: "worker", amountXrd: "100" },
      { txType: "withdraw", party: "worker", amountXrd: "5" },
    ])
    expect(net.worker).toEqual({ credited: "105", collected: "105", outstanding: "0" })
  })

  it("is exact — never float arithmetic", () => {
    const net = netEntitlements([
      { txType: "settle", party: "worker", amountXrd: "0.1" },
      { txType: "settle", party: "worker", amountXrd: "0.2" },
    ])
    expect(net.worker.credited).toBe("0.3")
  })

  /**
   * ⚠️ The 0.1 + 0.2 case above does NOT discriminate, and that is worth stating
   * because it is the reflexive example everyone reaches for. Verified by
   * mutation: swapping the exact scaler for `Math.round(Number(v) * 1e18)` keeps
   * it green — the rounding absorbs the error at that magnitude.
   *
   * These amounts do discriminate. A Radix Decimal carries 18 places, which is
   * more significant digits than a float has, so any value using them is beyond
   * IEEE754 well before the numbers get large.
   */
  it("survives amounts a float genuinely cannot represent", () => {
    // exact 123456789012345678 vs float 123456789012345680 — the last two places.
    const net = netEntitlements([
      { txType: "settle", party: "worker", amountXrd: "0.123456789012345678" },
    ])
    expect(net.worker.credited).toBe("0.123456789012345678")

    // And at scale the float answer is not merely imprecise, it crosses a whole
    // unit boundary: 999999999.999999999999999999 → 1000000000.000000013287555072
    const big = netEntitlements([
      { txType: "settle", party: "poster", amountXrd: "999999999.999999999999999999" },
    ])
    expect(big.poster.credited).toBe("999999999.999999999999999999")
  })

  it("keeps a subtraction exact at 18dp", () => {
    const net = netEntitlements([
      { txType: "settle", party: "worker", amountXrd: "0.123456789012345678" },
      { txType: "withdraw", party: "worker", amountXrd: "0.123456789012345677" },
    ])
    // One unit at the smallest place must survive the round trip.
    expect(net.worker.outstanding).toBe("0.000000000000000001")
  })

  it("keeps 18dp precision", () => {
    const net = netEntitlements([
      { txType: "settle", party: "worker", amountXrd: "0.000000000000000001" },
    ])
    expect(net.worker.credited).toBe("0.000000000000000001")
  })

  it("renders an over-collection as a visible negative, never its absolute value", () => {
    // Impossible on chain (take_lane zeroes before paying), so if it ever shows
    // up the ledger disagrees with the chain and must SAY so.
    const net = netEntitlements([
      { txType: "settle", party: "worker", amountXrd: "1" },
      { txType: "withdraw", party: "worker", amountXrd: "3" },
    ])
    expect(net.worker.outstanding).toBe("-2")
  })

  it("ignores rows for an unknown party rather than mis-attributing them", () => {
    const net = netEntitlements([
      { txType: "settle", party: "arbiter" as "worker", amountXrd: "9" },
    ])
    expect(net.worker.credited).toBe("0")
    expect(net.poster.credited).toBe("0")
  })
})
