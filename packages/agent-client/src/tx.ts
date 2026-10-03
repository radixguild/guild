// On-chain transaction pipeline: build → sign (agent key = notary) → submit
// via the Babylon Gateway transaction API → poll status → hand the intent
// hash to POST /api/v1/tasks/[id]/escrow for server-side event verification.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ LIVE-PROVEN — the WORKER legs only. 2026-09-14 22:32Z (09-15 AEST),     │
// │ the Guild worker agent's env key (account_rdx129hayt…t2pm8) signed      │
// │ claim_task and the 4-arg submit_task through claimTaskOnChain /         │
// │ submitTaskOnChain → signAndSubmitManifest in this file against the      │
// │ live Wave B escrow (component_rdx1czka54…hp88yly), driven by            │
// │ `worker-cli --live --on-chain` → runWorkerCycle: smoke task 75 = chain  │
// │ task 11, both CommittedSuccess (tx ids on the two functions). Through   │
// │ 2026-09-15 UTC that key committed 16 claim_task, 16 submit_task and 15  │
// │ withdraw_worker (withdrawWorkerOnChain) transactions this way — Gateway │
// │ stream of the escrow, read 2026-09-30; this file's `lock_fee` 5 marks   │
// │ them (poster-harness.mjs locks 2). NOT yet run live through this file:  │
// │ expireClaimOnChain, the dispute legs, sweepXrdOnChain and the poster    │
// │ legs.                                                                   │
// │                                                                         │
// │ The deployed escrow's agent_badge_resource IS wired (Some(GAGENT),      │
// │ re-read 2026-09-16); GAGENT supply is 1, but this client's default      │
// │ sets no badge env. Nothing here executes until the worker explicitly    │
// │ calls it; the owner of the agent's key fills in the env                 │
// │ (GUILD_AGENT_BADGE_RESOURCE / _LOCAL_ID — Member badge works too:       │
// │ claim_task takes either, and the smoke claim used it) and funds the     │
// │ account from their own wallet. Construction + signing are also          │
// │ exercised offline in tx.test.ts.                                        │
// └─────────────────────────────────────────────────────────────────────────┘

import {
  RadixEngineToolkit,
  TransactionBuilder,
  generateRandomNonce,
  type TransactionManifest,
} from '@radixdlt/radix-engine-toolkit';
import { bytesToHex } from './bytes.js';
import type { GuildClientConfig } from './config.js';
import { LIVE_ESCROW_COMPONENT, MAINNET_XRD, RETIRED_LIVE_ESCROW_COMPONENTS } from './config.js';
import type { AgentIdentity } from './identity.js';
import {
  readOnChainClaimBondBasis,
  readOnChainTaskReward,
  readOnChainWorkBriefHash,
  readTokenDivisibility,
  resolveBadgeLocalId,
} from './gateway.js';
import { workBriefHash, type TaskTerms } from './work-brief.js';
import {
  scaleDecimal,
  approveAndReleaseManifest,
  autoResolveDisputeManifest,
  cancelTaskAfterClaimManifest,
  cancelTaskManifest,
  claimTaskManifest,
  computeInsuranceXrd,
  createTaskManifest,
  expireClaimManifest,
  raiseDisputeManifest,
  releaseAfterReviewTimeoutManifest,
  requiredBond,
  submitTaskManifest,
  transferXrdManifest,
  withdrawPosterManifest,
  withdrawWorkerManifest,
} from './manifests.js';

/** How many epochs a transaction stays valid (~5 min/epoch on mainnet). */
const EPOCH_VALIDITY_WINDOW = 10;

/**
 * Refuse to drive a task into (or out of) the Disputed state on a PRODUCTION
 * escrow component.
 *
 * 🔴 **This fuse failed OPEN between 2026-08-17 and 2026-08-19.** It kept its own
 * literal copy of the live address, and the P2 cutover repointed `config.ts`'s
 * default without touching it — so it compared production against the retired
 * push component and never fired. `gate1-e2e.mjs --live --dispute` calls
 * `loadConfig()` with no overrides, i.e. straight at production, so the one
 * caller that exists was the one the fuse stopped guarding. Two tests covered it
 * and both passed: each hand-typed the retired address as its input.
 * The addresses now come from `config.ts` — the same constant `DEFAULTS` uses —
 * so the fuse cannot be left behind at the next cutover.
 *
 * **What it guards, stated as it is today rather than as it was written.**
 * The original text said this arms BUG-7 (the push `auto_resolve_dispute` was
 * PUBLIC and returned its buckets to the caller's worktop, so any third party
 * could drain the pot). PULL fixes that root cause — settlement is credited
 * internally and the caller receives nothing, chain-proven on the rehearsal
 * component 2026-08-15. What remains is the ruling that live disputes against a
 * production component are fused off in this kit — GUILD_ALLOW_LIVE_DISPUTE=1,
 * set deliberately, signs one — plus the accepted `SplitEvenly` outcome a real
 * counterparty would be held to. So this is now an interlock against acting
 * ahead of a decision, not against a drain — a smaller claim, and the honest one.
 *
 * **Why NOT the poster-harness's component-independent form** (refuse any
 * `component_rdx1…`): disputes are supposed to be exercised against throwaway
 * mainnet components, and were — the rehearsal component ran a real
 * raise→auto-resolve on 2026-08-11/15. A blanket mainnet refusal would have
 * blocked the one exercise route the rulings actually endorse. Naming the
 * production components is the rule that matches the intent.
 *
 * This copy exists at all because gate1-e2e's `--live --dispute` path imports
 * these functions directly and would otherwise bypass the guild-app interlock.
 */
