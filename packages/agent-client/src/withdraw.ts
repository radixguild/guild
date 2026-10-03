// withdraw.ts — the worker's collection leg (P3-1).
//
// WHY THIS EXISTS
// ---------------
// Under the PUSH escrow, settlement pushed funds to the worker as part of the
// poster's approval: an agent that submitted work was paid without doing
// anything further. The PULL cutover (2026-08-17) changed that — settlement now
// credits an ENTITLEMENT, and the payee must actively collect it. The manifest
// builder for that collection has existed since chunk F and nothing called it:
// `withdraw` appeared zero times in guild-worker. An agent could claim, build
// and submit, and then had no headless way to take its money.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// ----------------------------------
// It never chooses a destination. `withdraw_worker(task_id, badge)` has no
// destination argument; the escrow pays `task.worker_account`, pinned at
// claim_task. That is the property that makes presenting a transferable badge
// safe, and adding a `--to` flag would both fail to compile a valid manifest
// and imply a control the caller does not have.

import { loadConfig } from './config.js';
import type { GuildClientConfig } from './config.js';
import {
  isPositiveDecimal,
  readWorkerEntitlement,
  resolveBadgeLocalId,
  type WorkerEntitlement,
} from './gateway.js';
import type { AgentIdentity } from './identity.js';
import { withdrawWorkerManifest } from './manifests.js';
import { describeCommitFailure, withdrawWorkerOnChain } from './tx.js';

/**
 * Why a withdrawal was not attempted. Each is a distinct real state and they
 * are kept apart rather than collapsed, because two of them —
 * `no-entitlement-fields` and `nothing-owed` — read identically on the wire and
 * mean opposite things. That is the same "D trap" the withdraw UI names: a
 * pre-pull component reports every entitlement as absent, which is
 * indistinguishable from a fully-collected task unless presence is checked
 * separately from value.
 */
export type WithdrawRefusal =
  /** Task state unreadable — Gateway hiccup or unknown id on THIS component. */
  | 'unreadable'
  /** The component carries no entitlement fields: it is a pre-pull escrow. */
  | 'no-entitlement-fields'
  /** Entitlements exist and both lanes are zero. Nothing to collect. */
  | 'nothing-owed'
  /** The escrow recorded no claimer badge — cannot build a collection proof. */
  | 'claimer-badge-unknown'
  /** This agent's account is not the payee the escrow pinned at claim. */
  | 'not-the-payee'
  /** The claim used a badge resource this agent does not hold. */
  | 'badge-unavailable'
  /** The badge resource for this claim lane is not configured at all. */
  | 'badge-not-configured'
  /**
   * A `--live` run signed and submitted, but the Gateway did not report
   * `CommittedSuccess` (CommittedFailure / Rejected / Unknown). The only
   * refusal raised AFTER signing — `intentHash` and `status` are set.
   */
  | 'not-committed';

export interface WithdrawResult {
  /**
   * True when nothing was COLLECTED; `refusal` says why. Either nothing was
   * attempted (every pre-signing guard), or a `--live` submission did not
   * commit (`not-committed` — the one refusal that also carries `intentHash`
   * and `status`). A caller that branches only on this flag never mistakes a
   * reverted, rejected or timed-out transaction for a payout.
   */
  refused: boolean;
  refusal?: WithdrawRefusal;
  /** Operator-facing explanation. Always set when `refused`. */
  message?: string;
  /** The manifest that would be (or was) signed. */
  manifest?: string;
  /** True when this was a preview — nothing was signed or submitted. */
  dryRun: boolean;
  /** Set only on a --live run that submitted. */
  intentHash?: string;
  status?: string;
  /** What the chain says is owed, when it could be read. */
  entitlement?: { reward: string; bond: string };
}

