// agent-run.ts — `guild-agent run`. Every rule is re-read each tick; a 403 or
// an owner-mismatch stops the loop within one tick; the day quota is a rolling
// window; the sweep only ever pays the pinned owner; a heartbeat never stops
// it. The worker cycle itself is faked here (its own suites cover it) — these
// tests pin what the DRIVER hands it and how the driver reacts.

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuildApiError, HEARTBEAT_MAX_CHARS, type AgentMe, type GuildApiClient } from './api.js';
import type { AgentState } from './agent-state.js';
import { heartbeatPayload, runAgent, sleepUnlessAborted, type RunDeps } from './agent-run.js';
import { recordClaim } from './claim-quota.js';
import { loadConfig, type GuildClientConfig } from './config.js';
import { AgentIdentity } from './identity.js';
import { generateThrowawayPrivateKeyHex } from './throwaway-key.js';
import { KEY_FILE_ENV } from './key-file.js';
import { _resetSecretsForTests } from './secrets.js';
import type { SweepOptions } from './sweep.js';
import type { IntentRecord, WorkerCycleReport, WorkerOptions } from './worker.js';

const KEY = generateThrowawayPrivateKeyHex();
const OWNER = 'account_rdx12y5senkxfxg38swfv4tg88lx73jqnkdvcnzv8kwwdmg0efl40r2p7u';
const STRANGER = 'account_rdx1299rtllydz2vz6rrs4zafu2htkndwm2g5ksd27rrw9mhrechcm7tlr';
const T0 = Date.parse('2026-09-27T23:59:00.000Z');

