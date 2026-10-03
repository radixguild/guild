/**
 * Presentation helpers for the community-funding surface.
 *
 * Every function here is pure and total, and — the point of the file — every
 * *judgement* it makes is delegated to `funding-state-machine.ts` rather than
 * re-implemented for the browser. The page never decides for itself whether a
 * pledge is legal: it calls `describePledge`, which runs the SAME
 * `applyPledge` the API route runs on the server, catches the typed
 * `FundingStateError`, and turns it into copy.
 *
 * That indirection is the whole design. The obvious alternative — a little
 * `amount > remaining` check in the form — is a second implementation of five
 * rules (positive, minimum, over-target, gap-guard, deadline) that would drift
 * from the server's the first time one of them changed, and drift silently:
 * the form would say "looks fine" and the POST would come back 400. Here a
 * rule change in the state machine moves the client preview with it, or fails
 * the build. It is the same reasoning `graceExpiresAt` is exported for.
 *
 * Nothing here touches the DB, the clock or the network — `now` is always a
 * parameter, matching the state machine's own discipline so the boundary
 * cases (a deadline that passes while the form is open) stay testable.
 */

import {
  applyPledge,
  evaluateDeadline,
  FundingStateError,
  graceExpiresAt,
  type FundingErrorCode,
  type FundingPoolState,
  type FundingPoolStatus,
} from "@/lib/funding-state-machine";
import { compareXrd, gtXrd, subXrd } from "@/lib/xrd-decimal";
// The same formatter <XrdAmount> uses, so a figure quoted inside a sentence
// ("only 10 XRD is still needed") matches the figure in the panel above it.
// The DB hands back 18dp strings; unformatted, every refusal would read
// "10.000000000000000000 XRD".
import { formatXrdAmount } from "@/lib/format-xrd-usd";

/** The shape the API hands back (JSON: dates are ISO strings, money is exact
 *  decimal strings — never numbers; see xrd-decimal.ts on why 18dp `Decimal`
 *  amounts must not round-trip through `number`). */
export interface FundingPoolJson {
  id: number;
  posterId: string;
  title: string;
  description: string;
  targetXrd: string;
  pooledXrd: string;
  insuranceXrd: string;
  deadline: string | null;
  publishedAt: string | null;
  graceWindowSecs: number | null;
  status: FundingPoolStatus;
  fundedAt: string | null;
  finalizedAt: string | null;
  finalizedTaskId: number | null;
  expiredAt: string | null;
  expiredReason: "NotFunded" | "GraceExpired" | null;
  createdAt: string;
  updatedAt: string;
}

/** JSON row -> the state machine's own input type. `graceWindowSecs` falls
 *  back to the caller-supplied default exactly as the schema comment
 *  prescribes (NULL = "row predates the column or poster took the default"),
 *  so the client's countdown and the server's grace boundary agree. */
export function toPoolState(
  pool: FundingPoolJson,
  defaultGraceWindowSecs: number,
): FundingPoolState {
  return {
    status: pool.status,
    targetXrd: pool.targetXrd,
    pooledXrd: pool.pooledXrd,
    deadline: pool.deadline ? new Date(pool.deadline) : null,
    publishedAt: pool.publishedAt ? new Date(pool.publishedAt) : null,
    graceWindowSecs: pool.graceWindowSecs ?? defaultGraceWindowSecs,
    fundedAt: pool.fundedAt ? new Date(pool.fundedAt) : null,
    finalizedAt: pool.finalizedAt ? new Date(pool.finalizedAt) : null,
    expiredAt: pool.expiredAt ? new Date(pool.expiredAt) : null,
    expiredReason: pool.expiredReason,
  };
}

/** Percentage of target pledged, clamped to [0, 100] and rounded for display
 *  only — the exact figures stay decimal strings everywhere else. Computed on
 *  integer-scaled values rather than `Number(pooled)/Number(target)` so a
 *  target beyond `Number`'s safe range still bars sensibly. */
export function poolProgressPercent(pooledXrd: string, targetXrd: string): number {
  if (compareXrd(targetXrd, "0") <= 0) return 0;
  const pooled = Number(pooledXrd);
  const target = Number(targetXrd);
  if (!Number.isFinite(pooled) || !Number.isFinite(target) || target <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((pooled / target) * 100)));
}

/** What a pool's status means to a reader, and how loudly to say it.
 *  `tone` maps to the Badge variants the rest of the app already uses. */
export function statusPresentation(status: FundingPoolStatus): {
  label: string;
  tone: "default" | "secondary" | "outline" | "destructive";
  /** One line explaining what the state means for someone holding a pledge. */
  meaning: string;
} {
  switch (status) {
    case "draft":
      return {
        label: "Draft",
        tone: "outline",
        // A draft takes no money, so there is no pledge to hold and nothing
        // to reassure anyone about — say what it IS instead.
        meaning: "The charter is still being written. Pledging has not opened.",
      };
    case "pledging":
      return {
        label: "Open",
        tone: "default",
        meaning: "Accepting pledges until the deadline.",
      };
    case "funded":
      return {
        label: "Target met",
        tone: "secondary",
        meaning: "The target is covered and the poster can finalise it into a task.",
      };
    case "finalized":
      return {
        label: "Finalised",
        tone: "outline",
        meaning: "The poster closed this pool.",
      };
    case "expired":
      return {
        label: "Expired",
        tone: "destructive",
        meaning: "The window closed. Pledges recorded here can be released.",
      };
    case "refunding":
      return {
        label: "Releasing",
        tone: "destructive",
        meaning: "Pledges are being released back to the people who made them.",
      };
  }
}

