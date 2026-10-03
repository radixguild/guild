import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { isEnabled } from "@/lib/features"
import { getGameState } from "@/db/queries/game"

// GET /api/v1/game/state — the SESSION user's own roll state. Identity from the
// session (no [address] in the path), 503 when the feature is off (audit
// HIGH-003). Read-only: it never grants or mutates.
export const GET = withAuth(async (_req, { user }) => {
  if (!isEnabled("game")) {
    return NextResponse.json(
      { ok: false, error: { code: "FEATURE_DISABLED", message: "Game features are not available" } },
      { status: 503 },
    )
  }

  const s = await getGameState(user.userId)
  return NextResponse.json({
    ok: true,
    data: {
      total_rolls: s?.totalRolls ?? 0,
      total_bonus_xp: s?.totalBonusXp ?? 0,
      streak_days: s?.streakDays ?? 0,
      last_roll_value: s?.lastRollValue ?? 0,
      jackpots: s?.jackpots ?? 0,
      available_rolls_remaining: s?.availableRolls ?? 0,
    },
  })
})
