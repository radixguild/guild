import { sql } from "drizzle-orm"
import { pgTable, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core"
import { users } from "./users"
import { tasks } from "./tasks"

// In-app notification substrate (#382 — "no push notification is wired", see
// src/app/api/v1/tasks/route.ts's create-route comment). A poster currently
// learns their task was claimed only by revisiting the page; a worker learns a
// revision was requested only by luck. This table is the record a notification
// exists at all; src/lib/notifications.ts is the emission/adapter layer that
// writes it and documents the seam a future Telegram/email channel plugs into.
//
// Not to be confused with NOTIFICATION_LEVELS in ./working-groups.ts — that is
// a per-member SUBSCRIPTION preference (muted/normal/tracking/watching) for a
// working group's feed, not a notification record. Unrelated concepts that
// happen to share the English word.
//
// `recipientId` is a Radix account address — the SAME identity every other
// table uses (users.id, tasks.creatorId/assigneeId), never a new identity
// concept. `event` is a TYPE-ONLY text enum (no DB CHECK constraint), the same
// idiom as tasks.status and submissions.status: adding a new event kind later
// is a pure application change, not a migration. `taskId` is nullable — every
// event this ships with references a task, but the table is not modelled AS
// "task notifications", so a future non-task event doesn't force a schema
// change. `payload` is a small JSON blob for whatever the notification's copy
// needs to render (title, actor, submission id, review verdict) without a
// join back to the source row at read time. `readAt` NULL = unread; the
// mark-read endpoint only ever sets it, mirroring the one-way status fields
// elsewhere (submissions.approvedAt/declinedAt) — there is no "mark unread".
export const NOTIFICATION_EVENTS = [
  "task_claimed",
  "work_submitted",
  "submission_reviewed",
  "dispute_raised",
] as const
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number]

// Deliberately loose (no discriminated union keyed on `event`): the column is
// one small jsonb blob shared by every event kind, and a future event type
// should be able to add a field without a migration. Consumers read what they
// expect and ignore the rest.
export interface NotificationPayload {
  taskTitle?: string
  actorId?: string // whoever performed the action this notification is about
  submissionId?: number
  reviewStatus?: "approved" | "rejected" | "revision_requested"
  reviewNote?: string | null
}

export const notifications = pgTable(
  "notifications",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    recipientId: text("recipient_id")
      .references(() => users.id)
      .notNull(),
    event: text("event", { enum: NOTIFICATION_EVENTS }).notNull(),
    taskId: integer("task_id").references(() => tasks.id),
    payload: jsonb("payload").$type<NotificationPayload>(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // The inbox's one real read query: this recipient's rows, newest first.
    // id DESC is a monotonic proxy for created_at DESC (single writer per
    // row, defaultNow()) and lets the cursor key off an indexed integer
    // instead of a timestamp — same reasoning as tasks' id-tiebreak keyset.
    index("notifications_recipient_id_idx").on(table.recipientId, table.id),
    // The header badge's unread-count query — partial so it never scans read
    // rows. Same partial-index idiom as tasks_onchain_component_unique.
    index("notifications_recipient_unread_idx")
      .on(table.recipientId)
      .where(sql`${table.readAt} is null`),
    index("notifications_task_idx").on(table.taskId),
  ],
)
