import "server-only"
import type { PaymentPayload, SettlementResponse, VerifyResult, PaymentAccept } from "./types"
import { submitNotarizedTransaction, fetchTxFungibleChanges } from "@/lib/gateway"
import { screenPayment } from "./decode"
import {
  reserveSettlement,
  markSettled,
  releaseSettlement,
  isSettled,
  claimReplay,
  isReplayable,
} from "@/db/queries/x402"

// x402 facilitator — verify + settle a Radix `exact` payment (NON-SPONSORED).
//
// ⚠️ REVIEW + TEST ON DESKTOP BEFORE ENABLING. This submits REAL transactions
// and asserts REAL deposits. It is gated off by X402_ENABLED, but once on it
// moves money-adjacent state. Do NOT trust it until a payment has settled
// end-to-end against Stokenet/a test component and the assertions below have
// been proven in both directions (valid pays through, short/wrong-asset/wrong-
// payTo rejects). This repo's signature defect is calling a partial result whole.
//
// Scope: NON-SPONSORED only (client submits a full NotarizedTransactionV2 and
// pays its own gas). Sponsored mode (subintent + VERIFY_PARENT, facilitator
// pays gas) is Track 2 and needs /transaction/preview — absent from this repo.
//
// STILL TODO before this is trustworthy:
//   1. ✅ DONE — structural pre-screen, in ./decode.ts (`screenPayment`), run by
//      BOTH verify() and settle(). It decompiles the submitted bytes, runs the
//      toolkit's own `staticallyValidate` (header, epoch range, payload size,
//      tip bounds AND signatures), pins the header network, and requires the
//      manifest to contain a deposit-shaped call to `accept.payTo`.
//      🔴 The concrete hole it closed: `decompile` does NOT verify signatures —
//      measured, not assumed. A transaction with one byte flipped still
//      decompiles, and the old path (decompile-to-derive-hash, then submit) sent
//      it to the network. Now it is refused before the gateway.
//      ⚠️ NECESSARY, NOT SUFFICIENT: a manifest that contains a deposit may
//      still deposit nothing. settle()'s committed-receipt check remains the
//      only authority on VALUE, and the screen never claims otherwise.
//      Note the original wording asked for an exact "4-instruction shape" — not
//      implemented, deliberately. Wallets legitimately vary the manifest (extra
//      asserts, lock_fee_and_withdraw), so a shape whitelist would reject honest
//      payments to catch submissions the receipt check already rejects for free.
//   2. ✅ DONE — durable replay cache, keyed on the intent hash exactly as this
//      line originally asked. Was an in-memory Set that reset per process/deploy
//      and was never shared across instances; now the `x402_settlements` table
//      with the INSERT itself as the gate. It passed briefly through a
//      (intent, requirements, resource) triple, carried over from the in-memory
//      version — see the settlement-identity note below for why that was a hole
//      and why intent-only is the ruled shape.
//   3. Confirm the `amount` UNIT. This assumes accept.amount is ATOMIC subunits
//      (XRD 18dp), matching the doc's "100 XRD = 100000000000000000000". If the
//      live AVaunt scheme sends a human decimal instead, fix toAtomic()'s caller
//      only — the comparison is centralised here on purpose.

export interface Facilitator {
  verify(payload: PaymentPayload, accept: PaymentAccept, resourceUrl: string): Promise<VerifyResult>
  settle(payload: PaymentPayload, accept: PaymentAccept, resourceUrl: string): Promise<SettlementResponse>
}

// ── unit + replay helpers ────────────────────────────────────────────────────

// NOTE: written as BigInt(18), not the `18n` literal — this repo's tsconfig
// targets ES2017 and BigInt literals require ES2020 (TS2737). Semantically
// identical; changing the repo-wide target for one file is not worth it.
const DECIMALS = BigInt(18)
const TEN = BigInt(10)

/** Human decimal string ("0.05", "-100") → atomic BigInt (18dp). null if malformed. */
function toAtomic(decimal: string): bigint | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimal.trim())
  if (!m) return null
  const [, sign, whole, frac = ""] = m
  if (frac.length > Number(DECIMALS)) return null // more precision than XRD carries
  const scaled = BigInt(whole) * TEN ** DECIMALS + BigInt((frac + "0".repeat(Number(DECIMALS))).slice(0, Number(DECIMALS)))
  return sign === "-" ? -scaled : scaled
}

