// Member-badge self-mint — the typed, tested port of the proven
// guild-app/scripts/poster-harness.mjs `mint-badge` path (which ran the Gate-1
// worker's badge onto mainnet). `public_mint(username)` on the BadgeManager is
// PERMISSIONLESS — the same method radixguild.com/mint drives through the
// wallet — so a funded headless worker can badge itself without an operator.
//
// Safety posture:
//   • DRY-RUN BY DEFAULT and fully offline: prints the manifest + derived ids,
//     touches no network, needs no key. `live: true` is the only signing path.
//   • Live pre-checks fail closed: requires an identity, a minimally funded
//     account, and refuses nothing on duplicates — an already-held badge is
//     returned as success (idempotent onboarding), not re-minted.
//   • This mints the MEMBER badge (the "claim_task takes either" pilot lane).
//     GAGENT — the true agent-badge lane — is operator-only by design (owner
//     proof required); see scripts/deploy-agent-badge-controller.ts.
//   • A PAIRED agent never self-mints (docs/design/bring-your-agent.md §3.3):
//     its badge comes with the owner's Fund & activate transaction, which
//     mints under the pairing's name and aborts whole if that name is taken —
//     so a self-mint under the same name would leave the pairing unfundable.
//     Pairing is off for the beta (ruling 2026-10-03): the Guild answers
//     AGENT_NOT_PAIRED to every account, so a badge-first agent — a key that
//     was never paired — passes this check and mints for itself.
//     Refused on the local record (offline, dry-run too) and, before signing,
//     on the Guild's own answer; a live mint that cannot get that answer is
//     refused, never assumed unpaired. The local record is read beside
//     GUILD_AGENT_KEY_FILE, so a raw GUILD_AGENT_PRIVATE_KEY pointed elsewhere
//     skips it in a dry run — the live path's Guild check does not depend on it.

import { GuildApiClient, GuildApiError, PAIRING_ERROR_CODES } from './api.js';
import { localPairingFor, type AgentState } from './agent-state.js';
import { badgeEnvExports, bareLocalId, type GuildClientConfig } from './config.js';
import type { AgentIdentity } from './identity.js';
import { untrusted } from './secrets.js';
import {
  fetchXrdBalance as realFetchXrdBalance,
  resolveBadgeLocalId as realResolveBadgeLocalId,
} from './gateway.js';
import { publicMintManifest } from './manifests.js';
import { signAndSubmitManifest, type TransactionStatus } from './tx.js';

/**
 * Headless username rule. The badge's NonFungibleLocalId is string-derived
 * (`<guild_member_{username}>`), and a string local id only admits
 * `[a-zA-Z0-9_]` with 64 chars total — the 13-char `guild_member_` prefix
 * leaves 51 for the username. (The web /mint page allowed `[a-zA-Z0-9_-]{1,64}`
 * until 2026-09-24, a superset the chain refused; it now uses this same rule.)
 * Enforcing it keeps the local id byte-deterministic from the username, which
 * the headless claim path (env GUILD_AGENT_BADGE_LOCAL_ID) depends on.
 */
export const MINT_USERNAME_RE = /^[a-zA-Z0-9_]{1,51}$/;

/**
 * Below this XRD balance a live mint is refused. Must be ≥ the 5-XRD lock_fee
 * that signAndSubmitManifest prepends (publicMintManifest carries no lock of
 * its own): the LOCK is for the full 5 even though the mint costs well under
 * 1 — a 2–4.99 XRD account would pass a lower guard and then fail the fee lock.
 * Unused lock refunds on commit.
 */
export const MIN_MINT_BALANCE_XRD = 5;

/** How long to wait for the Gateway to index the fresh badge NFT. */
const RESOLVE_ATTEMPTS = 6;
const RESOLVE_INTERVAL_MS = 5_000;

