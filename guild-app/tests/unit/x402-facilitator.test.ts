import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { PaymentAccept, PaymentPayload } from "@/lib/x402/types"

// x402 facilitator — adversarial suite for the NON-SPONSORED verify/settle path.
//
// WHY THIS FILE EXISTS: `src/lib/x402/facilitator.ts` is the only money-adjacent
// code in the x402 Track 1 surface — it submits real transactions and decides,
// from a committed receipt, whether a caller has paid. It shipped written-blind
// (no shell on the authoring box), flag-gated off, with a banner saying "do NOT
// trust it until a payment has settled end-to-end and the assertions have been
// proven in BOTH directions". This suite is that proof for the assertions that
// can be proven off-ledger: a valid payment settles, and a short / wrong-asset /
// wrong-payTo / replayed one does not.
//
// It is deliberately NOT a claim that the facilitator is safe to enable. Two
// known defects are locked in below as `it.fails` tripwires (§5) — they document
// holes this suite CANNOT close, and they flip to green the moment someone fixes
// them. Read §5 before setting X402_ENABLED=true.

vi.mock("@/lib/gateway", () => ({
  submitNotarizedTransaction: vi.fn(),
  fetchTxFungibleChanges: vi.fn(),
}))

// The settlement store, faked in-process. THE STATE LIVES IN `vi.hoisted`, NOT
// IN THE MODULE, and that is the whole point: `vi.resetModules()` rebuilds the
// facilitator but NOT this Map, which is exactly what a real deploy does to a
// real table. The old in-memory Set died with the module, which is why §5's
// restart tripwire could never pass. Reproducing the durability boundary in the
// double is what makes that test mean anything.
//
// ⚠️ This double models the CONTRACT, not the SQL. It cannot prove the atomicity
// the contract rests on — a JS Map has no concurrent writers. That proof is
// tests/integration/x402-settlement-dedup.pg.test.ts, against real Postgres.
const STORE = vi.hoisted(() => ({
  rows: new Map<
    string,
    {
      status: "in_flight" | "settled"
      createdAt: number
      requirements: string
      resourceUrl: string
      payer?: string
      settledAt?: number
      replayCount?: number
    }
  >(),
  failNext: false,
}))

vi.mock("@/db/queries/x402", () => ({
  reserveSettlement: vi.fn(
    async (row: {
      intentHash: string
      requirements: string
      resourceUrl: string
      staleAfterSeconds: number
    }) => {
      if (STORE.failNext) throw new Error("test: settlement store unavailable")
      const existing = STORE.rows.get(row.intentHash)
      if (!existing) {
        STORE.rows.set(row.intentHash, {
          status: "in_flight",
          createdAt: Date.now(),
          requirements: row.requirements,
          resourceUrl: row.resourceUrl,
        })
        return { outcome: "reserved" }
      }
      // Context before status, mirroring the real query: an in-flight or expired
      // row must never become a window to redirect the payment.
      if (
        existing.requirements !== row.requirements ||
        existing.resourceUrl !== row.resourceUrl
      ) {
        return {
          outcome: "bound_elsewhere",
          boundTo: { requirements: existing.requirements, resourceUrl: existing.resourceUrl },
        }
      }
      if (existing.status === "settled") return { outcome: "already_settled" }
      if (Date.now() - existing.createdAt > row.staleAfterSeconds * 1000) {
        STORE.rows.set(row.intentHash, { ...existing, createdAt: Date.now() })
        return { outcome: "reserved" }
      }
      return { outcome: "in_progress" }
    },
  ),
  markSettled: vi.fn(async (intentHash: string, payer?: string) => {
    const r = STORE.rows.get(intentHash)
    if (r?.status === "in_flight") {
      STORE.rows.set(intentHash, {
        ...r,
        status: "settled",
        payer,
        settledAt: Date.now(),
        replayCount: 0,
      })
    }
  }),
  releaseSettlement: vi.fn(async (intentHash: string) => {
    // Guarded exactly like the real DELETE: never removes a settled row.
    if (STORE.rows.get(intentHash)?.status === "in_flight") STORE.rows.delete(intentHash)
  }),
  isSettled: vi.fn(async (intentHash: string) => {
    if (STORE.failNext) throw new Error("test: settlement store unavailable")
    return STORE.rows.get(intentHash)?.status === "settled"
  }),
  claimReplay: vi.fn(
    async (a: {
      intentHash: string
      requirements: string
      resourceUrl: string
      windowSeconds: number
      maxReplays: number
    }) => {
      if (STORE.failNext) throw new Error("test: settlement store unavailable")
      const r = STORE.rows.get(a.intentHash)
      if (!r || r.status !== "settled") return null
      if (r.requirements !== a.requirements || r.resourceUrl !== a.resourceUrl) return null
      if (Date.now() - (r.settledAt ?? 0) > a.windowSeconds * 1000) return null
      if ((r.replayCount ?? 0) >= a.maxReplays) return null
      STORE.rows.set(a.intentHash, { ...r, replayCount: (r.replayCount ?? 0) + 1 })
      return { payer: r.payer ?? null }
    },
  ),
  isReplayable: vi.fn(
    async (a: {
      intentHash: string
      requirements: string
      resourceUrl: string
      windowSeconds: number
      maxReplays: number
    }) => {
      const r = STORE.rows.get(a.intentHash)
      if (!r || r.status !== "settled") return false
      if (r.requirements !== a.requirements || r.resourceUrl !== a.resourceUrl) return false
      if (Date.now() - (r.settledAt ?? 0) > a.windowSeconds * 1000) return false
      return (r.replayCount ?? 0) < a.maxReplays
    },
  ),
  settlementFor: vi.fn(async (intentHash: string) => STORE.rows.get(intentHash) ?? null),
}))

