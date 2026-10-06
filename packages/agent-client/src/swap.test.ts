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
  readSwapState,
  swapStatus,
  type ListingRead,
  type SwapDeps,
  type SwapListing,
  type SwapState,
} from './swap.js';
import { main as posterMain } from './guild-poster.js';
import { main as workerMain } from './guild-worker.js';

const KV = JSON.parse(
  readFileSync(join(import.meta.dir, '..', '..', '..', 'guild-app', 'tests', 'fixtures', 'nft-swap', 'listings-kv-mainnet-2026-10-06.json'), 'utf8')
);
const STANDALONE = !!process.env.GUILD_NO_SIBLING;

const CONFIG = loadConfig();
const SWAP = CONFIG.nftSwapComponent;
const RECEIPT = 'resource_rdx1nfq47l0t7glmntfjuandqdmlejzvffq4cvlvrha94kqr52mdrvt2e7';
const NFT = 'resource_rdx1ng3k9ll8yygujlamrszv5qu58nv9kqtala6cry2xql4006ccyrykdk';
const SELLER = 'account_rdx12y6ch4m8wjcgu7hrnwfqjeqt70w4kh7qy7k3gs2j9wyx3596fgt3fm';
const LEDGER = 1_790_000_000;
// A throwaway test key (32 bytes of 0x07) — never funded, used only to derive an address.
const KEY_HEX = '07'.repeat(32);

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

describe('fill-swap', () => {
  test('dry run: the manifest pays exactly the chain stored ask, signs nothing', async () => {
    const { d, signed } = deps();
    const id = await identity();
    const r = await runFillSwap({ listingId: 3, live: false, identity: id, config: CONFIG, deps: d });
    expect(r.dryRun).toBe(true);
    expect(r.manifest).toBe(fillSwapManifest(SWAP, id.address, 3, 0, listing().asks[0]));
    expect(signed).toEqual([]);
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
    const r = await runFillSwap({ listingId: 3, live: true, identity: id, config: CONFIG, deps: d });
    expect(r).toMatchObject({ dryRun: false, intentHash: 'txid_rdx1test', status: 'CommittedSuccess' });
    expect(signed).toEqual([fillSwapManifest(SWAP, id.address, 3, 0, listing().asks[0])]);

    const failing = deps({ signAndSubmitManifest: async () => ({ intentHash: 'txid_rdx1bad', status: 'CommittedFailure' }) });
    const f = await runFillSwap({ listingId: 3, live: true, identity: id, config: CONFIG, deps: failing.d });
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
    const r = await runFillSwap({ listingId: 3, live: true, identity: await identity(), config: CONFIG, deps: d });
    expect(r.refused).toBeUndefined();
    expect(signed).toHaveLength(1);
  });

  test('an unresolved commit is reported as outcome unknown, never as not committed', async () => {
    for (const status of ['Unknown', 'Pending'] as const) {
      const { d } = deps({ signAndSubmitManifest: async () => ({ intentHash: 'txid_rdx1late', status }) });
      const r = await runFillSwap({ listingId: 3, live: true, identity: await identity(), config: CONFIG, deps: d });
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

describe('list-swap', () => {
  const nft = { resource: NFT, id: '#2#' };
  const xrd5000: SwapAsk = { kind: 'fungible', resource: MAINNET_XRD, amount: '5000' };

  test('dry run with the key: checks the NFT is here, builds the list call at ledger clock + days', async () => {
    const id = await identity();
    const { d, signed } = deps({ holder: id.address });
    const r = await runListSwap({ nft, asks: [xrd5000], days: 7, live: false, identity: id, config: CONFIG, deps: d });
    expect(r.dryRun).toBe(true);
    expect(r.manifest).toBe(listSwapManifest(SWAP, id.address, NFT, '#2#', [xrd5000], LEDGER + 7 * 86400));
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
