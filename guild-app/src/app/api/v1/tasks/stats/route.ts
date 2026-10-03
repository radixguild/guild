import { NextResponse } from "next/server"
import { getTaskStats } from "@/db/queries/tasks"
import { fromError } from "@/lib/api-response"

// Public marketplace pulse: per-status task counts + total paid XRD. No auth —
// this feeds the homepage widget and the TG bot's read-only /bounty stats
// (R1-BOT-UNIFICATION). Static segment, so Next resolves /tasks/stats ahead of
// the dynamic /tasks/[id] — no collision.
export async function GET() {
  try {
    const stats = await getTaskStats()
    return NextResponse.json({ ok: true, data: stats })
  } catch (err) {
    return fromError(err)
  }
}
