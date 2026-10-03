import { NextRequest, NextResponse } from "next/server"
import { isEnabled } from "@/lib/features"
import { gameLeaderboard } from "@/db/queries/game"
import { fromError } from "@/lib/api-response"
import { formatAddress } from "@/lib/marketplace-utils"

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 50

// GET /api/v1/game/leaderboard — public top-N by lifetime bonus XP. No
// [address] in the path; 503 when the feature is off (audit HIGH-003).
export async function GET(req: NextRequest) {
  try {
    if (!isEnabled("game")) {
      return NextResponse.json(
        { ok: false, error: { code: "FEATURE_DISABLED", message: "Game features are not available" } },
        { status: 503 },
      )
    }

    const { searchParams } = new URL(req.url)
    const limitParam = searchParams.get("limit")
    let limit = DEFAULT_LIMIT
    if (limitParam) {
      const parsed = parseInt(limitParam, 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return NextResponse.json(
          { ok: false, error: { code: "INVALID_LIMIT", message: "limit must be a positive integer" } },
          { status: 400 },
        )
      }
      limit = Math.min(parsed, MAX_LIMIT)
    }

    const rows = await gameLeaderboard(limit)
    // formatAddress truncates so the public board doesn't expose full
    // addresses to unauthenticated callers (audit MEDIUM-002) — the same
    // helper GET /api/v1/users/leaderboard uses (T4: one truncation
    // implementation, used by both public leaderboards).
    const data = rows.map((row, i) => ({
      rank: i + 1,
      address: formatAddress(row.userId),
      display_name: row.displayName,
      total_bonus_xp: row.totalBonusXp,
      total_rolls: row.totalRolls,
      jackpots: row.jackpots,
      streak_days: row.streakDays,
    }))

    return NextResponse.json({ ok: true, data })
  } catch (err) {
    return fromError(err)
  }
}
