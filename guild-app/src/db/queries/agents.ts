import "server-only"
import { and, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm"
import type { PgUpdateSetSource } from "drizzle-orm/pg-core"
import { db, type DbExecutor } from "@/db"
import { agents, pairingCodes, users, PENDING_AGENT_TTL_MS, type AgentStatus } from "@/db/schema"
import { generatePairingCode, PAIRING_CODE_TTL_MS } from "@/lib/agent-label"
import {
  defaultAgentRules,
  DEFAULT_FLOAT_XRD,
  FEE_RESERVE_XRD,
  MAX_CLAIMS_PER_DAY,
  MAX_TRUSTED_POSTERS,
  maxBondCeiling,
  type AgentRules,
} from "@/lib/agent-rules"

/**
 * Pairing and agent rows for Bring Your Agent (docs/design/bring-your-agent.md §3).
 *
 * THE REDEEM IS THE GATE. `redeemPairingCode` decides and records in ONE bounded
 * UPDATE (`redeemed_at IS NULL AND expires_at > now()`), inside the same
 * transaction as the `agents` INSERT — so two agents racing one code get one
 * 200 and one refusal, and an agent that already has a row cannot consume a
 * code (a conflicting INSERT rolls the whole transaction back, code included).
 * SELECT-then-UPDATE would reopen the check-then-act race the x402 ledger
 * closed (src/db/queries/x402.ts); this file keeps that idiom.
 *
 * FAILS CLOSED. A thrown DB error is "not paired"; nothing here falls back to
 * an in-memory guess.
 */

export type AgentRow = typeof agents.$inferSelect
export type PairingCodeRow = typeof pairingCodes.$inferSelect

export interface IssuedPairingCode {
  code: string
  expiresAt: Date
}

/**
 * Mint a code for `ownerId`. The PK collision on a 40-bit random code is
 * ~1e-12 per try; retried a few times and then surfaced rather than looped.
 */
export async function issuePairingCode(
  args: { ownerId: string; label: string; labelNorm: string; ttlMs?: number },
  executor: DbExecutor = db,
): Promise<IssuedPairingCode> {
  const ttl = args.ttlMs ?? PAIRING_CODE_TTL_MS
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generatePairingCode()
    const expiresAt = new Date(Date.now() + ttl)
    const inserted = await executor
      .insert(pairingCodes)
      .values({ code, ownerId: args.ownerId, label: args.label, labelNorm: args.labelNorm, expiresAt })
      .onConflictDoNothing()
      .returning({ code: pairingCodes.code })
    if (inserted.length > 0) return { code, expiresAt }
  }
  throw new Error("could not mint a unique pairing code after 3 tries")
}

export type RedeemOutcome =
  | { outcome: "paired"; agent: AgentRow }
  /** No such code, or it was already redeemed. Indistinguishable on purpose. */
  | { outcome: "invalid" }
  | { outcome: "expired" }
  /** This agent account already has a row — one key, one owner. */
  | { outcome: "already_paired"; agent: AgentRow }
  /** The account that issued the code is trying to redeem it. The code stays open. */
  | { outcome: "self_pair" }

/**
 * Redeem `code` for the agent account `agentId`. The code's OWNER becomes the
 * agent's owner; the agent starts `pending` with the default float and rules.
 */
export async function redeemPairingCode(args: {
  code: string
  agentId: string
  floatXrd?: string
}): Promise<RedeemOutcome> {
  const existing = await findAgentByAgentId(args.agentId)
  if (existing) return { outcome: "already_paired", agent: existing }

  try {
    return await redeemInTransaction(args)
  } catch (err) {
    // The pre-check above is not atomic with the INSERT: the same agent can
    // redeem two DIFFERENT codes at once, both pass it, and the loser's INSERT
    // meets agents_agent_id_unique. The loser's transaction has rolled back —
    // its code is still open for its owner — and the caller is told the truth
    // the kit already handles, rather than a raw 500.
    if (err instanceof SelfPair) return { outcome: "self_pair" }
    if (!(err instanceof AgentRowRaced)) throw err
    const winner = await findAgentByAgentId(args.agentId)
    if (!winner) throw new Error("agent row raced but is not readable after the race")
    return { outcome: "already_paired", agent: winner }
  }
}

