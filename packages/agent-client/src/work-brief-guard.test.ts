// Coverage for the work-brief chain cross-check (EXTERNAL-V1-FRAMEWORK P4-3 —
// the "keystone check"): assert sha256(canonicalWorkBrief(title, description))
// (or the v2 layout, once a term or a deadline is set) == the on-chain
// work_brief_hash BEFORE a claim bonds. Binds the text the agent read to the
// money it stakes.
//
// The finding this exists for: nothing in this codebase decoded a Hash-shaped
// (`kind: "Bytes"`, value under `hex`) Gateway field before this guard — every
// other reader here parses a Decimal string or an enum's variant_name, which
// are shaped differently on the wire. Getting that shape wrong would make the
// guard either never verify anything (always null → always refuse, or worse,
// always fall through to an override) or refuse every honest claim.
//
// A local Bun.serve stands in for the Gateway (matches the
// claim-bond-guard.test.ts / gateway.test.ts idiom). Component addresses are
// namespaced `wb…` so this file's module-level caches in gateway.ts
// (tasksKvStoreCache, claimBondCache — keyed by component address only,
// shared for the process lifetime) can never collide with a same-named
// component already populated by gateway.test.ts or claim-bond-guard.test.ts.

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { readOnChainWorkBriefHash } from './gateway.js';
import { claimTaskOnChain } from './tx.js';
import { workBriefHash } from './work-brief.js';
import { AgentIdentity } from './identity.js';
import { generateThrowawayPrivateKeyHex } from './throwaway-key.js';
import { loadConfig, type GuildClientConfig } from './config.js';

const HONEST_BRIEF = { title: 'Fix login bug', description: 'Session cookie not set on Safari.' };
// Same title, materially different description — models a task whose funded
// on-chain brief and the text an agent actually read have drifted apart.
const TAMPERED_BRIEF = {
  title: 'Fix login bug',
  description: 'Rewrite the entire auth stack, unrelated to what was funded.',
};
const DUE_ISO = '2026-09-01T00:00:00.000Z';

const ESCROW = 'component_rdx1_wbescrow';
const ESCROW_NOTASKS = 'component_rdx1_wbnotasks'; // no `tasks` KV field at all
const ESCROW_UNKNOWN = 'component_rdx1_wbunknown'; // absent from mock state entirely
const TASKS_KV = 'internal_keyvaluestore_rdx1_wbtasks';

const TASK_ID = 1; // v1 brief, matches HONEST_BRIEF
const TASK_ID_NOFIELD = 2; // TaskInfo present but carries no work_brief_hash field
const TASK_ID_MALFORMED = 3; // work_brief_hash present but not well-formed 64-hex Bytes
const TASK_ID_UPPERCASE = 4; // hex reported UPPERCASE — must normalise to compare
const TASK_ID_UNKNOWN = 5; // no KV entry for this id at all
const TASK_ID_V2 = 6; // v2 brief: HONEST_BRIEF + a deadline, no other term

let honestHashHex: string;
let uppercaseVariant: string;
let honestHashV2Hex: string;

let server: ReturnType<typeof Bun.serve>;
let gw: string;

