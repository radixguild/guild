// Countdown math for task timing chips (PRODUCTION-SCHEDULE Track B,
// "UX wave 1 · countdown chips"). Pure functions — callers pass `now` so
// ticking components and tests stay deterministic.

import { DEFAULT_DISPUTE_WINDOW_HOURS } from "@/lib/marketplace"

// Default dispute auto-resolve window in ms, from the same display constant
// the escrow actions use (168h = the live component's
// dispute_auto_resolve_secs = 604800 since the owner's 2026-10-11 change; it
// was 259200 = 72h before). Display-only: the CHAIN enforces the real window
// off the on-chain disputed_at, using the window PINNED onto the task when the
// dispute was raised — so a dispute raised before the change still closes at
// 72h. Prefer disputeWindowMs(pinned) wherever the pinned value is in hand.
export const DISPUTE_WINDOW_MS = DEFAULT_DISPUTE_WINDOW_HOURS * 3600 * 1000

/**
 * The window a dispute's countdown should use: the task's PINNED
 * `dispute_auto_resolve_secs` (OnChainTaskInfo.disputeAutoResolveSecs) when it
 * is a readable positive number, else the DISPUTE_WINDOW_MS default. Takes the
 * pinned value only from data a caller already holds — never a reason to add a
 * chain read.
 */
export function disputeWindowMs(pinnedSecs?: number | null): number {
  return typeof pinnedSecs === "number" && Number.isSafeInteger(pinnedSecs) && pinnedSecs > 0
    ? pinnedSecs * 1000
    : DISPUTE_WINDOW_MS
}

/**
 * A window length as a copy adjective. Up to 72 hours reads in hours ("72-hour",
 * how the original window was always described, never "3-day"); a longer
 * whole-day window reads in days ("7-day"); anything else stays in hours.
 * Used where the length is the task's own pinned value, not the default.
 */
export function windowLengthLabel(ms: number): string {
  const hours = Math.round(ms / 3_600_000)
  return hours % 24 === 0 && hours > 72 ? `${hours / 24}-day` : `${hours}-hour`
}

/**
 * Format a positive remaining span as "2d 4h" / "4h 32m" / "32m" / "<1m".
 * Floors each unit and shows at most the two most significant non-zero units.
 * Spans below one minute (including <= 0) collapse to "<1m" — callers decide
 * lapse handling before formatting.
 */
export function formatRemaining(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return "<1m"
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}

export interface TaskCountdown {
  /** Which timing window the chip tracks. */
  kind: "deadline" | "dispute"
  /** True once the window end has passed — the label flips to a state, not negative time. */
  lapsed: boolean
  /** Ready-to-render chip text, e.g. "closes in 2d 4h" or "finalize available". */
  label: string
}

/**
 * Derive the countdown chip state for a task, or null when no timing window
 * applies (no chip). Windows covered:
 *
 * - open + deadline        → "closes in 2d 4h", then "deadline passed"
 * - disputed + disputedAt  → "resolves in 2d 4h", then "finalize available"
 *
 * For disputed tasks, disputedAt is the persisted on-chain dispute time (the
 * dispute tx's consensus timestamp — what the chain's window actually keys
 * off). Rows disputed before that column shipped fall back to updatedAt,
 * which only approximates it (the task's last write — observed minutes off
 * on mainnet, so chips could flip "finalize available" before the chain
 * accepts the call). The window is the task's pinned
 * `disputeAutoResolveSecs` when the caller has it, else the default (see
 * disputeWindowMs).
 */
export function getTaskCountdown(
  task: {
    status: string
    deadline?: Date | null
    disputedAt?: Date | null
    updatedAt?: Date | null
    disputeAutoResolveSecs?: number | null
  },
  now: number
): TaskCountdown | null {
  if (task.status === "open" && task.deadline) {
    const remaining = task.deadline.getTime() - now
    return remaining > 0
      ? { kind: "deadline", lapsed: false, label: `due in ${formatRemaining(remaining)}` }
      : { kind: "deadline", lapsed: true, label: "past due date" }
  }
  const disputedAt = task.disputedAt ?? task.updatedAt
  if (task.status === "disputed" && disputedAt) {
    const remaining = disputedAt.getTime() + disputeWindowMs(task.disputeAutoResolveSecs) - now
    return remaining > 0
      ? { kind: "dispute", lapsed: false, label: `resolves in ${formatRemaining(remaining)}` }
      : { kind: "dispute", lapsed: true, label: "finalize available" }
  }
  return null
}
