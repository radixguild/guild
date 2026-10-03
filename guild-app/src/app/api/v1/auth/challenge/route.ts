import { NextRequest, NextResponse } from "next/server"
import { logger } from "@/lib/hardening"
import { issueChallenge } from "@/lib/rola"
import { fromError } from "@/lib/api-response"
import { createRateLimiter, getClientIp, rateLimitResponse } from "@/lib/rate-limit"

const limiter = createRateLimiter({ windowMs: 60_000, max: 10 })

export async function GET(req: NextRequest) {
  const requestId = crypto.randomUUID()
  try {
    const ip = getClientIp(req)
    const limit = limiter(ip)
    if (!limit.ok) {
      logger.warn("Rate limit hit", { route: "/api/v1/auth/challenge", ip, requestId })
      return rateLimitResponse(limit.retryAfter!)
    }

    const { challenge, expires_at } = issueChallenge()
    logger.info("Challenge issued", { route: "/api/v1/auth/challenge", requestId })
    return NextResponse.json({ ok: true, data: { challenge, expires_at } })
  } catch (err) {
    logger.error("Challenge endpoint error", { route: "/api/v1/auth/challenge", error: String(err), requestId })
    return fromError(err)
  }
}