function assertLiveDisputeAllowed(verb: string, config: GuildClientConfig): void {
  if (process.env.GUILD_ALLOW_LIVE_DISPUTE === '1') return;
  const isProduction =
    config.escrowComponent === LIVE_ESCROW_COMPONENT ||
    RETIRED_LIVE_ESCROW_COMPONENTS.includes(config.escrowComponent);
  if (isProduction) {
    throw new Error(
      `Refusing to sign ${verb} against a PRODUCTION escrow component ` +
        `(${config.escrowComponent}) — live disputes against a production component are fused ` +
        'off in this kit: exercise disputes on the mock VM or a throwaway component, ' +
        'or set GUILD_ALLOW_LIVE_DISPUTE=1 deliberately to sign one.'
    );
  }
}

// `assertHeartbeatAffordable` and its MAX_HEARTBEAT_BOND_FRACTION threshold
// stood here. Both retire with the leg they guarded (DB-3, sitting 2026-08-06):
// the guard refused to sign a `heartbeat` costing at or over half the remaining
// claim bond, which at the live parameters (bond 10 / fee 5) meant every call.
// The PULL blueprint has no `heartbeat` method to sign against, so the guard is
// not "disabled" — its subject is gone. GUILD_ALLOW_LOSSY_HEARTBEAT is
// therefore also gone; it no longer overrides anything, and an env var that
// silently does nothing is worse than none.

/**
 * Determine the resource + amount for a `claim_task` bond, entirely from LIVE
 * chain state — never a client-side constant (that WAS `config.claimBondXrd`
 * cross-checked against the chain's flat `claim_bond_xrd`; Wave B W4 removed
 * the field it cross-checked against, so there is no constant left to
 * cross-check — the amount is now DERIVED, not configured and verified).
 *
 * Supports BOTH shapes a pointed-at component can deploy, so this client
 * keeps working whichever side of the swap ceremony `config.escrowComponent`
 * is on:
 *
 *  - **proportional** (Wave B — `claim_bond_pct`/`floor`/`cap` all readable):
 *    the bond is the task's own `reward_token`, amount =
 *    `requiredBond(reward_amount, pct, floor, cap, divisibility)` — a
 *    faithful port of the blueprint's own `required_bond` (manifests.ts).
 *  - **flat** (pre-Wave-B — only the legacy `claim_bond_xrd` is readable):
 *    the bond is XRD, amount = that value — byte-identical to the behaviour
 *    that shipped before this fix.
 *
 * Fails CLOSED — throws before any manifest is built — when NEITHER shape is
 * readable, or when a chain fact the proportional formula needs (the task's
 * reward info, or the reward token's divisibility) can't be read. There is
 * deliberately no override env var here (unlike the retired
 * GUILD_ALLOW_BOND_MISMATCH): a wrong GUESS is either a reverted tx (bond too
 * small) or real money bonded on an unverified number (bond too large) —
 * EXTERNAL-V1-FRAMEWORK P4-5. An operator who genuinely needs to bypass this
 * has no honest number to substitute; there is nothing safe to opt into.
 */
export async function resolveClaimBond(
  onChainTaskId: number,
  config: GuildClientConfig
): Promise<{ resource: string; amount: string }> {
  const basis = await readOnChainClaimBondBasis(config.escrowComponent, config.gatewayBaseUrl);
  if (basis === null) {
    throw new Error(
      `Refusing to sign claim_task — the escrow component (${config.escrowComponent}) exposes ` +
        'neither the proportional claim_bond_pct/claim_bond_floor/claim_bond_cap fields (Wave B) ' +
        'nor the legacy claim_bond_xrd field. Cannot determine the claim bond without guessing. ' +
        'Check GUILD_ESCROW_COMPONENT.'
    );
  }

  if (basis.mode === 'flat') {
    // Byte-identical to the pre-Wave-B behaviour: XRD, the deployed flat value.
    return { resource: MAINNET_XRD, amount: basis.amountXrd };
  }

  const rewardInfo = await readOnChainTaskReward(
    onChainTaskId,
    config.escrowComponent,
    config.gatewayBaseUrl
  );
  if (rewardInfo === null) {
    throw new Error(
      `Refusing to sign claim_task — could not read task #${onChainTaskId}'s reward_token/` +
        `reward_amount off the escrow component (${config.escrowComponent}) to size the ` +
        'proportional claim bond. An unverifiable reward risks real funds on a guessed bond.'
    );
  }
  const divisibility = await readTokenDivisibility(rewardInfo.rewardToken, config.gatewayBaseUrl);
  if (divisibility === null) {
    throw new Error(
      `Refusing to sign claim_task — could not read the divisibility of reward token ` +
        `${rewardInfo.rewardToken}. An unverifiable divisibility risks rounding the bond wrong ` +
        '(a reverted claim, or one that over-bonds).'
    );
  }
  const amount = requiredBond(
    rewardInfo.rewardAmount,
    basis.pct,
    basis.floor,
    basis.cap,
    divisibility
  );
  return { resource: rewardInfo.rewardToken, amount };
}

/**
 * The work-brief text a `claim_task` caller is about to bond real XRD to work
 * on — the exact fields `create_task` committed on-chain (work-brief.ts).
 * `title`/`description` are the task's STORED values (e.g. from
 * `GET /api/v1/tasks/[id]`); `terms`/`dueIso` are optional because a v1 task
 * (posted before terms existed, or with none set and no deadline) has
 * neither — passing them absent for such a task is correct, not a shortcut.
 */
