import {
  pgTable,
  text,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { users } from "./users"

// Optional grouping over tasks (docs/TASK-TERMS-DESIGN.md §5). Commissioner is
// an account today; projects v2 widens it to a typed reference (DAO treasury)
// per the OVERHAUL-HANDOFF target architecture, so nothing else may assume
// "commissioner = poster of every task in the project".
export const projects = pgTable(
  "projects",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    name: text("name").notNull(),
    // URL identity (/projects/[slug]) — derived from name at create, stable
    // after that even if the name is edited later.
    slug: text("slug").notNull(),
    description: text("description").default("").notNull(),
    commissionerId: text("commissioner_id")
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Added 2026-09-06 (scaled-MVP item 1). Today the ONLY write to this table
    // is createProject's insert (verified: no UPDATE path exists anywhere in
    // the repo), so the column default alone keeps it honest — but the moment
    // a project-edit path is added, that write MUST set updatedAt explicitly
    // (`.set({ ...data, updatedAt: new Date() })`, matching tasks.ts /
    // users.ts) rather than rely on this default, which only fires on INSERT.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("projects_slug_idx").on(table.slug),
    index("projects_commissioner_idx").on(table.commissionerId),
  ]
)
