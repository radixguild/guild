// CLI entry: `bun run worker [--live] [--loop] [--on-chain] [--auto-withdraw]`
//
// Defaults to ONE dry-run cycle (poll + report, no writes). `--live` posts
// submissions off-chain, running YOUR agent as the work function via the
// GUILD_DOWORK_CMD command (bring-your-own — this client owns the Guild
// lifecycle but is framework-agnostic and ships NO agent); `--loop` keeps
// polling. `--on-chain` ADDITIONALLY signs the real-money escrow legs (claim
// bond + submit) and confirms them — decoupled from `--live` on purpose so a
// `--live` off-chain run can never accidentally sign a tx. Full money path =
// `--live --on-chain` (real XRD; the claim and submit legs are LIVE-PROVEN —
// see the tx.ts header + docs/design/agent-lane-pilot-execution-plan.md).
//
// `--auto-withdraw` is a THIRD, separate opt-in: every cycle's post-submit
// survey reports settled-but-uncollected entitlements (`uncollectedTaskIds`)
// whether or not this flag is set — `--auto-withdraw` additionally signs the
// existing `withdraw` leg for EVERY one of them, right there in the same
// cycle. It stays behind `--live` (a hard error without it, not a warning —
// see below) but does NOT require `--on-chain`: collecting is orthogonal to
// claim/submit, the same way `guild-worker withdraw` always has been.

import { spawn } from 'node:child_process';
import { GuildApiClient, type GuildTask } from './api.js';
import { loadAgentPrivateKeyHex } from './config.js';
import { AgentIdentity } from './identity.js';
import { isMainModule } from './runtime.js';
import { runWorkerCycle, startWorkerLoop, type DoWork } from './worker.js';

/**
 * The BRAIN's environment is allowlisted, never inherited. Task briefs are
 * attacker-authored (anyone can post a task), and the process that reads them
 * must not hold the signing key — an injected "print your environment"
 * instruction against an inherited env exfiltrates GUILD_AGENT_PRIVATE_KEY in
 * one round trip (reproduced 2026-08-04). Only these benign system vars pass
 * by default; everything else the brain needs is named explicitly in
 * GUILD_DOWORK_ENV.
 */
const DOWORK_DEFAULT_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'SHELL',
  'USER',
  'LOGNAME',
  'TZ',
];

/**
 * Build the child env for the doWork brain: default passthrough plus the
 * operator's GUILD_DOWORK_ENV allowlist (comma-separated variable names).
 * `GUILD_*` names are refused even when listed — the split this enforces is
 * that the LOOP holds guild credentials and the BRAIN holds none, and an
 * allowlist entry must not be able to quietly undo it. Throwing (not warning)
 * is deliberate: a worker that refuses to start is safer than a brain that
 * can be talked into reading its key.
 */
