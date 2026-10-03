import {
  formatUsdAmount,
  formatXrdAmount,
  type FormatXrdUsdOptions,
  type XrdAmount as XrdAmountValue,
} from "@/lib/format-xrd-usd"

/**
 * <XrdAmount> — the site-wide XRD/USD display primitive.
 *
 * Board note M5 (2026-09-03), ruling R1: XRD is the unit of account AND the
 * settlement asset. USD is DISPLAY ONLY, never the promise. This component is
 * how that ruling reaches the screen:
 *   - the XRD figure is always the headline text ("1,234 XRD");
 *   - a muted "≈ $0.81" is an ADDITIONAL, visually secondary estimate, never
 *     the other way around, and never rendered alone;
 *   - it disappears the moment the underlying quote is stale or unusable —
 *     a caller of this component can never end up showing a dollar number
 *     with no marker for how old (or how absent) the rate behind it is.
 *
 * Deliberately pure/presentational: no "use client", no data fetching, no
 * state. Every caller passes in what it already has from `useXrdUsd()` (see
 * src/lib/use-xrd-usd.tsx) — or, for a leaf that must also render as a
 * Server Component (TaskCard), from a parent that read the hook and threaded
 * the values down as props. That mirrors TaskCard's existing `usdRate` prop
 * contract; this component just adds the staleness fields to the same shape.
 *
 * The tooltip is a plain HTML `title` attribute, not client JS — cheap,
 * works with no hydration, and gives assistive tech something to announce.
 * It also means its wording is scanned by the honest-copy gate
 * (scripts/honest-copy.mjs CHECK 4, which reads `title=""` on prerendered
 * pages) on every cold-user route this renders on, so it is held to the same
 * house rule as the rest of the site's copy: never imply the USD figure is
 * anything but a display-only estimate, and never call it "USD-priced" or a
 * "stable" price — it is a third-party quote, not a promise.
 */
export interface XrdAmountProps {
  /** Number or decimal string — see format-xrd-usd.ts's module doc for why
   *  strings keep full precision on 18dp Radix `Decimal` amounts. */
  amountXrd: XrdAmountValue
  /** USD per XRD. Null/undefined/non-finite/<=0 → XRD-only, same fail-open
   *  contract as formatXrdUsd. */
  usdRate?: number | null
  /** True when the quote backing `usdRate` is older than the site's 30-min
   *  staleness bar (GET /api/v1/quote/xrd-usd's `stale` field). When true,
   *  the USD suffix is suppressed even if `usdRate` is a normal-looking
   *  number — a stale rate must never render as if it were live. */
  stale?: boolean
  /** Age of the underlying price in seconds (the route's `age_seconds`),
   *  folded into the tooltip. Omit/null when unknown. */
  ageSeconds?: number | null
  /** Where the rate came from ("astrolescent" | "coingecko"), folded into
   *  the tooltip. Omit/null when unknown. */
  source?: string | null
  /** Reward-resource label. Defaults to "XRD". When a task's `reward_resource`
   *  is something else (the Wave B reward_token path), the amount is shown in
   *  that unit and NO USD suffix is rendered — `usdRate` is an XRD/USD rate and
   *  prices nothing but XRD. Same contract as formatXrdUsd's `opts.unit`. */
  unit?: string
  mode?: FormatXrdUsdOptions["mode"]
  xrdDecimals?: number
  className?: string
}

/** "moments" / "12 min" / "3h 5m" — coarse on purpose, this is tooltip
 *  copy, not a stopwatch. */
function formatAge(ageSeconds: number | null | undefined): string | null {
  if (typeof ageSeconds !== "number" || !Number.isFinite(ageSeconds) || ageSeconds < 0) {
    return null
  }
  if (ageSeconds < 60) return "moments"
  const minutes = Math.floor(ageSeconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`
}

export function XrdAmount({
  amountXrd,
  usdRate,
  stale = false,
  ageSeconds = null,
  source = null,
  unit = "XRD",
  mode,
  xrdDecimals,
  className,
}: XrdAmountProps) {
  const xrdStr = formatXrdAmount(amountXrd, { mode, xrdDecimals })
  const isXrd = unit === "XRD"
  // A stale quote never reaches formatUsdAmount at all — belt and braces on
  // top of formatUsdAmount's own null-rate fail-open, so a caller cannot
  // accidentally show a dollar figure by forgetting to check `stale` first.
  // A non-XRD unit never reaches it either: the rate is XRD/USD.
  const usdStr = stale || !isXrd ? null : formatUsdAmount(amountXrd, usdRate)
  const ageLabel = formatAge(ageSeconds)
  const sourceLabel = source ?? "the price feed"

  const title = !isXrd
    ? `Priced and settled in ${unit}. The XRD/USD rate does not apply to this reward.`
    : usdStr
      ? `Display only — tasks are priced and settled in XRD; rate from ${sourceLabel}` +
        `${ageLabel ? `, ${ageLabel} ago` : ""}.`
      : usdRate != null
        ? `USD unavailable — the ${sourceLabel} rate is too old to show` +
          `${ageLabel ? ` (${ageLabel} old)` : ""}. Tasks are priced and settled in XRD.`
        : "USD unavailable. Tasks are priced and settled in XRD."

  return (
    <span className={className} title={title}>
      {xrdStr} {unit}
      {usdStr && <span className="text-muted-foreground"> &#8776; {usdStr}</span>}
    </span>
  )
}
