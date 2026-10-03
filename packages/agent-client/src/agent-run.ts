// agent-run.ts — `guild-agent run`: a personal agent's earning loop
// (docs/design/bring-your-agent.md §2.3).
//
// Every tick (60 s) it asks the Guild for this agent's rules — never caching
// them — and runs ONE worker cycle under them:
//
//   stop file            → exit cleanly (guild-agent stop)
//   403 from the Guild   → STOP: suspended or retired by the owner (withAuth
//                          refuses the account before any route runs)
//   AGENT_NOT_PAIRED     → STOP: the Guild has no record of this agent
//   owner ≠ pinned owner → STOP: owner-mismatch — never followed
//   any other failure    → skip this tick's cycle entirely (never sign on
//                          stale rules), try again next tick
//
// The cycle is worker.ts's runWorkerCycle, unmodified in contract: the rules
// become its options (trustedPosters, dry run, the claim gate — XRD bond ≤
// maxBondXrd, balance ≥ bond + FEE_RESERVE_XRD) and the day quota becomes its
// per-cycle claim budget (claim-quota.ts: at most one claim a tick, a rolling
// 24 h window). Collections are withdrawn and everything above the float is
// swept to the owner pinned in agent.json — the same mapping as
// `guild-agent sweep`. A heartbeat after each cycle feeds the owner's card;
// a heartbeat that fails never stops the loop and is never read as a stop.
//
// One loop per agent (run-lock.ts); SIGINT/SIGTERM finish the tick in flight,
// release the lock and exit 0.
//
// These are CLIENT rules: until the server re-checks them (A3), they bind a
// kit that has not been modified, and the float is the backstop.

import { GuildApiClient, GuildApiError, PAIRING_ERROR_CODES, HEARTBEAT_MAX_CHARS, type AgentMe } from './api.js';
import { readState as realReadState, resolveStatePath, resolveStopFilePath, stopRequested, clearStop } from './agent-state.js';
import { FEE_RESERVE_XRD } from './agent-rules.js';
import {
  claimsAllowedThisTick,
  readClaimsInWindow,
  recordClaim,
  resolveClaimsLogPath,
} from './claim-quota.js';
import { bareLocalId, loadAgentPrivateKeyHex, loadConfig, type GuildClientConfig } from './config.js';
import { AgentIdentity } from './identity.js';
import { acquireRunLock, describeRunLock, releaseRunLock, resolveRunLockPath } from './run-lock.js';
import { registerSecret, scrub, untrusted } from './secrets.js';
import { ownerLinkFromState, sweepToOwner } from './sweep.js';
import { defaultPersistIntentHash, runWorkerCycle, type DoWork, type IntentRecord, type WorkerCycleReport } from './worker.js';
import { createCommandDoWork } from './worker-cli.js';

/** The tick. Fixed: the owner's card reads three missed beats (3 min) as offline. */
export const RUN_TICK_MS = 60_000;

export type RunStop =
  | 'stop-requested'
  | 'signal'
  | 'suspended'
  | 'not-paired'
  | 'owner-mismatch'
  | 'max-ticks';

export interface RunDeps {
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  error: (line: string) => void;
  readState: typeof realReadState;
  createApi: (config: GuildClientConfig) => GuildApiClient;
  runWorkerCycle: typeof runWorkerCycle;
  sweepToOwner: typeof sweepToOwner;
  createDoWork: (cmd: string) => DoWork;
  /** claim-quota.ts's recorder; injectable so a failed WRITE can be tested apart from a failed read. */
  recordClaim: typeof recordClaim;
  /** The worker's intent breadcrumb file (worker.ts); the loop adds the day-quota record on top. */
  persistIntentHash: (rec: IntentRecord) => void;
  now: () => number;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Install the SIGINT/SIGTERM handler; returns its uninstaller. */
  onSignal: (handler: () => void) => () => void;
  /** Tests only: stop after this many ticks. */
  maxTicks?: number;
}

