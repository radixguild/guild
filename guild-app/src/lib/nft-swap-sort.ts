// Ordering and collection counts for the swap board (GET /api/v1/swaps
// `sort` / `collection`). Pure and isomorphic, like nft-swap.ts: the service
// applies these over the listings it already scanned (at most SWAP_SCAN_CAP),
// and the board's controls import the list of sorts from here.

import { normalizeDecimal, swapStatus, type SwapListing } from "./nft-swap"

export const SWAP_SORTS = ["newest", "ending", "price-asc", "price-desc", "name"] as const
export type SwapSort = (typeof SWAP_SORTS)[number]

export const isSwapSort = (s: unknown): s is SwapSort => typeof s === "string" && (SWAP_SORTS as readonly string[]).includes(s)

/** Radix Decimals have 18 places. */
const DECIMAL_PLACES = 18

/** An exact decimal string as an integer count of 10^-18 units, so two prices
 *  compare exactly (no float on the way). Callers pass a parsed ask's amount
 *  (nft-swap.ts isDecimalString: at most 30 integer and 18 fraction digits). */
export function decimalUnits(amount: string): bigint {
  const [int, frac = ""] = normalizeDecimal(amount).split(".")
  return BigInt(int + frac.padEnd(DECIMAL_PLACES, "0"))
}

/**
 * What a listing asks in XRD: its LOWEST fungible XRD alternative, or null
 * when it asks for no XRD (only other tokens or NFTs). Price sorts use this and
 * nothing else — a listing's token and NFT alternatives have no common unit —
 * so those listings sort last.
 */
export function xrdPrice(l: Pick<SwapListing, "asks">, xrd: string): bigint | null {
  let best: bigint | null = null
  for (const a of l.asks) {
    if (a.kind !== "fungible" || a.resource !== xrd) continue
    const v = decimalUnits(a.amount)
    if (best === null || v < best) best = v
  }
  return best
}

// A fixed locale and options, so the order does not depend on the server's
// environment: "Dino 2" before "Dino 10", case and accents ignored.
const COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" })

/**
 * `listings` in the order `sort` names, as a new array. Every order falls back
 * to newest first (higher listing id first), so it is total and stable.
 *
 *   newest      listing id, highest first
 *   ending      OPEN listings by soonest expiry, then every other listing
 *               (expired, filled, cancelled) newest first
 *   price-asc   lowest XRD ask first; listings with no XRD ask last
 *   price-desc  highest of those lowest XRD asks first; no-XRD last
 *   name        `nameOf` (the name the board shows), A to Z, numbers by value
 */
export function sortSwapListings<L extends SwapListing>(
  listings: readonly L[],
  sort: SwapSort,
  ctx: { ledgerNow: number; xrd: string; nameOf: (l: L) => string },
): L[] {
  const newest = (a: L, b: L) => b.listingId - a.listingId
  const out = [...listings]
  switch (sort) {
    case "newest":
      return out.sort(newest)
    case "ending": {
      const open = new Map(out.map((l) => [l.listingId, swapStatus(l, ctx.ledgerNow) === "open"]))
      return out.sort((a, b) => {
        const ao = open.get(a.listingId)
        const bo = open.get(b.listingId)
        if (ao !== bo) return ao ? -1 : 1
        return (ao ? a.expiresAt - b.expiresAt : 0) || newest(a, b)
      })
    }
    case "price-asc":
    case "price-desc": {
      const sign = sort === "price-asc" ? 1 : -1
      const price = new Map(out.map((l) => [l.listingId, xrdPrice(l, ctx.xrd)]))
      return out.sort((a, b) => {
        const ap = price.get(a.listingId) ?? null
        const bp = price.get(b.listingId) ?? null
        if (ap === null || bp === null) return ap === bp ? newest(a, b) : ap === null ? 1 : -1
        return (ap === bp ? 0 : ap < bp ? -sign : sign) || newest(a, b)
      })
    }
    case "name": {
      const key = new Map(out.map((l) => [l.listingId, ctx.nameOf(l)]))
      return out.sort((a, b) => COLLATOR.compare(key.get(a.listingId)!, key.get(b.listingId)!) || newest(a, b))
    }
  }
}

/** The collections among `listings` and how many listings each holds, most
 *  first (ties by address, so the order is stable). */
export function collectionCounts(listings: readonly Pick<SwapListing, "assetResource">[]): { resource: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const l of listings) counts.set(l.assetResource, (counts.get(l.assetResource) ?? 0) + 1)
  return [...counts]
    .map(([resource, count]) => ({ resource, count }))
    .sort((a, b) => b.count - a.count || (a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0))
}
