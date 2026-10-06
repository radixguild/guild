// swap.ts — the guild-nft-swap legs for a headless agent (P7-05).
//
//   guild-poster list-swap      list one NFT the poster account holds
//   guild-poster cancel-swap    take a Listed NFT back
//   guild-poster withdraw-swap  pull a Filled listing's payment (to the seller pinned at list)
//   guild-worker fill-swap      pay one alternative, receive the NFT, in one transaction
//
// Same rules as every other leg in this kit: DRY-RUN by default, `--live` signs;
// every dry run prints the exact manifest `--live` would sign; secrets are never
// echoed. Two more that matter for money:
//
//   • The terms a fill pays are READ FROM THE CHAIN, never typed: `fill-swap`
//     takes a listing id and an alternative index, reads that listing from the
//     component, and builds the payment from the stored ask. A flag cannot say
//     "5000" where the chain says "50000". `--live` also needs the caller's
//     own bound (`--max-price` / `--expect-nft`), so a mistyped listing id
//     cannot pay some other listing's ask.
//   • These preconditions are checked first, against the chain: the listing's
//     state at the LEDGER clock (not this machine's), who holds the receipt,
//     whether the NFT to list is in this account, each ask's resource kind and
//     divisibility, and that the fill royalty fits inside the fixed fee lock.
//     A refused leg signs nothing. NOT checked: whether the buyer holds the
//     payment, and duplicate asks on a programmatic list (the CLI cannot build
//     one). Either reverts on chain, and a revert costs only the network fee —
//     `lock_fee` is a cap, not a charge.
//
// The component is trusted only when the Gateway reports blueprint `NftSwap`
// AND the configured package (config.nftSwapPackage): a blueprint name is
// free to copy, and every value `--live` pays against comes from the
// component's own state. Its listing-receipt resource is read from that state
// on every run, never configured — so no override can pair the component with
// a stale receipt. Gateway shapes are the ones read off mainnet 2026-10-06; the
// parser mirrors guild-app/src/lib/nft-swap.ts (cross-checked against it on the
// mainnet records in swap.test.ts).

import { MAINNET_XRD, type GuildClientConfig } from './config.js';
import type { AgentIdentity } from './identity.js';
import {
  cancelSwapManifest,
  fillSwapManifest,
  listSwapManifest,
  withdrawSwapProceedsManifest,
  type SwapAsk,
} from './manifests.js';
import { describeCommitFailure, FEE_LOCK_XRD, signAndSubmitManifest, type TransactionStatus } from './tx.js';

export type { SwapAsk } from './manifests.js';

// Keyless dry-run previews build against this placeholder — the same literal
// guild-poster.ts and mint.ts use: derived from a fixed dummy public key, so no
// private key for it exists and nothing built against it can be signed.
const DRYRUN_PLACEHOLDER_ACCOUNT = 'account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw';

export type SwapListingState = 'Listed' | 'Filled' | 'Cancelled';

export interface SwapListing {
  listingId: number;
  seller: string;
  assetResource: string;
  assetId: string;
  asks: SwapAsk[];
  createdAt: number;
  expiresAt: number;
  state: SwapListingState;
  filledWith: number | null;
  proceedsWithdrawn: boolean;
}

export type SwapStatus = 'open' | 'expired' | 'filled' | 'cancelled';

/** S2: `list` refuses an expiry more than 30 days out (nft_swap.rs THIRTY_DAYS_SECS). */
export const MAX_LISTING_HORIZON_SECS = 30 * 24 * 60 * 60;
/** A 30-day pick is pulled in by this much: the ceiling is measured when the
 *  transaction EXECUTES, from a ledger time read a little earlier. */
export const EXPIRY_CEILING_MARGIN_SECS = 10 * 60;

