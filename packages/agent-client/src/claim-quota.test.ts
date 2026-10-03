// claim-quota.ts — a rolling 24 h window of committed claims, fail-closed both ways.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEY_FILE_ENV } from './key-file.js';
import { QUOTA_WINDOW_MS, claimsAllowedThisTick, readClaimsInWindow, recordClaim, resolveClaimsLogPath } from './claim-quota.js';

let dir: string;
let log: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guild-quota-'));
  log = join(dir, 'claims.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const T = Date.parse('2026-09-27T12:00:00.000Z');

test('the log sits beside the key file', () => {
  expect(resolveClaimsLogPath({ [KEY_FILE_ENV]: join(dir, 'k', 'agent.key') })).toBe(join(dir, 'k', 'claims.json'));
});

describe('readClaimsInWindow', () => {
  test('no file → an empty window', () => {
    expect(readClaimsInWindow(log, T)).toEqual({ ok: true, entries: [] });
  });

  test('only entries inside the trailing 24 h count; the edge itself is outside', () => {
    writeFileSync(
      log,
      JSON.stringify([
        { taskId: 1, at: new Date(T - QUOTA_WINDOW_MS).toISOString() }, // exactly 24 h ago: out
        { taskId: 2, at: new Date(T - QUOTA_WINDOW_MS + 1).toISOString() }, // in
        { taskId: 3, at: new Date(T + 60_000).toISOString() }, // clock skew: counts
      ])
    );
    const r = readClaimsInWindow(log, T);
    expect(r.ok && r.entries.map(e => e.taskId)).toEqual([2, 3]);
  });

  test('garbage, a non-list, or a malformed entry → not ok (never an empty window)', () => {
    for (const bad of ['{not json', '{"a":1}', '[{"taskId":"x","at":"2026-09-27T00:00:00Z"}]', '[{"taskId":1,"at":"yesterday"}]']) {
      writeFileSync(log, bad);
      expect(readClaimsInWindow(log, T).ok).toBe(false);
    }
  });
});

describe('recordClaim', () => {
  test('appends and prunes entries older than the window', () => {
    writeFileSync(log, JSON.stringify([{ taskId: 1, at: new Date(T - 2 * QUOTA_WINDOW_MS).toISOString() }]));
    recordClaim(log, 7, new Date(T));
    const saved = JSON.parse(readFileSync(log, 'utf8'));
    expect(saved).toEqual([{ taskId: 7, at: new Date(T).toISOString() }]);
  });

  test('refuses (throws) when the log cannot be read — the caller must stop claiming', () => {
    writeFileSync(log, '{not json');
    expect(() => recordClaim(log, 7, new Date(T))).toThrow(/cannot record claim #7/);
  });

  test('throws when the log cannot be written', () => {
    mkdirSync(log); // a directory where the file should be
    expect(() => recordClaim(log, 7, new Date(T))).toThrow();
  });
});

describe('claimsAllowedThisTick', () => {
  const window = (n: number) => ({ ok: true as const, entries: Array.from({ length: n }, (_, i) => ({ taskId: i, at: '' })) });
  test('at most one a tick, whatever is left of the day', () => {
    expect(claimsAllowedThisTick(100, window(0))).toBe(1);
    expect(claimsAllowedThisTick(1, window(0))).toBe(1);
  });
  test('none once the day is spent, or over-spent, or the cap is 0', () => {
    expect(claimsAllowedThisTick(1, window(1))).toBe(0);
    expect(claimsAllowedThisTick(1, window(3))).toBe(0);
    expect(claimsAllowedThisTick(0, window(0))).toBe(0);
  });
  test('none when the log is unreadable', () => {
    expect(claimsAllowedThisTick(100, { ok: false, why: 'x' })).toBe(0);
  });
});
