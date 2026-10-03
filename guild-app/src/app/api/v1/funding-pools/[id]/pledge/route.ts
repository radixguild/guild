import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { isEnabled } from "@/lib/features"
import { pledgeToFundingPool } from "@/db/queries/funding-pools"
import { pledgeFundingPoolSchema } from "@/lib/validation"
import { fromError, error as apiError } from "@/lib/api-response"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"
import { chainWriteGate } from "@/lib/chain-halt-gate"

// POST /api/v1/funding-pools/[id]/pledge
//
// ⚠️ READ THIS BEFORE WIRING ANY UI TO THIS ROUTE. A 201 here records a
// pledge in the app's own ledger (src/db/queries/funding-pools.ts). IT DOES
// NOT MOVE, LOCK, OR CUSTODY ANY XRD — there is no on-chain FundingPool
// component to send it to yet (docs/design/funding-pool-blueprint.md is a
// design, not a deployed blueprint; see PROJECT-STATE.md's ▶ 2026-08-14
// sitting). Any caller-facing surface built on this endpoint MUST say so in
// its own copy — do not let a UI imply a wallet transaction happened here,
// because none does. This is the same honesty boundary this repo's own
// hard rules require for on-chain claims generally.
const pledgeLimiter = createRateLimiter({ windowMs: 60_000, max: 20 })

export const POST = withAuth(async (req, { params, user }) => {
  if (!isEnabled("crowdfund")) {
    return NextResponse.json(
      { ok: false, error: { code: "FEATURE_DISABLED", message: "Community funding is not available" } },
      { status: 503 },
    )
  }

  // After the feature flag: the pool's money legs are signed on-chain, so a halt
  // makes this step impossible rather than merely slow. See chain-halt-gate.ts.
  const halted = await chainWriteGate()
  if (halted) return halted

  const limit = pledgeLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const { id } = await params
  const poolId = parseInt(id, 10)
  if (Number.isNaN(poolId)) return apiError("Invalid pool id", "INVALID_ID", 400)

  const body = await req.json().catch(() => null)
  if (!body) return apiError("Invalid JSON", "INVALID_BODY", 400)
  const parsed = pledgeFundingPoolSchema.safeParse(body)
  if (!parsed.success) return apiError(parsed.error.message, "VALIDATION_ERROR", 400)

  try {
    const result = await pledgeToFundingPool(poolId, user.userId, parsed.data.amount_xrd)
    if (!result.ok) return apiError(result.message, result.code, result.httpStatus)
    return NextResponse.json(
      {
        ok: true,
        data: result.data,
        // Explicit, cheap-to-read honesty flag alongside the row — see the
        // module doc above. Any consumer of this response should surface
        // this, not assume it from the 201.
        onChain: false,
      },
      { status: 201 },
    )
  } catch (err) {
    return fromError(err)
  }
})
