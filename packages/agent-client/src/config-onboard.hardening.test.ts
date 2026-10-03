// Adversarial hardening for two operator-input footguns:
//   1. config.ts claimBondXrd — a non-numeric GUILD_ESCROW_CLAIM_BOND_XRD (the
//      '1O'-for-'10' typo, 'abc', '', '-5') must FALL BACK to the safe default,
//      never become NaN (NaN !== undefined would override the default AND
//      silently disable the downstream `balance < fundingTarget` funding gate).
//   2. onboard.ts stage-1 key — a set-but-malformed GUILD_AGENT_PRIVATE_KEY must
//      stop gracefully ({ ok:false, reached:'none' }) without throwing, and the
//      log must never echo the raw key value.
//
// Both production fixes are already applied here; the "proving" cases pass.
// Env-mutating tests save/restore process.env so they can't leak into siblings.

import { describe, expect, test, afterEach, beforeEach } from 'bun:test';
import { loadConfig } from './config.js';
import { runOnboard, type OnboardDeps } from './onboard.js';

// ── shared onboard harness (mirrors onboard.test.ts world()/run()) ───────────
const CONFIG = loadConfig();

function world(overrides: Partial<OnboardDeps> = {}): {
  deps: Partial<OnboardDeps>;
  calls: { minted: string[]; authed: number; balanceReads: number; badgeReads: number };
} {
  const calls = { minted: [] as string[], authed: 0, balanceReads: 0, badgeReads: 0 };
  const deps: Partial<OnboardDeps> = {
    fetchXrdBalance: async () => {
      calls.balanceReads += 1;
      return 25;
    },
    resolveBadgeLocalId: async () => {
      calls.badgeReads += 1;
      return '<guild_member_tester>';
    },
    mint: async opts => {
      calls.minted.push(opts.username);
      return {
        dryRun: false,
        account: 'account_rdx1minted',
        badgeResource: CONFIG.workerBadgeResource,
        badgeLocalId: `guild_member_${opts.username}`,
        intentHash: 'txid_rdx1mint',
        envLines: [],
      };
    },
    authenticate: async () => {
      calls.authed += 1;
      return { id: 'account_rdx1user' };
    },
    generateKeyHex: () => 'dd'.repeat(32),
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

// ── config: env save/restore so mutations never leak to sibling files ────────
const ENV_KEYS = ['GUILD_ESCROW_CLAIM_BOND_XRD', 'GUILD_API_URL'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe('config: claimBondXrd never becomes NaN (proves the fix)', () => {
  const DEFAULT_BOND = 76.45; // DEFAULTS.claimBondXrd in config.ts (Wave B claim_bond_floor)

  // Every non-numeric / negative form falls back to the default; a valid one passes.
  const cases: Array<{ raw: string; expected: number; why: string }> = [
    { raw: '1O', expected: DEFAULT_BOND, why: "letter-O typo for '10'" },
    { raw: 'abc', expected: DEFAULT_BOND, why: 'pure non-numeric' },
    { raw: '', expected: DEFAULT_BOND, why: 'empty string (env() treats as unset)' },
    { raw: '-5', expected: DEFAULT_BOND, why: 'negative bond is nonsensical' },
    // JS quirk: Number('  ') === 0 (NOT NaN), so a whitespace-only value is finite
    // and >= 0 → honored as 0. Documented as current behavior; the NaN guard is
    // unaffected (0 is finite). A future trim()-then-reject could tighten this.
    { raw: '  ', expected: 0, why: 'whitespace-only coerces to 0, not NaN' },
    { raw: '7', expected: 7, why: 'a valid positive bond is honored' },
    { raw: '0', expected: 0, why: 'zero is finite and >= 0, so honored verbatim' },
  ];

  for (const { raw, expected, why } of cases) {
    test(`GUILD_ESCROW_CLAIM_BOND_XRD=${JSON.stringify(raw)} → ${expected} (${why})`, () => {
      process.env.GUILD_ESCROW_CLAIM_BOND_XRD = raw;
      const bond = loadConfig().claimBondXrd;
      expect(Number.isNaN(bond)).toBe(false); // the core guard: never NaN
      expect(bond).toBe(expected);
    });
  }

  test("a NaN bond would disable the funding gate — assert it can't arise from '1O'", () => {
    process.env.GUILD_ESCROW_CLAIM_BOND_XRD = '1O';
    const bond = loadConfig().claimBondXrd;
    // Downstream doctor/onboard compute `balance < claimBondXrd + fees`. With NaN
    // that comparison is ALWAYS false → underfunded accounts slip through. A finite
    // default keeps the gate live.
    expect(Number.isFinite(bond)).toBe(true);
    expect(bond).toBeGreaterThan(0);
  });
});

describe('config: apiBaseUrl trailing-slash handling (documents current behavior)', () => {
  test('env branch STRIPS a trailing slash', () => {
    process.env.GUILD_API_URL = 'https://x.com/';
    expect(loadConfig().apiBaseUrl).toBe('https://x.com'); // .replace(/\/+$/, '')
  });

  test('env branch strips MULTIPLE trailing slashes', () => {
    process.env.GUILD_API_URL = 'https://x.com///';
    expect(loadConfig().apiBaseUrl).toBe('https://x.com');
  });

  test('override branch is VERBATIM — trailing slash is NOT normalized (validation gap)', () => {
    // KNOWN GAP: loadConfig({ apiBaseUrl }) bypasses the env .replace(), so a caller
    // that passes 'https://x.com/' gets it back unchanged. Not a live-env footgun
    // (env is the operator surface) but recorded so a future normalize-at-merge
    // change has a pinned baseline. If that gap is closed, THIS assertion flips.
    const cfg = loadConfig({ apiBaseUrl: 'https://x.com/' });
    expect(cfg.apiBaseUrl).toBe('https://x.com/');
  });
});

describe('onboard stage-1: malformed key stops gracefully & never echoes it (proves the fix)', () => {
  const BAD_KEYS = [
    'not-hex', // non-hex chars + odd length
    '0xdeadbeef', // 0x prefix is rejected (assertHex wants bare hex)
    'zz'.repeat(32), // right length, non-hex nibbles
    'cc'.repeat(16), // valid hex but only 16 bytes, not 32
  ];

  for (const bad of BAD_KEYS) {
    test(`GUILD_AGENT_PRIVATE_KEY=${JSON.stringify(bad)} → { ok:false, reached:'none' }, no throw, no echo`, async () => {
      const { deps, calls } = world();
      let outcome: Awaited<ReturnType<typeof runOnboard>>;
      let lines: string[];
      // Must NOT throw — a set-but-bad key gives the same guided stop as an unset one.
      try {
        ({ outcome, lines } = await run({ env: { GUILD_AGENT_PRIVATE_KEY: bad } }, deps));
      } catch (e) {
        throw new Error(`runOnboard threw on a malformed key (should stop gracefully): ${e}`);
      }
      expect(outcome.ok).toBe(false);
      expect(outcome.reached).toBe('none');
      expect(outcome.address).toBeNull();
      expect(outcome.stoppedBecause).toBe('key in env does not parse');

      const text = lines.join('\n');
      // The stop message tells the operator the key didn't parse...
      expect(text).toContain('does not parse');
      // ...but the raw key value is NEVER logged (the parse error is value-free).
      expect(text).not.toContain(bad);

      // A stage-1 stop happens BEFORE any network seam is touched.
      expect(calls.balanceReads).toBe(0);
      expect(calls.badgeReads).toBe(0);
      expect(calls.authed).toBe(0);
      expect(calls.minted).toHaveLength(0);
    });
  }

  test('the guidance points at re-copy (a key you already hold), not at making one, and not a stack trace', async () => {
    const { deps } = world();
    const { lines } = await run({ env: { GUILD_AGENT_PRIVATE_KEY: 'not-hex' } }, deps);
    const text = lines.join('\n');
    expect(text).toContain('64 hex chars');
    expect(text).toContain('Re-copy it');
    expect(text).not.toContain('--generate');
  });
});
