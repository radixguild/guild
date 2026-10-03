import { pgTable, text, integer, boolean, timestamp } from "drizzle-orm/pg-core"

// One row per operator-alert key (src/lib/alert-policy.ts). This is what makes
// alerts EDGE-triggered across process restarts: without it, every pm2 restart
// during a multi-day incident re-raised the same page, and the request-path
// throttle (a per-process Map) forgot everything it knew.
//
// `version` is the optimistic-concurrency counter: a decision is persisted
// only via UPDATE … WHERE version = <the version that was read>, so two
// concurrent evaluations of one key produce exactly one message. The
// successful write is the permission to send (src/lib/alert-store.ts).
//
// Deliberately NOT a log table. Rows are overwritten in place; the message
// history is in the Telegram chat, which is where the operator reads it.
export const alertState = pgTable("alert_state", {
  key: text("key").primaryKey(),
  active: boolean("active").default(false).notNull(),
  since: timestamp("since", { withTimezone: true }),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  lastClearedAt: timestamp("last_cleared_at", { withTimezone: true }),
  sentCount: integer("sent_count").default(0).notNull(),
  suppressedCount: integer("suppressed_count").default(0).notNull(),
  inhibitedBy: text("inhibited_by"),
  version: integer("version").default(0).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
})