export function buildDoWorkEnv(
  parentEnv: Record<string, string | undefined> = process.env
): Record<string, string> {
  const names = new Set(DOWORK_DEFAULT_ENV);
  const extra = parentEnv.GUILD_DOWORK_ENV ?? '';
  for (const raw of extra.split(',')) {
    const name = raw.trim();
    if (name === '') continue;
    if (name.toUpperCase().startsWith('GUILD_')) {
      throw new Error(
        `GUILD_DOWORK_ENV must not pass GUILD_* variables to the doWork brain (got "${name}"). ` +
          'The brain reads attacker-authored task text and must never hold guild credentials.'
      );
    }
    names.add(name);
  }
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = parentEnv[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Bring-your-own-agent work function. Runs the operator-supplied command
 * (GUILD_DOWORK_CMD) with the task brief on STDIN and takes its STDOUT as the
 * submission content. The brief is never interpolated into the command, so task
 * content can't inject; the command itself comes only from the operator's own
 * env. The child runs on the allowlisted env above — pass your agent's own
 * credentials (e.g. its LLM API key) by naming them in GUILD_DOWORK_ENV.
 * Wire any agent — a script, an LLM CLI, your own binary — without this
 * client depending on it. For richer control, import `runWorkerCycle` and pass
 * your own `doWork` directly. Example: GUILD_DOWORK_CMD="node my-agent.js".
 */
export function createCommandDoWork(cmd: string): DoWork {
  const env = buildDoWorkEnv();
  return async (task: GuildTask): Promise<string> => {
    const brief = `Guild task #${task.id}: ${task.title}\n\n${task.description}`;
    // node:child_process, not Bun.spawn — the same call works under Node and Bun,
    // which is what lets the published dist/ run wherever the operator's agent
    // does (P4-5 / A2A distance item 2). The env allowlist above is the
    // load-bearing part; `sh -c` keeps the operator's command shape unchanged.
    const { stdout, stderr, exitCode } = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
      (resolvePromise, rejectPromise) => {
        const proc = spawn('sh', ['-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'], env });
        let out = '';
        let err = '';
        proc.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
        proc.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
        proc.on('error', rejectPromise);
        proc.on('close', code => resolvePromise({ stdout: out, stderr: err, exitCode: code ?? -1 }));
        proc.stdin.on('error', () => {
          /* the child may exit before reading its brief; the close handler reports that */
        });
        proc.stdin.end(brief);
      }
    );
    if (exitCode !== 0) {
      throw new Error(`GUILD_DOWORK_CMD ("${cmd}") exited ${exitCode}: ${stderr.slice(0, 500)}`);
    }
    return stdout.trim().slice(0, 10_000) || `Completed task #${task.id} (no output)`;
  };
}

/**
 * Parse GUILD_MAX_CLAIMS_PER_CYCLE into a per-cycle claim budget.
 *
 * Unset or empty returns undefined, and worker.ts applies its own default of 1.
 * Anything else must be a plain positive integer, and a bad value THROWS rather
 * than falling back to a default.
 *
 * Throwing is deliberate, because this cap is money. Every claim locks a bond
 * (GUILD_ESCROW_CLAIM_BOND_XRD, 10 XRD by default), and the only thing bounding
 * that exposure is `claimsThisCycle >= maxClaimsPerCycle` in worker.ts. The old
 * `env ? Number(env) : undefined` form let `Number('abc')` through as NaN — and
 * every `>=` comparison against NaN is false, so a single typo silently REMOVED
 * the cap and let one cycle claim every open task, bonding each one. A worker
 * that refuses to start is strictly safer than a worker with no claim budget.
 *
 * The regex (not Number alone) is what rejects 'Infinity', '1e9', '2.5' and
 * '-1' — Number() accepts all four, and none is a sane claim budget.
 */
/**
 * Parse WORKER_TRUSTED_POSTERS into the claim allowlist (comma-separated
 * account addresses). Unset/empty returns [], and worker.ts's default-deny
 * gate treats an empty allowlist as "claim nothing" — the SAFE default,
 * unlike parseMaxClaimsPerCycle's throw-on-garbage: a malformed or misspelled
 * entry here just never matches a real `task.creatorId` and fails CLOSED
 * (denies that poster), so there is no unsafe direction for a typo to push
 * this in. No address-shape validation on purpose, for the same reason.
 */
export function parseTrustedPosters(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

export function parseMaxClaimsPerCycle(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `GUILD_MAX_CLAIMS_PER_CYCLE must be a plain positive integer (got "${raw}"). ` +
        'Each claim locks a bond, so this budget is never silently defaulted — ' +
        'unset the variable to use the default of 1.'
    );
  }
  const parsed = Number(trimmed);
  if (parsed < 1) {
    throw new Error(
      `GUILD_MAX_CLAIMS_PER_CYCLE must be at least 1 (got "${raw}"). ` +
        'A budget of 0 would claim nothing; unset the variable to use the default of 1.'
    );
  }
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`GUILD_MAX_CLAIMS_PER_CYCLE is unreasonably large (got "${raw}").`);
  }
  return parsed;
}