let agentAddress = '';
beforeAll(async () => {
  agentAddress = (await AgentIdentity.fromPrivateKeyHex(KEY)).address;
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guild-run-'));
  _resetSecretsForTests();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function state(overrides: Partial<AgentState> = {}): AgentState {
  return {
    version: 1,
    label: 'myagent',
    address: agentAddress,
    apiBaseUrl: 'https://guild.test',
    status: 'active',
    ownerAccount: OWNER,
    pendingOwnerAccount: null,
    floatXrd: '200',
    badgeId: '<guild_member_myagent>',
    pairedAt: null,
    activatedAt: null,
    ...overrides,
  };
}

function me(overrides: Partial<AgentMe> = {}, rules: Partial<AgentMe['rules']> = {}): AgentMe {
  return {
    label: 'myagent',
    status: 'active',
    ownerAccount: OWNER,
    floatXrd: '200',
    badgeId: '<guild_member_myagent>',
    rules: { v: 1, trustedPosters: [OWNER], maxBondXrd: '180', maxClaimsPerDay: 1, dryRun: true, ...rules },
    ...overrides,
  };
}

function report(overrides: Partial<WorkerCycleReport> = {}): WorkerCycleReport {
  return {
    openTaskIds: [],
    assignedTaskIds: [],
    claimedTaskIds: [],
    submittedTaskIds: [],
    awaitingReviewTaskIds: [],
    disputedTaskIds: [],
    driftedTaskIds: [],
    uncollectedTaskIds: [],
    withdrawnTaskIds: [],
    withdrawalIntentHashes: [],
    intentHashes: [],
    errors: [],
    wouldClaimTaskIds: [],
    ruleSkips: [],
    ...overrides,
  };
}

type MeStep = AgentMe | Error;
/** A cycle that signs these claims (through the worker's persistIntentHash, as the real one does) and then returns or throws. */
type SignThen = { sign: number[]; then: WorkerCycleReport | Error };

/** A scripted world: `rules[i]` is what GET /agents/me answers on tick i+1. */
function world(opts: {
  rules: MeStep[];
  reports?: Array<WorkerCycleReport | Error | SignThen>;
  env?: Record<string, string | undefined>;
  readState?: RunDeps['readState'];
  authError?: Error;
  /** Sign-in error for the Nth client created (0-based) — e.g. the one rebuilt when the badge appears. */
  authErrorForClient?: { index: number; error: Error };
  heartbeatError?: Error;
  /** now() advance per tick, ms. */
  step?: number;
  recordClaim?: RunDeps['recordClaim'];
  /** Per cycle: extra claim outcomes the worker reports (e.g. a claim that threw). */
  outcomes?: Array<Array<[number, 'submitted' | 'not-submitted' | 'unknown']>>;
}) {
  const cycles: WorkerOptions[] = [];
  const beats: Record<string, unknown>[] = [];
  const configs: GuildClientConfig[] = [];
  const sweeps: SweepOptions[] = [];
  const persisted: IntentRecord[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let signal: (() => void) | null = null;
  let tickIndex = 0;
  let now = T0;
  const createApi = (config: GuildClientConfig): GuildApiClient => {
    configs.push(config);
    const index = configs.length - 1;
    let authed = false;
    return {
      config,
      get isAuthenticated() {
        return authed;
      },
      authenticate: async () => {
        if (opts.authError) throw opts.authError;
        if (opts.authErrorForClient?.index === index) throw opts.authErrorForClient.error;
        authed = true;
        return { id: agentAddress };
      },
      agentMe: async () => {
        const step = opts.rules[Math.min(tickIndex, opts.rules.length - 1)];
        tickIndex++;
        if (step instanceof Error) throw step;
        return step;
      },
      heartbeat: async (cycle: Record<string, unknown>) => {
        beats.push(cycle);
        if (opts.heartbeatError) throw opts.heartbeatError;
        return { recordedAt: new Date(now).toISOString() };
      },
    } as unknown as GuildApiClient;
  };
  const deps: RunDeps = {
    env: { GUILD_AGENT_PRIVATE_KEY: KEY, [KEY_FILE_ENV]: join(dir, 'agent.key'), ...opts.env },
    log: l => out.push(l),
    error: l => err.push(l),
    readState: opts.readState ?? (() => state()),
    createApi,
    runWorkerCycle: async options => {
      cycles.push(options);
      const step = opts.reports?.[Math.min(cycles.length - 1, (opts.reports?.length ?? 1) - 1)];
      const signThen = step && 'sign' in step ? step : null;
      const out = signThen ? signThen.then : (step as WorkerCycleReport | Error | undefined);
      const signs = signThen
        ? signThen.sign
        : out instanceof Error || !out
          ? []
          : out.intentHashes.filter(i => i.kind === 'claim').map(i => i.taskId);
      // The real worker reports each claim's outcome, and persists its intent,
      // the moment claimTaskOnChain returns.
      for (const taskId of signs) {
        options.onClaimOutcome?.(taskId, 'submitted');
        options.persistIntentHash?.({ taskId, kind: 'claim', intentHash: `txid_${taskId}` });
      }
      for (const [taskId, outcome] of opts.outcomes?.[cycles.length - 1] ?? []) options.onClaimOutcome?.(taskId, outcome);
      if (out instanceof Error) throw out;
      return out ?? report();
    },
    sweepToOwner: async o => {
      sweeps.push(o);
      return { refused: true, refusal: 'within-float', dryRun: false };
    },
    createDoWork: () => async () => 'work',
    recordClaim: opts.recordClaim ?? recordClaim,
    persistIntentHash: rec => void persisted.push(rec),
    now: () => now,
    sleep: async () => {
      now += opts.step ?? 60_000;
    },
    onSignal: handler => {
      signal = handler;
      return () => {
        signal = null;
      };
    },
    maxTicks: opts.rules.length,
  };
  return { deps, cycles, beats, configs, sweeps, persisted, out, err, fire: () => signal?.(), lockPath: join(dir, 'run.lock') };
}

describe('start', () => {
  test('refuses an agent that is not activated (no pinned owner) — no lock, no API', async () => {
    const w = world({ rules: [me()], readState: () => state({ ownerAccount: null, pendingOwnerAccount: OWNER, status: 'pending' }) });
    expect(await runAgent(w.deps)).toBe(1);
    expect(w.configs).toHaveLength(0);
    expect(existsSync(w.lockPath)).toBe(false);
    expect(w.err.join('\n')).toContain('not been activated');
  });

  test('refuses while another run holds the lock', async () => {
    const w = world({ rules: [me()] });
    writeFileSync(w.lockPath, `${process.pid}\n`); // this very process: alive
    expect(await runAgent(w.deps)).toBe(1);
    expect(w.cycles).toHaveLength(0);
    expect(w.err.join('\n')).toContain(`pid ${process.pid}`);
  });

  test('takes the lock while running and releases it on exit; the key never reaches the output', async () => {
    const w = world({ rules: [me()] });
    let heldDuring = false;
    const cycle = w.deps.runWorkerCycle;
    w.deps.runWorkerCycle = async o => {
      heldDuring = existsSync(w.lockPath);
      return cycle(o);
    };
    expect(await runAgent(w.deps)).toBe(0);
    expect(heldDuring).toBe(true);
    expect(existsSync(w.lockPath)).toBe(false);
    expect([...w.out, ...w.err].join('\n')).not.toContain(KEY);
  });
});

describe('the rules become the cycle, fresh every tick', () => {
  test('dry run: nothing on chain, no collection, no sweep — the claim gate and allowlist from the rules', async () => {
    const w = world({ rules: [me({}, { dryRun: true, maxBondXrd: '150', trustedPosters: [STRANGER] })] });
    await runAgent(w.deps);
    const o = w.cycles[0];
    expect(o.dryRun).toBe(true);
    expect(o.onChain).toBe(false);
    expect(o.autoWithdraw).toBe(false);
    expect(o.sweepTo).toBeUndefined();
    expect(o.doWork).toBeUndefined();
    expect(o.trustedPosters).toEqual([STRANGER]);
    expect(o.claimGate).toEqual({ maxBondXrd: '150', feeReserveXrd: '20' });
    expect(o.maxClaimsPerCycle).toBe(1);
    expect(w.beats[0].mode).toBe('dry-run');
  });

  test('live: claims, collects and sweeps — and the sweep pays the PINNED owner, never GUILD_OWNER_ACCOUNT', async () => {
    const w = world({
      rules: [me({}, { dryRun: false })],
      env: { GUILD_DOWORK_CMD: 'node my-agent.js', GUILD_OWNER_ACCOUNT: STRANGER, GUILD_FLOAT_XRD: '1' },
    });
    await runAgent(w.deps);
    const o = w.cycles[0];
    expect(o.dryRun).toBe(false);
    expect(o.onChain).toBe(true);
    expect(o.autoWithdraw).toBe(true);
    expect(o.sweepTo).toBe('owner');
    expect(typeof o.doWork).toBe('function');
    await o.sweepToOwner!({ live: true, identity: null, requested: 'owner' });
    expect(w.sweeps[0].link).toEqual({ ownerAccount: OWNER, floatXrd: '200' });
    expect(w.beats[0].mode).toBe('live');
  });

  test('switched live without GUILD_DOWORK_CMD → it runs dry and says why on the card', async () => {
    const w = world({ rules: [me({}, { dryRun: false })] });
    await runAgent(w.deps);
    expect(w.cycles[0].dryRun).toBe(true);
    expect(w.cycles[0].onChain).toBe(false);
    expect(JSON.stringify(w.beats[0].warnings)).toContain('GUILD_DOWORK_CMD is unset');
  });

  test('a rule change applies on the very next tick (nothing cached)', async () => {
    const w = world({
      rules: [me({}, { dryRun: true, trustedPosters: [OWNER] }), me({}, { dryRun: false, trustedPosters: [STRANGER], maxBondXrd: '90' })],
      env: { GUILD_DOWORK_CMD: 'x' },
    });
    await runAgent(w.deps);
    expect(w.cycles.map(c => c.dryRun)).toEqual([true, false]);
    expect(w.cycles[1].trustedPosters).toEqual([STRANGER]);
    expect(w.cycles[1].claimGate?.maxBondXrd).toBe('90');
  });
});

describe('stops — within one tick, before any cycle', () => {
  test('403 on the rules read (suspended or retired) → STOP, exit 1, lock released', async () => {
    const w = world({ rules: [me(), new GuildApiError('ACCOUNT_SUSPENDED', 'suspended', 403), me()] });
    expect(await runAgent(w.deps)).toBe(1);
    expect(w.cycles).toHaveLength(1); // tick 1 only
    expect(w.err.join('\n')).toContain('suspended or retired');
    expect(existsSync(w.lockPath)).toBe(false);
  });

  test('403 at sign-in → the same stop, no cycle at all', async () => {
    const w = world({ rules: [me()], authError: new GuildApiError('ACCOUNT_SUSPENDED', 'suspended', 403) });
    expect(await runAgent(w.deps)).toBe(1);
    expect(w.cycles).toHaveLength(0);
  });

  test('AGENT_NOT_PAIRED → STOP, exit 1', async () => {
    const w = world({ rules: [new GuildApiError('AGENT_NOT_PAIRED', 'no row', 404)] });
    expect(await runAgent(w.deps)).toBe(1);
    expect(w.cycles).toHaveLength(0);
  });

  test('owner-mismatch → STOP, exit 1, the new owner is never followed', async () => {
    const w = world({ rules: [me({ ownerAccount: STRANGER })] });
    expect(await runAgent(w.deps)).toBe(1);
    expect(w.cycles).toHaveLength(0);
    expect(w.err.join('\n')).toContain('owner-mismatch');
  });

  test('a transient failure (500, network) skips that tick\'s cycle and carries on', async () => {
    const w = world({ rules: [new GuildApiError('INTERNAL', 'boom', 500), new TypeError('fetch failed'), me()] });
    expect(await runAgent(w.deps)).toBe(0);
    expect(w.cycles).toHaveLength(1); // only tick 3
    expect(w.beats).toHaveLength(1);
  });

  test('a pairing that reads anything but active runs no cycle', async () => {
    const w = world({ rules: [me({ status: 'pending' })] });
    await runAgent(w.deps);
    expect(w.cycles).toHaveLength(0);
  });

  test('the stop file → a clean exit 0; the file is cleared', async () => {
    const w = world({ rules: [me(), me()] });
    const cycle = w.deps.runWorkerCycle;
    w.deps.runWorkerCycle = async o => {
      writeFileSync(join(dir, 'stop'), 'now\n');
      return cycle(o);
    };
    expect(await runAgent(w.deps)).toBe(0);
    expect(w.cycles).toHaveLength(1);
    expect(existsSync(join(dir, 'stop'))).toBe(false);
  });

  test('SIGINT/SIGTERM → the tick in flight finishes, then exit 0 and the lock is released', async () => {
    const w = world({ rules: [me(), me(), me()] });
    const cycle = w.deps.runWorkerCycle;
    w.deps.runWorkerCycle = async o => {
      w.fire();
      return cycle(o);
    };
    expect(await runAgent(w.deps)).toBe(0);
    expect(w.cycles).toHaveLength(1);
    expect(w.beats).toHaveLength(1); // the tick in flight still reported
    expect(existsSync(w.lockPath)).toBe(false);
  });
});

describe('the day quota — a rolling 24 h window, at most one claim a tick', () => {
  const claimed = (taskId: number) => report({ intentHashes: [{ taskId, kind: 'claim', intentHash: `txid_${taskId}` }] });

  test('a claim at 23:59 still counts at 00:01 (a calendar day would reset it)', async () => {
    // tick 1 at 23:59 claims; tick 2 two minutes later, past midnight.
    const w = world({ rules: [me(), me()], reports: [claimed(99), report()], step: 2 * 60_000 });
    await runAgent(w.deps);
    expect(w.cycles.map(c => c.maxClaimsPerCycle)).toEqual([1, 0]);
    expect(w.beats[1].quota).toEqual({ used: 1, maxPerDay: 1 });
  });

  test('24 h after the claim the budget is back', async () => {
    const w = world({ rules: [me(), me()], reports: [claimed(99), report()], step: 24 * 60 * 60_000 + 1 });
    await runAgent(w.deps);
    expect(w.cycles.map(c => c.maxClaimsPerCycle)).toEqual([1, 1]);
  });

  test('a high daily cap still allows only ONE claim a tick', async () => {
    const w = world({ rules: [me({}, { maxClaimsPerDay: 100 })] });
    await runAgent(w.deps);
    expect(w.cycles[0].maxClaimsPerCycle).toBe(1);
  });

  test('a signed claim that did not commit still counts (over-counting only ever claims less)', async () => {
    const w = world({ rules: [me(), me()], reports: [claimed(7), report()] });
    await runAgent(w.deps);
    expect(w.cycles[1].maxClaimsPerCycle).toBe(0);
  });

  test('an unreadable claim log → no claims, and the card says why', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'claims.json'), '{not json');
    const w = world({ rules: [me({}, { maxClaimsPerDay: 5 })] });
    await runAgent(w.deps);
    expect(w.cycles[0].maxClaimsPerCycle).toBe(0);
    expect(JSON.stringify(w.beats[0].warnings)).toContain('no claims this tick');
  });

  test('a claim that cannot be recorded stops claiming for the rest of the run, though the log still reads', async () => {
    // The log reads fine (empty) every tick; only the WRITE fails. Without the
    // stop, tick 2 would see an empty window and claim again.
    const w = world({
      rules: [me({}, { maxClaimsPerDay: 5 }), me({}, { maxClaimsPerDay: 5 })],
      reports: [claimed(1), report()],
      recordClaim: () => {
        throw new Error('EACCES: cannot write claims.json');
      },
    });
    await runAgent(w.deps);
    expect(w.cycles.map(c => c.maxClaimsPerCycle)).toEqual([1, 0]);
    expect(JSON.stringify(w.beats[1].warnings)).toContain('no claims until restarted');
    expect(w.err.join('\n')).toContain('no more claims until restarted');
  });
});

