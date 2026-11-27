// The NFT swap legs (swap.ts): every precondition the chain would revert on is
// refused BEFORE signing, the fill's terms come from the chain, dry runs sign
// nothing, and a non-committed transaction is reported as refused — never as
// done. Chain reads and the signer are injected; the listing records are the
// mainnet shapes read 2026-10-06 (guild-app/tests/fixtures/nft-swap/).
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, MAINNET_XRD } from './config.js';
import { AgentIdentity } from './identity.js';
import { cancelSwapManifest, fillSwapManifest, listSwapManifest, withdrawSwapProceedsManifest, type SwapAsk } from './manifests.js';
import {
  canonicalLocalId,
  expiryForDays,
  feeRefusal,
  parseAmount,
  parseNftRef,
  parseWholeNumber,
  parseSwapListing,
  runCancelSwap,
  runFillSwap,
  runListSwap,
  runWithdrawSwap,
  readListedListingId,
  readNftHolder,
  readResourceKind,
  freezeRule,
  guildReceiptResources,
  issuerControlRule,
  readResourceControl,
  readResourceName,
  readResourceRecall,
  transferRule,
  recallRule,
  readSwapListing,
  readSwapState,
  swapStatus,
  type ListingRead,
  type SwapDeps,
  type SwapListing,
  type SwapState,
} from './swap.js';
import { main as posterMain } from './guild-poster.js';
import { main as workerMain } from './guild-worker.js';

const FIX = join(import.meta.dir, '..', '..', '..', 'guild-app', 'tests', 'fixtures', 'nft-swap');
const KV = JSON.parse(readFileSync(join(FIX, 'listings-kv-mainnet-2026-10-06.json'), 'utf8'));
const LISTED_TX = JSON.parse(readFileSync(join(FIX, 'list-1-committed-details.json'), 'utf8'));
const STANDALONE = !!process.env.GUILD_NO_SIBLING;

const CONFIG = loadConfig();
const SWAP = CONFIG.nftSwapComponent;
const RECEIPT = 'resource_rdx1nfq47l0t7glmntfjuandqdmlejzvffq4cvlvrha94kqr52mdrvt2e7';
const NFT = 'resource_rdx1ng3k9ll8yygujlamrszv5qu58nv9kqtala6cry2xql4006ccyrykdk';
const SELLER = 'account_rdx12y6ch4m8wjcgu7hrnwfqjeqt70w4kh7qy7k3gs2j9wyx3596fgt3fm';
const LEDGER = 1_790_000_000;
// A throwaway test key (32 bytes of 0x07) — never funded, used only to derive an address.
const KEY_HEX = '07'.repeat(32);

// A second collection, for a listing whose NFT is not the throwaway one.
const OTHER_NFT = 'resource_rdx1nguzt4xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
// What the legs pass the builders for an asset they may list or fill.
const GUARD = { control: 'locked' as const, receiptResources: [RECEIPT, CONFIG.taskReceiptResource, CONFIG.claimReceiptResource], assetName: null };

const STATE: SwapState = {
  listingsKvStore: 'internal_keyvaluestore_rdx1kp9yd7edwqrzn5gnwzc38drdmy8tnjpn864a3v4538tmtxky2x5cqp',
  nextListingId: 10,
  receiptResource: RECEIPT,
  fees: { fill: { unit: 'XRD', amount: '0' }, extend: { unit: 'XRD', amount: '0' } },
  ledgerNow: LEDGER,
};

function listing(over: Partial<SwapListing> = {}): SwapListing {
  return {
    listingId: 3,
    seller: SELLER,
    assetResource: NFT,
    assetId: '#2#',
    asks: [{ kind: 'fungible', resource: MAINNET_XRD, amount: '5000' }],
    createdAt: LEDGER - 3600,
    expiresAt: LEDGER + 86400,
    state: 'Listed',
    filledWith: null,
    proceedsWithdrawn: false,
    ...over,
  };
}

function deps(over: Partial<SwapDeps> & { read?: ListingRead; holder?: string | null | undefined } = {}) {
  const signed: string[] = [];
  const d: Partial<SwapDeps> = {
    readSwapState: async () => STATE,
    readSwapListing: async () => over.read ?? { kind: 'ok', state: STATE, listing: listing() },
    readNftHolder: async () => ('holder' in over ? over.holder : SELLER),
    readResourceKind: async (_c, r) => (r === MAINNET_XRD ? { kind: 'fungible', divisibility: 18 } : { kind: 'nonFungible' }),
    readResourceControl: async () => 'locked',
    readResourceName: async () => null,
    readListedListingId: async () => 3,
    signAndSubmitManifest: async (m) => {
      signed.push(m);
      return { intentHash: 'txid_rdx1test', status: 'CommittedSuccess' };
    },
    describeCommitFailure: async (_g, status, hash, what) => `${what} not committed: ${status} (${hash})`,
    ...over,
  };
  return { d, signed };
}

const identity = async () => AgentIdentity.fromPrivateKeyHex(KEY_HEX);

