// Guild marketplace client configuration.
//
// Every value mirrors the server side of the contract:
//   guild-app/src/lib/config.ts   (addresses; this repository)
//   guild-app/src/lib/rola.ts     (ROLA origin / dApp definition / network)
//   the agent-auth design note (accepted; kept in the private operations repository)
//
// Defaults target MAINNET + the live https://radixguild.com deploy. Env vars
// exist so the pilot can re-point without code changes; see ../README.md and
// the GUILD AGENT CLIENT section of the repo root .env.example.

/** Radix mainnet network id — the only network the Guild targets. */
export const NETWORK_ID = 1;

/**
 * The escrow component this client SHIPS pointed at — i.e. production, the one
 * radixguild.com runs on. Wave B, live since the 2026-09-13 cutover (see
 * ESCROW-ADDRESSES.md in the private operations repository — canonical, chain-verified same day).
 *
 * ⚠️ Exported for one measured reason, and it is not stylistic. Until
 * 2026-08-19 `tx.ts` kept its OWN copy of this address for the live-dispute
 * fuse, and at the cutover the `DEFAULTS` entry below was repointed while that
 * copy was left on the retired push component — three files apart, in the same
 * package, in the same pass. The fuse then compared production against a dead
 * address and never fired: `raiseDisputeOnChain` / `autoResolveDisputeOnChain`
 * would have signed against the live component with no override and no warning.
 * Two tests covered the fuse and both PASSED, because both hand-typed the
 * retired address as their input — a guard, a test for the guard, and the one
 * input the guard exists to refuse never fed to it.
 *
 * One constant, imported by both, is what makes that divergence impossible.
 * Repoint HERE at a cutover and the fuse moves with it.
 *
 * 🔴 AG-13 (2026-09-14): this constant itself was the thing that drifted at
 * the NEXT cutover — it still pointed at the retired PULL component (P2,
 * 2026-08-17) the day after Wave B went live 2026-09-13. The one-constant
 * design above stopped the fuse from silently disarming a second time (it
 * WAS still comparing against the constant, correctly — the constant was just
 * wrong), but nothing before this fix would have caught a wrong-but-consistent
 * address on its own. That is what `escrow-address-drift.test.ts` is for.
 */
export const LIVE_ESCROW_COMPONENT =
  'component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly';

/**
 * The live guild-nft-swap component (P7-05): instantiated 2026-09-15 23:08:53Z,
 * same address as guild-app/src/lib/config.ts NFT_SWAP_COMPONENT (pinned by
 * escrow-address-drift.test.ts). Its listing-receipt resource is NOT a config
 * value: swap.ts reads it from the component's own state on every use, so no
 * partial override can pair this address with a stale receipt.
 */
export const LIVE_NFT_SWAP_COMPONENT =
  'component_rdx1cq80zarwh84mmrkn95xc7glgg5yvz0vkvqs9amxsnpwxuhkldd5mp4';

/** The package the live swap component was instantiated from (parity MATCH at
 *  publish, 2026-09-15) — the default `nftSwapPackage`, pinned to guild-app's
 *  NFT_SWAP_PACKAGE by escrow-address-drift.test.ts. */
export const LIVE_NFT_SWAP_PACKAGE =
  'package_rdx1p53j5yst59jhgc8ljap7266sd0nxgm2lndp2z6a4ddsprkn7e9ssmv';

/**
 * Production escrow components that have been RETIRED. They are still real,
 * still hold state, and pointing a dispute leg at one is never something a
 * caller means to do — so the fuse refuses these too.
 *
 * Mirrors guild-app `src/lib/escrow-history.ts`. ⚠️ That file carries a hard
 * "never import from app runtime code" rule because guild-app's launch-check
 * CHECK 7 asserts the BUILT artifact contains exactly one escrow-shaped
 * component. That constraint does NOT reach here: guild-app does not import
 * this package (verified 2026-08-19 — the only `agent-client` strings in
 * `guild-app/src` are prose in `app/agents/page.tsx` and two comments), so
 * these literals cannot reach the artifact CHECK 7 scans.
 *
 * ⚠️ As of 2026-09-14, guild-app's `escrow-history.ts` has NOT yet appended
 * the PULL component retired below — its own "append here at every cutover"
 * rule was missed at Wave B, same as this package's addresses were. Not fixed
 * here (out of this package's directory boundary); flagged separately.
 */