// Valid-format placeholder for keyless dry-run previews (mirrors the
// poster-harness DRYRUN_ACCOUNT — validateAddress needs a real bech32m form).
// Derived from a fixed dummy Ed25519 public key (32 bytes of 0x01): no private
// key exists, so nobody can sign for it or take anything a mis-submitted preview
// sends there. Replaced RX-10 (the old dApp definition on the compromised seed)
// on 2026-09-29.
const DRYRUN_ACCOUNT = 'account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw';

/** What the Guild says about this key's account, for the paired-agent refusal. */
export type ServerPairing = { paired: false } | { paired: true; reason: string };

/** Thrown when mint-badge refuses a paired (or suspended) agent. Nothing was signed. */
export class PairedAgentMintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairedAgentMintError';
  }
}

const OWNER_MINTS =
  "A paired agent's Member badge is minted by its owner's funding transaction, so mint-badge will not self-mint it. " +
  'Pairing is off for the beta: to act as a badge, bring a key that was never paired.';

/** Injectable seams (real defaults; tests pass fakes, so no network). */
export interface MintDeps {
  fetchXrdBalance: typeof realFetchXrdBalance;
  resolveBadgeLocalId: typeof realResolveBadgeLocalId;
  signAndSubmit: (
    manifest: string,
    identity: AgentIdentity,
    config: GuildClientConfig
  ) => Promise<{ intentHash: string; status: TransactionStatus }>;
  sleep: (ms: number) => Promise<void>;
  /** This key's local pairing record (agent-state.ts), or null. Offline. */
  localPairing: (address: string, env: Record<string, string | undefined>) => AgentState | null;
  /** The Guild's answer: is this account a paired agent? Throws when it cannot say. */
  serverPairing: (identity: AgentIdentity, config: GuildClientConfig, log: (line: string) => void) => Promise<ServerPairing>;
  // NB the real serverPairing signs in (ROLA), which creates the server user row
  // onboard's stage 4 would create anyway.
}

/** Sign-in is not on the client's 429 backoff (it IS the re-auth), so the pairing check waits itself. */
export const PAIRING_SIGN_IN_RETRIES = 2;
export const PAIRING_SIGN_IN_WAIT_MS = 30_000;

/**
 * Run a Guild sign-in, waiting out a 429 (sign-in is not on the client's
 * backoff: it IS the re-auth). Up to PAIRING_SIGN_IN_RETRIES waits of
 * PAIRING_SIGN_IN_WAIT_MS; any other error, or a 429 that outlasts them, is
 * rethrown for the caller to read. Shared by the pairing check and onboard's
 * own sign-in, so an `onboard --live` that signs in twice waits on both.
 */
export async function signInWithRetry<T>(
  signIn: () => Promise<T>,
  options: { sleep?: (ms: number) => Promise<void>; log?: (line: string) => void } = {}
): Promise<T> {
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const log = options.log ?? (() => {});
  for (let attempt = 0; ; attempt++) {
    try {
      return await signIn();
    } catch (error) {
      if (!(error instanceof GuildApiError && error.status === 429) || attempt >= PAIRING_SIGN_IN_RETRIES) throw error;
      log(`the Guild rate-limited the sign-in; waiting ${PAIRING_SIGN_IN_WAIT_MS / 1000}s before trying again`);
      await sleep(PAIRING_SIGN_IN_WAIT_MS);
    }
  }
}

const SUSPENDED: ServerPairing = {
  paired: true,
  reason: 'The Guild has suspended this account, so mint-badge will not mint for it.',
};

function cannotConfirm(why: string): Error {
  return new Error(`could not confirm with the Guild that this agent is unpaired (${why}). A live mint stays refused until it can.`);
}

/**
 * Ask the Guild whether this key's account is a paired agent. Exactly one
 * answer means "unpaired": GET /agents/me's own AGENT_NOT_PAIRED — which is what the
 * server answers to every account while pairing is off. A suspended
 * account (403 ACCOUNT_SUSPENDED, at sign-in or on the read) is refused.
 * Anything else — a failed or rate-limited sign-in, a 404 from a wrong
 * GUILD_API_URL, a 5xx — throws: a live mint never assumes an agent is unpaired.
 */
