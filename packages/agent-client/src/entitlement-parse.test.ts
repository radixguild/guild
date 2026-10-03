// entitlement-parse.test.ts — the Gateway-JSON parser behind `withdraw`.
//
// WHY THIS FILE EXISTS, STATED PLAINLY
// ------------------------------------
// The first cut of P3-1 shipped `readWorkerEntitlement` with ZERO test coverage:
// every case in withdraw.test.ts injects a pre-built WorkerEntitlement through
// `deps.readWorkerEntitlement`, so the real parser was never executed by CI. It
// contained a live bug — `claimer_is_agent` was compared against the STRING
// 'true' while the Gateway renders a Scrypto bool as a JSON boolean — and the
// full suite stayed green, lint stayed green, and a real mainnet read "confirmed"
// the field. That read confirmed nothing: the task it read was member-claimed, so
// the correct and the broken code both returned false.
//
// The fixtures below are the shapes the Gateway actually returns, captured from
// component_rdx1cz468e… on 2026-08-20 (kind "Bool", value false; kind "Decimal",
// value "0"). The boolean case is first because it is the one that got through.

import { describe, expect, test } from 'bun:test';
import { readWorkerEntitlement } from './gateway.js';

const GW = 'https://gateway.test';
const WORKER = 'account_rdx12890803ct999t5ss4qatjyktay82gfy295rr6p4qmhks8twekeqgp9';
const KVS = 'internal_keyvaluestore_rdx1kqxlydyxjffewgq5w40hh8ttkezs4skfy5ls0p373c0ze0xmznc8hv';

interface Field {
  field_name: string;
  value?: unknown;
  kind?: string;
  variant_name?: string;
  fields?: { value: string }[];
}

/** The TaskInfo field set a post-PULL component returns. */
function taskFields(over: Partial<Record<string, Field>> = {}): Field[] {
  const base: Record<string, Field> = {
    worker_entitled: { field_name: 'worker_entitled', kind: 'Decimal', value: '1500' },
    poster_entitled: { field_name: 'poster_entitled', kind: 'Decimal', value: '0' },
    worker_bond_entitled: { field_name: 'worker_bond_entitled', kind: 'Decimal', value: '0' },
    poster_bond_entitled: { field_name: 'poster_bond_entitled', kind: 'Decimal', value: '0' },
    // Native JSON boolean — the encoding the live Gateway actually uses.
    claimer_is_agent: { field_name: 'claimer_is_agent', kind: 'Bool', value: false },
    worker_account: {
      field_name: 'worker_account',
      variant_name: 'Some',
      fields: [{ value: WORKER }],
    },
    claimer_badge_id: {
      field_name: 'claimer_badge_id',
      variant_name: 'Some',
      fields: [{ value: '<guild_member_poster>' }],
    },
  };
  return Object.values({ ...base, ...over });
}

/**
 * A fetch stub answering the two calls the reader makes. Each test uses its own
 * component address: `resolveTasksKvStore` caches per component for the process
 * lifetime, so sharing one address would leak state between tests.
 */
