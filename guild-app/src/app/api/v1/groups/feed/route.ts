import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { listMemberFeed } from "@/db/queries/working-groups"
import { fromError, error as apiError } from "@/lib/api-response"

// GET /api/v1/groups/feed — THE MEMBER FEED, the core value of working groups.
//
// Tasks from every group you joined, minus the ones you muted, newest first.
// Authenticated by definition: "my feed" has no anonymous meaning, and an empty
// unauthenticated response would look like "no work" rather than "not signed
// in" — the two states a discovery surface must never conflate.
//
// Keyset paging: `?before=<iso>_<id>` from the previous page's cursor. Not
// OFFSET — the feed gains rows while it is being paged, which shifts every
// offset and makes tasks repeat or vanish.
export const GET = withAuth(async (req, { user }) => {
  try {
    const url = new URL(req.url)
    const limitParam = Number(url.searchParams.get("limit"))
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 20

    let before: { createdAt: Date; id: number } | undefined
    const raw = url.searchParams.get("before")
    if (raw) {
      // Split on the LAST underscore: an ISO timestamp contains none, but
      // pinning the id side is what makes a malformed cursor detectable rather
      // than silently paging from the top of the feed again.
      const idx = raw.lastIndexOf("_")
      const createdAt = new Date(raw.slice(0, idx))
      const id = Number(raw.slice(idx + 1))
      if (idx < 0 || Number.isNaN(createdAt.getTime()) || !Number.isFinite(id)) {
        return apiError("Malformed cursor", "INVALID_CURSOR", 400)
      }
      before = { createdAt, id }
    }

    const { data, hasMore, cursor } = await listMemberFeed(user.userId, { limit, before })
    return NextResponse.json({
      ok: true,
      data,
      hasMore,
      cursor: cursor ? `${cursor.createdAt.toISOString()}_${cursor.id}` : null,
    })
  } catch (err) {
    return fromError(err)
  }
})
