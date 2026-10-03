// requiredBond (manifests.ts) — the Wave B W4 proportional claim-bond
// formula, ported from the escrow blueprint's `required_bond` (lib.rs) and
// its dependencies `token_divisibility` / `Decimal::checked_mul` /
// `Decimal::checked_round(_, RoundingMode::ToZero)` (radix-common's
// `decimal.rs` / `rounding_mode.rs`, vendored locally and read directly —
// see requiredBond's own doc comment for the exact reasoning).
//
// Every expected value below is computed BY HAND (documented in each test's
// comment) rather than by calling requiredBond a second time with different
// framing — a test that derives its own oracle from the code under test
// cannot catch that code being wrong. Getting the rounding wrong by one unit
// makes every claim revert on-chain (or, in the over-generous direction,
// bonds too much real money) — EXTERNAL-V1-FRAMEWORK P4-5.

import { describe, test, expect } from 'bun:test';
import { requiredBond } from './manifests.js';

describe('requiredBond — floor / cap / pct-in-between', () => {
  test('FLOOR BINDS: raw (10 * 1%) = 0.1 is below floor 1 -> clamps up to the floor', () => {
    expect(requiredBond('10', '0.01', '1', '100', 18)).toBe('1');
  });

  test('CAP BINDS: raw (10000 * 50%) = 5000 is above cap 100 -> clamps down to the cap', () => {
    expect(requiredBond('10000', '0.5', '1', '100', 18)).toBe('100');
  });

  test('PCT IN BETWEEN: raw (200 * 5%) = 10 sits inside [1, 100] -> passes through unclamped', () => {
    expect(requiredBond('200', '0.05', '1', '100', 18)).toBe('10');
  });

  test('floor === cap (a deployed "fixed bond" configuration): both clamp directions land on the same value', () => {
    // raw = 1000 * 0.5 = 500, above cap 5 -> clamps down to 5.
    expect(requiredBond('1000', '0.5', '5', '5', 18)).toBe('5');
    // raw = 1 * 0.001 = 0.001, below floor 5 -> clamps up to 5.
    expect(requiredBond('1', '0.001', '5', '5', 18)).toBe('5');
  });

  test('a plain XRD-shaped case (divisibility 18) — the pre-Wave-B "flat 10" scenario, generalised', () => {
    // raw = 100 * 10% = 10, inside [1, 50].
    expect(requiredBond('100', '0.1', '1', '50', 18)).toBe('10');
  });
});

describe('requiredBond — divisibility truncation (RoundingMode::ToZero, never round-to-nearest)', () => {
  // reward=1, pct=0.123456789 (9dp) -> raw = 1 * 0.123456789 = 0.123456789
  // EXACTLY (multiplying by 1 introduces no truncation of its own — chosen
  // deliberately so the pre-round value is hand-verifiable without doing a
  // BigInt multiplication by hand). floor=0/cap=1 do not bind. A 6-decimal
  // reward token (e.g. a USDC-style stablecoin) can only express 6dp, so the
  // trailing "789" must be DROPPED, not rounded — 789's leading digit (7)
  // would round UP under ordinary "round to nearest", so if this ever came
  // back "0.123457" the rounding mode regressed from ToZero.
  test('6-decimal reward token: 0.123456789 truncates to 0.123456, not 0.123457', () => {
    expect(requiredBond('1', '0.123456789', '0', '1', 6)).toBe('0.123456');
  });

  // reward=8, pct=0.999999999999999999 (18 nines) -> raw = 8*(1 - 10^-18) =
  // 8 - 8*10^-18 = 7.999999999999999992 EXACTLY (worked by hand: rewardAttos
  // = 8*10^18; pctAttos = 10^18 - 1; product/10^18 = 8*10^18 - 8, i.e.
  // 7.999999999999999992 as a Decimal). At divisibility 0 (a whole-number-only
  // token — the "naive product is unrepresentable" case: 18 fractional
  // digits, none of which the token can express), truncating toward zero
  // must give "7". A value THIS close to 8 (off by 8 attos out of 8×10^18)
  // is exactly the case a round-to-nearest implementation would answer "8"
  // instead — the closest possible falsifier for the rounding direction.
  test('divisibility 0 (whole-number token): 7.999999999999999992 truncates to 7, never rounds up to 8', () => {
    expect(requiredBond('8', '0.999999999999999999', '0', '10', 0)).toBe('7');
  });

  test('an exact 18dp value at divisibility 18 needs no truncation at all', () => {
    expect(requiredBond('1', '1.123456789012345678', '0', '2', 18)).toBe('1.123456789012345678');
  });

  test('divisibility 18 does not touch a value that already fits — dropPlaces is 0, a true no-op', () => {
    expect(requiredBond('3', '0.333333333333333333', '0', '10', 18)).toBe('0.999999999999999999');
  });
});

describe('requiredBond — fail-closed input validation', () => {
  test('rejects a negative reward, pct, floor, or cap rather than silently treating it as zero', () => {
    expect(() => requiredBond('-1', '0.1', '0', '10', 18)).toThrow(/non-negative/);
    expect(() => requiredBond('1', '-0.1', '0', '10', 18)).toThrow(/non-negative/);
    expect(() => requiredBond('1', '0.1', '-1', '10', 18)).toThrow(/non-negative/);
    expect(() => requiredBond('1', '0.1', '0', '-10', 18)).toThrow(/non-negative/);
  });

  test.each([-1, 19, 2.5, Number.NaN])('rejects an out-of-range divisibility (%p)', bad => {
    expect(() => requiredBond('1', '0.1', '0', '10', bad as number)).toThrow(/divisibility/);
  });

  test('divisibility 0 and 18 are the accepted boundary values, not off-by-one excluded', () => {
    expect(() => requiredBond('1', '0.1', '0', '10', 0)).not.toThrow();
    expect(() => requiredBond('1', '0.1', '0', '10', 18)).not.toThrow();
  });

  test('a zero reward (an edge, not asserted useful) yields a zero bond before clamping — floor still applies', () => {
    // raw = 0 * pct = 0, below any positive floor -> clamps up to the floor.
    // This documents the clamp firing on the degenerate input; it does not
    // claim a zero-reward task is something create_task would ever accept.
    expect(requiredBond('0', '0.1', '1', '10', 18)).toBe('1');
  });
});