export const RETIRED_LIVE_ESCROW_COMPONENTS: readonly string[] = [
  // Superseded at the Wave B cutover, 2026-09-13.
  'component_rdx1cz468eqyr0fklyrlcsznadrwfnqnesw37vlm9j0xmq2s7427akd82f',
  // Superseded at the P2 PULL cutover, 2026-08-17.
  'component_rdx1cr690hkrk2kv933cw3qdr6amkaphdlu2whjhhh8wppus922yx335r2',
  // The pre-vNext component it in turn replaced.
  'component_rdx1cz9mh49guszgssxwwsnvh47ug5lgkhtjqtfc0sp0gr2q6qy6t796s7',
];

/**
 * Canonical mainnet XRD resource. Mirrors guild-app src/lib/radix.ts —
 * manifest builders fail closed against this constant so a drifted value can
 * never produce a real-money manifest (the …stcfkr regression, guild PR #107).
 */
export const MAINNET_XRD = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';

export interface GuildClientConfig {
  /** Base URL of the Guild app, e.g. https://radixguild.com (no trailing slash). */
  apiBaseUrl: string;
  /** dApp definition account baked into the ROLA signature message. */
  dAppDefinitionAddress: string;
  /**
   * Origin baked into the ROLA signature message. Must equal the server's
   * ROLA_EXPECTED_ORIGIN (default https://radixguild.com). For a self-custodied
   * agent key this is self-attested — see agent-auth-design.md build item 2.
   */
  rolaOrigin: string;
  /** Radix network id (1 = mainnet). */
  networkId: number;
  /** Babylon Gateway base URL. */
  gatewayBaseUrl: string;
  /** Marketplace escrow component (guild_marketplace_escrow singleton). */
  escrowComponent: string;
  /**
   * ⚠️ NO LONGER USED TO SIGN A CLAIM. Wave B W4 replaced the flat
   * `claim_bond_xrd` component field with a proportional bond
   * (`claim_bond_pct`/`floor`/`cap`, denominated in the TASK's own
   * `reward_token`) — `tx.ts`'s `claimTaskOnChain` derives the real bond
   * resource + amount entirely from LIVE chain state (`resolveClaimBond`,
   * via `gateway.ts`'s `readOnChainClaimBondBasis`) and never reads this
   * field, on EITHER shape a component can deploy. Kept only as a rough,
   * UNVERIFIED funding-readiness estimate for `doctor`/`onboard`, used ONLY
   * when the live bond shape can't be read from chain at all (both those
   * commands try the live read first and label the fallback explicitly).
   * Env override: GUILD_ESCROW_CLAIM_BOND_XRD.
   */
  claimBondXrd: number;
  /**
   * Agent badge resource — EMPTY until the operator mints a badge to this
   * agent. The deployed component's agent_badge_resource IS wired
   * (Some(GAGENT), re-read on the Wave B component 2026-09-16). GAGENT supply
   * is 1 (3 minted, #1#/#2# recalled 2026-09-14), but that does not fill this
   * client's default; the Member-badge lane needs no mint (claim_task takes either badge — set
   * this to the Member badge resource, as `guild-worker mint-badge` prints).
   * The claim path stays inert while unset. TODO(pilot): set once badged.
   */
  agentBadgeResource: string;
  /** NonFungibleLocalId of THIS agent's badge, e.g. "#1#". TODO(pilot). */
  agentBadgeLocalId: string;
  /** Claim Receipt NFT resource (minted to the worker by claim_task). */
  claimReceiptResource: string;
  /**
   * BadgeManager component — the public_mint entrypoint the Member-badge
   * self-mint drives (the same component radixguild.com/mint calls through the
   * wallet). Pinned to the live mainnet manager; override via GUILD_BADGE_MANAGER.
   */
  badgeManagerComponent: string;
  /**
   * Guild Member badge resource — the badge a NON-agent worker claims with and
   * therefore the proof it must present to `raise_dispute` (the deployed escrow's
   * worker_badge_resource). For Gate-1 the worker claimed with the Member badge
   * (claimer_is_agent=false), so raiseDisputeOnChain (worker path) resolves this
   * resource's local id. Defaults to the live mainnet Member badge; override via
   * GUILD_WORKER_BADGE_RESOURCE.
   *
   * ⚠️ worker_badge_resource != arbiter_badge_resource on the live PULL
   * component. This comment claimed equality until 2026-08-29; that was only
   * ever true in the pre-PULL Gate-1 era. Chain-read 2026-08-29: worker
   * resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl (the
   * public-mint Member badge), arbiter
   * resource_rdx1nf229dxvw72cqzrrkgqvn6zxxjmjpf3hx0zhulsfz4tka5kgnvakn3 (a
   * distinct supply-1 resource — see project memory "Arbiter badge ≠ member
   * badge", gateway-verified 2026-08-09). Do not conflate the two.
   */
  workerBadgeResource: string;
  /**
   * Task Receipt NFT resource (minted to the poster by `create_task`) — the
   * proof `approveAndReleaseManifest` / `cancelTaskManifest` /
   * `cancelTaskAfterClaimManifest` / `withdrawPosterManifest` all present.
   * Component-scoped like `claimReceiptResource`, so it moves WITH
   * `escrowComponent` at every cutover — see that field's PARTIAL-OVERRIDE
   * TRAP comment; the same trap applies here (an operator who repoints only
   * `GUILD_ESCROW_COMPONENT` gets a stale receipt and fails at approve/cancel/
   * withdraw-poster with a confusing "not found" instead of a clear one at
   * create time). Added for P1-19 (poster SDK) — no builder in this package
   * dereferenced a poster-side receipt before it, which is why
   * `GuildClientConfig` had no field for it (see
   * escrow-address-drift.test.ts's AG-13 comment on `taskReceiptResource`).
   */
  taskReceiptResource: string;
  /**
   * The guild-nft-swap component the swap verbs (`guild-poster list-swap` /
   * `cancel-swap` / `withdraw-swap`, `guild-worker fill-swap`) act on. Env
   * override: GUILD_NFT_SWAP_COMPONENT. swap.ts refuses it unless the Gateway
   * reports blueprint `NftSwap` AND package `nftSwapPackage` for it.
   */
  nftSwapComponent: string;
  /**
   * The package `nftSwapComponent` must have been instantiated from. Env
   * override: GUILD_NFT_SWAP_PACKAGE. Any package can name a blueprint
   * `NftSwap`, so the name alone proves nothing; the package is what pins the
   * code every `--live` read and payment trusts. PARTIAL-OVERRIDE TRAP, on
   * purpose: repointing only GUILD_NFT_SWAP_COMPONENT at a component from
   * another package refuses every swap verb until this moves with it.
   */
  nftSwapPackage: string;
}

