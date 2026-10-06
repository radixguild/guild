// The guild-nft-swap component, modelled for the app (P7-03 / P7-04).
//
// Pure and isomorphic: no fetch, no React. The Gateway readers live in
// nft-swap-gateway.ts, the manifest builders in manifests.ts.
//
// THE CHAIN IS THE RECORD. The design note's §6 sketched a `swap_listings`
// table mirroring the tasks pattern. This app reads the component instead:
// every field a listing has is on chain (escrow/scrypto/guild-marketplace-
// escrow/src/nft_swap.rs, `Listing`), nothing a swap needs is off chain, and a
// DB copy would bring the one failure class the task board keeps paying for —
// a row that lags the ledger (lost confirms, `[unreconcilable]`, a cancel that
// reads the wrong phase). There is no confirm endpoint and no row to heal. A
// listing made by hand-built manifest shows up exactly like one made here.
// The trigger to add an index is volume: `readSwapListings` scans every id,
// capped at SWAP_SCAN_CAP.
//
// Shapes below were read off mainnet 2026-10-06 (listings 1 and 2 on
// component_rdx1cq80zarwh84mmrkn95xc7glgg5yvz0vkvqs9amxsnpwxuhkldd5mp4).

/** One alternative the seller accepts (blueprint `Ask`). Amounts are exact
 *  decimal STRINGS — money, never a JS number. */
export type SwapAsk =
  | { kind: "fungible"; resource: string; amount: string }
  | { kind: "nonFungible"; resource: string; id: string }

/** Blueprint `ListingState`. */
export type SwapListingState = "Listed" | "Filled" | "Cancelled"

/** A listing as the component stores it. Times are unix seconds (`Instant`). */
export interface SwapListing {
  listingId: number
  /** The account pinned at `list` — the only place `withdraw_proceeds` pays. */
  seller: string
  assetResource: string
  assetId: string
  /** ≥ 1 alternatives; the buyer fills exactly one, by index. */
  asks: SwapAsk[]
  createdAt: number
  expiresAt: number
  state: SwapListingState
  /** Index into `asks` of the alternative that filled it. Set iff Filled. */
  filledWith: number | null
  proceedsWithdrawn: boolean
}

/** What a reader sees. `expired` is a Listed listing past its expiry: it can
 *  no longer be filled, only cancelled or extended. */
export type SwapStatus = "open" | "expired" | "filled" | "cancelled"

export const SWAP_STATUSES: readonly SwapStatus[] = ["open", "expired", "filled", "cancelled"]

/** S2: `list` refuses an expiry more than 30 days out, and one
 *  `extend_listing` call adds exactly this much. nft_swap.rs THIRTY_DAYS_SECS. */
export const MAX_LISTING_HORIZON_SECS = 30 * 24 * 60 * 60

/** How far below the 30-day ceiling a 30-day listing is built. The ceiling is
 *  measured from the ledger clock when the transaction EXECUTES, and the
 *  expiry is computed from a ledger time read a little earlier — so a pick of
 *  exactly 30 days is pulled in by ten minutes rather than risk the revert. */
export const EXPIRY_CEILING_MARGIN_SECS = 10 * 60

/** The most alternatives the list form offers. The blueprint sets no limit;
 *  each one is a few hundred bytes of manifest and fee. */
export const MAX_ASKS = 5

/** Listing ids scanned per page view. Past this the reader says so
 *  (`truncated`) instead of silently dropping the oldest listings. */
export const SWAP_SCAN_CAP = 1000

