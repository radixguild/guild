// `guild-worker onboard` — the seed→funded→badged→verified→earning path as ONE
// guided command. It walks the same stages doctor checks, stops at the first
// gap with the exact next action, and (with --live) performs the one stage it
// CAN automate — the Member-badge self-mint. Funding stays manual for an
// operator-provisioned fleet (XRD comes from the operator's wallet, by design
// — this command never holds or moves fleet funds) OR can be scripted by a
// genuinely autonomous agent that already controls XRD elsewhere, via
// `transferXrdManifest` (manifests.ts) + `signAndSubmitManifest` — see the
// README's "Self-funding" section. Key custody stays with the operator: the
// key is BROUGHT (GUILD_AGENT_PRIVATE_KEY) — this command never creates,
// prints or stores one (ruling 2026-10-03; key-never-made.test.ts).
//
// Stages:
//   1. key       — the key in GUILD_AGENT_PRIVATE_KEY must parse; none → stop
//                  and say how to bring one.
//   2. funding   — needs claim bond + fee headroom on the account.
//   3. badge     — Member-badge self-mint (dry-run preview; --live signs).
//   4. verified  — real ROLA login (creates the server-side user row).
//   5. earning   — prints the worker commands (dry-run → --live → --on-chain).

import { authenticateAgent, GuildApiError } from './api.js';
import { badgeEnvExports, loadConfig, type GuildClientConfig } from './config.js';
import {
  fetchXrdBalance as realFetchXrdBalance,
  readOnChainClaimBondBasis as realReadOnChainClaimBondBasis,
  resolveBadgeLocalId as realResolveBadgeLocalId,
} from './gateway.js';
import { AgentIdentity } from './identity.js';
import { ownerLinkEnvLines } from './sweep.js';
import { FEE_HEADROOM_XRD } from './doctor.js';
import { mintMemberBadge, signInWithRetry, type MintDeps } from './mint.js';
import { AgentStateCorruptError, localPairingFor, type AgentState } from './agent-state.js';

export type OnboardStage = 'key' | 'funding' | 'badge' | 'verified' | 'earning';

export interface OnboardOutcome {
  /** The furthest stage COMPLETED ('earning' = fully onboarded). */
  reached: OnboardStage | 'none';
  address: string | null;
  /**
   * Success semantics for exit codes: true ONLY for a fully onboarded agent.
   * Every stop — no key, underfunded, unbadged, gateway/auth failure — is
   * false, so a gating wrapper (`guild-worker onboard && start`) can never
   * proceed blocked.
   */
  ok: boolean;
  /** Set when a stage stopped the walk; explains what the operator does next. */
  stoppedBecause?: string;
}

/** Injectable seams (real defaults; tests pass fakes, so no network). */
export interface OnboardDeps {
  fetchXrdBalance: typeof realFetchXrdBalance;
  resolveBadgeLocalId: typeof realResolveBadgeLocalId;
  /** The claim-bond SHAPE the pointed-at component currently deploys — see
   * doctor.ts's funding check for the same reasoning (Wave B). */
  readClaimBondBasis: typeof realReadOnChainClaimBondBasis;
  mint: typeof mintMemberBadge;
  mintDeps?: Partial<MintDeps>;
  authenticate: (identity: AgentIdentity, config: GuildClientConfig) => Promise<{ id: string }>;
  /** This key's local pairing record (agent-state.ts), or null. */
  localPairing: (address: string, env: Record<string, string | undefined>) => AgentState | null;
  /** The wait between rate-limited sign-in attempts (tests pass a fake). */
  sleep: (ms: number) => Promise<void>;
}