export function realRunDeps(env: Record<string, string | undefined> = process.env): RunDeps {
  return {
    env,
    log: line => console.log(line),
    error: line => console.error(line),
    readState: realReadState,
    createApi: config => new GuildApiClient(config),
    runWorkerCycle,
    sweepToOwner,
    createDoWork: createCommandDoWork,
    recordClaim,
    persistIntentHash: defaultPersistIntentHash,
    now: () => Date.now(),
    sleep: sleepUnlessAborted,
    onSignal: handler => {
      process.on('SIGINT', handler);
      process.on('SIGTERM', handler);
      return () => {
        process.off('SIGINT', handler);
        process.off('SIGTERM', handler);
      };
    },
  };
}

/**
 * Wait `ms`, or less if `signal` aborts. A signal that ALREADY aborted (a
 * SIGINT during the cycle) resolves at once: an 'abort' listener added after
 * the event never fires, and the loop would otherwise sit out a whole tick.
 */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    // One listener per wait, removed whichever way the wait ends: the loop
    // reuses ONE signal for its whole life, so a leftover would pile up a
    // listener a minute.
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The claim-bearing config: the badge the Guild recorded for THIS agent, or
 * none — never the fleet's GUILD_AGENT_BADGE_* env, which names some other
 * account's badge (a claim presenting it would fail and burn a fee).
 */
function configWithBadge(badgeId: string | null): GuildClientConfig {
  const base = loadConfig();
  return badgeId
    ? loadConfig({ agentBadgeResource: base.workerBadgeResource, agentBadgeLocalId: bareLocalId(badgeId) })
    : loadConfig({ agentBadgeResource: '', agentBadgeLocalId: '' });
}