export interface WorkBriefInput {
  title: string;
  description: string;
  terms?: TaskTerms | null;
  dueIso?: string | null;
}

/**
 * Refuse to sign a `claim_task` whose work brief the CHAIN does not
 * corroborate — the P4-3 "keystone check" (EXTERNAL-V1-FRAMEWORK Phase 4).
 * `create_task` binds `sha256(canonicalWorkBrief(title, description))` (or
 * the v2 layout, once a term or a deadline is set) as `work_brief_hash`; this
 * recomputes that hash from the SAME text the caller is about to bond on and
 * compares it against the deployed component's own committed value. A
 * mismatch means the poster's on-chain commitment and the text the agent read
 * disagree — a stale/edited local copy, advertised-vs-funded fraud, or a
 * cross-component task-id collision — and bonding on it is exactly the
 * unpriced risk this exists to catch. Zero extra round-trips: the claim path
 * already reads the task's on-chain state (readTaskState) before this runs.
 *
 * Fails CLOSED when the chain value can't be read — the same posture
 * `resolveClaimBond` follows for the bond leg: an unverifiable brief is
 * precisely the unpriced risk. Override with GUILD_ALLOW_BRIEF_MISMATCH=1
 * (mirrors GUILD_ALLOW_LIVE_DISPUTE — deliberate, throwaway funds only; the
 * bond leg has no equivalent override — see resolveClaimBond's own doc for
 * why a bond guess is never safe to opt into).
 */
async function assertWorkBriefMatchesChain(
  onChainTaskId: number,
  workBrief: WorkBriefInput,
  config: GuildClientConfig
): Promise<void> {
  if (process.env.GUILD_ALLOW_BRIEF_MISMATCH === '1') return;

  const onChainHash = await readOnChainWorkBriefHash(
    onChainTaskId,
    config.escrowComponent,
    config.gatewayBaseUrl
  );
  if (onChainHash === null) {
    throw new Error(
      `Refusing to sign claim_task — could not read work_brief_hash off the escrow component ` +
        `(${config.escrowComponent}) for task #${onChainTaskId} to cross-check the work brief. ` +
        'An unverifiable brief risks real XRD on unbound text. Retry, or set ' +
        'GUILD_ALLOW_BRIEF_MISMATCH=1 deliberately.'
    );
  }

  const localHash = await workBriefHash(
    workBrief.title,
    workBrief.description,
    workBrief.terms,
    workBrief.dueIso
  );
  if (localHash !== onChainHash) {
    throw new Error(
      `Refusing to sign claim_task — the work brief for task #${onChainTaskId} does not match ` +
        `the escrow component's committed work_brief_hash (computed ${localHash}, chain says ` +
        `${onChainHash}). The title/description/terms this client has disagree with what the ` +
        'poster funded on-chain. A likely cause: the API scrubs ops-internal task text ' +
        '(guild-app src/lib/public-task-text.ts) for any viewer who is not yet a party to the ' +
        'task — this client read the workBrief BEFORE claiming, so it saw the same scrubbed ' +
        'text a stranger would, not what the poster actually funded. Since P3-24, ' +
        'POST /api/v1/tasks refuses to create a task whose text the scrub would touch, so this ' +
        'means the task predates that fix (ask the poster to repost without the ops-internal ' +
        'detail — editing it after funding cannot change the committed hash). Note that ' +
        'becoming this task\'s assignee does NOT clear this mismatch pre-claim: the party rule ' +
        'that serves the exact stored text only applies once you already hold the claim, which ' +
        'this guard is refusing before you do. Refresh the task from the API, or set ' +
        'GUILD_ALLOW_BRIEF_MISMATCH=1 deliberately.'
    );
  }
}

export interface SignedTransaction {
  /** Compiled notarized transaction, hex — POST body for /transaction/submit. */
  notarizedTransactionHex: string;
  /** Bech32m intent hash ("txid_rdx1…") — the id confirmEscrow expects. */
  intentHash: string;
}

export type TransactionStatus =
  | 'Pending'
  | 'CommittedSuccess'
  | 'CommittedFailure'
  | 'Rejected'
  | 'Unknown';