export async function askGuildPairing(
  api: Pick<GuildApiClient, 'authenticate' | 'agentMe'>,
  identity: AgentIdentity,
  options: { sleep?: (ms: number) => Promise<void>; log?: (line: string) => void } = {}
): Promise<ServerPairing> {
  const message = (error: unknown) => untrusted(error instanceof Error ? error.message : String(error));

  try {
    await signInWithRetry(() => api.authenticate(identity), options);
  } catch (error) {
    if (error instanceof GuildApiError && error.code === 'ACCOUNT_SUSPENDED') return SUSPENDED;
    if (error instanceof GuildApiError && error.status === 429) {
      throw cannotConfirm('the Guild is rate-limiting sign-ins from here — wait a minute and retry');
    }
    throw cannotConfirm(`sign-in failed: ${message(error)} — retry, or check GUILD_API_URL`);
  }

  try {
    const me = await api.agentMe();
    return { paired: true, reason: `The Guild reports this agent as paired ("${untrusted(me.label)}", ${me.status}). ${OWNER_MINTS}` };
  } catch (error) {
    if (error instanceof GuildApiError && error.code === PAIRING_ERROR_CODES.notPaired) return { paired: false };
    // Suspension is checked on every route (withAuth), and retiring an agent suspends it.
    if (error instanceof GuildApiError && error.code === 'ACCOUNT_SUSPENDED') return SUSPENDED;
    throw cannotConfirm(`${message(error)} — retry`);
  }
}

const REAL_DEPS: MintDeps = {
  fetchXrdBalance: realFetchXrdBalance,
  resolveBadgeLocalId: realResolveBadgeLocalId,
  signAndSubmit: signAndSubmitManifest,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  localPairing: localPairingFor,
  serverPairing: (identity, config, log) => askGuildPairing(new GuildApiClient(config), identity, { log }),
};

/** The refusal for a local pairing record — worded for where that pairing stands. */
function localPairingReason(state: AgentState): string {
  const label = untrusted(state.label ?? '?');
  if (state.ownerAccount) {
    return `This agent is paired ("${label}", owner …${state.ownerAccount.slice(-8)}). ${OWNER_MINTS}`;
  }
  return (
    `This agent has a pairing record ("${label}", ${state.status ?? 'pending'}). ${OWNER_MINTS} ` +
    '`guild-agent status` shows where that record stands with the Guild.'
  );
}

export interface MintResult {
  dryRun: boolean;
  account: string;
  badgeResource: string;
  /** Bare local id (`guild_member_x`) — chain-resolved on live, derived on dry-run. */
  badgeLocalId: string;
  /** The exact exports to persist into the agent's env file. */
  envLines: string[];
  /** Dry-run only: the manifest that WOULD be signed. */
  manifest?: string;
  /** Live only: committed mint tx (absent when the badge was already held). */
  intentHash?: string;
  /** Live only: the account already held a Member badge — nothing was signed. */
  alreadyHeld?: boolean;
  /** Live only: commit succeeded but the Gateway hadn't indexed the NFT yet. */
  unresolvedAfterCommit?: boolean;
}


