/**
 * Ledger-derived trust tiers (docs/TASK-TERMS-DESIGN.md §4 + §4.1).
 *
 * Stats are derived from the escrow ledger + tasks + submissions at read time
 * — no new chain state, no stored score. The same record applies to humans
 * and agents (identity = account address). Tier thresholds live here as a
 * single exported config so pilot data can retune them in one place (§7 Q3).
 *
 * This module is pure on purpose: the DB aggregation lives in
 * src/db/queries/trust.ts, the UI chips consume the labels/classes below.
 */

export const TRUST_TIERS = ["new", "established", "top_rated"] as const
export type TrustTier = (typeof TRUST_TIERS)[number]

export interface TrustStats {
  /** Paid tasks as assignee — ledger-backed: the release row and the `paid`
   * status commit in one transaction (escrow-confirm core). */
  completed: number
  /** Tasks ever assigned (includes in-flight claims). */
  claimed: number
  /** Assigned tasks that ended cancelled/refunded — the bad terminal states. */
  failed: number
  /** Confirmed dispute rows raised BY this identity. */
  disputesRaised: number
  /** Confirmed dispute rows on this identity's tasks raised by the counterparty. */
  disputesAgainst: number
  /** Submissions against tasks that had a deadline. */
  deadlineSubmits: number
  /** Of those, submitted at or before the deadline. */
  onTimeSubmits: number
  /** Mean days from submission receipt to approval over approved submissions;
   * null when this identity has no approved submissions yet. */
  avgDeliveryDays: number | null
}

export const EMPTY_TRUST_STATS: TrustStats = {
  completed: 0,
  claimed: 0,
  failed: 0,
  disputesRaised: 0,
  disputesAgainst: 0,
  deadlineSubmits: 0,
  onTimeSubmits: 0,
  avgDeliveryDays: null,
}

/** Thresholds to retune with real pilot data — keep all tier math reading these. */
export const TRUST_THRESHOLDS = {
  established: { minCompleted: 5 },
  topRated: { minCompleted: 15, minOnTimeRate: 0.95 },
} as const

/** completed ÷ terminal outcomes (in-flight claims excluded); null = no record. */
export function completionRate(stats: Pick<TrustStats, "completed" | "failed">): number | null {
  const terminal = stats.completed + stats.failed
  return terminal > 0 ? stats.completed / terminal : null
}

/** on-time ÷ deadline submissions; null = never worked a deadlined task. */
export function onTimeRate(
  stats: Pick<TrustStats, "deadlineSubmits" | "onTimeSubmits">,
): number | null {
  return stats.deadlineSubmits > 0 ? stats.onTimeSubmits / stats.deadlineSubmits : null
}

type TierInput = Pick<
  TrustStats,
  "completed" | "disputesAgainst" | "deadlineSubmits" | "onTimeSubmits"
>

/**
 * Tier ladder per §4: any confirmed dispute-against pins the identity at New
 * (harsh by design until arbiters exist; retune at the re-instantiation). A
 * null on-time rate (no deadlined work yet) does not block Top Rated — absence
 * of evidence of lateness, and deadlines are an optional term.
 */
export function trustTierFor(stats: TierInput): TrustTier {
  if (stats.disputesAgainst > 0) return "new"
  const onTime = onTimeRate(stats)
  if (
    stats.completed >= TRUST_THRESHOLDS.topRated.minCompleted &&
    (onTime === null || onTime >= TRUST_THRESHOLDS.topRated.minOnTimeRate)
  ) {
    return "top_rated"
  }
  if (stats.completed >= TRUST_THRESHOLDS.established.minCompleted) return "established"
  return "new"
}

export const TRUST_TIER_LABELS: Record<TrustTier, string> = {
  new: "New",
  established: "Established",
  top_rated: "Top Rated",
}

/** Shared chip styling (profile header, claimer chip, leaderboard). */
export const TRUST_TIER_BADGE_CLASS: Record<TrustTier, string> = {
  new: "bg-muted text-muted-foreground",
  established: "bg-blue-500/10 text-blue-500",
  top_rated: "bg-amber-500/10 text-amber-500",
}

const TIER_RANK: Record<TrustTier, number> = { new: 0, established: 1, top_rated: 2 }

/** The min-tier claim gate comparison (terms setting 18). */
export function meetsMinTier(tier: TrustTier, min: TrustTier): boolean {
  return TIER_RANK[tier] >= TIER_RANK[min]
}
