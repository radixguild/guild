import "server-only"
import { NextRequest, NextResponse } from "next/server"
import { fromError } from "@/lib/api-response"
import { getX402Config, acceptFor } from "./config"
import { facilitator } from "./facilitator"
import { decodePaymentPayload, encodeSettlement, paymentRequired } from "./types"

// x402 payment middleware — the Track 1 seam. Sits ALONGSIDE withAuth
// (src/lib/auth.ts): for x402 routes, payment replaces the JWT session
// ("payment IS auth"). See docs/research/x402-radix-integration.md §4.2.
//
// Shape mirrors withAuth so it composes as a route handler. When x402 is
// disabled (X402_ENABLED unset) the wrapped route 404s — the capability is
// compiled-off, not merely unadvertised.

type PaidHandler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>>; payment: { payer?: string; transaction?: string } },
) => Promise<NextResponse>

type RouteHandler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<NextResponse>

const NOT_FOUND = () =>
  NextResponse.json({ ok: false, error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 })

/**
 * Gate a route behind an x402 payment of `amountAtomic` (atomic units of the
 * configured asset). Returns 402 with PaymentRequirements when X-PAYMENT is
 * absent/invalid/unsettled; otherwise runs `handler` with the settlement.
 */
export function requirePayment(amountAtomic: string, handler: PaidHandler): RouteHandler {
  return async (req, ctx) => {
    try {
      const cfg = getX402Config()
      if (!cfg) return NOT_FOUND() // disabled or misconfigured → route does not exist

      const accept = acceptFor(cfg, amountAtomic)
      const url = req.nextUrl?.toString() ?? req.url

      const header = req.headers.get("x-payment")
      if (!header) {
        return NextResponse.json(paymentRequired(url, accept, "Payment required"), { status: 402 })
      }

      const payload = decodePaymentPayload(header)
      if (!payload) {
        return NextResponse.json(
          { ...paymentRequired(url, accept, "Malformed X-PAYMENT"), error: "invalid_payload" },
          { status: 402 },
        )
      }

      const verified = await facilitator.verify(payload, accept, url)
      if (!verified.isValid) {
        return NextResponse.json(
          { ...paymentRequired(url, accept, "Payment not valid"), error: verified.invalidReason ?? "invalid_payment" },
          { status: 402 },
        )
      }

      const settled = await facilitator.settle(payload, accept, url)
      if (!settled.success) {
        return NextResponse.json(
          { ...paymentRequired(url, accept, "Settlement failed"), error: settled.errorReason ?? "settle_failed" },
          { status: 402 },
        )
      }

      const res = await handler(req, {
        ...ctx,
        payment: { payer: settled.payer, transaction: settled.transaction },
      })
      res.headers.set("x-payment-response", encodeSettlement(settled))
      return res
    } catch (err) {
      return fromError(err)
    }
  }
}
