// The DB-id poster legs (approve / cancel / cancel-after-claim / release-timeout)
// pin the task to the CONFIGURED escrow component before building a manifest.
//
// On-chain task ids restart at 1 per component, so a DB row funded on a retired
// component carries an on-chain id that names a DIFFERENT task on the live one.
// Signing that id against the configured component would approve (pay out) or
// cancel the poster's unrelated task. A task whose component the API does not
// report cannot be pinned, so it is refused unless the operator passes
// --allow-unverified-component; a component MISMATCH is refused regardless.

import { describe, expect, test } from 'bun:test';
import type { GuildTask } from './api.js';
import { AgentIdentity } from './identity.js';
import { loadConfig, RETIRED_LIVE_ESCROW_COMPONENTS } from './config.js';
import {
  main,
  runApprove,
  runCancel,
  runCancelAfterClaim,
  runReleaseTimeout,
  type PosterApiLike,
  type PosterCliDeps,
} from './guild-poster.js';
import type { RunOnChainLegOptions } from './guild-poster.js';

const CONFIG = loadConfig();
const RETIRED = RETIRED_LIVE_ESCROW_COMPONENTS[0]!;

function fakeTask(overrides: Partial<GuildTask>): GuildTask {
  return {
    id: 12, title: 't', description: 'd', status: 'submitted', rewardXrd: '5.00000000',
    creatorId: 'account_rdx1poster', assigneeId: null, requiredTier: null, xpReward: 0,
    onChainTaskId: 3, deadline: null, createdAt: '', updatedAt: '',
    ...overrides,
  };
}

/** Records every chain/API touch after getTask; any of them on a refusal is a failure. */
function harness(task: GuildTask) {
  const touched: string[] = [];
  const signer = (name: string) => async () => {
    touched.push(name);
    return { intentHash: 'txid_rdx1fake', status: 'CommittedSuccess' as const };
  };
  const deps: Partial<PosterCliDeps> = {
    approveAndReleaseOnChain: signer('approveAndReleaseOnChain'),
    cancelTaskOnChain: signer('cancelTaskOnChain'),
    cancelTaskAfterClaimOnChain: signer('cancelTaskAfterClaimOnChain'),
    releaseAfterReviewTimeoutOnChain: signer('releaseAfterReviewTimeoutOnChain'),
  };
  const nope = (name: string) => () => {
    touched.push(name);
    throw new Error(`${name} must not be called`);
  };
  const api: PosterApiLike = {
    getTask: async () => task,
    authenticate: async () => {
      touched.push('authenticate');
      return { id: 'account_rdx1poster' };
    },
    confirmEscrow: async () => {
      touched.push('confirmEscrow');
      return task;
    },
    createTask: nope('createTask'),
    listProjects: nope('listProjects'),
    getProject: nope('getProject'),
    createProject: nope('createProject'),
    updateProject: nope('updateProject'),
  };
  return { api, deps, touched };
}

const LEGS: [string, (o: RunOnChainLegOptions) => ReturnType<typeof runApprove>][] = [
  ['approve', runApprove],
  ['cancel', runCancel],
  ['cancel-after-claim', runCancelAfterClaim],
  ['release-timeout', runReleaseTimeout],
];

describe('DB-id poster legs — escrow component pin', () => {
  for (const [verb, run] of LEGS) {
    test(`${verb} --live refuses a task funded on a retired component; nothing signs`, async () => {
      const identity = await AgentIdentity.fromPrivateKeyHex('aa'.repeat(32));
      const h = harness(fakeTask({ escrowComponent: RETIRED }));
      const result = await run({ dbTaskId: 12, live: true, identity, config: CONFIG, api: h.api, deps: h.deps });
      expect(result.refused).toBe(true);
      expect(result.message).toContain(RETIRED);
      expect(result.manifest).toBeUndefined();
      expect(h.touched).toEqual([]);
    });

    test(`${verb} --live refuses a mismatch even with allowUnverifiedComponent`, async () => {
      const identity = await AgentIdentity.fromPrivateKeyHex('aa'.repeat(32));
      const h = harness(fakeTask({ escrowComponent: RETIRED }));
      const result = await run({
        dbTaskId: 12, live: true, identity, config: CONFIG, api: h.api, deps: h.deps,
        allowUnverifiedComponent: true,
      });
      expect(result.refused).toBe(true);
      expect(h.touched).toEqual([]);
    });

    test(`${verb} --live refuses a task with no reported component (null); nothing signs`, async () => {
      const identity = await AgentIdentity.fromPrivateKeyHex('aa'.repeat(32));
      const h = harness(fakeTask({ escrowComponent: null }));
      const result = await run({ dbTaskId: 12, live: true, identity, config: CONFIG, api: h.api, deps: h.deps });
      expect(result.refused).toBe(true);
      expect(result.message).toMatch(/--allow-unverified-component/);
      expect(h.touched).toEqual([]);
    });

    test(`${verb} --live refuses a task whose component field is missing entirely`, async () => {
      const identity = await AgentIdentity.fromPrivateKeyHex('aa'.repeat(32));
      const h = harness(fakeTask({}));
      const result = await run({ dbTaskId: 12, live: true, identity, config: CONFIG, api: h.api, deps: h.deps });
      expect(result.refused).toBe(true);
      expect(h.touched).toEqual([]);
    });

    test(`${verb} dry run refuses a mismatch too, so the preview shows what --live would do`, async () => {
      const h = harness(fakeTask({ escrowComponent: RETIRED }));
      const result = await run({ dbTaskId: 12, live: false, identity: null, config: CONFIG, api: h.api, deps: h.deps });
      expect(result.refused).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.manifest).toBeUndefined();
    });

    test(`${verb} --live with null component proceeds only with allowUnverifiedComponent`, async () => {
      const identity = await AgentIdentity.fromPrivateKeyHex('aa'.repeat(32));
      const h = harness(fakeTask({ escrowComponent: null }));
      const result = await run({
        dbTaskId: 12, live: true, identity, config: CONFIG, api: h.api, deps: h.deps,
        allowUnverifiedComponent: true,
      });
      expect(result.refused).toBeFalsy();
      expect(result.status).toBe('CommittedSuccess');
      expect(h.touched).toContain('confirmEscrow');
    });

    test(`${verb} --live on the configured component signs as before`, async () => {
      const identity = await AgentIdentity.fromPrivateKeyHex('aa'.repeat(32));
      const h = harness(fakeTask({ escrowComponent: CONFIG.escrowComponent }));
      const result = await run({ dbTaskId: 12, live: true, identity, config: CONFIG, api: h.api, deps: h.deps });
      expect(result.refused).toBeFalsy();
      expect(result.status).toBe('CommittedSuccess');
    });
  }

  test('dry-run log line names the task component', async () => {
    const lines: string[] = [];
    const h = harness(fakeTask({ escrowComponent: CONFIG.escrowComponent }));
    await runApprove({
      dbTaskId: 12, live: false, identity: null, config: CONFIG, api: h.api, deps: h.deps,
      log: l => lines.push(l),
    });
    expect(lines.join('\n')).toContain(`escrowComponent=${CONFIG.escrowComponent}`);
  });

  test('main(): --allow-unverified-component reaches the leg; without it a null component exits 1', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex('aa'.repeat(32));
    const h = harness(fakeTask({ escrowComponent: null }));
    expect(await main(['approve', '12'], { identity, api: h.api, deps: h.deps })).toBe(1);
    expect(await main(['approve', '12', '--allow-unverified-component'], { identity, api: h.api, deps: h.deps })).toBe(0);
    expect(h.touched).toEqual([]); // both were dry runs
  });
});