export async function mintMemberBadge(options: {
  username: string;
  live: boolean;
  /** Required for live; optional for dry-run (placeholder account otherwise). */
  identity: AgentIdentity | null;
  config: GuildClientConfig;
  /** Where the local pairing record is looked up (beside GUILD_AGENT_KEY_FILE); default process.env. */
  env?: Record<string, string | undefined>;
  deps?: Partial<MintDeps>;
  log?: (line: string) => void;
}): Promise<MintResult> {
  const { username, live, identity, config } = options;
  const deps: MintDeps = { ...REAL_DEPS, ...options.deps };
  const log = options.log ?? (() => {});

  if (!MINT_USERNAME_RE.test(username)) {
    throw new Error(
      `Invalid username "${username}" — headless mints allow [a-zA-Z0-9_], max 51 chars ` +
        '(stricter than the web /mint form: the badge local id must stay a valid ' +
        'NonFungibleLocalId so the claim path can derive it deterministically).'
    );
  }

  // Before any preview or signing: a paired agent's badge is its owner's to mint.
  if (identity) {
    const local = deps.localPairing(identity.address, options.env ?? process.env);
    if (local) throw new PairedAgentMintError(localPairingReason(local));
  }

  const badgeResource = config.workerBadgeResource;
  const derivedLocalId = `guild_member_${username}`;
  const account = identity?.address ?? DRYRUN_ACCOUNT;
  const manifest = publicMintManifest(config.badgeManagerComponent, username, account);

  if (!live) {
    log(`DRY-RUN public_mint("${username}") → ${account}`);
    log(identity ? '' : '(no key in env — previewing against a placeholder account)');
    return {
      dryRun: true,
      account,
      badgeResource,
      badgeLocalId: derivedLocalId,
      manifest,
      envLines: badgeEnvExports(badgeResource, derivedLocalId),
    };
  }

  // ── live path (the only signing branch) ──────────────────────────────────
  if (!identity) {
    throw new Error(
      'Live mint needs the agent key — set GUILD_AGENT_PRIVATE_KEY (or drop --live for a preview).'
    );
  }

  // The local record is only a cache (it may be missing); the Guild decides.
  const server = await deps.serverPairing(identity, config, log);
  if (server.paired) throw new PairedAgentMintError(server.reason);

  // Idempotency first: an account that already holds a Member badge gets its
  // existing id back instead of a second NFT.
  const held = await deps.resolveBadgeLocalId(account, badgeResource, config.gatewayBaseUrl);
  if (held) {
    log(`Account already holds a Member badge (${held}) — nothing to mint.`);
    return {
      dryRun: false,
      account,
      badgeResource,
      badgeLocalId: bareLocalId(held),
      alreadyHeld: true,
      envLines: badgeEnvExports(badgeResource, held),
    };
  }

  const balance = await deps.fetchXrdBalance(account, config.gatewayBaseUrl);
  if (balance === null) {
    throw new Error('Could not read the account balance from the Gateway — retry, or check GUILD_GATEWAY_URL.');
  }
  if (balance < MIN_MINT_BALANCE_XRD) {
    throw new Error(
      `Account ${account} holds ${balance} XRD — a live mint needs ≥ ${MIN_MINT_BALANCE_XRD} XRD for fees. ` +
        'Fund the account first (guild-worker onboard shows the full funding target).'
    );
  }

  log(`public_mint("${username}") → ${account} (signing…)`);
  const { intentHash, status } = await deps.signAndSubmit(manifest, identity, config);
  if (status !== 'CommittedSuccess') {
    throw new Error(`public_mint not committed: ${status} (${intentHash})`);
  }
  log(`committed: ${intentHash}`);

  // Confirm on-ledger (Gateway indexing can lag the commit by a few seconds).
  for (let attempt = 0; attempt < RESOLVE_ATTEMPTS; attempt++) {
    const resolved = await deps.resolveBadgeLocalId(account, badgeResource, config.gatewayBaseUrl);
    if (resolved) {
      return {
        dryRun: false,
        account,
        badgeResource,
        badgeLocalId: bareLocalId(resolved),
        intentHash,
        envLines: badgeEnvExports(badgeResource, resolved),
      };
    }
    await deps.sleep(RESOLVE_INTERVAL_MS);
  }
  log('WARNING: mint committed but the Gateway has not indexed the badge yet — run `guild-worker doctor` in a minute to confirm.');
  return {
    dryRun: false,
    account,
    badgeResource,
    badgeLocalId: derivedLocalId,
    intentHash,
    unresolvedAfterCommit: true,
    envLines: badgeEnvExports(badgeResource, derivedLocalId),
  };
}
