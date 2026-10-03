import { sql } from "drizzle-orm"
import { pgTable, text, timestamp, integer, numeric, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core"
import type { AgentRules } from "@/lib/agent-rules"

/**
 * Bring Your Agent — the first owner ↔ agent linkage in this schema
 * (docs/design/bring-your-agent.md §3.1). Until this table, `users.is_agent`
 * was display-only and nothing tied an agent account to a person.
 *
 * THE CODE IS BORN BOUND TO ITS OWNER. `pairing_codes.owner_id` is set when the
 * signed-in owner asks for a code; the agent redeems it with its OWN session.
 * So a guessed code can only attach a stranger's agent to *your* card as an
 * unfunded pending row — it can never make a stranger the owner of *your*
 * agent (the direction the first draft of the design got backwards; §3.3).
 *
 * THE REDEEM IS THE GATE. Redemption is one bounded UPDATE (`redeemed_at IS
 * NULL AND expires_at > now()`, first writer wins) inside the same transaction
 * as the `agents` INSERT — the x402 idiom (src/db/queries/x402.ts). No
 * `attempts` counter: the code is the PRIMARY KEY, so a wrong guess touches no
 * row; brute force is bounded by the per-IP and per-account limiters on
 * POST /agents/pair and by the 32^8 space × 15-minute life.
 */
export const pairingCodes = pgTable(
  "pairing_codes",
  {
    /** 8 chars, Crockford base32, stored WITHOUT the display dash. */
    code: text("code").primaryKey(),
    /** The person who asked for it — the only account that may become this agent's owner. */
    ownerId: text("owner_id").notNull(),
    /** As typed (ASCII, ≤ 64) and as the chain will mint it (lower-cased). */
    label: text("label").notNull(),
    labelNorm: text("label_norm").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    /** The agent account that redeemed it. */
    redeemedBy: text("redeemed_by"),
  },
  (t) => [
    // The sweep of stale codes scans by expiry; without this it is a seq scan.
    index("pairing_codes_expires_at_idx").on(t.expiresAt),
    index("pairing_codes_owner_id_idx").on(t.ownerId),
    check(
      "pairing_codes_redeemed_pair_check",
      sql`(${t.redeemedAt} IS NULL) = (${t.redeemedBy} IS NULL)`,
    ),
  ],
)

export const AGENT_STATUSES = ["pending", "active", "suspended", "retired"] as const
export type AgentStatus = (typeof AGENT_STATUSES)[number]

/** How long an unfunded pairing lives before the agent account is free to pair again (§3.1). */
export const PENDING_AGENT_TTL_MS = 24 * 60 * 60 * 1000

export const agents = pgTable(
  "agents",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    /** The owner's wallet account (users.id). */
    ownerId: text("owner_id").notNull(),
    /** The agent's own account (users.id) — one key, one owner, for life. */
    agentId: text("agent_id").notNull(),
    label: text("label").notNull(),
    labelNorm: text("label_norm").notNull(),
    // Text enum = TYPE-ONLY (no DB constraint / migration) — the house
    // convention for a status that may grow (tasks.ts, funding-pools.ts).
    status: text("status", { enum: AGENT_STATUSES }).default("pending").notNull(),
    /**
     * What the owner funds / tops up to (decimal XRD). Set to the default at
     * pairing — NOT NULL so GET /agents/me always carries a number the kit's
     * parser accepts — and to the actual amount at funding. Same precision as
     * every money column (tasks.reward_xrd), held in step deliberately.
     */
    floatXrd: numeric("float_xrd", { precision: 38, scale: 18 }).notNull(),
    rules: jsonb("rules").$type<AgentRules>().notNull(),
    /** Intent hash of the owner's funding transaction (badge + float). */
    pairTx: text("pair_tx"),
    /** `<guild_member_…>` once the funding tx is confirmed. */
    badgeId: text("badge_id"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastCycle: jsonb("last_cycle").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    /**
     * When the owner last asked for this agent's funding transaction
     * (POST /agents/{id}/manifest). From then on a signed transaction may still
     * land, so the NAME is frozen (a rename would make the landed badge
     * unrecognisable) — unless the chain shows that name was taken by someone
     * else, which proves the old transaction can never succeed.
     */
    manifestIssuedAt: timestamp("manifest_issued_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("agents_agent_id_unique").on(t.agentId),
    index("agents_owner_id_idx").on(t.ownerId),
    index("agents_status_created_idx").on(t.status, t.createdAt),
    check("agents_owner_is_not_agent_check", sql`${t.ownerId} <> ${t.agentId}`),
    // An active or suspended row carries its activation time; a pending one does
    // not; a retired one may be either (an agent retired before it was ever
    // funded keeps its row — retire never deletes, see retireAgent).
    check(
      "agents_activated_at_check",
      sql`(${t.status} = 'pending' AND ${t.activatedAt} IS NULL) OR (${t.status} IN ('active', 'suspended') AND ${t.activatedAt} IS NOT NULL) OR (${t.status} = 'retired')`,
    ),
  ],
)
