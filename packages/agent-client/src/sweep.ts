// sweep.ts — custody ruling R1 (2026-09-21): a worker agent is DISPOSABLE.
//
// WHY THIS EXISTS
// ---------------
// A worker agent's key is a raw server key: no seed phrase, one file, on a box.
// On 2026-09-20 two such keys were found holding 57% of the operator's XRD,
// because every reward a worker collected simply stayed on it. The ruling that
// followed: a worker holds a FLOAT (enough for a claim bond and fees) and
// nothing else — earnings leave for the owner's wallet on every withdraw — so a
// lost or stolen worker key costs at most the float plus one live bond.
//
// This module is that leg: move everything above the float to the ONE account
// recorded as this agent's owner.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// ----------------------------------
// - It never sweeps to an address it was merely handed. When an owner is
//   recorded (GUILD_OWNER_ACCOUNT, written by `onboard --owner`), that is the
//   only legal destination: a `--sweep-to` that names anything else is REFUSED,
//   not honoured. An agent loop reads text written by strangers; "send it
//   here instead" must not be one flag away from working.
// - It never touches the escrow. `withdraw_worker` still pays the account the
//   escrow pinned at claim (withdraw.ts); this is a plain XRD transfer out of
//   that account afterwards, in its own transaction. If it fails, the money is
//   still the agent's — the safe direction.
// - It never uses a float. Every amount is exact 18dp integer arithmetic
//   (`scaleDecimal`), the same discipline the claim bond uses.
// - It is not a balance cap on an unlinked agent. With no owner recorded there
//   is nowhere for money to go, and `doctor` keeps its 2026-08-02 behaviour: no
//   upper bound. The float only means something once there is an owner.

import { loadConfig, MAINNET_XRD } from './config.js';
import type { GuildClientConfig } from './config.js';
import { fetchXrdBalanceExact } from './gateway.js';
import type { AgentIdentity } from './identity.js';
import type { AgentState } from './agent-state.js';
import { formatAttos, scaleDecimal, transferXrdManifest } from './manifests.js';
import { describeCommitFailure, sweepXrdOnChain } from './tx.js';

/** What a linked worker keeps: one floor-sized claim bond (76.45) plus fees, with room for a larger task. */
export const DEFAULT_FLOAT_XRD = '200';

/** Below this much excess a sweep is not worth its own network fee. */
export const MIN_SWEEP_XRD = '1';

const ACCOUNT_RE = /^account_rdx1[0-9a-z]{54}$/;
const DECIMAL_RE = /^\d{1,12}(\.\d{1,18})?$/;

/** The recorded link between this agent and the wallet that owns it. */
export interface OwnerLink {
  /** Null when no owner is recorded — then nothing is swept and no float applies. */
  ownerAccount: string | null;
  /** Plain decimal XRD string. Always set; only meaningful when an owner is. */
  floatXrd: string;
}

/**
 * Read the owner link from env. THROWS on a malformed value rather than
 * falling back: a typo in the owner address must stop the run, never quietly
 * become "no owner" (which would leave earnings on the key) or a default.
 */
export function loadOwnerLink(env: Record<string, string | undefined> = process.env): OwnerLink {
  const owner = env.GUILD_OWNER_ACCOUNT?.trim() || null;
  if (owner !== null && !ACCOUNT_RE.test(owner)) {
    throw new Error(
      'GUILD_OWNER_ACCOUNT is set but is not a mainnet account address (account_rdx1…, 66 characters). ' +
        'Fix it or unset it — it is never guessed.'
    );
  }
  const rawFloat = env.GUILD_FLOAT_XRD?.trim();
  const floatXrd = rawFloat ? rawFloat : DEFAULT_FLOAT_XRD;
  if (!DECIMAL_RE.test(floatXrd) || scaleDecimal(floatXrd) <= 0n) {
    throw new Error(
      `GUILD_FLOAT_XRD must be a positive plain decimal (e.g. "200"), got "${floatXrd}". ` +
        'A zero float would sweep the XRD the next claim bond needs.'
    );
  }
  return { ownerAccount: owner, floatXrd };
}

