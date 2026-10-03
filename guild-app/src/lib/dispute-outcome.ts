/**
 * What an AUTO-RESOLVED dispute actually pays — derived, never asserted.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The same dispute-outcome claim shipped in SIX places and was wrong in every
 * one of them, in two different directions:
 *
 *   escrow-actions.tsx ×3   "the party who raised the dispute automatically
 *                            wins the full reward + insurance", and a button
 *                            literally labelled "Raise dispute in my favour"
 *   escrow-truth.tsx        the FIX for the above — "splits the reward +
 *                            insurance evenly" — half right, insurance wrong
 *   money/page.tsx ×2       "an even split of the reward AND the insurance …
 *                            ~52 XRD of exposure"
 *
 * All six read `SplitEvenly` as governing both vaults. It governs one.
 * `auto_resolve_dispute` (escrow/.../src/lib.rs) passes TWO rulings into
 * `credit_split_for_parties`: the configured default for the REWARD, and a
 * hardcoded `&DisputeRuling::RefundPoster` for the INSURANCE. The blueprint
 * says why, in its own words: "Insurance is the poster's premium, not a prize:
 * on AUTO-resolve, where nobody judged, it goes back to the poster and the
 * dispute path pays exactly what approve pays."
 *
 * That is a deliberate anti-griefing property — it is what stops disputing
 * from out-earning honest completion — and describing it as a 50/50 of both
 * vaults erases the one guarantee the design was built to give.
 *
 * So the numbers here are COMPUTED from the blueprint's rules rather than
 * written into prose. A hardcoded "~52 XRD" cannot be kept true by anyone;
 * `posterCostOnAutoResolve()` cannot drift from `worker_share` without a test
 * going red.
 *
 * ⚠️ ARBITER-RULED disputes are a DIFFERENT path. `resolve_dispute` passes the
 * arbiter's single ruling for BOTH vaults, so there the insurance CAN move to
 * the worker. Nothing here describes that path — it is an operator ceremony
 * (the arbiter badge is supply-1, held by the operator; the runbook is
 * docs/architecture/dispute-resolution.md §0), not something the app performs.
 */

import { INSURANCE_RATE } from "@/lib/marketplace";

/** The live component's `dispute_auto_resolve_default`, Gateway-verified.
 *  Write-once at instantiate — there is no setter, so this cannot change
 *  without a new component. */
export const AUTO_RESOLVE_DEFAULT = "SplitEvenly" as const;

/** The worker's share of the REWARD under the live default. `worker_share`
 *  maps `Split { worker_pct: 0.5 }` to `amount * 0.5`. */
export const AUTO_RESOLVE_WORKER_REWARD_PCT = 0.5;

/**
 * The credits an auto-resolved dispute produces, for a task funded with
 * `rewardXrd` and its insurance premium.
 *
 * Mirrors `credit_split_for_parties` exactly, including the remainder rule:
 * the poster's share is the REMAINDER of the combined bucket, never a
 * separately-computed product, so truncation lands with the poster rather than
 * stranding dust in the vault.
 */
export function autoResolveCredits(rewardXrd: number, insuranceXrd?: number) {
  const insurance = insuranceXrd ?? Math.ceil(rewardXrd * INSURANCE_RATE);
  const funded = rewardXrd + insurance;
  // Delegates to the general form below so the numbers on the money page and
  // the numbers in the operator's dispute alert are produced by ONE function.
  // Two copies of this arithmetic is how the claim ended up wrong in six places.
  const split = autoResolvePayout(AUTO_RESOLVE_DEFAULT, null, rewardXrd, insurance);
  // Unreachable for the live default: SplitEvenly is recognised and does not
  // depend on the raiser, so the only null path is non-finite input. Throwing
  // beats returning NaN into rendered copy about someone's money.
  if (!split) {
    throw new Error(
      `autoResolveCredits: no payout for ${AUTO_RESOLVE_DEFAULT} on ` +
        `reward=${rewardXrd} insurance=${insurance}`,
    );
  }
  return {
    insurance,
    funded,
    /** Credited to the worker's entitlement — collected by their own withdrawal. */
    worker: split.worker,
    /** Credited to the poster's entitlement — the remainder of the combined bucket. */
    poster: split.poster,
    /** What the dispute actually costs the poster, net of what comes back. */
    posterCost: split.worker,
  };
}