describe('parseSwapListing — same answer as guild-app on the mainnet records', () => {
  test.skipIf(STANDALONE)('parity with guild-app/src/lib/nft-swap.ts', async () => {
    const app = (await import('../../../guild-app/src/lib/nft-swap')) as { parseSwapListing: (id: number, j: unknown) => unknown };
    for (const e of KV.entries) {
      const id = Number(e.key.programmatic_json.value);
      const mine = parseSwapListing(id, e.value.programmatic_json);
      expect(mine).not.toBeNull();
      expect(mine).toEqual(app.parseSwapListing(id, e.value.programmatic_json) as SwapListing);
    }
    // And the same refusal on a shape the blueprint cannot produce.
    const bad = JSON.parse(JSON.stringify(KV.entries[0].value.programmatic_json));
    bad.fields.find((f: any) => f.field_name === 'asks').elements[0].variant_name = 'Bundle';
    expect(parseSwapListing(1, bad)).toBeNull();
    expect(app.parseSwapListing(1, bad)).toBeNull();
  });

  // The kit and the app must name the same NFT the same way, or a pre-sign
  // holder check reads a different id than the one the site shows.
  test.skipIf(STANDALONE)('canonicalLocalId: parity with guild-app', async () => {
    const app = (await import('../../../guild-app/src/lib/nft-swap')) as { canonicalLocalId: (id: string) => string };
    for (const id of ['#01#', '#000#', '#0#', '[AbCd]', '{AAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBB-CCCCCCCCCCCCCCCC-DDDDDDDDDDDDDDDD}', '<Gold_1>']) {
      expect(canonicalLocalId(id)).toBe(app.canonicalLocalId(id));
    }
  });

  test('status at the ledger clock; expiry inside the ceiling', () => {
    expect(swapStatus(listing({ expiresAt: LEDGER + 1 }), LEDGER)).toBe('open');
    expect(swapStatus(listing({ expiresAt: LEDGER }), LEDGER)).toBe('expired');
    expect(expiryForDays(LEDGER, 30)).toBeLessThan(LEDGER + 30 * 86400);
    expect(expiryForDays(LEDGER, 7)).toBe(LEDGER + 7 * 86400);
  });

  test('argv helpers', () => {
    expect(parseNftRef(`${NFT}:#2#`)).toEqual({ resource: NFT, id: '#2#' });
    expect(parseNftRef(`${NFT}:#2#")`)).toBeNull();
    expect(parseNftRef('#2#')).toBeNull();
    expect(parseAmount('5000.500')).toBe('5000.5');
    expect(parseAmount('0.0')).toBeNull();
    expect(parseAmount('1e3')).toBeNull();
  });

  test('parseWholeNumber: plain digits only, never Number() coercion', () => {
    expect(parseWholeNumber('0')).toBe(0);
    expect(parseWholeNumber('12')).toBe(12);
    for (const raw of [undefined, '', ' ', '0x10', '1e1', '1.0', '-1', '+1', ' 1', '99999999999999999999']) {
      expect(parseWholeNumber(raw)).toBeNull();
    }
  });

  test('canonicalLocalId: the spelling the ledger stores', () => {
    expect(canonicalLocalId('#01#')).toBe('#1#');
    expect(canonicalLocalId('#000#')).toBe('#0#');
    expect(canonicalLocalId('#0#')).toBe('#0#');
    expect(canonicalLocalId('[AbCd]')).toBe('[abcd]');
    expect(canonicalLocalId('{AAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBB-CCCCCCCCCCCCCCCC-DDDDDDDDDDDDDDDD}')).toBe(
      '{aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-cccccccccccccccc-dddddddddddddddd}',
    );
    expect(canonicalLocalId('<Gold_1>')).toBe('<Gold_1>');
    expect(parseNftRef(`${NFT}:#02#`)).toEqual({ resource: NFT, id: '#2#' });
    expect(parseNftRef(`${NFT}:[AB]`)).toEqual({ resource: NFT, id: '[ab]' });
  });
});

describe('readSwapState — refuses what is not the live NftSwap component', () => {
  const body = (over: object) => ({
    ledger_state: { proposer_round_timestamp: '2026-10-06T07:00:00.000Z' },
    items: [{ details: {
      blueprint_name: 'NftSwap',
      package_address: 'package_rdx1p53j5yst59jhgc8ljap7266sd0nxgm2lndp2z6a4ddsprkn7e9ssmv',
      state: { fields: [
        { field_name: 'listings', value: STATE.listingsKvStore },
        { field_name: 'next_listing_id', value: '3' },
        { field_name: 'listing_receipt_manager', value: RECEIPT },
      ] },
      royalty_config: { is_enabled: true, method_rules: [{ method_name: 'fill', royalty_amount: { unit: 'XRD', amount: '0' } }] },
      ...over,
    } }],
  });
  const withFetch = async (json: object, fn: () => Promise<void>) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(json))) as unknown as typeof fetch;
    try { await fn(); } finally { globalThis.fetch = real; }
  };

  test('reads the live component', async () => {
    await withFetch(body({}), async () => {
      const s = await readSwapState(CONFIG);
      expect(s).toMatchObject({ nextListingId: 3, receiptResource: RECEIPT, fees: { fill: { unit: 'XRD', amount: '0' }, extend: null } });
    });
  });

  // The blueprint name is free to copy; the package is what is pinned, for an
  // override as much as for the live address.
  test('an overridden component is pinned to the configured package', async () => {
    const LOOKALIKE = 'component_rdx1cplookalikexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const OTHER_PKG = 'package_rdx1pkgnotthelivepackagexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    await withFetch(body({ package_address: OTHER_PKG }), async () => {
      expect(await readSwapState({ ...CONFIG, nftSwapComponent: LOOKALIKE })).toBeNull();
      expect(await readSwapState({ ...CONFIG, nftSwapComponent: LOOKALIKE, nftSwapPackage: OTHER_PKG })).not.toBeNull();
    });
  });
  test('another package at the live address, or another blueprint, reads as null', async () => {
    await withFetch(body({ package_address: 'package_rdx1pkgnotthelivepackagexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }), async () => {
      expect(await readSwapState(CONFIG)).toBeNull();
    });
    await withFetch(body({ blueprint_name: 'Escrow' }), async () => {
      expect(await readSwapState(CONFIG)).toBeNull();
    });
  });
});