/** Current epoch from the Gateway (POST /transaction/construction). */
export async function getCurrentEpoch(gatewayBaseUrl: string): Promise<number> {
  const response = await fetch(`${gatewayBaseUrl}/transaction/construction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!response.ok) throw new Error(`Gateway construction query failed: HTTP ${response.status}`);
  const body = (await response.json()) as { ledger_state?: { epoch?: number } };
  const epoch = body.ledger_state?.epoch;
  if (typeof epoch !== 'number') throw new Error('Gateway returned no ledger_state.epoch');
  return epoch;
}

/**
 * Build + sign a manifest with the agent's own key. The agent account is a
 * single-signer virtual account, so the notary IS the signatory
 * (notaryIsSignatory: true — no separate intent signature needed).
 */
export const FEE_LOCK_XRD = '5';

/**
 * Prepend the agent's own `lock_fee` unless the caller states the manifest
 * already locks one. Pure, exported, and the SINGLE source of this decision.
 *
 * ⚠️ THIS USED TO SNIFF THE MANIFEST TEXT — `manifest.includes('lock_fee')` —
 * AND THAT WAS A MONEY-PATH BUG. The needle is matchable by USER-CONTROLLED
 * content: `MINT_USERNAME_RE` is `/^[a-zA-Z0-9_]{1,51}$/` (mint.ts), which
 * permits the literal username `lock_fee`, and `mintMemberBadge`'s manifest
 * interpolates the username verbatim. Minting under that name made the guard
 * believe a fee lock was already present, so the real one was never prepended
 * and the transaction went out with only the tiny free-credit loan.
 *
 * The condition is now a PARAMETER, not an inference. A caller may still opt
 * out — `buildSignedTransaction` is public API and a third party can legitimately
 * build a manifest that locks its own fee — but it has to SAY so, and no string
 * a user can influence can say it for them.
 *
 * Grep at the time of the fix: `"lock_fee"` appears in exactly ONE place in the
 * whole publish surface — the template below. No manifest builder emits one. So
 * the old true-branch was never taken in legitimate use; its only reachable
 * effect was the bypass.
 */
export function composeFeeLockedManifest(
  manifest: string,
  feePayerAddress: string,
  manifestLocksItsOwnFee = false,
): string {
  if (manifestLocksItsOwnFee) return manifest;
  return (
    `CALL_METHOD\n  Address("${feePayerAddress}")\n  "lock_fee"\n  Decimal("${FEE_LOCK_XRD}")\n;\n` +
    manifest
  );
}

export async function buildSignedTransaction(input: {
  manifest: string;
  identity: AgentIdentity;
  currentEpoch: number;
  tipPercentage?: number;
  /**
   * Set true ONLY if `manifest` already contains its own `lock_fee`. Defaults
   * to false — the safe direction, since a missing lock costs a rejected
   * transaction while a spurious one costs nothing (unused fee is refunded).
   */
  manifestLocksItsOwnFee?: boolean;
}): Promise<SignedTransaction> {
  // The agent account pays the fee. Escrow manifests (claim/submit) carry no
  // lock_fee, so without this the tx only has the tiny free-credit loan and a
  // claim_task TemporarilyRejects with FeeReserveError(InsufficientBalance).
  // 5 XRD cap; unused refunds.
  const manifest: TransactionManifest = {
    instructions: {
      kind: 'String',
      value: composeFeeLockedManifest(
        input.manifest,
        input.identity.address,
        input.manifestLocksItsOwnFee,
      ),
    },
    blobs: [],
  };
  const builder = await TransactionBuilder.new();
  const notarized = await builder
    .header({
      networkId: input.identity.networkId,
      startEpochInclusive: input.currentEpoch,
      endEpochExclusive: input.currentEpoch + EPOCH_VALIDITY_WINDOW,
      nonce: generateRandomNonce(),
      notaryPublicKey: input.identity.privateKey.publicKey(),
      notaryIsSignatory: true,
      tipPercentage: input.tipPercentage ?? 0,
    })
    .manifest(manifest)
    .notarize(input.identity.privateKey);
  const intentHash = await RadixEngineToolkit.NotarizedTransaction.intentHash(notarized);
  const compiled = await RadixEngineToolkit.NotarizedTransaction.compile(notarized);
  return { notarizedTransactionHex: bytesToHex(compiled), intentHash: intentHash.id };
}

/** Submit a compiled tx (POST /transaction/submit). */
export async function submitTransaction(
  gatewayBaseUrl: string,
  notarizedTransactionHex: string
): Promise<{ duplicate: boolean }> {
  const response = await fetch(`${gatewayBaseUrl}/transaction/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ notarized_transaction_hex: notarizedTransactionHex }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Gateway submit failed: HTTP ${response.status} ${detail}`.trim());
  }
  const body = (await response.json()) as { duplicate?: boolean };
  return { duplicate: body.duplicate === true };
}

/** Poll /transaction/status until the tx leaves the mempool (or timeout). */
export async function waitForCommit(
  gatewayBaseUrl: string,
  intentHash: string,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<TransactionStatus> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // The transaction is already SUBMITTED when this runs. A network error or a
    // bad body while polling says nothing about it, so it is retried like a
    // non-OK answer — never thrown past a caller that must record the intent.
    try {
      const response = await fetch(`${gatewayBaseUrl}/transaction/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intent_hash: intentHash }),
      });
      if (response.ok) {
        const body = (await response.json()) as { status?: string };
        const status = body.status;
        if (status === 'CommittedSuccess' || status === 'CommittedFailure' || status === 'Rejected') {
          return status;
        }
      }
    } catch {
      // polled again below; Unknown at the deadline
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return 'Unknown';
}

/**
 * A human-readable failure description for a transaction that did NOT commit
 * successfully — one more `/transaction/status` read (waitForCommit already
 * reached a terminal state, so this is a single re-fetch, not a poll) to
 * recover the Gateway's own `error_message`, the one piece of information
 * every bare `status !== 'CommittedSuccess'` check in this file was
 * discarding.
 *
 * Mirrors guild-app/scripts/lib/tx-outcome.mjs's `readTxOutcome` +
 * `describeFailure` — that file's own header names `packages/agent-client/src/
 * tx.ts` (this file) as one of the nine call sites that reported failures as
 * `<method> not committed: CommittedFailure (txid_…)`, the one string that
 * cannot say which assert fired. This is the targeted fix for the ONE caller
 * that surfaced it in review (guild-poster.ts) — a single additive function,
 * not a signature change to `waitForCommit`/`TransactionStatus`/
 * `signAndSubmitManifest`, which every worker leg (claimTaskOnChain,
 * submitTaskOnChain, …) also depends on and which stay out of this PR's scope.
 *
 * Best-effort: a failed re-read (network blip, malformed body) must never
 * mask the ORIGINAL failure with a network error of its own, so this never
 * throws — it falls back to "(no error_message from the Gateway)" instead.
 */
