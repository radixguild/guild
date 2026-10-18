import { NextRequest } from "next/server"
import { error, success } from "@/lib/api-response"
import { createRateLimiter, getClientIp, rateLimitResponse } from "@/lib/rate-limit"
import { isAccountAddress, isResourceAddress, SWAP_SCAN_CAP } from "@/lib/nft-swap"
import { getSwapBoard, SWAP_FILTERS, type SwapFilter } from "@/lib/nft-swap-service"
import { isSwapSort, SWAP_SORTS } from "@/lib/nft-swap-sort"

// Read per request: the board is the component's own state, cached 15 s in
// nft-swap-service.ts — never baked at build time.
export const dynamic = "force-dynamic"

// Unauthenticated and chain-backed, and the Gateway budget is shared with every
// escrow read the app makes. A board miss (once per 15 s, shared by every
// caller) is 1 component read + up to 10 key-value-store batches sent together.
// Display data for a page of `limit` (≤ 100) listings, cold, is one NFT read
// per distinct collection on it (≤ 100) + one resource read per 20 resources
// (NFT + first ask: ≤ 10), 4 in flight at most — so ≈ 120 Gateway calls for a
// cold page at worst, 0 for a warm one. Good display reads keep 5 min, failed
// ones 30 s. 60 a minute per address is far above a person clicking filters.
// The collection filter's options add at most 5 resource batches (100 names);
// `sort=name` reads the NFT names of the whole filtered set, one read per
// collection (≤ 100 of them, 100 ids per read), before it can order a page.
const limiter = createRateLimiter({ windowMs: 60_000, max: 60 })

/**
 * Public, unauthenticated: the NFT swap listings, read from the guild-nft-swap
 * component on chain (there is no database copy). Newest first unless `sort`
 * says otherwise. `status` is computed at the ledger clock the response
 * carries. `before` pages sort=newest (a listing id); `offset` pages every
 * other sort. Both come back as `nextCursor`.
 */
export async function GET(req: NextRequest) {
  const limit = limiter(`swaps:${getClientIp(req)}`)
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)
  const q = new URL(req.url).searchParams

  const status = (q.get("status") ?? "all") as SwapFilter
  if (!SWAP_FILTERS.includes(status)) {
    return error(`status must be one of ${SWAP_FILTERS.join(", ")}`, "INVALID_STATUS", 400)
  }
  const seller = q.get("seller") ?? undefined
  if (seller !== undefined && !isAccountAddress(seller)) {
    return error("seller must be an account address", "INVALID_SELLER", 400)
  }
  const sort = q.get("sort") ?? "newest"
  if (!isSwapSort(sort)) {
    return error(`sort must be one of ${SWAP_SORTS.join(", ")}`, "INVALID_SORT", 400)
  }
  const collection = q.get("collection") ?? undefined
  if (collection !== undefined && !isResourceAddress(collection)) {
    return error("collection must be an NFT resource address", "INVALID_COLLECTION", 400)
  }
  const beforeRaw = q.get("before")
  const before = beforeRaw === null ? undefined : Number(beforeRaw)
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) {
    return error("before must be a positive listing id", "INVALID_CURSOR", 400)
  }
  const offsetRaw = q.get("offset")
  const offset = offsetRaw === null ? undefined : /^\d{1,4}$/.test(offsetRaw) ? Number(offsetRaw) : NaN
  if (offset !== undefined && !(offset >= 1 && offset <= SWAP_SCAN_CAP)) {
    return error(`offset must be 1-${SWAP_SCAN_CAP}`, "INVALID_CURSOR", 400)
  }
  // One cursor per ordering: a listing id only means something in id order.
  if (sort === "newest" && offset !== undefined) {
    return error("offset pages the other sorts; page sort=newest with before", "INVALID_CURSOR", 400)
  }
  if (sort !== "newest" && before !== undefined) {
    return error("before pages sort=newest; page the other sorts with offset", "INVALID_CURSOR", 400)
  }
  const limitRaw = q.get("limit")
  const pageSize = limitRaw === null ? undefined : Number(limitRaw)
  if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)) {
    return error("limit must be 1-100", "INVALID_LIMIT", 400)
  }

  const board = await getSwapBoard({ status, seller, collection, sort, before, offset, limit: pageSize })
  if (!board) {
    return error("The swap component could not be read from the Radix Gateway. Try again shortly.", "CHAIN_UNREADABLE", 503)
  }
  return success(board)
}