// Every leg test injects the readers; these run the real ones against the
// mainnet shapes, so a reader that drops a pin or reads the wrong field
// cannot hide behind the stubs. Each answers by path, so call order is free.
describe('the chain readers, against a stubbed Gateway', () => {
  type Answer = unknown | ((body: any) => unknown);
  const withGateway = async (routes: Record<string, Answer>, fn: () => Promise<void>) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const a = routes[new URL(String(url)).pathname];
      const json = typeof a === 'function' ? (a as (b: any) => unknown)(JSON.parse(String(init?.body ?? '{}'))) : a;
      // A path with no answer is a Gateway error.
      return json === undefined ? new Response('{}', { status: 500 }) : new Response(JSON.stringify(json));
    }) as unknown as typeof fetch;
    try { await fn(); } finally { globalThis.fetch = real; }
  };
  const component = {
    ledger_state: { proposer_round_timestamp: '2026-10-06T07:00:00.000Z' },
    items: [{ details: {
      blueprint_name: 'NftSwap',
      package_address: CONFIG.nftSwapPackage,
      state: { fields: [
        { field_name: 'listings', value: STATE.listingsKvStore },
        { field_name: 'next_listing_id', value: '3' },
        { field_name: 'listing_receipt_manager', value: RECEIPT },
      ] },
    } }],
  };
  /** The KV fixture answering only the keys asked for, after `edit`. */
  const kv = (edit: (entries: any[]) => any[] = (e) => e) => (body: any) => {
    const want = new Set(body.keys.map((k: any) => k.key_json.value));
    const entries = edit(JSON.parse(JSON.stringify(KV.entries)));
    return { ...KV, entries: entries.filter((e) => want.has(e.key.programmatic_json.value)) };
  };
  const KV_LEDGER = Math.floor(Date.parse(KV.ledger_state.proposer_round_timestamp) / 1000);

  test('readSwapListing: the mainnet record, at the clock of the listing read', async () => {
    await withGateway({ '/state/entity/details': component, '/state/key-value-store/data': kv() }, async () => {
      const r = await readSwapListing(CONFIG, 1);
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') return;
      expect(r.listing).toMatchObject({ listingId: 1, state: 'Filled', filledWith: 0 });
      expect(r.state.ledgerNow).toBe(KV_LEDGER);
      expect((await readSwapListing(CONFIG, 3)).kind).toBe('not_found');
    });
  });

  test('readSwapListing: an absent or malformed entry is unreadable; a failed read is unknown', async () => {
    const absent = kv((es) => es.filter((e) => e.key.programmatic_json.value !== '2'));
    await withGateway({ '/state/entity/details': component, '/state/key-value-store/data': absent }, async () => {
      expect((await readSwapListing(CONFIG, 2)).kind).toBe('unreadable');
    });
    const malformed = kv((es) => {
      es[0].value.programmatic_json.fields.find((f: any) => f.field_name === 'seller').value = 'not-an-account';
      return es;
    });
    await withGateway({ '/state/entity/details': component, '/state/key-value-store/data': malformed }, async () => {
      expect((await readSwapListing(CONFIG, 1)).kind).toBe('unreadable');
    });
    await withGateway({ '/state/entity/details': component }, async () => {
      expect((await readSwapListing(CONFIG, 1)).kind).toBe('unknown');
    });
  });

  test('readNftHolder: the holder; burned or never minted is undefined; unreadable is null', async () => {
    const at = (item: object) => ({ '/state/non-fungible/location': { non_fungible_ids: [{ non_fungible_id: '#2#', ...item }] } });
    await withGateway(at({ is_burned: false, owning_vault_global_ancestor_address: SELLER }), async () => {
      expect(await readNftHolder(CONFIG, RECEIPT, '#2#')).toBe(SELLER);
    });
    await withGateway(at({ is_burned: true }), async () => {
      expect(await readNftHolder(CONFIG, RECEIPT, '#2#')).toBeUndefined();
    });
    await withGateway({ '/state/non-fungible/location': { non_fungible_ids: [] } }, async () => {
      expect(await readNftHolder(CONFIG, RECEIPT, '#2#')).toBeUndefined();
    });
    await withGateway({}, async () => {
      expect(await readNftHolder(CONFIG, RECEIPT, '#2#')).toBeNull();
    });
  });

  test('readResourceKind: fungible with divisibility 0-18, non-fungible, anything else null', async () => {
    const as = (details: object) => ({ '/state/entity/details': { items: [{ details }] } });
    await withGateway(as({ type: 'FungibleResource', divisibility: 18 }), async () => {
      expect(await readResourceKind(CONFIG, MAINNET_XRD)).toEqual({ kind: 'fungible', divisibility: 18 });
    });
    await withGateway(as({ type: 'FungibleResource', divisibility: 19 }), async () => {
      expect(await readResourceKind(CONFIG, MAINNET_XRD)).toBeNull();
    });
    await withGateway(as({ type: 'NonFungibleResource' }), async () => {
      expect(await readResourceKind(CONFIG, NFT)).toEqual({ kind: 'nonFungible' });
    });
    await withGateway(as({ type: 'Component' }), async () => {
      expect(await readResourceKind(CONFIG, NFT)).toBeNull();
    });
  });

  test('readListedListingId: the proving run list tx reads 1; another emitter or a failed tx reads null', async () => {
    await withGateway({ '/transaction/committed-details': LISTED_TX }, async () => {
      expect(await readListedListingId(CONFIG, 'txid')).toBe(1);
      const elsewhere = { ...CONFIG, nftSwapComponent: 'component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly' };
      expect(await readListedListingId(elsewhere, 'txid')).toBeNull();
    });
    const failed = { transaction: { ...LISTED_TX.transaction, transaction_status: 'CommittedFailure' } };
    await withGateway({ '/transaction/committed-details': failed }, async () => {
      expect(await readListedListingId(CONFIG, 'txid')).toBeNull();
    });
  });
});

