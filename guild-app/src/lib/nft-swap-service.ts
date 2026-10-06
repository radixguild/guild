// Server-side assembly of what the swap pages and the public API show
// (GET /api/v1/swaps, GET /api/v1/swaps/{id}). Reads the chain through
// nft-swap-gateway.ts and adds display data; caches briefly so a burst of
// page views does not fan out to the Gateway.

import { NFT_SWAP_COMPONENT } from "./config"
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
const nftCache = new Map<string, { at: number; v: NftDisplay | null }>()
const resourceCache = new Map<string, { at: number; v: ResourceDisplay | null }>()

export function __resetSwapCachesForTests() {
  boardCache = null
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
  const board = await readSwapBoard(component)
  // Only a good read is cached: a Gateway hiccup must not pin "unknown" for
  // the whole window.
  if (board) boardCache = { component, at: now, board }
  return board
}

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

function view(l: SwapListing, ledgerTime: number, nft: NftDisplay | null): SwapListingView {
  return { ...l, status: swapStatus(l, ledgerTime), asset: { name: nft?.name ?? null, imageUrl: nft?.imageUrl ?? null } }
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

  let hiddenCount = 0
  const matching = board.listings.filter((l) => {
    if (isHidden(l, hidden)) {
      hiddenCount++
      return false
    }
    if (opts.seller && l.seller !== opts.seller) return false
    if (opts.before !== undefined && l.listingId >= opts.before) return false
    return status === "all" || swapStatus(l, ledgerTime) === status
  })
  const page = matching.slice(0, limit)
  const nfts = await nftsFor(page.map((l) => ({ resource: l.assetResource, id: l.assetId })))

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
    listings: page.map((l) => view(l, ledgerTime, nfts.get(`${l.assetResource} ${l.assetId}`) ?? null)),
    nextCursor: matching.length > limit ? page[page.length - 1].listingId : null,
  }
}

export type SwapDetailResult =
  | { kind: "ok"; view: SwapDetailView }
  | { kind: "not_found" }
  | { kind: "hidden" }
  | { kind: "unreadable" }
  | { kind: "unknown" }

/** One listing with everything its page needs. Always a fresh chain read —
 *  this is the page a buyer fills from and a seller cancels from. */
export async function getSwapDetail(listingId: number, component = NFT_SWAP_COMPONENT): Promise<SwapDetailResult> {
  const read = await readSwapListing(component, listingId)
  if (!read) return { kind: "unknown" }
  if (read.unreadable) return { kind: "unreadable" }
  if (!read.listing) return { kind: "not_found" }
  const l = read.listing
  if (isHidden(l, hiddenList())) return { kind: "hidden" }

  const nftAsks = l.asks.flatMap((a) => (a.kind === "nonFungible" ? [{ resource: a.resource, id: a.id }] : []))
  const [nfts, resources, receipt] = await Promise.all([
    nftsFor([{ resource: l.assetResource, id: l.assetId }, ...nftAsks]),
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
      listing: view(l, read.state.ledgerNow, nfts.get(`${l.assetResource} ${l.assetId}`) ?? null),
      receipt,
      askNfts,
    },
  }
}
