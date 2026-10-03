import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { listUserMemberships } from "@/db/queries/working-groups"
import { fromError } from "@/lib/api-response"

// GET /api/v1/groups/memberships — the CALLER's own joined groups (Model A step 4).
//
// 🔒 Deliberately self-only, and `withAuth` rather than the viewer-aware
// `getSessionUser()` the catalog route uses. There is no `?user=` parameter and
// adding one is a product decision, not a refactor:
//
// A working group is a SUBSCRIPTION — the design doc's own framing is "people
// join a work channel to hear about new work". Publishing which channels
// someone listens to is a disclosure the feature never promised, and it is the
// asymmetric direction: profile chips can be widened to public later on a
// decision, but a membership list that has been public cannot be un-published.
// So this returns exactly one person's rows: the authenticated caller's.
//
// Consequence for the UI: the profile page renders chips only when you are
// looking at your own profile. That is the intended shape, not a limitation to
// be worked around by threading an address in here.
export const GET = withAuth(async (_req, { user }) => {
  try {
    const data = await listUserMemberships(user.userId)
    return NextResponse.json({ ok: true, data })
  } catch (err) {
    return fromError(err)
  }
})