/**
 * `onboard --owner <account>`: decide whether that account may be recorded as
 * this agent's owner, and produce the env lines that record it. Pure — this
 * process never persists env itself (same stance as the generated key and the
 * badge lines: printed once, the operator puts them in the agent host env).
 *
 * An owner already recorded wins over the flag, for the same reason
 * `--sweep-to` cannot override it: changing where money goes is a deliberate
 * env edit, never a flag.
 */
export function ownerLinkEnvLines(
  requestedOwner: string,
  agentAccount: string,
  env: Record<string, string | undefined> = process.env
): { ok: true; owner: string; envLines: string[] } | { ok: false; refusal: SweepRefusal; message: string } {
  let link: OwnerLink;
  try {
    link = loadOwnerLink(env);
  } catch (error) {
    return { ok: false, refusal: 'link-invalid', message: error instanceof Error ? error.message : String(error) };
  }
  const dest = resolveSweepDestination(requestedOwner.trim(), link, agentAccount);
  if (!dest.ok) return { ok: false, refusal: dest.refusal, message: explainSweepRefusal(dest.refusal) };
  return {
    ok: true,
    owner: dest.owner,
    envLines: [`GUILD_OWNER_ACCOUNT=${dest.owner}`, `GUILD_FLOAT_XRD=${link.floatXrd}`],
  };
}

/**
 * The owner link of a PERSONAL agent (`guild-agent`), from its agent.json and
 * never from env: the owner pinned at activation is the only destination, and
 * the float is what that owner funded (bring-your-agent.md §3.7). It refuses
 * rather than guessing — no record, a record for a different key, or no pinned
 * owner (not activated yet) all mean there is nowhere this agent may pay. This
 * is the ONE mapping both `guild-agent sweep` and `run` use.
 */
export function ownerLinkFromState(
  state: AgentState | null,
  agentAddress: string
): { ok: true; link: OwnerLink } | { ok: false; why: string } {
  if (!state) {
    return {
      ok: false,
      why: 'this agent has no local record (agent.json beside its key), so its owner is unknown — and pairing is off for the beta, so nothing rebuilds it. `guild-agent sweep` only serves a paired agent; for a badge-first key use `guild-worker sweep` (owner from GUILD_OWNER_ACCOUNT).',
    };
  }
  if (state.address !== agentAddress) {
    return { ok: false, why: `the local record belongs to ${state.address}, not to this key's account ${agentAddress}.` };
  }
  if (!state.ownerAccount) {
    return { ok: false, why: 'no owner is pinned yet — the agent has not been activated, so there is nowhere it may pay.' };
  }
  return { ok: true, link: { ownerAccount: state.ownerAccount, floatXrd: state.floatXrd ?? DEFAULT_FLOAT_XRD } };
}

export type SweepRefusal =
  /** No agent key in env — the account to sweep FROM is unknown. */
  | 'no-identity'
  /** GUILD_OWNER_ACCOUNT or GUILD_FLOAT_XRD is set but malformed. Never guessed around. */
  | 'link-invalid'
  /** No owner recorded and none named — there is nowhere to send anything. */
  | 'owner-not-set'
  /** `--sweep-to` names an account other than the recorded owner. */
  | 'owner-mismatch'
  /** The destination is not a mainnet account address. */
  | 'owner-invalid'
  /** The destination is the agent's own account. */
  | 'owner-is-agent'
  /** The XRD balance could not be read — UNKNOWN, never "nothing to sweep". */
  | 'balance-unreadable'
  /** The balance is at or under the float (plus the minimum worth moving). */
  | 'within-float'
  /** Signed and submitted, but the Gateway did not report CommittedSuccess. */
  | 'not-committed';

