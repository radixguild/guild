// fill-swap's spend bound (peer finding SWAP-3): the ask is read from the
// chain, but the listing id is typed, and a transposed id would pay a
// stranger's ask in full from the agent key. --live therefore needs the
// caller's own bound — --max-price for a fungible alternative, --expect-nft
// for a non-fungible one — and refuses, signing nothing, when the chain's ask
// is above it or in another resource.
import { describe, test, expect } from 'bun:test';
import { loadConfig, MAINNET_XRD } from './config.js';
import { AgentIdentity } from './identity.js';
import { fillSwapManifest, type SwapAsk } from './manifests.js';
import { parseMaxPrice, runFillSwap, spendCheck, type SwapDeps, type SwapListing, type SwapState } from './swap.js';
import { main as workerMain } from './guild-worker.js';

const CONFIG = loadConfig();
const NFT = 'resource_rdx1ng3k9ll8yygujlamrszv5qu58nv9kqtala6cry2xql4006ccyrykdk';
// A synthetic token address (well-formed, not a real resource).
const TOKEN = 'resource_rdx1' + 't'.repeat(54);
const SELLER = 'account_rdx12y6ch4m8wjcgu7hrnwfqjeqt70w4kh7qy7k3gs2j9wyx3596fgt3fm';
const LEDGER = 1_790_000_000;
// A throwaway test key (32 bytes of 0x07) — never funded, used only to derive an address.
const identity = () => AgentIdentity.fromPrivateKeyHex('07'.repeat(32));

const STATE: SwapState = {
  listingsKvStore: 'internal_keyvaluestore_rdx1kp9yd7edwqrzn5gnwzc38drdmy8tnjpn864a3v4538tmtxky2x5cqp',
  nextListingId: 10,
  receiptResource: 'resource_rdx1nfq47l0t7glmntfjuandqdmlejzvffq4cvlvrha94kqr52mdrvt2e7',
  fees: { fill: { unit: 'XRD', amount: '0' }, extend: { unit: 'XRD', amount: '0' } },
  ledgerNow: LEDGER,
};

const listing = (ask: SwapAsk): SwapListing => ({
  listingId: 3,
  seller: SELLER,
  assetResource: NFT,
  assetId: '#2#',
  asks: [ask],
  createdAt: LEDGER - 3600,
  expiresAt: LEDGER + 86400,
  state: 'Listed',
  filledWith: null,
  proceedsWithdrawn: false,
});

function deps(ask: SwapAsk, state: SwapState = STATE) {
  const signed: string[] = [];
  const d: Partial<SwapDeps> = {
    readSwapListing: async () => ({ kind: 'ok', state, listing: listing(ask) }),
    signAndSubmitManifest: async (m) => {
      signed.push(m);
      return { intentHash: 'txid_rdx1test', status: 'CommittedSuccess' };
    },
  };
  return { d, signed };
}

const XRD_5000: SwapAsk = { kind: 'fungible', resource: MAINNET_XRD, amount: '5000' };
const NFT_ASK: SwapAsk = { kind: 'nonFungible', resource: NFT, id: '#7#' };

describe('spendCheck — exact, in attos', () => {
  test.each([
    ['5000', 'ok'],
    ['5000.000000000000000001', 'ok'],
    ['4999.999999999999999999', 'over'],
    ['4999', 'over'],
  ])('a 5000 XRD ask under --max-price %s is %s', (cap, verdict) => {
    expect(Object.keys(spendCheck(XRD_5000, { amount: cap, resource: MAINNET_XRD }, undefined))).toEqual([verdict]);
  });

  test('another resource is over, whatever the amount', () => {
    expect(spendCheck(XRD_5000, { amount: '1000000', resource: TOKEN }, undefined)).toHaveProperty('over');
  });

  test('an NFT ask needs --expect-nft naming that NFT (ids compared canonically)', () => {
    expect(spendCheck(NFT_ASK, undefined, undefined)).toHaveProperty('missing');
    expect(spendCheck(NFT_ASK, { amount: '1', resource: MAINNET_XRD }, undefined)).toHaveProperty('missing');
    expect(spendCheck(NFT_ASK, undefined, { resource: NFT, id: '#07#' })).toHaveProperty('ok');
    expect(spendCheck(NFT_ASK, undefined, { resource: NFT, id: '#8#' })).toHaveProperty('over');
    expect(spendCheck(NFT_ASK, undefined, { resource: TOKEN, id: '#7#' })).toHaveProperty('over');
    expect(spendCheck(XRD_5000, undefined, { resource: NFT, id: '#7#' })).toHaveProperty('missing');
  });
});

