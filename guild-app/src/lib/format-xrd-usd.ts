/**
 * format-xrd-usd — the site-wide XRD/USD display standard.
 *
 * Pure and dependency-free (Intl only), safe in both server (RSC) and client
 * code. Every path FAILS OPEN — a missing, zero, or malformed rate degrades to
 * the plain "X XRD" label rather than throwing, so a price-feed outage never
 * blanks a task card.
 *
 * The unit suffix defaults to "XRD" but is a caller-supplied option
 * (`opts.unit`) — see FormatXrdUsdOptions. This exists for the reward-resource
 * flip (XRD → a USD stablecoin at a future escrow component swap): a call
 * site with a task/tx row in scope should pass `unit: row.rewardResource ??
 * "XRD"` rather than assume XRD. The name says "xrd-usd" for history, not
 * because the module is XRD-only.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE STANDARD — two modes, and the default is the safe one.
 *
 *   `exact`   (default) — money the reader ACTS ON: a reward, an insurance
 *                         amount, a bond, a balance, "you will receive". NEVER
 *                         drops a digit. If the chain says 33.333333333333333333
 *                         then that is what renders.
 *
 *   `compact` (opt-in)  — INFORMATIONAL aggregates the reader only eyeballs:
 *                         leaderboard totals, fleet sums, lifetime stats.
 *                         Abbreviates to 3 significant figures with a k/M/B
 *                         suffix ("4.28k XRD").
 *
 * `exact` is the default deliberately. A call site that forgets to pass a mode
 * gets full precision — the failure is verbose, never wrong. Compaction is
 * something you must ASK for, and you only ask for it where no one is going to
 * act on the number.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY exact MODE IS STRING-NATIVE.
 *
 * Radix `Decimal` is 18dp and the DB column is numeric(38,18), so amounts reach
 * this module as strings with up to 18 decimal places. Routing one through a JS
 * number does not merely round it, it INVENTS digits:
 *
 *     Number("33.333333333333333333")  ===  33.333333333333336
 *                                                          ^^ never on the chain
 *
 * So the exact path never parses the fraction. It splits the string, trims
 * trailing zeros (Postgres pads to the column scale, so "100" arrives as
 * "100.000000000000000000"), formats ONLY the integer part through Intl for
 * locale-correct grouping — an XRD integer part cannot approach 2^53, so that
 * is lossless — and re-attaches the fraction digits verbatim.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE USD SIDE IS ALLOWED TO USE A FLOAT.
 *
 * The XRD amount is the money. The USD figure is an INDICATIVE conversion of a
 * third-party price quote that is itself only good to a few significant figures
 * and changes by the minute. Float error there is ~1e-16 relative, i.e. far
 * below the precision the quote itself carries. It is displayed to 2dp and is
 * never the basis of a transaction — no manifest, no ledger row, no comparison
 * reads it. That distinction is the whole reason this is safe here and is NOT
 * safe in escrow-entitlements.ts, which does the same job in BigInt.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SUB-CENT USD NEVER RENDERS "$0.00".
 *
 * At XRD ≈ $0.00095 a 5 XRD insurance is $0.00475, and 2dp formatting turned
 * every amount under ~10.5 XRD into "$0.00" — i.e. the site told users that real
 * escrowed money was worth nothing. Non-zero amounts below a cent now render
 * "<$0.01" (and ">-$0.01" negative). A genuine zero still renders "$0.00",
 * because that one is true.
 */

export type XrdUsdMode = "exact" | "compact";

