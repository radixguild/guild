import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { isEnabled } from "@/lib/features"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"
import { rollOnce } from "@/db/queries/game"

// Defence-in-depth on top of the per-day available_rolls budget — bounds a
// hammering client even mid-day. Keyed per user (audit Class 1, property 4),
// not per IP, so one user can't exhaust another's allowance.
const rollLimiter = createRateLimiter({ windowMs: 60_000, max: 30 })

// POST /api/v1/game/roll — roll once for the SESSION user.
//
// Audit posture:
//  - CRITICAL-001: identity comes from the session (withAuth → user.userId).
//    There is no [address] segment in the path, so cross-user rolls are
//    structurally impossible.
//  - CRITICAL-004: the endpoint accepts NO parameters. The face and bonus are
//    server-derived (CSPRNG); a non-empty body is rejected outright.
//  - HIGH-001: rollOnce() decrements the budget atomically and returns null
//    when none remain → 429.
//  - HIGH-003: hard 503 when the game feature flag is off.
export const POST = withAuth(async (req, { user }) => {
  if (!isEnabled("game")) {
    return NextResponse.json(
      { ok: false, error: { code: "FEATURE_DISABLED", message: "Game features are not available" } },
      { status: 503 },
    )
  }

  // No client parameters accepted. Allow only an absent or empty body.
  const raw = (await req.text()).trim()
  if (raw !== "" && raw !== "{}") {
    return NextResponse.json(
      { ok: false, error: { code: "BODY_NOT_ALLOWED", message: "This endpoint accepts no parameters" } },
      { status: 400 },
    )
  }

  const limit = rollLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const result = await rollOnce(user.userId)
  if (!result) {
    return NextResponse.json(
      { ok: false, error: { code: "NO_ROLLS", message: "No rolls remaining today" } },
      { status: 429 },
    )
  }

  const s = result.state
  return NextResponse.json({
    ok: true,
    data: {
      roll: result.roll,
      bonus_xp: result.bonus,
      jackpot: result.jackpot,
      total_rolls: s.totalRolls,
      total_bonus_xp: s.totalBonusXp,
      streak_days: s.streakDays,
      available_rolls_remaining: s.availableRolls,
    },
  })
})
