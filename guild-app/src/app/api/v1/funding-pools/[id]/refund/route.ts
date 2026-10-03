import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { isEnabled } from "@/lib/features"
import { claimFundingRefund } from "@/db/queries/funding-pools"
import { fromError, error as apiError } from "@/lib/api-response"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"
import { chainWriteGate } from "@/lib/chain-halt-gate"

// POST /api/v1/funding-pools/[id]/refund — pull refunds only (D4): the
// caller claims THEIR OWN recorded pledge back; there is no body, no
// destination argument, and no way to name another account, mirroring the
// blueprint's own `claim_refund(pool_id, contributor_account)` shape where
// the payee is always the caller.
//
// ⚠️ Same honesty note as the pledge route: this reverses an app-layer
// ledger entry. No real XRD was ever moved by the pledge this undoes, so
// none moves back here either.
const refundLimiter = createRateLimiter({ windowMs: 60_000, max: 20 })

export const POST = withAuth(async (_req, { params, user }) => {
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

  const limit = refundLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const { id } = await params
  const poolId = parseInt(id, 10)
  if (Number.isNaN(poolId)) return apiError("Invalid pool id", "INVALID_ID", 400)

  try {
    const result = await claimFundingRefund(poolId, user.userId)
    if (!result.ok) return apiError(result.message, result.code, result.httpStatus)
    return NextResponse.json({ ok: true, data: result.data, onChain: false })
  } catch (err) {
    return fromError(err)
  }
})