describe('heartbeat', () => {
  test('a failing heartbeat (5xx, timeout, 404) never stops the loop', async () => {
    for (const heartbeatError of [new GuildApiError('INTERNAL', 'x', 500), new TypeError('fetch failed'), new GuildApiError('AGENT_NOT_PAIRED', 'x', 404)]) {
      const w = world({ rules: [me(), me()], heartbeatError });
      expect(await runAgent(w.deps)).toBe(0);
      expect(w.cycles).toHaveLength(2);
    }
  });

  test('a SUSPENSION heard on the heartbeat stops the loop (withAuth answers every route alike)', async () => {
    const w = world({ rules: [me(), me()], heartbeatError: new GuildApiError('ACCOUNT_SUSPENDED', 'x', 403) });
    expect(await runAgent(w.deps)).toBe(1);
    expect(w.cycles).toHaveLength(1);
  });

  test('a cycle that throws is still reported, and the loop carries on', async () => {
    const w = world({ rules: [me(), me()], reports: [new Error('listTasks 502'), report()] });
    expect(await runAgent(w.deps)).toBe(0);
    expect(w.beats[0].cycle).toBe('skipped');
    expect(JSON.stringify(w.beats[0].warnings)).toContain('listTasks 502');
    expect(w.cycles).toHaveLength(2);
  });

  test('the payload stays under the server cap, however much a cycle reports', () => {
    const huge = report({
      claimedTaskIds: Array.from({ length: 500 }, (_, i) => i),
      errors: Array.from({ length: 500 }, () => 'e'.repeat(5000)),
      ruleSkips: Array.from({ length: 500 }, (_, i) => ({ taskId: i, reason: 'r'.repeat(5000) })),
    });
    const payload = heartbeatPayload({
      at: new Date(T0).toISOString(),
      tick: 1,
      mode: 'live',
      report: huge,
      quota: { used: 1, maxPerDay: 1 },
      warnings: Array.from({ length: 50 }, () => 'w'.repeat(5000)),
    });
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(HEARTBEAT_MAX_CHARS);
    expect((payload.claimed as number[]).length).toBe(20);
    expect(payload.errorCount).toBe(500);
  });
});