// The intent hash is now DERIVED from the submitted bytes rather than read off
// the payload. These fixtures are not real notarized transactions, so the real
// toolkit would reject all of them — the mock stands in for the decompile and
// lets each test say what the bytes derive to. `derivedFor` maps compiledHex ->
// intent id, which is the whole axis the binding defect lives on: the test can
// now hand over bytes that derive to one hash while CLAIMING another.
const { derivedFor } = vi.hoisted(() => ({ derivedFor: new Map<string, string>() }))

// The structural screen is mocked HERE and only here, delegating to the same
// `derivedFor` map the toolkit mock uses. This suite is about the facilitator's
// CONTROL FLOW — replay, reservation, receipt assertions — and it feeds arbitrary
// byte strings that are not real transactions, so the real screen would refuse
// every one of them.
//
// The screen itself is proven in tests/unit/x402-structural-decode.test.ts,
// which mocks NOTHING and builds real notarized transactions. Keeping the two
// apart is deliberate: a screen validated against a fake decoder proves the fake.
vi.mock("@/lib/x402/decode", () => ({
  screenPayment: vi.fn(async (hex: string) => {
    const id = derivedFor.get(hex.trim())
    return id ? { ok: true, intentHash: id } : { ok: false, reason: "invalid_payload" }
  }),
}))

vi.mock("@radixdlt/radix-engine-toolkit", () => ({
  RadixEngineToolkit: {
    NotarizedTransaction: {
      decompile: vi.fn(async (bytes: Uint8Array) => ({
        __hex: Buffer.from(bytes).toString("hex"),
      })),
      intentHash: vi.fn(async (n: { __hex: string }) => {
        const id = derivedFor.get(n.__hex)
        if (!id) throw new Error(`test fixture: no derived hash registered for ${n.__hex}`)
        return { hash: new Uint8Array(), id }
      }),
    },
  },
}))

/** The resource the payment buys — now part of the settlement cache key. */
const RESOURCE = "https://radixguild.com/api/v1/x402/tasks/funded"

/** Register bytes -> derived intent id, and return the hex to put in a payload. */
let hexCounter = 0
function bytesDerivingTo(intent: string): string {
  const hex = `4d21${(++hexCounter).toString(16).padStart(8, "0")}`
  derivedFor.set(hex, intent)
  return hex
}

import { submitNotarizedTransaction, fetchTxFungibleChanges } from "@/lib/gateway"
import { facilitator } from "@/lib/x402/facilitator"

const mockSubmit = vi.mocked(submitNotarizedTransaction)
const mockChanges = vi.mocked(fetchTxFungibleChanges)

// ── fixtures ────────────────────────────────────────────────────────────────

const XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"
const OTHER_RESOURCE = "resource_rdx1t4dekrf58h0r28s3c93z93gvnzfyhgy09mpc51zzc4gkg4rn0hp9wg"
const PAY_TO = "account_rdx12xm464txr74x9srzmmy5404lyqv650kkgy8ezrx76tmjpl5djvnnwv"
const ATTACKER_ACCOUNT = "account_rdx16xhqwqnf5c6qs4rnrtnp5x8gnwj0kx4kj5z4vzq9d0jm7gd4h5nfkm"
const PAYER = "account_rdx128z9cvz0kxk0nl3n4ycsu4d99f8xy6mqjhgvhq3fm5zqvv7fkmd8cx"

