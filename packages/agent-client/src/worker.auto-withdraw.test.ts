// P1-22: `--auto-withdraw`, the opt-in that collects every entitlement the
// post-submit survey reports, each cycle, instead of only reporting it.
//
// THE GAP IT CLOSES. The survey (worker.survey.test.ts) has reported
// uncollected entitlements since #636 — but nothing ever signed the
// `withdraw` leg for the agent. An unattended `--loop --on-chain` run
// accumulated reported-but-uncollected XRD indefinitely without a separate
// human or cron running `guild-worker withdraw` by hand.
//
// Every test names the mutation/regression it guards against. Zero network:
// `withdrawWorkerReward` and `describeCommitFailure` are both injected, same
// discipline as worker.test.ts's txFns.

import { describe, expect, test } from 'bun:test';
import type { GuildApiClient, GuildTask } from './api.js';
import type { AgentIdentity } from './identity.js';
import type { OnChainTaskState, WorkerEntitlement } from './gateway.js';
import type { WithdrawOptions, WithdrawResult } from './withdraw.js';
import type { TransactionStatus } from './tx.js';
import { runWorkerCycle, type IntentRecord } from './worker.js';

const ME = 'account_rdx1me';
const GW = 'https://gateway.example';
const COMPONENT = 'component_rdx1escrow';

function task(partial: Partial<GuildTask>): GuildTask {
  return {
    id: 1,
    title: 't',
    description: 'd',
    status: 'open',
    rewardXrd: '20',
    creatorId: 'account_rdx1poster',
    assigneeId: null,
    requiredTier: 'member',
    xpReward: 0,
    onChainTaskId: null,
    deadline: null,
    createdAt: '',
    updatedAt: '',
    ...partial,
  };
}

function entitlement(partial: Partial<WorkerEntitlement> = {}): WorkerEntitlement {
  return {
    reward: '10',
    bond: '0',
    workerAccount: ME,
    claimerBadgeId: '#1#',
    claimerIsAgent: true,
    entitlementsPresent: true,
    ...partial,
  };
}

interface Surveyed {
  paid?: GuildTask[];
}

function fakeApi(state: Surveyed): GuildApiClient {
  const api = {
    config: { gatewayBaseUrl: GW, escrowComponent: COMPONENT, apiBaseUrl: 'https://guild.example' },
    isAuthenticated: true,
    authenticate: () => Promise.resolve({ id: ME }),
    listTasks: (filters: { status?: string } = {}) => {
      if (filters.status === 'paid') {
        return Promise.resolve({ data: state.paid ?? [], cursor: null, hasMore: false });
      }
      return Promise.resolve({ data: [], cursor: null, hasMore: false });
    },
  };
  return api as unknown as GuildApiClient;
}

const identity = { address: ME } as AgentIdentity;

function silentLog() {
  const lines: string[] = [];
  return {
    lines,
    info: (m: string) => lines.push(m),
    warn: (m: string) => lines.push(m),
    error: (m: string) => lines.push(m),
  };
}

/** Spy withdrawWorkerReward: records every call, answers from a script keyed by taskId (the on-chain id). */
function spyWithdraw(script: Record<number, WithdrawResult>) {
  const calls: WithdrawOptions[] = [];
  const fn = (opts: WithdrawOptions): Promise<WithdrawResult> => {
    calls.push(opts);
    const result = script[opts.taskId];
    if (!result) throw new Error(`spyWithdraw: no script entry for taskId ${opts.taskId}`);
    return Promise.resolve(result);
  };
  return { calls, fn };
}

const NEVER_DESCRIBE = (): Promise<string> => {
  throw new Error('describeCommitFailure must not be called on this path');
};