const RESOURCE_RE = /^resource_rdx1[a-z0-9]{20,}$/
const ACCOUNT_RE = /^account_rdx1[a-z0-9]{20,}$/
// The four NonFungibleLocalId forms, bounded (string ids are ≤ 64 chars,
// bytes ≤ 64 bytes on Radix). Same whitelist as manifests.ts validateLocalId.
const LOCAL_ID_RE =
  /^(#\d{1,20}#|<[A-Za-z0-9_]{1,64}>|\[[0-9a-fA-F]{2,128}\]|\{[0-9a-fA-F]{16}-[0-9a-fA-F]{16}-[0-9a-fA-F]{16}-[0-9a-fA-F]{16}\})$/
const DECIMAL_RE = /^\d{1,30}(\.\d{1,18})?$/

export const isResourceAddress = (s: unknown): s is string => typeof s === "string" && RESOURCE_RE.test(s)
export const isAccountAddress = (s: unknown): s is string => typeof s === "string" && ACCOUNT_RE.test(s)
export const isLocalId = (s: unknown): s is string => typeof s === "string" && LOCAL_ID_RE.test(s)
export const isDecimalString = (s: unknown): s is string => typeof s === "string" && DECIMAL_RE.test(s)

// ── Parsing the Gateway's programmatic JSON ─────────────────────────────────

type Field = { field_name?: string; value?: unknown; variant_name?: string; fields?: unknown; elements?: unknown }

function field(fields: Field[], name: string): Field | undefined {
  return fields.find((f) => f?.field_name === name)
}

function instantSecs(f: Field | undefined): number | null {
  const n = typeof f?.value === "string" ? Number(f.value) : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function parseAsk(el: unknown): SwapAsk | null {
  const e = el as Field
  const inner = Array.isArray(e?.fields) ? (e.fields as Field[]) : null
  if (!inner) return null
  const resource = field(inner, "resource")?.value
  if (!isResourceAddress(resource)) return null
  if (e.variant_name === "Fungible") {
    const amount = field(inner, "amount")?.value
    return isDecimalString(amount) ? { kind: "fungible", resource, amount } : null
  }
  if (e.variant_name === "NonFungible") {
    const id = field(inner, "id")?.value
    return isLocalId(id) ? { kind: "nonFungible", resource, id } : null
  }
  return null
}

/**
 * Parse one `Listing` KVS value (`entries[].value.programmatic_json`). Fails
 * closed: any field outside the blueprint's shape returns null — the caller
 * shows "could not read", never a guess. A listing with one unreadable
 * alternative is unreadable as a whole, because the alternative INDEX is what
 * a fill names, and a dropped element would shift every index after it.
 */
export function parseSwapListing(listingId: number, json: unknown): SwapListing | null {
  const fields = (json as { fields?: unknown })?.fields
  if (!Array.isArray(fields)) return null
  const fs = fields as Field[]

  const seller = field(fs, "seller")?.value
  const assetResource = field(fs, "asset_resource")?.value
  const assetId = field(fs, "asset_id")?.value
  if (!isAccountAddress(seller) || !isResourceAddress(assetResource) || !isLocalId(assetId)) return null

  const elements = field(fs, "asks")?.elements
  if (!Array.isArray(elements) || elements.length === 0) return null
  const asks: SwapAsk[] = []
  for (const el of elements) {
    const ask = parseAsk(el)
    if (!ask) return null
    asks.push(ask)
  }

  const createdAt = instantSecs(field(fs, "created_at"))
  const expiresAt = instantSecs(field(fs, "expires_at"))
  if (createdAt === null || expiresAt === null) return null

  const stateName = field(fs, "state")?.variant_name
  if (stateName !== "Listed" && stateName !== "Filled" && stateName !== "Cancelled") return null

  const fw = field(fs, "filled_with")
  let filledWith: number | null = null
  if (fw?.variant_name === "Some") {
    const v = Array.isArray(fw.fields) ? Number((fw.fields as Field[])[0]?.value) : NaN
    if (!Number.isInteger(v) || v < 0 || v >= asks.length) return null
    filledWith = v
  } else if (fw?.variant_name !== "None") {
    return null
  }
  // The blueprint sets filled_with exactly when it sets Filled.
  if ((stateName === "Filled") !== (filledWith !== null)) return null

  const pw = field(fs, "proceeds_withdrawn")?.value
  // SBOR bools have been seen as both the literal and the string (gateway.ts
  // claimer_is_agent); anything else is not a bool.
  const proceedsWithdrawn = pw === true || pw === "true" ? true : pw === false || pw === "false" ? false : null
  if (proceedsWithdrawn === null) return null

  return {
    listingId,
    seller,
    assetResource,
    assetId,
    asks,
    createdAt,
    expiresAt,
    state: stateName,
    filledWith,
    proceedsWithdrawn,
  }
}

// ── Reading a listing ───────────────────────────────────────────────────────

/** `ledgerNow` is the Gateway's ledger clock (seconds) — the clock `fill`
 *  checks expiry against — not the browser's. `fill` asserts now < expires_at. */
export function swapStatus(listing: SwapListing, ledgerNow: number): SwapStatus {
  if (listing.state === "Filled") return "filled"
  if (listing.state === "Cancelled") return "cancelled"
  return ledgerNow < listing.expiresAt ? "open" : "expired"
}

/** A Filled listing whose payment still sits in the component. */
export const proceedsOwed = (l: SwapListing): boolean => l.state === "Filled" && !l.proceedsWithdrawn

/** `burn_listing_receipt` refuses while Listed and while proceeds are owed. */
export const receiptBurnable = (l: SwapListing): boolean =>
  l.state === "Cancelled" || (l.state === "Filled" && l.proceedsWithdrawn)

/** The alternative that filled the listing, or null. */
export const filledAsk = (l: SwapListing): SwapAsk | null =>
  l.filledWith === null ? null : (l.asks[l.filledWith] ?? null)

/** `extend_listing`'s new expiry: max(now, current) + 30 days. */
export const extendedExpiry = (l: SwapListing, ledgerNow: number): number =>
  Math.max(ledgerNow, l.expiresAt) + MAX_LISTING_HORIZON_SECS

/** The receipt's local id is the listing id (nft_swap.rs `list`). */
export const receiptLocalId = (listingId: number): string => `#${listingId}#`

// ── Building a listing ──────────────────────────────────────────────────────

/** An expiry `days` days after `ledgerNow`, inside the 30-day ceiling. */
export function expiryForDays(ledgerNow: number, days: number): number {
  const d = Math.min(Math.max(Math.floor(days), 1), 30)
  return Math.min(
    ledgerNow + d * 24 * 60 * 60,
    ledgerNow + MAX_LISTING_HORIZON_SECS - EXPIRY_CEILING_MARGIN_SECS,
  )
}

/** "5000.50" → "5000.5", "1.000" → "1", "0.0" → "0". The blueprint compares
 *  Decimals by value, so these spell the same ask. */
export function normalizeDecimal(s: string): string {
  if (!s.includes(".")) return s.replace(/^0+(?=\d)/, "")
  const [i, f] = s.split(".")
  const int = i.replace(/^0+(?=\d)/, "")
  const frac = f.replace(/0+$/, "")
  return frac ? `${int}.${frac}` : int
}

/** Equality the way the blueprint's duplicate check sees it. */
export function sameAsk(a: SwapAsk, b: SwapAsk): boolean {
  if (a.kind !== b.kind || a.resource !== b.resource) return false
  if (a.kind === "fungible" && b.kind === "fungible") return normalizeDecimal(a.amount) === normalizeDecimal(b.amount)
  if (a.kind === "nonFungible" && b.kind === "nonFungible") return a.id === b.id
  return false
}

export type AskProblem =
  | "bad_resource"
  | "not_fungible"
  | "not_non_fungible"
  | "bad_amount"
  | "zero_amount"
  | "too_precise"
  | "bad_id"
  | "duplicate"
  | "same_as_asset"

/** What the list form knows about an ask's resource, read LIVE from the
 *  Gateway (readResourceDisplay) — never assumed. */
export type AskResourceKind = { kind: "fungible"; divisibility: number } | { kind: "nonFungible" }

/**
 * The blueprint's `list` checks, run before the wallet opens so a typo costs
 * nothing: positive amount, within the resource's divisibility, no duplicate
 * alternatives. Two more the chain does NOT make, each of which would mint a
 * listing nobody can ever fill: a non-fungible ask naming a fungible resource
 * (`fill` takes the payment `as_non_fungible`), and an ask for the very NFT
 * being listed. An unknown resource (`kindOf` → null) is "bad_resource".
 */
export function askProblems(
  asks: SwapAsk[],
  kindOf: (resource: string) => AskResourceKind | null,
  asset?: { resource: string; id: string },
): (AskProblem | null)[] {
  return asks.map((ask, i) => {
    if (!isResourceAddress(ask.resource)) return "bad_resource"
    const info = kindOf(ask.resource)
    if (!info) return "bad_resource"
    if (ask.kind === "fungible") {
      if (info.kind !== "fungible") return "not_fungible"
      if (!isDecimalString(ask.amount)) return "bad_amount"
      if (normalizeDecimal(ask.amount) === "0") return "zero_amount"
      const frac = normalizeDecimal(ask.amount).split(".")[1] ?? ""
      if (frac.length > info.divisibility) return "too_precise"
    } else {
      if (info.kind !== "nonFungible") return "not_non_fungible"
      if (!isLocalId(ask.id)) return "bad_id"
      if (asset && ask.resource === asset.resource && ask.id === asset.id) return "same_as_asset"
    }
    if (asks.slice(0, i).some((prev) => sameAsk(prev, ask))) return "duplicate"
    return null
  })
}

// ── Display ─────────────────────────────────────────────────────────────────

/** Thousands separators on an exact decimal string, no float on the way. */
export function formatAmount(amount: string): string {
  const n = normalizeDecimal(amount)
  const [i, f] = n.split(".")
  const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return f ? `${int}.${f}` : int
}

/** "account_rdx12y6c…fgt3fm"-style short form for dense rows. The full
 *  address is always one click away (title / copy) wherever this is used. */
export function shortAddress(a: string): string {
  const i = a.indexOf("1")
  if (i < 0 || a.length < i + 14) return a
  return `${a.slice(0, i + 5)}…${a.slice(-6)}`
}

/** Only an https URL that parses is ever put in an <img src>. NFT metadata
 *  is written by whoever minted the NFT. */
export function safeImageUrl(u: unknown): string | null {
  if (typeof u !== "string" || u.length > 2048) return null
  try {
    const url = new URL(u)
    return url.protocol === "https:" ? url.toString() : null
  } catch {
    return null
  }
}

/** Display text from NFT or resource metadata: trimmed, one line, bounded. */
export function displayText(s: unknown, max = 80): string | null {
  if (typeof s !== "string") return null
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim()
  if (!t) return null
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

// ── Moderation lever ────────────────────────────────────────────────────────

/** Comma-separated listing ids or resource addresses from env, for the
 *  operator to hide a listing from these pages (an app-layer filter, never a
 *  chain rule: the listing stays fillable by anyone with its id). */
export function parseHiddenList(raw: string | undefined): { ids: Set<number>; resources: Set<string> } {
  const ids = new Set<number>()
  const resources = new Set<string>()
  for (const part of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (/^\d+$/.test(part)) ids.add(Number(part))
    else if (isResourceAddress(part)) resources.add(part)
  }
  return { ids, resources }
}

export function isHidden(l: SwapListing, hidden: { ids: Set<number>; resources: Set<string> }): boolean {
  return (
    hidden.ids.has(l.listingId) ||
    hidden.resources.has(l.assetResource) ||
    l.asks.some((a) => hidden.resources.has(a.resource))
  )
}
