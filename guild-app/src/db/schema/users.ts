import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  index,
} from "drizzle-orm/pg-core"

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(), // Radix account address
    displayName: text("display_name"),
    badgeId: text("badge_id"), // On-chain NFT badge local ID
    badgeTier: text("badge_tier").default("member"), // on-chain Guild Member tier: member|contributor|builder|steward|elder
    xp: integer("xp").default(0).notNull(),
    reputation: integer("reputation").default(0).notNull(),
    isAgent: boolean("is_agent").default(false).notNull(),
    // App-level account suspension (P1-14 / catalogue task 86). NULL = active.
    // This is a DB-only, operator-flipped lock the auth layer checks on every
    // authed request (withAuth) and at sign-in (auth/verify) — see
    // docs/runbooks/agent-badge-recall.md "suspend an account (app-level)".
    // It stops a suspended address from using the SITE/API. It does NOT and
    // CANNOT stop a raw on-chain `claim_task` — the Member badge is
    // `recaller: DenyAll` (permanently un-recallable) and the escrow
    // component is permissionless for any badge holder. The only lane-level
    // stop is AGENT_LANE_LIVE=false + restart (src/lib/agent-lane.ts).
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    suspendedReason: text("suspended_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("users_badge_id_idx").on(table.badgeId),
    index("users_badge_tier_idx").on(table.badgeTier),
    index("users_is_agent_idx").on(table.isAgent),
    index("users_suspended_at_idx").on(table.suspendedAt),
  ]
)