export function explainSweepRefusal(reason: SweepRefusal): string {
  switch (reason) {
    case 'no-identity':
      return 'No agent identity available. Set GUILD_AGENT_PRIVATE_KEY — even a dry run needs the account address, to read its balance and to check the owner is a different account.';
    case 'link-invalid':
      return 'GUILD_OWNER_ACCOUNT or GUILD_FLOAT_XRD is set but malformed. Fix the agent env — a malformed owner or float is never guessed around, and nothing is swept until it is right.';
    case 'owner-not-set':
      return 'No owner wallet is recorded for this agent, so there is nowhere to sweep to. Run `guild-worker onboard --owner <your wallet account>` and persist the GUILD_OWNER_ACCOUNT line it prints, or pass --sweep-to <account>.';
    case 'owner-mismatch':
      return 'Refusing: --sweep-to names a different account from the recorded owner (GUILD_OWNER_ACCOUNT). The recorded owner is the only destination this agent will pay. To change owners, change GUILD_OWNER_ACCOUNT deliberately — not with a flag.';
    case 'owner-invalid':
      return 'Refusing: the sweep destination is not a mainnet account address (account_rdx1…, 66 characters).';
    case 'owner-is-agent':
      return "Refusing: the sweep destination is this agent's own account. The owner must be a wallet account you hold the seed phrase for, not the agent key.";
    case 'balance-unreadable':
      return "Could not read this account's XRD balance from the Gateway. That is UNKNOWN, not \"nothing to sweep\" — retry.";
    case 'within-float':
      return 'Nothing to sweep: the balance is within the float this agent keeps for claim bonds and fees.';
    case 'not-committed':
      return 'NOT swept: the transfer was signed and submitted but the Gateway did not report CommittedSuccess. The XRD is still in the agent account — check the intent hash before retrying (an Unknown status means the Gateway timed out waiting, not that the transaction failed).';
  }
}

/**
 * Decide WHERE a sweep may go. Pure.
 *
 * `requested` is what the caller typed after --sweep-to: an account address,
 * the literal word "owner" (use the recorded one), or undefined.
 */
export function resolveSweepDestination(
  requested: string | undefined,
  link: OwnerLink,
  agentAccount: string
): { ok: true; owner: string } | { ok: false; refusal: SweepRefusal } {
  // "owner" is a keyword, matched after trimming and in any case — ` Owner` is a
  // typo for the keyword, not an address. An explicitly EMPTY destination
  // (`--sweep-to=`) is malformed input, never a request for the recorded owner.
  const typed = requested?.trim();
  if (typed === '') return { ok: false, refusal: 'owner-invalid' };
  const named = typed === undefined || typed.toLowerCase() === 'owner' ? null : typed;
  const owner = named ?? link.ownerAccount;
  if (!owner) return { ok: false, refusal: 'owner-not-set' };
  if (!ACCOUNT_RE.test(owner)) return { ok: false, refusal: 'owner-invalid' };
  // The recorded owner wins over anything typed — see the header comment.
  if (named !== null && link.ownerAccount !== null && named !== link.ownerAccount) {
    return { ok: false, refusal: 'owner-mismatch' };
  }
  if (owner === agentAccount) return { ok: false, refusal: 'owner-is-agent' };
  return { ok: true, owner };
}

/**
 * Decide HOW MUCH may go: everything above the float, exactly. Pure.
 *
 * The network fee for the sweep itself is paid out of the float that stays
 * behind, which is what a float is for — so the amount is NOT reduced by a fee
 * guess, and the balance after a sweep reads "float minus one fee".
 */
export function resolveSweepAmount(
  balanceXrd: string | null,
  floatXrd: string
): { ok: true; amount: string } | { ok: false; refusal: 'balance-unreadable' | 'within-float' | 'link-invalid' } {
  if (balanceXrd === null) return { ok: false, refusal: 'balance-unreadable' };
  let balance: bigint;
  try {
    balance = scaleDecimal(balanceXrd);
  } catch {
    return { ok: false, refusal: 'balance-unreadable' };
  }
  // loadOwnerLink validates the float, but a caller may hand in its own link:
  // a float this cannot parse, or one that is not positive, refuses — it never throws
  // and it is never read as zero (which would sweep the XRD the next bond needs).
  let float: bigint;
  try {
    if (!DECIMAL_RE.test(floatXrd)) throw new Error('not a plain decimal');
    float = scaleDecimal(floatXrd);
  } catch {
    return { ok: false, refusal: 'link-invalid' };
  }
  if (float <= 0n) return { ok: false, refusal: 'link-invalid' };
  const excess = balance - float;
  if (excess < scaleDecimal(MIN_SWEEP_XRD)) return { ok: false, refusal: 'within-float' };
  return { ok: true, amount: formatAttos(excess) };
}