const DEFAULTS: GuildClientConfig = {
  apiBaseUrl: 'https://radixguild.com',
  dAppDefinitionAddress: 'account_rdx12yepj6wme9ehcnmffk9fvelhumrfskzqyxdy6zde8ltn5zxy42mrcz',
  rolaOrigin: 'https://radixguild.com',
  networkId: NETWORK_ID,
  gatewayBaseUrl: 'https://mainnet.radixdlt.com',
  // Wave B escrow — LIVE on radixguild.com since the 2026-09-13 cutover
  // (PULL …akd82f superseded; see ESCROW-ADDRESSES.md in the private operations repository).
  // ⚠️ Repoint this AND claimReceiptResource below in the SAME commit at any
  // cutover. Until 2026-08-17 this defaulted to the retired push component, and
  // .env.example ships the override COMMENTED OUT — so a fresh agent inherited a
  // dead address, built valid PULL manifests, and every call reverted with
  // "task must be Open to claim". It lost no money; it simply could not work.
  // ⚠️ AG-13 (2026-09-14): exactly this happened again at the NEXT cutover — this
  // default still read the retired PULL component the day after Wave B shipped.
  // escrow-address-drift.test.ts now pins both this and claimReceiptResource
  // against docs/ESCROW-ADDRESSES.md and guild-app/src/lib/config.ts so a
  // third repeat fails CI instead of shipping silently.
  escrowComponent: LIVE_ESCROW_COMPONENT,
  // Last-resort UNVERIFIED funding estimate only (see the field doc above) —
  // never a signing input. Mirrors the live Wave B `claim_bond_floor` (see
  // docs/ESCROW-ADDRESSES.md's instantiate-params table) — the cheapest a real
  // claim could ever cost — so a doctor/onboard run that can't reach the chain
  // at all still funds against a realistic floor instead of the flat 10 XRD
  // bond retired components used.
  claimBondXrd: 76.45,
  agentBadgeResource: '',
  agentBadgeLocalId: '',
  // Wave B Claim Receipt resource (minted by the Wave B component's claim_task).
  // This is the PARTIAL-OVERRIDE TRAP: it is receipt-scoped to the component, so
  // an operator who sets only GUILD_ESCROW_COMPONENT still gets a stale receipt
  // here and fails at submit/withdraw rather than at claim. Move both together.
  claimReceiptResource: 'resource_rdx1n2z2rpjuwg2fu54qmcga862q7kl0qkp4rl9pvfh20z55utku84u9al',
  // BadgeManager (public_mint) — the live Member-badge manager component
  // (global CLAUDE.md "Badge component"; == guild-app poster-harness MANAGER).
  badgeManagerComponent: 'component_rdx1czexylvvm0q4uhwpjaqmlznj9sd3y2jnmmah6qug9lm9sfm3tyrtva',
  // Guild Member badge = deployed worker_badge_resource (guild-saas
  // docs/ESCROW-ADDRESSES.md; guild-app src/lib/config.ts BADGE_NFT). The
  // non-agent worker claims + raises disputes with this badge.
  workerBadgeResource: 'resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl',
  // Wave B Task Receipt resource (minted by the Wave B component's
  // create_task; guild-app's ESCROW_RECEIPT_RESOURCE / docs/ESCROW-ADDRESSES.md
  // "Task Receipt — WAVE B component" row). PARTIAL-OVERRIDE TRAP: move this
  // together with escrowComponent, same as claimReceiptResource above.
  taskReceiptResource: 'resource_rdx1n2gxh84q62taekne4d5mys5yk23du7yyvma6zjuh0vvhn4w2vrtkju',
  nftSwapComponent: LIVE_NFT_SWAP_COMPONENT,
  nftSwapPackage: LIVE_NFT_SWAP_PACKAGE,
};