/**
 * Test-only injection seams. Real invocations (the CLI's own import.meta.main
 * guard below, and guild-worker.ts's `run` subcommand) never pass any of
 * these — identity/api are always derived for real, intervalMs always
 * defaults to startWorkerLoop's 60s, and signal is always undefined (so
 * --loop never resolves on its own; the process runs until an OS kill, same
 * as the "runs until killed" comment always intended).
 */
export interface WorkerCliOverrides {
  identity?: AgentIdentity;
  api?: GuildApiClient;
  intervalMs?: number;
  /**
   * Lets a caller stop an in-progress `--loop` run and let workerCliMain's
   * promise resolve. Exists for tests (and any future graceful-shutdown
   * wiring); the CLI itself never passes one.
   */
  signal?: AbortSignal;
}

export async function workerCliMain(
  argv: string[] = process.argv.slice(2),
  overrides: WorkerCliOverrides = {}
): Promise<void> {
  const args = new Set(argv);
  const live = args.has('--live');
  const loop = args.has('--loop');
  const onChain = args.has('--on-chain');
  const autoWithdraw = args.has('--auto-withdraw');
  // `--sweep-to owner` | `--sweep-to <account>` | `--sweep-to=<…>` (custody ruling R1).
  // Parsed by position because this CLI's flags are otherwise a bare Set.
  const sweepFlagIndex = argv.findIndex(a => a === '--sweep-to' || a.startsWith('--sweep-to='));
  let sweepTo: string | undefined;
  if (sweepFlagIndex !== -1) {
    const flag = argv[sweepFlagIndex]!;
    const value = flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : argv[sweepFlagIndex + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('--sweep-to needs a value: `--sweep-to owner` (the account in GUILD_OWNER_ACCOUNT) or an account address.');
    }
    sweepTo = value;
  }

  // Hard error, not a warning — unlike --on-chain above (which merely has no
  // effect without --live), --auto-withdraw SIGNS a real transaction (the
  // existing `withdraw` leg, withdraw.ts) for every entitlement the
  // post-submit survey reports, every cycle. A warning here would let the
  // flag look accepted while quietly collecting nothing, which is worse than
  // refusing to start. Checked before touching identity/api on purpose — a
  // flag-shape mistake shouldn't need a working private key to surface.
  if (autoWithdraw && !live) {
    throw new Error(
      '--auto-withdraw needs --live (nothing signs without an explicit --live). Drop ' +
        '--auto-withdraw for a report-only cycle (the default), or add --live to also collect ' +
        'every entitlement the post-submit survey reports, each cycle.'
    );
  }

  // Same stance for --sweep-to: it is the second half of collecting, so without
  // --auto-withdraw it would look accepted and move nothing.
  if (sweepTo !== undefined && !autoWithdraw) {
    throw new Error(
      '--sweep-to needs --auto-withdraw (and --live): the loop sweeps what it has just collected. ' +
        'For a one-off, run `guild-worker sweep --live`.'
    );
  }

  const identity = overrides.identity ?? (await AgentIdentity.fromPrivateKeyHex(loadAgentPrivateKeyHex()));
  const api = overrides.api ?? new GuildApiClient();
  console.log(`guild-worker: agent address ${identity.address}`);
  const mode = onChain ? 'LIVE + ON-CHAIN' : live ? 'LIVE (off-chain)' : 'dry-run';
  console.log(`guild-worker: api ${api.config.apiBaseUrl} (${mode})`);
  if (onChain && !live) {
    console.warn(
      'guild-worker: --on-chain has no effect without --live (no submissions to settle)'
    );
  }

  let doWork: DoWork | undefined;
  if (live) {
    const cmd = process.env.GUILD_DOWORK_CMD;
    if (!cmd) {
      throw new Error(
        '--live needs a work function. Set GUILD_DOWORK_CMD to a command that reads the ' +
          'task brief on stdin and writes the submission content to stdout ' +
          '(e.g. GUILD_DOWORK_CMD="node my-agent.js"), or import runWorkerCycle and pass ' +
          'your own doWork. This client ships no agent — you bring yours.'
      );
    }
    doWork = createCommandDoWork(cmd);
  }

  const maxClaimsPerCycle = parseMaxClaimsPerCycle(process.env.GUILD_MAX_CLAIMS_PER_CYCLE);
  const trustedPosters = parseTrustedPosters(process.env.WORKER_TRUSTED_POSTERS);
  const options = {
    api,
    identity,
    dryRun: !live,
    onChain,
    doWork,
    maxClaimsPerCycle,
    trustedPosters,
    autoWithdraw,
    ...(sweepTo !== undefined ? { sweepTo } : {}),
  };
  if (onChain) {
    console.log(`guild-worker: per-cycle claim budget = ${maxClaimsPerCycle ?? 1}`);
  }
  console.log(
    trustedPosters.length > 0
      ? `guild-worker: claim allowlist = ${trustedPosters.length} trusted poster(s)`
      : 'guild-worker: claim allowlist EMPTY (WORKER_TRUSTED_POSTERS unset) — this worker will claim NOTHING. ' +
        'Set WORKER_TRUSTED_POSTERS to the accounts you intend to work for.'
  );
  console.log(
    autoWithdraw
      ? 'guild-worker: auto-withdraw ENABLED — every entitlement the post-submit survey reports will be collected on-chain, each cycle'
      : 'guild-worker: auto-withdraw disabled (default) — uncollected entitlements are only reported; ' +
        'run `guild-worker withdraw <onChainTaskId> --live` yourself, or pass --auto-withdraw'
  );

  if (sweepTo !== undefined) {
    console.log(
      `guild-worker: owner sweep ENABLED (--sweep-to ${sweepTo}) — after each cycle's collections, everything above the float ` +
        'goes to the owner wallet in its own transaction'
    );
  }

  if (loop) {
    // BUG (U5, EXTERNAL-V1-FRAMEWORK.md P4-4), fixed here. This used to be
    // `startWorkerLoop(options); return;` — startWorkerLoop is fire-and-forget
    // (it schedules its own setTimeout chain and returns a stop handle
    // synchronously), so that early `return` resolved workerCliMain's promise
    // before a single cycle ran. `guild-worker run --loop` (guild-worker.ts)
    // awaits workerCliMain and calls `process.exit(code)` the instant it
    // resolves, so the process died before the loop ever ticked. The direct
    // entry below (`bun run worker`, this file's own import.meta.main guard)
    // masked the bug: it never calls process.exit on success, so the dangling
    // setTimeout chain alone kept THAT process alive — the bug only showed up
    // through `guild-worker run --loop`.
    //
    // Fix: block until something actually stops the loop. Real usage passes
    // no signal, so this promise never resolves on its own — the process
    // stays alive exactly as the old "runs until killed" comment intended,
    // and termination is still an OS-level kill (Ctrl-C / SIGTERM), not a
    // return value. Tests pass an AbortController so a run can be observed
    // for N cycles and then shut down cleanly instead of hanging forever.
    await new Promise<void>(resolvePromise => {
      const handle = startWorkerLoop({ ...options, intervalMs: overrides.intervalMs });
      overrides.signal?.addEventListener('abort', () => {
        handle.stop();
        resolvePromise();
      });
    });
    return;
  }
  const report = await runWorkerCycle(options);
  console.log(`guild-worker: report ${JSON.stringify(report, null, 2)}`);
}

// Direct entry (`bun run worker`) keeps its behavior; `guild-worker run`
// imports workerCliMain instead, so the guard stops a double-run on import.
// isMainModule, not import.meta.main: the latter is undefined on Node < 22.18,
// where this guard would silently never fire and the CLI would exit 0 having
// done nothing.
if (isMainModule(import.meta.url)) {
  workerCliMain().catch((error: unknown) => {
    console.error(`guild-worker: fatal: ${String(error)}`);
    process.exit(1);
  });
}
