import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { submitNotarizedTransaction, fetchTxFungibleChanges } from "@/lib/gateway"
import { GATEWAY } from "@/lib/constants"

/**
 * The two Gateway functions the x402 facilitator depends on.
 *
 * WHY THIS FILE EXISTS: the facilitator suite mocks `@/lib/gateway` wholesale, so
 * it replaces the only code that ever touches a real Gateway response. Its
 * `receipt()` helper emits the POST-mapping shape, which means it agrees with the
 * TypeScript interface and proves nothing about the mapping that produces it. A
 * key-name drift in `fetchTxFungibleChanges` would leave every settle test green.
 * tests/unit/lib-gateway.test.ts covers the other 15 readers in that file in this
 * style; these two were added later and were missed.
 *
 * ── ON THE FIXTURE, AND WHY IT IS SYNTHETIC ─────────────────────────────────
 * The SHAPE below was verified against live mainnet on 2026-08-06 — both
 * `/stream/transactions` and `/transaction/committed-details` with
 * `opt_ins:{balance_changes:true}`. The VALUES are synthetic on purpose.
 *
 * A real intent hash is not inert: PR #330 ("the npm tarball was leaking mainnet
 * txids") resolved one to show it exposes an account, the escrow component, a
 * badge id, a fee and a timestamp, and added a publish-scanner rule for exactly
 * this class of file. Committing a captured mainnet payload as a test fixture
 * would reintroduce what that commit cleaned. So: real shape, invented accounts
 * and hashes, and no `confirmed_at` / `state_version` / `epoch` to correlate on.
 *
 * What WAS measured on the live API and is reproduced faithfully here:
 *   - the response nests under `transaction` (top level is {ledger_state, transaction})
 *   - `transaction_status` is the literal "CommittedSuccess"
 *   - entries carry `entity_address`, `resource_address`, `balance_change`
 *   - `balance_change` is a HUMAN DECIMAL STRING, signed, up to 18 dp
 *     (observed: "-506.45789936", "0.479704415746018467")
 *   - `fungible_fee_balance_changes` is a SEPARATE sibling array, present on
 *     every transaction observed, carrying `type: "FeePayment"` entries
 */

const XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"
const PAY_TO = "account_rdx12000000000000000000000000000000000000000000000000paytest"
const PAYER = "account_rdx12000000000000000000000000000000000000000000000000payer1"
const INTENT = "txid_rdx1_synthetic_fixture_not_a_real_mainnet_transaction"

