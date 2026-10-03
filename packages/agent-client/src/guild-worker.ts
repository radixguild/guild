#!/usr/bin/env node
// guild-worker — the one CLI an agent operator needs. Subcommands:
//
//   doctor      readiness preflight (read-only; --auth adds a real ROLA login)
//   onboard     guided seed→funded→badged→verified→earning walk
//   mint-badge  Member-badge self-mint (DRY-RUN by default; --live signs)
//   withdraw    collect a settled entitlement (DRY-RUN by default; --live signs)
//   dispute     raise or auto-resolve a dispute (DRY-RUN by default; --live signs)
//   run         the worker loop (same flags as `bun run worker`)
//
// Safety: nothing signs without an explicit --live; doctor is read-only;
// secrets are never echoed, and no command here creates, derives, prints or
// stores a key — the agent brings its own (ruling 2026-10-03).

import { loadConfig, loadAgentPrivateKeyHex } from './config.js';
import { raiseDispute, resolveDispute } from './dispute.js';
import { runDoctor, renderDoctorReport } from './doctor.js';
import { AgentIdentity } from './identity.js';
import { mintMemberBadge } from './mint.js';
import { runOnboard } from './onboard.js';
import { isMainModule } from './runtime.js';
import { sweepToOwner, type SweepResult } from './sweep.js';
import { withdrawWorkerReward } from './withdraw.js';
import { workerCliMain } from './worker-cli.js';

export interface ParsedArgs {
  command: string;
  flags: Set<string>;
  options: Map<string, string>;
  /** Everything after the command that wasn't consumed (passed through to `run`). */
  rest: string[];
}

/** Flags that take a value (`--username bob` or `--username=bob`). */
const VALUE_OPTIONS = new Set(['--username', '--reason', '--owner', '--sweep-to', '--to']);

/**
 * Parse `<command> [flags]` argv into a command + flags/options/rest.
 *
 * `valueOptions` defaults to this CLI's own set (`--username`) so every
 * existing call site (guild-worker's own dispatcher, guild-worker.test.ts)
 * keeps working unchanged. `guild-poster.ts` imports this SAME function with
 * ITS OWN value-options set (`--title`/`--description`/`--reward`/
 * `--terms-file`) rather than re-implementing argv parsing a second time —
 * one parser, one set of edge cases (the `--key=value` / "needs a value"
 * checks below), shared by both CLIs.
 */