beforeAll(async () => {
  honestHashHex = await workBriefHash(HONEST_BRIEF.title, HONEST_BRIEF.description);
  uppercaseVariant = honestHashHex.toUpperCase();
  honestHashV2Hex = await workBriefHash(HONEST_BRIEF.title, HONEST_BRIEF.description, null, DUE_ISO);

  server = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname;
      const body = (await req.json()) as any;

      if (path === '/state/entity/details') {
        const address: string = body.addresses?.[0];
        if (address === ESCROW) {
          return Response.json({
            items: [
              {
                details: {
                  state: {
                    fields: [
                      { field_name: 'claim_bond_xrd', value: '10' },
                      { field_name: 'tasks', value: TASKS_KV },
                    ],
                  },
                },
              },
            ],
          });
        }
        if (address === ESCROW_NOTASKS) {
          // claim_bond_xrd present so the BOND guard clears; no `tasks` field,
          // so resolveTasksKvStore (and therefore the brief guard) cannot.
          return Response.json({
            items: [{ details: { state: { fields: [{ field_name: 'claim_bond_xrd', value: '10' }] } } }],
          });
        }
        return Response.json({ items: [{ details: {} }] }); // ESCROW_UNKNOWN / anything else
      }

      if (path === '/state/key-value-store/data') {
        const key: string = body.keys?.[0]?.key_json?.value;
        if (key === String(TASK_ID)) {
          return Response.json({
            entries: [
              {
                value: {
                  programmatic_json: {
                    fields: [{ field_name: 'work_brief_hash', kind: 'Bytes', element_kind: 'U8', hex: honestHashHex }],
                  },
                },
              },
            ],
          });
        }
        if (key === String(TASK_ID_NOFIELD)) {
          return Response.json({
            entries: [
              { value: { programmatic_json: { fields: [{ field_name: 'reward_amount', value: '5' }] } } },
            ],
          });
        }
        if (key === String(TASK_ID_MALFORMED)) {
          return Response.json({
            entries: [
              {
                value: {
                  programmatic_json: {
                    fields: [{ field_name: 'work_brief_hash', kind: 'Bytes', element_kind: 'U8', hex: 'not-hex' }],
                  },
                },
              },
            ],
          });
        }
        if (key === String(TASK_ID_UPPERCASE)) {
          return Response.json({
            entries: [
              {
                value: {
                  programmatic_json: {
                    fields: [
                      { field_name: 'work_brief_hash', kind: 'Bytes', element_kind: 'U8', hex: uppercaseVariant },
                    ],
                  },
                },
              },
            ],
          });
        }
        if (key === String(TASK_ID_V2)) {
          return Response.json({
            entries: [
              {
                value: {
                  programmatic_json: {
                    fields: [
                      { field_name: 'work_brief_hash', kind: 'Bytes', element_kind: 'U8', hex: honestHashV2Hex },
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

afterAll(() => server.stop(true));
afterEach(() => {
  delete process.env.GUILD_ALLOW_BRIEF_MISMATCH;
});

const configFor = (escrowComponent: string, overrides: Partial<GuildClientConfig> = {}) =>
  loadConfig({
    escrowComponent,
    gatewayBaseUrl: gw,
    agentBadgeResource: 'resource_rdx1_badge',
    agentBadgeLocalId: '#1#',
    ...overrides,
  });

async function claim(
  onChainTaskId: number,
  escrowComponent: string,
  workBrief: { title: string; description: string; dueIso?: string | null },
  overrides: Partial<GuildClientConfig> = {}
) {
  const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
  return claimTaskOnChain(onChainTaskId, identity, configFor(escrowComponent, overrides), workBrief);
}

describe('readOnChainWorkBriefHash', () => {
  test('reads the committed hash as exact lowercase hex', async () => {
    expect(await readOnChainWorkBriefHash(TASK_ID, ESCROW, gw)).toBe(honestHashHex);
  });

  test('normalises an UPPERCASE hex report to lowercase', async () => {
    expect(await readOnChainWorkBriefHash(TASK_ID_UPPERCASE, ESCROW, gw)).toBe(honestHashHex);
  });

  test('null when the task carries no work_brief_hash field at all', async () => {
    expect(await readOnChainWorkBriefHash(TASK_ID_NOFIELD, ESCROW, gw)).toBeNull();
  });

  test('null when the field is not a well-formed 64-hex Bytes value (unrecognised shape, never a guess)', async () => {
    expect(await readOnChainWorkBriefHash(TASK_ID_MALFORMED, ESCROW, gw)).toBeNull();
  });

  test('null for an unknown task id (no KV entry)', async () => {
    expect(await readOnChainWorkBriefHash(TASK_ID_UNKNOWN, ESCROW, gw)).toBeNull();
  });

  test('null when the component exposes no tasks KV store at all', async () => {
    expect(await readOnChainWorkBriefHash(TASK_ID, ESCROW_NOTASKS, gw)).toBeNull();
  });

  test('null for an unknown component', async () => {
    expect(await readOnChainWorkBriefHash(TASK_ID, ESCROW_UNKNOWN, gw)).toBeNull();
  });
});

describe('claimTaskOnChain work-brief cross-check (P4-3 keystone check)', () => {
  // Both allow-cases assert the DOWNSTREAM error by name (claimTaskManifest
  // rejects this suite's fake component address) rather than merely "did not
  // throw the refusal" — positive proof execution cleared BOTH the bond guard
  // and the brief guard and reached manifest construction. Same idiom as
  // claim-bond-guard.test.ts.
  test('signs when the local brief hashes to the on-chain commitment', async () => {
    expect(claim(TASK_ID, ESCROW, HONEST_BRIEF)).rejects.toThrow('Invalid component_rdx address');
  });

  // MUTATION PROOF: this is the exact scenario the framework doc's evidence
  // bar names — "altered brief → refuse to claim". `bun test` reddens this
  // test (only this describe block; readOnChainWorkBriefHash tests above stay
  // green, since the reader itself is honest — it correctly reports what the
  // mock chain holds) whenever assertWorkBriefMatchesChain's compare is
  // reverted to a no-op, or its early-return is inverted.
  test('MUTATION PROOF: an altered brief refuses the claim', async () => {
    expect(claim(TASK_ID, ESCROW, TAMPERED_BRIEF)).rejects.toThrow('Refusing to sign claim_task');
    expect(claim(TASK_ID, ESCROW, TAMPERED_BRIEF)).rejects.toThrow(
      /work brief for task #1 does not match/
    );
  });

  test('v2 (deadline-only) brief verifies correctly when dueIso is supplied', async () => {
    expect(claim(TASK_ID_V2, ESCROW, { ...HONEST_BRIEF, dueIso: DUE_ISO })).rejects.toThrow(
      'Invalid component_rdx address'
    );
  });

  // REGRESSION for the exact false-positive risk named in the unit's brief: a
  // caller that verifies title+description only (the v1-only reading of "the
  // spec") would compute the v1 hash for a v2 (deadline-set) task and refuse
  // every such honest claim. Proves the guard picks v1/v2 the same way
  // guild-app's sendDepositTx does — via workBriefHash, not independently.
  test('REGRESSION: omitting dueIso on a v2 task mismatches — v1 hash != the committed v2 hash', async () => {
    expect(claim(TASK_ID_V2, ESCROW, HONEST_BRIEF)).rejects.toThrow('Refusing to sign claim_task');
  });

  // ESCROW (not ESCROW_UNKNOWN) deliberately: claim_bond_xrd IS readable there,
  // so the bond guard clears and execution actually reaches the brief guard.
  // An unknown COMPONENT fails the bond guard first (its own "could not read
  // claim_bond_xrd" refusal) — an unknown TASK ID on a known component is
  // what isolates "work_brief_hash specifically is unreadable".
  test('refuses when work_brief_hash cannot be read at all (unknown task id)', async () => {
    expect(claim(TASK_ID_UNKNOWN, ESCROW, HONEST_BRIEF)).rejects.toThrow(
      /could not read work_brief_hash/
    );
  });

  test('refuses when the component has no tasks KV store to read from', async () => {
    expect(claim(TASK_ID, ESCROW_NOTASKS, HONEST_BRIEF)).rejects.toThrow(
      /could not read work_brief_hash/
    );
  });

  test('GUILD_ALLOW_BRIEF_MISMATCH=1 overrides deliberately, even on a tampered brief', async () => {
    process.env.GUILD_ALLOW_BRIEF_MISMATCH = '1';
    expect(claim(TASK_ID, ESCROW, TAMPERED_BRIEF)).rejects.toThrow('Invalid component_rdx address');
  });

  test('the override does not leak — unset, the refusal returns', async () => {
    expect(claim(TASK_ID, ESCROW, TAMPERED_BRIEF)).rejects.toThrow('Refusing to sign claim_task');
  });

  // 🔴 Wave B: the old assertClaimBondMatchesChain cross-check (config vs
  // chain) this test named no longer exists — resolveClaimBond DERIVES the
  // bond from chain, it never compares against a client-side constant. What
  // survives is the ORDERING claim: bond resolution still runs before the
  // brief guard. ESCROW_UNKNOWN proves it: the component carries neither
  // claim_bond_xrd nor the proportional trio, so resolveClaimBond refuses
  // before assertWorkBriefMatchesChain ever runs — if the brief guard ran
  // first instead, ESCROW_UNKNOWN would fail with "could not read
  // work_brief_hash" (it has no `tasks` KV store either), not this message.
  test('the bond guard still fires first (the brief check never masks an unresolvable bond)', async () => {
    expect(claim(TASK_ID, ESCROW_UNKNOWN, HONEST_BRIEF)).rejects.toThrow(
      /neither the proportional claim_bond_pct/
    );
  });

  test('the badge-env guard still fires first (the brief check never masks it)', async () => {
    expect(
      claim(TASK_ID, ESCROW, HONEST_BRIEF, { agentBadgeResource: '', agentBadgeLocalId: '' })
    ).rejects.toThrow('Agent badge env not set');
  });
});