const RESOURCE_RE = /^resource_rdx1[a-z0-9]{20,}$/;
const ACCOUNT_RE = /^account_rdx1[a-z0-9]{20,}$/;
const LOCAL_ID_RE =
  /^(#\d{1,20}#|<[A-Za-z0-9_]{1,64}>|\[[0-9a-fA-F]{2,128}\]|\{[0-9a-fA-F]{16}-[0-9a-fA-F]{16}-[0-9a-fA-F]{16}-[0-9a-fA-F]{16}\})$/;
const DECIMAL_RE = /^\d{1,30}(\.\d{1,18})?$/;

export const isResourceAddress = (s: unknown): s is string => typeof s === 'string' && RESOURCE_RE.test(s);
export const isLocalId = (s: unknown): s is string => typeof s === 'string' && LOCAL_ID_RE.test(s);

/**
 * The one spelling the ledger stores for a local id, so `#01#` and `#1#` (or
 * `[AB]` and `[ab]`) compare equal and reach the Gateway as the same NFT.
 * Same rules as guild-app/src/lib/nft-swap.ts canonicalLocalId (asserted in
 * swap.parity.test.ts): an integer id loses its leading zeros (`#0#` stays),
 * bytes and RUID ids are lowercased, a string id is case-sensitive and left
 * alone, and anything that is not a local id comes back unchanged.
 */
export function canonicalLocalId(id: string): string {
  // Not a local id (by the bounded forms above): unchanged, exactly as the
  // app does — so the two never canonicalise the same input differently.
  if (!isLocalId(id)) return id;
  if (id.startsWith('#')) return `#${id.slice(1, -1).replace(/^0+(?=\d)/, '')}#`;
  if (id.startsWith('[') || id.startsWith('{')) return id.toLowerCase();
  return id;
}

// ── parsing (mirrors guild-app/src/lib/nft-swap.ts parseSwapListing) ────────

type Field = { field_name?: string; value?: unknown; variant_name?: string; fields?: unknown; elements?: unknown };
const field = (fs: Field[], name: string) => fs.find((f) => f?.field_name === name);
const instantSecs = (f: Field | undefined): number | null => {
  const n = typeof f?.value === 'string' ? Number(f.value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

function parseAsk(el: unknown): SwapAsk | null {
  const e = el as Field;
  const inner = Array.isArray(e?.fields) ? (e.fields as Field[]) : null;
  if (!inner) return null;
  const resource = field(inner, 'resource')?.value;
  if (!isResourceAddress(resource)) return null;
  if (e.variant_name === 'Fungible') {
    const amount = field(inner, 'amount')?.value;
    return typeof amount === 'string' && DECIMAL_RE.test(amount) ? { kind: 'fungible', resource, amount } : null;
  }
  if (e.variant_name === 'NonFungible') {
    const id = field(inner, 'id')?.value;
    return isLocalId(id) ? { kind: 'nonFungible', resource, id } : null;
  }
  return null;
}

/** One `Listing` KVS value → typed, or null on any shape the blueprint cannot
 *  produce (one bad alternative fails the whole listing: indexes must not shift). */
export function parseSwapListing(listingId: number, json: unknown): SwapListing | null {
  const fields = (json as { fields?: unknown })?.fields;
  if (!Array.isArray(fields)) return null;
  const fs = fields as Field[];
  const seller = field(fs, 'seller')?.value;
  const assetResource = field(fs, 'asset_resource')?.value;
  const assetId = field(fs, 'asset_id')?.value;
  if (typeof seller !== 'string' || !ACCOUNT_RE.test(seller) || !isResourceAddress(assetResource) || !isLocalId(assetId)) return null;
  const elements = field(fs, 'asks')?.elements;
  if (!Array.isArray(elements) || elements.length === 0) return null;
  const asks: SwapAsk[] = [];
  for (const el of elements) {
    const ask = parseAsk(el);
    if (!ask) return null;
    asks.push(ask);
  }
  const createdAt = instantSecs(field(fs, 'created_at'));
  const expiresAt = instantSecs(field(fs, 'expires_at'));
  if (createdAt === null || expiresAt === null) return null;
  const stateName = field(fs, 'state')?.variant_name;
  if (stateName !== 'Listed' && stateName !== 'Filled' && stateName !== 'Cancelled') return null;
  const fw = field(fs, 'filled_with');
  let filledWith: number | null = null;
  if (fw?.variant_name === 'Some') {
    const v = Array.isArray(fw.fields) ? Number((fw.fields as Field[])[0]?.value) : NaN;
    if (!Number.isInteger(v) || v < 0 || v >= asks.length) return null;
    filledWith = v;
  } else if (fw?.variant_name !== 'None') {
    return null;
  }
  if ((stateName === 'Filled') !== (filledWith !== null)) return null;
  const pw = field(fs, 'proceeds_withdrawn')?.value;
  const proceedsWithdrawn = pw === true || pw === 'true' ? true : pw === false || pw === 'false' ? false : null;
  if (proceedsWithdrawn === null) return null;
  return { listingId, seller, assetResource, assetId, asks, createdAt, expiresAt, state: stateName, filledWith, proceedsWithdrawn };
}

/** Status at the LEDGER clock — `fill` asserts now < expires_at. */
export function swapStatus(l: SwapListing, ledgerNow: number): SwapStatus {
  if (l.state === 'Filled') return 'filled';
  if (l.state === 'Cancelled') return 'cancelled';
  return ledgerNow < l.expiresAt ? 'open' : 'expired';
}

/** An expiry `days` days from the ledger clock, inside the 30-day ceiling. */
export function expiryForDays(ledgerNow: number, days: number): number {
  const d = Math.min(Math.max(Math.floor(days), 1), 30);
  return Math.min(ledgerNow + d * 86400, ledgerNow + MAX_LISTING_HORIZON_SECS - EXPIRY_CEILING_MARGIN_SECS);
}

// ── chain reads ─────────────────────────────────────────────────────────────

async function post(config: GuildClientConfig, path: string, body: unknown): Promise<any | null> {
  try {
    const resp = await fetch(`${config.gatewayBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

const ledgerSecs = (json: any): number | null => {
  const ms = Date.parse(json?.ledger_state?.proposer_round_timestamp);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

export interface SwapFee {
  unit: 'XRD' | 'USD';
  amount: string;
}

export interface SwapState {
  listingsKvStore: string;
  nextListingId: number;
  receiptResource: string;
  fees: { fill: SwapFee | null; extend: SwapFee | null };
  ledgerNow: number;
}

function feeFor(config: any, method: string): SwapFee | null {
  if (config?.is_enabled === false) return { unit: 'XRD', amount: '0' };
  const rule = Array.isArray(config?.method_rules) ? config.method_rules.find((r: any) => r?.method_name === method) : null;
  if (!rule) return null;
  const ra = rule.royalty_amount;
  if (ra === undefined || ra === null) return { unit: 'XRD', amount: '0' };
  if ((ra.unit !== 'XRD' && ra.unit !== 'USD') || typeof ra.amount !== 'string' || !/^\d+(\.\d+)?$/.test(ra.amount)) return null;
  return { unit: ra.unit, amount: ra.amount };
}

/** The component's state and the ledger clock; null unless it is an NftSwap
 *  component of the configured package. */
export async function readSwapState(config: GuildClientConfig): Promise<SwapState | null> {
  const json = await post(config, '/state/entity/details', {
    addresses: [config.nftSwapComponent],
    opt_ins: { component_royalty_config: true },
  });
  const details = json?.items?.[0]?.details;
  if (!details || details.blueprint_name !== 'NftSwap' || !Array.isArray(details?.state?.fields)) return null;
  if (details.package_address !== config.nftSwapPackage) return null;
  const f = (name: string) => details.state.fields.find((x: any) => x?.field_name === name)?.value;
  const listingsKvStore = f('listings');
  const nextListingId = Number(f('next_listing_id'));
  const receiptResource = f('listing_receipt_manager');
  const ledgerNow = ledgerSecs(json);
  if (
    typeof listingsKvStore !== 'string' ||
    !listingsKvStore.startsWith('internal_keyvaluestore_') ||
    !Number.isSafeInteger(nextListingId) ||
    nextListingId < 1 ||
    !isResourceAddress(receiptResource) ||
    ledgerNow === null
  ) {
    return null;
  }
  return {
    listingsKvStore,
    nextListingId,
    receiptResource,
    fees: { fill: feeFor(details.royalty_config, 'fill'), extend: feeFor(details.royalty_config, 'extend_listing') },
    ledgerNow,
  };
}

export type ListingRead =
  | { kind: 'ok'; state: SwapState; listing: SwapListing }
  | { kind: 'not_found' | 'unreadable' | 'unknown'; state?: SwapState };

/** One listing, fresh. `unknown` = the chain could not be read. */
export async function readSwapListing(config: GuildClientConfig, listingId: number): Promise<ListingRead> {
  const state = await readSwapState(config);
  if (!state) return { kind: 'unknown' };
  if (!Number.isSafeInteger(listingId) || listingId < 1 || listingId >= state.nextListingId) return { kind: 'not_found', state };
  const json = await post(config, '/state/key-value-store/data', {
    key_value_store_address: state.listingsKvStore,
    keys: [{ key_json: { kind: 'U64', value: String(listingId) } }],
  });
  if (!Array.isArray(json?.entries)) return { kind: 'unknown', state };
  const entry = json.entries.find((e: any) => e?.key?.programmatic_json?.value === String(listingId));
  if (!entry) return { kind: 'unreadable', state };
  const listing = parseSwapListing(listingId, entry?.value?.programmatic_json);
  const ledgerNow = ledgerSecs(json) ?? state.ledgerNow;
  return listing ? { kind: 'ok', state: { ...state, ledgerNow }, listing } : { kind: 'unreadable', state };
}

/** Which account holds one NFT. undefined = never minted or burned; null = unknown. */
export async function readNftHolder(config: GuildClientConfig, resource: string, localId: string): Promise<string | null | undefined> {
  const json = await post(config, '/state/non-fungible/location', { resource_address: resource, non_fungible_ids: [localId] });
  const items = json?.non_fungible_ids;
  if (!Array.isArray(items)) return null;
  const it = items.find((i: any) => i?.non_fungible_id === localId);
  if (!it || it.is_burned === true) return undefined;
  const holder = it.owning_vault_global_ancestor_address;
  return typeof holder === 'string' ? holder : null;
}

export type ResourceKind = { kind: 'fungible'; divisibility: number } | { kind: 'nonFungible' };

/** A resource's kind (and divisibility, for a fungible). null = unknown / not a resource. */
export async function readResourceKind(config: GuildClientConfig, resource: string): Promise<ResourceKind | null> {
  const json = await post(config, '/state/entity/details', { addresses: [resource] });
  const d = json?.items?.[0]?.details;
  if (d?.type === 'NonFungibleResource') return { kind: 'nonFungible' };
  if (d?.type === 'FungibleResource' && Number.isInteger(d.divisibility) && d.divisibility >= 0 && d.divisibility <= 18) {
    return { kind: 'fungible', divisibility: d.divisibility };
  }
  return null;
}

/** The listing id a committed `list` created, from its ListedEvent (emitter-pinned). */
export async function readListedListingId(config: GuildClientConfig, intentHash: string): Promise<number | null> {
  const json = await post(config, '/transaction/committed-details', { intent_hash: intentHash, opt_ins: { receipt_events: true } });
  if (json?.transaction?.transaction_status !== 'CommittedSuccess') return null;
  const events = json?.transaction?.receipt?.events;
  if (!Array.isArray(events)) return null;
  for (const ev of events) {
    if (ev?.name !== 'ListedEvent' || ev?.emitter?.entity?.entity_address !== config.nftSwapComponent) continue;
    const fields = ev?.data?.programmatic_json?.fields ?? ev?.data?.fields;
    const v = Array.isArray(fields) ? Number(fields.find((x: any) => x?.field_name === 'listing_id')?.value) : NaN;
    if (Number.isSafeInteger(v) && v > 0) return v;
  }
  return null;
}

// ── the legs ────────────────────────────────────────────────────────────────

export interface SwapDeps {
  readSwapState: typeof readSwapState;
  readSwapListing: typeof readSwapListing;
  readNftHolder: typeof readNftHolder;
  readResourceKind: typeof readResourceKind;
  readListedListingId: typeof readListedListingId;
  signAndSubmitManifest: typeof signAndSubmitManifest;
  describeCommitFailure: typeof describeCommitFailure;
}

const REAL_DEPS: SwapDeps = {
  readSwapState,
  readSwapListing,
  readNftHolder,
  readResourceKind,
  readListedListingId,
  signAndSubmitManifest,
  describeCommitFailure,
};

export interface SwapLegResult {
  dryRun: boolean;
  /** A precondition failed (nothing was signed) or the transaction did not commit. */
  refused?: boolean;
  message?: string;
  manifest?: string;
  intentHash?: string;
  status?: TransactionStatus;
  listingId?: number;
}

interface SwapLegCommon {
  live: boolean;
  identity: AgentIdentity | null;
  config: GuildClientConfig;
  deps?: Partial<SwapDeps>;
  log?: (line: string) => void;
}

const refuse = (message: string, extra: Partial<SwapLegResult> = {}): SwapLegResult => ({ dryRun: false, refused: true, message, ...extra });

const componentUnreadable = (config: GuildClientConfig) =>
  `the swap component ${config.nftSwapComponent} could not be read, or is not an NftSwap component of package ` +
  `${config.nftSwapPackage} — GUILD_NFT_SWAP_COMPONENT and GUILD_NFT_SWAP_PACKAGE must be set together`;

const componentLine = (config: GuildClientConfig) => `component ${config.nftSwapComponent} (package ${config.nftSwapPackage})`;

function feeLine(fee: SwapFee | null, what: string): string {
  if (!fee) return `${what} fee: unknown (the Gateway did not report the component royalty), plus the network fee`;
  return `${what} fee: ${fee.amount} ${fee.unit === 'USD' ? 'USD (paid in XRD)' : 'XRD'} (component royalty), plus the network fee`;
}

/** What the network fee must keep of the fixed fee lock after a royalty. */
const FEE_HEADROOM_XRD = '1.5';
const ATTO = 10n ** 18n;
const toAtto = (d: string): bigint | null => {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(d);
  return m ? BigInt(m[1]) * ATTO + BigInt((m[2] ?? '').padEnd(18, '0')) : null;
};

/**
 * Why a royalty-carrying call must not be signed, or null. Every kit
 * transaction locks a fixed FEE_LOCK_XRD (tx.ts), and a component royalty is
 * paid out of that lock: a royalty that leaves too little for the network fee
 * is rejected after it is submitted. An unreadable or USD-denominated royalty
 * cannot be checked against an XRD lock, so it refuses too.
 */
export function feeRefusal(fee: SwapFee | null, what: string): string | null {
  const fix = `${what} on radixguild.com instead, where the wallet sizes the fee lock`;
  if (!fee) {
    return `the ${what} fee could not be read from the Gateway, so it cannot be checked against this kit's fixed ${FEE_LOCK_XRD} XRD fee lock — retry, or ${fix}`;
  }
  if (fee.unit === 'USD') {
    return `the ${what} fee is ${fee.amount} USD (paid in XRD at the ledger's rate), which this kit cannot check against its fixed ${FEE_LOCK_XRD} XRD fee lock — ${fix}`;
  }
  const amount = toAtto(fee.amount);
  const ceiling = BigInt(FEE_LOCK_XRD) * ATTO - toAtto(FEE_HEADROOM_XRD)!;
  if (amount === null || amount > ceiling) {
    return `the ${what} fee is ${fee.amount} XRD, which leaves less than ${FEE_HEADROOM_XRD} XRD of this kit's fixed ${FEE_LOCK_XRD} XRD fee lock for the network fee, so the transaction would be rejected — ${fix}`;
  }
  return null;
}

const askText = (a: SwapAsk) => (a.kind === 'fungible' ? `${a.amount} of ${a.resource}` : `the NFT ${a.id} of ${a.resource}`);

async function signLeg(
  deps: SwapDeps,
  opts: SwapLegCommon,
  method: string,
  manifest: string,
  extra: Partial<SwapLegResult>,
): Promise<SwapLegResult> {
  const onchain = await deps.signAndSubmitManifest(manifest, opts.identity!, opts.config);
  opts.log?.(`${method} signed (${onchain.intentHash}, ${onchain.status})`);
  // Still unresolved when the poll gave up: it may yet commit, so "not
  // committed" would be a claim nobody established.
  if (onchain.status === 'Unknown' || onchain.status === 'Pending') {
    return refuse(`${method}: outcome unknown — the transaction was submitted; look up ${onchain.intentHash} before retrying`, {
      manifest,
      intentHash: onchain.intentHash,
      status: 'Unknown',
      ...extra,
    });
  }
  if (onchain.status !== 'CommittedSuccess') {
    return refuse(await deps.describeCommitFailure(opts.config.gatewayBaseUrl, onchain.status, onchain.intentHash, method), {
      manifest,
      intentHash: onchain.intentHash,
      status: onchain.status,
      ...extra,
    });
  }
  return { dryRun: false, manifest, intentHash: onchain.intentHash, status: onchain.status, ...extra };
}

export interface ListSwapOptions extends SwapLegCommon {
  nft: { resource: string; id: string };
  asks: SwapAsk[];
  days: number;
}

/** `guild-poster list-swap` — escrow one NFT the poster account holds. */
export async function runListSwap(opts: ListSwapOptions): Promise<SwapLegResult> {
  const deps = { ...REAL_DEPS, ...opts.deps };
  const log = opts.log ?? (() => {});
  const { nft, asks, days, live, identity, config } = opts;

  if (!isResourceAddress(nft.resource) || !isLocalId(nft.id)) return refuse('--nft must be <resource address>:<local id>, e.g. resource_rdx1…:#1#');
  if (asks.length === 0) return refuse('at least one ask is required (--price and/or --ask-nft)');
  if (!Number.isInteger(days) || days < 1 || days > 30) return refuse('--days must be a whole number of days, 1-30');
  if (live && !identity) return refuse('list-swap --live needs POSTER_PRIVATE_KEY (drop --live for a keyless preview).');

  const state = await deps.readSwapState(config);
  if (!state) return refuse(componentUnreadable(config));
  log(componentLine(config));

  // Each ask's resource must exist with the kind the ask claims (a fungible
  // amount within its divisibility; a non-fungible ask naming an NFT
  // collection), and no ask may be the NFT being listed — a listing nobody
  // could fill.
  for (const [i, ask] of asks.entries()) {
    const kind = await deps.readResourceKind(config, ask.resource);
    if (!kind) return refuse(`ask ${i}: ${ask.resource} could not be read as a resource`);
    if (ask.kind === 'fungible') {
      if (kind.kind !== 'fungible') return refuse(`ask ${i}: ${ask.resource} is an NFT collection — use --ask-nft for it`);
      const frac = ask.amount.split('.')[1]?.replace(/0+$/, '') ?? '';
      if (frac.length > kind.divisibility) return refuse(`ask ${i}: ${ask.amount} is finer than the token's divisibility (${kind.divisibility})`);
    } else {
      if (kind.kind !== 'nonFungible') return refuse(`ask ${i}: ${ask.resource} is a token — use --price for it`);
      if (ask.resource === nft.resource && canonicalLocalId(ask.id) === canonicalLocalId(nft.id)) return refuse(`ask ${i}: that is the NFT being listed`);
    }
  }

  const account = identity?.address ?? DRYRUN_PLACEHOLDER_ACCOUNT;
  if (identity) {
    const holder = await deps.readNftHolder(config, nft.resource, nft.id);
    if (holder === null) return refuse(`could not read who holds ${nft.id} of ${nft.resource}`);
    if (holder !== identity.address) {
      return refuse(`${nft.id} of ${nft.resource} is not in this account (${identity.address}); it is ${holder === undefined ? 'not minted or burned' : `in ${holder}`}`);
    }
  }

  const expiresAt = expiryForDays(state.ledgerNow, days);
  const manifest = listSwapManifest(config.nftSwapComponent, account, nft.resource, nft.id, asks, expiresAt);
  log(`list ${nft.id} of ${nft.resource} for ${asks.map(askText).join(' OR ')}`);
  log(`expires ${new Date(expiresAt * 1000).toISOString()} (ledger clock + ${days} day${days === 1 ? '' : 's'}); proceeds will be paid to ${account}`);
  if (!live) {
    if (!identity) log('(no POSTER_PRIVATE_KEY in env — previewing against a placeholder account)');
    return { dryRun: true, manifest };
  }
  const result = await signLeg(deps, opts, 'list', manifest, {});
  if (result.refused || !result.intentHash) return result;
  const listingId = await deps.readListedListingId(config, result.intentHash);
  if (listingId === null) log('listed, but the ListedEvent could not be read back yet — look the transaction up on the Dashboard');
  return { ...result, listingId: listingId ?? undefined };
}

async function readForLeg(
  deps: SwapDeps,
  config: GuildClientConfig,
  listingId: number,
): Promise<{ ok: true; state: SwapState; listing: SwapListing } | { ok: false; message: string }> {
  if (!Number.isSafeInteger(listingId) || listingId < 1) return { ok: false, message: 'a positive listing id is required' };
  const r = await deps.readSwapListing(config, listingId);
  if (r.kind === 'ok') return { ok: true, state: r.state, listing: r.listing };
  if (r.kind === 'not_found') return { ok: false, message: `no listing ${listingId} on ${config.nftSwapComponent}` };
  if (r.kind === 'unreadable') return { ok: false, message: `listing ${listingId} exists but its record did not parse — nothing was signed rather than a guess` };
  return { ok: false, message: componentUnreadable(config) };
}

export interface FillSwapOptions extends SwapLegCommon {
  listingId: number;
  /** Required when the listing has more than one alternative. */
  alternative?: number;
  /** The most the caller will pay, for a fungible alternative (`--max-price`). */
  maxPrice?: { amount: string; resource: string };
  /** The NFT the caller expects to pay, for a non-fungible one (`--expect-nft`). */
  expectNft?: { resource: string; id: string };
}

/**
 * The caller's own bound on what a fill spends, checked against the ask read
 * from the chain. The ask is never typed, but the listing id is: a transposed
 * id pays a stranger's ask in full from the agent key. With the bound, a wrong
 * id costs nothing. `missing` = no bound for this kind of ask was given.
 */
export function spendCheck(
  ask: SwapAsk,
  maxPrice: FillSwapOptions['maxPrice'],
  expectNft: FillSwapOptions['expectNft'],
): { ok: string } | { missing: string } | { over: string } {
  if (ask.kind === 'fungible') {
    if (!maxPrice) return { missing: '--max-price <amount>[:<resource>] (a fungible alternative)' };
    if (maxPrice.resource !== ask.resource) {
      return { over: `the alternative pays in ${ask.resource}, not the --max-price resource ${maxPrice.resource}` };
    }
    // Exact, in attos: a float would round an 18-place Decimal.
    const pay = toAtto(ask.amount);
    const cap = toAtto(maxPrice.amount);
    if (pay === null || cap === null || pay > cap) return { over: `the alternative pays ${ask.amount}, above --max-price ${maxPrice.amount}` };
    return { ok: `pays ${ask.amount}, within --max-price ${maxPrice.amount}` };
  }
  if (!expectNft) return { missing: '--expect-nft <resource>:<id> (a non-fungible alternative)' };
  if (expectNft.resource !== ask.resource || canonicalLocalId(expectNft.id) !== canonicalLocalId(ask.id)) {
    return { over: `the alternative pays the NFT ${ask.id} of ${ask.resource}, not the --expect-nft ${expectNft.id} of ${expectNft.resource}` };
  }
  return { ok: `pays the NFT ${ask.id} of ${ask.resource}, as --expect-nft expects` };
}

/** `guild-worker fill-swap` — pay one alternative, receive the NFT. */
export async function runFillSwap(opts: FillSwapOptions): Promise<SwapLegResult> {
  const deps = { ...REAL_DEPS, ...opts.deps };
  const log = opts.log ?? (() => {});
  const { listingId, live, identity, config } = opts;
  if (live && !identity) return refuse('fill-swap --live needs GUILD_AGENT_PRIVATE_KEY (drop --live for a keyless preview).', { listingId });

  const read = await readForLeg(deps, config, listingId);
  if (!read.ok) return refuse(read.message, { listingId });
  const { state, listing } = read;
  const status = swapStatus(listing, state.ledgerNow);
  if (status !== 'open') return refuse(`listing ${listingId} is ${status} at the ledger clock — only an open listing can be filled`, { listingId });

  let alt = opts.alternative;
  if (alt === undefined) {
    if (listing.asks.length > 1) {
      return refuse(
        `listing ${listingId} has ${listing.asks.length} alternatives — pass --alternative <n>: ` +
          listing.asks.map((a, i) => `${i} = ${askText(a)}`).join('; '),
        { listingId },
      );
    }
    alt = 0;
  }
  if (!Number.isInteger(alt) || alt < 0 || alt >= listing.asks.length) {
    return refuse(`--alternative must be 0-${listing.asks.length - 1} for listing ${listingId}`, { listingId });
  }
  const ask = listing.asks[alt];
  const account = identity?.address ?? DRYRUN_PLACEHOLDER_ACCOUNT;
  const manifest = fillSwapManifest(config.nftSwapComponent, account, listingId, alt, ask);
  const feeBlock = feeRefusal(state.fees.fill, 'fill');
  const bound = spendCheck(ask, opts.maxPrice, opts.expectNft);
  const boundBlock =
    'missing' in bound ? `fill-swap --live needs ${bound.missing}, your own bound on what this fill spends` : 'over' in bound ? bound.over : null;
  log(componentLine(config));
  log(`fill listing ${listingId} with alternative ${alt}: pays exactly ${askText(ask)} (read from the chain)`);
  log(`receives the NFT ${listing.assetId} of ${listing.assetResource}; ${feeLine(state.fees.fill, 'fill')}`);
  log('A fill cannot be undone, and a listing is not proof the NFT is genuine: check the collection address.');
  if (!live) {
    if (!identity) log('(no GUILD_AGENT_PRIVATE_KEY in env — previewing against a placeholder account)');
    if ('ok' in bound) log(`spend bound: ${bound.ok}`);
    else if ('missing' in bound) log(`--live will need ${bound.missing}`);
    else log(`--live would refuse: ${bound.over}`);
    if (feeBlock) log(`--live would refuse: ${feeBlock}`);
    return { dryRun: true, manifest, listingId };
  }
  if (feeBlock) return refuse(feeBlock, { listingId });
  if (boundBlock) return refuse(boundBlock, { listingId });
  return signLeg(deps, opts, 'fill', manifest, { listingId });
}

export interface ReceiptLegOptions extends SwapLegCommon {
  listingId: number;
}

async function receiptLeg(
  opts: ReceiptLegOptions,
  method: 'cancel' | 'withdraw_proceeds',
  precondition: (l: SwapListing) => string | null,
  build: (component: string, account: string, receiptResource: string, listingId: number) => string,
  describe: (l: SwapListing) => string,
): Promise<SwapLegResult> {
  const deps = { ...REAL_DEPS, ...opts.deps };
  const log = opts.log ?? (() => {});
  const { listingId, live, identity, config } = opts;
  const verb = method === 'cancel' ? 'cancel-swap' : 'withdraw-swap';
  if (live && !identity) return refuse(`${verb} --live needs POSTER_PRIVATE_KEY (drop --live for a keyless preview).`, { listingId });

  const read = await readForLeg(deps, config, listingId);
  if (!read.ok) return refuse(read.message, { listingId });
  const { state, listing } = read;
  const why = precondition(listing);
  if (why) return refuse(why, { listingId });
  log(componentLine(config));

  // The receipt is the credential; whoever holds it may act. Check it is here
  // before signing, so a missing receipt costs nothing.
  const account = identity?.address ?? DRYRUN_PLACEHOLDER_ACCOUNT;
  if (identity) {
    const holder = await deps.readNftHolder(config, state.receiptResource, `#${listingId}#`);
    if (holder === null) return refuse(`could not read who holds listing ${listingId}'s receipt`, { listingId });
    if (holder !== identity.address) {
      return refuse(`listing ${listingId}'s receipt is ${holder === undefined ? 'burned' : `in ${holder}`}, not in this account (${identity.address})`, { listingId });
    }
  }
  const manifest = build(config.nftSwapComponent, account, state.receiptResource, listingId);
  log(describe(listing));
  if (!live) {
    if (!identity) log('(no POSTER_PRIVATE_KEY in env — previewing against a placeholder account)');
    return { dryRun: true, manifest, listingId };
  }
  return signLeg(deps, opts, method, manifest, { listingId });
}

/** `guild-poster cancel-swap` — take a Listed NFT back (any time, expired or not). */
export function runCancelSwap(opts: ReceiptLegOptions): Promise<SwapLegResult> {
  return receiptLeg(
    opts,
    'cancel',
    (l) => (l.state === 'Listed' ? null : `listing ${l.listingId} is ${l.state} — only a Listed listing can be cancelled`),
    cancelSwapManifest,
    (l) => `cancel listing ${l.listingId}: the NFT ${l.assetId} of ${l.assetResource} returns to the receipt holder`,
  );
}

/** `guild-poster withdraw-swap` — pull a Filled listing's payment. */
export function runWithdrawSwap(opts: ReceiptLegOptions): Promise<SwapLegResult> {
  return receiptLeg(
    opts,
    'withdraw_proceeds',
    (l) =>
      l.state !== 'Filled'
        ? `listing ${l.listingId} is ${l.state} — only a Filled listing has proceeds`
        : l.proceedsWithdrawn
          ? `listing ${l.listingId}'s proceeds were already withdrawn`
          : null,
    withdrawSwapProceedsManifest,
    (l) => {
      const ask = l.asks[l.filledWith ?? 0];
      return `withdraw listing ${l.listingId}'s proceeds: ${askText(ask)}, paid to the seller pinned at list — ${l.seller} — whoever presents the receipt`;
    },
  );
}

// ── argv helpers for the two CLIs ───────────────────────────────────────────

/** `<resource>:<local id>` → parts with the id in its canonical spelling, or null. */
export function parseNftRef(raw: string | undefined): { resource: string; id: string } | null {
  if (!raw) return null;
  const i = raw.indexOf(':');
  if (i < 0) return null;
  const resource = raw.slice(0, i);
  const id = raw.slice(i + 1);
  return isResourceAddress(resource) && isLocalId(id) ? { resource, id: canonicalLocalId(id) } : null;
}

/** `--max-price <amount>[:<resource>]` → the bound, the resource defaulting to
 *  XRD (this kit is mainnet-only, like its fee lock), or null. */
export function parseMaxPrice(raw: string | undefined): { amount: string; resource: string } | null {
  if (!raw) return null;
  const i = raw.indexOf(':');
  const amount = parseAmount(i < 0 ? raw : raw.slice(0, i));
  const resource = i < 0 ? MAINNET_XRD : raw.slice(i + 1);
  return amount && isResourceAddress(resource) ? { amount, resource } : null;
}

/** A plain decimal whole number (`/^\d+$/`, safe integer), or null. Never
 *  Number() alone: it reads '' and ' ' as 0, and '0x10' / '1e1' as 16 / 10. */
export function parseWholeNumber(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** A positive decimal with at most 18 places, normalised (no trailing zeros). */
export function parseAmount(raw: string | undefined): string | null {
  if (!raw || !DECIMAL_RE.test(raw) || !/[1-9]/.test(raw)) return null;
  if (!raw.includes('.')) return raw.replace(/^0+(?=\d)/, '');
  const [i, f] = raw.split('.');
  const frac = f.replace(/0+$/, '');
  const int = i.replace(/^0+(?=\d)/, '');
  return frac ? `${int}.${frac}` : int;
}
