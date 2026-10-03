import { NextResponse } from "next/server"
import { getSessionUser } from "@/lib/auth"
import { findUserById } from "@/db/queries/users"
import { fromError } from "@/lib/api-response"

export async function GET() {
  try {
    const session = await getSessionUser()
    if (!session) {
      return NextResponse.json(
        { ok: false, error: { code: "AUTH_REQUIRED", message: "Not authenticated" } },
        { status: 401 },
      )
    }

    const user = await findUserById(session.userId)
    if (!user) {
      return NextResponse.json(
        { ok: false, error: { code: "USER_NOT_FOUND", message: "User not found" } },
        { status: 404 },
      )
    }

    return NextResponse.json({ ok: true, data: { user } })
  } catch (err) {
    return fromError(err)
  }
}