/** Thrown inside the redeem transaction to roll it back — code redemption included. */
class AgentRowRaced extends Error {}
class SelfPair extends Error {}

async function redeemInTransaction(args: { code: string; agentId: string; floatXrd?: string }): Promise<RedeemOutcome> {
  return db.transaction(async (tx) => {
    const now = new Date()
    const [redeemed] = await tx
      .update(pairingCodes)
      .set({ redeemedAt: now, redeemedBy: args.agentId })
      .where(
        and(
          eq(pairingCodes.code, args.code),
          isNull(pairingCodes.redeemedAt),
          gt(pairingCodes.expiresAt, now),
        ),
      )
      .returning()
    if (!redeemed) {
      // Classify for the person, not for the caller's benefit: an unknown code
      // and a used code read the same, an expired one says so.
      const [row] = await tx
        .select({ expiresAt: pairingCodes.expiresAt, redeemedAt: pairingCodes.redeemedAt })
        .from(pairingCodes)
        .where(eq(pairingCodes.code, args.code))
        .limit(1)
      if (row && row.redeemedAt === null && row.expiresAt <= now) return { outcome: "expired" }
      return { outcome: "invalid" }
    }
    if (redeemed.ownerId === args.agentId) {
      // Reachable: one account can issue a code and then paste the one-liner
      // with the same key (e.g. an agent pointed at the owner's own wallet
      // key). The schema's CHECK would refuse the INSERT anyway; roll the
      // redemption back so the code stays usable by a real agent, and say why.
      throw new SelfPair()
    }
    const floatXrd = args.floatXrd ?? DEFAULT_FLOAT_XRD
    const [agent] = await tx
      .insert(agents)
      .values({
        ownerId: redeemed.ownerId,
        agentId: args.agentId,
        label: redeemed.label,
        labelNorm: redeemed.labelNorm,
        status: "pending",
        floatXrd,
        rules: defaultAgentRules(floatXrd),
      })
      .onConflictDoNothing({ target: agents.agentId })
      .returning()
    if (!agent) throw new AgentRowRaced()
    return { outcome: "paired", agent }
  })
}

/**
 * The agent's own row, if any — a plain read. Whether a stale pending row is
 * dead is NOT decided here: that needs the chain (a funding tx can land at hour
 * 23), so it lives in src/lib/agent-lifecycle.ts `loadAgentForSession`, which
 * every agent-facing route calls instead of this.
 */
export async function findAgentByAgentId(agentId: string): Promise<AgentRow | null> {
  const [row] = await db.select().from(agents).where(eq(agents.agentId, agentId)).limit(1)
  return row ?? null
}

export async function findAgentById(id: number): Promise<AgentRow | null> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1)
  return row ?? null
}

export async function listAgentsForOwner(ownerId: string): Promise<AgentRow[]> {
  return db.select().from(agents).where(eq(agents.ownerId, ownerId)).orderBy(desc(agents.createdAt))
}

/**
 * A row that still holds its name: active or suspended (the badge is minted, or
 * about to be), or pending and younger than PENDING_AGENT_TTL_MS. A pending row
 * past its TTL is dead even before the lazy delete reaches it, so it must not
 * block anyone from the name.
 */
function holdsItsName(now: Date) {
  return or(
    inArray(agents.status, ["active", "suspended"]),
    and(eq(agents.status, "pending"), gt(agents.createdAt, new Date(now.getTime() - PENDING_AGENT_TTL_MS))),
  )
}

/** Does this owner already have a live agent under this normalised name? */
export async function ownerHasAgentNamed(ownerId: string, labelNorm: string, now: Date = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.labelNorm, labelNorm), holdsItsName(now)))
    .limit(1)
  return Boolean(row)
}

/**
 * Is this normalised name spoken for by ANOTHER owner — a live agent row, or a
 * code still open? Advisory, not a guarantee: `public_mint` is permissionless,
 * so anyone can take the name on-chain at any moment and the chain is the only
 * arbiter (the manifest route re-checks it right before the wallet opens). This
 * turns the common collision — two people picking the same name the same day —
 * into a refusal at the first step instead of a failed approval at the last.
 * An owner's OWN open codes never block them: re-issuing after a code lapses is
 * the normal retry.
 */
