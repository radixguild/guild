import { NextRequest, NextResponse } from "next/server"
import { verifyAndConsume } from "@/lib/rola"
import { createSession, setSessionCookie } from "@/lib/auth"
import { findOrCreateUser } from "@/db/queries/users"
import { verifyAuthSchema } from "@/lib/validation"
import { fromError } from "@/lib/api-response"
import { createRateLimiter, getClientIp, rateLimitResponse } from "@/lib/rate-limit"
import { crossOriginRefusal } from "@/lib/same-origin"

const limiter = createRateLimiter({ windowMs: 60_000, max: 10 })

export async function POST(req: NextRequest) {
  try {
    // Login CSRF: a sibling-subdomain page could otherwise post ITS OWN valid
    // proof and sign the visitor in as someone else.
    const refused = crossOriginRefusal(req)
    if (refused) return refused
    const limit = limiter(getClientIp(req))
    if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

    const body = await req.json().catch(() => null)
    if (!body) {
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_BODY", message: "Invalid JSON" } },
        { status: 400 },
      )
    }

    const parsed = verifyAuthSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
        { status: 400 },
      )
    }

    const { signed_challenge } = parsed.data
    const result = await verifyAndConsume(signed_challenge)
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: { code: "AUTH_FAILED", message: result.error } },
        { status: 401 },
      )
    }

    // Sessions are for ACCOUNTS only. ROLA also verifies persona proofs
    // (identity_rdx1…), but a persona can hold no badge, fund no escrow and
    // receive no reward, and every userId downstream is read as an account.
    // Neither the site nor the agent kit ever signs in with a persona.
    if (!result.address.startsWith("account_rdx1")) {
      return NextResponse.json(
        {
          ok: false,
          error: { code: "ACCOUNT_REQUIRED", message: "Sign in with a Radix account, not a persona." },
        },
        { status: 400 },
      )
    }

    // onConflictDoNothing (findOrCreateUser) never touches an existing row's
    // columns, so a returning user is never silently un-suspended here — the
    // only way suspendedAt clears is the operator's --lift (see
    // scripts/suspend-account.mjs). Refuse to mint a session for a suspended
    // address rather than let it sign in and hit ACCOUNT_SUSPENDED on its
    // first real call.
    const user = await findOrCreateUser(result.address)
    if (user.suspendedAt) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "ACCOUNT_SUSPENDED",
            message: "This account has been suspended. Contact the operator for details.",
          },
        },
        { status: 403 },
      )
    }
    const token = await createSession(user.id)
    await setSessionCookie(token)

    return NextResponse.json({ ok: true, data: { user } })
  } catch (err) {
    return fromError(err)
  }
}
