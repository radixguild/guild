// guild-agent.ts — the dispatcher. Every verb is driven through injected deps;
// nothing here touches the network, the home directory, or a real key.

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { GuildApiError, PAIRING_ERROR_CODES, type AgentMe } from './api.js';
import { AgentStateCorruptError, type AgentState } from './agent-state.js';
import type { DoctorReport } from './doctor.js';
import { AgentIdentity } from './identity.js';
import { generateThrowawayPrivateKeyHex } from './throwaway-key.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fatalLine, main, type MainDeps } from './guild-agent.js';
import { KEY_FILE_ENV } from './key-file.js';
import { REDACTED, _resetSecretsForTests, registerSecret } from './secrets.js';
import type { SweepOptions, SweepResult } from './sweep.js';
import { FEE_LOCK_XRD } from './tx.js';

const KEY = generateThrowawayPrivateKeyHex();
const OWNER = 'account_rdx12y5senkxfxg38swfv4tg88lx73jqnkdvcnzv8kwwdmg0efl40r2p7u';
const STRANGER = 'account_rdx1299rtllydz2vz6rrs4zafu2htkndwm2g5ksd27rrw9mhrechcm7tlr';

beforeEach(() => _resetSecretsForTests());

function readyReport(detail = 'ok'): DoctorReport {
  return { checks: [{ id: 'key', label: 'key', status: 'pass', detail }], verdict: 'ready', lane: 'member-badge', address: 'account_rdx1x' };
}

function activeState(): AgentState {
  return {
    version: 1,
    label: 'myagent',
    address: 'account_rdx1x',
    apiBaseUrl: 'https://guild.test',
    status: 'active',
    ownerAccount: OWNER,
    pendingOwnerAccount: null,
    floatXrd: '200',
    badgeId: '<guild_member_myagent>',
    pairedAt: '2026-09-24T00:00:00.000Z',
    activatedAt: '2026-09-24T00:05:00.000Z',
  };
}

function me(overrides: Partial<AgentMe> = {}): AgentMe {
  return {
    label: 'myagent',
    status: 'active',
    ownerAccount: OWNER,
    floatXrd: '200',
    badgeId: '<guild_member_myagent>',
    rules: { v: 1, trustedPosters: [OWNER], maxBondXrd: '180', maxClaimsPerDay: 1, dryRun: false },
    ...overrides,
  };
}

const notPairedApi = () => ({
  authenticate: async () => ({ id: 'x' }) as never,
  agentMe: async () => {
    throw new GuildApiError(PAIRING_ERROR_CODES.notPaired, 'no row', 404);
  },
});
const pairedApi = (m: AgentMe = me()) => () => ({ authenticate: async () => ({ id: 'x' }) as never, agentMe: async () => m });

function deps(overrides: Partial<MainDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: unknown[] = [];
  const d: Partial<MainDeps> = {
    env: { [KEY_FILE_ENV]: '/nowhere/agent.key' },
    join: async opts => {
      calls.push(['join', opts.code]);
      return { stage: 'active', exitCode: 0, address: 'account_rdx1x' };
    },
    runDoctor: async () => readyReport(),
    readState: () => null,
    requestStop: path => {
      calls.push(['stop', path]);
    },
    createApi: notPairedApi,
    log: l => out.push(l),
    error: l => err.push(l),
    ...overrides,
  };
  return { d, out, err, calls };
}