export async function describeCommitFailure(
  gatewayBaseUrl: string,
  status: TransactionStatus,
  intentHash: string,
  what: string
): Promise<string> {
  let errorMessage: string | null = null;
  try {
    const response = await fetch(`${gatewayBaseUrl}/transaction/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent_hash: intentHash }),
    });
    if (response.ok) {
      const body = (await response.json()) as { error_message?: string };
      errorMessage = body.error_message ?? null;
    }
  } catch {
    // Swallowed deliberately — see doc comment above.
  }
  const reason = errorMessage ? ` — ${errorMessage}` : ' (no error_message from the Gateway)';
  return `${what} not committed: ${status} (${intentHash})${reason}`;
}

/**
 * Build, sign, submit and wait — the shared live path. LIVE-PROVEN since
 * 2026-09-14 22:32Z through the worker legs (claim, submit, withdraw_worker —
 * see the header); every leg below reaches the network through here.
 */
export async function signAndSubmitManifest(
  manifest: string,
  identity: AgentIdentity,
  config: GuildClientConfig
): Promise<{ intentHash: string; status: TransactionStatus }> {
  const epoch = await getCurrentEpoch(config.gatewayBaseUrl);
  const signed = await buildSignedTransaction({ manifest, identity, currentEpoch: epoch });
  await submitTransaction(config.gatewayBaseUrl, signed.notarizedTransactionHex);
  const status = await waitForCommit(config.gatewayBaseUrl, signed.intentHash);
  return { intentHash: signed.intentHash, status };
}

/**
 * Claim a task on-chain with the AGENT badge. LIVE-PROVEN 2026-09-14 22:31:59Z:
 * the worker agent's key claimed smoke task 75 = chain task 11 on the Wave B
 * escrow through this function (bond 76.45 XRD, Claim Receipt #6#,
 * txid_rdx1k0t5enfz4knk649jp5m49yev5u5pc9arth8fl05yjksd3p765vys8zht24);
 * 15 more live claims committed on 2026-09-15.
 * Requires GUILD_AGENT_BADGE_RESOURCE + GUILD_AGENT_BADGE_LOCAL_ID (the smoke
 * claim presented the Member badge through them) and enough of the task's
 * reward token + fees in the agent account. The bond resource/amount are DERIVED from live chain state
 * BEFORE signing (`resolveClaimBond` — P4-5, Wave B's proportional bond; no
 * client-side constant is trusted), and the caller-supplied `workBrief` is
 * cross-checked against the component's committed work_brief_hash BEFORE
 * signing (assertWorkBriefMatchesChain — P4-3, the keystone check).
 * `workBrief` is required, not optional: there is no safe default that skips
 * binding the text the agent read to the money it stakes — a caller with
 * nothing to verify should pass GUILD_ALLOW_BRIEF_MISMATCH=1 deliberately,
 * not omit the argument.
 */
const NOT_SUBMITTED = Symbol('claim-not-submitted');

/**
 * True when claimTaskOnChain refused BEFORE signing anything — the badge env,
 * the bond read, the owner's ceiling, the brief guard, the manifest. Nothing
 * can be in flight, so no bond can post. Any other failure is ambiguous (the
 * transaction may have been submitted) and must be treated as a claim.
 */
export function claimWasNotSubmitted(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { [NOT_SUBMITTED]?: boolean })[NOT_SUBMITTED] === true;
}

export async function claimTaskOnChain(
  onChainTaskId: number,
  identity: AgentIdentity,
  config: GuildClientConfig,
  workBrief: WorkBriefInput,
  /**
   * A personal agent's owner rule (claim-gate.ts): the bond THIS function reads
   * and signs must be in `resource` and at most `maxAmount`. The gate's own
   * read happened earlier and separately; this holds the signed one to the
   * same rule, so the owner's cap binds the bond actually bonded.
   */
  bondCeiling?: { resource: string; maxAmount: string }
): Promise<{ intentHash: string; status: TransactionStatus }> {
  let manifest: string;
  try {
    if (!config.agentBadgeResource || !config.agentBadgeLocalId) {
      throw new Error(
        'Agent badge env not set (GUILD_AGENT_BADGE_RESOURCE / GUILD_AGENT_BADGE_LOCAL_ID) — ' +
          'on-chain claims stay disabled until this account holds a Guild badge (mint one with guild-worker mint-badge --live)'
      );
    }
    const bond = await resolveClaimBond(onChainTaskId, config);
    if (
      bondCeiling &&
      (bond.resource !== bondCeiling.resource || scaleDecimal(bond.amount) > scaleDecimal(bondCeiling.maxAmount))
    ) {
      throw new Error(
        `Refusing to sign claim_task — the bond read just before signing (${bond.amount} of ${bond.resource}) is outside ` +
          `the owner's ceiling (${bondCeiling.maxAmount} of ${bondCeiling.resource}). Nothing was signed.`
      );
    }
    await assertWorkBriefMatchesChain(onChainTaskId, workBrief, config);
    manifest = claimTaskManifest(
      config.escrowComponent,
      identity.address,
      config.agentBadgeResource,
      config.agentBadgeLocalId,
      onChainTaskId,
      bond.resource,
      bond.amount
    );
  } catch (error) {
    // Marked, not wrapped: the same error (class and message) reaches callers.
    // An error that cannot be marked (frozen, or not an object) is read as an
    // ambiguous claim — the conservative side.
    try {
      if (typeof error === 'object' && error !== null) (error as { [NOT_SUBMITTED]?: boolean })[NOT_SUBMITTED] = true;
    } catch {
      /* left unmarked */
    }
    throw error;
  }
  return signAndSubmitManifest(manifest, identity, config);
}

