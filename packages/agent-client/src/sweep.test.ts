// sweep.test.ts — custody ruling R1's guards.
//
// As with withdraw, the behaviour worth testing is the REFUSALS. Three of them
// decide whether money leaves the agent at all, and to where:
//   - an address typed after --sweep-to can never override the recorded owner;
//   - an unreadable balance is UNKNOWN, never "nothing to sweep" and never zero;
//   - the amount is exact — a float would strand or over-send attos.

import { describe, expect, test } from 'bun:test';
import { loadConfig } from './config.js';
import {
  DEFAULT_FLOAT_XRD,
  MIN_SWEEP_XRD,
  explainSweepRefusal,
  loadOwnerLink,
  resolveSweepAmount,
  ownerLinkFromState,
  resolveSweepDestination,
  sweepToOwner,
  type SweepRefusal,
} from './sweep.js';

// Fixtures already in this package's tests — no new address enters the repo (the
// asset registry sweeps every file). AGENT is a retired account, used only as the
// account swept FROM. OWNER and STRANGER are the two non-account fixtures
// (well-formed strings, not live accounts): a sweep DESTINATION in a test must
// never be a real account on a burned key, even though nothing here signs.
const AGENT = 'account_rdx12890803ct999t5ss4qatjyktay82gfy295rr6p4qmhks8twekeqgp9';
const OWNER = 'account_rdx168e8u653alt59xm8ple6khu6cgce9cfx9mlza6wxf7qs3wwdh0pwpf';
const STRANGER = 'account_rdx12yh4fwevmvnqgdmllrmvmnvhkxvavpmyq2vwvmnvhkxvavpmyqtest';

const LINKED = { ownerAccount: OWNER, floatXrd: '200' };
const UNLINKED = { ownerAccount: null, floatXrd: '200' };

describe('loadOwnerLink — malformed values stop the run, they are never guessed', () => {
  test('nothing set → no owner, the default float', () => {
    expect(loadOwnerLink({})).toEqual({ ownerAccount: null, floatXrd: DEFAULT_FLOAT_XRD });
  });

  test('a well-formed owner and float are read as given', () => {
    expect(loadOwnerLink({ GUILD_OWNER_ACCOUNT: ` ${OWNER} `, GUILD_FLOAT_XRD: '150.5' })).toEqual({
      ownerAccount: OWNER,
      floatXrd: '150.5',
    });
  });

  test.each([
    ['truncated', OWNER.slice(0, -3)],
    ['wrong prefix', OWNER.replace('account_rdx1', 'component_rdx1')],
    ['trailing manifest injection', `${OWNER}")\nCALL_METHOD`],
    ['uppercase', OWNER.toUpperCase()],
  ])('a %s owner address throws', (_label, bad) => {
    expect(() => loadOwnerLink({ GUILD_OWNER_ACCOUNT: bad })).toThrow(/GUILD_OWNER_ACCOUNT/);
  });

  test.each([['0'], ['0.0'], ['-5'], ['1e3'], ['abc'], ['200 XRD']])('float %p throws — a zero float would sweep the next bond', bad => {
    expect(() => loadOwnerLink({ GUILD_FLOAT_XRD: bad })).toThrow(/GUILD_FLOAT_XRD/);
  });
});

describe('resolveSweepDestination — the recorded owner is the only destination', () => {
  test('no flag and a recorded owner → the owner', () => {
    expect(resolveSweepDestination(undefined, LINKED, AGENT)).toEqual({ ok: true, owner: OWNER });
  });

  test('the word "owner" means the recorded one', () => {
    expect(resolveSweepDestination('owner', LINKED, AGENT)).toEqual({ ok: true, owner: OWNER });
  });

  test('naming the recorded owner explicitly is fine', () => {
    expect(resolveSweepDestination(OWNER, LINKED, AGENT)).toEqual({ ok: true, owner: OWNER });
  });

  test('🔴 naming ANY OTHER account while an owner is recorded is refused, not honoured', () => {
    expect(resolveSweepDestination(STRANGER, LINKED, AGENT)).toEqual({ ok: false, refusal: 'owner-mismatch' });
  });

  test('with no recorded owner a typed address is accepted — the operator typed it', () => {
    expect(resolveSweepDestination(OWNER, UNLINKED, AGENT)).toEqual({ ok: true, owner: OWNER });
  });

  test('no owner anywhere → nowhere to send', () => {
    expect(resolveSweepDestination(undefined, UNLINKED, AGENT)).toEqual({ ok: false, refusal: 'owner-not-set' });
    expect(resolveSweepDestination('owner', UNLINKED, AGENT)).toEqual({ ok: false, refusal: 'owner-not-set' });
  });

  test('a malformed typed address is refused before anything else', () => {
    expect(resolveSweepDestination('account_rdx1short', UNLINKED, AGENT)).toEqual({ ok: false, refusal: 'owner-invalid' });
    expect(resolveSweepDestination(`${OWNER}")\nCALL_METHOD`, UNLINKED, AGENT)).toEqual({ ok: false, refusal: 'owner-invalid' });
  });

  test("the agent's own account is never an owner", () => {
    expect(resolveSweepDestination(AGENT, UNLINKED, AGENT)).toEqual({ ok: false, refusal: 'owner-is-agent' });
    expect(resolveSweepDestination(undefined, { ownerAccount: AGENT, floatXrd: '200' }, AGENT)).toEqual({
      ok: false,
      refusal: 'owner-is-agent',
    });
  });
});

