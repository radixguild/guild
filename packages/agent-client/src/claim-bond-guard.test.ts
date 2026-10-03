// Coverage for the claim-bond resolution (EXTERNAL-V1-FRAMEWORK P4-5).
//
// 🔴 REWRITTEN for Wave B W4. The mechanism this file used to cover —
// `assertClaimBondMatchesChain`, which cross-checked a client-side constant
// (`config.claimBondXrd`) against the deployed component's single flat
// `claim_bond_xrd` field — no longer exists. Wave B replaced the flat field
// with three owner-tunable parameters (`claim_bond_pct`/`floor`/`cap`) and
// made the bond PROPORTIONAL to the task's own reward, denominated in the
// task's `reward_token` rather than always XRD. There is no longer a
// client-side constant to cross-check: `tx.ts`'s `resolveClaimBond` DERIVES
// the bond entirely from live chain state instead.
//
// This is exactly the shape the audit that produced the fix called out
// elsewhere in this package: the old test suite's own premise (a configured
// number vs. a single chain field) stopped matching the code it was meant to
// guard. Rewriting it — rather than leaving it green against a deleted
// mechanism, or silently deleting it — is the honest fix.
//
// A local Bun.serve stands in for the Gateway (no network, no mock.module
// pollution — matches the gateway.test.ts / work-brief-guard.test.ts idiom).

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { readOnChainClaimBondXrd } from './gateway.js';
import { claimTaskOnChain, resolveClaimBond } from './tx.js';
import { AgentIdentity } from './identity.js';
import { generateThrowawayPrivateKeyHex } from './throwaway-key.js';
import { loadConfig, MAINNET_XRD, type GuildClientConfig } from './config.js';

// ── The mock world ────────────────────────────────────────────────────────
//
// FLAT: only the legacy claim_bond_xrd field — the shape a component has
// before the Wave B swap ceremony.
const ESCROW_FLAT = 'component_rdx1_flatbond';
const FLAT_BOND_XRD = '10';

// PROPORTIONAL: the Wave B trio, plus a `tasks` KV store so the reward info
// a real claim needs is readable too.
const ESCROW_PROP = 'component_rdx1_propbond';
const PROP_TASKS_KV = 'internal_keyvaluestore_rdx1_propbondtasks';
// Bech32m-shaped (lowercase alnum only, no underscores) — readOnChainTaskReward
// anchors reward_token against the same shape validateAddress requires, so a
// fixture with an underscore in the body would fail that check for reasons
// that have nothing to do with what this file is testing.
const REWARD_TOKEN = 'resource_rdx1t4kep7f5m4wnnkyk8pyr5f6vqjrf2q35pvz4t2rewardtokenaaa';
const TASK_ID_PROP = 1; // reward 50, pct 0.1, floor 1, cap 100 -> bond 5
const TASK_ID_UNKNOWN = 2; // no KV entry at all
const TASK_ID_BAD_DIVISIBILITY = 3; // reward_token unreadable divisibility

// A component that carries a partial proportional trio (pct only) AND no
// legacy field either — resolveClaimBond must fail closed, never guess the
// missing floor/cap from the partial read.
const ESCROW_PARTIAL = 'component_rdx1_partialbond';

// Neither shape at all.
const ESCROW_NOFIELDS = 'component_rdx1_nobond';

const UNREADABLE_REWARD_TOKEN = 'resource_rdx1t4kep7f5m4wnnkyk8pyr5f6vqjrf2q35pvz4t2unreadableaaa';