describe('README documents guild-agent', () => {
  const readme = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');

  for (const cmd of ['join', 'status', 'stop', 'sweep']) {
    test(`README mentions guild-agent's \`${cmd}\``, () => {
      expect(readme).toContain(`guild-agent ${cmd}`);
    });
  }
  test('the install line in the README is the shape CI proves (npx -y -p <tarball> guild-…), and no longer a pairing one', () => {
    expect(readme).toMatch(/npx -y -p https:\/\/radixguild\.com\/kit\/agent\.tgz guild-worker mint-badge/);
    // `join --code` survives only as the OLD line the refusal paragraph explains — never as an instruction.
    expect(readme).not.toMatch(/^npx -y -p \S+ guild-agent join/m);
  });
  test('the README names the loss bound, the key file the kit reads, and that no command makes or prints a key', () => {
    expect(readme).toContain('generates, derives, prints or stores a key');
    expect(readme).toMatch(/one live bond/);
    expect(readme).toContain('GUILD_AGENT_KEY_FILE');
    expect(readme).toContain('key-never-made.test.ts');
  });
  test('the README says plainly what is off and which halves are not live yet (honest-copy standard)', () => {
    const flat = readme.replace(/\n> /g, ' ').replace(/\n/g, ' ');
    expect(flat).toContain('off for the beta');
    expect(flat).toContain('the earning loop (`run`) follows in the next release');
    expect(flat).toContain('until a deploy has run, the URL answers 404');
  });
  test('the two undocumented-until-now env vars are documented with their default-deny / no-credentials defaults', () => {
    expect(readme).toMatch(/`WORKER_TRUSTED_POSTERS`.*claims nothing/);
    expect(readme).toMatch(/`GUILD_DOWORK_ENV`.*no credentials/);
  });
});

describe('the fatal handler', () => {
  test('🔴 scrubs the key and strips control sequences from a thrown message', () => {
    registerSecret(KEY);
    const line = fatalLine(new Error(`boom ${KEY} \u001b[31mred\u001b[0m`));
    expect(line.startsWith('guild-agent: fatal: boom')).toBe(true);
    expect(line).not.toContain(KEY);
    expect(line).toContain(REDACTED);
    expect(line).not.toContain('\u001b');
  });
});

describe('guild-agent dispatch', () => {
  test('help → 0 and names every verb', async () => {
    const { d, out } = deps();
    expect(await main(['help'], d)).toBe(0);
    const text = out.join('\n');
    for (const verb of ['join', 'status', 'stop', 'sweep', 'run']) expect(text).toContain(verb);
    expect(text).toContain('OFF for the beta');
    // Neither pairing flag is advertised any more.
    expect(text).not.toContain('--new-key');
    expect(text).not.toContain('--code XXXX');
  });

  test('bare invocation is help', async () => {
    const { d, out } = deps();
    expect(await main([], d)).toBe(0);
    expect(out.join('\n')).toContain('usage: guild-agent');
  });

  test('unknown verb → 2', async () => {
    const { d, err } = deps();
    expect(await main(['dance'], d)).toBe(2);
    expect(err.join('\n')).toContain('unknown command: dance');
  });

  // `join` is off: it refuses and DOES NOTHING — every seam below throws if it is touched.
  // key-never-made.test.ts is the cross-command proof that no key is made or printed; this pins the dispatch.
  const untouchable = (name: string) => () => {
    throw new Error(`${name} was called by join`);
  };
  const joinWorld = () =>
    deps({
      runDoctor: untouchable('runDoctor') as never,
      readState: untouchable('readState') as never,
      requestStop: untouchable('requestStop') as never,
      createApi: untouchable('createApi') as never,
      sweepToOwner: untouchable('sweepToOwner') as never,
      inspectRunLock: untouchable('inspectRunLock') as never,
      runAgent: untouchable('runAgent') as never,
    });

  for (const argv of [
    ['join'],
    ['join', '--code', '7KQ4-M2XZ'],
    ['join', '--code=7KQ4-M2XZ'],
    ['join', '--new-key'],
    ['join', '--new-key', '--code', '7KQ4-M2XZ'],
  ]) {
    test(`\`${argv.join(' ')}\` → refused with exit 2, the three badge-first steps, and nothing called`, async () => {
      const { d, out, err, calls } = joinWorld();
      expect(await main(argv, d)).toBe(2);
      const text = err.join('\n');
      expect(text).toContain('guild-agent join is off');
      expect(text).toContain('never creates a key');
      expect(text).toContain('GUILD_AGENT_KEY_FILE');
      expect(text).toContain("Fund the agent's account yourself");
      expect(text).toContain('the Guild never');
      expect(text).toContain('guild-worker mint-badge --username <name> --live');
      // /mint mints into the CONNECTED wallet account, and the Radix Wallet cannot control a raw-key account.
      expect(text).not.toContain('radixguild.com/mint');
      expect(out).toEqual([]);
      expect(calls).toEqual([]);
    });
  }

  test('--new-key=… is still a usage error (it takes no value), exit 2', async () => {
    const { d, err } = deps();
    expect(await main(['join', '--new-key=yes'], d)).toBe(2);
    expect(err.join('\n')).toContain('does not take a value');
  });

  test('the refusal message and kit-release agree (one source), and it names no key-making command', async () => {
    const { joinRefusedMessage } = await import('./kit-release.js');
    const { d, err } = joinWorld();
    await main(['join'], d);
    expect(err.join('\n')).toBe(joinRefusedMessage());
    expect(joinRefusedMessage()).not.toMatch(/--generate|--new-key|new-seed/);
    expect(joinRefusedMessage()).not.toMatch(/\b[0-9a-f]{64}\b/);
  });

  test('--code without a value is still a usage error, exit 2', async () => {
    const { d, err } = deps();
    expect(await main(['join', '--code'], d)).toBe(2);
    expect(err.join('\n')).toContain('needs a value');
  });

  test('stop writes the stop file beside the key and says so', async () => {
    const { d, out, calls } = deps();
    expect(await main(['stop'], d)).toBe(0);
    expect(calls).toEqual([['stop', '/nowhere/stop']]);
    expect(out.join('\n')).toContain('/nowhere/stop');
  });

  test('run is not in this release: exit 2 with the operator alternative', async () => {
    const { RUN_SHIPPED } = await import('./kit-release.js');
    const { d, err } = deps();
    expect(await main(['run'], d)).toBe(2);
    expect(err.join('\n')).toContain('guild-worker run');
    expect(RUN_SHIPPED).toBe(false);
  });
});

