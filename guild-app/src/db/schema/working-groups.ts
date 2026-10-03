import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core"
import { users } from "./users"

// Working groups — Model A, "interest channels" (docs/design/working-groups-model-a.md,
// ruled 2026-08-14). A working group IS a joinable task category: discovery and
// routing, never governance. Deliberately NOT the Colony/Aragon shape — nothing
// here binds a group to a vote, a treasury, a lead or a budget, and the
// vestigial Model-B version of that (leads/charters/sunset) lives only in the
// retiring bot and is not being brought forward.
//
// The whole feature is ONE join row carrying a notification level. That single
// column drives both feed visibility and notification, which is why there is no
// separate subscriptions table, no per-user settings blob, and no notification
// preferences model: adding any of those would be modelling the same fact twice.

export const workingGroups = pgTable(
  "working_groups",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    // URL identity (/groups/[slug]). Admin-set, never derived from user input —
    // group creation is admin-only by design (see isActive below).
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").default("").notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    // Retire a group WITHOUT deleting it. Over-fragmentation is the #1
    // documented failure of this pattern, and the counter-measure is
    // soft-archiving dead groups — but a hard delete would cascade
    // user_working_groups rows away and orphan every task that routed through
    // it. `isActive=false` keeps the history and the FK intact.
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("working_groups_slug_idx").on(table.slug)]
)

export const userWorkingGroups = pgTable(
  "user_working_groups",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workingGroupId: integer("working_group_id")
      .notNull()
      .references(() => workingGroups.id, { onDelete: "cascade" }),
    // Discourse's notification_level, trimmed to four. TYPE-ONLY text enum (no
    // pgEnum) — the house convention, see tasks.status: this codebase avoids
    // enum migrations.
    //   muted    = hide this group's tasks from my feed, never notify
    //              (Stack Overflow's "ignored" — a negative filter, which is why
    //              it lives on the same column rather than in a second table)
    //   normal   = joined: tasks show in my filtered feed, no push (join default)
    //   tracking = feed + in-app unread badge, no push
    //   watching = feed + push on every new task in the group
    level: text("level", { enum: ["muted", "normal", "tracking", "watching"] })
      .default("normal")
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // One row per user↔group. The composite PK is the membership invariant:
    // a double-join is unrepresentable rather than merely rejected.
    primaryKey({ columns: [table.userId, table.workingGroupId] }),
    // Fanout direction: who is watching this group (push on new task).
    index("uwg_group_idx").on(table.workingGroupId),
    // Feed direction: my joined groups. The PK's leading column already covers
    // user-prefixed lookups, but this index is what the feed join actually
    // plans against when filtering by level.
    index("uwg_user_idx").on(table.userId),
  ]
)

/** The four notification levels, in escalating order. Shared by the API
 *  validator and the UI so a fifth level cannot be added in one place only. */
export const NOTIFICATION_LEVELS = ["muted", "normal", "tracking", "watching"] as const
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number]

// The propose-queue (Model A §5c / build step 6): "never auto-create from user
// input" is the ruling that keeps the catalog from fragmenting, so a proposal
// is data for an admin to curate, never a write path to workingGroups itself.
// There is no admin-role column or admin-gated route anywhere in this app
// (verified: no isAdmin/ADMIN_ADDRESS exists in src/), and inventing one just
// for this would be the same "fake gate" mistake src/lib/agent-lane.ts's
// honesty note already warns against — a permission check with no real
// authority behind it is worse than none, because it *looks* enforced. So
// curation of this queue is an operator script
// (scripts/review-group-proposals.mjs), the same shape as the existing
// scripts/seed-working-groups.mjs it extends, run by hand off-app. The API
// surface here is only: any signed-in user may propose, and may see the
// status of their OWN proposals (mirrors userWorkingGroups' self-only stance
// below).
export const workingGroupProposals = pgTable(
  "working_group_proposals",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    proposedBy: text("proposed_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").default("").notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected"] })
      .default("pending")
      .notNull(),
    // Set only on approval — the group the proposal became. Lets a proposer's
    // "my proposals" view link straight to the live group.
    resultingGroupId: integer("resulting_group_id").references(() => workingGroups.id),
    // Operator's reason, mainly for a rejection ("duplicate of #frontend").
    reviewNote: text("review_note"),
    // Free-text operator identity, NOT an FK to users(id): the reviewer is
    // whoever ran the script, which need not be a Guild user row at all, and
    // an FK here would make an optional operational label a write hazard.
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("wgp_status_idx").on(table.status),
    index("wgp_proposer_idx").on(table.proposedBy),
  ],
)

export const PROPOSAL_STATUSES = ["pending", "approved", "rejected"] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]
