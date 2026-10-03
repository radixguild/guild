import { NextRequest, NextResponse } from "next/server"
import { getLeaderboard } from "@/db/queries/users"
import { fromError } from "@/lib/api-response"
import { formatAddress } from "@/lib/marketplace-utils"

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 50

// GET /api/v1/users/leaderboard — public top-N by reputation, no auth
// required. Truncate the wallet address in the RESPONSE only (via the
// shared formatAddress helper, same as GET /api/v1/game/leaderboard) so an
// unauthenticated caller never sees a full address (audit MEDIUM-002).
// getLeaderboard() itself keeps returning full ids — G-508 exclusion and
// other internal callers still need the real address.
export async function GET(req: NextRequest) {
  try {
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

    const rows = await getLeaderboard(limit)
    const data = rows.map((row) => ({ ...row, id: formatAddress(row.id) }))

    return NextResponse.json({ ok: true, data })
  } catch (err) {
    return fromError(err)
  }
}