describe('the badge', () => {
  test('claims carry the badge the Guild recorded for this agent', async () => {
    const w = world({ rules: [me()] });
    await runAgent(w.deps);
    const base = loadConfig();
    expect(w.configs[0].agentBadgeResource).toBe(base.workerBadgeResource);
    expect(w.configs[0].agentBadgeLocalId).toBe('guild_member_myagent');
  });

  test('a badge not yet indexed at join is picked up from the Guild on a later tick — never from the fleet env', async () => {
    const saved = { r: process.env.GUILD_AGENT_BADGE_RESOURCE, l: process.env.GUILD_AGENT_BADGE_LOCAL_ID };
    process.env.GUILD_AGENT_BADGE_RESOURCE = 'resource_rdx1fleetbadge';
    process.env.GUILD_AGENT_BADGE_LOCAL_ID = 'guild_member_fleetworker';
    try {
      const w = world({ rules: [me({ badgeId: '<guild_member_myagent>' })], readState: () => state({ badgeId: null }) });
      await runAgent(w.deps);
      expect(w.configs).toHaveLength(2);
      expect(w.configs[0].agentBadgeResource).toBe('');
      expect(w.configs[0].agentBadgeLocalId).toBe('');
      expect(w.configs[1].agentBadgeLocalId).toBe('guild_member_myagent');
      expect(w.cycles[0].api.config.agentBadgeLocalId).toBe('guild_member_myagent');
    } finally {
      for (const [k, v] of [['GUILD_AGENT_BADGE_RESOURCE', saved.r], ['GUILD_AGENT_BADGE_LOCAL_ID', saved.l]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// ── K2-D review round 1 ───────────────────────────────────────────────────────
describe('review round 1', () => {
  test('HIGH: a claim signed early in a cycle still counts when a LATER step of that cycle throws', async () => {
    const w = world({
      rules: [me({}, { maxClaimsPerDay: 5 }), me({}, { maxClaimsPerDay: 1 })],
      reports: [{ sign: [42], then: new TypeError('gateway reset in step 2') }, report()],
    });
    await runAgent(w.deps);
    // Tick 2's cap is 1 and the tick-1 claim was recorded at signing: no budget left.
    expect(w.cycles.map(c => c.maxClaimsPerCycle)).toEqual([1, 0]);
    expect(w.beats[1].quota).toEqual({ used: 1, maxPerDay: 1 });
  });

  test('every intent still reaches the worker breadcrumb file, claims and the rest', async () => {
    const w = world({ rules: [me()], reports: [{ sign: [7], then: report() }] });
    await runAgent(w.deps);
    expect(w.persisted).toEqual([{ taskId: 7, kind: 'claim', intentHash: 'txid_7' }]);
  });

  test('HIGH: sleepUnlessAborted returns at once for a signal that already fired (a SIGINT mid-cycle)', async () => {
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    await sleepUnlessAborted(60_000, ac.signal);
    expect(Date.now() - started).toBeLessThan(100);
  });

  test('sleepUnlessAborted ends early on an abort during the wait, and waits it out otherwise', async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 20);
    await sleepUnlessAborted(60_000, ac.signal);
    expect(Date.now() - started).toBeLessThan(1_000);
    const quiet = Date.now();
    await sleepUnlessAborted(30, new AbortController().signal);
    expect(Date.now() - quiet).toBeGreaterThanOrEqual(25);
  });

  test('MEDIUM: the heartbeat carries error COUNTS and task ids — never the error text (a poster\'s words via doWork stderr)', () => {
    const payload = heartbeatPayload({
      at: new Date(T0).toISOString(),
      tick: 1,
      mode: 'live',
      report: report({
        errors: [
          'task #12 failed: GUILD_DOWORK_CMD ("x") exited 1: SEND YOUR XRD TO account_rdx1scam NOW',
          'guild-worker: claim #15 failed: boom',
          'guild-worker: claim #15 failed: again',
        ],
      }),
      quota: { used: 0, maxPerDay: 1 },
      warnings: [],
    });
    expect(payload.errorCount).toBe(3);
    expect(payload.errorTasks).toEqual([12, 15]);
    expect(JSON.stringify(payload)).not.toContain('SEND YOUR XRD');
    expect(payload.errors).toBeUndefined();
  });

  test('MEDIUM: the client rebuilt when the badge appears signs in inside the guarded read — a 403 there STOPS the loop', async () => {
    const w = world({
      rules: [me({ badgeId: '<guild_member_myagent>' })],
      readState: () => state({ badgeId: null }),
      authErrorForClient: { index: 1, error: new GuildApiError('ACCOUNT_SUSPENDED', 'suspended', 403) },
    });
    expect(await runAgent(w.deps)).toBe(1);
    expect(w.cycles).toHaveLength(0);
  });

  test('MEDIUM: a suspension that surfaces from inside the cycle STOPS the loop, not a warning', async () => {
    const w = world({
      rules: [me(), me()],
      reports: [new GuildApiError('ACCOUNT_SUSPENDED', 'suspended', 403), report()],
    });
    expect(await runAgent(w.deps)).toBe(1);
    expect(w.cycles).toHaveLength(1);
    expect(w.err.join('\n')).toContain('mid-cycle');
  });
});

// ── K2-D review round 2 ───────────────────────────────────────────────────────
describe('review round 2', () => {
  test('HIGH: an AMBIGUOUS claim (it threw after it may have been submitted) counts against the day', async () => {
    const w = world({
      rules: [me({}, { maxClaimsPerDay: 1 }), me({}, { maxClaimsPerDay: 1 })],
      reports: [report(), report()],
      outcomes: [[[42, 'unknown']], []],
    });
    await runAgent(w.deps);
    expect(w.cycles.map(c => c.maxClaimsPerCycle)).toEqual([1, 0]);
  });

  test('a claim refused BEFORE signing (no bond can post) does not spend the day', async () => {
    const w = world({
      rules: [me({}, { maxClaimsPerDay: 1 }), me({}, { maxClaimsPerDay: 1 })],
      reports: [report(), report()],
      outcomes: [[[42, 'not-submitted']], []],
    });
    await runAgent(w.deps);
    expect(w.cycles.map(c => c.maxClaimsPerCycle)).toEqual([1, 1]);
  });

  test('HIGH: the sweep keeps the float the Guild reports THIS tick — to the pinned owner only', async () => {
    const w = world({
      rules: [me({ floatXrd: '200' }, { dryRun: false }), me({ floatXrd: '350' }, { dryRun: false })],
      env: { GUILD_DOWORK_CMD: 'x' },
    });
    await runAgent(w.deps);
    await w.cycles[0].sweepToOwner!({ live: true, identity: null, requested: 'owner' });
    await w.cycles[1].sweepToOwner!({ live: true, identity: null, requested: 'owner' });
    expect(w.sweeps.map(s => s.link)).toEqual([
      { ownerAccount: OWNER, floatXrd: '200' },
      { ownerAccount: OWNER, floatXrd: '350' },
    ]);
  });

  test('MEDIUM: a wait that ends on its timer removes its abort listener (one signal lives all run)', async () => {
    let added = 0;
    let removed = 0;
    const signal = {
      aborted: false,
      addEventListener: () => void added++,
      removeEventListener: () => void removed++,
    } as unknown as AbortSignal;
    for (let i = 0; i < 3; i++) await sleepUnlessAborted(5, signal);
    expect(added).toBe(3);
    expect(removed).toBe(3);
  });
});
