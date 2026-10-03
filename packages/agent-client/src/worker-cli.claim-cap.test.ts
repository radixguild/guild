// Regression cover for the per-cycle claim budget parse (backlog L9).
//
// The bug: worker-cli read the budget as `env ? Number(env) : undefined`, so any
// non-numeric value became NaN — and NaN reaches worker.ts's `?? 1` intact,
// because NaN is neither null nor undefined. The guard that bounds bond exposure
// is `claimsThisCycle >= maxClaimsPerCycle`, and EVERY `>=` against NaN is false,
// so one typo silently removed the cap and let a single cycle claim every open
// task, locking a bond (10 XRD by default) on each.
//
// These tests pin the fix at the parse boundary: a bad value throws, so a NaN can
// never reach the comparison. The first test is the money one.

import { describe, test, expect } from 'bun:test';
import { parseMaxClaimsPerCycle } from './worker-cli.js';

describe('parseMaxClaimsPerCycle — the cap can never silently vanish', () => {
  test('a non-numeric value THROWS rather than becoming NaN (the L9 runaway)', () => {
    expect(() => parseMaxClaimsPerCycle('abc')).toThrow(/positive integer/);
    // Guard the actual mechanism, not just the throw: nothing NaN-ish escapes.
    for (const bad of ['abc', 'NaN', '1abc', 'e5']) {
      expect(() => parseMaxClaimsPerCycle(bad)).toThrow();
    }
  });

  test('Infinity and exponent notation throw — Number() would have accepted both', () => {
    expect(Number('Infinity')).toBe(Infinity); // documents why the regex, not Number, is the gate
    expect(() => parseMaxClaimsPerCycle('Infinity')).toThrow(/positive integer/);
    expect(() => parseMaxClaimsPerCycle('1e9')).toThrow(/positive integer/);
  });

  test('a fractional budget throws instead of rounding to a surprise', () => {
    expect(() => parseMaxClaimsPerCycle('2.5')).toThrow(/positive integer/);
  });

  test('zero and negatives throw — a 0 budget claims nothing and reads as broken', () => {
    expect(() => parseMaxClaimsPerCycle('0')).toThrow(/at least 1/);
    expect(() => parseMaxClaimsPerCycle('-1')).toThrow(/positive integer/);
  });

  test('unset or blank yields undefined so worker.ts applies its default of 1', () => {
    expect(parseMaxClaimsPerCycle(undefined)).toBeUndefined();
    expect(parseMaxClaimsPerCycle('')).toBeUndefined();
    expect(parseMaxClaimsPerCycle('   ')).toBeUndefined();
  });

  test('accepts plain positive integers, surrounding whitespace and leading zeros', () => {
    expect(parseMaxClaimsPerCycle('1')).toBe(1);
    expect(parseMaxClaimsPerCycle('5')).toBe(5);
    expect(parseMaxClaimsPerCycle(' 3 ')).toBe(3);
    expect(parseMaxClaimsPerCycle('007')).toBe(7);
  });

  test('an unsafe-integer budget throws', () => {
    expect(() => parseMaxClaimsPerCycle('99999999999999999999')).toThrow(/unreasonably large/);
  });
});
