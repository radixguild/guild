import { NextResponse } from "next/server"
import { clearSessionCookie } from "@/lib/auth"
import { fromError } from "@/lib/api-response"

export async function POST() {
  try {
    await clearSessionCookie()
    return NextResponse.json({ ok: true, data: null })
  } catch (err) {
    return fromError(err)
  }
}