export interface SweepResult {
  /** True when nothing was SWEPT; `refusal` says why. */
  refused: boolean;
  refusal?: SweepRefusal;
  message?: string;
  /** The manifest that would be (or was) signed. */
  manifest?: string;
  dryRun: boolean;
  owner?: string;
  amount?: string;
  balance?: string;
  floatXrd?: string;
  intentHash?: string;
  status?: string;
}

export interface SweepOptions {
  /** False (default) previews the manifest and signs nothing. */
  live: boolean;
  identity: AgentIdentity | null;
  /** What followed --sweep-to: an address, "owner", or undefined. */
  requested?: string;
  link?: OwnerLink;
  config?: GuildClientConfig;
  log?: (line: string) => void;
  deps?: {
    fetchXrdBalanceExact: typeof fetchXrdBalanceExact;
    sweepXrdOnChain: typeof sweepXrdOnChain;
  };
}

/**
 * Move everything above the float to the owner, or explain why not.
 * Dry-run by default, like every signing verb here. On `--live`,
 * `refused: false` means the transfer COMMITTED.
 */
export async function sweepToOwner(opts: SweepOptions): Promise<SweepResult> {
  const config = opts.config ?? loadConfig();
  const log = opts.log ?? (() => {});
  const deps = opts.deps ?? { fetchXrdBalanceExact, sweepXrdOnChain };
  const { live, identity } = opts;

  // Identity FIRST, then the link — and a malformed link comes back as a
  // refusal like every other reason not to sweep. It used to be read before
  // the identity check and THROWN, which escaped the structured result: a
  // script reading the `SWEEP {…}` line got nothing at all for that one failure.
  if (!identity) {
    return { refused: true, refusal: 'no-identity', message: explainSweepRefusal('no-identity'), dryRun: true };
  }
  let link: OwnerLink;
  try {
    link = opts.link ?? loadOwnerLink();
  } catch (error) {
    return {
      refused: true,
      refusal: 'link-invalid',
      message: `${error instanceof Error ? error.message : String(error)} ${explainSweepRefusal('link-invalid')}`,
      dryRun: !live,
    };
  }
  const refuse = (refusal: SweepRefusal, extra: Partial<SweepResult> = {}): SweepResult => ({
    refused: true,
    refusal,
    message: explainSweepRefusal(refusal),
    dryRun: !live,
    floatXrd: link.floatXrd,
    ...extra,
  });

  const dest = resolveSweepDestination(opts.requested, link, identity.address);
  if (!dest.ok) return refuse(dest.refusal);

  log(`reading the XRD balance of ${identity.address}`);
  const balance = await deps.fetchXrdBalanceExact(identity.address, config.gatewayBaseUrl);
  const amt = resolveSweepAmount(balance, link.floatXrd);
  if (!amt.ok) return refuse(amt.refusal, { owner: dest.owner, balance: balance ?? undefined });

  const manifest = transferXrdManifest({
    from: identity.address,
    to: dest.owner,
    amount: amt.amount,
    xrdResource: MAINNET_XRD,
  });
  const facts = { owner: dest.owner, amount: amt.amount, balance: balance!, floatXrd: link.floatXrd };

  if (!live) {
    log(`would sweep ${amt.amount} XRD to ${dest.owner}, keeping the ${link.floatXrd} XRD float`);
    return { refused: false, manifest, dryRun: true, ...facts };
  }

  log(`signing a transfer of ${amt.amount} XRD to ${dest.owner}`);
  const { intentHash, status } = await deps.sweepXrdOnChain(dest.owner, amt.amount, identity, config);
  log(`transfer signed (${intentHash}, ${status})`);
  if (status !== 'CommittedSuccess') {
    const why = await describeCommitFailure(config.gatewayBaseUrl, status, intentHash, 'sweep');
    return {
      refused: true,
      refusal: 'not-committed',
      message: `${why}. ${explainSweepRefusal('not-committed')}`,
      manifest,
      dryRun: false,
      intentHash,
      status,
      ...facts,
    };
  }
  return { refused: false, manifest, dryRun: false, intentHash, status, ...facts };
}