export function parseArgv(argv: string[], valueOptions: Set<string> = VALUE_OPTIONS): ParsedArgs {
  const [command = 'help', ...tail] = argv;
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const arg = tail[i];
    const eq = arg.indexOf('=');
    if (eq > 2 && arg.startsWith('--')) {
      // Every --key=value must name a known value option — otherwise it would
      // silently become a garbage flag ('--json=1' → flag "json=1" ≠ "json").
      if (!valueOptions.has(arg.slice(0, eq))) {
        throw new Error(`${arg.slice(0, eq)} does not take a value (drop the =…)`);
      }
      // `--sweep-to=` (nothing after the =) is the same mistake as `--sweep-to` with
      // nothing after it, and must fail the same way — not become an empty string a
      // command then has to interpret.
      if (arg.slice(eq + 1) === '') throw new Error(`${arg.slice(0, eq)} needs a value`);
      options.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else if (valueOptions.has(arg)) {
      const value = tail[++i];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} needs a value`);
      }
      options.set(arg.slice(2), value);
    } else if (arg.startsWith('--')) {
      flags.add(arg.slice(2));
    } else {
      rest.push(arg);
    }
  }
  return { command, flags, options, rest };
}

const HELP = `guild-worker — Radix Guild agent CLI

usage: guild-worker <command> [flags]

  doctor       readiness preflight: key, gateway, api, funding, badge, escrow
               (read-only; --auth adds a real ROLA login; --json for machines)
  onboard      guided onboarding: seed → funded → badged → verified → earning
               (the key is one you bring — this kit never makes one; --live +
               --username <n> performs the Member-badge mint when that stage is reached;
               --owner <wallet account> records who owns this agent, so its
               earnings can be swept there — see sweep below)
  mint-badge   Member-badge self-mint. DRY-RUN by default (prints the manifest,
               signs nothing); --live signs with GUILD_AGENT_PRIVATE_KEY.
               requires --username <name> ([a-zA-Z0-9_], max 51)
               Refuses a key that still has a pairing record (pairing is off for
               the beta); --live first signs in and asks the Guild, and refuses
               if it cannot get an answer.
  withdraw     collect what the escrow owes you on a settled task:
               withdraw <taskId> (keyless preview; --live signs with
               GUILD_AGENT_PRIVATE_KEY). Pays the account pinned at claim —
               there is no destination to choose.
               [--sweep-to owner|<account>] then moves everything above the
               float to your OWNER wallet, in a second transaction.
               Exit 3 = collected, but the sweep that followed did not happen.
  sweep        move everything above the float (default 200 XRD) to the owner
               wallet recorded in GUILD_OWNER_ACCOUNT. DRY-RUN by default;
               --live signs. [--to <account>] only when no owner is recorded —
               a recorded owner can never be overridden by a flag.
  dispute      raise or finalize a dispute. DRY-RUN by default (prints the
               manifest — raise also prints the evidence commitment — and
               signs nothing); --live signs with GUILD_AGENT_PRIVATE_KEY:
                 dispute raise <taskId> --reason <text>
                   present the Member badge you claimed with; --reason is
                   required and becomes the on-chain evidence commitment
                 dispute resolve <taskId>
                   permissionless auto-resolve after the 72h window — pays
                   the component's own default ruling; you receive nothing
               Production stays MOCK-ONLY: --live refuses against the live
               escrow (or a retired one) unless GUILD_ALLOW_LIVE_DISPUTE=1 is
               set on purpose.
  run          the worker loop — flags pass through: [--live] [--loop] [--on-chain]
               [--auto-withdraw] (collects every entitlement the post-submit
               survey reports, each cycle; needs --live — see README)
               [--sweep-to owner] (with --auto-withdraw: then moves everything
               above the float to the owner wallet)
  help         this text

env: GUILD_AGENT_PRIVATE_KEY (key), GUILD_DOWORK_CMD (your agent command),
GUILD_AGENT_BADGE_RESOURCE / GUILD_AGENT_BADGE_LOCAL_ID (claim badge),
GUILD_OWNER_ACCOUNT / GUILD_FLOAT_XRD (owner wallet + the float this key keeps)
— full reference in packages/agent-client/README.md`;

/** Load the agent identity from env, or null when no key is set. */
async function loadIdentityIfPresent(): Promise<AgentIdentity | null> {
  try {
    return await AgentIdentity.fromPrivateKeyHex(loadAgentPrivateKeyHex());
  } catch {
    return null;
  }
}

/**
 * The argv `run` hands to the worker loop. VALUE options must travel too: until
 * 2026-09-21 only `rest` and bare flags were forwarded, which was harmless while
 * no loop flag took a value — and would have made `run --auto-withdraw --sweep-to
 * owner` start a loop that LOOKED accepted and never swept. Exported for the test.
 */
export function runPassthroughArgv(args: ParsedArgs): string[] {
  return [
    ...args.rest,
    ...[...args.flags].map(f => `--${f}`),
    ...[...args.options].flatMap(([key, value]) => [`--${key}`, value]),
  ];
}

/**
 * Print a sweep outcome and pick the exit code. "Within the float" is a normal
 * answer (exit 0); every other refusal exits 1 so a caller scripting this never
 * reads an unswept balance as done.
 */
function reportSweep(result: SweepResult): number {
  const { manifest, ...machine } = result;
  if (result.refused) {
    const benign = result.refusal === 'within-float';
    console.error(`\n${benign ? 'Nothing swept' : 'Cannot sweep'}: ${result.message}\n`);
    console.log(`SWEEP ${JSON.stringify(machine)}`);
    return benign ? 0 : 1;
  }
  if (manifest && result.dryRun) {
    console.error('\nManifest that WOULD be signed (re-run with --live to sign):\n');
    console.error(manifest);
    console.error('');
  }
  console.error(
    result.dryRun
      ? `Dry-run only — nothing signed. Would send ${result.amount} XRD to ${result.owner}, keeping the ${result.floatXrd} XRD float.`
      : `Swept ${result.amount} XRD to ${result.owner}. The ${result.floatXrd} XRD float (less this fee) stays for the next claim.`
  );
  console.log(`SWEEP ${JSON.stringify(machine)}`);
  return 0;
}

/** Seams for testing the DISPATCH (which flag reaches which leg, which exit code). Real defaults. */
export interface MainDeps {
  withdrawWorkerReward: typeof withdrawWorkerReward;
  sweepToOwner: typeof sweepToOwner;
  loadIdentity: () => Promise<AgentIdentity | null>;
}

/** Exit codes: 0 ok · 1 refused/failed · 2 usage · 3 collected, but the sweep that followed did not happen. */
export const EXIT_COLLECTED_NOT_SWEPT = 3;

export async function main(argv: string[] = process.argv.slice(2), overrides: Partial<MainDeps> = {}): Promise<number> {
  const deps: MainDeps = { withdrawWorkerReward, sweepToOwner, loadIdentity: loadIdentityIfPresent, ...overrides };
  const args = parseArgv(argv);
  switch (args.command) {
    case 'doctor': {
      const report = await runDoctor({ includeAuth: args.flags.has('auth') });
      console.log(args.flags.has('json') ? JSON.stringify(report, null, 2) : renderDoctorReport(report));
      return report.verdict === 'ready' ? 0 : 1;
    }

    case 'onboard': {
      if (args.flags.has('generate')) {
        // Accepting it and carrying on would read as if a key had been made. None is: the kit never makes one.
        console.error(
          'onboard --generate is gone: this kit never creates a key. Bring your own and export it as GUILD_AGENT_PRIVATE_KEY, ' +
            'then run `guild-worker onboard`.'
        );
        return 2;
      }
      const outcome = await runOnboard({
        live: args.flags.has('live'),
        username: args.options.get('username'),
        owner: args.options.get('owner'),
      });
      return outcome.ok ? 0 : 1;
    }

    case 'mint-badge': {
      const username = args.options.get('username');
      if (!username) {
        console.error('mint-badge needs --username <name>   ([a-zA-Z0-9_], max 51 chars)');
        return 2;
      }
      const live = args.flags.has('live');
      const identity = await loadIdentityIfPresent();
      if (live && !identity) {
        console.error('mint-badge --live needs GUILD_AGENT_PRIVATE_KEY (drop --live for a keyless preview).');
        return 2;
      }
      const result = await mintMemberBadge({
        username,
        live,
        identity,
        config: loadConfig(),
        log: line => line && console.error(`mint-badge: ${line}`),
      });
      if (result.manifest) {
        console.error('\nManifest that WOULD be signed (re-run with --live to sign):\n');
        console.error(result.manifest);
        console.error('');
      }
      console.error(result.dryRun ? 'Dry-run only — nothing signed.' : 'Badge confirmed. Persist the env:');
      for (const line of result.envLines) console.error(`  ${line}`);
      // Machine-readable tail line (poster-harness RESULT convention).
      const { manifest: _manifest, ...machine } = result;
      console.log(`RESULT ${JSON.stringify(machine)}`);
      return 0;
    }

    case 'withdraw': {
      const raw = args.rest[0];
      const taskId = Number(raw);
      if (!raw || !Number.isInteger(taskId) || taskId <= 0) {
        console.error('withdraw needs a positive on-chain task id:  guild-worker withdraw <taskId>');
        return 2;
      }
      if (args.options.has('to')) {
        // `--to` belongs to `sweep`. Accepting it here and doing nothing would look like
        // a sweep was asked for and quietly leave the XRD on the key.
        console.error('withdraw does not take --to. To collect and then sweep: guild-worker withdraw <taskId> --sweep-to owner');
        return 2;
      }
      const live = args.flags.has('live');
      const identity = await deps.loadIdentity();
      if (live && !identity) {
        console.error('withdraw --live needs GUILD_AGENT_PRIVATE_KEY (drop --live for a keyless preview).');
        return 2;
      }
      const result = await deps.withdrawWorkerReward({
        taskId,
        live,
        identity,
        config: loadConfig(),
        log: line => line && console.error(`withdraw: ${line}`),
      });
      if (result.refused) {
        // Money that is owed but uncollectable must never fail silently: a
        // quiet exit on a settled task is the one outcome that leaves nobody
        // looking for the funds.
        console.error(`\nCannot collect task ${taskId}: ${result.message}\n`);
        console.log(`RESULT ${JSON.stringify(result)}`);
        return 1;
      }
      if (result.manifest && result.dryRun) {
        console.error('\nManifest that WOULD be signed (re-run with --live to sign):\n');
        console.error(result.manifest);
        console.error('');
      }
      // Deliberately does NOT name a destination account. The escrow deposits
      // into task.worker_account, and the payee guard passes when that pin
      // equals this account OR when the pin could not be read — so printing
      // "funds went to <this account>" would state as fact something only
      // proven in the first case. The chain is the record; point at it.
      console.error(
        result.dryRun
          ? 'Dry-run only — nothing signed.'
          : 'Collected. The escrow deposited into the account it pinned at claim time — confirm on the transaction above.'
      );
      const { manifest: _m, ...machine } = result;
      console.log(`RESULT ${JSON.stringify(machine)}`);
      const sweepTo = args.options.get('sweep-to');
      if (sweepTo === undefined) return 0;
      // A SECOND transaction, deliberately: the collection leg above is proven
      // and stays untouched, and if this one fails the XRD is still the agent's.
      if (result.dryRun) {
        console.error('\n--sweep-to preview (reads TODAY\'s balance — it does not yet include what this withdraw would collect):');
      }
      const sweepCode = reportSweep(
        await deps.sweepToOwner({ live, identity, requested: sweepTo, log: line => line && console.error(`sweep: ${line}`) })
      );
      // The collection above already succeeded (or previewed). A sweep that did not
      // happen must not make the whole command read as "the withdraw failed": on a
      // --live run that is its own exit code, so a script keying on $? can tell
      // "nothing collected" (1) from "collected, still on the agent key" (3).
      if (sweepCode !== 0 && !result.dryRun) {
        console.error('Collected — but NOT swept. The XRD is in the agent account; run `guild-worker sweep --live` once the reason above is fixed.');
        return EXIT_COLLECTED_NOT_SWEPT;
      }
      return sweepCode;
    }

    case 'sweep': {
      const to = args.options.get('to');
      const sweepToFlag = args.options.get('sweep-to');
      if (to !== undefined && sweepToFlag !== undefined && to !== sweepToFlag) {
        console.error('sweep was given both --to and --sweep-to with different values. Name the destination once.');
        return 2;
      }
      const live = args.flags.has('live');
      const identity = await deps.loadIdentity();
      if (live && !identity) {
        console.error('sweep --live needs GUILD_AGENT_PRIVATE_KEY (drop --live for a preview).');
        return 2;
      }
      return reportSweep(
        await deps.sweepToOwner({
          live,
          identity,
          requested: to ?? sweepToFlag,
          log: line => line && console.error(`sweep: ${line}`),
        })
      );
    }

    case 'dispute': {
      const sub = args.rest[0];
      if (sub !== 'raise' && sub !== 'resolve') {
        console.error(
          'dispute needs a sub-command:\n' +
            '  guild-worker dispute raise <taskId> --reason <text>\n' +
            '  guild-worker dispute resolve <taskId>'
        );
        return 2;
      }
      const raw = args.rest[1];
      const taskId = Number(raw);
      if (!raw || !Number.isInteger(taskId) || taskId <= 0) {
        console.error(
          `dispute ${sub} needs a positive on-chain task id:  guild-worker dispute ${sub} <taskId>`
        );
        return 2;
      }
      const live = args.flags.has('live');
      const identity = await loadIdentityIfPresent();
      if (live && !identity) {
        console.error(
          `dispute ${sub} --live needs GUILD_AGENT_PRIVATE_KEY (drop --live for a keyless preview).`
        );
        return 2;
      }

      if (sub === 'raise') {
        const reason = args.options.get('reason');
        if (reason === undefined) {
          console.error(
            'dispute raise needs --reason <text>:  guild-worker dispute raise <taskId> --reason <text>'
          );
          return 2;
        }
        const result = await raiseDispute({
          taskId,
          reason,
          live,
          identity,
          config: loadConfig(),
          log: line => line && console.error(`dispute raise: ${line}`),
        });
        if (result.refused) {
          // A dispute that SHOULD have been raised but silently wasn't is the
          // one outcome that leaves a real grievance unrecorded — same
          // reasoning as withdraw's refusal handling.
          console.error(`\nCannot raise a dispute on task ${taskId}: ${result.message}\n`);
          console.log(`RESULT ${JSON.stringify(result)}`);
          return 1;
        }
        if (result.dryRun) {
          console.error('\nManifest that WOULD be signed (re-run with --live to sign):\n');
          console.error(result.manifest);
          console.error(
            `\nEvidence commitment (sha256 of the domain-separated statement): ${result.evidenceHash}\n`
          );
          if (result.productionFuseWarning) console.error(`${result.productionFuseWarning}\n`);
        }
        const apiBaseUrl = loadConfig().apiBaseUrl;
        console.error(
          result.dryRun
            ? 'Dry-run only — nothing signed.'
            : 'Dispute raised on-chain. This CLI does not file the written statement for you — ' +
                'do it yourself once you have an authenticated session for this task\'s poster or ' +
                'worker account:\n' +
                `  curl -sX POST ${apiBaseUrl}/api/v1/tasks/${taskId}/dispute-evidence \\\n` +
                `    -H 'content-type: application/json' -H 'cookie: guild_session=<your session>' \\\n` +
                `    -d '${JSON.stringify({ evidence: reason })}'\n` +
                '  (the on-chain commitment already stands regardless of whether this succeeds.)'
        );
        const { manifest: _dm, ...machine } = result;
        console.log(`RESULT ${JSON.stringify(machine)}`);
        return 0;
      }

      // sub === 'resolve'
      const result = await resolveDispute({
        taskId,
        live,
        identity,
        config: loadConfig(),
        log: line => line && console.error(`dispute resolve: ${line}`),
      });
      if (result.dryRun) {
        console.error('\nManifest that WOULD be signed (re-run with --live to sign):\n');
        console.error(result.manifest);
        console.error('');
        if (result.productionFuseWarning) console.error(`${result.productionFuseWarning}\n`);
      }
      console.error(
        result.dryRun
          ? 'Dry-run only — nothing signed.'
          : 'Auto-resolve triggered. The component applied its own default ruling — the caller ' +
              '(you) receives nothing; auto_resolve_dispute pays no one directly.'
      );
      console.log(`RESULT ${JSON.stringify(result)}`);
      return 0;
    }

    case 'run':
      await workerCliMain(runPassthroughArgv(args));
      return 0;

    case 'help':
    case '--help':
      console.log(HELP);
      return 0;

    default:
      console.error(`unknown command: ${args.command}\n`);
      console.log(HELP);
      return 2;
  }
}

if (isMainModule(import.meta.url)) {
  main()
    .then(code => process.exit(code))
    .catch((error: unknown) => {
      console.error(`guild-worker: fatal: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