/**
 * Submit work on-chain (burns the Claim Receipt; the bond is HELD to
 * settlement since Wave B stage 5b, so nothing comes back here).
 * LIVE-PROVEN 2026-09-14 22:32:08Z: the 4-arg form committed for smoke task
 * 75 = chain task 11 through this function (receipt #6# burned,
 * txid_rdx12epx3k5gezzsawmk25yfengrvehk59jacuttnamf0p78mhh4mj3qg34wxm), and
 * again for task 90 = chain task 26 after the #656 brief-hash fix
 * (txid_rdx1ku54hn9g67xlvct7j6kcwd5dp09mtuav379rxwaavvgrxucv8tzs5np0yx,
 * 2026-09-15 09:18:55Z). `claimReceiptId` must be resolved from the agent
 * account's Claim Receipt NFTs (match ClaimReceiptData.task_id — worker.ts
 * does it with gateway.ts resolveClaimReceiptId; guild-app's twin is
 * src/lib/gateway.ts findClaimReceiptId).
 *
 * `workBrief` is required for the same reason it is required on
 * `claimTaskOnChain`: submit_task went 3-arg → 4-arg at Wave B step 4 and the
 * fourth argument is `brief_hash`, which the blueprint asserts against the
 * task's committed `work_brief_hash` (P4-3 submission validation). There is no
 * safe default — a wrong or absent hash is a submission the component refuses,
 * and inventing one here would move that failure from a type error to a
 * mainnet abort. So the brief travels the same way it does on the claim leg.
 */
export async function submitTaskOnChain(
  onChainTaskId: number,
  claimReceiptId: number,
  evidenceHashHex: string,
  identity: AgentIdentity,
  config: GuildClientConfig,
  workBrief: WorkBriefInput
): Promise<{ intentHash: string; status: TransactionStatus }> {
  const briefHashHex = await workBriefHash(
    workBrief.title,
    workBrief.description,
    workBrief.terms ?? null,
    workBrief.dueIso ?? null
  );
  const manifest = submitTaskManifest(
    config.escrowComponent,
    identity.address,
    config.claimReceiptResource,
    claimReceiptId,
    onChainTaskId,
    evidenceHashHex,
    briefHashHex
  );
  return signAndSubmitManifest(manifest, identity, config);
}

/**
 * Public, time-gated claim expiry. After a claim's deadline plus grace passes,
 * ANY funded key may expire it while it is still Claimed: the caller is paid a
 * bounty of `expire_bounty_pct` (0.1 live) of the forfeited claim_bond, the
 * remainder goes to the operator vault, and the task returns to Open. No
 * badge/receipt/proof needed.
 * UNTESTED-UNTIL-PILOT. Returns { intentHash, status }.
 *
 * Signature mirrors the other legs for the harness/gate1 --live wiring:
 * expireClaimOnChain(onChainTaskId, identity, config) positionally.
 */
export async function expireClaimOnChain(
  onChainTaskId: number,
  identity: AgentIdentity,
  config: GuildClientConfig
): Promise<{ intentHash: string; status: TransactionStatus }> {
  const manifest = expireClaimManifest(config.escrowComponent, identity.address, onChainTaskId);
  return signAndSubmitManifest(manifest, identity, config);
}

/**
 * Worker raises a dispute on a Submitted task (worker path — presents the Guild
 * Member badge it claimed with). Moves NO money; records the dispute + optional
 * evidence hash on-chain and flips the task to Disputed. The Member badge's local
 * id is resolved live from the worker account (it is string-derived, e.g.
 * `<guild_member_alice>`, not `#N#`). Returns { intentHash, status }.
 *
 * Signature mirrors claim/submit for the gate1-e2e --live dynamic import, which
 * calls raiseDisputeOnChain(onChainTaskId, identity, config) positionally. Pass an
 * optional evidence commitment via opts.evidenceHashHex (default: no evidence).
 */
export async function raiseDisputeOnChain(
  onChainTaskId: number,
  identity: AgentIdentity,
  config: GuildClientConfig,
  opts?: { evidenceHashHex?: string }
): Promise<{ intentHash: string; status: TransactionStatus }> {
  assertLiveDisputeAllowed('raise_dispute', config);
  if (!config.workerBadgeResource) {
    throw new Error(
      'Worker badge resource not set (GUILD_WORKER_BADGE_RESOURCE) — cannot resolve the ' +
        'Member badge to raise a dispute.'
    );
  }
  const badgeLocalId = await resolveBadgeLocalId(
    identity.address,
    config.workerBadgeResource,
    config.gatewayBaseUrl
  );
  if (!badgeLocalId) {
    throw new Error(
      `Worker account holds no ${config.workerBadgeResource} badge — cannot raise a dispute ` +
        '(the raiser must present the badge it claimed with).'
    );
  }
  const manifest = raiseDisputeManifest(
    config.escrowComponent,
    identity.address,
    config.workerBadgeResource,
    badgeLocalId,
    onChainTaskId,
    opts?.evidenceHashHex ?? null
  );
  return signAndSubmitManifest(manifest, identity, config);
}