export async function labelHeldByAnotherOwner(ownerId: string, labelNorm: string, now: Date = new Date()): Promise<boolean> {
  const [agentRow] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(ne(agents.ownerId, ownerId), eq(agents.labelNorm, labelNorm), holdsItsName(now)))
    .limit(1)
  if (agentRow) return true
  const [codeRow] = await db
    .select({ code: pairingCodes.code })
    .from(pairingCodes)
    .where(
      and(
        ne(pairingCodes.ownerId, ownerId),
        eq(pairingCodes.labelNorm, labelNorm),
        isNull(pairingCodes.redeemedAt),
        gt(pairingCodes.expiresAt, now),
      ),
    )
    .limit(1)
  return Boolean(codeRow)
}

/** Heartbeat from the loop: when it was last seen and what its last cycle did. */
export async function recordHeartbeat(agentId: string, cycle: Record<string, unknown>): Promise<boolean> {
  const rows = await db
    .update(agents)
    .set({ lastSeenAt: new Date(), lastCycle: cycle })
    .where(eq(agents.agentId, agentId))
    .returning({ id: agents.id })
  return rows.length > 0
}

/** Codes an owner issued that are still redeemable — for the card's "waiting for your agent" state. */
/** One code, only if this owner issued it (the owner's "was it used yet?" — never an oracle for anyone else's). */
export async function findOwnedPairingCode(code: string, ownerId: string): Promise<PairingCodeRow | null> {
  const [row] = await db
    .select()
    .from(pairingCodes)
    .where(and(eq(pairingCodes.code, code), eq(pairingCodes.ownerId, ownerId)))
    .limit(1)
  return row ?? null
}

export async function listOpenCodesForOwner(ownerId: string, now: Date = new Date()): Promise<PairingCodeRow[]> {
  return db
    .select()
    .from(pairingCodes)
    .where(and(eq(pairingCodes.ownerId, ownerId), isNull(pairingCodes.redeemedAt), gt(pairingCodes.expiresAt, now)))
    .orderBy(desc(pairingCodes.createdAt))
}

/** The GET /agents/me wire shape — what packages/agent-client's parseAgentMe validates. */
export function toAgentMe(row: AgentRow): {
  label: string
  status: AgentStatus
  ownerAccount: string
  floatXrd: string
  badgeId: string | null
  rules: AgentRules
} {
  return {
    label: row.label,
    status: row.status,
    ownerAccount: row.ownerId,
    floatXrd: trimDecimal(row.floatXrd),
    badgeId: row.badgeId,
    rules: row.rules,
  }
}

/**
 * Which owner action each status admits (design §3.2, §3.7). ONE table: the
 * SQL writes below bound themselves by it, and every card carries it as
 * `actions`, so the owner's page offers a control because the server said so —
 * never because the page re-derived the rule. `edit` is rules and float;
 * `start` is leaving practice mode (rules.dryRun → false), which waits for
 * funding: a pending agent stays in practice until it is active, so its owner
 * sees it practise before it may sign (design §1a, §3.5). `rename` also needs
 * the chain and the 24 h funding hold, which only the PATCH itself can answer
 * — `actions.rename` says just that the state allows one. The owner's page still submits and shows whatever the server answers:
 * a card can be a poll behind.
 */
export const OWNER_ACTION_STATES = {
  rename: ["pending"],
  edit: ["pending", "active", "suspended"],
  start: ["active", "suspended"],
  suspend: ["active"],
  resume: ["suspended"],
  retire: ["pending", "active", "suspended"],
} as const satisfies Record<string, readonly AgentStatus[]>

export type OwnerAction = keyof typeof OWNER_ACTION_STATES

export function ownerActions(status: AgentStatus): Record<OwnerAction, boolean> {
  const allows = (action: OwnerAction) => (OWNER_ACTION_STATES[action] as readonly AgentStatus[]).includes(status)
  return {
    rename: allows("rename"),
    edit: allows("edit"),
    start: allows("start"),
    suspend: allows("suspend"),
    resume: allows("resume"),
    retire: allows("retire"),
  }
}

/** SQL bound for an owner action: the row's status is one the table admits. */
function statusAllows(action: OwnerAction) {
  return inArray(agents.status, [...OWNER_ACTION_STATES[action]])
}

