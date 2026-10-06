// runWorkerCycle refuses `onChain: true` on a dry run unless the caller opts
// into the claim-only shape with `claimOnly: true`.
//
// The claim section signs a real claim bond on onChain alone; the submit
// section is skipped on a dry run. So `{ dryRun: true, onChain: true }` bonds
// claims it never submits. worker-cli.ts refuses `--on-chain` without `--live`
// (worker-cli.on-chain.test.ts); this is the same guarantee for a caller that
// imports runWorkerCycle directly. The deliberate claim-only shape the setup
// drivers use is pinned in worker.claim-only.test.ts.

import { describe, expect, test } from 'bun:test';
import type { GuildApiClient, GuildTask } from './api.js';
import type { AgentIdentity } from './identity.js';
import { runWorkerCycle } from './worker.js';

const ME = 'account_rdx1me';

function openFundedTask(): GuildTask {
  return {
    id: 30, title: 't', description: 'd', status: 'open', rewardXrd: '1',
    creatorId: 'account_rdx1other', assigneeId: null, requiredTier: 'member',
    xpReward: 0, onChainTaskId: 42, deadline: null, createdAt: '', updatedAt: '',
  };
}

function setup() {
  let apiCalls = 0;
  const api = {
    config: { claimReceiptResource: 'resource_rdx1_claim', gatewayBaseUrl: 'http://gateway.test' },
    get isAuthenticated() { return true; },
    authenticate: () => { apiCalls++; return Promise.resolve({ id: ME }); },
    listTasks: ({ status }: { status: string }) => {
      apiCalls++;
      return Promise.resolve({ data: status === 'open' ? [openFundedTask()] : [] });
    },
    confirmEscrow: (taskId: number) => {
      apiCalls++;
      return Promise.resolve({ ...openFundedTask(), id: taskId, status: 'assigned' });
    },
  } as unknown as GuildApiClient;
  const claims: number[] = [];
  const txFns = {
    claimTaskOnChain: (id: number) => {
      claims.push(id);
      return Promise.resolve({ intentHash: 'txid_rdx1claim', status: 'CommittedSuccess' });
    },
    submitTaskOnChain: () => Promise.resolve({ intentHash: 'txid_rdx1submit', status: 'CommittedSuccess' }),
  } as unknown as NonNullable<Parameters<typeof runWorkerCycle>[0]['txFns']>;
  const base = {
    api,
    identity: { address: ME } as AgentIdentity,
    onChain: true,
    trustedPosters: ['account_rdx1other'],
    txFns,
    resolveClaimReceiptId: () => Promise.resolve(null),
    readTaskState: () => Promise.resolve('Open' as const),
    persistIntentHash: () => {},
    confirmRetryDelayMs: 1,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  return { base, claims, apiCalls: () => apiCalls };
}

describe('runWorkerCycle — onChain on a dry run needs an explicit claimOnly opt-in', () => {
  test('dryRun: true + onChain: true throws, and claimTaskOnChain is never called', async () => {
    const s = setup();
    await expect(runWorkerCycle({ ...s.base, dryRun: true })).rejects.toThrow(/onChain requires dryRun: false/);
    expect(s.claims).toEqual([]);
    expect(s.apiCalls()).toBe(0);
  });

  test('dryRun omitted (defaults to true) + onChain: true also throws', async () => {
    const s = setup();
    await expect(runWorkerCycle({ ...s.base })).rejects.toThrow(/onChain requires dryRun: false/);
    expect(s.claims).toEqual([]);
  });

  test('claimOnly: false is not an opt-in', async () => {
    const s = setup();
    await expect(runWorkerCycle({ ...s.base, dryRun: true, claimOnly: false })).rejects.toThrow(
      /onChain requires dryRun: false/
    );
    expect(s.claims).toEqual([]);
  });

  test('claimOnly: true keeps the deliberate claim-only shape (claims, never submits)', async () => {
    const s = setup();
    const report = await runWorkerCycle({ ...s.base, dryRun: true, claimOnly: true });
    expect(s.claims).toEqual([42]);
    expect(report.submittedTaskIds).toEqual([]);
  });

  test('dryRun: false + onChain: true is the full money path and needs no opt-in', async () => {
    const s = setup();
    await expect(runWorkerCycle({ ...s.base, dryRun: false })).resolves.toBeDefined();
    expect(s.claims).toEqual([42]);
  });
});