// ── intent-hash derivation (the fix for the unbound-hash defect) ─────────────
//
// `payload.payload.transactionId` is CLIENT-SUPPLIED and is not bound to
// `compiledHex` in any way — they are two independent fields. Trusting it meant
// any committed transaction that ever deposited >= the price at payTo could be
// presented as proof of THIS payment. We now derive the hash from the submitted
// bytes and ignore the claimed one.
//
// API verified against node_modules/@radixdlt/radix-engine-toolkit@1.0.6
// (dist/wasm/default.d.ts:127-136), not from memory. NotarizedTransaction
// exposes FOUR hash functions — hash, notarizedTransactionHash, signedIntentHash
// and intentHash — and they are NOT interchangeable. The Gateway's
// /transaction/committed-details takes an INTENT hash, so intentHash() is the
// only correct one here. `TransactionHash.id` is the bech32m `txid_rdx1…` form
// (dist/models/transaction/hash.d.ts).
// Intent-hash derivation now lives in ./decode.ts alongside the structural
// screen: both need the same decompile, and doing it twice would be two chances
// to disagree about what the bytes are. screenPayment() returns the derived id.

// ── settlement identity ─────────────────────────────────────────────────────
//
// ONE PAYMENT, ONE SETTLEMENT. The identity is the DERIVED INTENT HASH alone.
// RULED 2026-09-02 (operator).
//
// 🔴 IT WAS THE (intent, requirements, resourceUrl) TRIPLE, AND THAT WAS A HOLE.
// The triple is the LOOSER key: the same committed payment presented against a
// different `resourceUrl` produced a different key, passed the replay check and
// settled again — settle() re-submits the already-committed transaction, reads
// the same receipt, sees the same deposit, returns success. And `resourceUrl` is
// `req.nextUrl.toString()` (require-payment.ts), which INCLUDES THE QUERY
// STRING, so the distinguishing axis was attacker-chosen: `?x=1`, `?x=2`, … each
// bought the service again on one payment.
//
// The comment that justified the triple had its argument inverted — it claimed
// keying on the intent alone "would let one payment unlock a DIFFERENT paid
// route", when intent-only is precisely the rule that prevents that. Left on the
// record because the code looked right and the reasoning read right; only
// working the case through by hand exposed it.
//
// WHY INTENT-ONLY IS ALSO THE RIGHT LONG-TERM SHAPE, not just the safe one: the
// payment is a cryptographically unique identifier bound to the exact bytes that
// moved money, derived by us rather than supplied by the caller. That is what an
// idempotency key IS. And the invariant is monotonic — narrowing later would be
// a breaking change, while relaxing later is easy, so the strict rule is the one
// that can still be reconsidered.
//
// NOT AN ENV TOGGLE, deliberately. A knob that loosens an anti-replay guard is
// off in exactly the environment nobody checked.
//
// The other two fields survive as BOUND CONTEXT, not identity: a repeat carrying
// this payment against a DIFFERENT resource is not a duplicate request, it is an
// attempt to spend one payment on something else, and it is refused under its
// own reason (`payment_bound_to_other_resource`) so it is greppable in logs.

function requirementsOf(accept: PaymentAccept): string {
  return [accept.network, accept.asset, accept.amount, accept.payTo].join("|")
}

// The reservation is still taken BEFORE submit for the reason it always was:
// without it the guard is check-then-act across two awaits, so N concurrent
// requests carrying one intent all pass the check, all submit, all see the same
// receipt and all return success — one payment, N service calls. What changed is
// that the check is now an atomic INSERT in Postgres, so it holds ACROSS
// processes and instances rather than within one.
//
// Margin on top of maxTimeoutSeconds before a dead reservation may be reclaimed.
// Must exceed the longest a legitimate settle can run (the poll loop is bounded
// by maxTimeoutSeconds), or a slow-but-live settle could have its reservation
// stolen and the payment settled twice.
const RESERVATION_STALE_MARGIN_SECS = 60

// A LOST RESPONSE MUST NOT BURN THE PAYMENT. Ruled 2026-09-02 (operator).
//
// `already_settled` used to be a flat refusal, so a response dropped in transit
// left the payer having paid for nothing — and the payer cannot tell that case
// apart from a rejected payment. A settled row now replays its recorded
// response, under TWO independent bounds:
//
//   • the CLOCK — `accept.maxTimeoutSeconds` from `settled_at`. Deliberately the
//     protocol's own number rather than a new constant: it is the payer's
//     declared patience for settlement, and a retry after a lost response
//     arrives well inside it. Anything longer converts a one-off payment into a
//     licence, because the handler re-runs on a replay and serves FRESH data —
//     there is no cached body being handed back.
//   • the COUNT — REPLAY_MAX. A window alone is a rate-limit hole: free rein for
//     120 seconds against an expensive endpoint is real value for one payment.
//     Three covers a client retry budget and stops well short of a subscription.
//
// Both are enforced inside a single UPDATE (see claimReplay), so the increment
// IS the permission and concurrent replays cannot all read the same remaining
// count.
const REPLAY_MAX = 3