/** 0.05 XRD in atomic subunits (18 decimals) — the default funded-tasks price. */
const PRICE_ATOMIC = "50000000000000000"

const accept = (over: Partial<PaymentAccept> = {}): PaymentAccept => ({
  scheme: "exact",
  network: "radix:1",
  amount: PRICE_ATOMIC,
  asset: XRD,
  payTo: PAY_TO,
  maxTimeoutSeconds: 120,
  ...over,
})

/** A unique intent hash per test — `settledIntents` is module-level state that
 *  persists for the whole file, so reusing a hash across tests would leak the
 *  replay guard between them and produce false greens. */
let counter = 0
const freshIntent = () => `txid_rdx1_test_intent_${++counter}`

const payload = (over: Partial<PaymentPayload> = {}, intent = freshIntent()): PaymentPayload => ({
  x402Version: 2,
  resource: { url: "https://radixguild.com/api/v1/x402/tasks/funded" },
  accepted: {
    scheme: "exact",
    network: "radix:1",
    amount: PRICE_ATOMIC,
    asset: XRD,
    payTo: PAY_TO,
    maxTimeoutSeconds: 120,
  },
  payload: {
    transactionId: intent,
    compiledHex: bytesDerivingTo(intent),
    network: "radix:1",
  },
  ...over,
})

