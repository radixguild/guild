import { NextRequest, NextResponse } from "next/server"
import { clearSessionCookie } from "@/lib/auth"
import { fromError } from "@/lib/api-response"
import { crossOriginRefusal } from "@/lib/same-origin"

export async function POST(req: NextRequest) {
  try {
    const refused = crossOriginRefusal(req)
    if (refused) return refused
    await clearSessionCookie()
    return NextResponse.json({ ok: true, data: null })
  } catch (err) {
    return fromError(err)
  }
}