/**
 * Public keeper finalize of a Disputed task after the 72h window — PULL form.
 * Callable by ANY funded fleet key (auto_resolve_dispute is PUBLIC on chain).
 * The manifest is a bare trigger: the component applies the default ruling
 * pinned on the task when the dispute was raised (the reward and the claim bond
 * split the same way) and credits both entitlements internally, so this
 * supplies no accounts, no amounts, and no ruling — the caller cannot route a payout, and
 * there is nothing to read from chain before signing. (The push era took a
 * SETTLEMENT-FACTS argument and derived routing from the component's default,
 * because the caller received both buckets; that surface died with the push
 * dispute lane.) Returns { intentHash, status }.
 */
export async function autoResolveDisputeOnChain(
  onChainTaskId: number,
  identity: AgentIdentity,
  config: GuildClientConfig
): Promise<{ intentHash: string; status: TransactionStatus }> {
  assertLiveDisputeAllowed('auto_resolve_dispute', config);
  const manifest = autoResolveDisputeManifest(config.escrowComponent, onChainTaskId);
  return signAndSubmitManifest(manifest, identity, config);
}

/**
 * Collect the worker's settled entitlement (P3-1).
 *
 * Under PULL, `approve_and_release` does not pay anyone — it credits an
 * entitlement that the payee must actively collect. This is that collection.
 *
 * ⚠️ `withdraw_worker(task_id, badge: Proof)` takes NO destination argument, by
 * design. The escrow deposits into `task.worker_account`, pinned at claim_task
 * and not chooseable by any caller — which is what makes presenting a
 * transferable badge safe here. Do not add a destination parameter: a stolen
 * badge still cannot redirect the money, and a parameter would imply otherwise.
 *
 * The badge presented is decided ON CHAIN by `claimer_is_agent`, not by what
 * this client happens to have configured — claiming with the Member badge and
 * withdrawing with the agent badge reverts on the blueprint's claimer check.
 */
export async function withdrawWorkerOnChain(
  onChainTaskId: number,
  badgeResource: string,
  badgeLocalId: string,
  identity: AgentIdentity,
  config: GuildClientConfig
): Promise<{ intentHash: string; status: TransactionStatus }> {
  const manifest = withdrawWorkerManifest(
    config.escrowComponent,
    identity.address,
    badgeResource,
    badgeLocalId,
    onChainTaskId
  );
  return signAndSubmitManifest(manifest, identity, config);
}

// ── Poster on-chain legs (P1-19) ─────────────────────────────────────────────
//
// Mirror the shape every worker leg above already has: build the byte-parity
// manifest, sign with the CALLER'S identity, submit, wait for commit.
// UNTESTED-UNTIL-PILOT — unlike the worker legs above, none of these has run
// live through this file: every poster leg on the Wave B escrow to date
// (create, approve, cancel, withdraw_poster — Gateway stream, read 2026-09-30)
// was signed by guild-app/scripts/poster-harness.mjs's own inline signer
// (lock_fee 2; gate1-e2e.mjs drives that harness too) or by a wallet. Offline
// construction + the pre-network validation guards are covered in tx.test.ts;
// the live round trip awaits a real `guild-poster --live` run against a
// funded POSTER_PRIVATE_KEY.
//
// `identity` here is the POSTER's identity — a caller loads it from
// `loadPosterPrivateKeyHex()` (config.ts), never `loadAgentPrivateKeyHex()`.
// Nothing in these functions enforces that distinction (an `AgentIdentity` is
// just a keypair + derived address, agnostic to which env var produced it);
// the separation is a CALLER discipline, enforced in guild-poster.ts.

/**
 * Custody ruling R1: move `amount` XRD from the agent's own account to the
 * wallet account recorded as its owner. A plain transfer — it never touches the
 * escrow — built by the same `transferXrdManifest` the self-funding path uses
 * (`try_deposit_or_abort`: an owner account that refuses the deposit aborts the
 * whole transaction, so the XRD stays put). The DECISIONS — which account, how
 * much — are made and tested in sweep.ts; this only signs what it is handed.
 */
export async function sweepXrdOnChain(
  ownerAccount: string,
  amount: string,
  identity: AgentIdentity,
  config: GuildClientConfig
): Promise<{ intentHash: string; status: TransactionStatus }> {
  const manifest = transferXrdManifest({
    from: identity.address,
    to: ownerAccount,
    amount,
    xrdResource: MAINNET_XRD,
  });
  return signAndSubmitManifest(manifest, identity, config);
}

/**
 * Fund a new task on-chain: withdraws `rewardXrd` + `computeInsuranceXrd`
 * insurance from the poster's account and calls `create_task`. `workBrief`
 * MUST be the DB-STORED title/description/terms/deadline — the same values
 * `POST /api/v1/tasks` just persisted — because the brief hash committed here
 * is what a later claim/submit is cross-checked against
 * (assertWorkBriefMatchesChain, above); hashing anything else would commit a
 * task the API's own record disagrees with.
 *
 * No arbiter-fee parameter: launch runs at "0" (no arbiter fee), matching
 * guild-app's `sendDepositTx` exactly — see `manifests.ts`'s
 * `createTaskManifest` doc. A future fee-bearing lane is a new parameter here,
 * not a silent default change.
 */