describe('runFillSwap --live — the bound', () => {
  test.each([
    ['no bound', XRD_5000, {}, '--max-price'],
    ['a bound below the ask', XRD_5000, { maxPrice: { amount: '4999.99', resource: MAINNET_XRD } }, 'above --max-price'],
    ['a bound in another resource', XRD_5000, { maxPrice: { amount: '9999', resource: TOKEN } }, 'not the --max-price resource'],
    ['no --expect-nft for an NFT ask', NFT_ASK, { maxPrice: { amount: '9999', resource: MAINNET_XRD } }, '--expect-nft'],
    ['another NFT', NFT_ASK, { expectNft: { resource: NFT, id: '#8#' } }, 'not the --expect-nft'],
  ])('refuses %s — nothing signed', async (_n, ask, bound, msg) => {
    const { d, signed } = deps(ask);
    const r = await runFillSwap({ listingId: 3, live: true, identity: await identity(), config: CONFIG, deps: d, ...bound });
    expect(r.refused).toBe(true);
    expect(r.message).toContain(msg);
    expect(signed).toEqual([]);
  });

  test('signs within the bound, the same manifest as the dry run', async () => {
    const id = await identity();
    for (const [ask, bound] of [
      [XRD_5000, { maxPrice: { amount: '5000', resource: MAINNET_XRD } }],
      [NFT_ASK, { expectNft: { resource: NFT, id: '#7#' } }],
    ] as const) {
      const { d, signed } = deps(ask);
      const r = await runFillSwap({ listingId: 3, live: true, identity: id, config: CONFIG, deps: d, ...bound });
      expect(r).toMatchObject({ dryRun: false, status: 'CommittedSuccess' });
      expect(signed).toEqual([fillSwapManifest(CONFIG.nftSwapComponent, id.address, 3, 0, ask)]);
    }
  });

  test('a listing whose expiry is the ledger clock is expired — refused before any bound', async () => {
    const { d, signed } = deps(XRD_5000);
    d.readSwapListing = async () => ({ kind: 'ok', state: STATE, listing: { ...listing(XRD_5000), expiresAt: LEDGER } });
    const r = await runFillSwap({ listingId: 3, live: true, identity: await identity(), config: CONFIG, deps: d, maxPrice: { amount: '5000', resource: MAINNET_XRD } });
    expect(r.refused).toBe(true);
    expect(r.message).toContain('is expired');
    expect(signed).toEqual([]);
  });
});

describe('runFillSwap dry run — reports the bound, signs nothing', () => {
  const dry = async (ask: SwapAsk, bound: object) => {
    const lines: string[] = [];
    const { d, signed } = deps(ask);
    const r = await runFillSwap({ listingId: 3, live: false, identity: null, config: CONFIG, deps: d, log: (l) => lines.push(l), ...bound });
    expect(r.dryRun).toBe(true);
    expect(signed).toEqual([]);
    return lines.join('\n');
  };
  test('no bound: says --live will need it', async () => {
    expect(await dry(XRD_5000, {})).toContain('--live will need --max-price');
    expect(await dry(NFT_ASK, {})).toContain('--live will need --expect-nft');
  });
  test('within: prints the comparison; over: says --live would refuse', async () => {
    expect(await dry(XRD_5000, { maxPrice: { amount: '6000', resource: MAINNET_XRD } })).toContain('pays 5000, within --max-price 6000');
    expect(await dry(XRD_5000, { maxPrice: { amount: '10', resource: MAINNET_XRD } })).toContain('--live would refuse: the alternative pays 5000, above --max-price 10');
  });
});

describe('guild-worker fill-swap — the bound flags', () => {
  test('parseMaxPrice: amount, optional resource, XRD by default', () => {
    expect(parseMaxPrice('5000')).toEqual({ amount: '5000', resource: MAINNET_XRD });
    expect(parseMaxPrice(`12.50:${TOKEN}`)).toEqual({ amount: '12.5', resource: TOKEN });
    for (const bad of ['', '0', '-1', '1e3', '0x10', '5000:', '5000:xrd', `:${TOKEN}`, '1.0000000000000000001']) {
      expect(parseMaxPrice(bad), bad).toBeNull();
    }
  });

  test('a malformed bound is a usage error (exit 2), never "no bound"', async () => {
    let ran = false;
    const runFillSwap = async () => {
      ran = true;
      return { dryRun: true };
    };
    for (const argv of [
      ['fill-swap', '3', '--max-price', '1e3'],
      ['fill-swap', '3', '--max-price=5000:junk'],
      ['fill-swap', '3', '--expect-nft', `${NFT}`],
      ['fill-swap', '3', '--expect-nft', `${NFT}:bad id`],
    ]) {
      expect(await workerMain(argv, { loadIdentity: async () => null, runFillSwap }), argv.join(' ')).toBe(2);
    }
    expect(ran).toBe(false);
  });

  test('the parsed bound reaches the runner', async () => {
    let seen: unknown;
    const code = await workerMain(['fill-swap', '3', '--max-price', '5000', '--expect-nft', `${NFT}:#07#`], {
      loadIdentity: async () => null,
      runFillSwap: async (o) => {
        seen = { maxPrice: o.maxPrice, expectNft: o.expectNft };
        return { dryRun: true, manifest: 'M', listingId: 3 };
      },
    });
    expect(code).toBe(0);
    expect(seen).toEqual({ maxPrice: { amount: '5000', resource: MAINNET_XRD }, expectNft: { resource: NFT, id: '#7#' } });
  });
});