describe('runWorkerCycle — --auto-withdraw default (opt-out, report-only)', () => {
  test('reports the entitlement but never calls withdrawWorkerReward when autoWithdraw is unset', async () => {
    const log = silentLog();
    const { calls, fn } = spyWithdraw({});
    const report = await runWorkerCycle({
      api: fakeApi({ paid: [task({ id: 50, status: 'paid', assigneeId: ME, onChainTaskId: 50 })] }),
      identity,
      log,
      readTaskState: () => Promise.resolve('Released' as OnChainTaskState),
      readWorkerEntitlement: () => Promise.resolve(entitlement()),
      withdrawWorkerReward: fn,
      describeCommitFailure: NEVER_DESCRIBE,
    });

    expect(report.uncollectedTaskIds).toEqual([50]);
    expect(report.withdrawnTaskIds).toEqual([]);
    expect(report.withdrawalIntentHashes).toEqual([]);
    expect(calls.length).toBe(0);
  });

  test('reports but does not withdraw when autoWithdraw is explicitly false', async () => {
    const { calls, fn } = spyWithdraw({});
    const report = await runWorkerCycle({
      api: fakeApi({ paid: [task({ id: 51, status: 'paid', assigneeId: ME, onChainTaskId: 51 })] }),
      identity,
      log: silentLog(),
      autoWithdraw: false,
      readTaskState: () => Promise.resolve('Released' as OnChainTaskState),
      readWorkerEntitlement: () => Promise.resolve(entitlement()),
      withdrawWorkerReward: fn,
    });

    expect(report.uncollectedTaskIds).toEqual([51]);
    expect(report.withdrawnTaskIds).toEqual([]);
    expect(calls.length).toBe(0);
  });
});

describe('runWorkerCycle — --auto-withdraw hard-errors without live', () => {
  /**
   * MUTATION: let autoWithdraw run under a dry-run cycle (the safe default).
   * worker-cli.ts refuses to even START `--auto-withdraw` without `--live`,
   * but a caller that imports `runWorkerCycle` directly bypasses that CLI
   * gate entirely — this is the second, library-level enforcement of the
   * same rule, so `autoWithdraw: true` can never silently combine with the
   * dryRun DEFAULT (true).
   */
  test('autoWithdraw with the default dryRun (true) throws before touching the network', async () => {
    const { calls, fn } = spyWithdraw({});
    await expect(
      runWorkerCycle({
        api: fakeApi({}),
        identity,
        log: silentLog(),
        autoWithdraw: true,
        withdrawWorkerReward: fn,
      })
    ).rejects.toThrow(/autoWithdraw requires dryRun: false/);
    expect(calls.length).toBe(0);
  });

  test('autoWithdraw with dryRun explicitly true also throws', async () => {
    await expect(
      runWorkerCycle({
        api: fakeApi({}),
        identity,
        log: silentLog(),
        autoWithdraw: true,
        dryRun: true,
      })
    ).rejects.toThrow(/autoWithdraw requires dryRun: false/);
  });

  test('autoWithdraw with dryRun: false does not throw the guard', async () => {
    const { fn } = spyWithdraw({});
    await expect(
      runWorkerCycle({
        api: fakeApi({}),
        identity,
        log: silentLog(),
        autoWithdraw: true,
        dryRun: false,
        withdrawWorkerReward: fn,
      })
    ).resolves.toBeDefined();
  });
});