/** The owner's card for one agent — GET /agents/mine and every owner action answer with this shape. */
export function toAgentCard(a: AgentRow) {
  return {
    id: a.id,
    label: a.label,
    labelNorm: a.labelNorm,
    agentAccount: a.agentId,
    status: a.status,
    floatXrd: trimDecimal(a.floatXrd),
    badgeId: a.badgeId,
    pairTx: a.pairTx,
    rules: a.rules,
    lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
    lastCycle: a.lastCycle ?? null,
    createdAt: a.createdAt.toISOString(),
    activatedAt: a.activatedAt?.toISOString() ?? null,
    suspendedAt: a.suspendedAt?.toISOString() ?? null,
    retiredAt: a.retiredAt?.toISOString() ?? null,
    // When this app last handed out the funding transaction (null: never, or
    // since a rename). The owner's page uses it to warn that a transaction
    // signed on another device may still be landing (A2.3).
    manifestIssuedAt: a.manifestIssuedAt?.toISOString() ?? null,
    actions: ownerActions(a.status),
    limits: cardLimits(trimDecimal(a.floatXrd)),
  }
}

/**
 * The bounds the PATCH enforces on an agent's rules, sent on its card so the
 * rules form can state them without knowing the rule (maxBondXrd ≤ float −
 * reserve). The form still submits and shows the server's answer.
 */
export function cardLimits(floatXrd: string) {
  return {
    maxBondXrd: maxBondCeiling(floatXrd),
    feeReserveXrd: String(FEE_RESERVE_XRD),
    maxClaimsPerDay: MAX_CLAIMS_PER_DAY,
    maxTrustedPosters: MAX_TRUSTED_POSTERS,
  }
}

/** numeric(38,18) comes back as "200.000000000000000000"; the wire carries "200". */
export function trimDecimal(value: string): string {
  if (!value.includes(".")) return value
  return value.replace(/0+$/, "").replace(/\.$/, "")
}

// ── A1b: funding, rules, lifecycle (docs/design/bring-your-agent.md §3.2, §3.7) ──

/** A pending row past PENDING_AGENT_TTL_MS: dead unless the chain says it was funded. */
export function isStalePending(row: Pick<AgentRow, "status" | "createdAt">, now: Date = new Date()): boolean {
  return row.status === "pending" && row.createdAt.getTime() + PENDING_AGENT_TTL_MS <= now.getTime()
}

/**
 * Delete ONE stale pending row — the caller has already asked the chain and
 * found no funding. Bounded on status and age, so a row activated in between
 * survives; returns whether anything was deleted.
 */
export async function deleteStalePendingAgent(id: number, now: Date = new Date()): Promise<boolean> {
  const cutoff = new Date(now.getTime() - PENDING_AGENT_TTL_MS)
  const deleted = await db
    .delete(agents)
    .where(
      and(
        eq(agents.id, id),
        eq(agents.status, "pending"),
        lte(agents.createdAt, cutoff),
        // A funding tx handed out within the last PENDING_AGENT_TTL_MS may still be
        // in flight — the chain reads "not minted" until it commits. Never here.
        or(isNull(agents.manifestIssuedAt), lte(agents.manifestIssuedAt, cutoff)),
      ),
    )
    .returning({ id: agents.id })
  return deleted.length > 0
}

/** Was this row's funding tx handed out recently enough that it may still land? */
export function manifestMayStillLand(row: Pick<AgentRow, "manifestIssuedAt">, now: Date = new Date()): boolean {
  return row.manifestIssuedAt !== null && row.manifestIssuedAt.getTime() + PENDING_AGENT_TTL_MS > now.getTime()
}

/**
 * pending → active, once the chain shows the float and the badge reached the
 * agent. Idempotent: an already-active row with the same badge is returned
 * as-is (a double click, or the owner's page and the agent's read racing).
 * null when the row is not this owner's, or is in any other state.
 */
export async function activateAgent(args: {
  id: number
  ownerId: string
  badgeId: string
  pairTx: string | null
  now?: Date
}): Promise<AgentRow | null> {
  const now = args.now ?? new Date()
  const [row] = await db
    .update(agents)
    .set({ status: "active", activatedAt: now, badgeId: args.badgeId, pairTx: args.pairTx })
    .where(and(eq(agents.id, args.id), eq(agents.ownerId, args.ownerId), eq(agents.status, "pending")))
    .returning()
  if (row) return row
  const current = await findAgentById(args.id)
  if (current && current.ownerId === args.ownerId && current.status === "active" && current.badgeId === args.badgeId) {
    return current
  }
  return null
}

