// Server-side assembly of what the swap pages and the public API show
// (GET /api/v1/swaps, GET /api/v1/swaps/{id}). Reads the chain through
// nft-swap-gateway.ts and adds display data; caches briefly so a burst of
// page views does not fan out to the Gateway.

import { NFT_SWAP_COMPONENT, NFT_SWAP_PACKAGE } from "./config"
import {
  isHidden,
  parseHiddenList,
  swapStatus,
  type SwapListing,
  type SwapStatus,
} from "./nft-swap"
import {
  readListingReceiptHolder,
  readNftDisplay,
  readResourceDisplay,
  readSwapBoard,
  readSwapListing,
  type NftDisplay,
  type ResourceDisplay,
  type SwapBoard,
  type SwapFee,
} from "./nft-swap-gateway"

/** A listing as the API returns it: the chain's record, the status at the
 *  ledger clock, and best-effort display data for the listed NFT. */
export interface SwapListingView extends SwapListing {
  status: SwapStatus
  asset: { name: string | null; imageUrl: string | null }
  /** The operator hid this listing from these pages (NFT_SWAP_HIDDEN). It
   *  stays on chain and fillable by id; the site shows no NFT name or picture
   *  for it and offers no Fill, but its receipt holder keeps every seller
   *  action — a hide must never lock anyone out of their own NFT. */
  hidden: boolean
}

export type SwapResourceView = Omit<ResourceDisplay, "address">

interface SwapCommon {
  component: string
  receiptResource: string
  /** The ledger clock (unix seconds) the statuses were computed at. */
  ledgerTime: number
  fees: { fill: SwapFee | null; extend: SwapFee | null }
  /** Display data for every resource the returned listings name. Absent
   *  entries = the Gateway did not say; show the address. */
  resources: Record<string, SwapResourceView>
}

export interface SwapBoardView extends SwapCommon {
  /** Listings ever made on the component. */
  total: number
  /** The board read only the newest SWAP_SCAN_CAP listings. */
  truncated: boolean
  /** Ids that exist on chain but did not parse — reported, never dropped. */
  unreadable: number[]
  /** Listings the operator hid from these pages (they stay on chain). */
  hidden: number
  listings: SwapListingView[]
  /** Pass as `before` for the next page; null = no more. */
  nextCursor: number | null
}

export interface SwapDetailView extends SwapCommon {
  listing: SwapListingView
  /** Who holds the listing receipt (the credential for cancel / extend /
   *  withdraw). null = the Gateway could not say. */
  receipt: { holder: string | null; burned: boolean } | null
  /** Display data for non-fungible asks, keyed `${resource} ${id}`. */
  askNfts: Record<string, Omit<NftDisplay, "id">>
}

export const SWAP_FILTERS = ["open", "expired", "filled", "cancelled", "all"] as const
export type SwapFilter = (typeof SWAP_FILTERS)[number]

const BOARD_CACHE_MS = 15_000
const DISPLAY_CACHE_MS = 5 * 60_000
const DISPLAY_CACHE_MAX = 2_000

let boardCache: { component: string; at: number; board: SwapBoard } | null = null
// Concurrent misses share one chain read rather than each starting their own.
let boardInFlight: { component: string; p: Promise<SwapBoard | null> } | null = null
const nftCache = new Map<string, { at: number; v: NftDisplay | null }>()
const resourceCache = new Map<string, { at: number; v: ResourceDisplay | null }>()

export function __resetSwapCachesForTests() {
  boardCache = null
  boardInFlight = null
  nftCache.clear()
  resourceCache.clear()
}

function trim<V>(m: Map<string, V>) {
  while (m.size > DISPLAY_CACHE_MAX) m.delete(m.keys().next().value as string)
}

const hiddenList = () => parseHiddenList(process.env.NFT_SWAP_HIDDEN)

async function boardFor(component: string): Promise<SwapBoard | null> {
  const now = Date.now()
  if (boardCache && boardCache.component === component && now - boardCache.at < BOARD_CACHE_MS) {
    return boardCache.board
  }
  if (boardInFlight?.component === component) return boardInFlight.p
  const p = readSwapBoard(component, expectedPackageFor(component)).then((board) => {
    // Only a good read is cached: a Gateway hiccup must not pin "unknown" for
    // the whole window.
    if (board) boardCache = { component, at: Date.now(), board }
    return board
  })
  boardInFlight = { component, p }
  try {
    return await p
  } finally {
    if (boardInFlight?.p === p) boardInFlight = null
  }
}

/** The live component is pinned to its package too; any other component (a
 *  test, a future cutover passing its own) is checked by blueprint only. */
const expectedPackageFor = (component: string) => (component === NFT_SWAP_COMPONENT ? NFT_SWAP_PACKAGE : undefined)

async function resourcesFor(addresses: string[]): Promise<Record<string, SwapResourceView>> {
  const now = Date.now()
  const want = [...new Set(addresses)].filter((a) => {
    const c = resourceCache.get(a)
    return !c || now - c.at >= DISPLAY_CACHE_MS
  })
  if (want.length) {
    const read = await readResourceDisplay(want)
    // A failed batch leaves these uncached, so the next view asks again.
    if (read) for (const a of want) resourceCache.set(a, { at: now, v: read.get(a) ?? null })
    trim(resourceCache)
  }
  const out: Record<string, SwapResourceView> = {}
  for (const a of addresses) {
    const v = resourceCache.get(a)?.v
    if (v) {
      const { address: _address, ...rest } = v
      out[a] = rest
    }
  }
  return out
}