function stubFetch(fields: Field[] | null, opts: { kvOk?: boolean } = {}) {
  return (async (url: string) => {
    if (String(url).includes('/state/entity/details')) {
      if (opts.kvOk === false) return { ok: false } as Response;
      return {
        ok: true,
        json: async () => ({ items: [{ details: { state: { fields: [{ field_name: 'tasks', value: KVS }] } } }] }),
      } as unknown as Response;
    }
    return {
      ok: true,
      json: async () => ({ entries: fields ? [{ value: { programmatic_json: { fields } } }] : [] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

let n = 0;
const nextComponent = () => `component_rdx1test${n++}`;

describe('readWorkerEntitlement — claimer_is_agent encoding', () => {
  // ── THE REGRESSION. This test fails against the shipped-first version. ──
  test('a NATIVE JSON boolean true is read as agent-claimed', async () => {
    const r = await readWorkerEntitlement(
      1,
      nextComponent(),
      GW,
      stubFetch(
        taskFields({
          claimer_is_agent: { field_name: 'claimer_is_agent', kind: 'Bool', value: true },
          claimer_badge_id: { field_name: 'claimer_badge_id', variant_name: 'Some', fields: [{ value: '#1#' }] },
        }),
      ),
    );
    // Comparing only against the string 'true' returns false here, which would
    // send an agent's withdrawal at the MEMBER badge resource and strand it.
    expect(r?.claimerIsAgent).toBe(true);
  });

  test('the STRING "true" is also accepted (other SBOR encoders)', async () => {
    const r = await readWorkerEntitlement(
      1,
      nextComponent(),
      GW,
      stubFetch(
        taskFields({
          claimer_is_agent: { field_name: 'claimer_is_agent', kind: 'Bool', value: 'true' },
        }),
      ),
    );
    expect(r?.claimerIsAgent).toBe(true);
  });

  test('native false, string "false", and junk all read as NOT agent', async () => {
    for (const value of [false, 'false', null, undefined, 1, 'yes']) {
      const r = await readWorkerEntitlement(
        1,
        nextComponent(),
        GW,
        stubFetch(taskFields({ claimer_is_agent: { field_name: 'claimer_is_agent', value } })),
      );
      // An unexpected shape must never read as "agent": that would present the
      // wrong badge resource, which the component rejects.
      expect(r?.claimerIsAgent).toBe(false);
    }
  });
});

describe('readWorkerEntitlement — entitlement presence and values', () => {
  test('a post-PULL task parses all lanes and both pins', async () => {
    const r = await readWorkerEntitlement(1, nextComponent(), GW, stubFetch(taskFields()));
    expect(r).toEqual({
      reward: '1500',
      bond: '0',
      workerAccount: WORKER,
      claimerBadgeId: '<guild_member_poster>',
      claimerIsAgent: false,
      entitlementsPresent: true,
    });
  });

  test('a PRE-pull component reports entitlementsPresent false, not zeroes', async () => {
    // The D trap. Drop the four entitlement fields entirely, as a push
    // component does. Values then default to '0' — and that must NOT be
    // mistaken for "collected".
    const fields = taskFields().filter(f => !f.field_name.includes('entitled'));
    const r = await readWorkerEntitlement(1, nextComponent(), GW, stubFetch(fields));
    expect(r?.entitlementsPresent).toBe(false);
  });

  test('all four entitlement fields are required for presence', async () => {
    for (const drop of [
      'worker_entitled',
      'poster_entitled',
      'worker_bond_entitled',
      'poster_bond_entitled',
    ]) {
      const fields = taskFields().filter(f => f.field_name !== drop);
      const r = await readWorkerEntitlement(1, nextComponent(), GW, stubFetch(fields));
      expect(r?.entitlementsPresent).toBe(false);
    }
  });

  test('None optionals become null, not the string "None"', async () => {
    const r = await readWorkerEntitlement(
      1,
      nextComponent(),
      GW,
      stubFetch(
        taskFields({
          worker_account: { field_name: 'worker_account', variant_name: 'None' },
          claimer_badge_id: { field_name: 'claimer_badge_id', variant_name: 'None' },
        }),
      ),
    );
    expect(r?.workerAccount).toBeNull();
    expect(r?.claimerBadgeId).toBeNull();
  });

  test('a malformed decimal normalises to "0" rather than being echoed', async () => {
    const r = await readWorkerEntitlement(
      1,
      nextComponent(),
      GW,
      stubFetch(taskFields({ worker_entitled: { field_name: 'worker_entitled', value: 'not-a-number' } })),
    );
    expect(r?.reward).toBe('0');
  });
});

describe('readWorkerEntitlement — unknown is never zero', () => {
  test('an unreadable component returns null', async () => {
    const r = await readWorkerEntitlement(1, nextComponent(), GW, stubFetch(null, { kvOk: false }));
    expect(r).toBeNull();
  });

  test('a task with no KVS entry returns null, NOT an empty entitlement', async () => {
    // This is the difference between "we could not find your task" and "your
    // task owes you nothing". Collapsing them tells an agent its money is gone.
    const r = await readWorkerEntitlement(99, nextComponent(), GW, stubFetch(null));
    expect(r).toBeNull();
  });

  test('a thrown fetch returns null rather than propagating', async () => {
    const boom = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    const r = await readWorkerEntitlement(1, nextComponent(), GW, boom);
    expect(r).toBeNull();
  });
});