describe('runWorkerCycle — --auto-withdraw collects what the survey reports', () => {
  /**
   * THE CASE THIS FLAG EXISTS FOR: two settled, uncollected tasks in one
   * cycle both get withdrawn — not just the first — and the report carries
   * proof (task id + intent hash) for each.
   */
  test('a cycle with two uncollected tasks withdraws both via the injected fake and reports intent hashes', async () => {
    const log = silentLog();
    const { calls, fn } = spyWithdraw({
      60: {
        refused: false,
        dryRun: false,
        intentHash: 'txid_rdx1withdraw60',
        status: 'CommittedSuccess',
        entitlement: { reward: '10', bond: '0' },
      },
      61: {
        refused: false,
        dryRun: false,
        intentHash: 'txid_rdx1withdraw61',
        status: 'CommittedSuccess',
        entitlement: { reward: '5', bond: '2' },
      },
    });

    const report = await runWorkerCycle({
      api: fakeApi({
        paid: [
          task({ id: 6, status: 'paid', assigneeId: ME, onChainTaskId: 60 }),
          task({ id: 7, status: 'paid', assigneeId: ME, onChainTaskId: 61 }),
        ],
      }),
      identity,
      log,
      autoWithdraw: true,
      dryRun: false,
      readTaskState: () => Promise.resolve('Released' as OnChainTaskState),
      readWorkerEntitlement: (onChainTaskId: number) =>
        Promise.resolve(entitlement(onChainTaskId === 60 ? { reward: '10' } : { reward: '5', bond: '2' })),
      withdrawWorkerReward: fn,
    });

    expect(report.uncollectedTaskIds.sort()).toEqual([6, 7]);
    expect(report.withdrawnTaskIds.sort()).toEqual([6, 7]);
    expect(report.withdrawalIntentHashes).toEqual(
      expect.arrayContaining([
        { taskId: 6, kind: 'withdraw', intentHash: 'txid_rdx1withdraw60' },
        { taskId: 7, kind: 'withdraw', intentHash: 'txid_rdx1withdraw61' },
      ] satisfies IntentRecord[])
    );

    // Called with the ON-CHAIN id (not the DB id) and live: true — the same
    // shape `guild-worker withdraw <onChainTaskId> --live` uses.
    expect(calls.map(c => c.taskId).sort()).toEqual([60, 61]);
    expect(calls.every(c => c.live === true)).toBe(true);
    expect(calls.every(c => c.identity === identity)).toBe(true);

    expect(log.lines.some(l => l.includes('WITHDRAWN task #6') && l.includes('txid_rdx1withdraw60'))).toBe(true);
    expect(log.lines.some(l => l.includes('WITHDRAWN task #7') && l.includes('txid_rdx1withdraw61'))).toBe(true);
  });

  test('does nothing extra when nothing is owed', async () => {
    const { calls, fn } = spyWithdraw({});
    const report = await runWorkerCycle({
      api: fakeApi({ paid: [task({ id: 8, status: 'paid', assigneeId: ME, onChainTaskId: 80 })] }),
      identity,
      log: silentLog(),
      autoWithdraw: true,
      dryRun: false,
      readTaskState: () => Promise.resolve('Released' as OnChainTaskState),
      readWorkerEntitlement: () => Promise.resolve(entitlement({ reward: '0', bond: '0' })),
      withdrawWorkerReward: fn,
    });

    expect(report.uncollectedTaskIds).toEqual([]);
    expect(report.withdrawnTaskIds).toEqual([]);
    expect(calls.length).toBe(0);
  });
});