const REAL_DEPS: OnboardDeps = {
  fetchXrdBalance: realFetchXrdBalance,
  resolveBadgeLocalId: realResolveBadgeLocalId,
  readClaimBondBasis: realReadOnChainClaimBondBasis,
  mint: mintMemberBadge,
  authenticate: authenticateAgent,
  localPairing: localPairingFor,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

export async function runOnboard(options: {
  live?: boolean;
  username?: string;
  /** Custody ruling R1: the wallet account that owns this agent (`--owner`). */
  owner?: string;
  config?: GuildClientConfig;
  env?: Record<string, string | undefined>;
  deps?: Partial<OnboardDeps>;
  log?: (line: string) => void;
}): Promise<OnboardOutcome> {
  const config = options.config ?? loadConfig();
  const env = options.env ?? process.env;
  const deps: OnboardDeps = { ...REAL_DEPS, ...options.deps };
  const log = options.log ?? console.log;

  // ── stage 1: key ──────────────────────────────────────────────────────────
  const keyHex = env.GUILD_AGENT_PRIVATE_KEY;
  if (!keyHex) {
    log('No agent key (GUILD_AGENT_PRIVATE_KEY unset). This kit never creates a key — bring your own:');
    log('  export GUILD_AGENT_PRIVATE_KEY=<your 32-byte hex ed25519 key>   (an existing capped-balance key; never a treasury)');
    log('Then re-run `guild-worker onboard`. Agents here are badge-first: the badge you mint for that key is what acts.');
    return { reached: 'none', address: null, ok: false, stoppedBecause: 'no key in env' };
  }
  let identity: AgentIdentity;
  try {
    identity = await AgentIdentity.fromPrivateKeyHex(keyHex);
  } catch (error) {
    // A set-but-malformed key must give the same guided stop doctor's key check does,
    // not an ungraceful fatal/stack. The parse error is a fixed, value-free string
    // (assertHex), so it never echoes the key.
    log(`✗ key — GUILD_AGENT_PRIVATE_KEY does not parse: ${error instanceof Error ? error.message : String(error)}`);
    log('  Expect 64 hex chars (32-byte ed25519) — no 0x, quotes, or whitespace.');
    log('  Re-copy it — this kit does not make keys, so it has to be one you already hold.');
    return { reached: 'none', address: null, ok: false, stoppedBecause: 'key in env does not parse' };
  }
  log(`✓ key — account ${identity.address}`);

  // ── stage 1a: a key with a pairing record is not a fleet worker ───────────
  // Pairing is off for the beta, but a record left by an earlier pairing means
  // its owner's funding transaction owns the badge; the manual funding and
  // self-mint below would fight it (§3.3).
  let pairing: AgentState | null;
  try {
    pairing = deps.localPairing(identity.address, env);
  } catch (error) {
    if (!(error instanceof AgentStateCorruptError)) throw error;
    log(`✗ key — ${error.message}`);
    return { reached: 'none', address: identity.address, ok: false, stoppedBecause: 'agent state file unreadable' };
  }
  if (pairing) {
    log('✗ key — this key has a pairing record (agent.json beside it), which onboard does not set up.');
    log('  Pairing is off for the beta, and that record means the owner\'s Fund & activate transaction was to give it its badge.');
    log('  See where it stands: guild-agent status — or bring a key that was never paired.');
    return { reached: 'none', address: identity.address, ok: false, stoppedBecause: 'paired personal agent' };
  }

  // ── stage 1b: owner link (custody ruling R1) — only when --owner is given ──
  //
  // A worker key is disposable: it keeps a float and its earnings leave for the
  // owner's WALLET account. Recording the owner is what makes `withdraw
  // --sweep-to owner`, `sweep` and doctor's float check mean anything. A bad
  // --owner STOPS onboarding: carrying on would leave the operator believing a
  // link exists that was never recorded.
  if (options.owner !== undefined) {
    const linkResult = ownerLinkEnvLines(options.owner, identity.address, env);
    if (!linkResult.ok) {
      log(`✗ owner — ${linkResult.message}`);
      return { reached: 'key', address: identity.address, ok: false, stoppedBecause: `--owner refused (${linkResult.refusal})` };
    }
    log(`✓ owner — …${linkResult.owner.slice(-8)} will receive everything above the float. Persist these in the agent env:`);
    for (const line of linkResult.envLines) log(`    ${line}`);
    log('  Then: `guild-worker withdraw <taskId> --sweep-to owner --live`, or `guild-worker run --live --on-chain --auto-withdraw --sweep-to owner`.');
    log('  The owner must be a wallet account you hold the seed phrase for — never another server key.');
  }

  // ── stage 2: funding ──────────────────────────────────────────────────────
  //
  // Wave B: read the LIVE claim-bond shape rather than trusting
  // config.claimBondXrd outright — same reasoning as doctor.ts's funding
  // check (a proportional component's FLOOR is the cheapest a real claim
  // could ever cost; the config constant is only a fallback estimate when the
  // live shape can't be read, and is labelled as such below).
  const bondBasis = await deps.readClaimBondBasis(config.escrowComponent, config.gatewayBaseUrl);
  const bondEstimateXrd =
    bondBasis === null
      ? config.claimBondXrd
      : bondBasis.mode === 'flat'
        ? Number(bondBasis.amountXrd)
        : Number(bondBasis.floor);
  const bondLabel =
    bondBasis === null
      ? `~${config.claimBondXrd} (UNVERIFIED estimate)`
      : bondBasis.mode === 'flat'
        ? bondBasis.amountXrd
        : `≥${bondBasis.floor} (proportional, XRD-denominated tasks only)`;
  const fundingTarget = bondEstimateXrd + FEE_HEADROOM_XRD;
  const balance = await deps.fetchXrdBalance(identity.address, config.gatewayBaseUrl);
  if (balance === null) {
    log('✗ funding — could not read the balance from the Gateway; retry in a moment.');
    return { reached: 'key', address: identity.address, ok: false, stoppedBecause: 'gateway unreadable' };
  }
  if (balance < fundingTarget) {
    log(`✗ funding — ${balance} XRD; earning needs ≥ ${fundingTarget} (claim bond ${bondLabel} + ~${FEE_HEADROOM_XRD} fees).`);
    log('');
    log(`  Send ${Math.ceil(fundingTarget - balance)} XRD from your wallet to:`);
    log(`    ${identity.address}`);
    log('');
    log('  Then re-run `guild-worker onboard`. (Capped balances only — this is a hot key.)');
    return { reached: 'key', address: identity.address, ok: false, stoppedBecause: 'account underfunded' };
  }
  log(`✓ funding — ${balance} XRD`);

  // ── stage 3: badge (Member-badge self-mint — the automatable stage) ───────
  const heldMember = await deps.resolveBadgeLocalId(
    identity.address,
    config.workerBadgeResource,
    config.gatewayBaseUrl
  );
  let badgeEnvLines: string[];
  if (heldMember) {
    log(`✓ badge — Member badge already held (${heldMember})`);
    badgeEnvLines = badgeEnvExports(config.workerBadgeResource, heldMember);
  } else if (options.live && options.username) {
    const result = await deps.mint({
      username: options.username,
      live: true,
      identity,
      config,
      env,
      deps: deps.mintDeps,
      log: line => log(`  mint: ${line}`),
    });
    log(`✓ badge — minted ${result.badgeLocalId}${result.intentHash ? ` (${result.intentHash})` : ''}`);
    badgeEnvLines = result.envLines;
  } else {
    log('✗ badge — no Member badge on the account.');
    log('');
    log('  Preview the self-mint (offline, signs nothing):');
    log('    guild-worker mint-badge --username <name>');
    log('  Then mint for real — either:');
    log('    guild-worker mint-badge --username <name> --live');
    log('    guild-worker onboard   --username <name> --live   # continues from here');
    return { reached: 'funding', address: identity.address, ok: false, stoppedBecause: 'unbadged — mint needs an explicit --live' };
  }
  if (!env.GUILD_AGENT_BADGE_RESOURCE || !env.GUILD_AGENT_BADGE_LOCAL_ID) {
    log('');
    log('  Persist the badge env (claims stay disabled without it):');
    for (const line of badgeEnvLines) log(`    ${line}`);
    log('');
  }

  // ── stage 4: verified (real ROLA login — creates the server user row) ─────
  // A live mint just signed in too (its pairing check), so this is the run's
  // second sign-in: it waits out the auth rate limit the same way.
  try {
    const user = await signInWithRetry(() => deps.authenticate(identity, config), { sleep: deps.sleep, log: line => log(`  ${line}`) });
    log(`✓ verified — ROLA login OK, server user ${user.id}`);
  } catch (error) {
    log(`✗ verified — login failed: ${error instanceof Error ? error.message : String(error)}`);
    log(
      error instanceof GuildApiError && error.status === 429
        ? '  The Guild is rate-limiting sign-ins from here — wait a minute and re-run onboard.'
        : '  Run `guild-worker doctor` — the dApp-definition check usually explains this.'
    );
    return { reached: 'badge', address: identity.address, ok: false, stoppedBecause: 'ROLA login failed' };
  }

  // ── stage 5: earning ──────────────────────────────────────────────────────
  log('');
  log('READY. Start earning:');
  log('  bun run worker                        # one dry-run cycle (poll + report, signs nothing)');
  log('  bun run worker -- --live              # post submissions via GUILD_DOWORK_CMD');
  log('  bun run worker -- --live --on-chain   # + sign the claim/submit escrow legs (real XRD)');
  if (!env.GUILD_DOWORK_CMD) {
    log('');
    log('  ⚠ GUILD_DOWORK_CMD is unset — --live refuses without it (your agent command:');
    log('    reads the task brief on stdin, writes the submission to stdout).');
  }
  return { reached: 'earning', address: identity.address, ok: true };
}
