// onboard.ts — the guided walk. What we pin: the stop-points (each stage gap
// halts with the exact operator action), the one automatable stage (mint only
// fires with BOTH --live and --username), the kit never makes a key (the agent
// brings its own — key-never-made.test.ts is the cross-command proof), and the
// happy path ends at 'earning' with the worker commands printed.

import { describe, expect, test } from 'bun:test';
import { loadConfig } from './config.js';
import { runOnboard, type OnboardDeps } from './onboard.js';
import { AgentStateCorruptError } from './agent-state.js';
import { GuildApiError } from './api.js';
import { PAIRING_SIGN_IN_WAIT_MS } from './mint.js';

const CONFIG = loadConfig();
const KEY_HEX = 'cc'.repeat(32);

function world(overrides: Partial<OnboardDeps> = {}): {
  deps: Partial<OnboardDeps>;
  calls: { minted: string[]; authed: number };
} {
  const calls = { minted: [] as string[], authed: 0 };
  const deps: Partial<OnboardDeps> = {
    fetchXrdBalance: async () => 25,
    // Flat mode with an arbitrary bond figure — NOT tied to DEFAULTS.claimBondXrd
    // (never consulted while this fake is non-null); see doctor.test.ts's
    // healthyDeps() for the same reasoning.
    readClaimBondBasis: async () => ({ mode: 'flat', amountXrd: '10' }),
    resolveBadgeLocalId: async () => '<guild_member_tester>',
    mint: async opts => {
      calls.minted.push(opts.username);
      return {
        dryRun: false,
        account: 'account_rdx1minted',
        badgeResource: CONFIG.workerBadgeResource,
        badgeLocalId: `guild_member_${opts.username}`,
        intentHash: 'txid_rdx1mint',
        envLines: [
          `export GUILD_AGENT_BADGE_RESOURCE="${CONFIG.workerBadgeResource}"`,
          `export GUILD_AGENT_BADGE_LOCAL_ID="guild_member_${opts.username}"`,
        ],
      };
    },
    authenticate: async () => {
      calls.authed += 1;
      return { id: 'account_rdx1user' };
    },
    localPairing: () => null,
    ...overrides,
  };
  return { deps, calls };
}

function run(
  opts: Partial<Parameters<typeof runOnboard>[0]>,
  deps: Partial<OnboardDeps>
): Promise<{ outcome: Awaited<ReturnType<typeof runOnboard>>; lines: string[] }> {
  const lines: string[] = [];
  return runOnboard({ config: CONFIG, deps, log: l => lines.push(l), ...opts }).then(outcome => ({
    outcome,
    lines,
  }));
}

describe('stage 1: key', () => {
  test('no key → stops and says to bring one; it never offers to make one', async () => {
    const { deps, calls } = world();
    const { outcome, lines } = await run({ env: {} }, deps);
    expect(outcome.reached).toBe('none');
    expect(outcome.ok).toBe(false);
    expect(outcome.address).toBeNull();
    expect(outcome.stoppedBecause).toBe('no key in env');
    const text = lines.join('\n');
    expect(text).toContain('never creates a key');
    expect(text).toContain('GUILD_AGENT_PRIVATE_KEY');
    expect(text).not.toContain('--generate');
    expect(text).not.toContain('new-seed');
    expect(text).not.toMatch(/\b[0-9a-f]{64}\b/);
    expect(calls.minted).toHaveLength(0);
    expect(calls.authed).toBe(0);
  });

  test('a stray generate option changes nothing: still no key, nothing printed, nothing made', async () => {
    const { deps } = world();
    // runOnboard no longer has a `generate` option; passing one (an old caller) must not resurrect it.
    const { outcome, lines } = await run({ env: {}, generate: true } as never, deps);
    expect(outcome.reached).toBe('none');
    expect(outcome.ok).toBe(false);
    expect(lines.join('\n')).not.toMatch(/\b[0-9a-f]{64}\b/);
  });
});