export async function createTaskOnChain(
  rewardXrd: number,
  identity: AgentIdentity,
  config: GuildClientConfig,
  workBrief: WorkBriefInput
): Promise<{
  intentHash: string;
  status: TransactionStatus;
  insuranceXrd: number;
  workBriefHashHex: string;
}> {
  const insuranceXrd = computeInsuranceXrd(rewardXrd);
  const workBriefHashHex = await workBriefHash(
    workBrief.title,
    workBrief.description,
    workBrief.terms ?? null,
    workBrief.dueIso ?? null
  );
  const manifest = createTaskManifest(
    config.escrowComponent,
    identity.address,
    rewardXrd,
    insuranceXrd,
    '0', // arbiter_fee_pct — no arbiter fee at launch (disputes auto-resolve); mirrors sendDepositTx
    workBriefHashHex
  );
  const result = await signAndSubmitManifest(manifest, identity, config);
  return { ...result, insuranceXrd, workBriefHashHex };
}

/**
 * Poster approves a Submitted task, releasing the reward + claim bond to the
 * worker's entitlement and the insurance to the poster's own entitlement
 * (PULL — neither party is paid until they separately withdraw). Presents the
 * poster's OWN Task Receipt as a proof; `config.taskReceiptResource` must be
 * the receipt resource of the SAME component `onChainTaskId` was funded on.
 */
export async function approveAndReleaseOnChain(
  onChainTaskId: number,
  identity: AgentIdentity,
  config: GuildClientConfig
): Promise<{ intentHash: string; status: TransactionStatus }> {
  const manifest = approveAndReleaseManifest(
    config.escrowComponent,
    identity.address,
    config.taskReceiptResource,
    onChainTaskId
  );
  return signAndSubmitManifest(manifest, identity, config);
}

/**
 * Poster cancels an Open (unclaimed) task, crediting reward + insurance BOTH
 * back to the poster's entitlement. Reverts on-chain once a worker has bonded
 * a claim — use `cancelTaskAfterClaimOnChain` from that point on.
 */
export async function cancelTaskOnChain(
  onChainTaskId: number,
  identity: AgentIdentity,
  config: GuildClientConfig
): Promise<{ intentHash: string; status: TransactionStatus }> {
  const manifest = cancelTaskManifest(
    config.escrowComponent,
    identity.address,
    config.taskReceiptResource,
    onChainTaskId
  );
  return signAndSubmitManifest(manifest, identity, config);
}

/**
 * Poster cancels a Claimed (not-yet-submitted) task. Reward + insurance credit
 * back to the poster; the worker's claim bond credits IN FULL to the worker's
 * own entitlement (the blueprint leaves `claimer_badge_id` set so the worker
 * can still collect it via `withdrawWorkerOnChain`) — this leg never shorts or
 * reroutes the bond, because under PULL it never touches this caller's
 * worktop at all. Reverts on-chain once work has been submitted — the dispute
 * or approve path is the recovery from Submitted onward.
 */
export async function cancelTaskAfterClaimOnChain(
  onChainTaskId: number,
  identity: AgentIdentity,
  config: GuildClientConfig
): Promise<{ intentHash: string; status: TransactionStatus }> {
  const manifest = cancelTaskAfterClaimManifest(
    config.escrowComponent,
    identity.address,
    config.taskReceiptResource,
    onChainTaskId
  );
  return signAndSubmitManifest(manifest, identity, config);
}

/**
 * Public, time-gated keeper call: finalize a Submitted task's release once its
 * review window has lapsed. ANY funded key may call this — it is not
 * poster-only on-chain (see `releaseAfterReviewTimeoutManifest`'s doc) — but it
 * lives alongside the poster legs because a poster who never reviews is
 * exactly who this exists to route around, and `guild-poster release-timeout`
 * is the operator-facing entry point for it.
 *
 * Pays exactly what `approveAndReleaseOnChain` pays and emits the SAME
 * `TaskReleasedEvent`, so confirming it against the Guild API uses
 * `kind: 'approve'` — never a distinct kind. See the manifest builder's doc
 * for why there is no separate confirm kind for this on the server.
 */
export async function releaseAfterReviewTimeoutOnChain(
  onChainTaskId: number,
  identity: AgentIdentity,
  config: GuildClientConfig
): Promise<{ intentHash: string; status: TransactionStatus }> {
  const manifest = releaseAfterReviewTimeoutManifest(config.escrowComponent, onChainTaskId);
  return signAndSubmitManifest(manifest, identity, config);
}

/**
 * Collect the poster's settled entitlement (the insurance back after an
 * approval or the review-timeout release; reward + insurance on either cancel;
 * the poster's share of the reward, the insurance and the worker's claim bond
 * after a dispute). Presents
 * the Task Receipt as a proof, deriving its local id from `onChainTaskId`
 * (mirrors `withdrawPosterManifest`'s own doc: the id is DERIVED, never a
 * parameter, so a caller cannot present one task's receipt against another).
 *
 * ⚠️ No destination argument, same reasoning as `withdrawWorkerOnChain`:
 * `withdraw_poster(task_id, receipt: Proof)` pays `task.poster`, pinned at
 * `create_task` — a stolen or borrowed receipt cannot redirect the money, and
 * a destination parameter here would imply a control this caller does not
 * have.
 */
export async function withdrawPosterOnChain(
  onChainTaskId: number,
  identity: AgentIdentity,
  config: GuildClientConfig
): Promise<{ intentHash: string; status: TransactionStatus }> {
  const manifest = withdrawPosterManifest(
    config.escrowComponent,
    identity.address,
    config.taskReceiptResource,
    onChainTaskId
  );
  return signAndSubmitManifest(manifest, identity, config);
}
