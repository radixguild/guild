import { describe, it, expect } from 'vitest'
import { formatXrdUsd, formatXrdUsdFromString } from '@/lib/format-xrd-usd'

// Locale-stable expectation helpers — mirror the formatter's own Intl options so
// assertions hold under any test-runner locale (same technique as
// lib-marketplace-utils.test.ts).
const xrd = (n: number, max = 20) =>
  n.toLocaleString(undefined, { maximumFractionDigits: max })
const usd = (n: number) =>
  n.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
/** The locale's decimal separator, so precision assertions are not en-US-only. */
const DEC = (1.1).toLocaleString(undefined).replace(/1/g, '')

describe('lib/format-xrd-usd', () => {
  describe('formatXrdUsd — fail-open contract', () => {
    it('null rate → "X XRD" (fail open)', () => {
      expect(formatXrdUsd(1000, null)).toBe(`${xrd(1000)} XRD`)
    })

    it('undefined rate → "X XRD" (fail open)', () => {
      expect(formatXrdUsd(100, undefined)).toBe(`${xrd(100)} XRD`)
    })

    it('valid rate → "$Y (X XRD)"', () => {
      expect(formatXrdUsd(100, 0.05)).toBe(`${usd(5)} (${xrd(100)} XRD)`)
    })

    it('formats zero with null rate', () => {
      expect(formatXrdUsd(0, null)).toBe(`${xrd(0)} XRD`)
    })

    it('formats zero with a valid rate', () => {
      expect(formatXrdUsd(0, 0.05)).toBe(`${usd(0)} (${xrd(0)} XRD)`)
    })

    it('NaN amount is guarded → treated as 0', () => {
      expect(formatXrdUsd(NaN, 0.05)).toBe(`${usd(0)} (${xrd(0)} XRD)`)
    })

    it('Infinity amount is guarded → treated as 0', () => {
      expect(formatXrdUsd(Infinity, null)).toBe(`${xrd(0)} XRD`)
    })

    it('rate <= 0 fails open (zero)', () => {
      expect(formatXrdUsd(100, 0)).toBe(`${xrd(100)} XRD`)
    })

    it('rate <= 0 fails open (negative)', () => {
      expect(formatXrdUsd(100, -1)).toBe(`${xrd(100)} XRD`)
    })

    it('non-finite rate fails open (NaN)', () => {
      expect(formatXrdUsd(100, NaN)).toBe(`${xrd(100)} XRD`)
    })

    it('non-finite rate fails open (Infinity)', () => {
      expect(formatXrdUsd(100, Infinity)).toBe(`${xrd(100)} XRD`)
    })

    it('never throws on garbage input', () => {
      expect(() =>
        // @ts-expect-error — exercising runtime robustness
        formatXrdUsd('not-a-number', 'also-bad'),
      ).not.toThrow()
    })
  })

  /**
   * EXACT MODE — the default, and the one that renders money someone acts on.
   * The rule is that it never drops a digit that was in the source.
   */
  describe('formatXrdUsd — exact mode (default)', () => {
    it('preserves sub-1 precision', () => {
      expect(formatXrdUsd(0.123456, null)).toBe(`${xrd(0.123456)} XRD`)
    })

    it('preserves fractional precision in [1, 1000)', () => {
      expect(formatXrdUsd(12.3456, null)).toBe(`${xrd(12.3456)} XRD`)
    })

    it('does NOT round large fractional amounts (display-parity guard)', () => {
      // Regression guard: an older magnitude-bucket formatter rounded >=1000 to
      // 0dp, so a 1500.5 XRD reward rendered "1,501 XRD". It must keep the .5.
      expect(formatXrdUsd(1500.5, null)).toBe(`${xrd(1500.5)} XRD`)
      expect(formatXrdUsd(1500.5, null)).not.toBe('1,501 XRD')
    })

    /**
     * The reason exact mode is string-native. Radix `Decimal` is 18dp and the DB
     * column is numeric(38,18), so this is a shape real amounts arrive in — and
     * Number() does not merely round it, it INVENTS digits:
     * Number("33.333333333333333333") === 33.333333333333336.
     */
    it('renders all 18 decimal places of a chain amount without inventing any', () => {
      const out = formatXrdUsd('33.333333333333333333', null)
      expect(out).toBe(`33${DEC}333333333333333333 XRD`)
      // The float round-trip's signature digits, which must appear nowhere.
      expect(out).not.toContain('333333333333336')
    })

    it('trims the zero padding Postgres adds to the column scale', () => {
      // numeric(38,18) returns "100" as "100.000000000000000000". Rendering that
      // verbatim would put twenty characters of noise on every task card.
      expect(formatXrdUsd('100.000000000000000000', null)).toBe(`${xrd(100)} XRD`)
      expect(formatXrdUsd('1500.500000000000000000', null)).toBe(`${xrd(1500.5)} XRD`)
    })

    it('groups the integer part of a long exact string', () => {
      expect(formatXrdUsd('1234567.5', null)).toBe(`${xrd(1234567.5)} XRD`)
    })

    it('negative amount is preserved (null rate)', () => {
      expect(formatXrdUsd(-5, null)).toBe(`${xrd(-5)} XRD`)
    })

    it('negative amount with a valid rate', () => {
      expect(formatXrdUsd(-5, 0.05)).toBe(`${usd(-0.25)} (${xrd(-5)} XRD)`)
    })

    it('a value whose digits are all zero never renders as "-0"', () => {
      expect(formatXrdUsd('-0.000000000000000000', null)).toBe(`${xrd(0)} XRD`)
    })

    /**
     * `xrdDecimals` TRUNCATES rather than rounding, deliberately. Its only caller
     * is the mint page's account balance, and showing someone more than they hold
     * is worse than showing less. (The previous module rounded here: 1234.56 at 0
     * decimals rendered "1,235".)
     */
    it('xrdDecimals truncates toward zero — never overstates the amount', () => {
      expect(formatXrdUsd(1234.56, null, { xrdDecimals: 0 })).toBe(`${xrd(1234)} XRD`)
      expect(formatXrdUsd(1234.56, null, { xrdDecimals: 0 })).not.toBe('1,235 XRD')
      expect(formatXrdUsd('9.999999', null, { xrdDecimals: 4 })).toBe(`9${DEC}9999 XRD`)
    })
  })

  /**
   * SUB-CENT USD — at XRD ~= $0.00095 a 5 XRD insurance is $0.00475, and plain
   * 2dp formatting rendered every amount under ~10.5 XRD as "$0.00": the site
   * told users that real escrowed money was worth nothing.
   */
  describe('formatXrdUsd — USD never claims real money is $0.00', () => {
    const RATE = 0.000955

    it('a 5 XRD insurance renders "<$0.01", not "$0.00"', () => {
      const out = formatXrdUsd(5, RATE)
      expect(out).toBe(`<${usd(0.01)} (${xrd(5)} XRD)`)
      expect(out).not.toContain(usd(0))
    })

    it('a 10 XRD claim bond renders a real cent, and does NOT get a spurious "<"', () => {
      // 10 * 0.000955 = $0.00955, which rounds UP to $0.01 at 2dp. So this is a
      // true value, not a floored one, and the "<" prefix would be a lie here.
      // The line between the two branches is 0.005, not 0.01.
      expect(formatXrdUsd(10, RATE)).toBe(`${usd(0.00955)} (${xrd(10)} XRD)`)
      expect(formatXrdUsd(10, RATE)).not.toContain('<')
    })

    it('a genuine zero still renders $0.00 — that one is true', () => {
      expect(formatXrdUsd(0, RATE)).toBe(`${usd(0)} (${xrd(0)} XRD)`)
    })

    it('a negative sub-cent amount renders ">-$0.01"', () => {
      expect(formatXrdUsd(-5, RATE)).toBe(`>-${usd(0.01)} (${xrd(-5)} XRD)`)
    })

    it('at or above a cent it formats normally', () => {
      // 100 XRD * 0.000955 = $0.0955 -> renders $0.10, comfortably above the floor.
      expect(formatXrdUsd(100, RATE)).toBe(`${usd(0.0955)} (${xrd(100)} XRD)`)
    })

    it('the boundary rounds rather than flooring — 0.005 is not "<$0.01"', () => {
      // Exactly half a cent rounds UP to $0.01 under 2dp formatting, so the
      // "<" branch must not claim it. The guard is < 0.005, not < 0.01.
      expect(formatXrdUsd(0.005, 1)).toBe(`${usd(0.005)} (${xrd(0.005)} XRD)`)
      expect(formatXrdUsd(0.005, 1)).not.toContain('<')
    })
  })

  /**
   * COMPACT MODE — informational aggregates only (leaderboard totals, lifetime
   * stats). Explicitly approximate, which is what the caller opted into.
   */
  describe('formatXrdUsd — compact mode', () => {
    const c = { mode: 'compact' as const }

    it('abbreviates thousands to 3 significant figures', () => {
      expect(formatXrdUsd(4282.57, null, c)).toBe('4.28k XRD')
      expect(formatXrdUsd(30500, null, c)).toBe('30.5k XRD')
      expect(formatXrdUsd(105000, null, c)).toBe('105k XRD')
    })

    it('abbreviates millions and billions', () => {
      expect(formatXrdUsd(1500000, null, c)).toBe('1.5M XRD')
      expect(formatXrdUsd(2400000000, null, c)).toBe('2.4B XRD')
    })

    it('leaves values below 1,000 unabbreviated, capped at 2dp', () => {
      expect(formatXrdUsd(610, null, c)).toBe('610 XRD')
      expect(formatXrdUsd(12.3456, null, c)).toBe(`12${DEC}35 XRD`)
    })

    it('still pairs with a USD label', () => {
      expect(formatXrdUsd(4282.57, 0.000955, c)).toBe(`${usd(4.0898)} (4.28k XRD)`)
    })

    it('handles negatives', () => {
      expect(formatXrdUsd(-4282.57, null, c)).toBe('-4.28k XRD')
    })
  })

  /**
   * The safety property of the whole design: a call site that forgets to choose
   * gets full precision. Compaction has to be ASKED for, so no one rounds an
   * actionable amount by omission.
   */
  describe('formatXrdUsd — exact is the default', () => {
    it('omitting opts is exact, not compact', () => {
      expect(formatXrdUsd(4282.57, null)).toBe(`${xrd(4282.57)} XRD`)
      expect(formatXrdUsd(4282.57, null)).not.toContain('k')
    })

    it('an empty opts object is exact', () => {
      expect(formatXrdUsd(4282.57, null, {})).toBe(`${xrd(4282.57)} XRD`)
    })

    it('an unrecognised mode falls back to exact, never to compact', () => {
      // @ts-expect-error — a bad mode must degrade to full precision
      expect(formatXrdUsd(4282.57, null, { mode: 'tiny' })).toBe(`${xrd(4282.57)} XRD`)
    })
  })

  /**
   * REWARD-RESOURCE FLIP PREP — `opts.unit` replaces the previously-hardcoded
   * "XRD" suffix. Every pre-flip call site omits it and must render byte-for-
   * byte identical to before (that is the point of defaulting to "XRD"); a
   * call site with a task/tx row's `rewardResource` in scope passes it through.
   */
  describe('formatXrdUsd — opts.unit (reward-resource flip prep)', () => {
    it('omitted unit defaults to "XRD" — every existing call site is unchanged', () => {
      expect(formatXrdUsd(100, null)).toBe(`${xrd(100)} XRD`)
      expect(formatXrdUsd(100, 0.05)).toBe(`${usd(5)} (${xrd(100)} XRD)`)
    })

    it('a non-XRD unit replaces the suffix, XRD-only branch', () => {
      expect(formatXrdUsd(100, null, { unit: 'USDC' })).toBe(`${xrd(100)} USDC`)
    })

    it('a non-XRD unit replaces the suffix inside the dual USD/XRD label', () => {
      expect(formatXrdUsd(100, 0.05, { unit: 'USDC' })).toBe(`${usd(5)} (${xrd(100)} USDC)`)
    })

    it('unit composes with compact mode', () => {
      expect(formatXrdUsd(4282.57, null, { mode: 'compact', unit: 'USDC' })).toBe('4.28k USDC')
    })

    it('unit composes with xrdDecimals', () => {
      expect(formatXrdUsd(1234.56, null, { xrdDecimals: 0, unit: 'USDC' })).toBe(`${xrd(1234)} USDC`)
    })

    it('an explicit "XRD" unit is identical to omitting it', () => {
      expect(formatXrdUsd(100, 0.05, { unit: 'XRD' })).toBe(formatXrdUsd(100, 0.05))
    })

    it('formatXrdUsdFromString forwards unit too', () => {
      expect(formatXrdUsdFromString('100', null, { unit: 'USDC' })).toBe(`${xrd(100)} USDC`)
    })
  })

  describe('formatXrdUsdFromString', () => {
    it('parses a numeric string with a valid rate', () => {
      expect(formatXrdUsdFromString('100', 0.05)).toBe(`${usd(5)} (${xrd(100)} XRD)`)
    })

    it('null rate → "X XRD"', () => {
      expect(formatXrdUsdFromString('1000', null)).toBe(`${xrd(1000)} XRD`)
    })

    it('preserves a fractional string amount', () => {
      expect(formatXrdUsdFromString('1500.5', null)).toBe(`${xrd(1500.5)} XRD`)
    })

    it('non-numeric string is guarded → treated as 0', () => {
      expect(formatXrdUsdFromString('abc', null)).toBe(`${xrd(0)} XRD`)
    })

    it('accepts compact mode too', () => {
      expect(formatXrdUsdFromString('4282.57', null, { mode: 'compact' })).toBe('4.28k XRD')
    })
  })
})