/** At most HEARTBEAT_MAX_CHARS: lists capped, strings clipped and scrubbed. */
export function heartbeatPayload(input: {
  at: string;
  tick: number;
  mode: 'dry-run' | 'live';
  report: WorkerCycleReport | null;
  quota: { used: number | null; maxPerDay: number };
  warnings: string[];
}): Record<string, unknown> {
  const clip = (s: string, n = 200) => untrusted(scrub(s), n);
  const ids = (xs: number[] | undefined) => (xs ?? []).slice(0, 20);
  const r = input.report;
  const payload: Record<string, unknown> = {
    v: 1,
    at: input.at,
    tick: input.tick,
    mode: input.mode,
    quota: input.quota,
    ...(r
      ? {
          claimed: ids(r.claimedTaskIds),
          wouldClaim: ids(r.wouldClaimTaskIds),
          submitted: ids(r.submittedTaskIds),
          withdrawn: ids(r.withdrawnTaskIds),
          awaitingReview: ids(r.awaitingReviewTaskIds),
          disputed: ids(r.disputedTaskIds),
          ruleSkips: (r.ruleSkips ?? []).slice(0, 10).map(s => ({ taskId: s.taskId, reason: clip(s.reason, 160) })),
          ...(r.balanceXrd !== undefined ? { balanceXrd: r.balanceXrd } : {}),
          ...(r.sweep ? { swept: r.sweep.amount } : {}),
          // Counts and task ids only, never the error TEXT: a failed doWork
          // folds its stderr — which can echo a poster's brief — into the
          // message, and the owner's card must not carry a poster's words.
          errorCount: r.errors.length,
          errorTasks: [...new Set(r.errors.flatMap(e => [...e.matchAll(/#(\d+)/g)].map(m => Number(m[1]))))].slice(0, 20),
        }
      : { cycle: 'skipped' }),
    warnings: input.warnings.slice(0, 5).map(w => clip(w, 300)),
  };
  // The caps above keep this far under the limit; this is the backstop.
  if (JSON.stringify(payload).length > HEARTBEAT_MAX_CHARS) {
    delete payload.ruleSkips;
    payload.errorTasks = [];
    payload.warnings = [];
  }
  return payload;
}

export async function runAgent(deps: RunDeps): Promise<number> {
  const { env, log, error } = deps;

  // ── start: an activated agent with a pinned owner, and the lock ──────────
  let keyHex: string;
  try {
    keyHex = loadAgentPrivateKeyHex(env);
  } catch (e) {
    error(`guild-agent run: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  registerSecret(keyHex);
  const identity = await AgentIdentity.fromPrivateKeyHex(keyHex);
  let state;
  try {
    state = deps.readState(resolveStatePath(env));
  } catch (e) {
    error(`guild-agent run: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const owner = ownerLinkFromState(state, identity.address);
  if (!owner.ok || !state) {
    error(`guild-agent run: this agent cannot run yet — ${owner.ok ? 'no local record' : owner.why}`);
    return 1;
  }
  const pinnedOwner = owner.link.ownerAccount!;

  const cmd = env.GUILD_DOWORK_CMD;
  const doWork = cmd ? deps.createDoWork(cmd) : null;

  const lockPath = resolveRunLockPath(env);
  const lock = acquireRunLock(lockPath);
  if (!lock.ok) {
    error(`guild-agent run: ${describeRunLock(lockPath, lock.lock)}`);
    return 1;
  }

  const stopPath = resolveStopFilePath(env);
  const claimsPath = resolveClaimsLogPath(env);
  const abort = new AbortController();
  let signalled = false;
  const uninstall = deps.onSignal(() => {
    signalled = true;
    abort.abort();
    log('guild-agent run: stopping after this tick…');
  });

  let badgeId = state.badgeId;
  let api = deps.createApi(configWithBadge(badgeId));
  let claimsBroken: string | null = null;
  let stop: RunStop | null = null;
  let tick = 0;

  try {
    log(`guild-agent run: ${identity.address} → owner …${pinnedOwner.slice(-8)}, a cycle every ${RUN_TICK_MS / 1000}s`);

    while (!stop) {
      if (signalled) {
        stop = 'signal';
        break;
      }
      if (stopRequested(stopPath)) {
        clearStop(stopPath);
        stop = 'stop-requested';
        break;
      }
      if (deps.maxTicks !== undefined && tick >= deps.maxTicks) {
        stop = 'max-ticks';
        break;
      }
      tick++;
      const at = new Date(deps.now()).toISOString();

      // ── the rules, fresh every tick ───────────────────────────────────────
      // Signing in lives inside the tick: the client only self-heals a 401
      // after one sign-in has succeeded, and a suspended account is refused
      // (403) right here at sign-in.
      let me: AgentMe;
      try {
        if (!api.isAuthenticated) await api.authenticate(identity);
        me = await api.agentMe();
        if (!badgeId && me.badgeId) {
          // The badge was not indexed when join recorded the state; now it is.
          // The new client signs in HERE, where a 403 is read as the stop it is.
          badgeId = me.badgeId;
          api = deps.createApi(configWithBadge(badgeId));
          await api.authenticate(identity);
        }
      } catch (e) {
        if (e instanceof GuildApiError && e.status === 403) {
          error('guild-agent run: STOPPED — the Guild refuses this agent (suspended or retired by its owner). `guild-agent sweep` still returns its money.');
          stop = 'suspended';
          break;
        }
        if (e instanceof GuildApiError && e.code === PAIRING_ERROR_CODES.notPaired) {
          error('guild-agent run: STOPPED — the Guild has no record of this agent. Contact the Guild with its address; do not pair it with a new code.');
          stop = 'not-paired';
          break;
        }
        error(`guild-agent run: could not read the rules this tick (${untrusted(e instanceof Error ? e.message : String(e))}) — no cycle; retrying next tick`);
        await deps.sleep(RUN_TICK_MS, abort.signal);
        continue;
      }
      if (me.ownerAccount !== pinnedOwner) {
        error(
          `guild-agent run: STOPPED — owner-mismatch: the Guild reports owner ${me.ownerAccount}, this agent pinned ${pinnedOwner}. ` +
            'The pinned owner is never replaced.'
        );
        stop = 'owner-mismatch';
        break;
      }
      if (me.status !== 'active') {
        error(`guild-agent run: the pairing is ${me.status}, not active — no cycle this tick`);
        await deps.sleep(RUN_TICK_MS, abort.signal);
        continue;
      }
      // ── the cycle, under those rules ──────────────────────────────────────
      const warnings: string[] = [];
      const live = !me.rules.dryRun && doWork !== null;
      if (!me.rules.dryRun && doWork === null) {
        warnings.push('the owner switched this agent live, but GUILD_DOWORK_CMD is unset — running dry until it is set');
      }
      const quota = readClaimsInWindow(claimsPath, deps.now());
      if (!quota.ok) warnings.push(`no claims this tick: ${quota.why}`);
      if (claimsBroken) warnings.push(`no claims until restarted: ${claimsBroken}`);
      const maxClaimsPerCycle = claimsBroken ? 0 : claimsAllowedThisTick(me.rules.maxClaimsPerDay, quota);

      let report: WorkerCycleReport | null = null;
      try {
        report = await deps.runWorkerCycle({
          api,
          identity,
          dryRun: !live,
          onChain: live,
          ...(live && doWork !== null ? { doWork } : {}),
          trustedPosters: me.rules.trustedPosters,
          maxClaimsPerCycle,
          autoWithdraw: live,
          ...(live ? { sweepTo: 'owner' } : {}),
          // The owner PINNED in agent.json (never GUILD_OWNER_ACCOUNT, never the
          // Guild's), with the float as the Guild reports it THIS tick — an
          // owner who raises or lowers the float is followed on the next sweep.
          sweepToOwner: opts => deps.sweepToOwner({ ...opts, link: { ownerAccount: pinnedOwner, floatXrd: me.floatXrd } }),
          claimGate: { maxBondXrd: me.rules.maxBondXrd, feeReserveXrd: String(FEE_RESERVE_XRD) },
          persistIntentHash: deps.persistIntentHash,
          // A claim counts against the day the moment its fate is known —
          // submitted (committed or not) or ambiguous (it threw after it may
          // have been submitted), even if a later step of this cycle throws and
          // the report is lost. Only a refusal before signing is free.
          // Over-counting only ever means claiming less.
          onClaimOutcome: (taskId, outcome) => {
            if (outcome === 'not-submitted') return;
            try {
              deps.recordClaim(claimsPath, taskId, new Date(deps.now()));
            } catch (e) {
              claimsBroken = e instanceof Error ? e.message : String(e);
              error(`guild-agent run: ${claimsBroken} — no more claims until restarted`);
            }
          },
          log: { info: log, warn: error, error },
        });
      } catch (e) {
        if (e instanceof GuildApiError && e.code === 'ACCOUNT_SUSPENDED') {
          error('guild-agent run: STOPPED — the Guild refused this agent mid-cycle (suspended or retired by its owner).');
          stop = 'suspended';
          break;
        }
        warnings.push(`the cycle failed: ${e instanceof Error ? e.message : String(e)}`);
        error(`guild-agent run: cycle ${tick} failed — ${untrusted(e instanceof Error ? e.message : String(e))}`);
      }

      const after = readClaimsInWindow(claimsPath, deps.now());
      try {
        await api.heartbeat(
          heartbeatPayload({
            at,
            tick,
            mode: live ? 'live' : 'dry-run',
            report,
            quota: { used: after.ok ? after.entries.length : null, maxPerDay: me.rules.maxClaimsPerDay },
            warnings,
          })
        );
      } catch (e) {
        // A suspension is a suspension whichever call hears it first (withAuth
        // answers every route the same way). Anything else about a heartbeat —
        // a 5xx, a timeout, a 404 — never stops the loop.
        if (e instanceof GuildApiError && e.code === 'ACCOUNT_SUSPENDED') {
          error('guild-agent run: STOPPED — the Guild refused this agent\'s heartbeat (suspended or retired by its owner).');
          stop = 'suspended';
          break;
        }
        error(`guild-agent run: heartbeat failed (${untrusted(e instanceof Error ? e.message : String(e))}) — the loop carries on`);
      }

      await deps.sleep(RUN_TICK_MS, abort.signal);
    }
  } finally {
    uninstall();
    releaseRunLock(lockPath);
  }

  log(`guild-agent run: stopped (${stop}) after ${tick} tick(s)`);
  return stop === 'suspended' || stop === 'not-paired' || stop === 'owner-mismatch' ? 1 : 0;
}
