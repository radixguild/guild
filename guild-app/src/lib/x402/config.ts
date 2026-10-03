import "server-only"
import type { PaymentAccept } from "./types"
import { XRD_ADDRESS } from "../radix"

// x402 config — env-driven. STARTER SCAFFOLDING (Track 1).
//
// The whole x402 surface is OFF unless X402_ENABLED=true, so merging this can't
// change the live build's behaviour (mirrors the launch-check philosophy: a new
// capability ships compiled-off). Turn it on only once ./facilitator.ts is real.

// XRD resource on Radix mainnet (network_id 1). No stokenet — project rule.
// Sourced from the one canonical definition (src/lib/radix.ts) rather than a
// local literal, so the reward-resource flip (XRD → USD stablecoin) only ever
// needs to change one file's value.
const XRD_RESOURCE = XRD_ADDRESS

export const X402_ENABLED = process.env.X402_ENABLED === "true"

export interface X402Config {
  network: string
  asset: string
  payTo: string
  maxTimeoutSeconds: number
}

/**
 * Returns the x402 config, or null when disabled / unconfigured. `X402_PAY_TO`
 * is REQUIRED (no default) — do not bake a payout account into source. Confirm
 * the correct receiver (ops vs escrow-owner) before enabling; see the doc §8 Q4.
 */
export function getX402Config(): X402Config | null {
  if (!X402_ENABLED) return null
  const payTo = process.env.X402_PAY_TO
  if (!payTo) {
    console.error("[x402] X402_ENABLED but X402_PAY_TO is not set — refusing to advertise payment")
    return null
  }
  return {
    network: "radix:1",
    asset: process.env.X402_ASSET || XRD_RESOURCE,
    payTo,
    maxTimeoutSeconds: 120,
  }
}

/** Build a PaymentAccept for a given price (atomic units of the asset). */
export function acceptFor(cfg: X402Config, amountAtomic: string): PaymentAccept {
  return {
    scheme: "exact",
    network: cfg.network,
    amount: amountAtomic,
    asset: cfg.asset,
    payTo: cfg.payTo,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds,
    extra: { name: "XRD" },
  }
}


// NO PRICED RESOURCE EXISTS. A `FUNDED_TASKS_PRICE_ATOMIC` constant stood here
// and priced the funded-tasks discovery call at 0.05 XRD. The route it priced was
// deleted by the 2026-09-02 ruling — see .well-known/x402.json/route.ts for the
// argument. `acceptFor` above is kept: it is the RAIL, not the product, and the
// next priced surface will need it.
//
// The constant is deliberately NOT left behind "just in case". A live price for a
// route that does not exist is precisely how an unbacked claim gets re-advertised
// by the next person who greps for a price and finds one.