export interface FormatXrdUsdOptions {
  /** See the module docstring. Defaults to "exact" — the safe direction. */
  mode?: XrdUsdMode;
  /**
   * Hard cap on rendered XRD decimals. Applies to `exact` only (compact has its
   * own significant-figure rule). Omit it unless a layout genuinely cannot fit
   * the digits — capping an actionable amount is the thing this module exists
   * to make deliberate rather than accidental.
   */
  xrdDecimals?: number;
  /**
   * Unit label suffixed onto the amount, e.g. "100 XRD" / "(100 XRD)". Defaults
   * to "XRD" so every pre-flip call site (the only kind that exists today) is
   * unchanged. Reward-resource flip prep: once `tasks.reward_resource` /
   * `escrow_transactions.reward_resource` is non-NULL for a row, pass that
   * value here — never assume XRD for a row you haven't checked. The name
   * stays `unit` rather than `symbol` because a resource address is not
   * guaranteed to have a friendly ticker; callers may pass either.
   */
  unit?: string;
}

/** Amounts arrive as strings from the DB/chain and as numbers from local math. */
export type XrdAmount = number | string;

const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * The locale's decimal separator, discovered once via Intl rather than assumed
 * to be ".". The integer part is grouped by Intl itself, so only this one
 * character has to be re-attached by hand.
 */
function decimalSeparator(): string {
  const parts = new Intl.NumberFormat(undefined).formatToParts(1.1);
  return parts.find((p) => p.type === "decimal")?.value ?? ".";
}

/**
 * Normalise any accepted amount to a plain decimal STRING, or null if it is not
 * one. Numbers are stringified first so a caller passing a float still gets the
 * exact path; exponential notation is rejected rather than guessed at (it can
 * only arrive from a magnitude no XRD amount reaches, or from garbage).
 */
function toDecimalString(amount: XrdAmount): string | null {
  if (typeof amount === "number") {
    if (!Number.isFinite(amount)) return null;
    const s = String(amount);
    return PLAIN_DECIMAL.test(s) ? s : null;
  }
  if (typeof amount !== "string") return null;
  const s = amount.trim();
  return PLAIN_DECIMAL.test(s) ? s : null;
}

/** Group the integer part through Intl; an XRD integer part never nears 2^53. */
function groupInteger(digits: string): string {
  return Number(digits).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/**
 * Exact XRD rendering: every significant digit kept, trailing zeros trimmed.
 * Trimming matters because Postgres pads to the column scale — without it every
 * reward on the site would read "100.000000000000000000".
 */
function formatXrdExact(decimal: string, maxDecimals?: number): string {
  const neg = decimal.startsWith("-");
  const [whole, rawFrac = ""] = (neg ? decimal.slice(1) : decimal).split(".");

  let frac = rawFrac;
  if (maxDecimals !== undefined) frac = frac.slice(0, Math.max(0, maxDecimals));
  frac = frac.replace(/0+$/, "");

  const body = frac ? `${groupInteger(whole)}${decimalSeparator()}${frac}` : groupInteger(whole);
  // "-0" is never a useful label: a value that trims to zero is zero.
  return neg && /[1-9]/.test(whole + frac) ? `-${body}` : body;
}

const COMPACT_TIERS: { limit: number; suffix: string }[] = [
  { limit: 1e9, suffix: "B" },
  { limit: 1e6, suffix: "M" },
  { limit: 1e3, suffix: "k" },
];

/**
 * Compact XRD rendering for informational aggregates: 3 significant figures with
 * a k/M/B suffix above 1,000, and at most 2 decimals below it. Passing through a
 * float is fine HERE and only here — compact output is explicitly approximate,
 * which is what the caller opted into.
 */
function formatXrdCompact(decimal: string): string {
  const n = Number(decimal);
  if (!Number.isFinite(n)) return formatXrdExact(decimal);

  const abs = Math.abs(n);
  for (const { limit, suffix } of COMPACT_TIERS) {
    if (abs >= limit) {
      const scaled = n / limit;
      // 3 significant figures: 4.28k, 30.5k, 105k — never "4.283k".
      const decimals = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
      const shown = scaled.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: decimals,
      });
      return `${shown}${suffix}`;
    }
  }
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * USD label. Returns null when there is no usable rate, which is the fail-open
 * signal the caller turns into an XRD-only string.
 */
