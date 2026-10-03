import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { behindAgentsFlag } from "@/lib/agent-api"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"
import { recordHeartbeat } from "@/db/queries/agents"
import { heartbeatSchema } from "@/lib/validation"

// One beat per tick; the loop's default tick is 60 s. 30/min tolerates a fast
// practice loop and starves a bug.
const limiter = createRateLimiter({ windowMs: 60_000, max: 30 })

/**
 * POST /api/v1/agents/me/heartbeat — "I am alive, and this is what my last
 * cycle did." The owner's card shows last-seen and the cycle summary; three
 * missed beats read as offline (docs/design/bring-your-agent.md §3.6).
 */
export const POST = behindAgentsFlag(withAuth(async (req, { user }) => {
  const limit = limiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const body = await req.json().catch(() => null)
  if (!body) {
    return NextResponse.json({ ok: false, error: { code: "INVALID_BODY", message: "Invalid JSON" } }, { status: 400 })
  }
  const parsed = heartbeatSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
      { status: 400 },
    )
  }
  const recorded = await recordHeartbeat(user.userId, parsed.data.cycle)
  if (!recorded) {
    return NextResponse.json(
      { ok: false, error: { code: "AGENT_NOT_PAIRED", message: "This account is not paired with an owner." } },
      { status: 404 },
    )
  }
  return NextResponse.json({ ok: true, data: { recordedAt: new Date().toISOString() } })
}))
