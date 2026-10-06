/**
 * NFT swap follow-up (peer finding SWAP-6, 2026-10-06): the board's `hidden`
 * count sits beside one filter's results, so it counts only the hidden
 * listings that filter would otherwise have shown — the status at the ledger
 * clock and the `before` cursor applied first. Counting every hidden listing
 * told a viewer of "Filled" that open listings they were not looking at had
 * been hidden from them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { SwapListing } from "@/lib/nft-swap"

const XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"
const NFT = "resource_rdx1" + "n".repeat(54)
const SELLER = "account_rdx12" + "s".repeat(53)
const T = 1_800_000_000

const G = vi.hoisted(() => ({ readSwapBoard: vi.fn() }))
vi.mock("@/lib/nft-swap-gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/nft-swap-gateway")>()),
  readSwapBoard: G.readSwapBoard,
  readNftDisplay: async () => new Map(),
  readResourceDisplay: async () => new Map(),
}))

import { __resetSwapCachesForTests, getSwapBoard } from "@/lib/nft-swap-service"

function listing(listingId: number, over: Partial<SwapListing> = {}): SwapListing {
  return {
    listingId,
    seller: SELLER,
    assetResource: NFT,
    assetId: `#${listingId}#`,
    asks: [{ kind: "fungible", resource: XRD, amount: "100" }],
    createdAt: T - 100,
    expiresAt: T + 86_400,
    state: "Listed",
    filledWith: null,
    proceedsWithdrawn: false,
    ...over,
  }
}

beforeEach(() => {
  __resetSwapCachesForTests()
  // Newest first: 6 open (shown), 5 open, 4 filled, 2 expired (all hidden).
  G.readSwapBoard.mockResolvedValue({
    state: { component: "component_rdx1swap", listingsKvStore: "kvs", nextListingId: 7, receiptResource: "resource_rdx1receipt", fees: { fill: null, extend: null }, ledgerNow: T },
    listings: [
      listing(6),
      listing(5),
      listing(4, { state: "Filled", filledWith: 0 }),
      listing(2, { expiresAt: T - 1 }),
    ],
    unreadable: [],
    total: 6,
    truncated: false,
  })
  vi.stubEnv("NFT_SWAP_HIDDEN", "5, 4, 2")
})
afterEach(() => vi.unstubAllEnvs())

describe("getSwapBoard — the hidden count follows the filter", () => {
  it.each([
    [{}, 3],
    [{ status: "open" as const }, 1],
    [{ status: "filled" as const }, 1],
    [{ status: "cancelled" as const }, 0],
    [{ before: 5 }, 2],
    [{ before: 4, status: "expired" as const }, 1],
    [{ before: 2 }, 0],
  ])("%j counts %i hidden", async (opts, n) => {
    const b = await getSwapBoard({ component: "component_rdx1swap", ...opts })
    expect(b!.hidden).toBe(n)
    expect(b!.listings.map((l) => l.listingId)).not.toContain(5)
  })

  it("a seller's own view shows their hidden listings and counts none", async () => {
    const b = await getSwapBoard({ component: "component_rdx1swap", seller: SELLER })
    expect(b!.hidden).toBe(0)
    expect(b!.listings.filter((l) => l.hidden).map((l) => l.listingId)).toEqual([5, 4, 2])
  })
})
