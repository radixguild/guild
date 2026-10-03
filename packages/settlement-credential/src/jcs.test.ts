// JCS (RFC 8785) tests. Rather than transcribing the RFC's own worked
// numeric example from memory (risky — getting one digit of a
// floating-point round-trip wrong reads as passing while asserting a false
// "spec-verified" claim), these tests verify the properties RFC 8785
// actually specifies and that this package depends on:
//  1. Object keys are sorted by UTF-16 CODE UNIT, not Unicode code point —
//     the one place JCS explicitly diverges from a "sort by character"
//     intuition, and exactly why `Object.keys(o).sort()` (JS's native,
//     UTF-16-code-unit string sort) is the correct — not incidental —
//     implementation choice.
//  2. Canonical output is independent of source key insertion order
//     (the whole point of canonicalization for a signature scheme).
//  3. Structural correctness: arrays keep order, nested objects recurse,
//     `undefined` values are dropped exactly as JSON.stringify drops them.
//  4. Number formatting delegates to `String(n)` — which, running inside a
//     real JS engine, *is* the ECMA-262 Number::toString algorithm RFC 8785
//     §3.2.2.3 mandates, so this is exercised rather than reimplemented.

import { describe, test, expect } from 'bun:test';
import { canonicalize } from './jcs.js';

describe('canonicalize — key ordering', () => {
  test('sorts object keys', () => {
    expect(canonicalize({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });

  test('is independent of source key insertion order', () => {
    const a = { network: 'mainnet', task_id: 3, outcome: 'dispute_resolved' };
    const b = { outcome: 'dispute_resolved', task_id: 3, network: 'mainnet' };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  test('sorts nested object keys independently at each level', () => {
    const value = { z: { y: 1, x: 2 }, a: 1 };
    expect(canonicalize(value)).toBe('{"a":1,"z":{"x":2,"y":1}}');
  });

  // The RFC 8785-defining case: a key holding a supplementary-plane
  // character (U+10000, encoded as the UTF-16 surrogate pair 𐀀)
  // sorts BEFORE a key holding U+FFFF under UTF-16-CODE-UNIT ordering
  // (0xD800 < 0xFFFF), even though U+10000 > U+FFFF as a Unicode CODE
  // POINT. If canonicalize ever switched to code-point-aware sorting
  // (e.g. via .sort with a locale collator, or Array.from + codePointAt),
  // this is the test that would catch it.
  test('sorts by UTF-16 code unit, not Unicode code point', () => {
    const supplementary = '\u{10000}'; // U+10000, surrogate pair (code units 0xD800,0xDC00)
    const bmpHigh = '￿'; // U+FFFF, single code unit 0xFFFF
    const canonical = canonicalize({ [bmpHigh]: 1, [supplementary]: 2 });
    // Code-unit order: 0xD800 < 0xFFFF, so `supplementary` sorts first —
    // the opposite of code-point order (0x10000 > 0xFFFF).
    expect(canonical.indexOf(JSON.stringify(supplementary))).toBeLessThan(
      canonical.indexOf(JSON.stringify(bmpHigh))
    );
  });
});

describe('canonicalize — structure', () => {
  test('arrays preserve element order (never sorted)', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  test('drops keys whose value is undefined, like JSON.stringify', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test('null is preserved as a value (not dropped)', () => {
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });

  test('booleans render as bare true/false', () => {
    expect(canonicalize({ a: true, b: false })).toBe('{"a":true,"b":false}');
  });

  test('strings use standard JSON escaping', () => {
    expect(canonicalize('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
  });
});

describe('canonicalize — numbers', () => {
  test('integers render without a decimal point', () => {
    expect(canonicalize(10)).toBe('10');
    expect(canonicalize(0)).toBe('0');
  });

  test('negative zero canonicalizes as 0 (ECMA-262 Number::toString(-0) === "0")', () => {
    expect(canonicalize(-0)).toBe('0');
  });

  test('rejects non-finite numbers rather than silently emitting invalid JSON', () => {
    expect(() => canonicalize(Number.NaN)).toThrow();
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('canonicalize — realistic credential shape', () => {
  test('two credentials differing only in field order canonicalize identically', () => {
    const subjectA = {
      task_id: 3,
      escrow_component: 'component_rdx1cz468e',
      outcome: 'dispute_resolved',
      amount_xrd: '10',
    };
    const subjectB = {
      amount_xrd: '10',
      outcome: 'dispute_resolved',
      escrow_component: 'component_rdx1cz468e',
      task_id: 3,
    };
    expect(canonicalize(subjectA)).toBe(canonicalize(subjectB));
  });
});