describe('resolveSweepDestination — the keyword and the empty value (review findings)', () => {
  test.each([[' owner'], ['Owner'], ['OWNER'], ['owner ']])('%p is the keyword, not an address', typed => {
    expect(resolveSweepDestination(typed, LINKED, AGENT)).toEqual({ ok: true, owner: OWNER });
    expect(resolveSweepDestination(typed, UNLINKED, AGENT)).toEqual({ ok: false, refusal: 'owner-not-set' });
  });

  test('an explicitly EMPTY destination is malformed — it never falls back to the recorded owner', () => {
    expect(resolveSweepDestination('', LINKED, AGENT)).toEqual({ ok: false, refusal: 'owner-invalid' });
    expect(resolveSweepDestination('   ', LINKED, AGENT)).toEqual({ ok: false, refusal: 'owner-invalid' });
  });
});

describe('resolveSweepAmount — exact, and unknown is never zero', () => {
  test('everything above the float goes, to the atto', () => {
    expect(resolveSweepAmount('965.75', '200')).toEqual({ ok: true, amount: '765.75' });
    // Number() cannot hold this; a float implementation would send 12238.34.
    expect(resolveSweepAmount('12438.340000000000000001', '200')).toEqual({
      ok: true,
      amount: '12238.340000000000000001',
    });
  });

  test('an unreadable balance is UNKNOWN — not "within the float"', () => {
    expect(resolveSweepAmount(null, '200')).toEqual({ ok: false, refusal: 'balance-unreadable' });
    expect(resolveSweepAmount('not-a-number', '200')).toEqual({ ok: false, refusal: 'balance-unreadable' });
  });

  test.each([
    ['empty account', '0'],
    ['under the float', '199.76'],
    ['exactly the float', '200'],
    ['over by less than the minimum worth moving', '200.999999999999999999'],
  ])('%s → nothing to sweep', (_label, balance) => {
    expect(resolveSweepAmount(balance, '200')).toEqual({ ok: false, refusal: 'within-float' });
  });

  test('exactly the minimum over the float IS swept', () => {
    expect(resolveSweepAmount('201', '200')).toEqual({ ok: true, amount: MIN_SWEEP_XRD });
  });
});

describe('resolveSweepAmount — a bad float refuses, it never throws and is never zero', () => {
  test.each([['0'], ['0.0'], ['-1'], ['abc'], [''], ['1e3']])('float %p → link-invalid', bad => {
    expect(resolveSweepAmount('5000', bad)).toEqual({ ok: false, refusal: 'link-invalid' });
  });
});