let server: ReturnType<typeof Bun.serve>;
let gw: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname;
      const body = (await req.json()) as any;

      if (path === '/state/entity/details') {
        const address: string = body.addresses?.[0];

        if (address === ESCROW_FLAT) {
          return Response.json({
            items: [{ details: { state: { fields: [{ field_name: 'claim_bond_xrd', value: FLAT_BOND_XRD }] } } }],
          });
        }
        if (address === ESCROW_PROP) {
          return Response.json({
            items: [
              {
                details: {
                  state: {
                    fields: [
                      { field_name: 'claim_bond_pct', value: '0.1' },
                      { field_name: 'claim_bond_floor', value: '1' },
                      { field_name: 'claim_bond_cap', value: '100' },
                      { field_name: 'tasks', value: PROP_TASKS_KV },
                    ],
                  },
                },
              },
            ],
          });
        }
        if (address === ESCROW_PARTIAL) {
          return Response.json({
            items: [{ details: { state: { fields: [{ field_name: 'claim_bond_pct', value: '0.1' }] } } }],
          });
        }
        if (address === REWARD_TOKEN) {
          return Response.json({ items: [{ details: { type: 'FungibleResource', divisibility: 18 } }] });
        }
        if (address === UNREADABLE_REWARD_TOKEN) {
          // Present, but not a fungible resource shape (e.g. a component) —
          // token_divisibility would panic on-chain; the reader must refuse.
          return Response.json({ items: [{ details: { type: 'GlobalGenericComponent' } }] });
        }
        // ESCROW_NOFIELDS / anything else -> no usable state.
        return Response.json({ items: [{ details: {} }] });
      }

      if (path === '/state/key-value-store/data') {
        const key: string = body.keys?.[0]?.key_json?.value;
        const kvAddress: string = body.key_value_store_address;
        if (kvAddress === PROP_TASKS_KV && key === String(TASK_ID_PROP)) {
          return Response.json({
            entries: [
              {
                value: {
                  programmatic_json: {
                    fields: [
                      { field_name: 'reward_token', kind: 'Reference', value: REWARD_TOKEN },
                      { field_name: 'reward_amount', value: '50' },
                    ],
                  },
                },
              },
            ],
          });
        }
        if (kvAddress === PROP_TASKS_KV && key === String(TASK_ID_BAD_DIVISIBILITY)) {
          return Response.json({
            entries: [
              {
                value: {
                  programmatic_json: {
                    fields: [
                      { field_name: 'reward_token', kind: 'Reference', value: UNREADABLE_REWARD_TOKEN },
                      { field_name: 'reward_amount', value: '50' },
                    ],
                  },
                },
              },
            ],
          });
        }
        return Response.json({ entries: [] }); // TASK_ID_UNKNOWN / anything else
      }

      return new Response('not found', { status: 404 });
    },
  });
  gw = `http://localhost:${server.port}`;
});

// This suite is scoped to bond resolution only. `claimTaskOnChain` also runs
// the work-brief guard (P4-3) right after resolving the bond, and none of
// this file's `tasks` KV fixtures carry a `work_brief_hash` — so, exactly
// like the old claim-bond-guard.test.ts, every claimTaskOnChain() call below
// would fail on "could not read work_brief_hash" before ever reaching the
// assertion this file cares about. Bypass it deliberately.
beforeAll(() => {
  process.env.GUILD_ALLOW_BRIEF_MISMATCH = '1';
});
afterAll(() => {
  server.stop(true);
  delete process.env.GUILD_ALLOW_BRIEF_MISMATCH;
});
afterEach(() => {
  delete process.env.GUILD_ALLOW_BOND_MISMATCH; // belt-and-braces: no env leaks across tests
});

const configFor = (escrowComponent: string, overrides: Partial<GuildClientConfig> = {}) =>
  loadConfig({
    escrowComponent,
    gatewayBaseUrl: gw,
    agentBadgeResource: 'resource_rdx1_badge',
    agentBadgeLocalId: '#1#',
    ...overrides,
  });

const IGNORED_WORK_BRIEF = { title: 'irrelevant', description: 'bond-guard suite only' };

async function claim(onChainTaskId: number, escrowComponent: string, overrides: Partial<GuildClientConfig> = {}) {
  const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
  return claimTaskOnChain(onChainTaskId, identity, configFor(escrowComponent, overrides), IGNORED_WORK_BRIEF);
}

describe('readOnChainClaimBondXrd (legacy flat reader — unchanged)', () => {
  test('reads the deployed claim_bond_xrd as an exact decimal string', async () => {
    expect(await readOnChainClaimBondXrd(ESCROW_FLAT, gw)).toBe(FLAT_BOND_XRD);
  });

  test('null for a component that carries neither shape', async () => {
    expect(await readOnChainClaimBondXrd(ESCROW_NOFIELDS, gw)).toBeNull();
  });
});