describe('fill-swap', () => {
  test('dry run: the manifest pays exactly the chain stored ask, signs nothing', async () => {
    const { d, signed } = deps();
    const id = await identity();
    const r = await runFillSwap({ listingId: 3, live: false, identity: id, config: CONFIG, deps: d });
    expect(r.dryRun).toBe(true);
    expect(r.manifest).toBe(fillSwapManifest(SWAP, id.address, 3, 0, listing().asks[0], NFT, '#2#', GUARD));
    expect(signed).toEqual([]);
  });

  test('the manifest asserts the NFT the chain lists, never one the caller typed', async () => {
    // The listing's NFT is read with its asks. --expect-nft bounds what the fill
    // PAYS; it never names what the fill must receive.
    const asks: SwapAsk[] = [{ kind: 'nonFungible', resource: NFT, id: '#7#' }];
    const { d, signed } = deps({ read: { kind: 'ok', state: STATE, listing: listing({ assetResource: OTHER_NFT, assetId: '<rare_1>', asks }) } });
    const id = await identity();
    const r = await runFillSwap({ listingId: 3, live: true, expectNft: { resource: NFT, id: '#7#' }, identity: id, config: CONFIG, deps: d });
    expect(r.refused).toBeUndefined();
    expect(signed).toEqual([fillSwapManifest(SWAP, id.address, 3, 0, asks[0], OTHER_NFT, '<rare_1>', GUARD)]);
    const m = signed[0];
    const check = m.indexOf(`ASSERT_WORKTOP_CONTAINS_NON_FUNGIBLES\n  Address("${OTHER_NFT}")\n  Array<NonFungibleLocalId>(NonFungibleLocalId("<rare_1>"))\n;`);
    expect(check).toBeGreaterThan(m.indexOf('"fill"'));
    expect(m.indexOf('"try_deposit_batch_or_abort"')).toBeGreaterThan(check);
    expect(m.split('ASSERT_WORKTOP_CONTAINS_NON_FUNGIBLES')).toHaveLength(2);
  });

  test.each([
    ['recallable', /recall is not permanently switched off for resource_rdx1/],
    ['freezable', /freezing is not permanently switched off for resource_rdx1/],
    ['restrictable', /transfers of resource_rdx1\w+ are restricted, or are not permanently open/],
    ['unknown', /could not confirm that recall, freezing and transfer restrictions are permanently off/],
  ] as const)('refuses a %s collection, dry run or live, and signs nothing', async (state, line) => {
    const { d, signed } = deps({ readResourceControl: async () => state });
    for (const live of [false, true]) {
      const r = await runFillSwap({ listingId: 3, live, identity: await identity(), config: CONFIG, deps: d });
      expect(r.refused).toBe(true);
      expect(r.message).toMatch(line);
      expect(r.manifest).toBeUndefined();
    }
    expect(signed).toEqual([]);
  });

  test('a locked-deny collection fills, and the built manifest still asserts the listed NFT', async () => {
    const { d, signed } = deps({ readResourceControl: async () => 'locked' });
    const r = await runFillSwap({ listingId: 3, live: true, maxPrice: { resource: MAINNET_XRD, amount: '5000' }, identity: await identity(), config: CONFIG, deps: d });
    expect(r.refused).toBeUndefined();
    expect(signed).toHaveLength(1);
    expect(signed[0]).toContain('ASSERT_WORKTOP_CONTAINS_NON_FUNGIBLES');
    expect(signed[0].indexOf('ASSERT_WORKTOP_CONTAINS_NON_FUNGIBLES')).toBeGreaterThan(signed[0].indexOf('"fill"'));
  });

  test('more than one alternative needs --alternative, and names them', async () => {
    const asks: SwapAsk[] = [
      { kind: 'fungible', resource: MAINNET_XRD, amount: '5000' },
      { kind: 'nonFungible', resource: NFT, id: '#1#' },
    ];
    const { d } = deps({ read: { kind: 'ok', state: STATE, listing: listing({ asks }) } });
    const r = await runFillSwap({ listingId: 3, live: false, identity: null, config: CONFIG, deps: d });
    expect(r.refused).toBe(true);
    expect(r.message).toContain('pass --alternative');
    const ok = await runFillSwap({ listingId: 3, alternative: 1, live: false, identity: null, config: CONFIG, deps: d });
    expect(ok.manifest).toContain('"withdraw_non_fungibles"');
    const out = await runFillSwap({ listingId: 3, alternative: 2, live: false, identity: null, config: CONFIG, deps: d });
    expect(out.message).toContain('--alternative must be 0-1');
  });

  test.each([
    ['expired', listing({ expiresAt: LEDGER - 1 }), 'is expired'],
    // fill asserts now < expires_at: a listing expiring at this very second is already expired.
    ['expiring at the ledger clock', listing({ expiresAt: LEDGER }), 'is expired'],
    ['filled', listing({ state: 'Filled', filledWith: 0 }), 'is filled'],
    ['cancelled', listing({ state: 'Cancelled' }), 'is cancelled'],
  ])('refuses a listing that is %s — nothing signed', async (_n, l, msg) => {
    const { d, signed } = deps({ read: { kind: 'ok', state: STATE, listing: l } });
    const r = await runFillSwap({ listingId: 3, live: true, identity: await identity(), config: CONFIG, deps: d });
    expect(r.refused).toBe(true);
    expect(r.message).toContain(msg);
    expect(signed).toEqual([]);
  });

  test('an unreadable chain refuses, never guesses', async () => {
    for (const read of [{ kind: 'unknown' as const }, { kind: 'unreadable' as const }, { kind: 'not_found' as const }]) {
      const { d, signed } = deps({ read });
      const r = await runFillSwap({ listingId: 3, live: true, identity: await identity(), config: CONFIG, deps: d });
      expect(r.refused).toBe(true);
      expect(signed).toEqual([]);
    }
  });

  test('live: signs the dry run manifest; a failed commit comes back refused with the reason', async () => {
    const { d, signed } = deps();
    const id = await identity();
    const r = await runFillSwap({ listingId: 3, live: true, maxPrice: { amount: '5000', resource: MAINNET_XRD }, identity: id, config: CONFIG, deps: d });
    expect(r).toMatchObject({ dryRun: false, intentHash: 'txid_rdx1test', status: 'CommittedSuccess' });
    expect(signed).toEqual([fillSwapManifest(SWAP, id.address, 3, 0, listing().asks[0], NFT, '#2#', GUARD)]);

    const failing = deps({ signAndSubmitManifest: async () => ({ intentHash: 'txid_rdx1bad', status: 'CommittedFailure' }) });
    const f = await runFillSwap({ listingId: 3, live: true, maxPrice: { amount: '5000', resource: MAINNET_XRD }, identity: id, config: CONFIG, deps: failing.d });
    expect(f.refused).toBe(true);
    expect(f.message).toBe('fill not committed: CommittedFailure (txid_rdx1bad)');
  });

  test('a component that will not read names both override variables', async () => {
    const { d } = deps({ read: { kind: 'unknown' } });
    const r = await runFillSwap({ listingId: 3, live: false, identity: null, config: CONFIG, deps: d });
    expect(r.message).toContain('GUILD_NFT_SWAP_COMPONENT and GUILD_NFT_SWAP_PACKAGE');
  });

  // Every kit transaction locks a fixed 5 XRD, and the royalty is paid out of it.
  test.each([
    ['unknown', null],
    ['in USD', { unit: 'USD' as const, amount: '1' }],
    ['10 XRD', { unit: 'XRD' as const, amount: '10' }],
    ['3.6 XRD (under 1.5 XRD left for the network)', { unit: 'XRD' as const, amount: '3.6' }],
    ['3.500000000000000001 XRD', { unit: 'XRD' as const, amount: '3.500000000000000001' }],
  ])('--live refuses a fill fee that is %s — nothing signed; the dry run says so', async (_n, fill) => {
    const state = { ...STATE, fees: { ...STATE.fees, fill } };
    const { d, signed } = deps({ read: { kind: 'ok', state, listing: listing() } });
    const r = await runFillSwap({ listingId: 3, live: true, identity: await identity(), config: CONFIG, deps: d });
    expect(r.refused).toBe(true);
    expect(r.message).toContain('5 XRD fee lock');
    expect(r.message).toContain('radixguild.com');
    expect(signed).toEqual([]);

    const lines: string[] = [];
    const dry = await runFillSwap({ listingId: 3, live: false, identity: null, config: CONFIG, deps: d, log: (l) => lines.push(l) });
    expect(dry.dryRun).toBe(true);
    expect(lines.join('\n')).toContain('--live would refuse');
    expect(lines.join('\n')).not.toContain('transaction preview');
  });

  test('a fill fee that leaves 1.5 XRD of the lock signs', async () => {
    expect(feeRefusal({ unit: 'XRD', amount: '3.5' }, 'fill')).toBeNull();
    expect(feeRefusal({ unit: 'XRD', amount: '0' }, 'fill')).toBeNull();
    const state = { ...STATE, fees: { ...STATE.fees, fill: { unit: 'XRD' as const, amount: '3.5' } } };
    const { d, signed } = deps({ read: { kind: 'ok', state, listing: listing() } });
    const r = await runFillSwap({ listingId: 3, live: true, maxPrice: { amount: '5000', resource: MAINNET_XRD }, identity: await identity(), config: CONFIG, deps: d });
    expect(r.refused).toBeUndefined();
    expect(signed).toHaveLength(1);
  });

  test('an unresolved commit is reported as outcome unknown, never as not committed', async () => {
    for (const status of ['Unknown', 'Pending'] as const) {
      const { d } = deps({ signAndSubmitManifest: async () => ({ intentHash: 'txid_rdx1late', status }) });
      const r = await runFillSwap({ listingId: 3, live: true, maxPrice: { amount: '5000', resource: MAINNET_XRD }, identity: await identity(), config: CONFIG, deps: d });
      expect(r).toMatchObject({ refused: true, status: 'Unknown', intentHash: 'txid_rdx1late' });
      expect(r.message).toContain('outcome unknown — the transaction was submitted; look up txid_rdx1late before retrying');
      expect(r.message).not.toContain('not committed');
    }
  });

  test('--live with no key refuses before reading anything', async () => {
    const { d } = deps({ readSwapListing: async () => { throw new Error('must not read'); } });
    const r = await runFillSwap({ listingId: 3, live: true, identity: null, config: CONFIG, deps: d });
    expect(r.message).toContain('needs GUILD_AGENT_PRIVATE_KEY');
  });
});

