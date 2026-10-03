// Custody ruling R1 in the loop: `--auto-withdraw --sweep-to owner`.
//
// What matters here is ORDER and CONTAINMENT, not the sweep's own decisions
// (sweep.test.ts owns those): the sweep runs once per cycle AFTER every
// collection, signs live, can never be enabled without auto-withdraw, stays
// silent when there is nothing to move, and a sweep that fails or throws must
// never stop the agent working or be reported as swept.
//
// Zero network: `withdrawWorkerReward` and `sweepToOwner` are both injected whole.

import { describe, expect, test } from 'bun:test';
import type { GuildApiClient, GuildTask } from './api.js';
import type { AgentIdentity } from './identity.js';
import type { OnChainTaskState, WorkerEntitlement } from './gateway.js';
import type { SweepOptions, SweepResult } from './sweep.js';
import type { WithdrawResult } from './withdraw.js';
import { runWorkerCycle } from './worker.js';

const ME = 'account_rdx1me';
const OWNER = 'account_rdx168e8u653alt59xm8ple6khu6cgce9cfx9mlza6wxf7qs3wwdh0pwpf'; // non-account fixture

function task(partial: Partial<GuildTask>): GuildTask {
  return {
    id: 1,
    title: 't',
    description: 'd',
    status: 'paid',
    rewardXrd: '10',
    creatorId: 'account_rdx1poster',
    assigneeId: ME,
    onChainTaskId: 1,
    ...partial,
  } as GuildTask;
}

const entitlement: WorkerEntitlement = {
  reward: '765',
  bond: '76.5',
  workerAccount: ME,
  claimerBadgeId: '<guild_member_me>',
  claimerIsAgent: false,
  entitlementsPresent: true,
};

function fakeApi(paid: GuildTask[]): GuildApiClient {
  return {
    config: { gatewayBaseUrl: 'https://gateway.example', escrowComponent: 'component_rdx1escrow', apiBaseUrl: 'https://guild.example' },
    isAuthenticated: true,
    authenticate: () => Promise.resolve({ id: ME }),
    listTasks: (filters: { status?: string } = {}) =>
      Promise.resolve({ data: filters.status === 'paid' ? paid : [], cursor: null, hasMore: false }),
  } as unknown as GuildApiClient;
}

const identity = { address: ME } as AgentIdentity;

function silentLog() {
  const lines: string[] = [];
  return { lines, info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
}

const COLLECTED: WithdrawResult = {
  refused: false,
  dryRun: false,
  intentHash: 'txid_rdx1withdraw',
  status: 'CommittedSuccess',
  entitlement: { reward: '765', bond: '76.5' },
};

/** One paid task owed to ME, collected by a fake, then whatever `sweep` answers. */
function cycle(sweep: (o: SweepOptions) => Promise<SweepResult>, extra: Record<string, unknown> = {}) {
  const events: string[] = [];
  const log = silentLog();
  const run = runWorkerCycle({
    api: fakeApi([task({ id: 6, onChainTaskId: 60 })]),
    identity,
    log,
    autoWithdraw: true,
    dryRun: false,
    sweepTo: 'owner',
    readTaskState: () => Promise.resolve('Released' as OnChainTaskState),
    readWorkerEntitlement: () => Promise.resolve(entitlement),
    withdrawWorkerReward: () => {
      events.push('withdraw');
      return Promise.resolve(COLLECTED);
    },
    sweepToOwner: o => {
      events.push('sweep');
      return sweep(o);
    },
    ...extra,
  });
  return { run, events, log };
}

describe('runWorkerCycle — --sweep-to', () => {
  test('sweeps ONCE, AFTER the collection, live, to what was asked — and reports it', async () => {
    const seen: SweepOptions[] = [];
    const { run, events, log } = cycle(o => {
      seen.push(o);
      return Promise.resolve({ refused: false, dryRun: false, owner: OWNER, amount: '841.5', intentHash: 'txid_rdx1sweep', status: 'CommittedSuccess' });
    });
    const report = await run;
    expect(events).toEqual(['withdraw', 'sweep']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ live: true, requested: 'owner', identity });
    expect(report.withdrawnTaskIds).toEqual([6]);
    expect(report.sweep).toEqual({ amount: '841.5', owner: OWNER, intentHash: 'txid_rdx1sweep' });
    expect(report.errors).toEqual([]);
    expect(log.lines.some(l => l.includes('SWEPT 841.5 XRD') && l.includes('txid_rdx1sweep'))).toBe(true);
  });

  test('never sweeps when sweepTo is unset — the default loop is unchanged', async () => {
    const { run, events } = cycle(() => Promise.reject(new Error('must not be called')), { sweepTo: undefined });
    const report = await run;
    expect(events).toEqual(['withdraw']);
    expect(report.sweep).toBeUndefined();
  });

  test('"within the float" is silent: no error, no sweep recorded', async () => {
    const { run, log } = cycle(() =>
      Promise.resolve({ refused: true, refusal: 'within-float', message: 'nothing to sweep', dryRun: false })
    );
    const report = await run;
    expect(report.sweep).toBeUndefined();
    expect(report.errors).toEqual([]);
    expect(log.lines.some(l => l.includes('REFUSED'))).toBe(false);
  });

  test.each([['owner-mismatch'], ['owner-not-set'], ['balance-unreadable'], ['not-committed']] as const)(
    'a %s refusal is an ERROR, and is never reported as swept',
    async refusal => {
      const { run } = cycle(() => Promise.resolve({ refused: true, refusal, message: `why: ${refusal}`, dryRun: false }));
      const report = await run;
      expect(report.sweep).toBeUndefined();
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]).toContain(refusal);
      expect(report.withdrawnTaskIds).toEqual([6]); // the collection still counted
    }
  );

  test('a sweep that THROWS is contained — the cycle still returns its report', async () => {
    const { run } = cycle(() => Promise.reject(new Error('gateway exploded')));
    const report = await run;
    expect(report.withdrawnTaskIds).toEqual([6]);
    expect(report.sweep).toBeUndefined();
    expect(report.errors.some(e => e.includes('sweep threw') && e.includes('gateway exploded'))).toBe(true);
  });

  test('sweepTo without autoWithdraw throws before the cycle does anything', async () => {
    let touched = false;
    const attempt = runWorkerCycle({
      api: fakeApi([]),
      identity,
      log: silentLog(),
      sweepTo: 'owner',
      withdrawWorkerReward: () => {
        touched = true;
        return Promise.resolve(COLLECTED);
      },
      sweepToOwner: () => {
        touched = true;
        return Promise.resolve({ refused: false, dryRun: false });
      },
    });
    await expect(attempt).rejects.toThrow(/sweepTo requires autoWithdraw/);
    expect(touched).toBe(false);
  });
});
