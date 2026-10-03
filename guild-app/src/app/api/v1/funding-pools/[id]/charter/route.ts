import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { isEnabled } from "@/lib/features"
import { saveDraftCharter } from "@/db/queries/funding-pools"
import { PoolCharterSchema } from "@/lib/pool-charter"
import { fromError, error as apiError } from "@/lib/api-response"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"

// PUT /api/v1/funding-pools/[id]/charter — save a DRAFT's charter.
//
// Accepts a partial: a charter is written over several sittings, and refusing
// to save an unfinished one would just push people to write it somewhere else
// and paste it in at the end, which is the opposite of what the draft state is
// for. The completeness bar lives at publish (charterReadiness), not here.
//
// Refuses once the pool has left draft. What contributors pledged against has
// to stop moving the moment it can attract a pledge.
const charterLimiter = createRateLimiter({ windowMs: 60_000, max: 30 })

export const PUT = withAuth(async (req, { params, user }) => {
  if (!isEnabled("crowdfund")) {
    return NextResponse.json(
      { ok: false, error: { code: "FEATURE_DISABLED", message: "Community funding is not available" } },
      { status: 503 },
    )
  }

  const limit = charterLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const { id } = await params
  const poolId = parseInt(id, 10)
  if (Number.isNaN(poolId)) return apiError("Invalid pool id", "INVALID_ID", 400)

  const body = await req.json().catch(() => null)
  if (!body) return apiError("Invalid JSON", "INVALID_BODY", 400)
  const parsed = PoolCharterSchema.partial().safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
      { status: 400 },
    )
  }

  try {
    const result = await saveDraftCharter(poolId, user.userId, parsed.data)
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