function formatUsd(amountXrd: number, rateUsd: number): string | null {
  const usd = amountXrd * rateUsd;
  if (!Number.isFinite(usd)) return null;

  const money = (v: number) =>
    v.toLocaleString(undefined, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  // Non-zero but rounds to zero at 2dp. Saying "$0.00" about real escrowed money
  // is the bug this branch exists to prevent; a true zero falls through.
  if (usd !== 0 && Math.abs(usd) < 0.005) {
    return usd > 0 ? `<${money(0.01)}` : `>-${money(0.01)}`;
  }
  return money(usd);
}

/**
 * Dual XRD/USD label — "$0.10 (100 XRD)", or "100 XRD" when no rate is usable.
 *
 * @param amountXrd Number or decimal string. Strings keep full precision in
 *                  `exact` mode; see the module docstring.
 * @param rateUsd   USD per XRD. Null/zero/negative/non-finite → XRD-only label.
 */
export function formatXrdUsd(
  amountXrd: XrdAmount,
  rateUsd: number | null | undefined,
  opts?: FormatXrdUsdOptions,
): string {
  const decimal = toDecimalString(amountXrd);
  // Unreadable input renders as zero rather than throwing — a malformed amount
  // must not blank a whole card. Matches the previous module's contract.
  const safe = decimal ?? "0";
  const unit = opts?.unit ?? "XRD";

  const xrdStr =
    opts?.mode === "compact" ? formatXrdCompact(safe) : formatXrdExact(safe, opts?.xrdDecimals);

  if (
    rateUsd === null ||
    rateUsd === undefined ||
    typeof rateUsd !== "number" ||
    !Number.isFinite(rateUsd) ||
    rateUsd <= 0
  ) {
    return `${xrdStr} ${unit}`;
  }

  const usdStr = formatUsd(Number(safe), rateUsd);
  return usdStr === null ? `${xrdStr} ${unit}` : `${usdStr} (${xrdStr} ${unit})`;
}

/**
 * String-amount convenience. Identical to {@link formatXrdUsd} — which accepts
 * strings directly — and kept because call sites and tests refer to it by name.
 */
export function formatXrdUsdFromString(
  amount: string,
  rateUsd: number | null | undefined,
  opts?: FormatXrdUsdOptions,
): string {
  return formatXrdUsd(amount, rateUsd, opts);
}

/**
 * XRD-only rendering (exact or compact), no USD — the same 18dp-safe numeric
 * path as {@link formatXrdUsd}, exposed on its own so a caller that wants to
 * lay out the XRD figure and the USD estimate as SEPARATE, independently
 * styled nodes (see `<XrdAmount>`, components/XrdAmount.tsx) doesn't have to
 * re-parse formatXrdUsd's combined string to split them back apart.
 */
export function formatXrdAmount(amountXrd: XrdAmount, opts?: FormatXrdUsdOptions): string {
  const decimal = toDecimalString(amountXrd);
  const safe = decimal ?? "0";
  return opts?.mode === "compact" ? formatXrdCompact(safe) : formatXrdExact(safe, opts?.xrdDecimals);
}

/**
 * USD-only label ("$0.81", "<$0.01"), or null when the rate is unusable —
 * same fail-open contract as {@link formatXrdUsd}. Paired with
 * {@link formatXrdAmount} for callers that render the two figures as
 * separate nodes.
 */
export function formatUsdAmount(
  amountXrd: XrdAmount,
  rateUsd: number | null | undefined,
): string | null {
  if (
    rateUsd === null ||
    rateUsd === undefined ||
    typeof rateUsd !== "number" ||
    !Number.isFinite(rateUsd) ||
    rateUsd <= 0
  ) {
    return null;
  }
  const decimal = toDecimalString(amountXrd);
  const safe = decimal ?? "0";
  return formatUsd(Number(safe), rateUsd);
}
