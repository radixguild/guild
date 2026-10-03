// Pure decision logic for the reconciler's claim heal (R3-2), extracted so the
// money-path resolution is unit-testable without the Gateway/DB (mirrors the
// src/lib/escrow-drift.ts precedent). The reconciler script
// (scripts/reconcile-escrow.mjs) does the I/O — read the live on-chain claim
// facts, look up the guild user, apply the confirm — and delegates the WHO/what
// decision here. The per-task resync (src/lib/escrow-resync.ts) reuses the same
// decision when a caller can't prove claimership (the receipt burns at submit).

export type ClaimHealDecision =
  | { action: "heal"; assignee: string }
  | { action: "surface"; assignee: string; reason: string }
  | { action: "skip"; reason: string };

/**
 * The on-chain TaskState variants in which the blueprint RETAINS
 * `worker_account` (guild-marketplace-escrow src/lib.rs): set by claim_task,
 * cleared ONLY by expire_claim and cancel_task_by_poster_after_claim. It
 * survives submit, approve_and_release, and every dispute path (Refunded here
 * = a dispute-loss refund — the cancel paths that also end Refunded clear the
 * worker, so they present as `workerAccount: null` and skip).
 */
const WORKER_RETAINING_STATES: ReadonlySet<string> = new Set([
  "Claimed",
  "Submitted",
  "Disputed",
  "Released",
  "Refunded",
]);

/**
 * Decide how a caller should handle a TaskClaimedEvent whose DB row has no
 * assignee, from the CURRENT on-chain claim state. Pure + total.
 *
 *   • heal    — a worker is on record on-chain (worker_account present in a
 *               worker-retaining state) and the DB row is still in the healable
 *               window (open/assigned) → set the assignee to worker_account.
 *               This covers the live claim (Claimed) AND a client-vanished
 *               backlog whose lifecycle already moved on-chain (Submitted /
 *               Released / Disputed / dispute-loss Refunded): the confirm core
 *               then replays submit/approve/… in stream order, so the row
 *               converges to parity within the same reconciler pass.
 *   • surface — a worker is on record but the DB status is already past the
 *               healable window (the confirm core's ALLOWED_FROM gate won't
 *               backfill it), or the state/worker shape is inconsistent with
 *               the blueprint (e.g. Open with a worker_account — expire_claim
 *               clears it, so that's a parse anomaly, never healed) → hand the
 *               resolved account to the operator.
 *   • skip    — no worker on record (Open after an expired claim, or a cancel
 *               path → worker_account cleared to None) → nothing to attribute;
 *               the DB open state is consistent with the chain.
 *
 * worker_account (the on-chain payout account) is the SOLE attribution source:
 * whenever it is `Some`, it names the payout account of the CURRENT (latest)
 * claim — the account the escrow pays, paid, or would pay — so it can never
 * name the wrong worker. Crucially, an abandoned/expired claim clears it to
 * None, so an expired claim resolves to `skip`, never a heal that would
 * attribute the task to the worker who walked away. (This is why the
 * claimer-badge OWNER is deliberately NOT consulted — a membership badge is
 * transferable and outlives the claim, so its current owner is a race-prone,
 * wrong attribution source. It is also why the claim tx's own bond-deposit
 * account is not used: that resolves the EVENT's claimer, which is exactly
 * wrong for expired-then-reclaimed histories.)
 */
export function decideClaimHeal(input: {
  dbStatus: string;
  onChainState: string | null;
  workerAccount: string | null;
}): ClaimHealDecision {
  const { dbStatus, onChainState, workerAccount } = input;
  const healable = dbStatus === "open" || dbStatus === "assigned";

  if (workerAccount) {
    if (onChainState !== null && WORKER_RETAINING_STATES.has(onChainState)) {
      // A worker the chain still vouches for. Heal only within the window the
      // confirm core will accept (open/assigned); anything past that is a
      // deeper desync the operator must look at.
      return healable
        ? { action: "heal", assignee: workerAccount }
        : {
            action: "surface",
            assignee: workerAccount,
            reason: `on-chain ${onChainState} names worker ${workerAccount} but DB status '${dbStatus}' is past the healable window`,
          };
    }
    // A worker_account in a state that structurally cannot carry one (Open —
    // expire_claim clears it) or with an unreadable state: an inconsistent
    // shape. Never heal on it; surface for the operator instead of guessing.
    return {
      action: "surface",
      assignee: workerAccount,
      reason: `on-chain state ${onChainState ?? "unknown"} should not retain a worker_account — inconsistent read, not healing`,
    };
  }

  // No worker on record on-chain: Open (expired claim) or a cancel path.
  return {
    action: "skip",
    reason: `no active on-chain claim (state ${onChainState ?? "unknown"}, worker_account cleared) — nothing to attribute`,
  };
}

export type HealResultAction = "healed" | "retry" | "unreconcilable";

/**
 * Classify an applyEscrowConfirm result for the reconciler's --apply step, so a
 * transient re-verification failure holds the cursor instead of forfeiting the
 * heal. Pure.
 *   • healed         — ok.
 *   • retry          — a 422 (on-chain event re-verification failed). The
 *                      reconciler ALREADY read this event from the committed-tx
 *                      stream (emitter + task_id matched), so a failed RE-read
 *                      via /transaction/committed-details is a transient Gateway
 *                      blip, not a genuine absence. The caller must THROW so the
 *                      run exits 1 with no next-cursor and the keeper cron holds
 *                      its cursor to retry — never advancing past the unhealed row
 *                      (the same contract readOnChainClaimInfo enforces for the
 *                      first read).
 *   • unreconcilable — any other terminal rejection (lifecycle 409 / authz 403 /
 *                      NOT_RECONCILABLE 501): a real, non-retryable condition.
 */
export function classifyHealResult(result: {
  ok: boolean;
  httpStatus?: number;
}): HealResultAction {
  if (result.ok) return "healed";
  if (result.httpStatus === 422) return "retry";
  return "unreconcilable";
}