describe('recallRule — same rule as guild-app', () => {
  const role = (name: string, rule: string, resolution = 'Explicit') => ({
    role_key: { module: 'Main', name },
    assignment: resolution === 'Explicit' ? { explicit_rule: { type: rule }, resolution } : { resolution },
  });
  const details = (recaller: unknown, updater: unknown) => ({ role_assignments: { entries: [recaller, updater].filter(Boolean) } });
  const cases: [string, unknown, string][] = [
    ['DenyAll/DenyAll', details(role('recaller', 'DenyAll'), role('recaller_updater', 'DenyAll')), 'locked-deny'],
    ['Protected recaller', details(role('recaller', 'Protected'), role('recaller_updater', 'DenyAll')), 'recallable'],
    ['owner-rule recaller', details(role('recaller', '', 'Owner'), role('recaller_updater', 'DenyAll')), 'recallable'],
    ['open updater', details(role('recaller', 'DenyAll'), role('recaller_updater', 'AllowAll')), 'recallable'],
    ['no updater entry', details(role('recaller', 'DenyAll'), null), 'unknown'],
    ['no recaller entry', details(null, role('recaller_updater', 'DenyAll')), 'unknown'],
    ['no role data', {}, 'unknown'],
  ];
  test.each(cases)('%s', (_n, d, want) => {
    expect(recallRule(d)).toBe(want);
  });
  test.skipIf(STANDALONE)('parity with guild-app/src/lib/nft-swap-gateway.ts', async () => {
    const app = (await import('../../../guild-app/src/lib/nft-swap-gateway')) as { recallRule: (d: unknown) => string };
    for (const [, d] of cases) expect(recallRule(d)).toBe(app.recallRule(d));
  });
  test('readResourceRecall reads it from the entity details', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ items: [{ details: details(role('recaller', 'DenyAll'), role('recaller_updater', 'DenyAll')) }] }))) as typeof fetch;
    try {
      expect(await readResourceRecall(CONFIG, NFT)).toBe('locked-deny');
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('list-swap', () => {
  const nft = { resource: NFT, id: '#2#' };
  const xrd5000: SwapAsk = { kind: 'fungible', resource: MAINNET_XRD, amount: '5000' };

  test('dry run with the key: checks the NFT is here, builds the list call at ledger clock + days', async () => {
    const id = await identity();
    const { d, signed } = deps({ holder: id.address });
    const r = await runListSwap({ nft, asks: [xrd5000], days: 7, live: false, identity: id, config: CONFIG, deps: d });
    expect(r.dryRun).toBe(true);
    expect(r.manifest).toBe(listSwapManifest(SWAP, id.address, NFT, '#2#', [xrd5000], LEDGER + 7 * 86400, GUARD));
    expect(signed).toEqual([]);
  });

  test.each([
    ['recallable', /recall is not permanently switched off for resource_rdx1/],
    ['freezable', /freezing is not permanently switched off for resource_rdx1/],
    ['restrictable', /transfers of resource_rdx1\w+ are restricted, or are not permanently open/],
    ['unknown', /could not confirm that recall, freezing and transfer restrictions are permanently off/],
  ] as const)('refuses a %s collection before building or signing anything', async (state, line) => {
    const { d, signed } = deps({ readResourceControl: async () => state });
    const r = await runListSwap({ nft, asks: [xrd5000], days: 7, live: false, identity: null, config: CONFIG, deps: d });
    expect(r.refused).toBe(true);
    expect(r.message).toMatch(line);
    expect(r.manifest).toBeUndefined();
    expect(signed).toEqual([]);
  });

  test('refuses an NFT that is not in this account', async () => {
    const { d } = deps({ holder: SELLER });
    const r = await runListSwap({ nft, asks: [xrd5000], days: 7, live: true, identity: await identity(), config: CONFIG, deps: d });
    expect(r.refused).toBe(true);
    expect(r.message).toContain('is not in this account');
  });

  test('refuses asks the chain would refuse, or accept and nobody could fill', async () => {
    const { d } = deps();
    const run = (asks: SwapAsk[], days = 7) => runListSwap({ nft, asks, days, live: false, identity: null, config: CONFIG, deps: d });
    expect((await run([{ kind: 'fungible', resource: NFT, amount: '1' }])).message).toContain('is an NFT collection');
    expect((await run([{ kind: 'nonFungible', resource: MAINNET_XRD, id: '#1#' }])).message).toContain('is a token');
    expect((await run([{ kind: 'nonFungible', resource: NFT, id: '#2#' }])).message).toContain('the NFT being listed');
    expect((await run([{ kind: 'nonFungible', resource: NFT, id: '#02#' }])).message).toContain('the NFT being listed');
    expect((await run([xrd5000], 31)).message).toContain('--days');
    expect((await run([])).message).toContain('at least one ask');
  });

  test('live: signs, then reads the new listing id from the ListedEvent', async () => {
    const id = await identity();
    const { d, signed } = deps({ holder: id.address });
    const r = await runListSwap({ nft, asks: [xrd5000], days: 7, live: true, identity: id, config: CONFIG, deps: d });
    expect(r).toMatchObject({ dryRun: false, listingId: 3, status: 'CommittedSuccess' });
    expect(signed).toHaveLength(1);
  });
});

describe('cancel-swap / withdraw-swap — the receipt is the credential', () => {
  test('cancel: the receipt must be in this account', async () => {
    const id = await identity();
    const here = deps({ holder: id.address });
    const ok = await runCancelSwap({ listingId: 3, live: true, identity: id, config: CONFIG, deps: here.d });
    expect(ok.dryRun).toBe(false);
    expect(here.signed).toEqual([cancelSwapManifest(SWAP, id.address, RECEIPT, 3)]);

    const elsewhere = deps({ holder: SELLER });
    const r = await runCancelSwap({ listingId: 3, live: true, identity: id, config: CONFIG, deps: elsewhere.d });
    expect(r.refused).toBe(true);
    expect(r.message).toContain(`receipt is in ${SELLER}`);
    expect(elsewhere.signed).toEqual([]);

    const burned = deps({ holder: undefined });
    expect((await runCancelSwap({ listingId: 3, live: true, identity: id, config: CONFIG, deps: burned.d })).message).toContain('burned');
  });

  // nft_swap.rs keeps cancel open after expiry, so an expired NFT is never stranded.
  test('cancel: an expired, still Listed listing signs the cancel', async () => {
    const id = await identity();
    const expired = deps({ read: { kind: 'ok', state: STATE, listing: listing({ expiresAt: LEDGER - 1 }) }, holder: id.address });
    const r = await runCancelSwap({ listingId: 3, live: true, identity: id, config: CONFIG, deps: expired.d });
    expect(r.refused).toBeUndefined();
    expect(expired.signed).toEqual([cancelSwapManifest(SWAP, id.address, RECEIPT, 3)]);
  });

  test('cancel refuses anything but Listed; withdraw refuses anything but Filled-and-owed', async () => {
    const id = await identity();
    const filled = { kind: 'ok' as const, state: STATE, listing: listing({ state: 'Filled', filledWith: 0 }) };
    expect((await runCancelSwap({ listingId: 3, live: false, identity: id, config: CONFIG, deps: deps({ read: filled, holder: id.address }).d })).message).toContain('only a Listed');
    expect((await runWithdrawSwap({ listingId: 3, live: false, identity: id, config: CONFIG, deps: deps({ holder: id.address }).d })).message).toContain('only a Filled');
    const done = { kind: 'ok' as const, state: STATE, listing: listing({ state: 'Filled', filledWith: 0, proceedsWithdrawn: true }) };
    expect((await runWithdrawSwap({ listingId: 3, live: false, identity: id, config: CONFIG, deps: deps({ read: done, holder: id.address }).d })).message).toContain('already withdrawn');
    const owed = deps({ read: filled, holder: id.address });
    const w = await runWithdrawSwap({ listingId: 3, live: false, identity: id, config: CONFIG, deps: owed.d });
    expect(w.manifest).toBe(withdrawSwapProceedsManifest(SWAP, id.address, RECEIPT, 3));
  });
});

describe('the CLIs dispatch the swap verbs', () => {
  test('guild-poster list-swap: usage errors exit 2, a dry run exits 0 with the manifest', async () => {
    expect(await posterMain(['list-swap', '--price', '5'], { identity: null })).toBe(2);
    expect(await posterMain(['list-swap', '--nft', `${NFT}:#2#`], { identity: null })).toBe(2);
    expect(await posterMain(['list-swap', '--nft', `${NFT}:#2#`, '--price-token', NFT], { identity: null })).toBe(2);
    const { d } = deps();
    expect(await posterMain(['list-swap', '--nft', `${NFT}:#2#`, '--price', '5000'], { identity: null, swapDeps: d })).toBe(0);
  });

  test('guild-poster cancel-swap / withdraw-swap need a listing id; a refusal exits 1', async () => {
    expect(await posterMain(['cancel-swap'], { identity: null })).toBe(2);
    for (const raw of ['1e1', '0x10', ' ']) expect(await posterMain(['withdraw-swap', raw], { identity: null })).toBe(2);
    expect(await posterMain(['list-swap', '--nft', `${NFT}:#2#`, '--price', '5', '--days', '1e1'], { identity: null })).toBe(2);
    expect(await posterMain(['list-swap', '--nft', `${NFT}:#2#`, '--price', '5', '--days', ''], { identity: null })).toBe(2);
    const { d } = deps();
    expect(await posterMain(['withdraw-swap', '3'], { identity: null, swapDeps: d })).toBe(1);
  });

  test('guild-worker fill-swap: usage, then the runner with the parsed alternative', async () => {
    expect(await workerMain(['fill-swap'])).toBe(2);
    expect(await workerMain(['fill-swap', '3', '--alternative', '-1'])).toBe(2);
    // Number() reads each of these as a real index or id: '' and ' ' as 0.
    for (const alt of ['', ' ', '0x1', '1e0', '1.0']) expect(await workerMain(['fill-swap', '3', '--alternative', alt])).toBe(2);
    for (const id of ['0x10', '1e1', ' ', '3.0']) expect(await workerMain(['fill-swap', id])).toBe(2);
    let seen: number | undefined = -99;
    const code = await workerMain(['fill-swap', '3', '--alternative', '1'], {
      loadIdentity: async () => null,
      runFillSwap: async (o) => {
        seen = o.alternative;
        return { dryRun: true, manifest: 'M', listingId: 3 };
      },
    });
    expect(code).toBe(0);
    expect(seen).toBe(1);
  });
});

// ── 28 Nov 2026: freeze, transfer rules and receipts — the same guards as guild-app ──

describe('issuerControlRule — recall, freeze and transfer rules, same answer as guild-app', () => {
  const role = (name: string, rule: string, resolution = 'Explicit') => ({
    role_key: { module: 'Main', name },
    assignment: resolution === 'Explicit' ? { explicit_rule: { type: rule }, resolution } : { resolution },
  });
  // Live listing 9's NFT and its ask token read like this on all eight roles.
  const LOCKED: Record<string, string | null | [string, string]> = {
    recaller: 'DenyAll', recaller_updater: 'DenyAll', freezer: 'DenyAll', freezer_updater: 'DenyAll',
    withdrawer: 'AllowAll', withdrawer_updater: 'DenyAll', depositor: 'AllowAll', depositor_updater: 'DenyAll',
  };
  const details = (over: Record<string, string | null | [string, string]> = {}) => ({
    role_assignments: {
      entries: Object.entries({ ...LOCKED, ...over }).flatMap(([name, rule]) =>
        rule === null ? [] : [Array.isArray(rule) ? role(name, rule[0], rule[1]) : role(name, rule)],
      ),
    },
  });
  const cases: [string, unknown, string][] = [
    ['all eight locked', details(), 'locked'],
    ['Protected recaller', details({ recaller: 'Protected' }), 'recallable'],
    ['Protected freezer', details({ freezer: 'Protected' }), 'freezable'],
    ['owner-rule freezer', details({ freezer: ['', 'Owner'] }), 'freezable'],
    ['open freezer_updater', details({ freezer_updater: 'AllowAll' }), 'freezable'],
    ['Protected withdrawer', details({ withdrawer: 'Protected' }), 'restrictable'],
    ['DenyAll depositor', details({ depositor: 'DenyAll' }), 'restrictable'],
    ['open withdrawer_updater', details({ withdrawer_updater: 'Protected' }), 'restrictable'],
    ['owner-rule depositor_updater', details({ depositor_updater: ['', 'Owner'] }), 'restrictable'],
    ['recall wins over the others', details({ recaller: 'AllowAll', freezer: 'AllowAll', withdrawer: 'DenyAll' }), 'recallable'],
    ['no freezer entry', details({ freezer: null }), 'unknown'],
    ['no freezer_updater entry', details({ freezer_updater: null }), 'unknown'],
    ['no withdrawer entry', details({ withdrawer: null }), 'unknown'],
    ['no depositor_updater entry', details({ depositor_updater: null }), 'unknown'],
    ['unreadable depositor', details({ depositor: ['', 'Weird'] }), 'unknown'],
    ['no role data', {}, 'unknown'],
  ];
  test.each(cases)('%s', (_n, d, want) => {
    expect(issuerControlRule(d)).toBe(want as ReturnType<typeof issuerControlRule>);
  });
  test.skipIf(STANDALONE)('parity with guild-app: each rule, and the combined state', async () => {
    const gw = (await import('../../../guild-app/src/lib/nft-swap-gateway')) as Record<string, (d: unknown) => string>;
    const model = (await import('../../../guild-app/src/lib/nft-swap')) as unknown as {
      issuerControl: (r: Record<string, string>) => string;
    };
    for (const [name, d] of cases) {
      expect(freezeRule(d), name).toBe(gw.freezeRule(d) as ReturnType<typeof freezeRule>);
      expect(transferRule(d), name).toBe(gw.transferRule(d) as ReturnType<typeof transferRule>);
      const app = model.issuerControl({ recall: gw.recallRule(d), freeze: gw.freezeRule(d), transfer: gw.transferRule(d) });
      expect(issuerControlRule(d), name).toBe(app as ReturnType<typeof issuerControlRule>);
    }
  });
  test('readResourceControl reads it from the entity details', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ items: [{ details: details() }] }))) as typeof fetch;
    try {
      expect(await readResourceControl(CONFIG, NFT)).toBe('locked');
    } finally {
      globalThis.fetch = real;
    }
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    try {
      expect(await readResourceControl(CONFIG, NFT)).toBe('unknown');
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('Guild receipts are never a swap asset or an ask', () => {
  const xrd: SwapAsk = { kind: 'fungible', resource: MAINNET_XRD, amount: '5000' };

  test('the receipt resources are the component\'s listing receipt (from its state) and the escrow\'s two (config)', () => {
    expect(guildReceiptResources(CONFIG, RECEIPT)).toEqual([RECEIPT, CONFIG.taskReceiptResource, CONFIG.claimReceiptResource]);
  });
  test.skipIf(STANDALONE)('parity with guild-app: the same three resources, and the same isReceiptAsset answers', async () => {
    const app = (await import('../../../guild-app/src/lib/nft-swap')) as unknown as {
      guildReceiptResources: (r: string) => string[];
      isReceiptAsset: (a: string, r: unknown) => boolean;
    };
    const kit = await import('./manifests.js');
    expect(guildReceiptResources(CONFIG, RECEIPT)).toEqual(app.guildReceiptResources(RECEIPT));
    for (const list of [[RECEIPT], [RECEIPT, NFT], [], null, undefined, [undefined], ['junk']]) {
      for (const asset of [RECEIPT, NFT, OTHER_NFT]) {
        expect(kit.isReceiptAsset(asset, list as never), JSON.stringify([asset, list])).toBe(app.isReceiptAsset(asset, list));
      }
    }
  });

  test.each([
    ['the listing receipt', () => RECEIPT],
    ['the task receipt', () => CONFIG.taskReceiptResource],
    ['the claim receipt', () => CONFIG.claimReceiptResource],
  ])('fill-swap refuses a listing whose NFT is %s, with locked roles, and signs nothing', async (_n, res) => {
    const { d, signed } = deps({ read: { kind: 'ok', state: STATE, listing: listing({ assetResource: res() }) } });
    const r = await runFillSwap({ listingId: 3, live: true, maxPrice: { resource: MAINNET_XRD, amount: '5000' }, identity: await identity(), config: CONFIG, deps: d });
    expect(r.refused).toBe(true);
    expect(r.message).toMatch(/is a Guild receipt by address or by name .*so a fill is not offered/);
    expect(signed).toEqual([]);
  });
  test.each([
    ['the listing receipt', () => RECEIPT],
    ['the task receipt', () => CONFIG.taskReceiptResource],
  ])('list-swap refuses %s as the NFT, and as an ask', async (_n, res) => {
    const id = await identity();
    const asAsset = deps({ holder: id.address });
    const a = await runListSwap({ nft: { resource: res(), id: '#2#' }, asks: [xrd], days: 7, live: true, identity: id, config: CONFIG, deps: asAsset.d });
    expect(a.refused).toBe(true);
    expect(a.message).toMatch(/is a Guild receipt by address or by name .*so it cannot be listed here/);
    const asAsk = deps({ holder: id.address });
    const b = await runListSwap({ nft: { resource: NFT, id: '#2#' }, asks: [{ kind: 'nonFungible', resource: res(), id: '#5#' }], days: 7, live: true, identity: id, config: CONFIG, deps: asAsk.d });
    expect(b.refused).toBe(true);
    expect(b.message).toMatch(/ask 0: .* is a Guild receipt by address or by name .*so it cannot be asked for here/);
    expect([...asAsset.signed, ...asAsk.signed]).toEqual([]);
  });

  test.each([
    ['recallable', /ask 0: recall is not permanently switched off .* so it cannot be asked for here/],
    ['freezable', /ask 0: freezing is not permanently switched off/],
    ['restrictable', /ask 0: transfers of .* are restricted/],
    ['unknown', /ask 0: could not confirm/],
  ] as const)('list-swap refuses an ask whose resource is %s, though the NFT itself is locked', async (state, line) => {
    const id = await identity();
    const { d, signed } = deps({ holder: id.address, readResourceControl: async (_c, r) => (r === MAINNET_XRD ? state : 'locked') });
    const r = await runListSwap({ nft: { resource: NFT, id: '#2#' }, asks: [xrd], days: 7, live: true, identity: id, config: CONFIG, deps: d });
    expect(r.refused).toBe(true);
    expect(r.message).toMatch(line);
    expect(signed).toEqual([]);
  });
});

// A receipt from another instance of the escrow or swap blueprints has a
// different address and the same name. Mainnet listing 4 was one: a "Guild
// Marketplace Task Receipt" that is not the configured escrow's.
describe('a Guild receipt the address list does not know is caught by its name', () => {
  const xrd: SwapAsk = { kind: 'fungible', resource: MAINNET_XRD, amount: '5000' };
  const NAMES = ['Guild Marketplace Task Receipt', 'Guild Marketplace Claim Receipt', 'Guild NFT Swap Listing Receipt'];

  test.each(NAMES)('fill-swap refuses a listing whose NFT is named "%s", with locked roles', async (name) => {
    const { d, signed } = deps({ readResourceName: async () => name, read: { kind: 'ok', state: STATE, listing: listing({ assetResource: OTHER_NFT }) } });
    const r = await runFillSwap({ listingId: 3, live: true, maxPrice: { resource: MAINNET_XRD, amount: '5000' }, identity: await identity(), config: CONFIG, deps: d });
    expect(r.refused).toBe(true);
    expect(r.message).toMatch(/is a Guild receipt by address or by name/);
    expect(signed).toEqual([]);
  });
  test.each(NAMES)('list-swap refuses an NFT named "%s", and an ask named so', async (name) => {
    const id = await identity();
    const asAsset = deps({ holder: id.address, readResourceName: async (_c, r) => (r === OTHER_NFT ? name : null) });
    const a = await runListSwap({ nft: { resource: OTHER_NFT, id: '#2#' }, asks: [xrd], days: 7, live: true, identity: id, config: CONFIG, deps: asAsset.d });
    expect(a.refused).toBe(true);
    expect(a.message).toMatch(/so it cannot be listed here/);
    const asAsk = deps({ holder: id.address, readResourceName: async (_c, r) => (r === OTHER_NFT ? name : null) });
    const b = await runListSwap({ nft: { resource: NFT, id: '#2#' }, asks: [{ kind: 'nonFungible', resource: OTHER_NFT, id: '#5#' }], days: 7, live: true, identity: id, config: CONFIG, deps: asAsk.d });
    expect(b.refused).toBe(true);
    expect(b.message).toMatch(/ask 0: .*so it cannot be asked for here/);
    expect([...asAsset.signed, ...asAsk.signed]).toEqual([]);
  });
  test('an ordinary collection name (live listing 9: Ciggie Puffs) still lists and fills, and the builder gets the name', async () => {
    const id = await identity();
    const l = deps({ holder: id.address, readResourceName: async (_c, r) => (r === NFT ? 'Ciggie Puffs' : 'Ciggie') });
    const listed = await runListSwap({ nft: { resource: NFT, id: '#2#' }, asks: [xrd], days: 7, live: true, identity: id, config: CONFIG, deps: l.d });
    expect(listed.refused).toBeUndefined();
    expect(l.signed).toEqual([listSwapManifest(SWAP, id.address, NFT, '#2#', [xrd], LEDGER + 7 * 86400, { ...GUARD, assetName: 'Ciggie Puffs' })]);
    const f = deps({ readResourceName: async () => 'Ciggie Puffs' });
    const filled = await runFillSwap({ listingId: 3, live: true, maxPrice: { resource: MAINNET_XRD, amount: '5000' }, identity: id, config: CONFIG, deps: f.d });
    expect(filled.refused).toBeUndefined();
    expect(f.signed).toHaveLength(1);
  });
  test.skipIf(STANDALONE)('parity with guild-app: isGuildReceiptName, and isReceiptAsset with a name', async () => {
    const app = (await import('../../../guild-app/src/lib/nft-swap')) as unknown as {
      isGuildReceiptName: (n: unknown) => boolean;
      isReceiptAsset: (a: string, r: unknown, n?: unknown) => boolean;
    };
    const kit = await import('./manifests.js');
    const names = [...NAMES, 'guild receipt', 'GUILD-RECEIPT', 'Ｇｕｉｌｄ Receipt', 'Receipt of the Guild', 'Guild Badge', 'Receipt', 'Ciggie Puffs', '', null, undefined, 7];
    for (const n of names) {
      expect(kit.isGuildReceiptName(n as never), String(n)).toBe(app.isGuildReceiptName(n));
      expect(kit.isReceiptAsset(NFT, [RECEIPT], n as never), String(n)).toBe(app.isReceiptAsset(NFT, [RECEIPT], n));
    }
    for (const n of [...NAMES, 'Receipt of the Guild', 'Ｇｕｉｌｄ Receipt']) expect(kit.isGuildReceiptName(n)).toBe(true);
    for (const n of ['Guild Badge', 'Receipt', 'Ciggie Puffs', '', null]) expect(kit.isGuildReceiptName(n)).toBe(false);
  });
  test.each([
    ['fill-swap', async (d: Partial<SwapDeps>, id: AgentIdentity) =>
      runFillSwap({ listingId: 3, live: true, maxPrice: { resource: MAINNET_XRD, amount: '5000' }, identity: id, config: CONFIG, deps: d })],
    ['list-swap', async (d: Partial<SwapDeps>, id: AgentIdentity) =>
      runListSwap({ nft: { resource: NFT, id: '#2#' }, asks: [xrd], days: 7, live: true, identity: id, config: CONFIG, deps: d })],
  ] as const)('%s refuses when the NFT\'s name could not be read, though its roles read locked — and signs nothing', async (_n, run) => {
    const id = await identity();
    const { d, signed } = deps({ holder: id.address, readResourceName: async (_c, r) => (r === NFT ? undefined : null) });
    const r = await run(d, id);
    expect(r.refused).toBe(true);
    expect(r.message).toMatch(/could not read resource_rdx1\w+'s name to check it is not a Guild receipt/);
    expect(r.manifest).toBeUndefined();
    expect(signed).toEqual([]);
  });
  test('list-swap refuses when an ask\'s name could not be read', async () => {
    const id = await identity();
    const { d, signed } = deps({ holder: id.address, readResourceName: async (_c, r) => (r === MAINNET_XRD ? undefined : null) });
    const r = await runListSwap({ nft: { resource: NFT, id: '#2#' }, asks: [xrd], days: 7, live: true, identity: id, config: CONFIG, deps: d });
    expect(r.refused).toBe(true);
    expect(r.message).toMatch(/ask 0: could not read .* name/);
    expect(signed).toEqual([]);
  });

  test('readResourceName: a name, null for a resource with none, undefined when it could not be read', async () => {
    const real = globalThis.fetch;
    const answer = (body: unknown, status = 200) => (globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch);
    try {
      answer({ items: [{ metadata: { items: [{ key: 'name', value: { typed: { value: 'Guild Marketplace Task Receipt' } } }] } }] });
      expect(await readResourceName(CONFIG, NFT)).toBe('Guild Marketplace Task Receipt');
      answer({ items: [{ metadata: { items: [] } }] });
      expect(await readResourceName(CONFIG, NFT)).toBeNull();
      for (const [body, status] of [[{}, 500], [{}, 200], [{ items: [] }, 200], [{ items: [{}] }, 200]] as const) {
        answer(body, status);
        expect(await readResourceName(CONFIG, NFT), JSON.stringify([body, status])).toBeUndefined();
      }
      globalThis.fetch = (async () => {
        throw new Error('network down');
      }) as typeof fetch;
      expect(await readResourceName(CONFIG, NFT)).toBeUndefined();
    } finally {
      globalThis.fetch = real;
    }
  });
});
