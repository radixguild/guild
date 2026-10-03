import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { createRateLimiter, getClientIp, rateLimitResponse } from "@/lib/rate-limit"
import { isAccountAddress } from "@/lib/agent-rules"
import { issueCode, tgLinkSecret, verifyTicket } from "@/lib/tg-link"
import { tgLinkCodeSchema } from "@/lib/validation"

const perAccount = createRateLimiter({ windowMs: 60_000, max: 5 })
const perIp = createRateLimiter({ windowMs: 60_000, max: 10 })

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ ok: false, error: { code, message } }, { status })

/**
 * POST /api/v1/telegram/link-code — the web half of the Telegram bot's /link
 * (see src/lib/tg-link.ts). The session's address is the one proved: a code is
 * only ever issued for `user.userId`, which a ROLA signature bound at sign-in,
 * never for an address from the request.
 */
export const POST = withAuth(async (req, { user }) => {
  const secret = tgLinkSecret()
  if (!secret) return fail(503, "TG_LINK_DISABLED", "Telegram linking isn't switched on yet.")

  const ip = perIp(getClientIp(req))
  if (!ip.ok) return rateLimitResponse(ip.retryAfter!)
  const acct = perAccount(user.userId)
  if (!acct.ok) return rateLimitResponse(acct.retryAfter!)

  if (!isAccountAddress(user.userId)) {
    return fail(403, "ACCOUNT_REQUIRED", "Sign in with a wallet account (account_rdx1…) to link it.")
  }

  const body = await req.json().catch(() => null)
  const parsed = tgLinkCodeSchema.safeParse(body)
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "A ticket from the Telegram bot is required.")

  const nowS = Math.floor(Date.now() / 1000)
  const ticket = verifyTicket(secret, parsed.data.ticket, nowS)
  if (!ticket.ok) {
    return ticket.reason === "expired"
      ? fail(410, "TG_TICKET_EXPIRED", "This link has expired. Send /link to the bot again.")
      : fail(400, "TG_TICKET_INVALID", "This link wasn't issued by the Guild bot. Send /link to the bot again.")
  }

  const { code, expiresAt } = issueCode(secret, { tgId: ticket.tgId, address: user.userId, nowS })
  return NextResponse.json({ ok: true, data: { code, expires_at: expiresAt, address: user.userId } })
})