/** What the poster is out of pocket when a dispute auto-resolves. Equal to the
 *  worker's credit by construction — the insurance always comes home. */
export const posterCostOnAutoResolve = (rewardXrd: number, insuranceXrd?: number) =>
  autoResolveCredits(rewardXrd, insuranceXrd).worker;

/**
 * The general form: what an auto-resolved dispute pays each party under ANY of
 * the three configured defaults, for a task whose vaults hold `rewardXrd` and
 * `insuranceXrd`.
 *
 * `autoResolveCredits` above answers the same question for the ONE ruling the
 * live component is configured with, and delegates here so the two can never
 * disagree. This general form exists because the drift watcher reads the ruling
 * off the component at run time rather than trusting a constant — if the
 * component is ever swapped, the alert must describe the ruling that will
 * actually fire, not the one that was true when this file was written.
 *
 * Every unknown returns null instead of a guess. The whole point of putting a
 * number in an operator's alert is that they can act on it; a wrong number is
 * worse than no number, and this module exists because that exact claim was
 * wrong in six places at once.
 *
 * Mirrors two things in the blueprint, and they live in different places —
 * `worker_share` (lib.rs, its own match on `DisputeRuling`) is only the
 * per-ruling share function:
 *   • the ruling governs the REWARD only. The insurance is hard-coded
 *     `RefundPoster` at the CALL SITE in `auto_resolve_dispute` (lib.rs, its
 *     `credit_split_for_parties` call passing `&DisputeRuling::RefundPoster`
 *     as the insurance ruling),
 *     not inside `worker_share`, and that is what stops disputing out-earning
 *     honest approval;
 *   • the poster's leg is the REMAINDER of the combined bucket — the
 *     `combined.take(worker_total)` / `combined.amount()` pair near the end of
 *     `credit_split_for_parties` — so truncation lands with the poster instead
 *     of stranding dust in the vault.
 *
 * ⚠️ This comment cited "lib.rs:1768-1786" for both facts until 2026-08-26. That
 * range holds `worker_share`'s body and `credit_split_for_parties`' signature —
 * neither of the two things it was offered as proof of. Both claims were true;
 * the citation simply did not support them, which in a module written because
 * this exact claim was wrong in six places is the failure mode, not a nitpick.
 */
export function autoResolvePayout(
  ruling: string | null,
  raisedBy: "poster" | "worker" | null,
  rewardXrd: number,
  insuranceXrd: number,
): { worker: number; poster: number } | null {
  if (!Number.isFinite(rewardXrd) || !Number.isFinite(insuranceXrd)) return null;
  let workerReward: number;
  if (ruling === "SplitEvenly") {
    workerReward = rewardXrd * AUTO_RESOLVE_WORKER_REWARD_PCT;
  } else if (ruling === "ReturnToPoster") {
    // AutoResolveDefault::ReturnToPoster → DisputeRuling::RefundPoster → 0.
    workerReward = 0;
  } else if (ruling === "FavorDisputeRaiser") {
    // The ONE ruling whose outcome depends on who raised (lib.rs, the
    // `FavorDisputeRaiser => match raised_by` arm in `auto_resolve_dispute`).
    // With the raiser unknown a guess names the wrong winner half the time.
    if (raisedBy === null) return null;
    workerReward = raisedBy === "worker" ? rewardXrd : 0;
  } else {
    // Unrecognised or unreadable ruling — including a future variant this
    // build has never heard of. Say nothing rather than guess.
    return null;
  }
  return { worker: workerReward, poster: rewardXrd - workerReward + insuranceXrd };
}