/** One-line explanation per refusal — the only place this wording lives. */
export function explainRefusal(reason: WithdrawRefusal, taskId: number): string {
  switch (reason) {
    case 'unreadable':
      return `Could not read task ${taskId} on the configured escrow component. That is UNKNOWN, not "nothing owed" — do not treat it as collected. Retry, or check GUILD_ESCROW_COMPONENT points at the component the task was funded on (ids are per-component and collide across cutovers).`;
    case 'no-entitlement-fields':
      return `The configured escrow component does not record entitlements, so it is a pre-PULL deployment. Under that escrow settlement pushed funds to you directly and there is genuinely nothing to collect. Check GUILD_ESCROW_COMPONENT.`;
    case 'nothing-owed':
      return `Task ${taskId} owes you nothing: both the reward and claim-bond lanes read zero. Either you already collected, or the task has not settled yet (the poster must approve first).`;
    case 'claimer-badge-unknown':
      return `The escrow does not record which badge claimed task ${taskId}, so a collection proof cannot be built. Nothing is lost — the entitlement is still held for you. This needs an operator.`;
    case 'not-the-payee':
      return `Task ${taskId}'s worker payout is pinned to a DIFFERENT account than this agent's. Refusing on purpose: withdraw_worker asserts only that the badge is the claimer's — it does NOT check who calls it — so this would SUCCEED and deposit into the pinned account, not yours. You would pay the fee and receive nothing. (The badge is transferable, so holding it does not make you the payee.)`;
    case 'badge-unavailable':
      return `This agent does not hold the badge that claimed task ${taskId}, so it cannot present the proof the collection needs. The claim badge is chosen on chain at claim time, not by this client.`;
    case 'badge-not-configured':
      return `Task ${taskId} was claimed with the agent badge, but GUILD_AGENT_BADGE_RESOURCE is not set — so this client never looked up whether you hold it. Nothing is lost; set the env and retry. (Do not read this as "you hold the wrong badge": no holdings were checked.)`;
    case 'not-committed':
      return `Task ${taskId} was NOT collected: withdraw_worker was signed and submitted but the Gateway did not report CommittedSuccess. The entitlement stays on the escrow until a withdrawal commits — check the intent hash before retrying (an Unknown status means the Gateway timed out waiting, not that the transaction failed).`;
  }
}

/**
 * Decide whether a withdrawal is possible, given what the chain says.
 *
 * Pure and exported so the refusal logic is unit-testable without a network:
 * every branch here is a decision about real money, and the ones that matter
 * most (unknown vs zero) are exactly the ones that cannot be exercised by
 * pointing a test at mainnet.
 */
export function resolveWithdrawal(
  entitlement: WorkerEntitlement | null,
  agentAccount: string,
  heldBadgeLocalId: string | null,
  badgeResourceConfigured = true
): { ok: true; badgeLocalId: string } | { ok: false; refusal: WithdrawRefusal } {
  if (!entitlement) return { ok: false, refusal: 'unreadable' };
  // Presence BEFORE value — see the WithdrawRefusal doc comment.
  if (!entitlement.entitlementsPresent) {
    return { ok: false, refusal: 'no-entitlement-fields' };
  }
  const owed =
    isPositiveDecimal(entitlement.reward) || isPositiveDecimal(entitlement.bond);
  if (!owed) return { ok: false, refusal: 'nothing-owed' };
  // Payee identity comes from the CHAIN PIN, never from local config: the pin is
  // where the money will actually go.
  if (entitlement.workerAccount !== null && entitlement.workerAccount !== agentAccount) {
    return { ok: false, refusal: 'not-the-payee' };
  }
  if (!entitlement.claimerBadgeId) {
    return { ok: false, refusal: 'claimer-badge-unknown' };
  }
  // "We never looked" and "we looked and you don't hold it" are different
  // facts and get different messages: the first sends an operator to an env
  // var, the second to their wallet.
  if (!badgeResourceConfigured) {
    return { ok: false, refusal: 'badge-not-configured' };
  }
  // The badge the withdrawal must present is the one the CHAIN recorded at
  // claim, not whichever badge this agent happens to hold now.
  if (heldBadgeLocalId !== entitlement.claimerBadgeId) {
    return { ok: false, refusal: 'badge-unavailable' };
  }
  return { ok: true, badgeLocalId: entitlement.claimerBadgeId };
}

export interface WithdrawOptions {
  taskId: number;
  /** False (default) previews the manifest and signs nothing. */
  live: boolean;
  /** Null is legal for a dry run — the preview needs an address, not a key. */
  identity: AgentIdentity | null;
  config?: GuildClientConfig;
  log?: (line: string) => void;
  /** Injected for tests; defaults to the real Gateway reads. */
  deps?: {
    readWorkerEntitlement: typeof readWorkerEntitlement;
    resolveBadgeLocalId: typeof resolveBadgeLocalId;
    withdrawWorkerOnChain: typeof withdrawWorkerOnChain;
  };
}