/** Human countdown to a boundary. Returns null when the boundary has passed,
 *  so callers must handle "over" explicitly rather than rendering "0 days
 *  left" on a window that shut a week ago. */
export function timeRemaining(target: Date, now: Date): string | null {
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)} days`;
}

/** The deadline line for a pool card: which clock is running, and how long is
 *  left on it. A `funded` pool is racing the GRACE window, not the deadline
 *  (D5's liveness escape) — showing "deadline passed" on a funded pool that
 *  still has five days to finalise would be actively misleading. */
export function deadlineSummary(
  pool: FundingPoolState,
  now: Date,
): { label: string; remaining: string | null; urgent: boolean } {
  const settled = evaluateDeadline(pool, now);
  // A draft has no clock to report — publishing starts it (publishPool).
  if (settled.status === "draft") {
    return { label: "Not open yet", remaining: null, urgent: false };
  }
  const grace = graceExpiresAt(settled);
  if (settled.status === "funded" && grace) {
    const remaining = timeRemaining(grace, now);
    return { label: "Finalise within", remaining, urgent: remaining !== null && grace.getTime() - now.getTime() < 48 * 3600_000 };
  }
  if (settled.status === "pledging" && settled.deadline) {
    const dl = settled.deadline;
    const remaining = timeRemaining(dl, now);
    return { label: "Open for", remaining, urgent: remaining !== null && dl.getTime() - now.getTime() < 48 * 3600_000 };
  }
  return { label: statusPresentation(settled.status).label, remaining: null, urgent: false };
}

export type PledgePreview =
  | { ok: true; remainingAfterXrd: string; wouldMeetTarget: boolean }
  | { ok: false; code: FundingErrorCode | "INVALID_AMOUNT"; message: string };

/**
 * What would happen if this pledge were submitted right now — answered by the
 * server's own rule set, not by a copy of it.
 *
 * The two error codes worth calling out, because they are the ones a naive
 * form gets wrong:
 *   • GAP_TOO_SMALL — a pledge that would leave a remainder smaller than the
 *     minimum contribution is refused, since no legal future pledge could
 *     close that gap. Users hit this constantly near the top of a pool and it
 *     is baffling without an explanation, so we surface the exact remainder.
 *   • OVER_TARGET — the pool refuses over-funding outright (D1), rather than
 *     accepting and refunding the excess.
 */
export function describePledge(
  pool: FundingPoolState,
  amountXrd: string,
  now: Date,
  minContributionXrd: string,
): PledgePreview {
  const trimmed = amountXrd.trim();
  // Guarded before the state machine sees it: `applyPledge` takes a decimal
  // STRING and an empty or malformed one is a form-state condition ("the user
  // hasn't finished typing"), not a rule violation worth a scary message.
  if (trimmed === "" || !/^\d+(\.\d{1,18})?$/.test(trimmed)) {
    return { ok: false, code: "INVALID_AMOUNT", message: "Enter an amount in XRD." };
  }
  try {
    const after = applyPledge(pool, trimmed, now, { minContributionXrd });
    return {
      ok: true,
      remainingAfterXrd: subXrd(after.targetXrd, after.pooledXrd),
      wouldMeetTarget: after.status === "funded",
    };
  } catch (err) {
    if (err instanceof FundingStateError) {
      return { ok: false, code: err.code, message: explainRefusal(err, pool, trimmed, minContributionXrd) };
    }
    throw err;
  }
}

/** Turns the state machine's (developer-shaped) message into something a
 *  contributor can act on. Keyed by code, never by message text. */
function explainRefusal(
  err: FundingStateError,
  pool: FundingPoolState,
  amountXrd: string,
  minContributionXrd: string,
): string {
  const remaining = subXrd(pool.targetXrd, pool.pooledXrd);
  switch (err.code) {
    case "BELOW_MINIMUM":
      return `The minimum pledge is ${formatXrdAmount(minContributionXrd)} XRD.`;
    case "OVER_TARGET":
      return `Only ${formatXrdAmount(remaining)} XRD is still needed — this pool does not take more than its target.`;
    case "GAP_TOO_SMALL": {
      const left = subXrd(remaining, amountXrd);
      return `That would leave ${formatXrdAmount(left)} XRD to find, which is under the ${formatXrdAmount(minContributionXrd)} XRD minimum — no later pledge could close it. Pledge ${formatXrdAmount(remaining)} XRD to finish the pool, or less to leave a workable gap.`;
    }
    case "AMOUNT_NOT_POSITIVE":
      return "Enter an amount above zero.";
    case "PAST_DEADLINE":
    case "NOT_ACCEPTING_PLEDGES":
      return "This pool is no longer taking pledges.";
    default:
      return err.message;
  }
}

/** The largest legal pledge right now — what a "fund the rest" button offers.
 *  Returns null when nothing legal is left to give. */
export function maxLegalPledge(pool: FundingPoolState, now: Date, minContributionXrd: string): string | null {
  const remaining = subXrd(pool.targetXrd, pool.pooledXrd);
  if (!gtXrd(remaining, "0")) return null;
  const preview = describePledge(pool, remaining, now, minContributionXrd);
  return preview.ok ? remaining : null;
}
