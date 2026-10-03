import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { behindAgentsFlag } from "@/lib/agent-api"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"
import { findOwnedPairingCode } from "@/db/queries/agents"
import { formatPairingCode, normalizePairingCode } from "@/lib/agent-label"

// The Add-an-agent dialog asks every 5 s while it waits (12/min); room for a retry.
const statusLimiter = createRateLimiter({ windowMs: 60_000, max: 30 })

/**
 * GET /api/v1/agents/codes/{code} — has the agent used THIS code yet?
 * (docs/design/bring-your-agent.md §1a step 2; the owner's waiting screen.)
 *
 *   open      not redeemed, not expired — keep waiting
 *   redeemed  an agent redeemed it (it is now on GET /agents/mine as pending)
 *   expired   not redeemed and past its expiry — it can never be redeemed now
 *
 * Read from the code's own row, so the answer is about this code alone —
 * never inferred from which agents exist. Owner-only: another account's code,
 * a malformed code and a missing one are the same 404, so this is no oracle.
 */
export const GET = behindAgentsFlag(withAuth(async (_req, { params, user }) => {
  const limit = statusLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const code = normalizePairingCode((await params).code)
  const row = code ? await findOwnedPairingCode(code, user.userId) : null
  if (!row) {
    return NextResponse.json({ ok: false, error: { code: "CODE_NOT_FOUND", message: "No such pairing code on your account." } }, { status: 404 })
  }
  const status = row.redeemedAt ? "redeemed" : row.expiresAt.getTime() <= Date.now() ? "expired" : "open"
  return NextResponse.json({
    ok: true,
    data: { code: formatPairingCode(row.code), status, expiresAt: row.expiresAt.toISOString() },
  })
}))
