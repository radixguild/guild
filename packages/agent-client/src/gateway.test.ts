// Offline coverage for the read-only Gateway resolvers. A local Bun.serve stands
// in for the Babylon Gateway (no network, no mock.module pollution — matches the
// api.test.ts idiom) and returns canned /state/... JSON, locking the exact field
// shapes the resolvers parse AND the critical "match on task_id field, not on the
// #N# local id" behavior (a worker may hold stale receipts from expired claims).

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { resolveBadgeLocalId, resolveClaimReceiptId, readTaskState } from './gateway.js';

const ACCOUNT = 'account_rdx1_worker';
const BADGE = 'resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl';
const CLAIM_RECEIPT = 'resource_rdx1n2x2epej0dyahwjga5rrwnx893rq4f7dxvs9psh74kqak5e9delc4w';
const ESCROW = 'component_rdx1_escrow';
// Accounts the fake Gateway answers with an error status (rate limit / outage).
const BUSY: Record<string, number> = { account_rdx1_ratelimited: 429, account_rdx1_outage: 503 };
const TASKS_KV = 'internal_keyvaluestore_rdx1_tasks';
// on-chain task id -> TaskState variant (43 is Claimed → exercises the pin skip).
const TASK_STATES: Record<string, string> = { '42': 'Open', '43': 'Claimed' };

// The worker's held Claim Receipts: local id -> ClaimReceiptData.task_id. The
// "#42#" decoy is the whole point — its NFID number equals task_id 42, but its
// receipt is for task 100, so a correct resolver must NOT return 42 for task 42.
const RECEIPTS: Record<string, number> = {
  '#42#': 100, // decoy: nfid number collides with another task's id
  '#9#': 42, // the real receipt for on-chain task 42
  '#7#': 41, // stale receipt from an earlier expired claim
};

let server: ReturnType<typeof Bun.serve>;
let gw: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname;
      const body = (await req.json()) as any;

      if (path === '/state/entity/details') {
        const busy = BUSY[body.addresses?.[0]];
        if (busy) return new Response('busy', { status: busy });
        // The escrow component's state exposes its `tasks` KV store address.
        if (body.addresses?.[0] === ESCROW) {
          return Response.json({
            items: [{ details: { state: { fields: [{ field_name: 'tasks', value: TASKS_KV }] } } }],
          });
        }
        // Unknown address -> empty (exercises the null-badge / null-receipt path,
        // and the null tasks-KV path for readTaskState on an unknown component).
        if (body.addresses?.[0] !== ACCOUNT) {
          return Response.json({ items: [{ non_fungible_resources: { items: [] } }] });
        }
        return Response.json({
          items: [
            {
              non_fungible_resources: {
                items: [
                  {
                    resource_address: BADGE,
                    vaults: { items: [{ items: ['guild_member_alice'] }] },
                  },
                  {
                    resource_address: CLAIM_RECEIPT,
                    vaults: { items: [{ items: Object.keys(RECEIPTS) }] },
                  },
                ],
              },
            },
          ],
        });
      }

      if (path === '/state/non-fungible/data') {
        const nfId: string = body.non_fungible_ids?.[0];
        const taskId = RECEIPTS[nfId];
        return Response.json({
          non_fungible_ids: [
            {
              data: {
                programmatic_json: {
                  fields: [{ field_name: 'task_id', value: String(taskId) }],
                },
              },
            },
          ],
        });
      }

      if (path === '/state/key-value-store/data') {
        const key: string = body.keys?.[0]?.key_json?.value;
        const variant = TASK_STATES[key];
        if (!variant) return Response.json({ entries: [] }); // unknown task id
        return Response.json({
          entries: [
            {
              value: {
                programmatic_json: { fields: [{ field_name: 'state', variant_name: variant }] },
              },
            },
          ],
        });
      }

      return new Response('not found', { status: 404 });
    },
  });
  gw = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

describe('resolveBadgeLocalId', () => {
  test('returns the string-derived Member badge local id (not #N#)', async () => {
    expect(await resolveBadgeLocalId(ACCOUNT, BADGE, gw)).toBe('guild_member_alice');
  });

  test('returns null when the account holds no such badge', async () => {
    expect(await resolveBadgeLocalId('account_rdx1_stranger', BADGE, gw)).toBeNull();
    expect(await resolveBadgeLocalId(ACCOUNT, 'resource_rdx1_unheld', gw)).toBeNull();
  });

  test('a non-2xx Gateway answer (429 / 503) THROWS — never read as "holds no badge"', async () => {
    for (const account of Object.keys(BUSY)) {
      await expect(resolveBadgeLocalId(account, BADGE, gw)).rejects.toThrow(/could not read its badge holdings/);
    }
  });
});

describe('resolveClaimReceiptId', () => {
  test('matches on the ClaimReceiptData.task_id field, NOT the #N# local id', async () => {
    // task 42's receipt is #9#; the #42# receipt is for task 100. Must return 9.
    expect(await resolveClaimReceiptId(ACCOUNT, CLAIM_RECEIPT, 42, gw)).toBe(9);
    // and the decoy resolves correctly by its own task_id.
    expect(await resolveClaimReceiptId(ACCOUNT, CLAIM_RECEIPT, 100, gw)).toBe(42);
  });

  test('returns null when no held receipt matches the task (submit settled / not indexed)', async () => {
    expect(await resolveClaimReceiptId(ACCOUNT, CLAIM_RECEIPT, 999, gw)).toBeNull();
  });

  test('returns null when the account holds no receipts at all', async () => {
    expect(await resolveClaimReceiptId('account_rdx1_stranger', CLAIM_RECEIPT, 42, gw)).toBeNull();
  });
});

describe('readTaskState (claim pin)', () => {
  test('resolves the live TaskState variant on the configured component', async () => {
    expect(await readTaskState(42, ESCROW, gw)).toBe('Open');
    expect(await readTaskState(43, ESCROW, gw)).toBe('Claimed');
  });

  test('returns null for an unknown task id (empty KV entries)', async () => {
    expect(await readTaskState(999, ESCROW, gw)).toBeNull();
  });

  test('returns null when the component has no tasks KV (unknown/wrong component)', async () => {
    expect(await readTaskState(42, 'component_rdx1_notescrow', gw)).toBeNull();
  });
});
