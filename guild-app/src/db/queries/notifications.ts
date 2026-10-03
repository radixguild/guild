import { and, count, desc, eq, inArray, isNull, lt } from "drizzle-orm"
import { db, type DbExecutor } from "@/db"
import { notifications, type NotificationEvent, type NotificationPayload } from "@/db/schema"

export interface CreateNotificationInput {
  recipientId: string
  event: NotificationEvent
  taskId?: number | null
  payload?: NotificationPayload | null
}

/**
 * Insert one notification row. Takes an optional executor so a future caller
 * COULD fold it into an enclosing transaction — but src/lib/notifications.ts's
 * emitNotification deliberately does NOT pass one: a notification write must
 * never roll back the money-path transition it observes, so it always runs as
 * its own standalone statement, after that transition has already committed.
 */
export async function createNotification(input: CreateNotificationInput, tx?: DbExecutor) {
  const handle = tx ?? db
  const [row] = await handle
    .insert(notifications)
    .values({
      recipientId: input.recipientId,
      event: input.event,
      taskId: input.taskId ?? null,
      payload: input.payload ?? null,
    })
    .returning()
  return row
}

export interface ListNotificationsOptions {
  limit?: number
  cursor?: string // last-seen id, as a string (from the previous page's cursor)
  unreadOnly?: boolean
}

export interface ListNotificationsResult {
  data: (typeof notifications.$inferSelect)[]
  cursor: string | null
  hasMore: boolean
}

/**
 * This recipient's notifications, newest first. id DESC (not created_at DESC)
 * — see the schema note on notifications_recipient_id_idx for why id is a
 * safe, indexed proxy for recency here.
 */
export async function listNotificationsForUser(
  recipientId: string,
  opts: ListNotificationsOptions = {},
): Promise<ListNotificationsResult> {
  const limit = Math.min(opts.limit || 20, 100)
  const conditions = [eq(notifications.recipientId, recipientId)]
  if (opts.unreadOnly) conditions.push(isNull(notifications.readAt))
  if (opts.cursor) {
    const cur = parseInt(opts.cursor, 10)
    if (!isNaN(cur)) conditions.push(lt(notifications.id, cur))
  }

  // Fetch one extra row to learn hasMore without a second COUNT query.
  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const cursor = hasMore ? String(page[page.length - 1]!.id) : null
  return { data: page, cursor, hasMore }
}

/** Total unread count for the header badge — independent of any page/cursor. */
export async function countUnreadForUser(recipientId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(notifications)
    .where(and(eq(notifications.recipientId, recipientId), isNull(notifications.readAt)))
  return row?.count ?? 0
}

/**
 * Mark notifications read for exactly this recipient — ownership is enforced
 * HERE (the recipientId condition is always present), not just trusted from
 * the route, so a caller can never mark someone else's row read by guessing
 * an id.
 *
 *   ids undefined  → mark ALL of this recipient's unread notifications read.
 *   ids = []       → no-op, returns 0 without touching the DB (an explicit
 *                    empty list means "nothing", not "everything" — inArray
 *                    with the same semantics can't be relied on across drivers).
 *   ids = [1,2,3]  → mark exactly those (already-read ids are silently
 *                    unaffected, not an error).
 *
 * Returns the number of rows actually flipped from unread to read.
 */
export async function markNotificationsRead(recipientId: string, ids?: number[]): Promise<number> {
  if (ids && ids.length === 0) return 0
  const conditions = [eq(notifications.recipientId, recipientId), isNull(notifications.readAt)]
  if (ids) conditions.push(inArray(notifications.id, ids))
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(...conditions))
    .returning({ id: notifications.id })
  return rows.length
}