/**
 * Collect the worker's entitlement for one task, or explain why it cannot.
 *
 * Dry-run by default, matching every other signing verb in this CLI: a
 * `--live`-less invocation reads the chain, prints the manifest it WOULD sign,
 * and touches nothing.
 *
 * On `--live`, `refused: false` means the withdrawal COMMITTED. A submission
 * the chain did not commit comes back `refused: true` / `not-committed`, the
 * same contract `guild-poster`'s `runWithdraw` keeps — so a caller branching
 * on `refused` alone (guild-worker's CLI does exactly that) is never told
 * "Collected." over a transaction that moved nothing.
 */
export async function withdrawWorkerReward(opts: WithdrawOptions): Promise<WithdrawResult> {
  const config = opts.config ?? loadConfig();
  const log = opts.log ?? (() => {});
  const deps = opts.deps ?? {
    readWorkerEntitlement,
    resolveBadgeLocalId,
    withdrawWorkerOnChain,
  };
  const { taskId, live, identity } = opts;

  if (!identity) {
    // No key at all: we cannot even name the payee to compare against the pin.
    return {
      refused: true,
      refusal: 'not-the-payee',
      message:
        'No agent identity available. Set GUILD_AGENT_PRIVATE_KEY — even a dry run needs the account address to check it is the payee the escrow pinned.',
      dryRun: true,
    };
  }

  log(`reading entitlement for task ${taskId} on ${config.escrowComponent}`);
  const entitlement = await deps.readWorkerEntitlement(
    taskId,
    config.escrowComponent,
    config.gatewayBaseUrl
  );

  // Which badge resource the claim used is decided on chain, not by config.
  const badgeResource = entitlement?.claimerIsAgent
    ? config.agentBadgeResource
    : config.workerBadgeResource;
  const heldBadgeLocalId = badgeResource
    ? await deps.resolveBadgeLocalId(identity.address, badgeResource, config.gatewayBaseUrl)
    : null;

  const decision = resolveWithdrawal(
    entitlement,
    identity.address,
    heldBadgeLocalId,
    Boolean(badgeResource)
  );
  if (!decision.ok) {
    return {
      refused: true,
      refusal: decision.refusal,
      message: explainRefusal(decision.refusal, taskId),
      dryRun: !live,
      entitlement: entitlement
        ? { reward: entitlement.reward, bond: entitlement.bond }
        : undefined,
    };
  }

  const manifest = withdrawWorkerManifest(
    config.escrowComponent,
    identity.address,
    badgeResource,
    decision.badgeLocalId,
    taskId
  );
  const owed = { reward: entitlement!.reward, bond: entitlement!.bond };

  if (!live) {
    log(`would collect reward ${owed.reward} + bond ${owed.bond}`);
    return { refused: false, manifest, dryRun: true, entitlement: owed };
  }

  log(`signing withdraw_worker for task ${taskId}`);
  const { intentHash, status } = await deps.withdrawWorkerOnChain(
    taskId,
    badgeResource,
    decision.badgeLocalId,
    identity,
    config
  );
  log(`withdraw_worker signed (${intentHash}, ${status})`);
  if (status !== 'CommittedSuccess') {
    // Signed is not collected. Before this gate (fixed alongside PR #638's
    // poster-side `runWithdraw`) a reverted, rejected or timed-out submission
    // came back `refused: false` and guild-worker printed "Collected." over a
    // transaction that moved nothing. The Gateway's own error_message is the
    // one fact an operator needs, so it is fetched (best effort) and carried
    // in `message`; `intentHash` and `status` travel with it for the record.
    const commitFailure = await describeCommitFailure(
      config.gatewayBaseUrl,
      status,
      intentHash,
      'withdraw_worker'
    );
    return {
      refused: true,
      refusal: 'not-committed',
      message: `${commitFailure}. ${explainRefusal('not-committed', taskId)}`,
      manifest,
      dryRun: false,
      intentHash,
      status,
      entitlement: owed,
    };
  }
  return { refused: false, manifest, dryRun: false, intentHash, status, entitlement: owed };
}
