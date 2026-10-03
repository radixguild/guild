import { NextRequest, NextResponse } from "next/server"
import { isEnabled } from "@/lib/features"
import { getPatronLeaderboard } from "@/db/queries/funding-pools"
import { fromError } from "@/lib/api-response"

// GET /api/v1/funding-pools/leaderboard — the patron leaderboard ("backers
// get patronage not profit"). Ranked by distinct pools backed, NEVER by XRD
// pledged — see getPatronLeaderboard's doc comment for why ranking by money
// would undercut the whole framing this feature is built on.
export async function GET(req: NextRequest) {
  if (!isEnabled("crowdfund")) {
    return NextResponse.json(
      { ok: false, error: { code: "FEATURE_DISABLED", message: "Community funding is not available" } },
      { status: 503 },
    )
  }
  try {
    const { searchParams } = new URL(req.url)
    const limitParam = searchParams.get("limit")
    const limit = limitParam ? parseInt(limitParam, 10) : undefined
    if (limitParam && (!Number.isFinite(limit) || (limit as number) <= 0)) {
      // Same guard as /api/v1/funding-pools' GET and /api/v1/game/leaderboard.
      // Two failure modes, not one: an unchecked NaN reaches
      // getPatronLeaderboard's `Math.min(limit, 100)` (still NaN) and
      // `.limit(NaN)`; a negative limit is finite, so an isFinite-only check
      // passed it straight through to `.limit(-5)`, which Postgres rejects.
      // Both surfaced as a generic 500 instead of this typed 400.
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_LIMIT", message: "limit must be a positive integer" } },
        { status: 400 },
      )
    }
    const data = await getPatronLeaderboard(limit)
    return NextResponse.json({ ok: true, data })
  } catch (err) {
    return fromError(err)
  }
}