// ── the facilitator ──────────────────────────────────────────────────────────

export const facilitator: Facilitator = {
  async verify(payload, accept, resourceUrl): Promise<VerifyResult> {
    // 1. The client must be paying for THIS scheme/network/asset/payTo. These
    //    fields are the client's own CLAIM echoed back — matching them proves
    //    self-consistency, not payment. The real control is settle()'s
    //    committed-receipt assertion against a hash we derive ourselves.
    const a = payload.accepted
    if (a?.scheme !== "exact") return { isValid: false, invalidReason: "unsupported_scheme" }
    if (a.network !== accept.network) return { isValid: false, invalidReason: "wrong_network" }
    if (a.asset !== accept.asset) return { isValid: false, invalidReason: "wrong_asset" }
    if (a.payTo !== accept.payTo) return { isValid: false, invalidReason: "wrong_payto" }
    if (!payload.payload?.compiledHex) return { isValid: false, invalidReason: "invalid_payload" }

    // 2. Structurally screen the SUBMITTED BYTES and derive the intent hash from
    //    them. Rejects anything that cannot succeed — bad signature, wrong
    //    network, no deposit to us — before the gateway is ever touched.
    const screened = await screenPayment(payload.payload.compiledHex, accept)
    if (!screened.ok) return { isValid: false, invalidReason: screened.reason }
    const derived = screened.intentHash

    // 3. If the client also claimed a hash, it must be the one its own bytes
    //    produce. A mismatch is an attempt to have us assert someone else's
    //    committed payment, so it is refused rather than quietly ignored.
    const claimed = payload.payload.transactionId
    if (claimed && claimed !== derived) {
      return { isValid: false, invalidReason: "intent_hash_mismatch" }
    }

    // 4. Replay: a key that already settled cannot be reused. A DB failure here
    //    is NOT "not settled" — it is unknown, and unknown must refuse. Reading
    //    a throw as a pass would turn a database outage into an open door.
    try {
      if (await isSettled(derived)) {
        // Settled is no longer an automatic refusal — it may be a payer who
        // never received their response. verify() reports valid and lets
        // settle() make the call, because settle() is where the replay is
        // CLAIMED atomically; deciding it here would be a check whose act
        // happens in another function, which is the race this file keeps
        // closing. verify() is advisory, settle() is authoritative.
        const replayable = await isReplayable({
          intentHash: derived,
          requirements: requirementsOf(accept),
          resourceUrl,
          windowSeconds: accept.maxTimeoutSeconds,
          maxReplays: REPLAY_MAX,
        })
        if (!replayable) return { isValid: false, invalidReason: "intent_already_settled" }
      }
    } catch {
      return { isValid: false, invalidReason: "replay_check_unavailable" }
    }
    return { isValid: true }
  },

  async settle(payload, accept, resourceUrl): Promise<SettlementResponse> {
    const network = accept.network

    // Screen and derive again. settle() is reachable independently of verify(),
    // so it repeats the check rather than trusting that one happened — a gate
    // that only runs on the polite path is not a gate.
    const screened = await screenPayment(payload.payload.compiledHex, accept)
    if (!screened.ok) return { success: false, errorReason: screened.reason }
    const intent = screened.intentHash

    // LOST-RESPONSE REPLAY, before anything else. If this payment already
    // settled for this exact resource and is inside both bounds, hand back the
    // recorded response. Critically this does NOT re-submit: the transaction is
    // already committed, and re-submitting would spend a gateway round trip to
    // rediscover what the row already records.
    try {
      const replay = await claimReplay({
        intentHash: intent,
        requirements: requirementsOf(accept),
        resourceUrl,
        windowSeconds: accept.maxTimeoutSeconds,
        maxReplays: REPLAY_MAX,
      })
      if (replay) {
        return { success: true, transaction: intent, network, payer: replay.payer ?? undefined }
      }
    } catch {
      return { success: false, errorReason: "settlement_store_unavailable" }
    }

    // Reserve BEFORE the submit. The INSERT is the gate: exactly one caller,
    // across every process, wins the row. Everyone else is told which kind of
    // loss it was.
    let reservation
    try {
      reservation = await reserveSettlement({
        intentHash: intent,
        requirements: requirementsOf(accept),
        resourceUrl,
        staleAfterSeconds: accept.maxTimeoutSeconds + RESERVATION_STALE_MARGIN_SECS,
      })
    } catch {
      // Fail closed. There is no in-memory fallback on purpose: falling back to
      // a Set during a DB outage would silently restore the cross-instance
      // replay hole at the worst possible moment.
      return { success: false, errorReason: "settlement_store_unavailable" }
    }
    if (reservation.outcome === "already_settled") {
      return { success: false, errorReason: "intent_already_settled" }
    }
    if (reservation.outcome === "bound_elsewhere") {
      // This payment already bought something else. Distinct from an ordinary
      // replay on purpose: an ordinary replay is a client retrying, this is one
      // payment being pointed at a second resource, which is the attack the
      // intent-only key exists to stop. Given its own reason so it is greppable.
      return { success: false, errorReason: "payment_bound_to_other_resource" }
    }
    if (reservation.outcome === "in_progress") {
      return { success: false, errorReason: "settlement_in_progress" }
    }

    let result: SettlementResponse
    try {
      result = await runSettlement(payload, accept, intent, network)
    } catch (err) {
      // A throw must release, or a transient gateway fault bricks the payment
      // until the staleness window expires.
      await releaseSettlement(intent).catch(() => {})
      throw err
    }
    // Release on failure so a failed settlement does not burn the payment —
    // the same rule the in-memory version held, now durable.
    if (!result.success) await releaseSettlement(intent).catch(() => {})
    return result
  },
}

