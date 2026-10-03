import "server-only"
import type { PaymentAccept } from "./types"

/**
 * Structural pre-screen for an x402 `exact` payment — TODO(1), closed 2026-09-02.
 *
 * WHAT THIS IS FOR, precisely. settle() is the authority on VALUE: it reads the
 * committed receipt and requires a deposit >= the price at payTo, so a short,
 * misdirected or fabricated payment fails there regardless of anything here.
 * This screen exists to reject submissions that CANNOT succeed before we spend a
 * gateway submit and then poll for up to maxTimeoutSeconds waiting for a receipt
 * we already know will not satisfy us.
 *
 * 🔴 THE ONE THING IT CATCHES THAT NOTHING ELSE DID: a transaction whose NOTARY
 * SIGNATURE IS INVALID. `decompile` does not verify signatures — measured, not
 * assumed: flipping the last byte of a real notarized transaction still
 * decompiles cleanly and only `staticallyValidate` reports
 * `SignatureValidationError(InvalidNotarySignature)`. Until now the facilitator
 * decompiled (to derive the intent hash) and submitted. So malformed-but-decodable
 * payloads reached the network.
 *
 * NECESSARY, NOT SUFFICIENT — and the distinction is load-bearing. A manifest
 * that CONTAINS a deposit to payTo may still deposit nothing (the withdraw can
 * fail), deposit less than the price, or be undone later in the manifest. Static
 * inspection cannot settle value questions, so this returns "worth submitting",
 * never "paid". Anything that treats a pass here as payment has reintroduced the
 * defect the receipt check exists to prevent.
 */

type Screened =
  | { ok: true; intentHash: string }
  | {
      ok: false
      reason:
        | "invalid_payload"
        | "failed_static_validation"
        | "wrong_network"
        | "no_payment_to_payto"
      detail?: string
    }

/** Account deposit entry points a wallet may legitimately use to pay. */
const DEPOSIT_METHODS = new Set([
  "deposit",
  "deposit_batch",
  "try_deposit_or_abort",
  "try_deposit_batch_or_abort",
])

/**
 * `accept.network` is a CAIP-style "radix:<networkId>" string. Parsed rather
 * than assumed to be mainnet, so a config change cannot silently point the
 * validator at a different chain than the payment claims.
 */
function networkIdOf(network: string): number | null {
  const m = /^radix:(\d+)$/.exec(network.trim())
  if (!m) return null
  const id = Number(m[1])
  return Number.isSafeInteger(id) && id >= 0 && id <= 255 ? id : null
}

export async function screenPayment(
  compiledHex: string,
  accept: PaymentAccept,
): Promise<Screened> {
  const networkId = networkIdOf(accept.network)
  if (networkId === null) {
    return { ok: false, reason: "wrong_network", detail: "unparseable accept.network" }
  }

  const hex = compiledHex.trim().replace(/^0x/i, "")
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length === 0 || hex.length % 2 !== 0) {
    return { ok: false, reason: "invalid_payload", detail: "not hex" }
  }

  const { RadixEngineToolkit, defaultValidationConfig } = await import(
    "@radixdlt/radix-engine-toolkit"
  )

  let notarized
  try {
    notarized = await RadixEngineToolkit.NotarizedTransaction.decompile(
      Uint8Array.from(Buffer.from(hex, "hex")),
      "Parsed",
    )
  } catch {
    return { ok: false, reason: "invalid_payload", detail: "undecodable" }
  }

  // The toolkit's own validator: header sanity, epoch range, payload size, tip
  // bounds, AND signature verification. Deliberately preferred over hand-rolled
  // equivalents — it is maintained alongside the ledger rules it encodes, and a
  // hand-rolled version would drift from them silently.
  try {
    const validation = await RadixEngineToolkit.NotarizedTransaction.staticallyValidate(
      notarized,
      defaultValidationConfig(networkId),
    )
    if (validation.kind !== "Valid") {
      return { ok: false, reason: "failed_static_validation", detail: validation.error }
    }
  } catch {
    return { ok: false, reason: "failed_static_validation", detail: "validator threw" }
  }

  const intent = notarized.signedIntent?.intent
  if (!intent) return { ok: false, reason: "invalid_payload", detail: "no intent" }

  // NO SEPARATE HEADER-NETWORK CHECK HERE, and that is a deliberate deletion.
  // One stood here reading `intent.header.networkId !== networkId`. Mutation
  // testing showed it could not fail: `staticallyValidate` rejects a foreign
  // network first, with `HeaderValidationError(InvalidNetwork)`, so disabling
  // the explicit comparison changed no test. A guard that cannot fail is the
  // failure mode this repo keeps paying for, so it is gone rather than kept as
  // decoration. `staticallyValidate` owns the network check; the test named
  // "rejects a transaction built for a DIFFERENT network" asserts the reason it
  // actually produces.

  const instructions = intent.manifest?.instructions
  if (instructions?.kind !== "Parsed" || !Array.isArray(instructions.value)) {
    return { ok: false, reason: "invalid_payload", detail: "instructions not parsed" }
  }

  const paysUs = instructions.value.some((i: unknown) => {
    const ins = i as { kind?: string; methodName?: string; address?: { value?: string } }
    return (
      ins.kind === "CallMethod" &&
      typeof ins.methodName === "string" &&
      DEPOSIT_METHODS.has(ins.methodName) &&
      ins.address?.value === accept.payTo
    )
  })
  if (!paysUs) return { ok: false, reason: "no_payment_to_payto" }

  const { id } = await RadixEngineToolkit.NotarizedTransaction.intentHash(notarized)
  return { ok: true, intentHash: id }
}