import { keyFileExists, readKeyFile, resolveKeyFilePath } from './key-file.js';

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

/**
 * Normalize a NonFungibleLocalId. The Guild Member badge id is string-derived
 * (`guild_member_<username>`) and its canonical form is angle-bracketed
 * (`<guild_member_alice>`) — that is what the manifest builder's validateLocalId
 * requires. An operator who copies the bare `guild_member_alice` from a UI into
 * GUILD_AGENT_BADGE_LOCAL_ID would otherwise hit a silent "Invalid badgeLocalId"
 * throw on the very first claim, before any tx. Wrap a bare string id; leave any
 * already-valid form (#n#, <str>, {uuid}, [hex]) untouched.
 */
export function normalizeLocalId(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  if (/^(#\d+#|<[A-Za-z0-9_]+>|\{[0-9a-fA-F-]+\}|\[[0-9a-fA-F]+\])$/.test(id)) return id;
  if (/^[A-Za-z0-9_]+$/.test(id)) return `<${id}>`;
  return id; // leave malformed input for validateLocalId to reject loudly
}

/**
 * normalizeLocalId's inverse: `<guild_member_x>` → `guild_member_x` (env files
 * carry the bare form; loadConfig re-wraps at read time). STRICT on purpose —
 * anything that isn't a well-formed angle-bracketed string id passes through
 * untouched, so a malformed id never gets silently "repaired".
 */
export function bareLocalId(id: string): string {
  const m = /^<([A-Za-z0-9_]+)>$/.exec(id);
  return m ? m[1] : id;
}

/**
 * The exact env exports that enable the on-chain claim path for a held badge —
 * ONE producer for mint results, doctor hints, and onboard output, so the
 * contract can't drift between them.
 */
export function badgeEnvExports(badgeResource: string, localId: string): string[] {
  return [
    `export GUILD_AGENT_BADGE_RESOURCE="${badgeResource}"`,
    `export GUILD_AGENT_BADGE_LOCAL_ID="${bareLocalId(localId)}"`,
  ];
}

/** Resolve config from GUILD_* env vars over mainnet defaults. */
export function loadConfig(overrides: Partial<GuildClientConfig> = {}): GuildClientConfig {
  const fromEnv: Partial<GuildClientConfig> = {
    apiBaseUrl: env('GUILD_API_URL')?.replace(/\/+$/, ''),
    dAppDefinitionAddress: env('GUILD_DAPP_DEFINITION_ADDRESS'),
    rolaOrigin: env('GUILD_ROLA_ORIGIN'),
    gatewayBaseUrl: env('GUILD_GATEWAY_URL'),
    escrowComponent: env('GUILD_ESCROW_COMPONENT'),
    claimBondXrd: (() => {
      const raw = env('GUILD_ESCROW_CLAIM_BOND_XRD');
      if (raw === undefined) return undefined;
      const n = Number(raw);
      // A non-numeric bond (e.g. the '1O'-for-'10' typo) must NOT become NaN: NaN is
      // !== undefined, so it would override the default AND silently disable the funding
      // gate downstream (doctor's `balance < fundingTarget` is always false against NaN).
      // Fall back to the safe default by returning undefined for anything non-finite/negative.
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    })(),
    agentBadgeResource: env('GUILD_AGENT_BADGE_RESOURCE'),
    agentBadgeLocalId: normalizeLocalId(env('GUILD_AGENT_BADGE_LOCAL_ID')),
    claimReceiptResource: env('GUILD_ESCROW_CLAIM_RECEIPT_RESOURCE'),
    badgeManagerComponent: env('GUILD_BADGE_MANAGER'),
    workerBadgeResource: env('GUILD_WORKER_BADGE_RESOURCE'),
    taskReceiptResource: env('GUILD_ESCROW_TASK_RECEIPT_RESOURCE'),
    nftSwapComponent: env('GUILD_NFT_SWAP_COMPONENT'),
    nftSwapPackage: env('GUILD_NFT_SWAP_PACKAGE'),
  };
  const merged: GuildClientConfig = { ...DEFAULTS };
  for (const [key, value] of Object.entries({ ...fromEnv, ...overrides })) {
    if (value !== undefined) {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/**
 * The agent's ed25519 private key (32-byte hex): GUILD_AGENT_PRIVATE_KEY when
 * set, else the key FILE (`$GUILD_AGENT_KEY_FILE`, default
 * ~/.radix-guild/agent.key; key-file.ts). The kit only READS the key — it never
 * creates one: the developer brings their own (ruling 2026-10-03).
 *
 * CUSTODY (accepted design, 2026-06-10; file custody added for Bring Your
 * Agent 2026-09-24): CAPPED balances — fees + claim bonds + a float, never a
 * funded treasury key. Env wins over the file so the operator fleet's `.env`
 * custody is unchanged; the file is the personal-agent path.
 */
export function loadAgentPrivateKeyHex(
  source: Record<string, string | undefined> = process.env
): string {
  const fromEnv = source.GUILD_AGENT_PRIVATE_KEY;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const path = resolveKeyFilePath(source);
  if (keyFileExists(path)) return readKeyFile(path);
  throw new Error(
    `No agent key: GUILD_AGENT_PRIVATE_KEY is not set and there is no key file at ${path} ` +
      '(this kit never creates a key — bring your own: export GUILD_AGENT_PRIVATE_KEY, or put it in that file; ' +
      '32-byte hex, capped-balance agent key only)'
  );
}

/**
 * The poster's ed25519 private key (32-byte hex) from POSTER_PRIVATE_KEY.
 *
 * A DIFFERENT env var, and a DIFFERENT key, from `GUILD_AGENT_PRIVATE_KEY` —
 * the poster funds tasks (pays reward + insurance) while the worker/agent key
 * only ever bonds a claim, and conflating them would let one compromised key
 * drain both roles. `POSTER_PRIVATE_KEY` (no `GUILD_` prefix) matches the
 * convention already live on the production box and in every operator script
 * that signs poster-side legs (`guild-app/scripts/poster-harness.mjs`,
 * `post-micro-tasks.mjs`, `approve-task.mjs`) — kept as-is rather than
 * renamed to `GUILD_POSTER_PRIVATE_KEY` for consistency with this package's
 * other env names, because the fleet's standing `.env` files already export
 * the un-prefixed name and a rename here would silently stop reading them.
 *
 * Custody posture mirrors `loadAgentPrivateKeyHex`: capped balances only,
 * never the signer/treasury/keeper seed.
 */
export function loadPosterPrivateKeyHex(): string {
  const key = env('POSTER_PRIVATE_KEY');
  if (!key) {
    throw new Error('POSTER_PRIVATE_KEY is not set (32-byte hex; capped-balance poster key only)');
  }
  return key;
}

/**
 * The poster's expected account address, from POSTER_ACCOUNT_ADDRESS — set but
 * OPTIONAL. When present, callers that load a poster identity should assert
 * the key actually DERIVES this address (mirrors `loadPosterKey`'s check in
 * poster-harness.mjs: "asserts the key's DERIVED account ==
 * POSTER_ACCOUNT_ADDRESS — a set-but-wrong key fails, not just an unset one").
 * That guard exists because a wrong-but-valid key (e.g. the operator's own
 * funded treasury/bot key leaking into this env var) would otherwise sign real
 * money transactions from an account nobody meant to expose headlessly, and
 * fail only much later — at a Gateway balance check, or not at all until an
 * unexpected account is drained. Returns undefined (never throws) so a caller
 * with no expectation set can still run — the cross-check is opt-in via
 * presence of this var, matching the operator scripts' own behavior.
 */
export function loadPosterAccountAddress(): string | undefined {
  return env('POSTER_ACCOUNT_ADDRESS');
}
