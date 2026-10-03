// Parity: the kit's vendored rule constants against the guild-app source they
// copy. TEXT parity, not a live import: guild-app/src/lib/agent-rules.ts
// imports `zod`, which this package's CI job (agent-client, test.yml) does not
// install — a live import would fail "Cannot find package 'zod'" on every run
// (the reason work-brief.parity.test.ts scopes itself away from task-terms.ts).
// So this reads the server file and pins each exported literal, failing loudly
// if a literal can no longer be found. GUILD_NO_SIBLING=1 (a standalone
// checkout of this package) is the ONLY disarm, as in the other parity files.

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FEE_RESERVE_XRD } from './agent-rules.js';
import { DEFAULT_FLOAT_XRD } from './sweep.js';

const SERVER_FILE = fileURLToPath(new URL('../../../guild-app/src/lib/agent-rules.ts', import.meta.url));
const STANDALONE = !!process.env.GUILD_NO_SIBLING;

function serverLiteral(pattern: RegExp): string {
  const source = readFileSync(SERVER_FILE, 'utf8');
  const match = source.match(pattern);
  if (!match) throw new Error(`parity guard disarmed: ${pattern} not found in ${SERVER_FILE}`);
  return match[1];
}

describe('the parity guard itself', () => {
  test('is armed — the guild-app rules file is really there', () => {
    if (STANDALONE) {
      expect(process.env.GUILD_NO_SIBLING).toBeTruthy();
      return;
    }
    expect(existsSync(SERVER_FILE)).toBe(true);
  });
});

describe('vendored constants match guild-app/src/lib/agent-rules.ts', () => {
  test('FEE_RESERVE_XRD — same value, same type (a number on both sides)', () => {
    if (STANDALONE) return;
    // `= 20` exactly: a string ("20") or an expression on the server would no
    // longer match, and that is a change this copy has to be looked at for.
    expect(Number(serverLiteral(/^export const FEE_RESERVE_XRD = (\d+)$/m))).toBe(FEE_RESERVE_XRD);
    expect(typeof FEE_RESERVE_XRD).toBe('number');
  });

  test("DEFAULT_FLOAT_XRD — the server's pairing default is the float sweep.ts keeps", () => {
    if (STANDALONE) return;
    expect(serverLiteral(/^export const DEFAULT_FLOAT_XRD = "(\d+(?:\.\d+)?)"$/m)).toBe(DEFAULT_FLOAT_XRD);
  });
});