/**
 * Record that the owner has been handed this agent's funding transaction. The
 * name is frozen from here (see agents.manifestIssuedAt). Bounded to pending:
 * nothing else can be funded.
 */
export async function markManifestIssued(
  id: number,
  ownerId: string,
  labelNorm: string,
  now: Date = new Date(),
): Promise<boolean> {
  // Bounded on the NAME the manifest embeds: if a rename committed since the
  // caller read the row, nothing is stamped and the caller must not hand out a
  // manifest for a name the row no longer has.
  const rows = await db
    .update(agents)
    .set({ manifestIssuedAt: now })
    .where(and(eq(agents.id, id), eq(agents.ownerId, ownerId), eq(agents.status, "pending"), eq(agents.labelNorm, labelNorm)))
    .returning({ id: agents.id })
  return rows.length > 0
}

/** The owner's row, or null — an id that is someone else's reads exactly like one that does not exist. */
export async function findOwnedAgent(id: number, ownerId: string): Promise<AgentRow | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.ownerId, ownerId)))
    .limit(1)
  return row ?? null
}

/**
 * Apply an owner's edit in ONE write. A rename is allowed only while the agent
 * is pending (before funding the name is just a row; after, it is a minted
 * badge), so a request carrying a label is bounded to `pending`; anything else
 * to any live state. The route validated every field. null = the row is not
 * this owner's, or not in a state that allows this edit.
 */
export async function updateAgentSettings(args: {
  id: number
  ownerId: string
  /**
   * A rename. `from` is the name the caller checked against; the write lands
   * only if the row still has it. `oldNameUnusable`: the caller proved on-chain
   * that `from` is minted to another account, so no funding tx for it can ever
   * land — only then may a rename go through while a manifest may still land.
   * Otherwise the write also requires that no manifest was handed out within
   * PENDING_AGENT_TTL_MS of `now` (the bound deleteStalePendingAgent and
   * manifestMayStillLand use), so a manifest issued between the caller's read
   * and this write wins, and the rename is refused (null). A NAME change
   * clears `manifest_issued_at`: the new name has never had a funding tx.
   */
  label?: { label: string; labelNorm: string; from: string; oldNameUnusable: boolean }
  rules?: AgentRules
  /**
   * The rules the caller's edit was based on. When given, the write lands only
   * if the row still holds exactly these (jsonb equality — key order does not
   * matter, poster order does), so an edit from a page a poll behind — another
   * tab, another device — can never silently restore rules the owner has
   * since changed (e.g. re-add a poster just removed).
   */
  baseRules?: AgentRules
  /**
   * Practice mode ALONE: sets rules.dryRun inside the stored document
   * (jsonb_set), leaving every other rule as the row has it — so Pause never
   * writes back a stale copy of the rest. Never together with `rules`.
   */
  dryRun?: boolean
  floatXrd?: string
  now?: Date
}): Promise<AgentRow | null> {
  const set: PgUpdateSetSource<typeof agents> = {}
  const conds = [eq(agents.id, args.id), eq(agents.ownerId, args.ownerId)]
  if (args.label) {
    set.label = args.label.label
    set.labelNorm = args.label.labelNorm
    conds.push(statusAllows("rename"), eq(agents.labelNorm, args.label.from))
    if (args.label.labelNorm !== args.label.from) {
      set.manifestIssuedAt = null
      if (!args.label.oldNameUnusable) {
        const cutoff = new Date((args.now ?? new Date()).getTime() - PENDING_AGENT_TTL_MS)
        conds.push(or(isNull(agents.manifestIssuedAt), lte(agents.manifestIssuedAt, cutoff))!)
      }
    }
  } else {
    conds.push(statusAllows("edit"))
  }
  if (args.rules) set.rules = args.rules
  else if (args.dryRun !== undefined) set.rules = sql`jsonb_set(${agents.rules}, '{dryRun}', ${JSON.stringify(args.dryRun)}::jsonb)`
  if (args.baseRules) conds.push(sql`${agents.rules} = ${JSON.stringify(args.baseRules)}::jsonb`)
  // Leaving practice mode waits for funding — however the write says it.
  if (args.dryRun === false || args.rules?.dryRun === false) conds.push(statusAllows("start"))
  if (args.floatXrd !== undefined) set.floatXrd = args.floatXrd
  if (Object.keys(set).length === 0) return findOwnedAgent(args.id, args.ownerId)
  const [row] = await db
    .update(agents)
    .set(set)
    .where(and(...conds))
    .returning()
  return row ?? null
}

