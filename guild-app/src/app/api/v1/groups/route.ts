import { NextResponse } from "next/server"
import { getSessionUser } from "@/lib/auth"
import { listWorkingGroups } from "@/db/queries/working-groups"
import { fromError } from "@/lib/api-response"

// GET /api/v1/groups — the working-group catalog (Model A).
//
// Public, but viewer-aware: signed in, each row carries YOUR membership level so
// the browse page renders join/leave state in one round trip. Deliberately NOT
// withAuth — a cold visitor must be able to see what the groups are before
// connecting a wallet, which is the entire discovery job of this surface.
export async function GET() {
  try {
    const user = await getSessionUser().catch(() => null)
    const data = await listWorkingGroups(user?.userId)
    return NextResponse.json({ ok: true, data })
  } catch (err) {
    return fromError(err)
  }
}