describe('sweepToOwner — dry-run by default, committed means committed', () => {
  const config = loadConfig();
  const identity = { address: AGENT } as never;
  const neverSign = async () => {
    throw new Error('sweepXrdOnChain must not be called here');
  };

  test('a dry run reads the balance, prints the exact transfer, and signs nothing', async () => {
    const r = await sweepToOwner({
      live: false,
      identity,
      link: LINKED,
      config,
      deps: { fetchXrdBalanceExact: async () => '965.75', sweepXrdOnChain: neverSign },
    });
    expect(r.refused).toBe(false);
    expect(r.dryRun).toBe(true);
    expect(r.owner).toBe(OWNER);
    expect(r.amount).toBe('765.75');
    expect(r.manifest).toContain(`Address("${AGENT}")\n  "withdraw"`);
    expect(r.manifest).toContain('Decimal("765.75")');
    expect(r.manifest).toContain(`Address("${OWNER}")\n  "try_deposit_or_abort"`);
    expect(r.intentHash).toBeUndefined();
  });

  test('--live signs exactly the previewed destination and amount', async () => {
    const calls: unknown[][] = [];
    const r = await sweepToOwner({
      live: true,
      identity,
      link: LINKED,
      config,
      deps: {
        fetchXrdBalanceExact: async () => '965.75',
        sweepXrdOnChain: async (...args: unknown[]) => {
          calls.push(args);
          return { intentHash: 'txid_test', status: 'CommittedSuccess' as never };
        },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(OWNER);
    expect(calls[0]?.[1]).toBe('765.75');
    expect(r).toMatchObject({ refused: false, dryRun: false, intentHash: 'txid_test', status: 'CommittedSuccess' });
  });

  test('🔴 a mismatched --sweep-to never reaches the balance read, let alone a signature', async () => {
    let read = 0;
    const r = await sweepToOwner({
      live: true,
      identity,
      requested: STRANGER,
      link: LINKED,
      config,
      deps: {
        fetchXrdBalanceExact: async () => {
          read++;
          return '5000';
        },
        sweepXrdOnChain: neverSign,
      },
    });
    expect(r).toMatchObject({ refused: true, refusal: 'owner-mismatch' });
    expect(read).toBe(0);
    expect(r.manifest).toBeUndefined();
  });

  test('an unreadable balance refuses on --live too — it never sweeps a guess', async () => {
    const r = await sweepToOwner({
      live: true,
      identity,
      link: LINKED,
      config,
      deps: { fetchXrdBalanceExact: async () => null, sweepXrdOnChain: neverSign },
    });
    expect(r).toMatchObject({ refused: true, refusal: 'balance-unreadable', dryRun: false });
  });

  test('signed is not swept: a non-committed status comes back refused, with the hash', async () => {
    const r = await sweepToOwner({
      live: true,
      identity,
      link: LINKED,
      config: { ...config, gatewayBaseUrl: 'http://127.0.0.1:9' },
      deps: {
        fetchXrdBalanceExact: async () => '965.75',
        sweepXrdOnChain: async () => ({ intentHash: 'txid_failed', status: 'CommittedFailure' as never }),
      },
    });
    expect(r).toMatchObject({ refused: true, refusal: 'not-committed', intentHash: 'txid_failed', dryRun: false });
    expect(r.message).toMatch(/still in the agent account/);
  });

  test('no identity refuses as a dry run, whatever was asked', async () => {
    const r = await sweepToOwner({ live: true, identity: null, link: LINKED, config });
    expect(r).toMatchObject({ refused: true, refusal: 'no-identity', dryRun: true });
  });
});

describe('explainSweepRefusal — every refusal has operator-facing words', () => {
  const ALL: SweepRefusal[] = [
    'no-identity',
    'link-invalid',
    'owner-not-set',
    'owner-mismatch',
    'owner-invalid',
    'owner-is-agent',
    'balance-unreadable',
    'within-float',
    'not-committed',
  ];
  test.each(ALL.map(r => [r]))('%s', reason => {
    expect(explainSweepRefusal(reason).length).toBeGreaterThan(40);
  });
  test('the two that look alike on the wire say opposite things', () => {
    expect(explainSweepRefusal('balance-unreadable')).toMatch(/UNKNOWN/);
    expect(explainSweepRefusal('within-float')).not.toMatch(/UNKNOWN/);
  });
});

describe('fetchXrdBalanceExact — a string, and UNKNOWN stays unknown', () => {
  const XRD = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';
  const respond = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  test('returns the Gateway amount verbatim — 18dp survives', async () => {
    const { fetchXrdBalanceExact } = await import('./gateway.js');
    const f = respond(200, { items: [{ resource_address: XRD, amount: '12438.340000000000000001' }] });
    expect(await fetchXrdBalanceExact(AGENT, 'http://gw', f)).toBe('12438.340000000000000001');
  });

  test('an account that does not exist yet, or holds no XRD, is "0"', async () => {
    const { fetchXrdBalanceExact } = await import('./gateway.js');
    expect(await fetchXrdBalanceExact(AGENT, 'http://gw', respond(404, {}))).toBe('0');
    expect(await fetchXrdBalanceExact(AGENT, 'http://gw', respond(200, { items: [] }))).toBe('0');
  });

  test('every UNKNOWN is null, never "0": 5xx, a second page, a malformed amount, a throw', async () => {
    const { fetchXrdBalanceExact } = await import('./gateway.js');
    expect(await fetchXrdBalanceExact(AGENT, 'http://gw', respond(503, {}))).toBeNull();
    expect(await fetchXrdBalanceExact(AGENT, 'http://gw', respond(200, { items: [], next_cursor: 'abc' }))).toBeNull();
    expect(
      await fetchXrdBalanceExact(AGENT, 'http://gw', respond(200, { items: [{ resource_address: XRD, amount: '1e3' }] }))
    ).toBeNull();
    const boom = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await fetchXrdBalanceExact(AGENT, 'http://gw', boom)).toBeNull();
  });
});

describe('sweepToOwner — a malformed link is a REFUSAL, never a throw (review finding)', () => {
  const config = loadConfig();
  const identity = { address: AGENT } as never;
  const withEnv = async (env: Record<string, string>, fn: () => Promise<void>) => {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
    try { await fn(); } finally {
      for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  };

  test('a malformed GUILD_FLOAT_XRD comes back as link-invalid with the reason — nothing is read or signed', async () => {
    await withEnv({ GUILD_OWNER_ACCOUNT: OWNER, GUILD_FLOAT_XRD: 'lots' }, async () => {
      let touched = false;
      const r = await sweepToOwner({
        live: true,
        identity,
        config,
        deps: { fetchXrdBalanceExact: async () => { touched = true; return '5000'; }, sweepXrdOnChain: async () => { touched = true; throw new Error('no'); } },
      });
      expect(r).toMatchObject({ refused: true, refusal: 'link-invalid', dryRun: false });
      expect(r.message).toMatch(/GUILD_FLOAT_XRD/);
      expect(touched).toBe(false);
    });
  });

  test('a malformed GUILD_OWNER_ACCOUNT likewise', async () => {
    await withEnv({ GUILD_OWNER_ACCOUNT: 'account_rdx1short' }, async () => {
      const r = await sweepToOwner({ live: false, identity, config });
      expect(r).toMatchObject({ refused: true, refusal: 'link-invalid' });
      expect(r.message).toMatch(/GUILD_OWNER_ACCOUNT/);
    });
  });

  test('identity is checked BEFORE the link: no key + a bad float is still no-identity, not a throw', async () => {
    await withEnv({ GUILD_FLOAT_XRD: 'lots' }, async () => {
      const r = await sweepToOwner({ live: true, identity: null, config });
      expect(r).toMatchObject({ refused: true, refusal: 'no-identity', dryRun: true });
    });
  });
});

// K2-C: the personal agent's owner link comes from agent.json — one mapping,
// used by both `guild-agent sweep` and `run`.
describe('ownerLinkFromState', () => {
  const OWNER_ACC = OWNER;
  const record = (overrides: Record<string, unknown> = {}) =>
    ({
      version: 1,
      label: 'myagent',
      address: AGENT,
      apiBaseUrl: 'https://radixguild.com',
      status: 'active',
      ownerAccount: OWNER_ACC,
      pendingOwnerAccount: null,
      floatXrd: '150',
      badgeId: null,
      pairedAt: null,
      activatedAt: null,
      ...overrides,
    }) as Parameters<typeof ownerLinkFromState>[0];

  test('an activated record → its pinned owner and funded float', () => {
    expect(ownerLinkFromState(record(), AGENT)).toEqual({ ok: true, link: { ownerAccount: OWNER_ACC, floatXrd: '150' } });
  });
  test('no float recorded → the default float, never zero', () => {
    expect(ownerLinkFromState(record({ floatXrd: null }), AGENT)).toEqual({
      ok: true,
      link: { ownerAccount: OWNER_ACC, floatXrd: DEFAULT_FLOAT_XRD },
    });
  });
  test('refuses: no record, a record for another key, no pinned owner (a pending owner is not one)', () => {
    expect(ownerLinkFromState(null, AGENT).ok).toBe(false);
    expect(ownerLinkFromState(record(), STRANGER).ok).toBe(false);
    expect(ownerLinkFromState(record({ ownerAccount: null, pendingOwnerAccount: OWNER_ACC, status: 'pending' }), AGENT).ok).toBe(false);
  });
});
