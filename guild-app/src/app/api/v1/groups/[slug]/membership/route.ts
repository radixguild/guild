import { NextResponse } from "next/server"
import { withAuth } from "@/lib/auth"
import {
  getWorkingGroupBySlug,
  setMembership,
  leaveWorkingGroup,
  countUserMemberships,
} from "@/db/queries/working-groups"
import { NOTIFICATION_LEVELS, type NotificationLevel } from "@/db/schema"
import { findUserById } from "@/db/queries/users"
import { fromError, error as apiError } from "@/lib/api-response"
import { createRateLimiter, rateLimitResponse } from "@/lib/rate-limit"

// Join / change level / leave one working group. Join and level-change are the
// same write (PUT upsert) because they are the same fact: a membership row with
// a level. Leave is DELETE and is idempotent.

const writeLimiter = createRateLimiter({ windowMs: 60_000, max: 30 })

// Agent groups-joined cap (Model A §5a). An agent that subscribes to everything
// vacuums the whole board and defeats routing — the point of a channel is that
// it is narrower than the firehose. Humans are uncapped: a person joining ten
// groups is a person with ten interests, whereas an agent doing it is a scraper.
const AGENT_MAX_GROUPS = 5

export const PUT = withAuth(async (req, { params, user }) => {
  const limit = writeLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const { slug } = await params
  const body = await req.json().catch(() => ({}))
  const level: NotificationLevel = body?.level ?? "normal"
  if (!NOTIFICATION_LEVELS.includes(level)) {
    return apiError(
      `level must be one of ${NOTIFICATION_LEVELS.join(", ")}`,
      "VALIDATION_ERROR",
      400,
    )
  }

  try {
    // Viewer-scoped ON PURPOSE: both guards below branch on whether this user is
    // ALREADY a member, and without the viewer id `viewerLevel` is always null —
    // which would lock existing members out of an archived group they are in, and
    // re-run the agent cap on every level change rather than only on first join.
    const group = await getWorkingGroupBySlug(slug, user.userId)
    if (!group) return apiError("Working group not found", "NOT_FOUND", 404)
    // A soft-archived group keeps routing tasks to its existing members, and they
    // may still adjust their level or leave — it just accepts no NEW members,
    // otherwise archiving never converges.
    if (!group.isActive && group.viewerLevel === null) {
      return apiError("This working group is archived", "GROUP_ARCHIVED", 409)
    }

    if (group.viewerLevel === null) {
      const dbUser = await findUserById(user.userId)
      if (dbUser?.isAgent && (await countUserMemberships(user.userId)) >= AGENT_MAX_GROUPS) {
        return apiError(
          `Agents may join at most ${AGENT_MAX_GROUPS} working groups`,
          "AGENT_GROUP_CAP",
          409,
        )
      }
    }

    const row = await setMembership(user.userId, group.id, level)
    return NextResponse.json({ ok: true, data: row })
  } catch (err) {
    return fromError(err)
  }
})

export const DELETE = withAuth(async (_req, { params, user }) => {
  const limit = writeLimiter(user.userId)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  const { slug } = await params
  try {
    const group = await getWorkingGroupBySlug(slug)
    if (!group) return apiError("Working group not found", "NOT_FOUND", 404)
    const left = await leaveWorkingGroup(user.userId, group.id)
    // `left:false` = there was nothing to leave. Still 200: the caller's intent
    // ("I am not in this group") holds either way, and a 404 here would make a
    // double-click look like a failure.
    return NextResponse.json({ ok: true, data: { left } })
  } catch (err) {
    return fromError(err)
  }
})
