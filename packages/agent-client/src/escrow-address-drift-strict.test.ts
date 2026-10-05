// The strict switch in escrow-address-drift.test.ts's inlined private-input
// guard (GUILD_REQUIRE_PRIVATE_INPUTS=1, post-flip topology note §5.6, private operations repository,
// F16). That guard runs at module scope, so the only honest test of it is to run
// the file: each case below runs `bun test` on it in a child process with exactly
// the switches it names, and inherits none from this run.
//
// Every case holds in this repo and in the public export alike. The one case whose
// outcome depends on the tree (the switch alone) asserts what that tree must do.

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const PKG = join(import.meta.dir, '..');
const DOC_PRESENT = existsSync(join(PKG, '..', '..', 'docs', 'ESCROW-ADDRESSES.md'));
const SWITCHES = new Set(['GUILD_REQUIRE_PRIVATE_INPUTS', 'GUILD_SIMULATE_PUBLIC_EXPORT', 'GUILD_NO_SIBLING']);
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SWITCHES.has(k)));

function runDriftTest(env: Record<string, string>) {
  const r = spawnSync(process.execPath, ['test', './src/escrow-address-drift.test.ts'], {
    cwd: PKG,
    encoding: 'utf8',
    env: { ...BASE_ENV, ...env },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const STRICT_MISSING = /missing under GUILD_REQUIRE_PRIVATE_INPUTS=1: docs\/ESCROW-ADDRESSES\.md/;

describe('escrow-address-drift.test.ts under GUILD_REQUIRE_PRIVATE_INPUTS', () => {
  test('without the switch, a missing doc SKIPS outside the private tree (the export)', () => {
    const r = runDriftTest({ GUILD_SIMULATE_PUBLIC_EXPORT: '1' });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/\b5 skip\b/);
  });

  test('with it, the same missing doc FAILS — the composed tree may not skip', () => {
    const r = runDriftTest({ GUILD_SIMULATE_PUBLIC_EXPORT: '1', GUILD_REQUIRE_PRIVATE_INPUTS: '1' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(STRICT_MISSING);
  });

  test(`alone, it ${DOC_PRESENT ? 'runs every test (the doc is here)' : 'fails (this tree lacks the doc)'}`, () => {
    const r = runDriftTest({ GUILD_REQUIRE_PRIVATE_INPUTS: '1' });
    if (DOC_PRESENT) {
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(/\b0 fail\b/);
      expect(r.out).not.toMatch(/\bskip\b/);
    } else {
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(STRICT_MISSING);
    }
  });

  test('any value but "1", "0" or "" is refused, so a typo cannot leave it off', () => {
    const r = runDriftTest({ GUILD_SIMULATE_PUBLIC_EXPORT: '1', GUILD_REQUIRE_PRIVATE_INPUTS: 'true' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/GUILD_REQUIRE_PRIVATE_INPUTS must be "1" \(strict\) or unset\/"0" \(off\), not "true"/);
  });

  test('"0" leaves it off', () => {
    const r = runDriftTest({ GUILD_SIMULATE_PUBLIC_EXPORT: '1', GUILD_REQUIRE_PRIVATE_INPUTS: '0' });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/\b5 skip\b/);
  });

  test('GUILD_NO_SIBLING with the switch is refused: it would read no doc and pass', () => {
    const r = runDriftTest({ GUILD_NO_SIBLING: '1', GUILD_REQUIRE_PRIVATE_INPUTS: '1' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/GUILD_REQUIRE_PRIVATE_INPUTS=1 with GUILD_NO_SIBLING/);
  });
});