describe('stage 2: funding', () => {
  test('underfunded → stop, printing the address and exact top-up', async () => {
    const { deps, calls } = world({ fetchXrdBalance: async () => 4 });
    const { outcome, lines } = await run({ env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX } }, deps);
    expect(outcome.reached).toBe('key');
    expect(outcome.ok).toBe(false); // blocked ≠ success, even though 'key' completed
    expect(outcome.stoppedBecause).toBe('account underfunded');
    const text = lines.join('\n');
    expect(text).toMatch(/Send \d+ XRD/);
    expect(text).toContain(outcome.address);
    expect(calls.authed).toBe(0);
  });

  test('unreadable gateway → stop without guessing', async () => {
    const { deps } = world({ fetchXrdBalance: async () => null });
    const { outcome } = await run({ env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX } }, deps);
    expect(outcome.stoppedBecause).toBe('gateway unreadable');
    expect(outcome.ok).toBe(false);
  });

  // Wave B: a proportional component's FLOOR is what this stage funds
  // against, not the config default — mirrors doctor.test.ts's coverage of
  // the same maths in doctor.ts.
  test('a PROPORTIONAL bond basis funds against the live floor, not the config default', async () => {
    const { deps } = world({
      readClaimBondBasis: async () => ({ mode: 'proportional', pct: '0.1', floor: '50', cap: '500' }),
      fetchXrdBalance: async () => 30, // covers the flat-fixture target (15), not the live floor (55)
    });
    const { outcome, lines } = await run({ env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX } }, deps);
    expect(outcome.stoppedBecause).toBe('account underfunded');
    expect(lines.join('\n')).toContain('50');
  });
});

describe('stage 3: badge', () => {
  test('unbadged without --live → stop; mint stays an explicit opt-in', async () => {
    const { deps, calls } = world({ resolveBadgeLocalId: async () => null });
    const { outcome, lines } = await run({ env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX } }, deps);
    expect(outcome.reached).toBe('funding');
    expect(outcome.ok).toBe(false);
    expect(outcome.stoppedBecause).toContain('--live');
    expect(lines.join('\n')).toContain('mint-badge --username');
    expect(calls.minted).toHaveLength(0);
  });

  test('unbadged + --live + --username → mints inline and continues to earning', async () => {
    const { deps, calls } = world({ resolveBadgeLocalId: async () => null });
    const { outcome, lines } = await run(
      { env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX }, live: true, username: 'worker1' },
      deps
    );
    expect(calls.minted).toEqual(['worker1']);
    expect(calls.authed).toBe(1);
    expect(outcome.reached).toBe('earning');
    expect(outcome.ok).toBe(true);
    expect(lines.join('\n')).toContain('minted guild_member_worker1');
  });

  test('badge held → env persist lines printed when badge env is unset', async () => {
    const { deps, calls } = world();
    const { outcome, lines } = await run({ env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX } }, deps);
    expect(outcome.reached).toBe('earning');
    expect(calls.minted).toHaveLength(0); // held → never re-mints
    const text = lines.join('\n');
    expect(text).toContain('GUILD_AGENT_BADGE_RESOURCE');
    expect(text).toContain('guild_member_tester');
  });
});

describe('stages 4-5: verified → earning', () => {
  test('ROLA failure stops at badge with a doctor pointer', async () => {
    const { deps } = world({
      authenticate: async () => {
        throw new Error('origin mismatch');
      },
    });
    const { outcome, lines } = await run({ env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX } }, deps);
    expect(outcome.reached).toBe('badge');
    expect(outcome.ok).toBe(false);
    expect(outcome.stoppedBecause).toBe('ROLA login failed');
    expect(lines.join('\n')).toContain('doctor');
  });

  test('full walk prints the graduated worker commands + DOWORK warning', async () => {
    const { deps } = world();
    const { outcome, lines } = await run({ env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX } }, deps);
    expect(outcome.reached).toBe('earning');
    const text = lines.join('\n');
    expect(text).toContain('bun run worker');
    expect(text).toContain('--live --on-chain');
    expect(text).toContain('GUILD_DOWORK_CMD is unset');
  });

  test('no DOWORK warning when the env has it', async () => {
    const { deps } = world();
    const { lines } = await run(
      { env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX, GUILD_DOWORK_CMD: 'node agent.js' } },
      deps
    );
    expect(lines.join('\n')).not.toContain('GUILD_DOWORK_CMD is unset');
  });
});

