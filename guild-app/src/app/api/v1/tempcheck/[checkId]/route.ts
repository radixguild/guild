import { NextRequest, NextResponse } from "next/server"
import { getSessionUser } from "@/lib/auth"
import { fromError } from "@/lib/api-response"
import { createRateLimiter, getClientIp, rateLimitResponse } from "@/lib/rate-limit"
import { tempCheckVoteSchema } from "@/lib/validation"
import { TEMP_CHECKS, type CheckId } from "@/content/lights-on"
import { countSigned, getVoterChoice, getVotesForCheck, tallyVotes, upsertVote } from "@/db/queries/tempcheck"

// /lights-on's web temperature checks ("Who keeps the lights on?"). Unweighted,
// one vote per browser, never binding — see src/content/lights-on.ts's
// WIDGET_COPY for the exact promise this route keeps.

const VOTER_COOKIE = "tc_voter"
const VOTER_COOKIE_MAX_AGE = 365 * 24 * 60 * 60 // 1 year, in seconds
const MAX_BODY_BYTES = 1024
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Per-IP write throttle (spec: "cap per-IP to a sane rate ... do not build a
// new rate limiter" — reuses the same createRateLimiter as auth/verify and
// groups/propose). No limiter on GET: it is a plain read with no side effect,
// same posture as /api/v1/network/status.
const voteLimiter = createRateLimiter({ windowMs: 60_000, max: 20 })

function isCheckId(value: string): value is CheckId {
  return Object.prototype.hasOwnProperty.call(TEMP_CHECKS, value)
}

function badRequest(code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status: 400 })
}

type RouteCtx = { params: Promise<{ checkId: string }> }

export async function GET(req: NextRequest, { params }: RouteCtx) {
  try {
    const { checkId } = await params
    if (!isCheckId(checkId)) {
      return badRequest("UNKNOWN_CHECK", "Unknown temperature check")
    }

    const check = TEMP_CHECKS[checkId]
    const rows = await getVotesForCheck(checkId)

    // `yourVote` is an addition on top of the {checkId, total, signed,
    // options} contract, not a replacement for it — sourced from the SAME
    // httpOnly cookie the POST route reads, never from anything client-
    // supplied, so a page reload can still show the voter their own choice
    // (the cookie is httpOnly precisely so client JS cannot read it itself).
    const voterKey = req.cookies.get(VOTER_COOKIE)?.value
    const yourVote = voterKey && UUID_RE.test(voterKey) ? await getVoterChoice(checkId, voterKey) : null

    return NextResponse.json({
      ok: true,
      data: {
        checkId,
        total: rows.length,
        signed: countSigned(rows),
        options: tallyVotes(rows, check.options.map((o) => o.key)),
        yourVote,
      },
    })
  } catch (err) {
    return fromError(err)
  }
}

export async function POST(req: NextRequest, { params }: RouteCtx) {
  try {
    const { checkId } = await params
    if (!isCheckId(checkId)) {
      return badRequest("UNKNOWN_CHECK", "Unknown temperature check")
    }
    const check = TEMP_CHECKS[checkId]

    const limit = voteLimiter(getClientIp(req))
    if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

    // Reject oversized bodies before parsing — a 1KB cap is generous for a
    // one-field `{option}` payload and cheap to enforce on the raw text.
    const raw = await req.text()
    if (raw.length > MAX_BODY_BYTES) {
      return badRequest("BODY_TOO_LARGE", "Request body too large")
    }

    let body: unknown
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      return badRequest("INVALID_BODY", "Invalid JSON")
    }

    const parsed = tempCheckVoteSchema.safeParse(body)
    if (!parsed.success) {
      return badRequest("VALIDATION_ERROR", parsed.error.message)
    }

    const optionKey = parsed.data.option
    if (!check.options.some((o) => o.key === optionKey)) {
      return badRequest("UNKNOWN_OPTION", "Unknown option for this check")
    }

    // Voter identity: the existing tc_voter cookie, or a freshly minted UUID
    // on this browser's first vote anywhere on the page. Never trust a
    // client-supplied value that isn't shaped like one of ours.
    const existing = req.cookies.get(VOTER_COOKIE)?.value
    const voterKey = existing && UUID_RE.test(existing) ? existing : crypto.randomUUID()

    const user = await getSessionUser()
    const signed = user !== null

    await upsertVote({
      checkId,
      optionKey,
      voterKey,
      userId: user?.userId ?? null,
      signed,
    })

    const rows = await getVotesForCheck(checkId)
    const res = NextResponse.json({
      ok: true,
      data: {
        checkId,
        total: rows.length,
        signed: countSigned(rows),
        options: tallyVotes(rows, check.options.map((o) => o.key)),
        yourVote: optionKey,
      },
    })

    // "Ignore requests without the cookie when it cannot be set": setting a
    // cookie on a NextResponse we just built cannot fail in a real route
    // handler (there is no I/O involved — it only appends a header), but the
    // vote is worthless without a way to identify the SAME browser next time,
    // so the guard is kept rather than assumed. If this ever throws, refuse
    // the vote outright instead of returning success for an identity that
    // will not persist.
    try {
      res.cookies.set(VOTER_COOKIE, voterKey, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: VOTER_COOKIE_MAX_AGE,
        path: "/",
      })
    } catch {
      return badRequest("COOKIE_REQUIRED", "A voter cookie is required to vote")
    }

    return res
  } catch (err) {
    return fromError(err)
  }
}
