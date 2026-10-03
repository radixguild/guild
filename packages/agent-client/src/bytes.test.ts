// Adversarial hardening for the hex<->bytes helpers. These back on-chain id /
// key encoding (assertHex is the guard on fixed-width fields), so a silently
// wrong parse is a money-path hazard: an odd-length or non-hex string that
// slips through, or an uppercase address that fails an equality check because
// it was never normalized. Table-driven, each case a real assertion.

import { describe, test, expect } from 'bun:test';
import { isHex, assertHex, hexToBytes, bytesToHex } from './bytes.js';

describe('isHex', () => {
  // [value, byteLength|undefined, expected]
  const CASES: [string, number | undefined, boolean][] = [
    ['', undefined, false], // empty is not hex when no byteLength is pinned
    ['abc', undefined, false], // odd length
    ['gg', undefined, false], // non-hex chars, even length
    ['ABCD', undefined, true], // uppercase accepted
    ['abcd', 2, true], // 4 chars == 2 bytes
    ['abcd', 3, false], // length mismatch against pinned byteLength
    ['0z', undefined, false], // one bad nibble
    ['00', undefined, true], // leading-zero byte still hex
    ['', 0, true], // empty IS valid when byteLength 0 is explicitly pinned
  ];
  for (const [value, byteLength, expected] of CASES) {
    test(`${JSON.stringify(value)} @ byteLength=${byteLength} -> ${expected}`, () => {
      expect(isHex(value, byteLength)).toBe(expected);
    });
  }
});

describe('assertHex', () => {
  test('valid hex is returned lowercased', () => {
    expect(assertHex('ABCD', 2, 'field')).toBe('abcd');
  });

  test('already-lowercase valid hex passes through unchanged', () => {
    expect(assertHex('00ff', 2, 'field')).toBe('00ff');
  });

  test('wrong byte length throws with the expected-chars message', () => {
    expect(() => assertHex('abcd', 3, 'taskId')).toThrow(
      'Invalid taskId: expected 3-byte hex (6 chars)',
    );
  });

  test('non-hex input throws', () => {
    expect(() => assertHex('zzzz', 2, 'field')).toThrow(/Invalid field/);
  });

  test('odd-length input throws', () => {
    expect(() => assertHex('abc', 2, 'field')).toThrow(/Invalid field/);
  });
});

describe('hexToBytes', () => {
  test('empty string throws (not a zero-length array)', () => {
    expect(() => hexToBytes('')).toThrow('Invalid hex string');
  });

  test('odd length throws', () => {
    expect(() => hexToBytes('abc')).toThrow('Invalid hex string');
  });

  test('non-hex throws', () => {
    expect(() => hexToBytes('gg')).toThrow('Invalid hex string');
  });

  test('single byte parses', () => {
    expect(Array.from(hexToBytes('ab'))).toEqual([0xab]);
  });

  test('uppercase parses to the same bytes as lowercase', () => {
    expect(Array.from(hexToBytes('ABCD'))).toEqual([0xab, 0xcd]);
  });

  test('leading-zero byte is preserved', () => {
    expect(Array.from(hexToBytes('00ff'))).toEqual([0x00, 0xff]);
  });
});

describe('bytesToHex', () => {
  test('empty Uint8Array -> empty string', () => {
    expect(bytesToHex(new Uint8Array([]))).toBe('');
  });

  test('each byte is zero-padded to two nibbles', () => {
    expect(bytesToHex(new Uint8Array([0x00, 0x0f, 0xff]))).toBe('000fff');
  });
});

describe('round-trip bytesToHex(hexToBytes(h)) === h.toLowerCase()', () => {
  const HEXES = ['ab', 'ABCD', '00ff', '0011deadbeef', 'ff00', 'deadBEEF'];
  for (const h of HEXES) {
    test(JSON.stringify(h), () => {
      expect(bytesToHex(hexToBytes(h))).toBe(h.toLowerCase());
    });
  }
});
