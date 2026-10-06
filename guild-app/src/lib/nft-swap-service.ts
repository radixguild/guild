// Server-side assembly of what the swap pages and the public API show
// (GET /api/v1/swaps, GET /api/v1/swaps/{id}). Reads the chain through
// nft-swap-gateway.ts and adds display data; caches briefly so a burst of
// page views does not fan out to the Gateway.

import { NFT_SWAP_COMPONENT } from "./config"
import {
  canonicalLocalId,
  isHidden,
  parseHiddenList,
  swapStatus,
  type SwapAsk,
  type SwapListing,
  type SwapStatus,
} from "./nft-swap"
import {
  ENTITY_BATCH,
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
import { XRD_ADDRESS } from "./radix"

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
  /** Display data for the resources the page shows by name: on the board
   *  each listing's NFT and its first ask, on a listing's page its NFT and
   *  first DETAIL_ASK_DISPLAY_CAP asks. A hidden listing contributes only XRD.
   *  Absent entries = not looked up or the Gateway did not say; show the
   *  address. */
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
  /** Display data for non-fungible asks among the first
   *  DETAIL_ASK_DISPLAY_CAP, keyed `${resource} ${id}`; none for a hidden
   *  listing. */
  askNfts: Record<string, Omit<NftDisplay, "id">>
  /** The listing has more asks than DETAIL_ASK_DISPLAY_CAP; the rest have no
   *  display data and show by address and id. */
  moreAsks: boolean
}

export const SWAP_FILTERS = ["open", "expired", "filled", "cancelled", "all"] as const
export type SwapFilter = (typeof SWAP_FILTERS)[number]

/** Asks a listing's page looks up display data for. The blueprint sets no
 *  limit on asks and a stranger writes them, so the rest show by address. */
export const DETAIL_ASK_DISPLAY_CAP = 8

const BOARD_CACHE_MS = 15_000
const DISPLAY_CACHE_MS = 5 * 60_000
// A lookup the Gateway failed is not retried for this long, so a bad address
// in a listing does not cost a Gateway call on every page view.
const DISPLAY_FAIL_MS = 30_000
const DISPLAY_CACHE_MAX = 2_000
/** Display reads one request has in flight at once. */
const DISPLAY_CONCURRENCY = 4

type Cached<V> = { until: number; v: V | null }

let boardCache: { component: string; at: number; board: SwapBoard } | null = null
// Concurrent misses share one chain read rather than each starting their own.
let boardInFlight: { component: string; p: Promise<SwapBoard | null> } | null = null
const nftCache = new Map<string, Cached<NftDisplay>>()
const resourceCache = new Map<string, Cached<ResourceDisplay>>()
let hiddenMemo: { raw: string | undefined; list: ReturnType<typeof parseHiddenList> } | null = null

export function __resetSwapCachesForTests() {
  boardCache = null
  boardInFlight = null
  nftCache.clear()
  resourceCache.clear()
  hiddenMemo = null
}

function trim<V>(m: Map<string, V>) {
  while (m.size > DISPLAY_CACHE_MAX) m.delete(m.keys().next().value as string)
}

/** A good read keeps for DISPLAY_CACHE_MS, a failed one (null) for
 *  DISPLAY_FAIL_MS — both from when the read started. */
function stamp<V>(at: number, read: Map<string, V> | null, k: string): Cached<V> {
  return read ? { until: at + DISPLAY_CACHE_MS, v: read.get(k) ?? null } : { until: at + DISPLAY_FAIL_MS, v: null }
}

/** `fn` over `xs`, at most `n` at a time. `fn` must not throw (the readers
 *  answer null instead). */
async function eachLimited<T>(xs: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < xs.length) await fn(xs[next++])
  }
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, worker))
}

function hiddenList() {
  const raw = process.env.NFT_SWAP_HIDDEN
  if (!hiddenMemo || hiddenMemo.raw !== raw) {
    const list = parseHiddenList(raw)
    // Once per value, and env is fixed per process. Not a throw: a typo must
    // not take the board down, but the operator has to see that a listing
    // they meant to hide is still on show.
    if (list.invalid.length > 0) {
      console.error(
        `NFT_SWAP_HIDDEN: ignored ${list.invalid.length} token(s) that are neither a listing id nor a resource address: ${list.invalid.join(", ")}`,
      )
    }
    hiddenMemo = { raw, list }
  }
  return hiddenMemo.list
}

async function boardFor(component: string): Promise<SwapBoard | null> {
  const now = Date.now()
  if (boardCache && boardCache.component === component && now - boardCache.at < BOARD_CACHE_MS) {
    return boardCache.board
  }
  if (boardInFlight?.component === component) return boardInFlight.p
  // Stamped when the read starts: a slow read is already that old when it
  // lands, and the window promises at most BOARD_CACHE_MS of age.
  const p = readSwapBoard(component).then((board) => {
    // Only a good read is cached: a Gateway hiccup must not pin "unknown" for
    // the whole window.
    if (board) boardCache = { component, at: now, board }
    return board
  })
  boardInFlight = { component, p }
  try {
    return await p
  } finally {
    if (boardInFlight?.p === p) boardInFlight = null
  }
}

