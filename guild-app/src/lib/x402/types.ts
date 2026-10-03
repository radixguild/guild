import "server-only"

// x402 protocol types (v2) — the wire shapes for HTTP 402 agent payments.
// Reference: docs/research/x402-radix-integration.md §1–2. Radix `exact` scheme.
//
// STARTER SCAFFOLDING (2026-08-04, Track 1). Types + a PaymentRequirements
// builder are complete; the actual verify/settle live in ./facilitator.ts and
// are deliberately inert until wired against the Radix Gateway + toolkit and
// tested on the desktop. Nothing here moves money.

export const X402_VERSION = 2 as const

/** One acceptable way to pay for a resource (the Radix `exact` scheme). */
export interface PaymentAccept {
  scheme: "exact"
  network: string // "radix:1" (mainnet) — CAIP-2-style, see §8 open Q1
  amount: string // atomic units of `asset` (XRD = 18 decimals) as a decimal string
  asset: string // resource address (XRD resource on mainnet)
  payTo: string // account address the payment settles to
  maxTimeoutSeconds: number
  extra?: Record<string, unknown>
}

/** The 402 body: what the server tells the client to pay. */
export interface PaymentRequired {
  x402Version: typeof X402_VERSION
  error: string
  resource: { url: string; description?: string; mimeType?: string }
  accepts: PaymentAccept[]
}

/** The client's proof-of-payment, base64-encoded in the `X-PAYMENT` header. */
export interface PaymentPayload {
  x402Version: typeof X402_VERSION
  resource: { url: string }
  accepted: Omit<PaymentAccept, "extra">
  payload: {
    transactionId: string // radix intent hash
    compiledHex: string // compiled (sub)transaction hex
    network: string
  }
}

/** Facilitator settlement result, base64-encoded in `X-PAYMENT-RESPONSE`. */
export interface SettlementResponse {
  success: boolean
  transaction?: string // radix intent hash on success
  network?: string
  payer?: string // client account that paid
  errorReason?: string
}

export interface VerifyResult {
  isValid: boolean
  invalidReason?: string
}

/** Build the 402 body for a resource that requires payment. */
export function paymentRequired(url: string, accept: PaymentAccept, description?: string): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    error: "Payment required",
    resource: { url, description, mimeType: "application/json" },
    accepts: [accept],
  }
}

/** Decode the base64 `X-PAYMENT` header into a PaymentPayload, or null if malformed. */
export function decodePaymentPayload(header: string): PaymentPayload | null {
  try {
    const json = Buffer.from(header, "base64").toString("utf8")
    const obj = JSON.parse(json) as PaymentPayload
    if (obj?.x402Version !== X402_VERSION || !obj?.payload?.compiledHex) return null
    return obj
  } catch {
    return null
  }
}

/** Encode a SettlementResponse for the `X-PAYMENT-RESPONSE` header. */
export function encodeSettlement(s: SettlementResponse): string {
  return Buffer.from(JSON.stringify(s), "utf8").toString("base64")
}