describe('runWorkerCycle — --auto-withdraw surfaces refusals and failures, never as collected', () => {
  /**
   * A precondition refusal (e.g. badge unavailable, not-the-payee) — nothing
   * was signed. MUTATION: swallow `result.refused` and count it anyway.
   */
  test('a refused withdrawal is surfaced in errors, not counted as withdrawn', async () => {
    const log = silentLog();
    const { fn } = spyWithdraw({
      90: {
        refused: true,
        refusal: 'not-the-payee',
        message: 'Task 90\'s worker payout is pinned to a DIFFERENT account than this agent\'s.',
        dryRun: false,
      },
    });

    const report = await runWorkerCycle({
      api: fakeApi({ paid: [task({ id: 9, status: 'paid', assigneeId: ME, onChainTaskId: 90 })] }),
      identity,
      log,
      autoWithdraw: true,
      dryRun: false,
      readTaskState: () => Promise.resolve('Released' as OnChainTaskState),
      readWorkerEntitlement: () => Promise.resolve(entitlement()),
      withdrawWorkerReward: fn,
    });

    expect(report.withdrawnTaskIds).toEqual([]);
    expect(report.withdrawalIntentHashes).toEqual([]);
    expect(
      report.errors.some(e => e.includes('auto-withdraw #9 REFUSED') && e.includes('DIFFERENT account'))
    ).toBe(true);
    expect(log.lines.some(l => l.includes('REFUSED'))).toBe(true);
  });

  /**
   * Signed and submitted, but the chain did NOT commit it successfully —
   * the exact case PR #638's describeCommitFailure exists to explain.
   * MUTATION: treat any non-throwing withdrawWorkerReward result as
   * collected, regardless of `status`.
   */
  test('a non-CommittedSuccess result is a failure, never collected', async () => {
    const log = silentLog();
    const { fn } = spyWithdraw({
      100: {
        refused: false,
        dryRun: false,
        intentHash: 'txid_rdx1withdraw_failed',
        status: 'CommittedFailure',
        entitlement: { reward: '10', bond: '0' },
      },
    });
    const describeCalls: unknown[] = [];
    const describeCommitFailure = (
      gatewayBaseUrl: string,
      status: TransactionStatus,
      intentHash: string,
      what: string
    ): Promise<string> => {
      describeCalls.push({ gatewayBaseUrl, status, intentHash, what });
      return Promise.resolve(`${what} not committed: ${status} (${intentHash}) — AssertionFailed: nothing_owed`);
    };

    const report = await runWorkerCycle({
      api: fakeApi({ paid: [task({ id: 10, status: 'paid', assigneeId: ME, onChainTaskId: 100 })] }),
      identity,
      log,
      autoWithdraw: true,
      dryRun: false,
      readTaskState: () => Promise.resolve('Released' as OnChainTaskState),
      readWorkerEntitlement: () => Promise.resolve(entitlement()),
      withdrawWorkerReward: fn,
      describeCommitFailure,
    });

    expect(report.withdrawnTaskIds).toEqual([]);
    expect(report.withdrawalIntentHashes).toEqual([]);
    expect(describeCalls.length).toBe(1);
    expect(report.errors.some(e => e.includes('AssertionFailed: nothing_owed'))).toBe(true);
    expect(log.lines.some(l => l.includes('AssertionFailed: nothing_owed'))).toBe(true);
  });

  /**
   * withdrawWorkerReward THROWS outright (e.g. a network blip inside it).
   * MUTATION: let that exception escape the cycle instead of containing it —
   * one task's collection failing must not stop the survey covering (or
   * collecting) the rest.
   */
  test('a thrown error is contained, reported, and does not stop the cycle', async () => {
    const log = silentLog();
    const fn = (): Promise<WithdrawResult> => {
      throw new Error('gateway exploded mid-withdraw');
    };

    const report = await runWorkerCycle({
      api: fakeApi({
        paid: [
          task({ id: 11, status: 'paid', assigneeId: ME, onChainTaskId: 110 }),
          task({ id: 12, status: 'paid', assigneeId: ME, onChainTaskId: 111 }),
        ],
      }),
      identity,
      log,
      autoWithdraw: true,
      dryRun: false,
      readTaskState: () => Promise.resolve('Released' as OnChainTaskState),
      readWorkerEntitlement: () => Promise.resolve(entitlement()),
      withdrawWorkerReward: fn,
    });

    // Both were reported as owed (the throw did not stop the SURVEY either).
    expect(report.uncollectedTaskIds.sort()).toEqual([11, 12]);
    expect(report.withdrawnTaskIds).toEqual([]);
    expect(report.errors.filter(e => e.includes('gateway exploded mid-withdraw')).length).toBe(2);
    expect(log.lines.filter(l => l.includes('gateway exploded mid-withdraw')).length).toBe(2);
  });

  /**
   * Never retried in the same cycle: a failing task's withdrawal is attempted
   * exactly once per cycle, however many uncollected tasks there are.
   */
  test('never retries a failed withdrawal within the same cycle', async () => {
    let calls = 0;
    const fn = (): Promise<WithdrawResult> => {
      calls++;
      return Promise.resolve({ refused: true, refusal: 'nothing-owed', message: 'already collected', dryRun: false });
    };

    await runWorkerCycle({
      api: fakeApi({ paid: [task({ id: 13, status: 'paid', assigneeId: ME, onChainTaskId: 130 })] }),
      identity,
      log: silentLog(),
      autoWithdraw: true,
      dryRun: false,
      readTaskState: () => Promise.resolve('Released' as OnChainTaskState),
      readWorkerEntitlement: () => Promise.resolve(entitlement()),
      withdrawWorkerReward: fn,
    });

    expect(calls).toBe(1);
  });
});