async function resourcesFor(addresses: string[]): Promise<Record<string, SwapResourceView>> {
  const now = Date.now()
  const want = [...new Set(addresses)].filter((a) => (resourceCache.get(a)?.until ?? 0) <= now)
  const batches: string[][] = []
  for (let i = 0; i < want.length; i += ENTITY_BATCH) batches.push(want.slice(i, i + ENTITY_BATCH))
  // Each batch is cached as it lands, so one failed batch costs only its own
  // addresses, not the whole page's.
  await eachLimited(batches, DISPLAY_CONCURRENCY, async (batch) => {
    const at = Date.now()
    const read = await readResourceDisplay(batch)
    for (const a of batch) resourceCache.set(a, stamp(at, read, a))
  })
  trim(resourceCache)
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

const nftKey = (resource: string, id: string) => `${resource} ${canonicalLocalId(id)}`

/** Display data for NFTs, keyed by nftKey. One Gateway call per resource,
 *  at most DISPLAY_CONCURRENCY at a time. */
async function nftsFor(pairs: { resource: string; id: string }[]): Promise<Map<string, NftDisplay | null>> {
  const now = Date.now()
  const byResource = new Map<string, Set<string>>()
  for (const { resource, id } of pairs) {
    if ((nftCache.get(nftKey(resource, id))?.until ?? 0) > now) continue
    byResource.set(resource, (byResource.get(resource) ?? new Set()).add(canonicalLocalId(id)))
  }
  await eachLimited([...byResource], DISPLAY_CONCURRENCY, async ([resource, ids]) => {
    const at = Date.now()
    const read = await readNftDisplay(resource, [...ids])
    for (const id of ids) nftCache.set(nftKey(resource, id), stamp(at, read, id))
  })
  trim(nftCache)
  const out = new Map<string, NftDisplay | null>()
  for (const { resource, id } of pairs) out.set(nftKey(resource, id), nftCache.get(nftKey(resource, id))?.v ?? null)
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

/** The resources a listing's card or page looks up display data for, given
 *  the asks it shows. A hidden listing names nothing a stranger wrote; XRD's
 *  metadata is the network's own, so its symbol still reads. */
function displayResources(l: SwapListing, asks: SwapAsk[], hidden: boolean): string[] {
  const all = [l.assetResource, ...asks.map((a) => a.resource)]
  return hidden ? all.filter((r) => r === XRD_ADDRESS) : all
}

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
  // strand anyone's own listing; the public board drops them. A dropped one is
  // counted only once it passed every other filter: the count sits beside
  // this filter's results, so it says how many of THOSE the operator hid, not
  // how many hidden listings exist anywhere.
  let hiddenCount = 0
  const matching = board.listings.filter((l) => {
    if (opts.seller && l.seller !== opts.seller) return false
    if (opts.before !== undefined && l.listingId >= opts.before) return false
    if (status !== "all" && swapStatus(l, ledgerTime) !== status) return false
    if (!opts.seller && isHidden(l, hidden)) {
      hiddenCount++
      return false
    }
    return true
  })
  const page = matching.slice(0, limit)
  const shown = page.filter((l) => !isHidden(l, hidden))
  const nfts = await nftsFor(shown.map((l) => ({ resource: l.assetResource, id: l.assetId })))
  // A card names its first ask only (askSummary), so only that one is looked up.
  const resources = await resourcesFor(page.flatMap((l) => displayResources(l, l.asks.slice(0, 1), isHidden(l, hidden))))

  return {
    component,
    receiptResource: board.state.receiptResource,
    ledgerTime,
    fees: board.state.fees,
    resources,
    total: board.total,
    truncated: board.truncated,
    unreadable: board.unreadable,
    hidden: hiddenCount,
    listings: page.map((l) =>
      view(l, ledgerTime, nfts.get(nftKey(l.assetResource, l.assetId)) ?? null, isHidden(l, hidden)),
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
  const read = await readSwapListing(component, listingId)
  if (!read) return { kind: "unknown" }
  if (read.unreadable) return { kind: "unreadable" }
  if (!read.listing) return { kind: "not_found" }
  const l = read.listing
  const hidden = isHidden(l, hiddenList())

  const asks = l.asks.slice(0, DETAIL_ASK_DISPLAY_CAP)
  // A hidden listing's NFTs — its own and the ones it asks for — are not
  // looked up at all: nothing a stranger wrote is shown for it.
  const nftAsks = hidden
    ? []
    : asks.flatMap((a) => (a.kind === "nonFungible" ? [{ resource: a.resource, id: a.id }] : []))
  const [nfts, resources, receipt] = await Promise.all([
    nftsFor([...(hidden ? [] : [{ resource: l.assetResource, id: l.assetId }]), ...nftAsks]),
    resourcesFor(displayResources(l, asks, hidden)),
    readListingReceiptHolder(read.state.receiptResource, l.listingId),
  ])
  const askNfts: SwapDetailView["askNfts"] = {}
  for (const { resource, id } of nftAsks) {
    const d = nfts.get(nftKey(resource, id))
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
      listing: view(l, read.state.ledgerNow, nfts.get(nftKey(l.assetResource, l.assetId)) ?? null, hidden),
      receipt,
      askNfts,
      moreAsks: l.asks.length > DETAIL_ASK_DISPLAY_CAP,
    },
  }
}
