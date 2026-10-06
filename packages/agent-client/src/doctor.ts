// `guild-worker doctor` — the agent-readiness preflight. Answers ONE question:
// "can this key earn on the Guild marketplace right now, and if not, what is
// the FIRST thing to fix?" Every check yields an actionable hint.
//
// Read-only by design: no signing, no server writes — EXCEPT the opt-in
// `includeAuth` probe, which performs a real ROLA login (server side effect: a
// harmless user row for the agent address; the same write onboarding performs).
//
// Checks are pure over injectable deps (the worker.ts seam pattern), so tests
// drive every branch with fakes and zero network.

import { authenticateAgent } from './api.js';
import { badgeEnvExports, loadConfig, normalizeLocalId, type GuildClientConfig } from './config.js';
import {
  fetchGatewayStatus as realFetchGatewayStatus,
  fetchXrdBalance as realFetchXrdBalance,
  probeEscrowComponent as realProbeEscrowComponent,
  readOnChainClaimBondBasis as realReadOnChainClaimBondBasis,
  resolveBadgeLocalId as realResolveBadgeLocalId,
  type ClaimBondBasis,
} from './gateway.js';
import { AgentIdentity } from './identity.js';
import { findAgentPrivateKeyHex, resolveKeyFilePath } from './key-file.js';
import { localPairingFor, type AgentState } from './agent-state.js';
import { MIN_SWEEP_XRD, loadOwnerLink } from './sweep.js';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it — present on warn/fail. */
  hint?: string;
}

/** Which on-chain claim branch the current env selects. */
export type BadgeLane = 'member-badge' | 'agent-badge' | 'unbadged';

export interface DoctorReport {
  checks: CheckResult[];
  /** ready = no failing check (warns allowed). */
  verdict: 'ready' | 'not-ready';
  lane: BadgeLane;
  /** The agent's account address, when a key was present and parsed. */
  address: string | null;
}

/**
 * There is deliberately NO upper bound on an agent's balance.
 *
 * This used to be `CUSTODY_CAP_XRD = 100`, warning above that. Removed by
 * operator decision 2026-08-02: an agent is meant to earn and accrue XRD, so a
 * ceiling on its balance models the wrong thing entirely.
 *
 * It was wrong on its own terms, not just unwanted. The constant landed
 * 2026-07-19, a week BEFORE the 100 XRD/task reward was decided, so the two
 * identical numbers were a coincidence — and the effect was that a worker
 * completing ONE task tripped the warning. It fired on the success condition,
 * could not distinguish "this key became a treasury" from "this agent did its
 * job", and so warned continuously through the entire internal wave. A signal
 * that is always on is not a signal.
 *
 * The underfunded check below stays, because it protects something real: a
 * claim reverts if the account cannot cover bond + fees. That is a fact about
 * the transaction, not a preference about custody.
 *
 * ⚠️ REFINED 2026-09-21 (custody ruling R1) — NOT reversed. An agent with NO
 * recorded owner still has no upper bound, and doctor.test.ts still pins that.
 * What changed is that an agent can now record an OWNER wallet
 * (GUILD_OWNER_ACCOUNT, `onboard --owner`), and then its earnings have
 * somewhere to go: `withdraw --sweep-to` / `sweep` move everything above a
 * FLOAT to that wallet. Only for a linked agent does the `float` check below
 * exist, and what it reports is not "you earned too much" — it is "a sweep is
 * owed", with the one command that clears it. The 08-02 failure was a warning
 * that fired on success and had no remedy; this one has a remedy, and under
 * `--auto-withdraw --sweep-to owner` it never fires in steady state.
 */

/** lock_fee cap in tx.ts — the fee headroom a claim needs beyond the bond. */
export const FEE_HEADROOM_XRD = 5;

