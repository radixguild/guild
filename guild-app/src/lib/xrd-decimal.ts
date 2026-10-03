// Exact fixed-point arithmetic over 18dp decimal STRINGS — the representation
// this codebase already standardises on for money (see the note on
// escrow_transactions.amount_xrd: Radix `Decimal` is 18dp, and anything that
// round-trips through a JS `number` for a sum or a comparison silently rounds
// or misfires on ties).
//
// Why this module exists rather than reusing `Number()`: the FundingPool
// blueprint spec's own audit-surface notes call out the exact failure mode —
// "the review's §1 float bug (839.42 + 141.78 + 18.80 ≠ 1000 in JS) is an
// app-layer bug" (docs/design/funding-pool-blueprint.md §9) — and requires
// whatever sums contributions to keep the decimal-string convention so the
// app layer cannot disagree with the future on-chain `Decimal`. The
// contribution ledger (funding-state-machine.ts) does exactly the kind of
// repeated add-then-compare-to-target that bug lives in, so it gets its own
// exact arithmetic instead of trusting IEEE-754 doubles.
//
// No external dependency: BigInt scaled to 18dp gives EXACT decimal add/
// subtract/compare for values that fit in a numeric(38,18) column, which is
// the only arithmetic this feature's money path needs (see §9: "no
// multiplication or division anywhere in contribute/refund/finalize").

const SCALE = 18;
// BigInt LITERALS (`0n`) need target ES2020; this app targets ES2017
// (tsconfig.json) — the existing exact-decimal helpers in manifests.ts and
// escrow-entitlements.ts both use the constructor form for the same reason.
// Same convention here rather than a third one.
const ZERO = BigInt(0);
const SCALE_FACTOR = BigInt(10) ** BigInt(SCALE);

/** `^-?\d+(\.\d+)?$` — the shape every numeric(38,18) column round-trips as
 *  through drizzle/pg, and the shape `reward_amount` validation already
 *  requires elsewhere (src/lib/validation.ts). Rejects "1e10", "Infinity",
 *  "NaN", leading "+", empty string — nothing here should ever need them. */
const DECIMAL_STRING_RE = /^-?\d+(\.\d+)?$/;

export class InvalidXrdAmountError extends Error {
  constructor(value: string) {
    super(`Not an exact decimal XRD amount: ${JSON.stringify(value)}`);
    this.name = "InvalidXrdAmountError";
  }
}

function toFixedPoint(value: string): bigint {
  if (!DECIMAL_STRING_RE.test(value)) throw new InvalidXrdAmountError(value);
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, frac = ""] = unsigned.split(".");
  if (frac.length > SCALE) {
    // Radix `Decimal` and this repo's numeric(38,18) columns both cap at
    // 18dp. A caller offering more precision than the chain/DB can hold is a
    // bug upstream (e.g. an unrounded division), not something to silently
    // truncate — truncating here is exactly the "no error, no warning"
    // failure the escrow_transactions.amount_xrd comment warns about.
    throw new InvalidXrdAmountError(value);
  }
  const fracPadded = frac.padEnd(SCALE, "0");
  const magnitude = BigInt(whole) * SCALE_FACTOR + BigInt(fracPadded || "0");
  return negative ? -magnitude : magnitude;
}