describe('guild-agent status', () => {
  test("leaves the badge source to doctor's local-record lookup — badge-first by default, never forced to a Fund & activate hint", async () => {
    const seen: unknown[] = [];
    const { d } = deps({
      env: { GUILD_AGENT_PRIVATE_KEY: KEY },
      runDoctor: async opts => {
        seen.push(opts.badgeSource);
        return readyReport();
      },
    });
    await main(['status'], d);
    expect(seen).toEqual([undefined]);
  });

  test('no key anywhere → 1, says to bring one, and never points at a key-making command', async () => {
    const { d, out } = deps();
    expect(await main(['status'], d)).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('No agent key.');
    expect(text).toContain('never creates one');
    expect(text).toContain('/nowhere/agent.key');
    expect(text).toContain('GUILD_AGENT_PRIVATE_KEY');
    expect(text).toContain('radixguild.com/agents');
    expect(text).not.toContain('--generate');
    expect(text).not.toContain('guild-agent join');
    expect(text).not.toContain('Add an agent');
  });

  test('key in env, Guild says not paired → doctor report + "pairing is off", no way to pair offered; exit follows the doctor verdict', async () => {
    const { d, out } = deps({ env: { GUILD_AGENT_PRIVATE_KEY: KEY } });
    expect(await main(['status'], d)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Pairing: none');
    expect(text).toContain('pairing is off for the beta');
    expect(text).not.toContain('guild-agent join');
    expect(text).not.toContain('XXXX-XXXX');
    expect(text).not.toContain(KEY);
  });

  test('paired → shows label, status, owner and rules from the Guild', async () => {
    const { d, out } = deps({ env: { GUILD_AGENT_PRIVATE_KEY: KEY }, readState: () => activeState(), createApi: pairedApi() });
    expect(await main(['status'], d)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('"myagent" · active');
    expect(text).toContain(OWNER);
    expect(text).toContain('maxBondXrd');
    expect(text).not.toContain(KEY);
  });

  test('🔴 the Guild is asked even with NO local record: an active agent whose agent.json is gone is reported, with the rebuild command, exit 1', async () => {
    const { d, out } = deps({ env: { GUILD_AGENT_PRIVATE_KEY: KEY }, readState: () => null, createApi: pairedApi() });
    expect(await main(['status'], d)).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('"myagent" · active');
    expect(text).toContain('local record is missing');
    expect(text).toContain('is off for the beta');
    expect(text).not.toContain('not paired');
  });

  test('a pending pairing the Guild has dropped: "none" with the reason (never funded, expired) and no way to re-pair', async () => {
    const pendingState = { ...activeState(), status: 'pending' as const, ownerAccount: null, pendingOwnerAccount: OWNER, floatXrd: null, badgeId: null, activatedAt: null };
    const { d, out } = deps({ env: { GUILD_AGENT_PRIVATE_KEY: KEY }, readState: () => pendingState, createApi: notPairedApi });
    expect(await main(['status'], d)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('never funded');
    expect(text).toContain('pairing is off for the beta');
    expect(text).not.toContain('join --code');
  });

  test('🔴 an activated agent whose Guild record vanished is NOT "not paired": exit 1, no "get a code", and the reason is that pairing is off', async () => {
    const { d, out } = deps({ env: { GUILD_AGENT_PRIVATE_KEY: KEY }, readState: () => activeState(), createApi: notPairedApi });
    expect(await main(['status'], d)).toBe(1);
    const text = out.join('\n');
    expect(text).not.toContain('Pairing: none');
    expect(text).not.toContain('join --code');
    expect(text).toContain('no record of this agent although it was activated');
    expect(text).toContain(OWNER);
    expect(text).toContain('Pairing is off for the beta');
    expect(text).toContain('contact the Guild');
  });

  test('the same situation in --json: notPaired is false and the warning is present', async () => {
    const { d, out } = deps({ env: { GUILD_AGENT_PRIVATE_KEY: KEY }, readState: () => activeState(), createApi: notPairedApi });
    expect(await main(['status', '--json'], d)).toBe(1);
    const doc = JSON.parse(out.join('\n'));
    expect(doc.notPaired).toBe(false);
    expect(doc.warnings.join(' ')).toContain('although it was activated');
  });

  test('🔴 owner-mismatch between the Guild and the pinned owner is a warning and exit 1', async () => {
    const { d, out } = deps({
      env: { GUILD_AGENT_PRIVATE_KEY: KEY },
      readState: () => activeState(),
      createApi: pairedApi(me({ ownerAccount: STRANGER })),
    });
    expect(await main(['status'], d)).toBe(1);
    expect(out.join('\n')).toContain('owner-mismatch');
  });

  test('a corrupt agent.json is a warning with the fix, and the Guild is still consulted', async () => {
    const { d, out } = deps({
      env: { GUILD_AGENT_PRIVATE_KEY: KEY },
      readState: () => {
        throw new AgentStateCorruptError('/nowhere/agent.json', 'Unexpected token');
      },
      createApi: pairedApi(),
    });
    expect(await main(['status'], d)).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('unreadable');
    expect(text).toContain('"myagent" · active');
  });

  test('🔴 status output is scrubbed: a doctor detail carrying the key prints redacted, in text and in --json', async () => {
    const leaky = () => readyReport(`env says ${KEY}`);
    const t = deps({ env: { GUILD_AGENT_PRIVATE_KEY: KEY }, runDoctor: async () => leaky() });
    expect(await main(['status'], t.d)).toBe(0);
    expect(t.out.join('\n')).not.toContain(KEY);
    expect(t.out.join('\n')).toContain(REDACTED);
    const j = deps({ env: { GUILD_AGENT_PRIVATE_KEY: KEY }, runDoctor: async () => leaky() });
    expect(await main(['status', '--json'], j.d)).toBe(0);
    const doc = JSON.parse(j.out.join('\n'));
    expect(JSON.stringify(doc)).not.toContain(KEY);
    expect(doc.doctor.checks[0].detail).toContain(REDACTED);
  });

  test('--json emits one JSON document with the doctor report, state and pairing', async () => {
    const { d, out } = deps({ env: { GUILD_AGENT_PRIVATE_KEY: KEY }, readState: () => activeState(), createApi: pairedApi() });
    expect(await main(['status', '--json'], d)).toBe(0);
    const doc = JSON.parse(out.join('\n'));
    expect(doc.doctor.verdict).toBe('ready');
    expect(doc.state.label).toBe('myagent');
    expect(doc.pairing.status).toBe('active');
    expect(doc.notPaired).toBe(false);
    expect(JSON.stringify(doc)).not.toContain(KEY);
  });

  test('🔴 the Guild could not be asked (network error) → the local record is shown as unconfirmed and the exit is 1, never 0', async () => {
    const { d, out } = deps({
      env: { GUILD_AGENT_PRIVATE_KEY: KEY },
      readState: () => activeState(),
      createApi: () => ({
        authenticate: async () => ({ id: 'x' }) as never,
        agentMe: async () => {
          throw new Error('fetch failed: ECONNRESET \u001b[31mx\u001b[0m');
        },
      }),
    });
    expect(await main(['status'], d)).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('could not confirm pairing with the Guild');
    expect(text).toContain('unconfirmed');
    expect(text).not.toContain('\u001b');
  });

  test('a pairing API that is missing (plain 404) is named and is also exit 1 — asking is not confirming', async () => {
    const { d, out } = deps({
      env: { GUILD_AGENT_PRIVATE_KEY: KEY },
      readState: () => activeState(),
      createApi: () => ({
        authenticate: async () => ({ id: 'x' }) as never,
        agentMe: async () => {
          throw new GuildApiError('NOT_FOUND', 'x', 404);
        },
      }),
    });
    expect(await main(['status'], d)).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('does not offer agent pairing yet');
    expect(text).toContain('(local record, unconfirmed)');
  });
});

// K2-C — `guild-agent sweep` (bring-your-agent.md §3.7): the pinned owner from
// agent.json is the ONLY destination (never env, a flag or the Guild), nothing
// calls the Guild API, and a live `run` lock stops it unless --force.
describe('guild-agent sweep', () => {
  let agentAddress = '';
  beforeAll(async () => {
    agentAddress = (await AgentIdentity.fromPrivateKeyHex(KEY)).address;
  });
  const state = (overrides: Partial<AgentState> = {}): AgentState => ({ ...activeState(), address: agentAddress, ...overrides });

  function sweepWorld(overrides: Partial<MainDeps> = {}, result?: (opts: SweepOptions) => SweepResult) {
    const seen: SweepOptions[] = [];
    const world = deps({
      // A hostile env: the fleet's owner vars name a stranger and a tiny float.
      env: { GUILD_AGENT_PRIVATE_KEY: KEY, GUILD_OWNER_ACCOUNT: STRANGER, GUILD_FLOAT_XRD: '1' },
      readState: () => state(),
      inspectRunLock: () => ({ state: 'free' }),
      createApi: () => {
        throw new Error('the Guild API was called');
      },
      sweepToOwner: async opts => {
        seen.push(opts);
        return (
          result?.(opts) ?? {
            refused: false,
            dryRun: !opts.live,
            owner: opts.link!.ownerAccount!,
            amount: '37.5',
            balance: '237.5',
            floatXrd: opts.link!.floatXrd,
            manifest: 'CALL_METHOD …',
          }
        );
      },
      ...overrides,
    });
    return { ...world, seen };
  }

  test('previews by default: the owner and float come from agent.json, the env owner is ignored, no Guild API', async () => {
    const { d, out, err, seen } = sweepWorld();
    expect(await main(['sweep'], d)).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].live).toBe(false);
    expect(seen[0].requested).toBe('owner');
    expect(seen[0].link).toEqual({ ownerAccount: OWNER, floatXrd: '200' });
    expect(seen[0].identity?.address).toBe(agentAddress);
    expect(err.join('\n')).toContain('Dry-run only');
    expect(err.join('\n')).toContain('keeping the 200 XRD float');
    expect(out.some(l => l.startsWith('SWEEP {'))).toBe(true);
    expect([...out, ...err].join('\n')).not.toContain(KEY);
  });

  test('--live signs', async () => {
    const { d, err, seen } = sweepWorld();
    expect(await main(['sweep', '--live'], d)).toBe(0);
    expect(seen[0].live).toBe(true);
    expect(err.join('\n')).toContain('Swept 37.5 XRD');
  });

  test("--all returns the float too, keeping only the transfer's own fee lock — still to the pinned owner", async () => {
    const { d, err, seen } = sweepWorld();
    expect(await main(['sweep', '--all'], d)).toBe(0);
    expect(seen[0].link).toEqual({ ownerAccount: OWNER, floatXrd: FEE_LOCK_XRD });
    expect(err.join('\n')).toContain('fee lock');
  });

  test('an activated record without a float keeps the default float, never zero', async () => {
    const { d, seen } = sweepWorld({ readState: () => state({ floatXrd: null }) });
    await main(['sweep'], d);
    expect(seen[0].link?.floatXrd).toBe('200');
  });

  for (const [name, readState, why] of [
    ['no local record', () => null, /no local record/],
    ['a record for another key', () => state({ address: STRANGER }), /belongs to/],
    ['not activated (no pinned owner)', () => state({ status: 'pending', ownerAccount: null, pendingOwnerAccount: OWNER }), /not been activated/],
    [
      'an unreadable record',
      () => {
        throw new AgentStateCorruptError('/x/agent.json', 'bad json');
      },
      /unreadable/,
    ],
  ] as const) {
    test(`refuses with ${name} — nothing is swept`, async () => {
      const { d, err, seen } = sweepWorld({ readState: readState as MainDeps['readState'] });
      expect(await main(['sweep', '--live'], d)).toBe(1);
      expect(seen).toHaveLength(0);
      expect(err.join('\n')).toMatch(why);
    });
  }

  test('no key → 1, nothing swept', async () => {
    const { d, seen } = sweepWorld({ env: { [KEY_FILE_ENV]: '/nowhere/agent.key' } });
    expect(await main(['sweep'], d)).toBe(1);
    expect(seen).toHaveLength(0);
  });

  test('a live run lock stops it, naming the pid and the way out; --force sweeps anyway', async () => {
    const held = sweepWorld({ inspectRunLock: () => ({ state: 'held', pid: 4242 }) });
    expect(await main(['sweep', '--live'], held.d)).toBe(1);
    expect(held.seen).toHaveLength(0);
    const text = held.err.join('\n');
    expect(text).toContain('pid 4242');
    expect(text).toContain('guild-agent stop');
    expect(text).toContain('--force');

    const forced = sweepWorld({
      inspectRunLock: () => {
        throw new Error('--force must not even read the lock');
      },
    });
    expect(await main(['sweep', '--live', '--force'], forced.d)).toBe(0);
    expect(forced.seen).toHaveLength(1);
  });

  test('an unreadable lock also stops it (fail closed); a stale one does not', async () => {
    const unreadable = sweepWorld({ inspectRunLock: () => ({ state: 'unreadable' }) });
    expect(await main(['sweep'], unreadable.d)).toBe(1);
    expect(unreadable.seen).toHaveLength(0);
    const stale = sweepWorld({ inspectRunLock: () => ({ state: 'stale', pid: 7 }) });
    expect(await main(['sweep'], stale.d)).toBe(0);
    expect(stale.seen).toHaveLength(1);
  });

  test('exit codes follow guild-worker sweep: within-float is 0, any other refusal 1', async () => {
    const within = sweepWorld({}, () => ({ refused: true, refusal: 'within-float', message: 'Nothing to sweep', dryRun: true }));
    expect(await main(['sweep'], within.d)).toBe(0);
    expect(within.err.join('\n')).toBe('Nothing to sweep');
    const withinAll = sweepWorld({}, opts => ({ refused: true, refusal: 'within-float', message: 'x', dryRun: true, floatXrd: opts.link!.floatXrd }));
    expect(await main(['sweep', '--all'], withinAll.d)).toBe(0);
    expect(withinAll.err.join('\n')).toContain(`within the ${FEE_LOCK_XRD} XRD this transfer's fee lock needs`);
    const failed = sweepWorld({}, () => ({ refused: true, refusal: 'not-committed', message: 'NOT swept', dryRun: false }));
    expect(await main(['sweep', '--live'], failed.d)).toBe(1);
    expect(failed.err.join('\n')).toContain('Cannot sweep');
  });
});