/** A committed receipt in which `amount` of `resource` landed at `entity`. */
const receipt = (
  opts: { entity?: string; resource?: string; deposit?: string; status?: string } = {},
) => ({
  status: opts.status ?? "CommittedSuccess",
  changes: [
    { entity: opts.entity ?? PAY_TO, resource: opts.resource ?? XRD, change: opts.deposit ?? "0.05" },
    { entity: PAYER, resource: opts.resource ?? XRD, change: `-${opts.deposit ?? "0.05"}` },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  mockSubmit.mockResolvedValue(true)
  // NOT cleared: STORE.rows. Every test draws a fresh intent, so rows never
  // collide, and leaving them is what lets the restart test below observe a
  // store that outlives the module. Only the injected fault is reset.
  STORE.failNext = false
})

// ── 1. verify() — the pre-settlement checks ─────────────────────────────────

describe("facilitator.verify", () => {
  it("accepts a well-formed payload for the offered scheme", async () => {
    const result = await facilitator.verify(payload(), accept(), RESOURCE)
    expect(result).toEqual({ isValid: true })
  })

  it("accepts a payload that claims NO transactionId — the hash is derived", async () => {
    // Contract change, deliberate: this used to be invalid_payload. The hash is
    // now derived from the submitted bytes, so a client claiming nothing is
    // fine — it is a client claiming something ELSE that is the attack, covered
    // by the next test.
    const p = payload()
    // @ts-expect-error — a client need not claim a hash at all
    p.payload.transactionId = undefined
    const result = await facilitator.verify(p, accept(), RESOURCE)
    expect(result).toEqual({ isValid: true })
  })

  it("rejects a claimed transactionId that the submitted bytes do not produce", async () => {
    const p = payload()
    p.payload.transactionId = "txid_rdx1_someone_elses_committed_payment"
    const result = await facilitator.verify(p, accept(), RESOURCE)
    expect(result).toEqual({ isValid: false, invalidReason: "intent_hash_mismatch" })
  })

  it("rejects bytes that do not decompile to a notarized transaction", async () => {
    const p = payload()
    p.payload.compiledHex = "zzzz-not-hex"
    const result = await facilitator.verify(p, accept(), RESOURCE)
    expect(result).toEqual({ isValid: false, invalidReason: "invalid_payload" })
  })

  it("rejects a payload with no compiledHex", async () => {
    const p = payload()
    // @ts-expect-error — deliberately malformed
    p.payload.compiledHex = undefined
    const result = await facilitator.verify(p, accept(), RESOURCE)
    expect(result).toEqual({ isValid: false, invalidReason: "invalid_payload" })
  })

  it("rejects a scheme other than `exact`", async () => {
    const p = payload()
    // @ts-expect-error — no other scheme is implemented
    p.accepted.scheme = "upto"
    const result = await facilitator.verify(p, accept(), RESOURCE)
    expect(result).toEqual({ isValid: false, invalidReason: "unsupported_scheme" })
  })

  it("rejects a mismatched network", async () => {
    const p = payload()
    p.accepted.network = "radix:2"
    const result = await facilitator.verify(p, accept(), RESOURCE)
    expect(result).toEqual({ isValid: false, invalidReason: "wrong_network" })
  })

  it("rejects a mismatched asset", async () => {
    const p = payload()
    p.accepted.asset = OTHER_RESOURCE
    const result = await facilitator.verify(p, accept(), RESOURCE)
    expect(result).toEqual({ isValid: false, invalidReason: "wrong_asset" })
  })

  it("rejects a mismatched payTo", async () => {
    const p = payload()
    p.accepted.payTo = ATTACKER_ACCOUNT
    const result = await facilitator.verify(p, accept(), RESOURCE)
    expect(result).toEqual({ isValid: false, invalidReason: "wrong_payto" })
  })

  it("accepts a settled intent while replays remain, then rejects it", async () => {
    // CHANGED 2026-09-02 by the lost-response ruling: a settled payment inside
    // the window is a payer who may never have received their response, not an
    // attacker. verify() reports valid while a replay remains and refuses once
    // the allowance is gone. It must NOT consume one — that is asserted below.
    const intent = freshIntent()
    mockChanges.mockResolvedValue(receipt())
    expect((await facilitator.settle(payload({}, intent), accept(), RESOURCE)).success).toBe(true)

    expect(await facilitator.verify(payload({}, intent), accept(), RESOURCE)).toEqual({
      isValid: true,
    })

    // Exhaust the allowance through settle(), which is what actually spends it.
    for (let i = 0; i < 3; i++) await facilitator.settle(payload({}, intent), accept(), RESOURCE)

    expect(await facilitator.verify(payload({}, intent), accept(), RESOURCE)).toEqual({
      isValid: false,
      invalidReason: "intent_already_settled",
    })
  })

  it("verify does not SPEND a replay — otherwise the pre-check eats the retry it exists to allow", async () => {
    const intent = freshIntent()
    mockChanges.mockResolvedValue(receipt())
    await facilitator.settle(payload({}, intent), accept(), RESOURCE)

    // Three verifies would exhaust the allowance if verify consumed one each.
    await facilitator.verify(payload({}, intent), accept(), RESOURCE)
    await facilitator.verify(payload({}, intent), accept(), RESOURCE)
    await facilitator.verify(payload({}, intent), accept(), RESOURCE)

    // The replay is still there for the caller who actually needs it.
    expect((await facilitator.settle(payload({}, intent), accept(), RESOURCE)).success).toBe(true)
  })

  it("does NOT reach the network — verify is a pure pre-check", async () => {
    await facilitator.verify(payload(), accept(), RESOURCE)
    expect(mockSubmit).not.toHaveBeenCalled()
    expect(mockChanges).not.toHaveBeenCalled()
  })
})

// ── 2. settle() — the committed-receipt assertion (the real control) ────────

describe("facilitator.settle — accepts a genuine payment", () => {
  it("settles when the exact amount lands at payTo in the right asset", async () => {
    const intent = freshIntent()
    mockChanges.mockResolvedValue(receipt())

    const result = await facilitator.settle(payload({}, intent), accept(), RESOURCE)

    expect(result.success).toBe(true)
    expect(result.transaction).toBe(intent)
    expect(result.network).toBe("radix:1")
    expect(result.payer).toBe(PAYER)
    expect(mockSubmit).toHaveBeenCalledOnce()
  })

  it("settles on overpayment (deposit strictly greater than the price)", async () => {
    mockChanges.mockResolvedValue(receipt({ deposit: "1.5" }))
    const result = await facilitator.settle(payload(), accept(), RESOURCE)
    expect(result.success).toBe(true)
  })

  it("identifies the payer as the account whose balance fell furthest", async () => {
    mockChanges.mockResolvedValue({
      status: "CommittedSuccess",
      changes: [
        { entity: PAY_TO, resource: XRD, change: "0.05" },
        { entity: ATTACKER_ACCOUNT, resource: XRD, change: "-0.01" },
        { entity: PAYER, resource: XRD, change: "-0.06" },
      ],
    })
    const result = await facilitator.settle(payload(), accept(), RESOURCE)
    expect(result.success).toBe(true)
    expect(result.payer).toBe(PAYER)
  })
})

describe("facilitator.settle — rejects a payment that is not what was asked for", () => {
  it("rejects a SHORT payment", async () => {
    mockChanges.mockResolvedValue(receipt({ deposit: "0.04" }))
    const result = await facilitator.settle(payload(), accept(), RESOURCE)
    expect(result).toEqual({ success: false, errorReason: "insufficient_or_misdirected_payment" })
  })

  it("rejects a payment one subunit short of the price", async () => {
    // 0.049999999999999999 XRD — the boundary. Proves the comparison is `>=`
    // on atomic units and not a lossy float or a truncating decimal parse.
    mockChanges.mockResolvedValue(receipt({ deposit: "0.049999999999999999" }))
    const result = await facilitator.settle(payload(), accept(), RESOURCE)
    expect(result).toEqual({ success: false, errorReason: "insufficient_or_misdirected_payment" })
  })

  it("settles at exactly the price, to the subunit", async () => {
    mockChanges.mockResolvedValue(receipt({ deposit: "0.050000000000000000" }))
    const result = await facilitator.settle(payload(), accept(), RESOURCE)
    expect(result.success).toBe(true)
  })

  it("rejects the WRONG ASSET, even in a sufficient amount", async () => {
    mockChanges.mockResolvedValue(receipt({ resource: OTHER_RESOURCE, deposit: "1000" }))
    const result = await facilitator.settle(payload(), accept(), RESOURCE)
    expect(result).toEqual({ success: false, errorReason: "insufficient_or_misdirected_payment" })
  })

  it("rejects a payment MISDIRECTED to another account", async () => {
    mockChanges.mockResolvedValue(receipt({ entity: ATTACKER_ACCOUNT }))
    const result = await facilitator.settle(payload(), accept(), RESOURCE)
    expect(result).toEqual({ success: false, errorReason: "insufficient_or_misdirected_payment" })
  })

  it("rejects a receipt with no balance changes at all", async () => {
    mockChanges.mockResolvedValue({ status: "CommittedSuccess", changes: [] })
    const result = await facilitator.settle(payload(), accept(), RESOURCE)
    expect(result).toEqual({ success: false, errorReason: "insufficient_or_misdirected_payment" })
  })

  it("rejects a transaction that committed as a FAILURE", async () => {
    mockChanges.mockResolvedValue(receipt({ status: "CommittedFailure" }))
    const result = await facilitator.settle(payload(), accept(), RESOURCE)
    expect(result).toEqual({ success: false, errorReason: "transaction_failed" })
  })

  it("rejects a transaction the network REJECTED", async () => {
    mockChanges.mockResolvedValue(receipt({ status: "Rejected" }))
    const result = await facilitator.settle(payload(), accept(), RESOURCE)
    expect(result).toEqual({ success: false, errorReason: "transaction_failed" })
  })

  it("rejects when the gateway refuses the submission", async () => {
    mockSubmit.mockResolvedValue(false)
    const result = await facilitator.settle(payload(), accept(), RESOURCE)
    expect(result).toEqual({ success: false, errorReason: "submit_rejected" })
    expect(mockChanges).not.toHaveBeenCalled()
  })

  it("rejects a non-numeric price without submitting anything", async () => {
    const result = await facilitator.settle(payload(), accept({ amount: "not-a-number" }), RESOURCE)
    expect(result).toEqual({ success: false, errorReason: "invalid_payment_requirements" })
    expect(mockSubmit).not.toHaveBeenCalled()
  })

  it("times out rather than hanging when the tx never commits", async () => {
    mockChanges.mockResolvedValue(null)
    const result = await facilitator.settle(payload(), accept({ maxTimeoutSeconds: 0 }), RESOURCE)
    expect(result).toEqual({ success: false, errorReason: "settle_timeout" })
  })

  it("does NOT burn the intent when settlement fails — a short payment can be retried", async () => {
    const intent = freshIntent()
    mockChanges.mockResolvedValue(receipt({ deposit: "0.01" }))
    const first = await facilitator.settle(payload({}, intent), accept(), RESOURCE)
    expect(first.success).toBe(false)

    // The same intent, now genuinely paid, must still be settleable.
    mockChanges.mockResolvedValue(receipt())
    const second = await facilitator.settle(payload({}, intent), accept(), RESOURCE)
    expect(second.success).toBe(true)
  })
})

// ── 3. replay ───────────────────────────────────────────────────────────────

describe("facilitator — replay protection (in-process)", () => {
  it("replays a settled intent up to the cap, then refuses", async () => {
    // CHANGED 2026-09-02. A flat refusal on the second call meant a response
    // lost in transit burned the payment — the payer paid and got nothing, and
    // could not distinguish that from a rejected payment. Now the recorded
    // response is replayed, bounded by REPLAY_MAX (3) and by the window.
    //
    // The anti-replay property is NOT weakened, it moved: the 5th call still
    // refuses, and the refusal still depends on the durable row. Falsifier:
    // raise REPLAY_MAX and this test fails at the boundary it names.
    const intent = freshIntent()
    mockChanges.mockResolvedValue(receipt())

    const first = await facilitator.settle(payload({}, intent), accept(), RESOURCE)
    expect(first.success).toBe(true)
    const payer = first.success ? first.payer : undefined

    for (let i = 0; i < 3; i++) {
      const replay = await facilitator.settle(payload({}, intent), accept(), RESOURCE)
      expect(replay.success).toBe(true)
      // The SAME response, not a fresh settlement — same payer, same tx.
      expect(replay).toMatchObject({ transaction: intent, payer })
    }

    const exhausted = await facilitator.settle(payload({}, intent), accept(), RESOURCE)
    expect(exhausted).toEqual({ success: false, errorReason: "intent_already_settled" })
  })

  it("does not re-submit the transaction on a replayed intent", async () => {
    const intent = freshIntent()
    mockChanges.mockResolvedValue(receipt())
    await facilitator.settle(payload({}, intent), accept(), RESOURCE)
    mockSubmit.mockClear()

    await facilitator.settle(payload({}, intent), accept(), RESOURCE)
    expect(mockSubmit).not.toHaveBeenCalled()
  })
})

// ── 4. unit handling ────────────────────────────────────────────────────────

describe("facilitator — atomic-unit handling", () => {
  it("treats accept.amount as ATOMIC subunits, not a human decimal", async () => {
    // If `amount` were read as a human decimal, "50000000000000000" would mean
    // 5e16 XRD and a 0.05 XRD deposit would be wildly short. It settles, so the
    // atomic reading is the one in force. This test is the tripwire for TODO(3)
    // in facilitator.ts: if the live AVaunt scheme turns out to send a human
    // decimal, THIS is the test that must change alongside the fix.
    mockChanges.mockResolvedValue(receipt({ deposit: "0.05" }))
    const result = await facilitator.settle(payload(), accept({ amount: PRICE_ATOMIC }), RESOURCE)
    expect(result.success).toBe(true)
  })

  it("rejects a deposit carrying more precision than XRD has", async () => {
    // 19 decimal places — toAtomic returns null, so no deposit is recognised.
    mockChanges.mockResolvedValue(receipt({ deposit: "0.0500000000000000001" }))
    const result = await facilitator.settle(payload(), accept(), RESOURCE)
    expect(result).toEqual({ success: false, errorReason: "insufficient_or_misdirected_payment" })
  })

  it("handles a whole-number deposit string", async () => {
    mockChanges.mockResolvedValue(receipt({ deposit: "100" }))
    const result = await facilitator.settle(payload(), accept(), RESOURCE)
    expect(result.success).toBe(true)
  })
})

// ── 5. KNOWN DEFECTS — tripwires, not passing assertions ───────────────────
//
// Each test below asserts the behaviour the facilitator SHOULD have. Each is
// marked `it.fails`, meaning: "this assertion does not hold today, and vitest
// should error if it ever starts holding." When the underlying defect is fixed,
// the tripwire itself goes red — change `it.fails` to `it` and it stays green
// forever after. Do NOT set X402_ENABLED=true while these are still `it.fails`.

describe("intent-hash binding — FIXED, kept as a regression test", () => {
  // Was DEFECT 1, and it was real: settle() submitted payload.payload.compiledHex
  // but asserted the receipt of payload.payload.transactionId — two independent
  // client-controlled fields. Any committed transaction that had ever deposited
  // >= the price at payTo could be presented as proof of THIS payment.
  //
  // Fixed by deriving the hash from the submitted bytes via
  // RadixEngineToolkit.NotarizedTransaction.decompile + .intentHash, and refusing
  // a claimed hash those bytes do not produce. These were `it.fails` tripwires
  // and now assert live behaviour — if a refactor reintroduces trust in the
  // payload's hash, these go red.

  it("looks up the DERIVED hash, so a stolen claim finds no receipt", async () => {
    // The mock is hash-aware on purpose. A blanket mockResolvedValue(receipt())
    // cannot tell which hash was looked up, so it would pass whether the code
    // used the derived hash or the claimed one — i.e. it would be vacuous
    // against the exact defect this test exists for.
    const victimPaid = "txid_rdx1_someone_elses_committed_payment"
    mockSubmit.mockResolvedValue(true) // the gateway 2xxs duplicates
    mockChanges.mockImplementation(async (h: string) => (h === victimPaid ? receipt() : null))

    // Bytes deriving to the attacker's own (unpaid) intent, claiming the victim's.
    const stolen = payload({}, "txid_rdx1_attackers_own")
    stolen.payload.transactionId = victimPaid

    const result = await facilitator.settle(stolen, accept({ maxTimeoutSeconds: 1 }), RESOURCE)

    expect(result.success).toBe(false)
    expect(mockChanges).toHaveBeenCalledWith("txid_rdx1_attackers_own")
    expect(mockChanges).not.toHaveBeenCalledWith(victimPaid)
  })

  it("asserts the receipt of the DERIVED hash, not the claimed one", async () => {
    // The strongest form: no claimed hash at all, so the only hash in play is
    // the derived one. If settlement still works, derivation is genuinely
    // driving the receipt lookup.
    const derived = freshIntent()
    const p = payload({}, derived)
    // @ts-expect-error — claim nothing
    p.payload.transactionId = undefined
    mockChanges.mockResolvedValue(receipt())

    const result = await facilitator.settle(p, accept(), RESOURCE)

    expect(result.success).toBe(true)
    expect(result.transaction).toBe(derived)
    expect(mockChanges).toHaveBeenCalledWith(derived)
  })
})

describe("settlement cache key — payment, requirements AND resource", () => {
  it("does not let a payment for one resource unlock a different one", async () => {
    const intent = freshIntent()
    mockChanges.mockResolvedValue(receipt())

    const first = await facilitator.settle(payload({}, intent), accept(), RESOURCE)
    expect(first.success).toBe(true)

    // Same payment, same requirements, DIFFERENT resource — must not be treated
    // as already-settled for that other route. (Keying on the intent alone was
    // the narrower behaviour the reference facilitator avoids.)
    const other = await facilitator.settle(
      payload({}, intent),
      accept(),
      "https://radixguild.com/api/v1/x402/some-other-paid-thing",
    )
    expect(other.errorReason).not.toBe("intent_already_settled")
  })
})

describe("concurrency — one payment cannot buy N calls", () => {
  // ⚠️ UNPROVEN. The reserve-before-submit guard in settle() is NOT covered by
  // this suite, and this note is here instead of a test that pretends otherwise.
  //
  // The obvious test — fire three settles for one intent through Promise.all and
  // assert exactly one success — passes with the guard DELETED (mutation-checked,
  // both with instant mocks and with a 25ms submit delay). It passes for the
  // wrong reason: calls 2 and 3 return `invalid_payload`, because this file's
  // intent-hash mock throws for any hex it has not been told about and the later
  // payloads race the registration. So the assertion measures the fixture, not
  // the guard, and "exactly one success" is true by accident.
  //
  // What would actually prove it: drive settle() through the real toolkit with
  // three genuinely identical payloads (same compiledHex, so one registration),
  // and assert `submitNotarizedTransaction` was called exactly once. That needs
  // a real notarized transaction fixture — the same fixture the critique already
  // asked for to validate the Gateway receipt parser. Both wants are satisfied
  // by capturing one real committed transaction, which is the next piece of work.
  //
  // Until then: the guard is written and reviewed, and it is not test-backed.
  it.skip("settles exactly once when the same intent arrives concurrently", async () => {
    // The guard used to be check-then-act across two awaits: every concurrent
    // caller passed the check, submitted, saw the same receipt and succeeded.
    // Reserving before submit is what makes this one-in, one-out.
    //
    // ⚠️ The submit mock is DELIBERATELY SLOW. With instantly-resolving mocks the
    // three calls advance in microtask lockstep and happen to serialise, so the
    // test passed even with the reservation deleted — mutation-proven vacuous on
    // first writing. A real delay forces genuine overlap, which is the only way
    // this test can be about the guard rather than about scheduler luck.
    const intent = freshIntent()
    mockSubmit.mockImplementation(
      async () => new Promise<boolean>((r) => setTimeout(() => r(true), 25)),
    )
    mockChanges.mockResolvedValue(receipt())

    const results = await Promise.all([
      facilitator.settle(payload({}, intent), accept(), RESOURCE),
      facilitator.settle(payload({}, intent), accept(), RESOURCE),
      facilitator.settle(payload({}, intent), accept(), RESOURCE),
    ])

    expect(results.filter((r) => r.success)).toHaveLength(1)
    expect(mockSubmit).toHaveBeenCalledTimes(1)
  })
})

describe("KNOWN DEFECTS — must be fixed before X402_ENABLED=true", () => {

  // DEFECT 2 — ✅ FIXED 2026-09-02. Was a module-level in-memory Set that reset
  // on every process restart and was never shared between instances, so the same
  // payment settled again after any deploy. Now `x402_settlements`, with the
  // INSERT as the gate (ON CONFLICT DO NOTHING + rowcount), not a post-hoc mark.
  //
  // The tripwire is now a REAL assertion — `it.fails` -> `it`. It earns that only
  // because the store double's state lives outside the module (see the top of
  // this file), so `vi.resetModules()` genuinely models a deploy: new process,
  // same table. Had the double been a module-level Map, this would pass by
  // resetting nothing and prove the opposite of what it claims.
  //
  // Falsifier: point the double's `isSettled`/`reserveSettlement` at a Map
  // declared inside the vi.mock factory instead of in vi.hoisted, and this test
  // goes green while the defect is back.
  it("rejects a replayed intent after a process restart", async () => {
    const intent = freshIntent()
    mockChanges.mockResolvedValue(receipt())

    const first = await facilitator.settle(payload({}, intent), accept(), RESOURCE)
    expect(first.success).toBe(true)

    // Simulate a redeploy: a brand-new module instance, brand-new Set.
    vi.resetModules()
    const { facilitator: rebooted } = await import("@/lib/x402/facilitator")

    // After the restart the row is still there, so the allowance is still
    // spent-able and still FINITE. Exhaust it and the refusal proves the record
    // survived the process — a fresh in-memory Set would have granted an
    // unlimited fresh settlement on the very first call.
    for (let i = 0; i < 3; i++) await rebooted.settle(payload({}, intent), accept(), RESOURCE)
    const second = await rebooted.settle(payload({}, intent), accept(), RESOURCE)
    expect(second.success).toBe(false)
    expect(second).toEqual({ success: false, errorReason: "intent_already_settled" })
  })
})

/**
 * §6 — source hygiene. Not a behavioural claim about settlement.
 *
 * `cacheKey()` originally separated its three components with RAW NUL bytes.
 * Git classifies any file containing a NUL as binary, so for this module's
 * entire history (one commit, #334) `git diff` printed "Binary files differ"
 * with no patch, GitHub rendered "Binary file not shown", and plain `grep`
 * skipped it — the one money-adjacent file in the x402 surface was the one file
 * no reviewer could read a diff of.
 *
 * The separator is now the four-character ESCAPE `\x1f`. These tests are the
 * ratchet: they fail if anyone reintroduces a raw control byte, whether NUL or
 * the 0x1F the escape denotes. The general C0 assertion is the load-bearing one
 * — a NUL-only check passes a raw-0x1F regression, which is the same defect
 * wearing a different number.
 *
 * Every control character below is written as an ESCAPE. A literal NUL in this
 * file would make the TEST binary and reproduce the bug inside the guard
 * against it.
 */
describe("x402 facilitator source hygiene", () => {
  const SRC = readFileSync(join(process.cwd(), "src/lib/x402/facilitator.ts"), "utf8")

  it("holds no raw NUL byte", () => {
    expect(SRC.indexOf("\u0000")).toBe(-1)
  })

  it("holds no raw C0 control byte at all — only tab, newline and carriage return", () => {
    const offenders: string[] = []
    for (let i = 0; i < SRC.length; i++) {
      const code = SRC.charCodeAt(i)
      const isControl = code < 0x20 || code === 0x7f
      const isAllowed = code === 0x09 || code === 0x0a || code === 0x0d
      if (isControl && !isAllowed) {
        offenders.push(`0x${code.toString(16).padStart(2, "0")} at offset ${i}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("builds NO composite settlement key — the separator problem is gone, not hidden", () => {
    // REPOINTED 2026-09-02, not deleted. This assertion used to pin the \x1f
    // separator inside cacheKey(). The intent-only ruling removed cacheKey
    // entirely: identity is the derived intent hash, one value, so there is
    // nothing to separate and no separator to get wrong. That is a real, if
    // secondary, argument for the ruling — a whole class of collision bug (can a
    // client smuggle the separator into the last component and shift the
    // boundary?) stops existing rather than being defended against.
    //
    // A deleted test would have quietly surrendered the ratchet. This one keeps
    // it by guarding the NEW invariant: if a composite key ever comes back, it
    // fails here and whoever brings it back has to re-argue the separator.
    expect(SRC).not.toContain("function cacheKey")
    expect(SRC).not.toMatch(/\$\{intentHash\}.*\$\{requirements\}/)

    // And the identity actually passed to the store is the bare derived hash.
    expect(SRC).toMatch(/isSettled\(derived\)/)
    expect(SRC).toMatch(/intentHash: intent,/)
  })
})