/**
 * The reasons this file writes to `users.suspended_reason`. Resume clears ONLY
 * its own: an operator suspension (scripts/suspend-account.mjs, any other
 * reason) is never lifted by an owner, and never overwritten by one.
 */
export const AGENT_SUSPENDED_BY_OWNER = "agent:suspended-by-owner"
export const AGENT_RETIRED_BY_OWNER = "agent:retired-by-owner"

/**
 * Lock the agent's own account out of the site/API (withAuth refuses a
 * suspended user on the next request, so the loop stops within one tick).
 * Upserts: an agent whose users row is missing still ends up locked. An
 * existing suspension — operator's or an earlier owner action — is kept as is.
 */
async function lockAgentAccount(tx: DbExecutor, agentId: string, reason: string, now: Date) {
  await tx
    .insert(users)
    .values({ id: agentId, isAgent: true, suspendedAt: now, suspendedReason: reason })
    .onConflictDoUpdate({
      target: users.id,
      set: { suspendedAt: now, suspendedReason: reason },
      setWhere: isNull(users.suspendedAt),
    })
}

export type LifecycleResult =
  | { ok: true; agent: AgentRow }
  | { ok: false; code: "NOT_FOUND" | "WRONG_STATE"; status: AgentStatus | null }

/** active → suspended, and the agent's account locked. */
export async function suspendAgent(id: number, ownerId: string, now: Date = new Date()): Promise<LifecycleResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(agents)
      .set({ status: "suspended", suspendedAt: now })
      .where(and(eq(agents.id, id), eq(agents.ownerId, ownerId), statusAllows("suspend")))
      .returning()
    if (!row) return classifyMiss(tx, id, ownerId)
    await lockAgentAccount(tx, row.agentId, AGENT_SUSPENDED_BY_OWNER, now)
    return { ok: true, agent: row }
  })
}

/** suspended → active, and ONLY the owner's own lock lifted. */
export async function resumeAgent(id: number, ownerId: string): Promise<LifecycleResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(agents)
      .set({ status: "active", suspendedAt: null })
      .where(and(eq(agents.id, id), eq(agents.ownerId, ownerId), statusAllows("resume")))
      .returning()
    if (!row) return classifyMiss(tx, id, ownerId)
    await tx
      .update(users)
      .set({ suspendedAt: null, suspendedReason: null })
      .where(and(eq(users.id, row.agentId), eq(users.suspendedReason, AGENT_SUSPENDED_BY_OWNER)))
    return { ok: true, agent: row }
  })
}

/**
 * Retire — for good, and the row is always KEPT. A pending agent may already
 * hold its float and badge (a funding tx that landed before the owner's page
 * confirmed it, or one still in flight when the owner gave up): deleting its
 * row would leave that money in an account nothing in the app links to its
 * owner. So pending, active and suspended all become `retired` with the
 * account locked; `activated_at` stays as it was (null if never funded). Its
 * badge, if any, stays in its account forever (Member badges cannot be
 * recalled). Pairing again means a NEW key (`guild-agent join --new-key`, which
 * moves the old key aside once its account is empty) —
 * one key, one owner, for life (design §3.1).
 */
export async function retireAgent(id: number, ownerId: string, now: Date = new Date()): Promise<LifecycleResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(agents)
      .set({ status: "retired", retiredAt: now })
      .where(and(eq(agents.id, id), eq(agents.ownerId, ownerId), statusAllows("retire")))
      .returning()
    if (!row) return classifyMiss(tx, id, ownerId)
    await lockAgentAccount(tx, row.agentId, AGENT_RETIRED_BY_OWNER, now)
    return { ok: true, agent: row }
  })
}

async function classifyMiss(tx: DbExecutor, id: number, ownerId: string): Promise<LifecycleResult> {
  const [row] = await tx
    .select({ status: agents.status })
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.ownerId, ownerId)))
    .limit(1)
  return row ? { ok: false, code: "WRONG_STATE", status: row.status } : { ok: false, code: "NOT_FOUND", status: null }
}

