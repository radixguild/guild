import {
  pgTable,
  text,
  integer,
  date,
  timestamp,
  index,
} from "drizzle-orm/pg-core"
import { users } from "./users"

// Grid-game roll state — the PostgreSQL port of the bot's SQLite `game_state`
// (bot/db.js). One row per player, keyed on the Radix address (= users.id).
//
// Two columns have no bot equivalent — `available_rolls` and `last_grant_date`:
// in the bot a roll is a side-effect of a governance action, so it needs no
// budget. The standalone REST API has no such natural gate, so it grants an
// explicit per-day roll budget and the roll endpoint decrements it atomically
// (audit HIGH-001, Class 5 parity). `total_bonus_xp` is a game score only — it
// never flows into users.xp, so the game cannot inflate badge tiers or voting
// weight (audit CRITICAL-001 risk note).
export const gameState = pgTable(
  "game_state",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id), // Radix account address
    totalRolls: integer("total_rolls").default(0).notNull(),
    totalBonusXp: integer("total_bonus_xp").default(0).notNull(),
    streakDays: integer("streak_days").default(0).notNull(),
    lastRollDate: date("last_roll_date"), // UTC calendar day of the last roll
    lastRollValue: integer("last_roll_value").default(0).notNull(),
    jackpots: integer("jackpots").default(0).notNull(),
    // Roll budget (API-only). Decremented atomically per roll; topped up once
    // per UTC day by the daily grant.
    availableRolls: integer("available_rolls").default(0).notNull(),
    lastGrantDate: date("last_grant_date"), // UTC day the budget was last granted
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Leaderboard orders by total_bonus_xp DESC.
    index("game_state_total_bonus_xp_idx").on(table.totalBonusXp),
  ],
)
