import { NextResponse } from "next/server"
import { listGroupsFeed, findWorkingGroupIdsBySlugs } from "@/db/queries/working-groups"
import { fromError, error as apiError } from "@/lib/api-response"

// GET /api/v1/groups/browse?groups=<slug>[,<slug>...] — custom-feed browse
// (build step 5): "the same query with working_group_id IN (:selected) and no
// membership join — a preview of groups before joining."
//
// Public, unlike /groups/feed: this shows what a set of groups' feeds looks
// like, not "my feed", so there is no viewer state to be authenticated about
// and a cold visitor can filter the board by area before ever connecting a
// wallet — the same discovery-first stance as GET /api/v1/groups.
//
// Keyset paging: `?before=<iso>_<id>`, identical shape to /groups/feed.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const raw = url.searchParams.get("groups")?.trim() ?? ""
    if (!raw) {
      return apiError(
        "groups is required — a comma-separated list of working-group slugs",
        "VALIDATION_ERROR",
        400,
      )
    }
    const slugs = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))]

    const limitParam = Number(url.searchParams.get("limit"))
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 20

    let before: { createdAt: Date; id: number } | undefined
    const cursorRaw = url.searchParams.get("before")
    if (cursorRaw) {
      const idx = cursorRaw.lastIndexOf("_")
      const createdAt = new Date(cursorRaw.slice(0, idx))
      const id = Number(cursorRaw.slice(idx + 1))
      if (idx < 0 || Number.isNaN(createdAt.getTime()) || !Number.isFinite(id)) {
        return apiError("Malformed cursor", "INVALID_CURSOR", 400)
      }
      before = { createdAt, id }
    }

    // Unknown slugs resolve to nothing rather than 400ing — see the query's
    // own comment: a shareable ?groups= link should degrade gracefully.
    const groupIds = await findWorkingGroupIdsBySlugs(slugs)
    const { data, hasMore, cursor } = await listGroupsFeed(groupIds, { limit, before })
    return NextResponse.json({
      ok: true,
      data,
      hasMore,
      cursor: cursor ? `${cursor.createdAt.toISOString()}_${cursor.id}` : null,
    })
  } catch (err) {
    return fromError(err)
  }
}
