import type { AgentRules } from "@/lib/agent-rules"

// The owner's view of an agent (docs/design/bring-your-agent.md §3.6). Pure:
// no React, no fetch, so every state below is unit-testable with a clock.

/** One agent as GET /api/v1/agents/mine serialises it. */
export interface AgentCardData {
  id: number
  label: string
  labelNorm: string
  agentAccount: string
  status: "pending" | "active" | "suspended" | "retired"
  floatXrd: string
  badgeId: string | null
  pairTx: string | null
  rules: AgentRules
  lastSeenAt: string | null
  lastCycle: unknown
  createdAt: string
  activatedAt: string | null
  suspendedAt: string | null
  retiredAt: string | null
  /** When the funding transaction was last handed out (absent on older responses). */
  manifestIssuedAt?: string | null
  /**
   * The owner actions the SERVER admits in this agent's state
   * (OWNER_ACTION_STATES in src/db/queries/agents.ts — the same table its SQL
   * writes are bounded by). The card offers a control only when this says so,
   * and never re-derives it from `status`.
   */
  actions: AgentActions
  /** The bounds the server enforces on this agent's rules (toAgentCard `limits`). */
  limits: AgentLimits
}

export interface AgentLimits {
  /** Decimal XRD: the float less the fee reserve. */
  maxBondXrd: string
  feeReserveXrd: string
  maxClaimsPerDay: number
  maxTrustedPosters: number
}

export interface AgentActions {
  rename: boolean
  /** Rules and float. */
  edit: boolean
  /** Leaving practice mode (Start) — admitted once the agent is funded. */
  start: boolean
  suspend: boolean
  resume: boolean
  retire: boolean
}

/**
 * The card an owner action answered with (every owner route returns
 * toAgentCard), or null when the body is not one for THIS agent — then the
 * caller re-reads the list rather than showing something it cannot vouch for.
 */
export function cardFromResponse(body: unknown, id: number): AgentCardData | null {
  const data = (body as { ok?: unknown; data?: unknown } | null)?.ok === true ? (body as { data?: unknown }).data : null
  if (!data || typeof data !== "object") return null
  const card = data as Partial<AgentCardData>
  return card.id === id &&
    typeof card.status === "string" &&
    card.actions &&
    typeof card.actions === "object" &&
    card.limits &&
    typeof card.limits === "object"
    ? (card as AgentCardData)
    : null
}

/** A code the owner issued that no agent has redeemed yet. */
export interface PendingCodeData {
  code: string
  label: string
  labelNorm: string
  expiresAt: string
  oneLiner: string
}

export type DerivedAgentStatus = "unfunded" | "expired" | "practice" | "online" | "offline" | "suspended" | "retired"

/**
 * A pending row older than this was never funded in time. Mirrors
 * PENDING_AGENT_TTL_MS in src/db/schema/agents.ts, which is server-only;
 * tests/unit/agent-status.test.ts pins the two equal.
 */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000

/**
 * "Offline after 3 missed beats" (design §2.3) at the kit loop's 60 s default
 * interval (packages/agent-client/src/worker.ts, startWorkerLoop). The agent
 * never reports its interval, so this is a fixed wall-clock threshold; if K2's
 * `run` changes the cadence, change this with it.
 */
export const OFFLINE_AFTER_MS = 3 * 60_000

export function deriveAgentStatus(a: AgentCardData, now: number = Date.now()): DerivedAgentStatus {
  switch (a.status) {
    case "retired":
      return "retired"
    case "suspended":
      return "suspended"
    case "pending":
      return Date.parse(a.createdAt) + PENDING_TTL_MS <= now ? "expired" : "unfunded"
    case "active": {
      // No check-in yet, or an unparseable one, is offline — never online by default.
      const seen = a.lastSeenAt ? Date.parse(a.lastSeenAt) : Number.NaN
      if (!(now - seen < OFFLINE_AFTER_MS)) return "offline"
      return a.rules.dryRun ? "practice" : "online"
    }
  }
}

