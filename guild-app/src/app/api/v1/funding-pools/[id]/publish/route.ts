import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { isEnabled } from "@/lib/features"
import { publishFundingPool } from "@/db/queries/funding-pools"
import { fromError, error as apiError } from "@/lib/api-response"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"

// POST /api/v1/funding-pools/[id]/publish — draft -> pledging.
//
// Publishing does two things and neither of them moves XRD: it freezes the
// charter, and it starts the pledging clock (the wall-clock deadline is
// derived here from the stored window length — see publishPool() in
// src/lib/funding-state-machine.ts).
//
// Deliberately NOT behind chainWriteGate, unlike the pledge route. Nothing
// here is signed on chain, so a network halt does not make publishing
// impossible — it makes it the only useful thing a poster can still do. The
// pledge route keeps its gate because a pledge is the step that eventually
// becomes a transaction.
const publishLimiter = createRateLimiter({ windowMs: 60_000, max: 10 })

export const POST = withAuth(async (_req, { params, user }) => {
  if (!isEnabled("crowdfund")) {
    return NextResponse.json(
      { ok: false, error: { code: "FEATURE_DISABLED", message: "Community funding is not available" } },
      { status: 503 },
    )
  }

  const limit = publishLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const { id } = await params
  const poolId = parseInt(id, 10)
  if (Number.isNaN(poolId)) return apiError("Invalid pool id", "INVALID_ID", 400)

  try {
    const result = await publishFundingPool(poolId, user.userId)
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: { code: result.code, message: result.message } },
        { status: result.httpStatus },
      )
    }
    return NextResponse.json({ ok: true, data: result.data })
  } catch (err) {
    return fromError(err)
  }
})