// ── custody ruling R1 (2026-09-21): `onboard --owner <wallet account>` ────────
describe('onboard --owner — records who owns this agent, or stops', () => {
  const OWNER = 'account_rdx168e8u653alt59xm8ple6khu6cgce9cfx9mlza6wxf7qs3wwdh0pwpf'; // non-account fixture
  const OTHER = 'account_rdx12yh4fwevmvnqgdmllrmvmnvhkxvavpmyq2vwvmnvhkxvavpmyqtest'; // non-account fixture

  test('a good owner prints the two env lines to persist, and onboarding carries on', async () => {
    const { deps } = world();
    const { outcome, lines } = await run({ env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX }, owner: OWNER }, deps);
    expect(lines.some(l => l.includes(`GUILD_OWNER_ACCOUNT=${OWNER}`))).toBe(true);
    expect(lines.some(l => l.includes('GUILD_FLOAT_XRD=200'))).toBe(true);
    expect(lines.some(l => l.startsWith('✓ owner'))).toBe(true);
    expect(outcome.reached).not.toBe('key'); // it did not stop at the owner step
  });

  test('without --owner nothing about owners is printed — the default walk is unchanged', async () => {
    const { deps } = world();
    const { lines } = await run({ env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX } }, deps);
    expect(lines.some(l => /owner/i.test(l))).toBe(false);
  });

  test.each([
    ['malformed', 'account_rdx1short', /owner-invalid/],
    ['injection', `${OWNER}")\nCALL_METHOD`, /owner-invalid/],
  ])('a %s --owner STOPS onboarding, ok:false', async (_label, bad, why) => {
    const { deps, calls } = world();
    const { outcome, lines } = await run({ env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX }, owner: bad }, deps);
    expect(outcome.ok).toBe(false);
    expect(outcome.stoppedBecause).toMatch(why);
    expect(lines.some(l => l.startsWith('✗ owner'))).toBe(true);
    expect(lines.some(l => l.includes('GUILD_OWNER_ACCOUNT='))).toBe(false);
    expect(calls.authed).toBe(0); // nothing after the owner step ran
  });

  test("the agent's own account is refused as its owner", async () => {
    const { AgentIdentity } = await import('./identity.js');
    const self = (await AgentIdentity.fromPrivateKeyHex(KEY_HEX)).address;
    const { deps } = world();
    const { outcome } = await run({ env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX }, owner: self }, deps);
    expect(outcome.ok).toBe(false);
    expect(outcome.stoppedBecause).toMatch(/owner-is-agent/);
  });

  test('🔴 an owner already recorded in env cannot be replaced by the flag', async () => {
    const { deps } = world();
    const { outcome, lines } = await run(
      { env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX, GUILD_OWNER_ACCOUNT: OWNER }, owner: OTHER },
      deps
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.stoppedBecause).toMatch(/owner-mismatch/);
    expect(lines.some(l => l.includes(OTHER))).toBe(false);
  });
});

describe('onboard --owner — a malformed float already in env is named for what it is', () => {
  test('GUILD_FLOAT_XRD=lots → stops with link-invalid, and says which variable', async () => {
    const OWNER = 'account_rdx168e8u653alt59xm8ple6khu6cgce9cfx9mlza6wxf7qs3wwdh0pwpf'; // non-account fixture
    const { deps } = world();
    const { outcome, lines } = await run({ env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX, GUILD_FLOAT_XRD: 'lots' }, owner: OWNER }, deps);
    expect(outcome.ok).toBe(false);
    expect(outcome.stoppedBecause).toMatch(/link-invalid/);
    expect(lines.some(l => l.includes('GUILD_FLOAT_XRD'))).toBe(true);
  });
});

