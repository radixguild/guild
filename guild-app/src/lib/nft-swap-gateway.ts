// Gateway readers for the guild-nft-swap component (P7-03 / P7-04).
//
// The model and the reasons it reads the chain instead of a DB table are in
// nft-swap.ts. Every reader answers null for "unknown" — a Gateway hiccup, a
// non-2xx, a shape it does not recognise — and callers say "could not read",
// never a guess. Batch sizes are the Gateway's own limits, measured on mainnet
// 2026-10-06: 100 keys per key-value-store/data call, 20 addresses per
// entity/details call, 100 ids per non-fungible/data call (101 / 21 / 101
// answer 400).

import { GATEWAY } from "./constants"
import { GATEWAY_READ_TIMEOUT_MS, readNonFungibleHolder, readTxEventFields } from "./gateway"
import {
  SWAP_SCAN_CAP,
  displayText,
  isLocalId,
  isResourceAddress,
  parseSwapListing,
  receiptLocalId,
  safeImageUrl,
  type SwapListing,
} from "./nft-swap"

const KV_BATCH = 100
const ENTITY_BATCH = 20
const NF_DATA_BATCH = 100

async function post(path: string, body: unknown): Promise<any | null> {
  try {
    const resp = await fetch(`${GATEWAY}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GATEWAY_READ_TIMEOUT_MS),
    })
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  }
}

/** The ledger clock of a response, in seconds — the clock `list` and `fill`
 *  check expiry against (`Clock::current_time_rounded_to_seconds`). */
function ledgerSecs(json: any): number | null {
  const ms = Date.parse(json?.ledger_state?.proposer_round_timestamp)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

// ── The component ───────────────────────────────────────────────────────────

/** A component royalty as the Gateway reports it. A method with no royalty
 *  (Free) reads as amount "0". */
export interface SwapFee {
  unit: "XRD" | "USD"
  amount: string
}

export interface SwapComponentState {
  component: string
  listingsKvStore: string
  /** Ids run 1 .. nextListingId − 1; every one of them exists. */
  nextListingId: number
  receiptResource: string
  /** The royalty a buyer pays on `fill` and a seller on `extend_listing`,
   *  read live — the dials are updatable by the royalty-admin badge. null
   *  when the Gateway did not report the method's rule. */
  fees: { fill: SwapFee | null; extend: SwapFee | null }
  ledgerNow: number
}

function feeFor(config: any, method: string): SwapFee | null {
  if (config?.is_enabled === false) return { unit: "XRD", amount: "0" }
  const rules = config?.method_rules
  if (!Array.isArray(rules)) return null
  const rule = rules.find((r: any) => r?.method_name === method)
  if (!rule) return null
  const ra = rule.royalty_amount
  if (ra === undefined || ra === null) return { unit: "XRD", amount: "0" }
  const unit = ra.unit
  const amount = ra.amount
  if ((unit !== "XRD" && unit !== "USD") || typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount)) return null
  return { unit, amount }
}

/**
 * The component's state: where its listings live, how many there are, the
 * receipt resource, the live fee dials and the ledger clock — one call.
 * Refuses (null) anything that is not an `NftSwap` component, so a wrong
 * address in env reads as "could not read", not as an empty board.
 */
export async function readSwapComponentState(component: string): Promise<SwapComponentState | null> {
  const json = await post("/state/entity/details", {
    addresses: [component],
    opt_ins: { component_royalty_config: true },
  })
  const details = json?.items?.[0]?.details
  if (!details || details.blueprint_name !== "NftSwap") return null
  const fields = details?.state?.fields
  if (!Array.isArray(fields)) return null
  const f = (name: string) => fields.find((x: any) => x?.field_name === name)?.value
  const listingsKvStore = f("listings")
  const next = Number(f("next_listing_id"))
  const receiptResource = f("listing_receipt_manager")
  const ledgerNow = ledgerSecs(json)
  if (
    typeof listingsKvStore !== "string" ||
    !listingsKvStore.startsWith("internal_keyvaluestore_") ||
    !Number.isSafeInteger(next) ||
    next < 1 ||
    !isResourceAddress(receiptResource) ||
    ledgerNow === null
  ) {
    return null
  }
  return {
    component,
    listingsKvStore,
    nextListingId: next,
    receiptResource,
    fees: { fill: feeFor(details.royalty_config, "fill"), extend: feeFor(details.royalty_config, "extend_listing") },
    ledgerNow,
  }
}

// ── Listings ────────────────────────────────────────────────────────────────

/**
 * Read listings by id. A listing that exists but does not parse lands in
 * `unreadable` rather than vanishing; an id with no entry lands in `missing`.
 * One failed batch fails the whole read (null) — a board with a silent gap in
 * it would look complete.
 */
export async function readSwapListingsById(
  listingsKvStore: string,
  ids: number[],
): Promise<{ listings: SwapListing[]; unreadable: number[]; missing: number[]; ledgerNow: number } | null> {
  const listings: SwapListing[] = []
  const unreadable: number[] = []
  const seen = new Set<number>()
  let ledgerNow: number | null = null
  for (const batch of chunks(ids, KV_BATCH)) {
    const json = await post("/state/key-value-store/data", {
      key_value_store_address: listingsKvStore,
      keys: batch.map((id) => ({ key_json: { kind: "U64", value: String(id) } })),
    })
    const entries = json?.entries
    if (!Array.isArray(entries)) return null
    ledgerNow = ledgerNow ?? ledgerSecs(json)
    for (const e of entries) {
      const id = Number(e?.key?.programmatic_json?.value)
      if (!Number.isSafeInteger(id) || !batch.includes(id)) continue
      seen.add(id)
      const listing = parseSwapListing(id, e?.value?.programmatic_json)
      if (listing) listings.push(listing)
      else unreadable.push(id)
    }
  }
  if (ledgerNow === null) return null
  return { listings, unreadable, missing: ids.filter((id) => !seen.has(id)), ledgerNow }
}

export interface SwapBoard {
  state: SwapComponentState
  /** Newest first. */
  listings: SwapListing[]
  /** Ids that exist on chain but did not parse — shown as such, not hidden. */
  unreadable: number[]
  /** Listings ever made on this component. */
  total: number
  /** More than SWAP_SCAN_CAP listings exist and only the newest were read. */
  truncated: boolean
}

/** Every listing on the component, newest first (up to SWAP_SCAN_CAP). */
export async function readSwapBoard(component: string): Promise<SwapBoard | null> {
  const state = await readSwapComponentState(component)
  if (!state) return null
  const total = state.nextListingId - 1
  const lowest = Math.max(1, total - SWAP_SCAN_CAP + 1)
  const ids: number[] = []
  for (let id = total; id >= lowest; id--) ids.push(id)
  if (ids.length === 0) return { state, listings: [], unreadable: [], total, truncated: false }
  const read = await readSwapListingsById(state.listingsKvStore, ids)
  if (!read) return null
  read.listings.sort((a, b) => b.listingId - a.listingId)
  // An id below next_listing_id with no entry should not exist — the
  // blueprint never removes a listing. Report it with the unreadable ones.
  const unreadable = [...read.unreadable, ...read.missing].sort((a, b) => b - a)
  return { state, listings: read.listings, unreadable, total, truncated: lowest > 1 }
}

/** One listing. `listing: null` = no such id on this component. */
export async function readSwapListing(
  component: string,
  listingId: number,
): Promise<{ state: SwapComponentState; listing: SwapListing | null; unreadable: boolean } | null> {
  const state = await readSwapComponentState(component)
  if (!state) return null
  if (!Number.isSafeInteger(listingId) || listingId < 1 || listingId >= state.nextListingId) {
    return { state, listing: null, unreadable: false }
  }
  const read = await readSwapListingsById(state.listingsKvStore, [listingId])
  if (!read) return null
  return {
    state: { ...state, ledgerNow: read.ledgerNow },
    listing: read.listings[0] ?? null,
    unreadable: read.unreadable.length > 0 || read.missing.length > 0,
  }
}

// ── The listing receipt ─────────────────────────────────────────────────────

/** Who holds listing `listingId`'s receipt — the only credential that can
 *  cancel, extend or withdraw. `holder` is the account (or component) the
 *  receipt's vault belongs to; null = unknown. */
export async function readListingReceiptHolder(
  receiptResource: string,
  listingId: number,
): Promise<{ holder: string | null; burned: boolean } | null> {
  const r = await readNonFungibleHolder(receiptResource, receiptLocalId(listingId))
  if (r === null) return null
  if (!r.minted) return { holder: null, burned: false }
  return { holder: r.burned ? null : r.holder, burned: r.burned }
}

/** The listing id a committed `list` transaction created, from its
 *  ListedEvent — emitter-pinned to `component`. null = unknown. */
export async function readListedListingId(intentHash: string, component: string): Promise<number | null> {
  const fields = await readTxEventFields(intentHash, "ListedEvent", component)
  if (!fields) return null
  const v = Number(fields.find((x: any) => x?.field_name === "listing_id")?.value)
  return Number.isSafeInteger(v) && v > 0 ? v : null
}

// ── Display data for resources and NFTs ─────────────────────────────────────

export interface ResourceDisplay {
  address: string
  kind: "fungible" | "nonFungible"
  /** Fungible only; the blueprint refuses a finer amount. */
  divisibility: number | null
  name: string | null
  symbol: string | null
  iconUrl: string | null
  /**
   * The resource's `withdrawer` role. "open" = anyone holding it may withdraw;
   * "denied" = soulbound, `list` would fail in the seller's own manifest;
   * "restricted" = a rule decides (a badge, the owner) and the wallet will
   * say whether this account satisfies it.
   */
  withdraw: "open" | "restricted" | "denied"
}

function metadataValue(items: any[], key: string): unknown {
  return items.find((m: any) => m?.key === key)?.value?.typed?.value
}

function withdrawRule(details: any): ResourceDisplay["withdraw"] {
  const entries = details?.role_assignments?.entries
  const role = Array.isArray(entries) ? entries.find((r: any) => r?.role_key?.name === "withdrawer") : null
  const type = role?.assignment?.explicit_rule?.type
  if (type === "AllowAll") return "open"
  if (type === "DenyAll") return "denied"
  return "restricted"
}

/** Name, symbol, icon, kind and divisibility for resources, batched. */
export async function readResourceDisplay(addresses: string[]): Promise<Map<string, ResourceDisplay> | null> {
  const unique = [...new Set(addresses.filter(isResourceAddress))]
  const out = new Map<string, ResourceDisplay>()
  for (const batch of chunks(unique, ENTITY_BATCH)) {
    const json = await post("/state/entity/details", { addresses: batch })
    const items = json?.items
    if (!Array.isArray(items)) return null
    for (const it of items) {
      const address = it?.address
      const details = it?.details
      if (!isResourceAddress(address) || !details) continue
      const kind =
        details.type === "FungibleResource" ? "fungible" : details.type === "NonFungibleResource" ? "nonFungible" : null
      if (!kind) continue
      const d = details.divisibility
      const md = Array.isArray(it?.metadata?.items) ? it.metadata.items : []
      out.set(address, {
        address,
        kind,
        divisibility: kind === "fungible" && Number.isInteger(d) && d >= 0 && d <= 18 ? d : null,
        name: displayText(metadataValue(md, "name")),
        symbol: displayText(metadataValue(md, "symbol"), 16),
        iconUrl: safeImageUrl(metadataValue(md, "icon_url")),
        withdraw: withdrawRule(details),
      })
    }
  }
  return out
}

export interface NftDisplay {
  id: string
  name: string | null
  imageUrl: string | null
  burned: boolean
}

/** The Radix NFT display fields (`name`, `key_image_url`) for ids of one
 *  resource, batched. Ids the Gateway does not return are simply absent. */
export async function readNftDisplay(resource: string, ids: string[]): Promise<Map<string, NftDisplay> | null> {
  if (!isResourceAddress(resource)) return null
  const unique = [...new Set(ids.filter(isLocalId))]
  const out = new Map<string, NftDisplay>()
  for (const batch of chunks(unique, NF_DATA_BATCH)) {
    const json = await post("/state/non-fungible/data", { resource_address: resource, non_fungible_ids: batch })
    const items = json?.non_fungible_ids
    if (!Array.isArray(items)) return null
    for (const it of items) {
      const id = it?.non_fungible_id
      if (!isLocalId(id)) continue
      const fields = it?.data?.programmatic_json?.fields
      const f = (name: string) =>
        Array.isArray(fields) ? fields.find((x: any) => x?.field_name === name)?.value : undefined
      out.set(id, {
        id,
        name: displayText(f("name")),
        imageUrl: safeImageUrl(f("key_image_url")),
        burned: it?.is_burned === true,
      })
    }
  }
  return out
}

// ── The connected account's NFTs (the List page) ────────────────────────────

export interface AccountNftGroup {
  resource: string
  ids: string[]
  /** The account holds more ids of this resource than the first page shows. */
  more: boolean
}

/** The non-fungibles an account holds — first page of resources, first page
 *  of ids per vault, with `more` flags rather than a silent cut. */
export async function readAccountNonFungibles(
  account: string,
): Promise<{ groups: AccountNftGroup[]; moreResources: boolean } | null> {
  const json = await post("/state/entity/page/non-fungibles", {
    address: account,
    aggregation_level: "Vault",
    opt_ins: { non_fungible_include_nfids: true },
  })
  const items = json?.items
  if (!Array.isArray(items)) return null
  const groups: AccountNftGroup[] = []
  for (const it of items) {
    const resource = it?.resource_address
    const vaults = it?.vaults?.items
    if (!isResourceAddress(resource) || !Array.isArray(vaults)) continue
    const ids: string[] = []
    let more = Boolean(it?.vaults?.next_cursor)
    for (const v of vaults) {
      if (Array.isArray(v?.items)) for (const id of v.items) if (isLocalId(id)) ids.push(id)
      if (v?.next_cursor) more = true
    }
    if (ids.length > 0) groups.push({ resource, ids, more })
  }
  return { groups, moreResources: Boolean(json?.next_cursor) }
}
