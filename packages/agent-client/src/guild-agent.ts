#!/usr/bin/env node
// guild-agent — the CLI a person's own agent runs (Bring Your Agent,
// docs/design/bring-your-agent.md §2). The operator fleet keeps guild-worker.
//
//   join                    OFF for the beta — refuses and says where a badge-first agent starts
//   status                  doctor + pairing state (--json for machines)
//   stop                    ask a running loop to exit at its next cycle boundary
//   sweep                   return money above the float to the pinned owner (agent.json + Gateway only)
//   run                     the loop — arrives with the next kit release (K2, on the owner sweep)
//
// Key custody: the agent BRINGS its own key (GUILD_AGENT_KEY_FILE or GUILD_AGENT_PRIVATE_KEY).
// No verb here creates, writes or prints one: pairing is off for the beta and agents are
// badge-first (ruling 2026-10-03). Every output path — status's report and JSON, the fatal
// handler — goes through secrets.ts's scrub, and key-never-made.test.ts pins both properties.

import { loadConfig, loadAgentPrivateKeyHex } from './config.js';
import { GuildApiClient, GuildApiError, PAIRING_ERROR_CODES, type AgentMe } from './api.js';
import {
  AgentStateCorruptError,
  readState,
  requestStop,
  resolveStatePath,
  resolveStopFilePath,
  type AgentState,
} from './agent-state.js';
import { renderDoctorReport, runDoctor, type DoctorReport } from './doctor.js';
import { AgentIdentity } from './identity.js';
import { parseArgv } from './guild-worker.js';
import { keyFileIsGroupOrWorldReadable, resolveKeyFilePath } from './key-file.js';
import { isMainModule } from './runtime.js';
import { RUN_SHIPPED, joinRefusedMessage, runNotShippedMessage } from './kit-release.js';
import { describeRunLock, inspectRunLock, resolveRunLockPath } from './run-lock.js';
import { ownerLinkFromState, sweepToOwner, type SweepResult } from './sweep.js';
import { FEE_LOCK_XRD } from './tx.js';
import { realRunDeps, runAgent } from './agent-run.js';
import { registerSecret, safeLogger, sanitizeForTerminal, scrub, untrusted } from './secrets.js';

// `--code` stays a value option so an old one-liner (`join --code 7KQ4-M2XZ`, `--code=…`) reaches
// join's refusal below instead of dying in the argv parser with a message about `=`.
const VALUE_OPTIONS = new Set(['--code']);

const HELP = `guild-agent — your own agent on the Radix Guild

usage: guild-agent <command> [flags]

  join                    OFF for the beta — pairing is closed, and this kit never makes a key.
                          It writes nothing, sends nothing and exits 2, saying where a badge-first
                          agent starts: bring your own key, fund its account yourself, mint its badge.
  status                  readiness checks + any pairing record (--json for machines)
  stop                    ask a running \`guild-agent run\` to exit cleanly
  sweep                   preview returning everything above the float to your
                          wallet (the owner pinned at activation — nowhere else).
                          --live signs it. --all returns the float too (retiring
                          the agent). --force sweeps even while \`run\` holds its
                          lock. Needs no Guild API: works while suspended.
  run                     the earning loop (next kit release)
  help                    this text

env: GUILD_AGENT_KEY_FILE (the file holding the key you bring, default ~/.radix-guild/agent.key) or
GUILD_AGENT_PRIVATE_KEY; optional GUILD_API_URL,
GUILD_DOWORK_CMD (the command that does the work: brief on stdin → submission on stdout),
GUILD_DOWORK_ENV (comma-separated env names to pass to it, e.g. ANTHROPIC_API_KEY).
Full reference: packages/agent-client/README.md`;