// K2 (bring-your-agent.md §3.3): a paired personal agent is funded by its owner
// and gets its badge from that one transaction — onboard's manual funding and
// self-mint would fight it, so onboard stops at the key.
describe('stage 1a: a paired personal agent', () => {
  test('a local pairing record for this key → stop before funding, badge or sign-in', async () => {
    const seen: string[] = [];
    let balanceReads = 0;
    const { deps, calls } = world({
      localPairing: address => {
        seen.push(address);
        return { address } as never;
      },
      fetchXrdBalance: async () => {
        balanceReads += 1;
        return 25;
      },
    });
    const { outcome, lines } = await run({ env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX }, live: true, username: 'worker1' }, deps);
    expect(outcome.ok).toBe(false);
    expect(outcome.stoppedBecause).toBe('paired personal agent');
    expect(seen).toHaveLength(1);
    expect(balanceReads).toBe(0);
    expect(calls.minted).toHaveLength(0);
    expect(calls.authed).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('Pairing is off for the beta');
    expect(text).toContain('guild-agent status');
    expect(text).not.toContain('guild-agent join');
  });

  test('an unreadable state file → a guided stop naming the fix, not a crash', async () => {
    const { deps, calls } = world({
      localPairing: () => {
        throw new AgentStateCorruptError('/x/agent.json', 'bad json');
      },
    });
    const { outcome, lines } = await run({ env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX } }, deps);
    expect(outcome.ok).toBe(false);
    expect(outcome.stoppedBecause).toBe('agent state file unreadable');
    expect(lines.join('\n')).toContain('pairing is off for the beta');
    expect(lines.join('\n')).not.toContain('guild-agent join');
    expect(calls.minted).toHaveLength(0);
  });

  test('any other error from the lookup is not swallowed', async () => {
    const { deps } = world({
      localPairing: () => {
        throw new Error('EACCES');
      },
    });
    await expect(run({ env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX } }, deps)).rejects.toThrow('EACCES');
  });
});

// K2-A review round 2: a live onboard signs in twice (the mint's pairing check,
// then stage 4) — the second sign-in waits out the auth rate limit too.
describe('stage 4 sign-in under the auth rate limit', () => {
  const rateLimited = () => new GuildApiError('RATE_LIMITED', 'slow down', 429);

  test('a 429 is waited out and the walk still reaches earning', async () => {
    let tries = 0;
    const waits: number[] = [];
    const { deps } = world({
      authenticate: async () => {
        if (++tries <= 2) throw rateLimited();
        return { id: 'account_rdx1user' };
      },
      sleep: async ms => void waits.push(ms),
    });
    const { outcome } = await run({ env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX } }, deps);
    expect(outcome.reached).toBe('earning');
    expect(waits).toEqual([PAIRING_SIGN_IN_WAIT_MS, PAIRING_SIGN_IN_WAIT_MS]);
  });

  test('a 429 that outlasts the waits stops at badge with the rate-limit advice, not the dApp one', async () => {
    const { deps } = world({
      authenticate: async () => {
        throw rateLimited();
      },
      sleep: async () => {},
    });
    const { outcome, lines } = await run({ env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX } }, deps);
    expect(outcome.ok).toBe(false);
    expect(outcome.stoppedBecause).toBe('ROLA login failed');
    expect(lines.join('\n')).toContain('rate-limiting sign-ins');
  });

  test('the mint gets onboard\'s env, so its local pairing lookup reads the same place', async () => {
    const seen: unknown[] = [];
    const { deps } = world({
      resolveBadgeLocalId: async () => null,
      mint: async opts => {
        seen.push(opts.env);
        return { dryRun: false, account: 'a', badgeResource: 'r', badgeLocalId: 'guild_member_w', envLines: [] };
      },
    });
    const env = { GUILD_AGENT_PRIVATE_KEY: KEY_HEX, GUILD_AGENT_KEY_FILE: '/elsewhere/agent.key' };
    await run({ env, live: true, username: 'w' }, deps);
    expect(seen).toEqual([env]);
  });
});
