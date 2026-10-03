import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import { isEnabled } from "@/lib/features"
import { markNotificationsRead } from "@/db/queries/notifications"
import { markNotificationsReadSchema } from "@/lib/validation"
import { fromError } from "@/lib/api-response"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"

// Per session user. Generous: the dropdown fires one PATCH per item click, so
// a reader working down a long inbox must never trip it.
const readLimiter = createRateLimiter({ windowMs: 60_000, max: 60 })

// PATCH /api/v1/notifications/read — mark the SESSION user's own
// notifications read. Body: { ids?: number[] }.
//   omitted    → mark ALL of the caller's unread notifications read (the
//                dropdown's "mark all read").
//   [1, 2, 3]  → mark exactly those (the dropdown's per-item click). Ids that
//                don't belong to the caller, or are already read, are
//                silently unaffected — ownership is enforced in
//                markNotificationsRead itself, not just trusted here.
// 503 when the substrate is compiled off (audit HIGH-003 pattern).
export const PATCH = withAuth(async (req, { user }) => {
  if (!isEnabled("notifications")) {
    return NextResponse.json(
      { ok: false, error: { code: "FEATURE_DISABLED", message: "Notifications are not available" } },
      { status: 503 },
    )
  }

  const limit = readLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  try {
    const body = await req.json().catch(() => ({}))

    const parsed = markNotificationsReadSchema.safeParse(body ?? {})
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
        { status: 400 },
      )
    }

    const updated = await markNotificationsRead(user.userId, parsed.data.ids)

    return NextResponse.json({ ok: true, data: { updated } })
  } catch (err) {
    return fromError(err)
  }
})