/** Injectable seams (real defaults; tests pass fakes, so no network). */
export interface DoctorDeps {
  fetchGatewayStatus: typeof realFetchGatewayStatus;
  fetchXrdBalance: typeof realFetchXrdBalance;
  resolveBadgeLocalId: typeof realResolveBadgeLocalId;
  probeEscrowComponent: typeof realProbeEscrowComponent;
  /** The claim-bond SHAPE the pointed-at component currently deploys — the
   * funding check's basis for "how much should this account hold" (Wave B). */
  readClaimBondBasis: typeof realReadOnChainClaimBondBasis;
  /** For the app-API probes (task board + .well-known/radix.json). */
  fetchFn: typeof fetch;
  /** ROLA login probe (includeAuth only). Defaults to a real GuildApiClient. */
  authenticate: (identity: AgentIdentity, config: GuildClientConfig) => Promise<{ id: string }>;
  /** This key's local pairing record (agent-state.ts) — picks the badge hint when `badgeSource` is omitted. */
  localPairing: (address: string, env: Record<string, string | undefined>) => AgentState | null;
}

/** Where this agent's Member badge comes from — decides what the badge check tells it to do. */
export type BadgeSource = 'self-mint' | 'owner-funding';

/**
 * The badge hint for a key that still has a pairing record (agent.json beside it): that
 * pairing's badge was to come with the owner's Fund & activate transaction, and a
 * self-mint under the pairing's name would leave that transaction unable to land
 * (bring-your-agent.md §3.3). Pairing is off for the beta (ruling 2026-10-03), so
 * Fund & activate is not on offer: the way forward is a key that was never paired.
 */
export const OWNER_FUNDING_BADGE_HINT =
  'This key has a pairing record, so mint-badge refuses it — and pairing, with the Fund & activate step that would have ' +
  'given it a badge, is off for the beta. `guild-agent status` shows where the record stands. ' +
  'To act as a badge, bring a key that was never paired and fund its account from your own wallet — `guild-worker doctor` ' +
  'on that key then says how to mint its badge.';

const REAL_DEPS: DoctorDeps = {
  fetchGatewayStatus: realFetchGatewayStatus,
  fetchXrdBalance: realFetchXrdBalance,
  resolveBadgeLocalId: realResolveBadgeLocalId,
  probeEscrowComponent: realProbeEscrowComponent,
  readClaimBondBasis: realReadOnChainClaimBondBasis,
  fetchFn: fetch,
  authenticate: authenticateAgent,
  localPairing: localPairingFor,
};

/**
 * From this key's local record. One that cannot be read is NOT read as "no
 * pairing": doctor then never suggests a self-mint (mint-badge would refuse it
 * anyway) and reports the read failure as its own check.
 */