describe('resolveClaimBond — dual mode + fail closed (direct, no manifest involved)', () => {
  test('PROPORTIONAL: derives resource + amount from the task reward and live pct/floor/cap', async () => {
    const config = configFor(ESCROW_PROP);
    const bond = await resolveClaimBond(TASK_ID_PROP, config);
    // reward 50 * pct 0.1 = 5, within [1, 100], rounded to 18dp -> unchanged.
    expect(bond).toEqual({ resource: REWARD_TOKEN, amount: '5' });
  });

  test('FLAT: a pre-Wave-B component (no proportional trio) resolves to XRD + the legacy value', async () => {
    const config = configFor(ESCROW_FLAT);
    const bond = await resolveClaimBond(999, config); // task id irrelevant in flat mode
    expect(bond).toEqual({ resource: MAINNET_XRD, amount: FLAT_BOND_XRD });
  });

  test('fails closed when the component exposes NEITHER shape', async () => {
    const config = configFor(ESCROW_NOFIELDS);
    expect(resolveClaimBond(1, config)).rejects.toThrow(
      /neither the proportional claim_bond_pct\/claim_bond_floor\/claim_bond_cap fields.*nor the legacy claim_bond_xrd/s
    );
  });

  test('a PARTIAL proportional trio is never treated as usable — falls through to fail-closed, not a guess', async () => {
    // ESCROW_PARTIAL has claim_bond_pct only (no floor/cap) and no legacy
    // field either. readOnChainClaimBondParams must return null for a
    // partial read (not { pct, floor: undefined, cap: undefined }), so this
    // ends up in the same "neither shape" refusal as ESCROW_NOFIELDS.
    const config = configFor(ESCROW_PARTIAL);
    expect(resolveClaimBond(1, config)).rejects.toThrow(/neither the proportional/);
  });

  test('PROPORTIONAL but the task reward is unreadable (unknown task id): fails closed, never guesses', async () => {
    const config = configFor(ESCROW_PROP);
    expect(resolveClaimBond(TASK_ID_UNKNOWN, config)).rejects.toThrow(
      /could not read task #2's reward_token\/reward_amount/
    );
  });

  test('PROPORTIONAL but the reward token divisibility is unreadable: fails closed, never guesses', async () => {
    const config = configFor(ESCROW_PROP);
    expect(resolveClaimBond(TASK_ID_BAD_DIVISIBILITY, config)).rejects.toThrow(
      /could not read the divisibility of reward token/
    );
  });

  // There is deliberately no override env var for this guard (unlike the
  // retired GUILD_ALLOW_BOND_MISMATCH) — see resolveClaimBond's own doc for
  // why: a wrong guess here is either a reverted tx or real money bonded on
  // an unverified number, and there is no honest number to substitute.
  test('GUILD_ALLOW_BOND_MISMATCH no longer does anything — this guard has no override', async () => {
    process.env.GUILD_ALLOW_BOND_MISMATCH = '1';
    const config = configFor(ESCROW_NOFIELDS);
    expect(resolveClaimBond(1, config)).rejects.toThrow(/neither the proportional/);
  });
});

describe('claimTaskOnChain wiring — resolveClaimBond fires before the brief guard', () => {
  // Positive proof execution cleared bond resolution AND reached manifest
  // construction: the stub component address fails claimTaskManifest's own
  // validator, so getting THAT specific error (not a bond-related one) shows
  // resolveClaimBond succeeded first. Same idiom the old file used.
  test('a resolvable PROPORTIONAL bond lets execution reach manifest construction', async () => {
    expect(claim(TASK_ID_PROP, ESCROW_PROP)).rejects.toThrow('Invalid component_rdx address');
  });

  test('a resolvable FLAT bond lets execution reach manifest construction', async () => {
    expect(claim(1, ESCROW_FLAT)).rejects.toThrow('Invalid component_rdx address');
  });

  test('an unresolvable bond refuses BEFORE the brief guard ever runs', async () => {
    // ESCROW_NOFIELDS also has no `tasks` KV store, so if the brief guard ran
    // first it would fail with "could not read work_brief_hash" instead —
    // asserting THIS specific message proves the bond guard fired first.
    expect(claim(1, ESCROW_NOFIELDS)).rejects.toThrow(/neither the proportional/);
  });

  test('the badge-env guard still fires first (bond resolution never masks it)', async () => {
    expect(claim(TASK_ID_PROP, ESCROW_PROP, { agentBadgeResource: '', agentBadgeLocalId: '' })).rejects.toThrow(
      'Agent badge env not set'
    );
  });
});

// K2-D review: the owner's maxBondXrd must bind the bond claimTaskOnChain reads
// and SIGNS, not only the separate read the claim gate made earlier.
describe('claimTaskOnChain bondCeiling — the signed bond is held to the owner\'s cap', () => {
  async function claimWithCeiling(onChainTaskId: number, escrowComponent: string, ceiling: { resource: string; maxAmount: string }) {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    return claimTaskOnChain(onChainTaskId, identity, configFor(escrowComponent), IGNORED_WORK_BRIEF, ceiling);
  }

  test('a bond one atto over the cap is refused before anything is built or signed', async () => {
    await expect(claimWithCeiling(1, ESCROW_FLAT, { resource: MAINNET_XRD, maxAmount: '9.999999999999999999' })).rejects.toThrow(
      /outside the owner's ceiling/
    );
  });

  test('a bond exactly at the cap goes on to manifest construction', async () => {
    await expect(claimWithCeiling(1, ESCROW_FLAT, { resource: MAINNET_XRD, maxAmount: FLAT_BOND_XRD })).rejects.toThrow(
      'Invalid component_rdx address'
    );
  });

  test('a bond in another token is refused, whatever its amount', async () => {
    await expect(claimWithCeiling(TASK_ID_PROP, ESCROW_PROP, { resource: MAINNET_XRD, maxAmount: '1000' })).rejects.toThrow(
      /outside the owner's ceiling/
    );
  });
});
