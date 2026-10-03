import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { isEnabled } from "@/lib/features"
import { listNotificationsForUser, countUnreadForUser } from "@/db/queries/notifications"
import { fromError } from "@/lib/api-response"

// GET /api/v1/notifications — the SESSION user's own inbox, newest first.
// Identity from the session (no [address] in the path — same posture as
// /api/v1/game/state), 503 when the substrate is compiled off (audit
// HIGH-003 pattern; see features.ts's `notifications`).
//
// Query params: ?limit=20 (max 100) · ?cursor=<id from the previous page's
// `cursor`> · ?unreadOnly=true.
export const GET = withAuth(async (req, { user }) => {
  if (!isEnabled("notifications")) {
    return NextResponse.json(
      { ok: false, error: { code: "FEATURE_DISABLED", message: "Notifications are not available" } },
      { status: 503 },
    )
  }

  try {
    const { searchParams } = new URL(req.url)

    const limitParam = searchParams.get("limit")
    const limit = limitParam ? parseInt(limitParam, 10) : undefined
    if (limitParam && isNaN(limit!)) {
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_LIMIT", message: "limit must be a number" } },
        { status: 400 },
      )
    }

    const { data, cursor, hasMore } = await listNotificationsForUser(user.userId, {
      limit,
      cursor: searchParams.get("cursor") ?? undefined,
      unreadOnly: searchParams.get("unreadOnly") === "true",
    })

    // Always the TRUE total, independent of this page's filter/cursor — the
    // header badge needs the real count even when the page loaded is
    // unreadOnly=false or only the first 20 rows.
    const unreadCount = await countUnreadForUser(user.userId)

    return NextResponse.json({ ok: true, data, cursor, hasMore, unreadCount })
  } catch (err) {
    return fromError(err)
  }
})
