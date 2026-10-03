// Regression cover for U5 (docs/EXTERNAL-V1-FRAMEWORK.md §6, P4-4): `guild-worker
// run --loop` exited immediately.
//
// The bug: workerCliMain's loop branch was `startWorkerLoop(options); return;`.
// startWorkerLoop is fire-and-forget — it schedules its own setTimeout chain and
// returns a stop handle synchronously — so that early `return` resolved
// workerCliMain's promise before a single cycle ran. guild-worker.ts's `run`
// subcommand awaits workerCliMain and calls `process.exit(code)` the instant it
// resolves, so the process died before the loop ever ticked. The direct entry
// (`bun run worker`, worker-cli.ts's own import.meta.main guard) masked the bug:
// it never calls process.exit on success, so the dangling setTimeout chain alone
// kept THAT process alive — only `guild-worker run --loop` was actually broken.
//
// These tests exercise workerCliMain itself — the CLI-dispatch layer shared by
// both entry points, where the user-facing bug lived — rather than only
// startWorkerLoop (which worker.test.ts already covers with an injected fake
// API; this file reuses the same fakeApi/identity-cast idioms).

import { describe, expect, test } from 'bun:test';
import type { GuildApiClient, GuildTask } from './api.js';
import type { AgentIdentity } from './identity.js';
import { workerCliMain } from './worker-cli.js';

const ME = 'account_rdx1me';

/**
 * `listTasks` calls one cycle makes, used here purely as a CYCLE COUNTER — these
 * tests are about the loop ticking, not about how many statuses a cycle surveys.
 *
 * open → assigned → the post-submit survey's four statuses (submitted, disputed,
 * paid, refunded). It went 2 → 4 → 6: the survey landed because an agent that
 * delivered work and got disputed had no idea, and then grew paid/refunded
 * because that is where uncollected money actually sits — an approve flips the
 * row to "paid" within a network round trip, so a settled task is almost never
 * still "submitted" when a cycle runs.
 *
 * Named rather than inlined because a bare `toBe(2)` reads as an assertion about
 * request volume and silently becomes wrong every time a pass is added.
 */
const CALLS_PER_CYCLE = 6;

/**
 * Counts listTasks calls — runWorkerCycle makes CALLS_PER_CYCLE of them, so this
 * observes how many cycles actually ran without instrumenting worker.ts itself.
 */
function countingApi(onListTasks: () => void): GuildApiClient {
  let authenticated = false;
  const api = {
    config: { claimReceiptResource: 'resource_rdx1_claim', gatewayBaseUrl: 'http://gateway.test', apiBaseUrl: 'http://api.test' },
    get isAuthenticated(): boolean {
      return authenticated;
    },
    authenticate: () => {
      authenticated = true;
      return Promise.resolve({ id: ME });
    },
    listTasks: () => {
      onListTasks();
      return Promise.resolve({ data: [] as GuildTask[], cursor: null, hasMore: false });
    },
  };
  return api as unknown as GuildApiClient;
}

const identity = { address: ME } as AgentIdentity;

describe('workerCliMain --loop (U5 regression)', () => {
  test('does not resolve after one cycle — the CLI process must stay alive to loop', async () => {
    const api = countingApi(() => {});
    const controller = new AbortController();

    const runPromise = workerCliMain(['--loop'], {
      identity,
      api,
      intervalMs: 5,
      signal: controller.signal,
    });

    // Race against a short timeout. Before the fix, runPromise resolved
    // essentially synchronously (right after the fire-and-forget loop start),
    // so it would win this race every time.
    const outcome = await Promise.race([
      runPromise.then(() => 'resolved' as const),
      new Promise<'still-running'>(resolve => setTimeout(() => resolve('still-running'), 40)),
    ]);
    expect(outcome).toBe('still-running');

    controller.abort();
    await runPromise; // proves the stop path also resolves cleanly, not just that it hangs
  });

  test('survives multiple cycles under test (evidence bar: >= 2 cycles)', async () => {
    let listTasksCalls = 0;
    const api = countingApi(() => {
      listTasksCalls++;
    });
    const controller = new AbortController();

    const runPromise = workerCliMain(['--loop'], {
      identity,
      api,
      intervalMs: 5,
      signal: controller.signal,
    });

    const deadline = Date.now() + 2000;
    while (listTasksCalls < CALLS_PER_CYCLE * 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    controller.abort();
    await runPromise;

    expect(listTasksCalls).toBeGreaterThanOrEqual(CALLS_PER_CYCLE * 2);
  });

  test('single-run mode (no --loop) is unaffected — resolves after exactly one cycle', async () => {
    let listTasksCalls = 0;
    const api = countingApi(() => {
      listTasksCalls++;
    });

    await workerCliMain([], { identity, api });

    expect(listTasksCalls).toBe(CALLS_PER_CYCLE);
  });
});