function localBadgeSource(
  address: string,
  env: Record<string, string | undefined>,
  deps: DoctorDeps
): { source: BadgeSource; problem: string | null } {
  try {
    return { source: deps.localPairing(address, env) ? 'owner-funding' : 'self-mint', problem: null };
  } catch (error) {
    return { source: 'owner-funding', problem: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Badge holdings read that keeps "could not read" apart from "holds none":
 * resolveBadgeLocalId throws on an unreadable Gateway answer, and doctor
 * reports that as its own failing check instead of crashing or saying the
 * account holds no badge.
 */
async function readBadge(
  deps: DoctorDeps,
  account: string,
  resource: string,
  gatewayBaseUrl: string
): Promise<{ held: string | null; error: string | null }> {
  try {
    return { held: await deps.resolveBadgeLocalId(account, resource, gatewayBaseUrl), error: null };
  } catch (error) {
    return { held: null, error: error instanceof Error ? error.message : String(error) };
  }
}

const badgeUnreadable = (why: string): CheckResult => ({
  id: 'badge',
  label: 'badge',
  status: 'fail',
  detail: `could not read the account's badge holdings: ${why}`,
  hint: 'A Gateway hiccup, not a missing badge. Re-run doctor in a minute, or check GUILD_GATEWAY_URL.',
});

const skip = (id: string, label: string, why: string): CheckResult => ({
  id,
  label,
  status: 'skip',
  detail: why,
});

export async function runDoctor(options: {
  config?: GuildClientConfig;
  env?: Record<string, string | undefined>;
  /** Opt-in ROLA login probe (the one server-write check). */
  includeAuth?: boolean;
  /**
   * Where this agent's badge comes from. Omitted (`guild-agent status` and the fleet's
   * `guild-worker doctor`), it is 'owner-funding' only when this key has a local pairing
   * record, else 'self-mint' — the badge-first default.
   */
  badgeSource?: BadgeSource;
  deps?: Partial<DoctorDeps>;
}): Promise<DoctorReport> {
  const config = options.config ?? loadConfig();
  const env = options.env ?? process.env;
  const deps: DoctorDeps = { ...REAL_DEPS, ...options.deps };
  const checks: CheckResult[] = [];
  let lane: BadgeLane = 'unbadged';

  // ── 1. key ────────────────────────────────────────────────────────────────
  let identity: AgentIdentity | null = null;
  // The same sources the signing commands read (GUILD_AGENT_PRIVATE_KEY, else
  // the key file), so doctor's verdict is about the key `run` and `mint-badge`
  // would actually sign with.
  let keyHex: string | undefined;
  let keySource: 'env' | 'file' = 'env';
  let keyFileProblem: string | null = null;
  try {
    const found = findAgentPrivateKeyHex(env);
    keyHex = found?.keyHex;
    if (found) keySource = found.source;
  } catch (error) {
    keyFileProblem = error instanceof Error ? error.message : String(error);
  }
  if (keyFileProblem !== null) {
    checks.push({
      id: 'key',
      label: 'agent key',
      status: 'fail',
      detail: keyFileProblem,
      hint: 'Expect the file to hold 64 hex chars (32-byte ed25519) and be readable by this user. Fix the file, or export GUILD_AGENT_PRIVATE_KEY instead.',
    });
  } else if (!keyHex) {
    checks.push({
      id: 'key',
      label: 'agent key',
      status: 'fail',
      detail: `No agent key: GUILD_AGENT_PRIVATE_KEY is not set and there is no key file at ${resolveKeyFilePath(env)}.`,
      hint: 'This kit never creates a key — bring your own: export GUILD_AGENT_PRIVATE_KEY, or put it in the file GUILD_AGENT_KEY_FILE names.',
    });
  } else {
    try {
      identity = await AgentIdentity.fromPrivateKeyHex(keyHex);
      checks.push({
        id: 'key',
        label: 'agent key',
        status: 'pass',
        detail: `parses OK${keySource === 'file' ? ' (from the key file)' : ''} — account ${identity.address}`,
      });
    } catch (error) {
      checks.push({
        id: 'key',
        label: 'agent key',
        status: 'fail',
        detail: `GUILD_AGENT_PRIVATE_KEY does not parse: ${error instanceof Error ? error.message : String(error)}`,
        hint: 'Expect 64 hex chars (32-byte ed25519). Re-copy the key — no quotes, no 0x, no whitespace.',
      });
    }
  }

  // ── 2. gateway ────────────────────────────────────────────────────────────
  const status = await deps.fetchGatewayStatus(config.gatewayBaseUrl, deps.fetchFn);
  if (!status) {
    checks.push({
      id: 'gateway',
      label: 'radix gateway',
      status: 'fail',
      detail: `no ledger state from ${config.gatewayBaseUrl}`,
      hint: 'Check connectivity / GUILD_GATEWAY_URL (default https://mainnet.radixdlt.com).',
    });
  } else if (status.network !== 'mainnet') {
    checks.push({
      id: 'gateway',
      label: 'radix gateway',
      status: 'fail',
      detail: `gateway reports network "${status.network}" — the Guild is mainnet-only`,
      hint: 'Point GUILD_GATEWAY_URL at https://mainnet.radixdlt.com.',
    });
  } else {
    checks.push({
      id: 'gateway',
      label: 'radix gateway',
      status: 'pass',
      detail: `mainnet epoch ${status.epoch}, state version ${status.stateVersion}`,
    });
  }
  const chainReadable = status !== null && status.network === 'mainnet';

  // ── 3. guild API ──────────────────────────────────────────────────────────
  let apiReachable = false;
  try {
    const resp = await deps.fetchFn(`${config.apiBaseUrl}/api/v1/tasks?limit=1`);
    const body = resp.ok ? ((await resp.json()) as { ok?: boolean }) : null;
    if (body?.ok === true) {
      apiReachable = true;
      checks.push({
        id: 'api',
        label: 'guild api',
        status: 'pass',
        detail: `${config.apiBaseUrl} task board responds`,
      });
    } else {
      checks.push({
        id: 'api',
        label: 'guild api',
        status: 'fail',
        detail: `${config.apiBaseUrl}/api/v1/tasks → HTTP ${resp.status}`,
        hint: 'Check GUILD_API_URL (default https://radixguild.com) or the deploy.',
      });
    }
  } catch (error) {
    checks.push({
      id: 'api',
      label: 'guild api',
      status: 'fail',
      detail: `cannot reach ${config.apiBaseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      hint: 'Check connectivity / GUILD_API_URL.',
    });
  }

  // ── 4. dApp definition parity (.well-known/radix.json) ────────────────────
  if (apiReachable) {
    try {
      const resp = await deps.fetchFn(`${config.apiBaseUrl}/.well-known/radix.json`);
      const body = resp.ok
        ? ((await resp.json()) as { dApps?: { dAppDefinitionAddress?: string }[] })
        : null;
      const listed = (body?.dApps ?? []).map(d => d.dAppDefinitionAddress);
      if (listed.includes(config.dAppDefinitionAddress)) {
        checks.push({
          id: 'dapp',
          label: 'dApp definition',
          status: 'pass',
          detail: 'server .well-known/radix.json matches the client dApp definition',
        });
      } else {
        checks.push({
          id: 'dapp',
          label: 'dApp definition',
          status: 'warn',
          detail: `server lists [${listed.join(', ') || 'nothing'}], client uses ${config.dAppDefinitionAddress}`,
          hint: 'ROLA logins will fail if these diverge — align GUILD_DAPP_DEFINITION_ADDRESS with the deploy.',
        });
      }
    } catch {
      checks.push({
        id: 'dapp',
        label: 'dApp definition',
        status: 'warn',
        detail: 'could not read .well-known/radix.json',
        hint: 'Wallet verification and ROLA depend on it — check the deploy.',
      });
    }
  } else {
    checks.push(skip('dapp', 'dApp definition', 'guild api unreachable'));
  }

  /** The XRD balance the funding check read, reused by the float check (undefined = never read). */
  let lastBalance: number | null | undefined;
  /** What the funding check decided one claim needs (bond floor + fee headroom), and whether it came from chain. */
  let lastFundingTarget: { xrd: number; verified: boolean } | undefined;

  // ── 5. funding ────────────────────────────────────────────────────────────
  //
  // Wave B: the claim bond is no longer a flat, config-known constant, so this
  // check reads the LIVE basis first rather than trusting `config.claimBondXrd`
  // outright. A proportional component reports pct/floor/cap, not a single
  // number — the FLOOR is the cheapest a real claim could ever cost there, so
  // it is what this check funds against; the actual bond for any given task is
  // `>= floor` and scales with that task's reward, which is unknowable here
  // (there is no specific task yet — this is a preflight, not a claim). Note
  // this is also an XRD-only estimate: every task guild-app creates today
  // rewards in XRD, but a proportional bond on a non-XRD-reward task would need
  // THAT token instead, which an XRD balance check cannot see.
  //
  // If the live basis can't be read at all, this falls back to
  // `config.claimBondXrd` as a last-resort ESTIMATE and says so explicitly —
  // doctor is advisory only (no signing happens here), so a stale/unverifiable
  // number degrades to "best guess, unconfirmed" rather than blocking the
  // whole check the way `resolveClaimBond` (tx.ts) fails closed before a real
  // signature.
  if (!identity) {
    checks.push(skip('funding', 'account funding', 'no usable key'));
  } else if (!chainReadable) {
    checks.push(skip('funding', 'account funding', 'gateway unreachable'));
  } else {
    // Only reached once a key AND a reachable gateway are both confirmed, so
    // this is the one place the (network) bond-basis read is worth doing.
    const bondBasis: ClaimBondBasis | null = await deps.readClaimBondBasis(
      config.escrowComponent,
      config.gatewayBaseUrl
    );
    const fundingBasis: { estimateXrd: number; label: string; verified: boolean } =
      bondBasis === null
        ? {
            estimateXrd: config.claimBondXrd,
            label: `~${config.claimBondXrd} (UNVERIFIED estimate — could not read the live bond shape)`,
            verified: false,
          }
        : bondBasis.mode === 'flat'
          ? { estimateXrd: Number(bondBasis.amountXrd), label: `${bondBasis.amountXrd} (flat, chain-verified)`, verified: true }
          : {
              estimateXrd: Number(bondBasis.floor),
              label: `≥${bondBasis.floor} (proportional: ${bondBasis.pct} of the reward, floor ${bondBasis.floor}, capped ${bondBasis.cap}; XRD-denominated tasks only)`,
              verified: true,
            };
    const fundingTarget = fundingBasis.estimateXrd + FEE_HEADROOM_XRD;
    lastFundingTarget = { xrd: fundingTarget, verified: fundingBasis.verified };
    const balance = await deps.fetchXrdBalance(identity.address, config.gatewayBaseUrl, deps.fetchFn);
    lastBalance = balance;
    if (balance === null) {
      checks.push({
        id: 'funding',
        label: 'account funding',
        status: 'fail',
        detail: 'could not read the XRD balance from the Gateway',
        hint: 'Transient Gateway error — retry.',
      });
    } else if (balance < fundingTarget) {
      checks.push({
        id: 'funding',
        label: 'account funding',
        status: 'fail',
        detail: `${balance} XRD — claiming needs ≥ ${fundingTarget} (bond ${fundingBasis.label} + ~${FEE_HEADROOM_XRD} fees)`,
        hint: fundingBasis.verified
          ? `Send ${Math.ceil(fundingTarget - balance)} XRD to ${identity.address}`
          : `Send ${Math.ceil(fundingTarget - balance)} XRD to ${identity.address} (this target is unverified — retry doctor once the Gateway is reachable to get the live figure)`,
      });
    } else {
      checks.push({
        id: 'funding',
        label: 'account funding',
        status: fundingBasis.verified ? 'pass' : 'warn',
        detail: fundingBasis.verified
          ? `${balance} XRD (bond ${fundingBasis.label} + fees covered)`
          : `${balance} XRD — likely covers bond ${fundingBasis.label} + fees, but the live bond shape could not be verified`,
        ...(fundingBasis.verified ? {} : { hint: 'Retry once the Gateway/escrow component is reachable for a chain-verified figure.' }),
      });
    }
  }

  // ── 5b. owner float (custody ruling R1) — only for an agent with an owner ──
  //
  // No owner recorded → no check at all: there is nowhere for money to go, and
  // an unlinked agent keeps the 2026-08-02 "no upper bound" behaviour exactly.
  // "Not recorded" is decided from the raw env BEFORE anything is parsed, so a
  // stray or malformed GUILD_FLOAT_XRD on an unlinked agent cannot conjure a
  // failing `float` check out of nothing (review finding, 2026-09-21).
  if (env.GUILD_OWNER_ACCOUNT?.trim()) try {
    const link = loadOwnerLink(env);
    if (link.ownerAccount) {
      const ownerTail = `…${link.ownerAccount.slice(-8)}`;
      const ceiling = Number(link.floatXrd) + Number(MIN_SWEEP_XRD);
      if (identity && link.ownerAccount === identity.address) {
        checks.push({
          id: 'float',
          label: 'owner float',
          status: 'fail',
          detail: "GUILD_OWNER_ACCOUNT is this agent's own account.",
          hint: 'The owner must be a wallet account you hold the seed phrase for, not the agent key.',
        });
      } else if (lastFundingTarget && Number(link.floatXrd) < lastFundingTarget.xrd) {
        // A float smaller than the cheapest possible claim is a self-inflicted
        // outage: the first sweep leaves an agent that can never claim again, and
        // the claim failure that follows would say nothing about the float.
        checks.push({
          id: 'float',
          label: 'owner float',
          status: 'fail',
          detail: `the float is ${link.floatXrd} XRD, but one claim needs ≥ ${lastFundingTarget.xrd} XRD (the ${lastFundingTarget.verified ? 'live' : 'estimated'} bond floor + ~${FEE_HEADROOM_XRD} fees) — after a sweep this agent could not claim anything`,
          hint: `Set GUILD_FLOAT_XRD to at least ${Math.ceil(lastFundingTarget.xrd)} — more if your agent claims tasks whose 10% bond is larger than the floor.`,
        });
      } else if (lastBalance === undefined || lastBalance === null) {
        checks.push(skip('float', 'owner float', 'balance not read'));
      } else if (lastBalance > ceiling) {
        checks.push({
          id: 'float',
          label: 'owner float',
          status: 'fail',
          detail: `${lastBalance} XRD on this key — a sweep is owed: the float is ${link.floatXrd} XRD and the rest belongs in the owner wallet ${ownerTail}`,
          hint: 'guild-worker sweep            (preview)   then   guild-worker sweep --live',
        });
      } else {
        checks.push({
          id: 'float',
          label: 'owner float',
          status: 'pass',
          detail: `${lastBalance} XRD, within the ${link.floatXrd} XRD float — earnings sweep to the owner wallet ${ownerTail}`,
        });
      }
    }
  } catch (error) {
    checks.push({
      id: 'float',
      label: 'owner float',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      hint: 'Fix GUILD_OWNER_ACCOUNT / GUILD_FLOAT_XRD in the agent env.',
    });
  }

  // ── 6. badge / lane ───────────────────────────────────────────────────────
  const local = options.badgeSource === undefined && identity ? localBadgeSource(identity.address, env, deps) : null;
  const badgeSource: BadgeSource = options.badgeSource ?? local?.source ?? 'self-mint';
  if (local?.problem) {
    checks.push({
      id: 'pairing-record',
      label: 'pairing record',
      status: 'warn',
      detail: `this key's local pairing record could not be read: ${local.problem}`,
      hint: 'agent.json is only a cache of a pairing and nothing rebuilds it (pairing is off for the beta); mint-badge refuses this key until it reads. Move it aside — keep a copy if this agent was ever activated: the file holds its pinned owner.',
    });
  }
  if (!identity) {
    checks.push(skip('badge', 'badge', 'no usable key'));
  } else if (!chainReadable) {
    checks.push(skip('badge', 'badge', 'gateway unreachable'));
  } else if (config.agentBadgeResource && config.agentBadgeLocalId) {
    const isMemberResource = config.agentBadgeResource === config.workerBadgeResource;
    const laneName = isMemberResource ? 'member-badge' : 'agent-badge';
    const { held, error: badgeReadError } = await readBadge(
      deps,
      identity.address,
      config.agentBadgeResource,
      config.gatewayBaseUrl
    );
    const expected = normalizeLocalId(config.agentBadgeLocalId);
    if (badgeReadError !== null) {
      checks.push(badgeUnreadable(badgeReadError));
    } else if (!held) {
      checks.push({
        id: 'badge',
        label: 'badge',
        status: 'fail',
        detail: `env selects the ${laneName} lane but the account holds no ${config.agentBadgeResource} NFT`,
        hint: isMemberResource
          ? badgeSource === 'owner-funding'
            ? OWNER_FUNDING_BADGE_HINT
            : 'Mint one: guild-worker mint-badge --username <name> --live'
          : 'GAGENT is operator-minted — mint it to this account (scripts/deploy-agent-badge-controller.ts) or switch to the Member-badge lane.',
      });
    } else if (normalizeLocalId(held) !== expected) {
      checks.push({
        id: 'badge',
        label: 'badge',
        status: 'fail',
        detail: `GUILD_AGENT_BADGE_LOCAL_ID says ${expected} but the account holds ${held}`,
        hint: `Env drift — set GUILD_AGENT_BADGE_LOCAL_ID to the held id (${held}).`,
      });
    } else {
      lane = laneName;
      checks.push({
        id: 'badge',
        label: 'badge',
        status: 'pass',
        detail: `${laneName} lane — holds ${held}${isMemberResource ? ' (on-chain claim branch: claimer_is_agent = false)' : ' (GAGENT agent branch)'}`,
      });
    }
  } else {
    const { held: heldMember, error: memberReadError } = await readBadge(
      deps,
      identity.address,
      config.workerBadgeResource,
      config.gatewayBaseUrl
    );
    if (memberReadError !== null) {
      checks.push(badgeUnreadable(memberReadError));
    } else if (heldMember) {
      checks.push({
        id: 'badge',
        label: 'badge',
        status: 'warn',
        detail: `Member badge held (${heldMember}) but the badge env is unset — on-chain claims stay disabled`,
        hint: badgeEnvExports(config.workerBadgeResource, heldMember).join('; '),
      });
    } else {
      checks.push({
        id: 'badge',
        label: 'badge',
        status: 'fail',
        detail: 'no badge on the account and no badge env set',
        hint:
          badgeSource === 'owner-funding'
            ? OWNER_FUNDING_BADGE_HINT
            : 'guild-worker mint-badge --username <name>   (preview first, then add --live)',
      });
    }
  }

  // ── 7. escrow component ───────────────────────────────────────────────────
  if (!chainReadable) {
    checks.push(skip('escrow', 'escrow component', 'gateway unreachable'));
  } else if (await deps.probeEscrowComponent(config.escrowComponent, config.gatewayBaseUrl)) {
    checks.push({
      id: 'escrow',
      label: 'escrow component',
      status: 'pass',
      detail: `${config.escrowComponent} is live and has the expected shape`,
    });
  } else {
    checks.push({
      id: 'escrow',
      label: 'escrow component',
      status: 'fail',
      detail: `${config.escrowComponent} not readable as a guild escrow component`,
      // Until kit 0.7.2 this hint said a stale component costs claimers their bond. It
      // does not: a claim that reverts moves no bond (escrow lib.rs claim_task), only its fee.
      hint: 'Check GUILD_ESCROW_COMPONENT — it must name the live escrow component: every claim, submit and withdrawal this client signs goes to the component it names.',
    });
  }

  // ── 8. work function ──────────────────────────────────────────────────────
  const doWorkCmd = env.GUILD_DOWORK_CMD;
  checks.push(
    doWorkCmd
      ? {
          id: 'dowork',
          label: 'work function',
          status: 'pass',
          detail: `GUILD_DOWORK_CMD is set (${doWorkCmd.length > 48 ? `${doWorkCmd.slice(0, 48)}…` : doWorkCmd})`,
        }
      : {
          id: 'dowork',
          label: 'work function',
          status: 'warn',
          detail: 'GUILD_DOWORK_CMD is not set',
          hint: 'guild-worker run --live refuses without it — point it at a command that reads a task brief on stdin and writes the submission to stdout.',
        }
  );

  // ── 9. auth (opt-in — performs a real ROLA login = a server-side user row) ─
  if (options.includeAuth) {
    if (!identity) {
      checks.push(skip('auth', 'rola login', 'no usable key'));
    } else if (!apiReachable) {
      checks.push(skip('auth', 'rola login', 'guild api unreachable'));
    } else {
      try {
        const user = await deps.authenticate(identity, config);
        checks.push({
          id: 'auth',
          label: 'rola login',
          status: 'pass',
          detail: `authenticated — server user ${user.id}`,
        });
      } catch (error) {
        checks.push({
          id: 'auth',
          label: 'rola login',
          status: 'fail',
          detail: `login failed: ${error instanceof Error ? error.message : String(error)}`,
          hint: 'Check GUILD_ROLA_ORIGIN / GUILD_DAPP_DEFINITION_ADDRESS against the deploy (see the dApp definition check).',
        });
      }
    }
  }

  return {
    checks,
    verdict: checks.some(c => c.status === 'fail') ? 'not-ready' : 'ready',
    lane,
    address: identity?.address ?? null,
  };
}

const GLYPH: Record<CheckStatus, string> = { pass: '✓', warn: '⚠', fail: '✗', skip: '○' };

/** Human rendering — one aligned line per check, hints indented, verdict last. */
export function renderDoctorReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map(c => c.label.length));
  const lines = report.checks.flatMap(c => [
    ` ${GLYPH[c.status]} ${c.label.padEnd(width)}  ${c.detail}`,
    ...(c.hint ? [`   ${' '.repeat(width)}  ↳ ${c.hint}`] : []),
  ]);
  const failing = report.checks.filter(c => c.status === 'fail').length;
  lines.push('');
  lines.push(
    report.verdict === 'ready'
      ? `READY — lane: ${report.lane}${report.address ? `, account ${report.address}` : ''}`
      : `NOT READY — ${failing} check${failing === 1 ? '' : 's'} failing (fix the first ✗ above and re-run)`
  );
  return lines.join('\n');
}
