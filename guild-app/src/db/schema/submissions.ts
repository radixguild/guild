import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core"
import { users } from "./users"
import { tasks } from "./tasks"
import type { PrVerification } from "@/lib/pr-verify"
import { DECLINE_REASONS } from "@/lib/decline-reasons"

// Structured decline reasons (rejected submissions only). The enum + labels now
// live in the drizzle-free @/lib/decline-reasons so client components can import
// them without pulling this schema (and its pg-core builders) into the bundle;
// re-exported here so existing server-side importers keep working unchanged.
export { DECLINE_REASONS } from "@/lib/decline-reasons"
export type { DeclineReason } from "@/lib/decline-reasons"

export const submissions = pgTable(
  "submissions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    taskId: integer("task_id")
      .references(() => tasks.id)
      .notNull(),
    submitterId: text("submitter_id")
      .references(() => users.id)
      .notNull(),
    content: text("content").notNull(),
    // One decision per row: pending is the only reviewable state; a revision
    // loop produces a NEW pending row per attempt (the decision audit trail).
    status: text("status", {
      enum: ["pending", "approved", "rejected", "revision_requested"],
    })
      .default("pending")
      .notNull(),
    reviewerId: text("reviewer_id").references(() => users.id),
    reviewNote: text("review_note"),
    declineReason: text("decline_reason", { enum: DECLINE_REASONS }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    // GitHub verdict vs the task's committed terms (lib/pr-verify.ts). A
    // SEPARATE column on purpose: the on-chain evidence hash binds only
    // `content` (canonicalSubmissionEvidence) — verification never alters it.
    prVerification: jsonb("pr_verification").$type<PrVerification>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("submissions_task_idx").on(table.taskId),
    index("submissions_submitter_idx").on(table.submitterId),
    index("submissions_status_idx").on(table.status),
  ]
)
