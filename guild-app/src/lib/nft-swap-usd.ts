// "≈US$" beside an XRD ask on the swap pages. DISPLAY ONLY: the ask is set and
// paid in XRD, and nothing here reaches a manifest, a sort or a comparison.
//
// The rate is the site's one XRD/USD quote (GET /api/v1/quote/xrd-usd, read by
// useXrdUsd() in use-xrd-usd.tsx), so this adds no price source and no external
// call. Same fail-soft rule as the rest of the site (format-xrd-usd.ts): no
// usable rate, or a stale one, means NO dollar text at all, never a zero or a
// guess. Unlike formatUsdAmount the locale is fixed, so the label is always
// "US$" and never "$" in one browser and "US$" in another.

/** A plain decimal as the chain prints it ("5000", "12.5"); anything else is not priced. */
const PLAIN_DECIMAL = /^\d+(\.\d+)?$/

/** Past this the figure is no longer a price anyone could mean, and a float
 *  would be inventing digits: show nothing rather than a wrong number. */
const MAX_USD = 1e15

const usd = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * "≈US$12.34" for `amountXrd` at `rate` (USD per XRD), "<US$0.01" for a real
 * amount that rounds to zero cents, or null when there is nothing honest to
 * say: no rate, a stale one, a zero or malformed amount, an absurd product.
 */
export function approxUsd(
  amountXrd: string,
  quote: { rate: number | null | undefined; stale?: boolean },
): string | null {
  const { rate, stale = false } = quote
  if (stale || typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null
  if (!PLAIN_DECIMAL.test(amountXrd)) return null
  // A float is fine for the dollar figure (see format-xrd-usd.ts, "WHY THE USD
  // SIDE IS ALLOWED TO USE A FLOAT"): the XRD amount is the money.
  const value = Number(amountXrd) * rate
  if (!Number.isFinite(value) || value <= 0 || value >= MAX_USD) return null
  return value < 0.005 ? "<US$0.01" : `≈US$${usd.format(value)}`
}

const SOURCE_NAME: Record<string, string> = { astrolescent: "Astrolescent", coingecko: "CoinGecko" }

/**
 * The hover text on the dollar figure: what it is, that it is display only,
 * where the rate comes from and how old it is. `ageLabel` is already worded
 * ("3 min"); a source this site does not know is not named.
 */
export function usdTitle(source: string | null | undefined, ageLabel: string | null): string {
  const from = (source && SOURCE_NAME[source]) || "the site's price feed"
  return `Display only: this ask is set and paid in XRD. Estimated from the XRD/USD rate on ${from}${ageLabel ? `, updated ${ageLabel} ago` : ""}.`
}