/** Real Gateway shape, synthetic values. */
const committedDetails = (over: { status?: string } = {}) => ({
  ledger_state: { network: "mainnet" },
  transaction: {
    intent_hash: INTENT,
    transaction_status: over.status ?? "CommittedSuccess",
    fee_paid: "0.91043524283",
    balance_changes: {
      fungible_balance_changes: [
        { entity_address: PAYER, resource_address: XRD, balance_change: "-0.479704415746018467" },
        { entity_address: PAY_TO, resource_address: XRD, balance_change: "0.479704415746018467" },
      ],
      // Sibling array the parser deliberately does not read — see the last test.
      fungible_fee_balance_changes: [
        { type: "FeePayment", entity_address: PAYER, resource_address: XRD, balance_change: "-0.91043524283" },
      ],
      non_fungible_balance_changes: [],
    },
  },
})

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  fetchSpy = vi.spyOn(global, "fetch")
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("submitNotarizedTransaction", () => {
  it("posts the notarized hex to /transaction/submit", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) } as Response)

    await submitNotarizedTransaction("4d21030221")

    expect(fetchSpy).toHaveBeenCalledWith(`${GATEWAY}/transaction/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notarized_transaction_hex: "4d21030221" }),
      signal: expect.any(AbortSignal),
    })
  })

  it("returns true on 2xx", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true } as Response)
    expect(await submitNotarizedTransaction("4d21")).toBe(true)
  })

  it("returns false on a rejected submission", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 400 } as Response)
    expect(await submitNotarizedTransaction("4d21")).toBe(false)
  })

  it("returns false rather than throwing on a transport failure", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNRESET"))
    expect(await submitNotarizedTransaction("4d21")).toBe(false)
  })

  it("cannot distinguish an accepted submission from a DUPLICATE — both are 2xx", async () => {
    // Pinning a real limitation rather than a behaviour. The Gateway answers 2xx
    // for a re-submitted transaction, so `submit_rejected` is a weak signal and
    // the facilitator's safety cannot rest on it. It rests on the committed
    // receipt and on the derived intent hash instead.
    fetchSpy.mockResolvedValueOnce({ ok: true } as Response)
    expect(await submitNotarizedTransaction("a-previously-submitted-tx")).toBe(true)
  })
})

describe("fetchTxFungibleChanges", () => {
  it("requests committed-details with the balance_changes opt-in", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(committedDetails()) } as Response)

    await fetchTxFungibleChanges(INTENT)

    expect(fetchSpy).toHaveBeenCalledWith(`${GATEWAY}/transaction/committed-details`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent_hash: INTENT, opt_ins: { balance_changes: true } }),
      signal: expect.any(AbortSignal),
    })
  })

  it("maps the real Gateway entry shape onto {entity, resource, change}", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(committedDetails()) } as Response)

    const result = await fetchTxFungibleChanges(INTENT)

    // This is the assertion the facilitator suite structurally cannot make.
    expect(result).toEqual({
      status: "CommittedSuccess",
      changes: [
        { entity: PAYER, resource: XRD, change: "-0.479704415746018467" },
        { entity: PAY_TO, resource: XRD, change: "0.479704415746018467" },
      ],
    })
  })

  it("preserves an 18-decimal signed string exactly, without going through Number", async () => {
    // 0.479704415746018467 is not representable as a double. If the mapping ever
    // parses instead of passing the string through, this loses precision and the
    // facilitator's atomic comparison silently shifts.
    fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(committedDetails()) } as Response)

    const result = await fetchTxFungibleChanges(INTENT)

    expect(result!.changes[1].change).toBe("0.479704415746018467")
    expect(result!.changes[1].change).not.toBe(String(Number("0.479704415746018467")))
  })

  it("reports a non-success commit status verbatim", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(committedDetails({ status: "CommittedFailure" })),
    } as Response)

    expect((await fetchTxFungibleChanges(INTENT))!.status).toBe("CommittedFailure")
  })

  it("returns null on a non-2xx — which the facilitator reads as still-pending", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 404 } as Response)
    expect(await fetchTxFungibleChanges(INTENT)).toBeNull()
  })

  it("returns null rather than throwing on a transport failure", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNRESET"))
    expect(await fetchTxFungibleChanges(INTENT)).toBeNull()
  })

  it("degrades to status Unknown with no changes if the payload shape drifts", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ transaction: {} }) } as Response)

    expect(await fetchTxFungibleChanges(INTENT)).toEqual({ status: "Unknown", changes: [] })
  })

  it("does NOT read fungible_fee_balance_changes — a known, deliberate gap", async () => {
    // Measured on mainnet 2026-08-06: every transaction observed carried entries
    // in this sibling array, so a payer's XRD outflow is split across two arrays
    // and the parser sees only one of them.
    //
    // Safe for the DEPOSIT assertion, which is what decides settlement: a payment
    // to payTo is a manifest instruction and lands in fungible_balance_changes.
    // It does mean the reported `payer` reflects only the non-fee portion. Fine
    // while payer is informational; NOT fine the day anything authorizes on it.
    fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(committedDetails()) } as Response)

    const result = await fetchTxFungibleChanges(INTENT)

    expect(result!.changes).toHaveLength(2)
    expect(result!.changes.some((c) => c.change === "-0.91043524283")).toBe(false)
  })
})
