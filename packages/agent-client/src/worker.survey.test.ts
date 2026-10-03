// The post-submit survey — pass 3 of runWorkerCycle.
//
// THE GAP IT CLOSES. runWorkerCycle handled `open` (claim) and `assigned` (work
// + submit) and then stopped looking. An agent that delivered work and got
// DISPUTED never learned it had been: it would keep claiming new tasks while a
// 72h window ran out on money it had already earned. The operator-facing half of
// that problem got a Telegram alert; the agent-facing half got nothing, which is
// worse — there is no human watching a channel on the agent's side at all.
//
// Every test below names the mutation it catches.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GuildApiClient, GuildTask } from './api.js';
import type { AgentIdentity } from './identity.js';
import type { OnChainTaskState, WorkerEntitlement } from './gateway.js';
import { runWorkerCycle } from './worker.js';

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
    reward: '0',
    bond: '0',
    workerAccount: ME,
    claimerBadgeId: '#1#',
    claimerIsAgent: true,
    entitlementsPresent: true,
    ...partial,
  };
}

interface Surveyed {
  submitted?: GuildTask[];
  disputed?: GuildTask[];
  listTasksError?: Error;
}

function fakeApi(state: Surveyed): GuildApiClient {
  const api = {
    config: { gatewayBaseUrl: GW, escrowComponent: COMPONENT, apiBaseUrl: 'https://guild.example' },
    isAuthenticated: true,
    authenticate: () => Promise.resolve({ id: ME }),
    listTasks: (filters: { status?: string } = {}) => {
      if (filters.status === 'submitted') {
        if (state.listTasksError) return Promise.reject(state.listTasksError);
        return Promise.resolve({ data: state.submitted ?? [], cursor: null, hasMore: false });
      }
      if (filters.status === 'disputed') {
        return Promise.resolve({ data: state.disputed ?? [], cursor: null, hasMore: false });
      }
      // open + assigned: nothing to claim, nothing to work.
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

function cycle(
  state: Surveyed,
  chainStates: Record<number, OnChainTaskState | null>,
  entitlements: Record<number, WorkerEntitlement | null> = {}
) {
  const log = silentLog();
  const calls = { readTaskState: 0, readWorkerEntitlement: 0 };
  return runWorkerCycle({
    api: fakeApi(state),
    identity,
    log,
    readTaskState: (id: number) => {
      calls.readTaskState++;
      return Promise.resolve(chainStates[id] ?? null);
    },
    readWorkerEntitlement: (id: number) => {
      calls.readWorkerEntitlement++;
      return Promise.resolve(entitlements[id] ?? null);
    },
  }).then(report => ({ report, log, calls }));
}

describe('post-submit survey', () => {
  /**
   * THE CASE THE PASS EXISTS FOR. `raise_dispute` is PUBLIC on-chain and needs
   * no app involvement, so a dispute raised by a hand-built manifest moves the
   * task on chain while the API still says `submitted` — that is not
   * hypothetical, it is how live task 3 was disputed.
   *
   * MUTATION: survey API status instead of chain state. The task reads
   * `submitted` from the API, so a status-only survey reports nothing at all —
   * blind to precisely the case this exists for.
   */
  test('sees a dispute the API has not heard about', async () => {
    const { report, log } = await cycle(
      { submitted: [task({ id: 7, status: 'submitted', assigneeId: ME, onChainTaskId: 7 })] },
      { 7: 'Disputed' }
    );

    expect(report.disputedTaskIds).toEqual([7]);
    expect(log.lines.some(l => l.includes('#7 is DISPUTED on chain'))).toBe(true);
  });

  test('sees a dispute the API HAS heard about', async () => {
    const { report } = await cycle(
      { disputed: [task({ id: 8, status: 'disputed', assigneeId: ME, onChainTaskId: 8 })] },
      { 8: 'Disputed' }
    );

    expect(report.disputedTaskIds).toEqual([8]);
  });

  /**
   * MUTATION: wire raiseDisputeOnChain or autoResolveDisputeOnChain into this
   * pass. Both are exported and reachable from here. `raise_dispute` has no
   * on-chain rate limit and costs the raiser nothing, so an agent that disputes
   * reflexively could flood the single human arbiter at machine speed — and
   * profit from it under the deployed SplitEvenly default. Notifying is the
   * supported behaviour; firing is a decision a human takes.
   */
  test('reports a dispute and signs nothing', async () => {
    let signed = false;
    const log = silentLog();
    const report = await runWorkerCycle({
      api: fakeApi({
        disputed: [task({ id: 9, status: 'disputed', assigneeId: ME, onChainTaskId: 9 })],
      }),
      identity,
      log,
      onChain: true,
      dryRun: false,
      readTaskState: () => Promise.resolve('Disputed' as OnChainTaskState),
      readWorkerEntitlement: () => Promise.resolve(null),
      txFns: {
        claimTaskOnChain: (() => {
          signed = true;
          throw new Error('the survey must not sign');
        }) as never,
        submitTaskOnChain: (() => {
          signed = true;
          throw new Error('the survey must not sign');
        }) as never,
      },
    });

    expect(signed).toBe(false);
    expect(report.disputedTaskIds).toEqual([9]);
    expect(report.intentHashes).toEqual([]);
  });

  /**
   * MUTATION: wire raiseDisputeOnChain or autoResolveDisputeOnChain into
   * worker.ts, by ANY means — a new txFns entry, a direct import-and-call, a
   * helper that reaches dispute.ts's raiseDispute/resolveDispute. P1-16 gave
   * the CLI a supported way to fire these two (guild-worker.ts's `dispute
   * raise` / `dispute resolve`, in dispute.ts) precisely so the LOOP would
   * never need to — the test above only proves claim/submit stay unsigned
   * during this pass, and worker.ts has never imported either dispute
   * function, so there is no injectable seam a behavioural test could spy on.
   * A structural check is the one that actually catches a future call however
   * it is wired in: worker.ts's own source must never contain either name
   * followed by a call, anywhere, full stop. (The doc comment above the
   * survey pass MENTIONS both names in prose — this only fails on a real
   * call, i.e. the identifier immediately followed by `(`.)
   */
  test('worker.ts never calls raiseDisputeOnChain or autoResolveDisputeOnChain, by any wiring', () => {
    const src = readFileSync(join(import.meta.dir, 'worker.ts'), 'utf8');
    // Guards the guard: if neither name appears at all (e.g. the doc comment
    // referencing them was deleted too), the regexes below would vacuously
    // pass — the failure mode where a green check means nothing.
    expect(src).toContain('raiseDisputeOnChain');
    expect(src).toContain('autoResolveDisputeOnChain');
    expect(src).not.toMatch(/\braiseDisputeOnChain\s*\(/);
    expect(src).not.toMatch(/\bautoResolveDisputeOnChain\s*\(/);
  });

  /**
   * MUTATION: treat a null chain read as "nothing happened" and fall through to
   * the API's status. Null is "could not read" — asserting nothing beats
   * asserting wrongly about someone's money, and the task is still there next
   * cycle.
   */
  test('asserts nothing when the chain is unreadable', async () => {
    const { report, log } = await cycle(
      { submitted: [task({ id: 11, status: 'submitted', assigneeId: ME, onChainTaskId: 11 })] },
      { 11: null }
    );

    expect(report.disputedTaskIds).toEqual([]);
    expect(report.driftedTaskIds).toEqual([]);
    expect(log.lines.some(l => l.includes('unreadable'))).toBe(true);
  });

  test('stays quiet on work that is genuinely still awaiting review', async () => {
    const { report } = await cycle(
      { submitted: [task({ id: 12, status: 'submitted', assigneeId: ME, onChainTaskId: 12 })] },
      { 12: 'Submitted' }
    );

    expect(report.awaitingReviewTaskIds).toEqual([12]);
    expect(report.disputedTaskIds).toEqual([]);
    expect(report.driftedTaskIds).toEqual([]);
  });

  test('flags a task the API and the chain disagree about', async () => {
    const { report } = await cycle(
      { submitted: [task({ id: 13, status: 'submitted', assigneeId: ME, onChainTaskId: 13 })] },
      { 13: 'Released' }
    );

    expect(report.driftedTaskIds).toEqual([13]);
  });

  /**
   * MUTATION: filter on nothing, or on creatorId. Every agent would then survey
   * — and warn about — every other agent's disputes.
   */
  test('surveys only work assigned to this agent', async () => {
    const { report, calls } = await cycle(
      {
        submitted: [
          task({ id: 14, status: 'submitted', assigneeId: 'account_rdx1someoneelse', onChainTaskId: 14 }),
        ],
        disputed: [
          task({ id: 15, status: 'disputed', assigneeId: 'account_rdx1someoneelse', onChainTaskId: 15 }),
        ],
      },
      { 14: 'Disputed', 15: 'Disputed' }
    );

    expect(report.disputedTaskIds).toEqual([]);
    expect(report.awaitingReviewTaskIds).toEqual([]);
    // and it did not spend Gateway reads on them either
    expect(calls.readTaskState).toBe(0);
  });

  test('skips a task that was never funded — there is nothing on chain to read', async () => {
    const { calls } = await cycle(
      { submitted: [task({ id: 16, status: 'submitted', assigneeId: ME, onChainTaskId: null })] },
      {}
    );

    expect(calls.readTaskState).toBe(0);
  });
});

describe('post-submit survey — uncollected money', () => {
  test('names the amount owed and the command that collects it', async () => {
    const { report, log } = await cycle(
      { disputed: [task({ id: 20, status: 'disputed', assigneeId: ME, onChainTaskId: 20 })] },
      { 20: 'Released' },
      { 20: entitlement({ reward: '10' }) }
    );

    expect(report.uncollectedTaskIds).toEqual([20]);
    expect(log.lines.some(l => l.includes('guild-worker withdraw 20 --live'))).toBe(true);
  });

  test('counts a bond-only debt — the lanes are different resources', async () => {
    const { report } = await cycle(
      { disputed: [task({ id: 21, status: 'disputed', assigneeId: ME, onChainTaskId: 21 })] },
      { 21: 'Refunded' },
      { 21: entitlement({ reward: '0', bond: '10' }) }
    );

    expect(report.uncollectedTaskIds).toEqual([21]);
  });

  test('says nothing when everything owed has been collected', async () => {
    const { report } = await cycle(
      { disputed: [task({ id: 22, status: 'disputed', assigneeId: ME, onChainTaskId: 22 })] },
      { 22: 'Released' },
      { 22: entitlement({ reward: '0', bond: '0' }) }
    );

    expect(report.uncollectedTaskIds).toEqual([]);
  });

  /**
   * MUTATION: check the VALUES before `entitlementsPresent`, or treat an
   * unreadable entitlement as zero. A pre-pull component carries no entitlement
   * fields at all, so every amount reads "0" — indistinguishable from a task
   * that settled and was fully collected. The agent would then conclude it is
   * owed nothing on evidence that never existed.
   */
  test('a check that could not run says so, instead of reading as "nothing owed"', async () => {
    const cannotSay = [
      { id: 23, ent: entitlement({ reward: '10', entitlementsPresent: false }) },
      { id: 24, ent: null },
    ];
    for (const { id, ent } of cannotSay) {
      const { report, log } = await cycle(
        { disputed: [task({ id, status: 'disputed', assigneeId: ME, onChainTaskId: id })] },
        { [id]: 'Released' },
        { [id]: ent }
      );
      expect(report.uncollectedTaskIds).toEqual([]);
      expect(log.lines.some(l => l.includes('NOT "nothing owed"'))).toBe(true);
    }
  });

  test('does not go looking for entitlements on a task that has not settled', async () => {
    const { calls } = await cycle(
      { disputed: [task({ id: 25, status: 'disputed', assigneeId: ME, onChainTaskId: 25 })] },
      { 25: 'Disputed' }
    );

    expect(calls.readWorkerEntitlement).toBe(0);
  });
});

describe('post-submit survey — failure containment', () => {
  /**
   * MUTATION: let the survey throw. A failure to look at ALREADY-DELIVERED work
   * would then stop the agent claiming and submitting NEW work — one broken
   * endpoint taking down the whole loop.
   */
  test('a survey failure is reported, not swallowed, and does not stop the cycle', async () => {
    const log = silentLog();
    const report = await runWorkerCycle({
      api: fakeApi({ listTasksError: new Error('gateway exploded') }),
      identity,
      log,
      readTaskState: () => Promise.resolve(null),
      readWorkerEntitlement: () => Promise.resolve(null),
    });

    expect(report.errors.some(e => e.includes('post-submit survey failed'))).toBe(true);
    expect(report.errors.some(e => e.includes('gateway exploded'))).toBe(true);
    // The cycle still completed — open/assigned passes ran and returned a report.
    expect(report.openTaskIds).toEqual([]);
  });
});

/**
 * `/api/v1/tasks` filters by STATUS, not by assignee — the client filters to its
 * own work — and the server's default page is 20 rows. So a single unpaged call
 * sees the first 20 tasks IN THE WHOLE MARKETPLACE with that status, and this
 * agent's disputed task can sit on page 2.
 *
 * This blind spot opens with marketplace GROWTH, not with any code change, which
 * is what makes it worth a test rather than a comment.
 */
describe('post-submit survey — pagination', () => {
  function pagedApi(pages: GuildTask[][], onCall?: (f: { cursor?: string }) => void) {
    let calls = 0;
    const api = {
      config: { gatewayBaseUrl: GW, escrowComponent: COMPONENT, apiBaseUrl: 'https://guild.example' },
      isAuthenticated: true,
      authenticate: () => Promise.resolve({ id: ME }),
      listTasks: (filters: { status?: string; cursor?: string } = {}) => {
        if (filters.status !== 'submitted') {
          return Promise.resolve({ data: [], cursor: null, hasMore: false });
        }
        onCall?.(filters);
        const index = filters.cursor ? Number(filters.cursor) : 0;
        calls++;
        return Promise.resolve({
          data: pages[index] ?? [],
          cursor: index + 1 < pages.length ? String(index + 1) : null,
          hasMore: index + 1 < pages.length,
        });
      },
      get pageCalls() {
        return calls;
      },
    };
    return api as unknown as GuildApiClient & { pageCalls: number };
  }

  /**
   * MUTATION: drop the paging loop and read `.data` from one call — the shipped
   * first version. The agent's own disputed task is on page 2, so the survey
   * reports NOTHING, which reads exactly like "you have nothing outstanding".
   */
  test('follows the cursor to find work past the first page', async () => {
    const api = pagedApi([
      [task({ id: 30, status: 'submitted', assigneeId: 'account_rdx1someoneelse', onChainTaskId: 30 })],
      [task({ id: 31, status: 'submitted', assigneeId: ME, onChainTaskId: 31 })],
    ]);
    const log = silentLog();

    const report = await runWorkerCycle({
      api,
      identity,
      log,
      readTaskState: () => Promise.resolve('Disputed' as OnChainTaskState),
      readWorkerEntitlement: () => Promise.resolve(null),
    });

    expect(report.disputedTaskIds).toEqual([31]);
  });

  test('stops as soon as the server says there is no more', async () => {
    const api = pagedApi([[task({ id: 32, status: 'submitted', assigneeId: ME, onChainTaskId: 32 })]]);
    const log = silentLog();

    await runWorkerCycle({
      api,
      identity,
      log,
      readTaskState: () => Promise.resolve('Submitted' as OnChainTaskState),
      readWorkerEntitlement: () => Promise.resolve(null),
    });

    expect(api.pageCalls).toBe(1);
  });

  /**
   * MUTATION: page without a bound, or bound it silently. Unbounded, one agent
   * can spend a whole cycle walking a large marketplace; silent, a truncated
   * survey is indistinguishable from a clean one — which is the exact failure
   * this pass exists to end. Bounded AND loud is the only honest pair.
   */
  test('caps the walk and says so when the cap bites', async () => {
    const many = Array.from({ length: 9 }, (_, i) => [
      task({ id: 40 + i, status: 'submitted', assigneeId: 'account_rdx1someoneelse', onChainTaskId: 40 + i }),
    ]);
    const api = pagedApi(many);
    const log = silentLog();

    await runWorkerCycle({
      api,
      identity,
      log,
      readTaskState: () => Promise.resolve('Submitted' as OnChainTaskState),
      readWorkerEntitlement: () => Promise.resolve(null),
    });

    expect(api.pageCalls).toBe(5);
    expect(log.lines.some(l => l.includes('was NOT checked this cycle'))).toBe(true);
  });

  test('asks for the full page size rather than accepting the 20-row default', async () => {
    const seen: { limit?: number }[] = [];
    const api = {
      config: { gatewayBaseUrl: GW, escrowComponent: COMPONENT, apiBaseUrl: 'https://guild.example' },
      isAuthenticated: true,
      authenticate: () => Promise.resolve({ id: ME }),
      listTasks: (filters: { status?: string; limit?: number } = {}) => {
        if (filters.status === 'submitted' || filters.status === 'disputed') seen.push(filters);
        return Promise.resolve({ data: [], cursor: null, hasMore: false });
      },
    } as unknown as GuildApiClient;

    await runWorkerCycle({
      api,
      identity,
      log: silentLog(),
      readTaskState: () => Promise.resolve(null),
      readWorkerEntitlement: () => Promise.resolve(null),
    });

    expect(seen.length).toBe(2);
    expect(seen.every(f => f.limit === 100)).toBe(true);
  });
});

/**
 * The four findings an adversarial review returned against the first version of
 * this pass. All four were confirmed by an independent refuter; each test below
 * names the mutation that restores the defect.
 */
describe('post-submit survey — review findings', () => {
  function api(state: Partial<Record<string, GuildTask[]>>, seen?: { status?: string }[]) {
    return {
      config: { gatewayBaseUrl: GW, escrowComponent: COMPONENT, apiBaseUrl: 'https://guild.example' },
      isAuthenticated: true,
      authenticate: () => Promise.resolve({ id: ME }),
      listTasks: (f: { status?: string } = {}) => {
        seen?.push(f);
        return Promise.resolve({ data: state[f.status ?? ''] ?? [], cursor: null, hasMore: false });
      },
    } as unknown as GuildApiClient;
  }

  /**
   * FINDING 1. `guild-worker withdraw` takes an ON-CHAIN task id — its own usage
   * string says so, and it passes the argument straight to a Gateway read with
   * no DB lookup anywhere. `task.id` is a Postgres serial; the two numbering
   * spaces diverge for essentially every task.
   *
   * MUTATION: interpolate `task.id`. The agent runs the printed command against
   * whatever unrelated task occupies that slot on the component, gets refused as
   * not-the-payee, and has no correct id printed anywhere to retry with.
   */
  test('the collect command names the ON-CHAIN id, not the DB id', async () => {
    const log = silentLog();
    await runWorkerCycle({
      api: api({ paid: [task({ id: 42, status: 'paid', assigneeId: ME, onChainTaskId: 187 })] }),
      identity,
      log,
      readTaskState: () => Promise.resolve('Released' as OnChainTaskState),
      readWorkerEntitlement: () => Promise.resolve(entitlement({ reward: '5' })),
    });

    expect(log.lines.some(l => l.includes('guild-worker withdraw 187 --live'))).toBe(true);
    expect(log.lines.some(l => l.includes('withdraw 42'))).toBe(false);
  });

  /**
   * FINDING 2. `approve` flips the DB row to `paid` within a network round trip
   * of the on-chain release, so a settled task is almost never still `submitted`
   * when a cycle runs — surveying only submitted/disputed meant the money-owed
   * check practically never fired on the path every successful task takes.
   *
   * MUTATION: drop 'paid'/'refunded' from the surveyed statuses.
   */
  test('surveys settled tasks, which is where uncollected money actually sits', async () => {
    const { report } = await (async () => {
      const log = silentLog();
      const r = await runWorkerCycle({
        api: api({
          paid: [task({ id: 50, status: 'paid', assigneeId: ME, onChainTaskId: 50 })],
          refunded: [task({ id: 51, status: 'refunded', assigneeId: ME, onChainTaskId: 51 })],
        }),
        identity,
        log,
        readTaskState: (id: number) =>
          Promise.resolve((id === 50 ? 'Released' : 'Refunded') as OnChainTaskState),
        readWorkerEntitlement: () => Promise.resolve(entitlement({ bond: '10' })),
      });
      return { report: r };
    })();

    expect(report.uncollectedTaskIds.sort()).toEqual([50, 51]);
  });

  /** A settled task that agrees with the chain is not "drift" — it is the happy path. */
  test('a settled task in agreement is not reported as drifted', async () => {
    const log = silentLog();
    const report = await runWorkerCycle({
      api: api({ paid: [task({ id: 52, status: 'paid', assigneeId: ME, onChainTaskId: 52 })] }),
      identity,
      log,
      readTaskState: () => Promise.resolve('Released' as OnChainTaskState),
      readWorkerEntitlement: () => Promise.resolve(entitlement()),
    });

    expect(report.driftedTaskIds).toEqual([]);
    expect(report.uncollectedTaskIds).toEqual([]);
  });

  /**
   * FINDING 3. On-chain ids restart at 1 per component, so an id is only
   * meaningful WITH its component. A swap does not wait for open disputes — the
   * documented gate is zero uncollected entitlements, and an unresolved dispute
   * has none — so a task can outlive the component it was funded on.
   *
   * MUTATION: drop the component pin. `readTaskState(7, NEW_COMPONENT)` returns
   * a real, unrelated task's state, and the survey reports it as this agent's.
   */
  test('refuses to read a task funded on a different component', async () => {
    const log = silentLog();
    let read = 0;
    const report = await runWorkerCycle({
      api: api({
        disputed: [
          task({
            id: 60,
            status: 'disputed',
            assigneeId: ME,
            onChainTaskId: 7,
            escrowComponent: 'component_rdx1retired',
          }),
        ],
      }),
      identity,
      log,
      readTaskState: () => {
        read++;
        return Promise.resolve('Open' as OnChainTaskState);
      },
      readWorkerEntitlement: () => Promise.resolve(null),
    });

    expect(read).toBe(0);
    expect(report.driftedTaskIds).toEqual([60]);
    expect(log.lines.some(l => l.includes('NOT checked this cycle'))).toBe(true);
  });

  test('still reads a task whose component matches, or that has no pin at all', async () => {
    for (const escrowComponent of [COMPONENT, null, undefined]) {
      let read = 0;
      await runWorkerCycle({
        api: api({
          submitted: [
            task({ id: 61, status: 'submitted', assigneeId: ME, onChainTaskId: 61, escrowComponent }),
          ],
        }),
        identity,
        log: silentLog(),
        readTaskState: () => {
          read++;
          return Promise.resolve('Submitted' as OnChainTaskState);
        },
        readWorkerEntitlement: () => Promise.resolve(null),
      });
      expect(read).toBe(1);
    }
  });

  /**
   * FINDING 4. The payee is pinned at claim_task. `resolveWithdrawal` already
   * refuses a not-the-payee withdrawal before signing — but that is after the
   * agent has been TOLD it is owed money. A false money claim is a defect even
   * when no money can move on it.
   *
   * MUTATION: report on the amounts alone. Combined with an id collision, the
   * agent is told it is owed a stranger's entitlement.
   */
  test('does not call a stranger’s entitlement this agent’s money', async () => {
    const log = silentLog();
    const report = await runWorkerCycle({
      api: api({ paid: [task({ id: 70, status: 'paid', assigneeId: ME, onChainTaskId: 70 })] }),
      identity,
      log,
      readTaskState: () => Promise.resolve('Released' as OnChainTaskState),
      readWorkerEntitlement: () =>
        Promise.resolve(entitlement({ reward: '999', workerAccount: 'account_rdx1stranger' })),
    });

    expect(report.uncollectedTaskIds).toEqual([]);
    expect(log.lines.some(l => l.includes('not this agent'))).toBe(true);
  });

  test('still reports money when the pinned payee IS this agent', async () => {
    const log = silentLog();
    const report = await runWorkerCycle({
      api: api({ paid: [task({ id: 71, status: 'paid', assigneeId: ME, onChainTaskId: 71 })] }),
      identity,
      log,
      readTaskState: () => Promise.resolve('Released' as OnChainTaskState),
      readWorkerEntitlement: () => Promise.resolve(entitlement({ reward: '5', workerAccount: ME })),
    });

    expect(report.uncollectedTaskIds).toEqual([71]);
  });

  test('asks the server for only this agent’s tasks', async () => {
    const seen: { status?: string; assignee?: string }[] = [];
    await runWorkerCycle({
      api: api({}, seen),
      identity,
      log: silentLog(),
      readTaskState: () => Promise.resolve(null),
      readWorkerEntitlement: () => Promise.resolve(null),
    });

    const surveyed = seen.filter(f =>
      ['submitted', 'disputed', 'paid', 'refunded'].includes(f.status ?? '')
    );
    expect(surveyed.length).toBe(4);
    expect(surveyed.every(f => f.assignee === ME)).toBe(true);
  });
});