function fromFixedPoint(scaled: bigint): string {
  const negative = scaled < ZERO;
  const abs = negative ? -scaled : scaled;
  const whole = abs / SCALE_FACTOR;
  const frac = (abs % SCALE_FACTOR).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return (negative ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

/** a + b, exact. */
export function addXrd(a: string, b: string): string {
  return fromFixedPoint(toFixedPoint(a) + toFixedPoint(b));
}

/** a - b, exact. May return a negative string — callers that mean "remaining
 *  cannot go below zero" must check `compareXrd` themselves; this function
 *  does not clamp, so a bug that subtracts too much is visible, not hidden. */
export function subXrd(a: string, b: string): string {
  return fromFixedPoint(toFixedPoint(a) - toFixedPoint(b));
}

/** -1 if a < b, 0 if a === b (same value, any zero-padding), 1 if a > b. */
export function compareXrd(a: string, b: string): -1 | 0 | 1 {
  const x = toFixedPoint(a);
  const y = toFixedPoint(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export const eqXrd = (a: string, b: string): boolean => compareXrd(a, b) === 0;
export const ltXrd = (a: string, b: string): boolean => compareXrd(a, b) < 0;
export const lteXrd = (a: string, b: string): boolean => compareXrd(a, b) <= 0;
export const gtXrd = (a: string, b: string): boolean => compareXrd(a, b) > 0;
export const gteXrd = (a: string, b: string): boolean => compareXrd(a, b) >= 0;

/** True for a syntactically-valid, strictly positive amount ("0" and
 *  negatives are both false) — the shape every pledge/refund amount must
 *  satisfy before it reaches any arithmetic above. */
export function isPositiveXrd(value: string): boolean {
  try {
    return toFixedPoint(value) > ZERO;
  } catch {
    return false;
  }
}

/** True for a syntactically-valid amount that is >= `min`. TOTAL over `value`
 *  — never throws on it, the same contract as `isPositiveXrd` and for the same
 *  reason: it is called from zod `.refine()` predicates, and zod 4 runs a
 *  refinement even when an earlier check (the shape regex) already failed, so
 *  a predicate can be handed "abc" — and a throw there escapes `safeParse` as
 *  a 500 instead of a 400. (validation.ts's reward schema also re-tests the
 *  shape before calling this, so there it is the second line of defence, not
 *  the first.) `min` is a repo constant, not input: a malformed one is a
 *  programmer error and throws, loudly, rather than rejecting every amount. */
export function isAtLeastXrd(value: string, min: string): boolean {
  const floor = toFixedPoint(min);
  try {
    return toFixedPoint(value) >= floor;
  } catch {
    return false;
  }
}

/** Normalises a decimal string to its canonical form (no trailing zeros, no
 *  leading zeros, "-0" collapsed to "0") — useful for asserting two strings
 *  denote the same value without going through `compareXrd` at call sites
 *  that want a string back, e.g. for storage. */
export function normalizeXrd(value: string): string {
  return fromFixedPoint(toFixedPoint(value));
}

/** Ceiling of `value * fraction`, rounded UP to `decimals` places (default 0
 *  — whole XRD), computed entirely in scaled BigInt — `value` never passes
 *  through `Number()`. This is the fix for the insurance-figure bug: `value`
 *  is a user-supplied amount at up to 18dp (xrdAmountSchema's full range),
 *  and `Number(value)` loses precision above ~15-17 significant digits
 *  *before* any multiply happens, silently deriving the result from an
 *  already-rounded input. `fraction` is expected to be a small fixed
 *  in-repo constant (e.g. FUNDING_INSURANCE_FRACTION, converted with
 *  `String(...)`) rather than user input — for a literal like 0.05 that
 *  round-trips through `Number.prototype.toString()` exactly, so no
 *  precision is lost converting it to a string either.
 *
 *  Both operands are scaled to 18dp (`toFixedPoint`), so their product is
 *  scaled to 36dp; dividing by `10^(36 - decimals)` with a manual
 *  remainder-check ceiling (never `Math.ceil`, which would re-introduce a
 *  float) gives the exact answer at the requested precision. */
export function ceilXrdMultiple(value: string, fraction: string, decimals = 0): string {
  if (decimals < 0 || decimals > SCALE) {
    throw new RangeError(`decimals must be between 0 and ${SCALE}`);
  }
  const scaledValue = toFixedPoint(value); // value * 10^18
  const scaledFraction = toFixedPoint(fraction); // fraction * 10^18
  const product = scaledValue * scaledFraction; // value * fraction * 10^36
  const divisor = BigInt(10) ** BigInt(2 * SCALE - decimals);
  let quotient = product / divisor;
  const remainder = product % divisor;
  // BigInt division truncates toward zero; for non-negative operands (every
  // real XRD amount and fraction this function is ever called with) that IS
  // floor, so a nonzero remainder means the true value has a fractional part
  // still to be rounded up.
  if (remainder > ZERO) quotient += BigInt(1);
  return fromFixedPoint(quotient * BigInt(10) ** BigInt(SCALE - decimals));
}
