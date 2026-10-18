// The board's orderings and collection counts (src/lib/nft-swap-sort.ts),
// pure. The service and route that apply them are tested in
// nft-swap-gateway.test.ts.
import { describe, expect, it } from "vitest"
import type { SwapAsk, SwapListing } from "@/lib/nft-swap"
import { collectionCounts, decimalUnits, isSwapSort, SWAP_SORTS, sortSwapListings, xrdPrice } from "@/lib/nft-swap-sort"

const XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"
const OTHER = "resource_rdx1t" + "c".repeat(40) + "0003"
const NOW = 1_800_000_000

const L = (listingId: number, asks: SwapAsk[], over: Partial<SwapListing> = {}): SwapListing => ({
  listingId,
  seller: "account_rdx12y6ch4m8wjcgu7hrnwfqjeqt70w4kh7qy7k3gs2j9wyx3596fgt3fm",
  assetResource: "resource_rdx1n" + "a".repeat(40) + "0001",
  assetId: `#${listingId}#`,
  asks,
  createdAt: NOW - 100,
  expiresAt: NOW + 1000 * listingId,
  state: "Listed",
  filledWith: null,
  proceedsWithdrawn: false,
  ...over,
})
const xrd = (amount: string): SwapAsk => ({ kind: "fungible", resource: XRD, amount })
const ctx = { ledgerNow: NOW, xrd: XRD, nameOf: (l: SwapListing) => `n${l.listingId}` }
const order = (ls: SwapListing[], sort: Parameters<typeof sortSwapListings>[1], c = ctx) =>
  sortSwapListings(ls, sort, c).map((l) => l.listingId)

describe("swap sort primitives", () => {
  it("knows exactly the five sorts", () => {
    expect([...SWAP_SORTS]).toEqual(["newest", "ending", "price-asc", "price-desc", "name"])
    for (const s of SWAP_SORTS) expect(isSwapSort(s)).toBe(true)
    for (const s of ["", "NAME", "price", "oldest", null, undefined, 3]) expect(isSwapSort(s)).toBe(false)
  })

  it("decimalUnits is exact to 18 places", () => {
    expect(decimalUnits("1")).toBe(BigInt("1000000000000000000"))
    expect(decimalUnits("0.000000000000000001")).toBe(BigInt(1))
    expect(decimalUnits("12.50")).toBe(BigInt("12500000000000000000"))
    expect(decimalUnits("007")).toBe(BigInt("7000000000000000000"))
  })

  it("xrdPrice is the lowest fungible XRD ask; null when there is none", () => {
    expect(xrdPrice(L(1, [xrd("200"), xrd("20"), { kind: "fungible", resource: OTHER, amount: "1" }]), XRD)).toBe(decimalUnits("20"))
    expect(xrdPrice(L(1, [{ kind: "fungible", resource: OTHER, amount: "1" }]), XRD)).toBeNull()
    // An NFT ask is not a price, even of the XRD resource's address.
    expect(xrdPrice(L(1, [{ kind: "nonFungible", resource: XRD, id: "#1#" }]), XRD)).toBeNull()
  })

  it("never mutates its input", () => {
    const ls = [L(1, [xrd("2")]), L(2, [xrd("1")])]
    order(ls, "price-asc")
    expect(ls.map((l) => l.listingId)).toEqual([1, 2])
  })

  it("ending puts open listings first by expiry, even when the status filter is all", () => {
    const ls = [
      L(1, [xrd("1")], { state: "Filled", filledWith: 0 }),
      L(2, [xrd("1")], { expiresAt: NOW - 5 }), // expired
      L(3, [xrd("1")], { expiresAt: NOW + 50 }),
      L(4, [xrd("1")], { expiresAt: NOW + 10 }),
      L(5, [xrd("1")], { state: "Cancelled" }),
    ]
    expect(order(ls, "ending")).toEqual([4, 3, 5, 2, 1])
  })

  it("name orders numbers by value and ignores case and accents", () => {
    const names: Record<number, string> = { 1: "Dino 10", 2: "dino 9", 3: "Élan", 4: "eagle" }
    const c = { ...ctx, nameOf: (l: SwapListing) => names[l.listingId] }
    expect(order([1, 2, 3, 4].map((i) => L(i, [xrd("1")])), "name", c)).toEqual([2, 1, 4, 3])
  })

  it("collectionCounts: most listings first, ties by address", () => {
    const a = "resource_rdx1n" + "a".repeat(40) + "0001"
    const b = "resource_rdx1n" + "b".repeat(40) + "0002"
    const c = "resource_rdx1n" + "c".repeat(40) + "0003"
    expect(
      collectionCounts([{ assetResource: c }, { assetResource: b }, { assetResource: a }, { assetResource: b }, { assetResource: c }]),
    ).toEqual([
      { resource: b, count: 2 },
      { resource: c, count: 2 },
      { resource: a, count: 1 },
    ])
    expect(collectionCounts([])).toEqual([])
  })
})