async function runSettlement(
  payload: PaymentPayload,
  accept: PaymentAccept,
  intent: string,
  network: string,
): Promise<SettlementResponse> {
  {

    // accept.amount is ATOMIC subunits per TODO(3) — interpret directly as
    // BigInt. If the live scheme sends a human decimal instead, this is the one
    // line to change (use toAtomic(accept.amount)). toAtomic() below still
    // handles the Gateway's human-decimal balance_change values.
    let requiredAtomic: bigint
    try {
      requiredAtomic = BigInt(accept.amount)
    } catch {
      return { success: false, errorReason: "invalid_payment_requirements" }
    }

    // Submit the client's notarized TX (client pays gas — no facilitator liability).
    const submitted = await submitNotarizedTransaction(payload.payload.compiledHex)
    if (!submitted) return { success: false, errorReason: "submit_rejected" }

    // Poll the committed receipt (bounded — maxTimeoutSeconds). A committed TX
    // that deposited ≥ requiredAtomic of accept.asset to accept.payTo settles.
    const deadline = accept.maxTimeoutSeconds * 1000
    const start = Date.now()
    while (Date.now() - start < deadline) {
      const receipt = await fetchTxFungibleChanges(intent)
      if (receipt) {
        if (receipt.status === "CommittedSuccess") {
          const deposit = receipt.changes.find(
            (c) => c.entity === accept.payTo && c.resource === accept.asset,
          )
          const depositedAtomic = deposit ? toAtomic(deposit.change) : null
          if (depositedAtomic !== null && depositedAtomic >= requiredAtomic) {
            // Durable, and only ever on a committed success. If this write
            // throws the settlement is NOT reported as successful: an
            // unrecorded success is a replayable payment, so the payer is
            // refused and can retry rather than being handed a free replay.
            // payer = the account whose asset balance went most negative.
            // Derived BEFORE the record write so it can be persisted: a replay
            // has to reproduce this exact response, and a replay that dropped
            // the payer would be a different answer to the same question.
            const payer = receipt.changes
              .filter((c) => c.resource === accept.asset && c.change.startsWith("-"))
              .sort((x, y) => (toAtomic(x.change)! < toAtomic(y.change)! ? -1 : 1))[0]?.entity
            try {
              await markSettled(intent, payer)
            } catch {
              return { success: false, errorReason: "settlement_record_failed" }
            }
            return { success: true, transaction: intent, network, payer }
          }
          return { success: false, errorReason: "insufficient_or_misdirected_payment" }
        }
        if (receipt.status === "CommittedFailure" || receipt.status === "Rejected") {
          return { success: false, errorReason: "transaction_failed" }
        }
      }
      await new Promise((r) => setTimeout(r, 2000)) // still pending — back off
    }
    return { success: false, errorReason: "settle_timeout" }
  }
}