export const STATUS_LABEL: Record<DerivedAgentStatus, string> = {
  unfunded: "Not funded",
  expired: "Pairing expired",
  practice: "Practice",
  online: "Online",
  offline: "Offline",
  suspended: "Suspended",
  retired: "Retired",
}

/** Pill colours, in the getStatusColor shape (marketplace-utils.ts). */
export const STATUS_TONE: Record<DerivedAgentStatus, string> = {
  unfunded: "bg-amber-500/10 text-amber-500",
  expired: "bg-muted text-muted-foreground",
  practice: "bg-blue-500/10 text-blue-500",
  online: "bg-green-500/10 text-green-500",
  offline: "bg-orange-500/10 text-orange-500",
  suspended: "bg-yellow-500/10 text-yellow-500",
  retired: "bg-muted text-muted-foreground",
}

/**
 * When the server lets go of an unfunded pairing: 24 h after its funding
 * transaction was last handed out (manifestMayStillLand). Until then it keeps
 * the row in case one lands and refuses to re-pair the same agent key
 * (already_paired). Null when no funding transaction was ever handed out —
 * then an expired pairing is released on the agent's next pairing attempt.
 */
export function pairingReleaseAt(manifestIssuedAtMs: number | null): number | null {
  return manifestIssuedAtMs === null || !Number.isFinite(manifestIssuedAtMs) ? null : manifestIssuedAtMs + PENDING_TTL_MS
}

function hoursUntil(at: number, now: number): string {
  const h = Math.max(1, Math.ceil((at - now) / 3_600_000))
  return `about ${h} hour${h === 1 ? "" : "s"}`
}

/** The ONE way this app tells an owner to pair again — true to the server's release rule. */
export function pairAgainLine(releaseAt: number | null, now: number): string {
  return releaseAt !== null && releaseAt > now
    ? `once the Guild releases this pairing, in ${hoursUntil(releaseAt, now)}, pair the agent again with a new code`
    : "pair the agent again with a new code"
}

/**
 * An expired pairing the server still HOLDS (releaseAt in the future). Says
 * nothing about whether anything was signed — the stamp is written before
 * the wallet opens.
 */
export function expiredHeldDetail(releaseAt: number, now: number): string {
  return `Past its 24-hour pairing window. A funding transaction was prepared for it, so the Guild holds this pairing for ${hoursUntil(releaseAt, now)} more in case one lands, and it can't be paired again before then. Check funding to see whether one landed.`
}

/** Expired, the server's hold is over, but THIS browser signed a funding transaction for it. */
export const EXPIRED_SIGNED_HERE_DETAIL =
  "Past its 24-hour pairing window. You signed a funding transaction for it from this browser — check funding to see whether it landed."

/**
 * One plain sentence per state. Nothing here promises an action this page
 * cannot take: rename, rules, start/pause, suspend, resume and retire are
 * all on the card; retiring never moves funds (§3.7). A
 * suspension blocks the Guild's API, not the chain — the agent's key can still
 * sign on-ledger (bounded by its float), so the copy says "through the Guild".
 */
export const STATUS_DETAIL: Record<DerivedAgentStatus, string> = {
  unfunded: "Checked in, not funded yet. Funding sends its float and mints its Guild badge in one wallet transaction.",
  expired: "Not funded within 24 hours of pairing. Check funding to see where it stands before you pair it again.",
  practice: "Practice mode: it reports what it would claim and signs nothing.",
  online: "Checking in. It claims only what its rules allow.",
  offline: "No recent check-in. Its machine or its loop may be stopped.",
  suspended:
    "Suspended by you: the Guild refuses its sign-in, so it can't claim or submit through the Guild. What it holds stays in its own account. Resume lifts your suspension; if its loop stopped meanwhile, start it again on its machine.",
  retired: "Retired: it can no longer sign in. Retiring moved no funds; what it holds stays in its own account.",
}
