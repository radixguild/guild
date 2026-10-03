import { pgTable, text, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core"
import { users } from "./users"

// Web temperature-check votes backing /lights-on ("Who keeps the lights on?",
// src/content/lights-on.ts). Unweighted, one vote per browser: the voter is
// identified by an httpOnly `tc_voter` cookie (a random UUID, set on first
// vote), never by wallet or IP. A signed-in account additionally stamps
// user_id and signed=true, so the tally can report signed-in votes as a
// separate count — see the widget copy: "unweighted, one vote per browser;
// votes from signed-in accounts are counted separately. Not binding."
//
// One row per (check_id, voter_key): re-voting on the same check from the
// same browser REPLACES the row rather than adding a second one — that is
// the whole point of the unique index below, enforced by the upsert in
// src/db/queries/tempcheck.ts rather than trusted to application code alone.
export const tempcheckVotes = pgTable(
  "tempcheck_votes",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    checkId: text("check_id").notNull(), // one of src/content/lights-on.ts's TEMP_CHECK_IDS
    optionKey: text("option_key").notNull(), // one of that check's option keys
    voterKey: text("voter_key").notNull(), // the tc_voter cookie value (UUID) — the browser identity
    userId: text("user_id").references(() => users.id), // set only when the voter was signed in at vote time
    signed: boolean("signed").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // The re-vote-replaces invariant: a browser can vote on a given check any
    // number of times, but always accumulates into ONE row, mirroring
    // task_contributions' pool/contributor unique index.
    uniqueIndex("tempcheck_votes_check_voter_unique").on(table.checkId, table.voterKey),
    index("tempcheck_votes_check_id_idx").on(table.checkId),
  ],
)