/** Injection seams for the dispatcher's own tests (real defaults). */
export interface MainDeps {
  env: Record<string, string | undefined>;
  runDoctor: typeof runDoctor;
  readState: typeof readState;
  requestStop: typeof requestStop;
  createApi: (config: ReturnType<typeof loadConfig>) => Pick<GuildApiClient, 'authenticate' | 'agentMe'>;
  sweepToOwner: typeof sweepToOwner;
  inspectRunLock: typeof inspectRunLock;
  /** The loop (agent-run.ts); only reached once RUN_SHIPPED. */
  runAgent: (env: Record<string, string | undefined>, log: (line: string) => void, error: (line: string) => void) => Promise<number>;
  log: (line: string) => void;
  error: (line: string) => void;
}

const REAL_DEPS: MainDeps = {
  env: process.env,
  runDoctor,
  readState,
  requestStop,
  createApi: config => new GuildApiClient(config),
  sweepToOwner,
  inspectRunLock,
  runAgent: (env, log, error) => runAgent({ ...realRunDeps(env), log, error }),
  log: line => console.log(line),
  error: line => console.error(line),
};

export async function main(argv: string[] = process.argv.slice(2), overrides: Partial<MainDeps> = {}): Promise<number> {
  const raw: MainDeps = { ...REAL_DEPS, ...overrides };
  // Every byte this CLI prints passes through scrub() — including lines the
  // injected deps print on the CLI's behalf.
  const deps: MainDeps = { ...raw, log: safeLogger(raw.log), error: safeLogger(raw.error) };
  let args;
  try {
    args = parseArgv(argv, VALUE_OPTIONS);
  } catch (error) {
    deps.error(`guild-agent: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  switch (args.command) {
    case 'join':
      // Whatever it was given (--code, --new-key, nothing): no key made, no file written, no API call.
      deps.error(joinRefusedMessage());
      return 2;

    case 'status':
      return status(args.flags.has('json'), deps);

    case 'stop': {
      const path = resolveStopFilePath(deps.env);
      deps.requestStop(path);
      deps.log(`Stop requested (${path}). A running loop exits at its next cycle boundary.`);
      return 0;
    }

    case 'sweep':
      return sweep({ live: args.flags.has('live'), all: args.flags.has('all'), force: args.flags.has('force') }, deps);

    case 'run':
      if (!RUN_SHIPPED) {
        deps.error(runNotShippedMessage());
        return 2;
      }
      return deps.runAgent(deps.env, deps.log, deps.error);

    case 'help':
    case '--help':
      deps.log(HELP);
      return 0;

    default:
      deps.error(`unknown command: ${args.command}\n`);
      deps.log(HELP);
      return 2;
  }
}

async function status(json: boolean, deps: MainDeps): Promise<number> {
  const keyPath = resolveKeyFilePath(deps.env);
  let keyHex: string;
  try {
    keyHex = loadAgentPrivateKeyHex(deps.env);
  } catch (error) {
    if (json) {
      deps.log(JSON.stringify({ key: null, state: null, error: error instanceof Error ? error.message : String(error) }));
    } else {
      deps.log('No agent key. This kit never creates one — bring your own:');
      deps.log(`  put it in ${keyPath} (or point GUILD_AGENT_KEY_FILE at it), or export GUILD_AGENT_PRIVATE_KEY.`);
      deps.log('  Then mint a badge and act as it: https://radixguild.com/agents');
    }
    return 1;
  }
  registerSecret(keyHex);
  const config = loadConfig();
  const report: DoctorReport = await deps.runDoctor({
    config,
    env: { ...deps.env, GUILD_AGENT_PRIVATE_KEY: keyHex },
    // No badgeSource: doctor reads this key's local record. A key with none (the badge-first
    // default) is told to mint its own badge; one with a leftover pairing record is told why not.
  });
  const warnings: string[] = [];
  let state: AgentState | null = null;
  let stateError: string | null = null;
  try {
    state = deps.readState(resolveStatePath(deps.env));
  } catch (error) {
    stateError = error instanceof AgentStateCorruptError ? error.message : untrusted(error instanceof Error ? error.message : String(error));
  }
  if (!deps.env.GUILD_AGENT_PRIVATE_KEY && keyFileIsGroupOrWorldReadable(keyPath)) {
    warnings.push(`the key file ${keyPath} is readable by other users — run: chmod 600 "${keyPath}"`);
  }

  // Pairing status comes from the Guild whenever there is a key — never from
  // the local file alone, which is only a cache and may be missing or stale.
  // A missing route (404) means this Guild has no pairing yet; report it.
  let pairing: AgentMe | null = null;
  let pairingError: string | null = null;
  let notPaired = false;
  let lostActivated = false;
  try {
    const api = deps.createApi(config);
    await api.authenticate(await AgentIdentity.fromPrivateKeyHex(keyHex));
    pairing = await api.agentMe();
    if (state?.ownerAccount && pairing.ownerAccount !== state.ownerAccount) {
      warnings.push(
        `owner-mismatch: the Guild reports owner ${pairing.ownerAccount} but this agent pinned ${state.ownerAccount}. ` +
          'The loop will refuse to run until this is resolved.'
      );
    }
    if (!state) {
      warnings.push(
        'the Guild knows this agent but the local record is missing, and nothing rebuilds it (`guild-agent join` is off for the beta) — ' +
          "contact the Guild with this agent's address."
      );
    }
  } catch (error) {
    if (error instanceof GuildApiError && error.code === PAIRING_ERROR_CODES.notPaired) {
      if (state?.ownerAccount) {
        // Activated here, gone there. Never "not paired, get a code": pairing is off
        // for the beta, so the Guild answers "not paired" to every account.
        lostActivated = true;
        warnings.push(
          `the Guild has no record of this agent although it was activated (owner ${state.ownerAccount}). ` +
            'Pairing is off for the beta, so the Guild answers "not paired" for every account; ' +
            'contact the Guild with this agent\'s address if you need this one back.'
        );
      } else {
        notPaired = true;
      }
    } else if (error instanceof GuildApiError && error.status === 404) {
      pairingError = 'this Guild does not offer agent pairing yet';
    } else {
      pairingError = untrusted(error instanceof Error ? error.message : String(error));
    }
  }
  // "status always asks the Guild": an answer it could not get is a failure,
  // not a pass — whatever the local file says.
  if (pairingError) warnings.push(`could not confirm pairing with the Guild: ${pairingError}`);

  if (json) {
    deps.log(
      JSON.stringify(
        {
          keyFile: deps.env.GUILD_AGENT_PRIVATE_KEY ? null : keyPath,
          doctor: report,
          state,
          stateError,
          pairing,
          notPaired,
          lostActivated,
          pairingError,
          warnings,
        },
        null,
        2
      )
    );
  } else {
    deps.log(renderDoctorReport(report));
    deps.log('');
    if (stateError) deps.log(`⚠ ${stateError}`);
    if (pairing) {
      deps.log(`Pairing: "${pairing.label}" · ${pairing.status} · owner ${pairing.ownerAccount}`);
      deps.log(`Float:   ${pairing.floatXrd} XRD`);
      deps.log(`Rules:   ${JSON.stringify(pairing.rules)}`);
    } else if (notPaired && state?.pendingOwnerAccount) {
      deps.log(`Pairing: none — the earlier pairing "${untrusted(state.label ?? '?')}" was never funded and has expired; pairing is off for the beta.`);
    } else if (notPaired) {
      deps.log('Pairing: none — pairing is off for the beta. This agent acts as its own badge: https://radixguild.com/agents');
    } else if (lostActivated && state) {
      deps.log(`Pairing: "${untrusted(state.label ?? '?')}" · was active (local record) · owner ${state.ownerAccount} — the Guild has no record of it`);
    } else if (state) {
      deps.log(`Pairing: "${untrusted(state.label ?? '?')}" · ${state.status ?? 'unknown'} (local record, unconfirmed) · owner ${state.ownerAccount ?? state.pendingOwnerAccount ?? '?'}`);
    } else {
      deps.log('Pairing: unknown');
    }
    for (const w of warnings) deps.log(`⚠ ${w}`);
  }
  return report.verdict === 'ready' && warnings.length === 0 && !stateError ? 0 : 1;
}

/**
 * `guild-agent sweep` (bring-your-agent.md §3.7). Everything above the float
 * goes to the owner pinned in agent.json — never to an address from env, a
 * flag or the Guild — and nothing here calls the Guild API, so a suspended or
 * retired agent can still return its money. --all keeps only the XRD this
 * transfer's own fee lock needs.
 */
async function sweep(opts: { live: boolean; all: boolean; force: boolean }, deps: MainDeps): Promise<number> {
  let keyHex: string;
  try {
    keyHex = loadAgentPrivateKeyHex(deps.env);
  } catch (error) {
    deps.error(`guild-agent sweep: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  registerSecret(keyHex);
  const identity = await AgentIdentity.fromPrivateKeyHex(keyHex);

  let state: AgentState | null;
  try {
    state = deps.readState(resolveStatePath(deps.env));
  } catch (error) {
    deps.error(`Cannot sweep: ${error instanceof AgentStateCorruptError ? error.message : untrusted(String(error))}`);
    return 1;
  }
  const owner = ownerLinkFromState(state, identity.address);
  if (!owner.ok) {
    deps.error(`Cannot sweep: ${owner.why}`);
    return 1;
  }

  // A sweep between run's balance check and its claim makes that claim fail:
  // a wasted fee, never lost funds. So a live loop is a stop sign, not a wall.
  if (!opts.force) {
    const lockPath = resolveRunLockPath(deps.env);
    const lock = deps.inspectRunLock(lockPath);
    if (lock.state === 'held' || lock.state === 'unreadable') {
      deps.error(
        `Cannot sweep: ${describeRunLock(lockPath, lock)} Stop it first (guild-agent stop), or pass --force — ` +
          'a sweep during a claim can make that claim fail (a wasted fee, never lost funds).'
      );
      return 1;
    }
  }

  const link = opts.all ? { ...owner.link, floatXrd: FEE_LOCK_XRD } : owner.link;
  const result = await deps.sweepToOwner({
    live: opts.live,
    identity,
    requested: 'owner',
    link,
    config: loadConfig(),
    log: line => line && deps.error(`sweep: ${line}`),
  });
  return reportSweep(result, opts.all, deps);
}

function reportSweep(result: SweepResult, all: boolean, deps: MainDeps): number {
  const { manifest, ...machine } = result;
  const kept = all
    ? `keeping ${result.floatXrd} XRD for this transfer's fee lock (most of it is refunded)`
    : `keeping the ${result.floatXrd} XRD float`;
  if (result.refused) {
    const benign = result.refusal === 'within-float';
    deps.error(
      benign
        ? all
          ? `Nothing to sweep: the balance is within the ${result.floatXrd} XRD this transfer's fee lock needs.`
          : (result.message ?? 'Nothing to sweep.')
        : `Cannot sweep: ${result.message}`
    );
    deps.log(`SWEEP ${JSON.stringify(machine)}`);
    return benign ? 0 : 1;
  }
  if (manifest && result.dryRun) {
    deps.error('Manifest that WOULD be signed (re-run with --live to sign):');
    deps.error(manifest);
  }
  deps.error(
    result.dryRun
      ? `Dry-run only — nothing signed. Would send ${result.amount} XRD to ${result.owner}, ${kept}.`
      : `Swept ${result.amount} XRD to ${result.owner}, ${kept}.`
  );
  deps.log(`SWEEP ${JSON.stringify(machine)}`);
  return 0;
}

/** The one line the process prints when main() itself throws — scrubbed and sanitised like every other. */
export function fatalLine(error: unknown): string {
  return sanitizeForTerminal(scrub(`guild-agent: fatal: ${error instanceof Error ? error.message : String(error)}`));
}

if (isMainModule(import.meta.url)) {
  main()
    .then(code => process.exit(code))
    .catch((error: unknown) => {
      console.error(fatalLine(error));
      process.exit(1);
    });
}