async function nftsFor(pairs: { resource: string; id: string }[]): Promise<Map<string, NftDisplay | null>> {
  const now = Date.now()
  const key = (r: string, id: string) => `${r} ${id}`
  const byResource = new Map<string, string[]>()
  for (const { resource, id } of pairs) {
    const c = nftCache.get(key(resource, id))
    if (c && now - c.at < DISPLAY_CACHE_MS) continue
    byResource.set(resource, [...(byResource.get(resource) ?? []), id])
  }
  await Promise.all(
    [...byResource].map(async ([resource, ids]) => {
      const read = await readNftDisplay(resource, ids)
      if (read) for (const id of ids) nftCache.set(key(resource, id), { at: now, v: read.get(id) ?? null })
    }),
  )
  trim(nftCache)
  const out = new Map<string, NftDisplay | null>()
  for (const { resource, id } of pairs) out.set(key(resource, id), nftCache.get(key(resource, id))?.v ?? null)
  return out
}

function view(l: SwapListing, ledgerTime: number, nft: NftDisplay | null, hidden: boolean): SwapListingView {
  return {
    ...l,
    status: swapStatus(l, ledgerTime),
    asset: hidden ? { name: null, imageUrl: null } : { name: nft?.name ?? null, imageUrl: nft?.imageUrl ?? null },
    hidden,
  }
}

const resourcesOf = (ls: SwapListing[]) => ls.flatMap((l) => [l.assetResource, ...l.asks.map((a) => a.resource)])

/**
 * One page of the board, newest first. `status` filters at the ledger clock;
 * `seller` narrows to one account's listings; `before` is the previous page's
 * cursor. null = the chain could not be read.
 */
export async function getSwapBoard(opts: {
  status?: SwapFilter
  seller?: string
  before?: number
  limit?: number
  component?: string
}): Promise<SwapBoardView | null> {
  const component = opts.component ?? NFT_SWAP_COMPONENT
  const board = await boardFor(component)
  if (!board) return null
  const ledgerTime = board.state.ledgerNow
  const hidden = hiddenList()
  const limit = Math.min(Math.max(opts.limit ?? 48, 1), 100)
  const status = opts.status ?? "all"

  // A seller-filtered view ("My listings") still shows that seller's hidden
  // listings — flagged, with no NFT name or picture — so the hide lever cannot
  // strand anyone's own listing; the public board drops them.
  let hiddenCount = 0
  const matching = board.listings.filter((l) => {
    if (opts.seller && l.seller !== opts.seller) return false
    if (!opts.seller && isHidden(l, hidden)) {
      hiddenCount++
      return false
    }
    if (opts.before !== undefined && l.listingId >= opts.before) return false
    return status === "all" || swapStatus(l, ledgerTime) === status
  })
  const page = matching.slice(0, limit)
  const shown = page.filter((l) => !isHidden(l, hidden))
  const nfts = await nftsFor(shown.map((l) => ({ resource: l.assetResource, id: l.assetId })))

  return {
    component,
    receiptResource: board.state.receiptResource,
    ledgerTime,
    fees: board.state.fees,
    resources: await resourcesFor(resourcesOf(page)),
    total: board.total,
    truncated: board.truncated,
    unreadable: board.unreadable,
    hidden: hiddenCount,
    listings: page.map((l) =>
      view(l, ledgerTime, nfts.get(`${l.assetResource} ${l.assetId}`) ?? null, isHidden(l, hidden)),
    ),
    nextCursor: matching.length > limit ? page[page.length - 1].listingId : null,
  }
}

export type SwapDetailResult =
  | { kind: "ok"; view: SwapDetailView }
  | { kind: "not_found" }
  | { kind: "unreadable" }
  | { kind: "unknown" }

/** One listing with everything its page needs. Always a fresh chain read —
 *  this is the page a buyer fills from and a seller cancels from. */
export async function getSwapDetail(listingId: number, component = NFT_SWAP_COMPONENT): Promise<SwapDetailResult> {
  const read = await readSwapListing(component, listingId, expectedPackageFor(component))
  if (!read) return { kind: "unknown" }
  if (read.unreadable) return { kind: "unreadable" }
  if (!read.listing) return { kind: "not_found" }
  const l = read.listing
  const hidden = isHidden(l, hiddenList())

  const nftAsks = l.asks.flatMap((a) => (a.kind === "nonFungible" ? [{ resource: a.resource, id: a.id }] : []))
  const [nfts, resources, receipt] = await Promise.all([
    // A hidden listing's own NFT is not looked up at all: nothing to show.
    nftsFor([...(hidden ? [] : [{ resource: l.assetResource, id: l.assetId }]), ...nftAsks]),
    resourcesFor(resourcesOf([l])),
    readListingReceiptHolder(read.state.receiptResource, l.listingId),
  ])
  const askNfts: SwapDetailView["askNfts"] = {}
  for (const { resource, id } of nftAsks) {
    const d = nfts.get(`${resource} ${id}`)
    if (d) askNfts[`${resource} ${id}`] = { name: d.name, imageUrl: d.imageUrl, burned: d.burned }
  }
  return {
    kind: "ok",
    view: {
      component,
      receiptResource: read.state.receiptResource,
      ledgerTime: read.state.ledgerNow,
      fees: read.state.fees,
      resources,
      listing: view(l, read.state.ledgerNow, nfts.get(`${l.assetResource} ${l.assetId}`) ?? null, hidden),
      receipt,
      askNfts,
    },
  }
}
