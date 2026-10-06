/**
 * The swap readers (src/lib/nft-swap-gateway.ts), the page/API service
 * (src/lib/nft-swap-service.ts) and the two public routes. Gateway shapes are
 * the ones read off mainnet on 2026-10-06 (tests/fixtures/nft-swap/). Every
 * reader answers null — "unknown" — rather than a guess, and the routes turn
 * that into 503 CHAIN_UNREADABLE, never an empty board.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GATEWAY } from "@/lib/constants"
import type { SwapAsk } from "@/lib/nft-swap"
import {
  readAccountNonFungibles,
  readListedListingId,
  readListingReceiptHolder,
  readNftDisplay,
  readResourceDisplay,
  readSwapBoard,
  readSwapComponentState,
  readSwapListingsById,
} from "@/lib/nft-swap-gateway"
import { __resetSwapCachesForTests, DETAIL_ASK_DISPLAY_CAP, getSwapBoard, getSwapDetail } from "@/lib/nft-swap-service"
import { GET as getBoardRoute } from "@/app/api/v1/swaps/route"
import { GET as getDetailRoute } from "@/app/api/v1/swaps/[id]/route"

const FIX = join(__dirname, "..", "fixtures", "nft-swap")
const kvFixture = JSON.parse(readFileSync(join(FIX, "listings-kv-mainnet-2026-10-06.json"), "utf8"))
const listedTx = JSON.parse(readFileSync(join(FIX, "list-1-committed-details.json"), "utf8"))

const SWAP = "component_rdx1cq80zarwh84mmrkn95xc7glgg5yvz0vkvqs9amxsnpwxuhkldd5mp4"
const KV = "internal_keyvaluestore_rdx1kp9yd7edwqrzn5gnwzc38drdmy8tnjpn864a3v4538tmtxky2x5cqp"
const RECEIPT = "resource_rdx1nfq47l0t7glmntfjuandqdmlejzvffq4cvlvrha94kqr52mdrvt2e7"
const NFT = "resource_rdx1ng3k9ll8yygujlamrszv5qu58nv9kqtala6cry2xql4006ccyrykdk"
const XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"
const SELLER = "account_rdx12y6ch4m8wjcgu7hrnwfqjeqt70w4kh7qy7k3gs2j9wyx3596fgt3fm"
const LEDGER = { network: "mainnet", state_version: 561291238, proposer_round_timestamp: "2026-10-06T06:32:14.487Z" }
const LEDGER_SECS = Math.floor(Date.parse(LEDGER.proposer_round_timestamp) / 1000)

const ok = (body: unknown) => ({ ok: true, json: () => Promise.resolve(body) }) as Response
const notOk = () => ({ ok: false, json: () => Promise.resolve({}) }) as Response
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body))
const pathOf = (call: unknown[]) => String(call[0]).slice(GATEWAY.length)

function componentDetails(next = 3, extra: Record<string, unknown> = {}) {
  return {
    ledger_state: LEDGER,
    items: [{
      address: SWAP,
      details: {
        type: "Component",
        blueprint_name: "NftSwap",
        package_address: "package_rdx1p53j5yst59jhgc8ljap7266sd0nxgm2lndp2z6a4ddsprkn7e9ssmv",
        state: {
          kind: "Tuple",
          type_name: "NftSwap",
          fields: [
            { kind: "Own", type_name: "KeyValueStore", field_name: "listings", value: KV },
            { kind: "U64", field_name: "next_listing_id", value: String(next) },
            { kind: "Reference", type_name: "ResourceAddress", field_name: "listing_receipt_manager", value: RECEIPT },
          ],
        },
        royalty_config: {
          is_enabled: true,
          method_rules: [
            { method_name: "list" },
            { method_name: "fill", royalty_amount: { unit: "XRD", amount: "0" } },
            { method_name: "extend_listing", royalty_amount: { unit: "XRD", amount: "2.5" } },
          ],
        },
        ...extra,
      },
    }],
  }
}

/** A Listed copy of mainnet listing 2 under another id, expiring at `exp`. */
function listedEntry(id: number, exp: number, seller = SELLER) {
  const e = JSON.parse(JSON.stringify(kvFixture.entries[1]))
  e.key.programmatic_json.value = String(id)
  const fs = e.value.programmatic_json.fields
  fs.find((f: any) => f.field_name === "state").variant_name = "Listed"
  fs.find((f: any) => f.field_name === "expires_at").value = String(exp)
  fs.find((f: any) => f.field_name === "seller").value = seller
  fs.find((f: any) => f.field_name === "asset_id").value = `#${id}#`
  return e
}

/** Replace an entry's asks with these, in the Gateway's programmatic JSON. */
function withAsks(e: any, asks: SwapAsk[]) {
  const ref = (resource: string) => ({ kind: "Reference", type_name: "ResourceAddress", field_name: "resource", value: resource })
  e.value.programmatic_json.fields.find((f: any) => f.field_name === "asks").elements = asks.map((a) =>
    a.kind === "fungible"
      ? { kind: "Enum", type_name: "Ask", variant_id: "0", variant_name: "Fungible", fields: [ref(a.resource), { kind: "Decimal", field_name: "amount", value: a.amount }] }
      : { kind: "Enum", type_name: "Ask", variant_id: "1", variant_name: "NonFungible", fields: [ref(a.resource), { kind: "NonFungibleLocalId", field_name: "id", value: a.id }] },
  )
  return e
}

/** `n` distinct, well-formed resource addresses. */
const resources = (n: number, c = "n") =>
  Array.from({ length: n }, (_, i) => `resource_rdx1${c.repeat(40)}${String(i).padStart(4, "0")}`)

let fetchSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  fetchSpy = vi.spyOn(global, "fetch")
  vi.spyOn(console, "error").mockImplementation(() => {})
  __resetSwapCachesForTests()
  vi.unstubAllEnvs()
})
afterEach(() => vi.restoreAllMocks())

describe("readSwapComponentState", () => {
  it("reads the KVS, the next id, the receipt resource, the live fees and the ledger clock in one call", async () => {
    fetchSpy.mockResolvedValueOnce(ok(componentDetails()))
    const s = await readSwapComponentState(SWAP)
    expect(s).toEqual({
      component: SWAP,
      listingsKvStore: KV,
      nextListingId: 3,
      receiptResource: RECEIPT,
      fees: { fill: { unit: "XRD", amount: "0" }, extend: { unit: "XRD", amount: "2.5" } },
      ledgerNow: LEDGER_SECS,
    })
    expect(pathOf(fetchSpy.mock.calls[0])).toBe("/state/entity/details")
    expect(bodyOf(fetchSpy.mock.calls[0])).toEqual({ addresses: [SWAP], opt_ins: { component_royalty_config: true } })
  })

  it("royalties switched off read as 0 XRD; an unreported rule reads null", async () => {
    fetchSpy.mockResolvedValueOnce(ok(componentDetails(3, { royalty_config: { is_enabled: false } })))
    expect((await readSwapComponentState(SWAP))!.fees).toEqual({
      fill: { unit: "XRD", amount: "0" },
      extend: { unit: "XRD", amount: "0" },
    })
    fetchSpy.mockResolvedValueOnce(ok(componentDetails(3, { royalty_config: { is_enabled: true, method_rules: [] } })))
    expect((await readSwapComponentState(SWAP))!.fees).toEqual({ fill: null, extend: null })
  })

  it("refuses anything that is not an NftSwap component — a wrong env address must not read as an empty board", async () => {
    fetchSpy.mockResolvedValueOnce(ok(componentDetails(3, { blueprint_name: "Escrow" })))
    expect(await readSwapComponentState(SWAP)).toBeNull()
  })

  it("with an expected package, refuses an NftSwap component instantiated from any other package", async () => {
    const live = "package_rdx1p53j5yst59jhgc8ljap7266sd0nxgm2lndp2z6a4ddsprkn7e9ssmv"
    fetchSpy.mockResolvedValueOnce(ok(componentDetails(3, { package_address: "package_rdx1pkgnotthelivepackagexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" })))
    expect(await readSwapComponentState(SWAP, live)).toBeNull()
    fetchSpy.mockResolvedValueOnce(ok(componentDetails(3)))
    expect(await readSwapComponentState(SWAP, live)).not.toBeNull()
  })

  // The List form calls it with no package: the pin must not depend on the caller.
  it("pins the live component to the live package by default, and no caller can unpin it", async () => {
    const other = "package_rdx1pkgnotthelivepackagexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    fetchSpy.mockResolvedValueOnce(ok(componentDetails(3, { package_address: other })))
    expect(await readSwapComponentState(SWAP)).toBeNull()
    fetchSpy.mockResolvedValueOnce(ok(componentDetails(3, { package_address: other })))
    expect(await readSwapComponentState(SWAP, other)).toBeNull()
    // Another component is checked by blueprint only unless a package is given.
    const elsewhere = "component_rdx1cqnotthelivecomponentxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    fetchSpy.mockResolvedValueOnce(ok(componentDetails(3, { package_address: other })))
    expect(await readSwapComponentState(elsewhere)).not.toBeNull()
  })

  it("null on non-2xx, a throw, or a missing ledger clock", async () => {
    fetchSpy.mockResolvedValueOnce(notOk())
    expect(await readSwapComponentState(SWAP)).toBeNull()
    fetchSpy.mockRejectedValueOnce(new Error("down"))
    expect(await readSwapComponentState(SWAP)).toBeNull()
    fetchSpy.mockResolvedValueOnce(ok({ ...componentDetails(), ledger_state: {} }))
    expect(await readSwapComponentState(SWAP)).toBeNull()
  })
})

describe("readSwapListingsById", () => {
  it("parses the mainnet entries and reports an absent id as missing", async () => {
    fetchSpy.mockResolvedValueOnce(ok(kvFixture))
    const r = await readSwapListingsById(KV, [1, 2, 3])
    expect(r!.listings.map((l) => [l.listingId, l.state])).toEqual([[1, "Filled"], [2, "Cancelled"]])
    expect(r!.missing).toEqual([3])
    expect(r!.unreadable).toEqual([])
    expect(bodyOf(fetchSpy.mock.calls[0]).keys[0]).toEqual({ key_json: { kind: "U64", value: "1" } })
  })

  it("batches at the Gateway's 100-key limit, and one failed batch fails the read", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => i + 1)
    fetchSpy.mockResolvedValueOnce(ok({ ledger_state: LEDGER, entries: [] })).mockResolvedValueOnce(notOk())
    expect(await readSwapListingsById(KV, ids)).toBeNull()
    expect(bodyOf(fetchSpy.mock.calls[0]).keys).toHaveLength(100)
    expect(bodyOf(fetchSpy.mock.calls[1]).keys).toHaveLength(50)
  })

  it("sends every batch at once — a cold board waits one round trip, not ten", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => i + 1)
    const pending: ((r: Response) => void)[] = []
    fetchSpy.mockImplementation(() => new Promise<Response>((r) => pending.push(r)))
    const read = readSwapListingsById(KV, ids)
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    for (const r of pending) r(ok({ ledger_state: LEDGER, entries: [] }))
    expect((await read)!.missing).toHaveLength(250)
  })

  it("an entry that does not parse is reported, not dropped", async () => {
    const bad = JSON.parse(JSON.stringify(kvFixture))
    bad.entries[0].value.programmatic_json.fields[0].value = "not-an-account"
    fetchSpy.mockResolvedValueOnce(ok(bad))
    const r = await readSwapListingsById(KV, [1, 2])
    expect(r!.unreadable).toEqual([1])
    expect(r!.listings.map((l) => l.listingId)).toEqual([2])
  })
})

describe("readSwapBoard", () => {
  it("reads every id below next_listing_id, newest first", async () => {
    fetchSpy.mockResolvedValueOnce(ok(componentDetails(3))).mockResolvedValueOnce(ok(kvFixture))
    const b = await readSwapBoard(SWAP)
    expect(b!.listings.map((l) => l.listingId)).toEqual([2, 1])
    expect(b!.total).toBe(2)
    expect(b!.truncated).toBe(false)
  })

  it("an empty component is an empty board, with no listing read at all", async () => {
    fetchSpy.mockResolvedValueOnce(ok(componentDetails(1)))
    const b = await readSwapBoard(SWAP)
    expect(b!.listings).toEqual([])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("past the scan cap it reads the newest 1000 and says so", async () => {
    fetchSpy.mockResolvedValueOnce(ok(componentDetails(1501)))
    for (let i = 0; i < 10; i++) fetchSpy.mockResolvedValueOnce(ok({ ledger_state: LEDGER, entries: [] }))
    const b = await readSwapBoard(SWAP)
    expect(b!.truncated).toBe(true)
    expect(b!.total).toBe(1500)
    expect(bodyOf(fetchSpy.mock.calls[1]).keys[0].key_json.value).toBe("1500")
    expect(fetchSpy).toHaveBeenCalledTimes(11)
    // Ids that exist but returned no entry are reported, never silently gone.
    expect(b!.unreadable).toHaveLength(1000)
  })
})

describe("readListingReceiptHolder", () => {
  const location = (items: unknown[]) => ok({ non_fungible_ids: items })
  it("the holder, or burned", async () => {
    fetchSpy.mockResolvedValueOnce(location([{ non_fungible_id: "#2#", is_burned: false, owning_vault_global_ancestor_address: SELLER }]))
    expect(await readListingReceiptHolder(RECEIPT, 2)).toEqual({ holder: SELLER, burned: false })
    fetchSpy.mockResolvedValueOnce(location([{ non_fungible_id: "#2#", is_burned: true }]))
    expect(await readListingReceiptHolder(RECEIPT, 2)).toEqual({ holder: null, burned: true })
  })
  // list() mints the receipt in the same transaction, so for a listing that
  // exists "not minted" is only a replica behind: unknown, not "no holder".
  it("a receipt the Gateway does not know yet is unknown (null)", async () => {
    fetchSpy.mockResolvedValueOnce(location([]))
    expect(await readListingReceiptHolder(RECEIPT, 2)).toBeNull()
  })
})

describe("readListedListingId", () => {
  it("reads listing_id from the proving run's own list transaction", async () => {
    fetchSpy.mockResolvedValueOnce(ok(listedTx))
    expect(await readListedListingId("txid_rdx1hdkp85sp42r5eragxpjm3vt8d58ggf0hjwlsgkt3p8rjaddtmhxsp6gjq6", SWAP)).toBe(1)
  })
  it("null when the event came from another component, or the tx did not succeed", async () => {
    fetchSpy.mockResolvedValueOnce(ok(listedTx))
    expect(await readListedListingId("txid", "component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly")).toBeNull()
    fetchSpy.mockResolvedValueOnce(ok({ transaction: { ...listedTx.transaction, transaction_status: "CommittedFailure" } }))
    expect(await readListedListingId("txid", SWAP)).toBeNull()
  })
})

describe("display readers", () => {
  it("readResourceDisplay: kind, divisibility, name, and the withdrawer rule; batches of 20", async () => {
    const item = (address: string, type: string, rule: string, extra: object = {}) => ({
      address,
      metadata: { items: [{ key: "name", value: { typed: { value: `name of ${address.slice(-4)}` } } }, { key: "icon_url", value: { typed: { value: "http://insecure.example/x.png" } } }] },
      details: { type, role_assignments: { entries: [{ role_key: { name: "withdrawer" }, assignment: { explicit_rule: { type: rule } } }] }, ...extra },
    })
    const many = Array.from({ length: 21 }, (_, i) => `resource_rdx1${"q".repeat(40)}${String(i).padStart(4, "0")}`)
    fetchSpy
      .mockResolvedValueOnce(ok({ items: [item(XRD, "FungibleResource", "AllowAll", { divisibility: 18 }), item(NFT, "NonFungibleResource", "DenyAll")] }))
      .mockResolvedValueOnce(ok({ items: [] }))
    const m = await readResourceDisplay([XRD, NFT, ...many.slice(0, 19), XRD])
    expect(m!.get(XRD)).toMatchObject({ kind: "fungible", divisibility: 18, withdraw: "open", iconUrl: null })
    expect(m!.get(NFT)).toMatchObject({ kind: "nonFungible", divisibility: null, withdraw: "denied" })
    expect(bodyOf(fetchSpy.mock.calls[0]).addresses).toHaveLength(20)
    expect(bodyOf(fetchSpy.mock.calls[1]).addresses).toHaveLength(1)
  })

  it("readNftDisplay: the Radix display fields, with only https images", async () => {
    fetchSpy.mockResolvedValueOnce(ok({
      non_fungible_ids: [
        { non_fungible_id: "#1#", is_burned: false, data: { programmatic_json: { fields: [{ field_name: "name", value: "Guild swap throwaway 1" }, { field_name: "key_image_url", value: "https://img.example/1.png" }] } } },
        { non_fungible_id: "#2#", is_burned: true, data: { programmatic_json: { fields: [{ field_name: "key_image_url", value: "javascript:alert(1)" }] } } },
      ],
    }))
    const m = await readNftDisplay(NFT, ["#1#", "#2#", "#1#"])
    expect(m!.get("#1#")).toEqual({ id: "#1#", name: "Guild swap throwaway 1", imageUrl: "https://img.example/1.png", burned: false })
    expect(m!.get("#2#")).toEqual({ id: "#2#", name: null, imageUrl: null, burned: true })
    expect(bodyOf(fetchSpy.mock.calls[0]).non_fungible_ids).toEqual(["#1#", "#2#"])
  })

  it("readAccountNonFungibles: ids across vaults, with the more-flags rather than a silent cut", async () => {
    fetchSpy.mockResolvedValueOnce(ok({
      items: [
        { resource_address: NFT, vaults: { items: [{ items: ["#1#"] }, { items: ["#2#"], next_cursor: "c" }] } },
        { resource_address: RECEIPT, vaults: { items: [{ items: [] }] } },
      ],
      next_cursor: "more",
    }))
    expect(await readAccountNonFungibles(SELLER)).toEqual({
      groups: [{ resource: NFT, ids: ["#1#", "#2#"], more: true }],
      moreResources: true,
    })
  })

  it("readAccountNonFungibles: an empty account, and an emptied vault, are not failures", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ items: [] }))
    expect(await readAccountNonFungibles(SELLER)).toEqual({ groups: [], moreResources: false })
    fetchSpy.mockResolvedValueOnce(ok({ items: [{ resource_address: NFT, vaults: { items: [{ total_count: 0 }, { total_count: 1, items: ["#3#"] }] } }] }))
    expect(await readAccountNonFungibles(SELLER)).toEqual({ groups: [{ resource: NFT, ids: ["#3#"], more: false }], moreResources: false })
  })

  // A shape it does not know must read "could not read", never "holds no NFTs".
  it.each([
    ["a renamed vault list", { resource_address: NFT, vaults: { entries: [{ items: ["#1#"] }] } }],
    ["a vault with NFTs but no id list", { resource_address: NFT, vaults: { items: [{ total_count: 2, nfids: ["#1#", "#2#"] }] } }],
    ["an id that is not a local id", { resource_address: NFT, vaults: { items: [{ total_count: 1, items: ["1"] }] } }],
    ["a resource that is not an address", { resource_address: "x", vaults: { items: [] } }],
  ])("readAccountNonFungibles: null on %s", async (_label, item) => {
    fetchSpy.mockResolvedValueOnce(ok({ items: [item] }))
    expect(await readAccountNonFungibles(SELLER)).toBeNull()
  })
})

// ── The service and the routes ──────────────────────────────────────────────

type Handler = (body: any) => Response | Promise<Response>

/** Route the Gateway by path, so call order does not matter. `resourceRead`
 *  answers entity/details for anything but the component, `nftRead`
 *  non-fungible/data, `onComponent` runs before each component read. */
function gatewayStub(
  opts: {
    entries?: unknown[]
    next?: number
    holder?: string
    failComponent?: boolean
    resourceRead?: Handler
    nftRead?: Handler
    onComponent?: () => void
  } = {},
) {
  fetchSpy.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const path = String(url).slice(GATEWAY.length)
    const body = JSON.parse(String(init?.body ?? "{}"))
    if (path === "/state/entity/details") {
      if (body.addresses?.[0] === SWAP) {
        opts.onComponent?.()
        return opts.failComponent ? notOk() : ok(componentDetails(opts.next ?? 3))
      }
      return opts.resourceRead ? opts.resourceRead(body) : ok({ items: [] })
    }
    if (path === "/state/key-value-store/data") {
      const want = new Set(body.keys.map((k: any) => k.key_json.value))
      const entries = (opts.entries ?? kvFixture.entries).filter((e: any) => want.has(e.key.programmatic_json.value))
      return ok({ ledger_state: LEDGER, key_value_store_address: KV, entries })
    }
    if (path === "/state/non-fungible/data") return opts.nftRead ? opts.nftRead(body) : ok({ non_fungible_ids: [] })
    if (path === "/state/non-fungible/location") {
      return ok({ non_fungible_ids: [{ non_fungible_id: body.non_fungible_ids[0], is_burned: false, owning_vault_global_ancestor_address: opts.holder ?? SELLER }] })
    }
    return notOk()
  })
}

describe("getSwapBoard / getSwapDetail", () => {
  const open = LEDGER_SECS + 86400
  const lapsed = LEDGER_SECS - 60
  const OTHER = "account_rdx12y5senkxfxg38swfv4tg88lx73jqnkdvcnzv8kwwdmg0efl40r2p7u"
  const entries = () => [...kvFixture.entries, listedEntry(3, open), listedEntry(4, lapsed, OTHER)]

  it("filters by status at the ledger clock, by seller, and pages by cursor", async () => {
    gatewayStub({ entries: entries(), next: 5 })
    const all = await getSwapBoard({})
    expect(all!.listings.map((l) => [l.listingId, l.status])).toEqual([[4, "expired"], [3, "open"], [2, "cancelled"], [1, "filled"]])
    expect((await getSwapBoard({ status: "open" }))!.listings.map((l) => l.listingId)).toEqual([3])
    expect((await getSwapBoard({ seller: OTHER }))!.listings.map((l) => l.listingId)).toEqual([4])
    const page1 = await getSwapBoard({ limit: 2 })
    expect(page1!.nextCursor).toBe(3)
    expect((await getSwapBoard({ limit: 2, before: 3 }))!.listings.map((l) => l.listingId)).toEqual([2, 1])
  })

  it("caches the board for a burst — one component read for several views", async () => {
    gatewayStub({ entries: entries(), next: 5 })
    await getSwapBoard({})
    await getSwapBoard({ status: "open" })
    const componentReads = fetchSpy.mock.calls.filter((c) => bodyOf(c).addresses?.[0] === SWAP)
    expect(componentReads).toHaveLength(1)
  })

  it("the operator's hide list takes listings off the public board, but never locks out their receipt holder", async () => {
    vi.stubEnv("NFT_SWAP_HIDDEN", `3, ${NFT}x`)
    gatewayStub({ entries: entries(), next: 5 })
    const b = await getSwapBoard({})
    expect(b!.listings.map((l) => l.listingId)).not.toContain(3)
    expect(b!.hidden).toBe(1)
    // The seller's own view still lists it — flagged, with no NFT name or picture.
    const mine = await getSwapBoard({ seller: SELLER })
    const three = mine!.listings.find((l) => l.listingId === 3)!
    expect(three.hidden).toBe(true)
    expect(three.asset).toEqual({ name: null, imageUrl: null })
    // Its page still answers, so the receipt holder can cancel or collect.
    const d = await getSwapDetail(3)
    expect(d.kind).toBe("ok")
    if (d.kind === "ok") {
      expect(d.view.listing.hidden).toBe(true)
      expect(d.view.receipt).toEqual({ holder: SELLER, burned: false })
    }
  })

  it("concurrent board misses share one chain read", async () => {
    gatewayStub({ entries: entries(), next: 5 })
    await Promise.all([getSwapBoard({}), getSwapBoard({ status: "open" }), getSwapBoard({ limit: 1 })])
    const componentReads = fetchSpy.mock.calls.filter((c) => bodyOf(c).addresses?.[0] === SWAP)
    expect(componentReads).toHaveLength(1)
  })

  it("getSwapDetail: the listing, the receipt holder and the fees; not_found past the last id", async () => {
    gatewayStub({ entries: entries(), next: 5, holder: OTHER })
    const r = await getSwapDetail(3)
    expect(r.kind).toBe("ok")
    if (r.kind !== "ok") return
    expect(r.view.listing.status).toBe("open")
    expect(r.view.receipt).toEqual({ holder: OTHER, burned: false })
    expect(r.view.fees.extend).toEqual({ unit: "XRD", amount: "2.5" })
    expect(await getSwapDetail(5)).toEqual({ kind: "not_found" })
  })

  it("unknown when the chain cannot be read", async () => {
    gatewayStub({ failComponent: true })
    expect(await getSwapBoard({})).toBeNull()
    expect(await getSwapDetail(1)).toEqual({ kind: "unknown" })
  })

  // Display data for whatever a resource read returns: every address a name.
  const named: Handler = (body) =>
    ok({
      items: body.addresses.map((address: string) => ({
        address,
        metadata: { items: [{ key: "name", value: { typed: { value: "Stranger's name" } } }] },
        details: address === XRD ? { type: "FungibleResource", divisibility: 18 } : { type: "NonFungibleResource" },
      })),
    })
  const resourceReads = () =>
    fetchSpy.mock.calls.filter((c) => pathOf(c) === "/state/entity/details" && bodyOf(c).addresses[0] !== SWAP)
  const nftReads = () => fetchSpy.mock.calls.filter((c) => pathOf(c) === "/state/non-fungible/data")

  // The asks are a stranger's to write and the blueprint sets no limit.
  it("a listing with 300 asks: its page looks up the first 8, at most 4 at a time, and says there are more", async () => {
    const askRes = resources(300)
    const big = withAsks(listedEntry(3, open), askRes.map((resource) => ({ kind: "nonFungible", resource, id: "#1#" })))
    let inFlight = 0
    let peak = 0
    gatewayStub({
      entries: [...kvFixture.entries, big],
      next: 4,
      resourceRead: named,
      nftRead: async () => {
        peak = Math.max(peak, ++inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        return ok({ non_fungible_ids: [] })
      },
    })
    const r = await getSwapDetail(3)
    expect(r.kind).toBe("ok")
    if (r.kind !== "ok") return
    expect(r.view.moreAsks).toBe(true)
    expect(DETAIL_ASK_DISPLAY_CAP).toBe(8)
    // The listed NFT's collection + the first 8 asks'.
    expect(nftReads().map((c) => bodyOf(c).resource_address)).toEqual(expect.arrayContaining([NFT, ...askRes.slice(0, 8)]))
    expect(nftReads()).toHaveLength(9)
    expect(peak).toBeLessThanOrEqual(4)
    expect(resourceReads().flatMap((c) => bodyOf(c).addresses).sort()).toEqual([NFT, ...askRes.slice(0, 8)].sort())
    expect(Object.keys(r.view.resources)).toHaveLength(9)

    // A card names its first ask only, so the board looks up nothing past it.
    fetchSpy.mockClear()
    const b = await getSwapBoard({})
    expect(b!.listings).toHaveLength(3)
    expect(resourceReads().flatMap((c) => bodyOf(c).addresses)).not.toContain(askRes[1])
    expect(nftReads().map((c) => bodyOf(c).resource_address)).toEqual([NFT])
  })

  it("a failed display lookup is not retried for 30 s — a bad address must not cost a Gateway call per view", async () => {
    let clock = 1_800_000_000_000
    vi.spyOn(Date, "now").mockImplementation(() => clock)
    gatewayStub({ entries: entries(), next: 5, resourceRead: () => notOk(), nftRead: () => notOk() })
    await getSwapDetail(3)
    await getSwapDetail(3)
    expect(resourceReads()).toHaveLength(1)
    expect(nftReads()).toHaveLength(1)
    clock += 31_000
    await getSwapDetail(3)
    expect(resourceReads()).toHaveLength(2)
    expect(nftReads()).toHaveLength(2)
  })

  it("resource lookups are cached a batch of 20 at a time — one failed batch does not blank the page", async () => {
    const asked = resources(25, "f")
    const poison = asked[24]
    const many = asked.map((r, i) => withAsks(listedEntry(3 + i, open), [{ kind: "fungible", resource: r, amount: "1" }]))
    gatewayStub({
      entries: [...kvFixture.entries, ...many],
      next: 28,
      resourceRead: (body) => (body.addresses.includes(poison) ? notOk() : named(body)),
    })
    const b = await getSwapBoard({})
    expect(resourceReads()).toHaveLength(2)
    expect(b!.resources[asked[0]]).toBeDefined()
    expect(b!.resources[XRD]).toBeDefined()
    expect(b!.resources[poison]).toBeUndefined()
  })

  it("a hidden listing serves nothing a stranger wrote — no NFT, ask or collection names, only XRD's own", async () => {
    vi.stubEnv("NFT_SWAP_HIDDEN", "3")
    const [askNft, askToken] = resources(2)
    const hiddenOne = withAsks(listedEntry(3, open), [
      { kind: "nonFungible", resource: askNft, id: "#1#" },
      { kind: "fungible", resource: XRD, amount: "10" },
      { kind: "fungible", resource: askToken, amount: "1" },
    ])
    gatewayStub({ entries: [...kvFixture.entries, hiddenOne], next: 4, resourceRead: named })
    const d = await getSwapDetail(3)
    expect(d.kind).toBe("ok")
    if (d.kind !== "ok") return
    expect(d.view.listing.hidden).toBe(true)
    expect(d.view.listing.asset).toEqual({ name: null, imageUrl: null })
    expect(Object.keys(d.view.resources)).toEqual([XRD])
    expect(d.view.askNfts).toEqual({})
    expect(nftReads()).toHaveLength(0)

    // The seller's own board view: listed, flagged, and still nameless.
    const mine = await getSwapBoard({ seller: SELLER })
    expect(mine!.listings.map((l) => l.listingId)).toContain(3)
    expect(mine!.resources[askNft]).toBeUndefined()
    expect(mine!.resources[NFT]).toBeDefined() // listings 1 and 2 are not hidden
  })

  it("the board cache is stamped when the read starts: a 20 s read is not served as fresh 1 s later", async () => {
    let clock = 1_800_000_000_000
    vi.spyOn(Date, "now").mockImplementation(() => clock)
    gatewayStub({ entries: entries(), next: 5, onComponent: () => void (clock += 20_000) })
    await getSwapBoard({})
    clock += 1_000
    await getSwapBoard({})
    expect(fetchSpy.mock.calls.filter((c) => bodyOf(c).addresses?.[0] === SWAP)).toHaveLength(2)
  })

  it("a malformed NFT_SWAP_HIDDEN token is logged once, not dropped silently", async () => {
    vi.stubEnv("NFT_SWAP_HIDDEN", "3, 4;5")
    gatewayStub({ entries: entries(), next: 5 })
    await getSwapBoard({})
    await getSwapBoard({ status: "open" })
    await getSwapDetail(3)
    const logged = vi.mocked(console.error).mock.calls.filter((c) => String(c[0]).includes("NFT_SWAP_HIDDEN"))
    expect(logged).toHaveLength(1)
    expect(String(logged[0][0])).toContain("4;5")
  })

  it("a receipt the Gateway has not indexed yet reads unknown on the page, not 'no holder'", async () => {
    gatewayStub({ entries: entries(), next: 5 })
    fetchSpy.mockImplementation(((orig) => async (url: unknown, init?: RequestInit) =>
      String(url).endsWith("/state/non-fungible/location") ? ok({ non_fungible_ids: [] }) : orig(url, init))(
      fetchSpy.getMockImplementation()!,
    ))
    const d = await getSwapDetail(3)
    expect(d.kind === "ok" && d.view.receipt).toBeNull()
  })
})

describe("GET /api/v1/swaps and /api/v1/swaps/{id}", () => {
  // A distinct client address per request, so the per-address limiter never
  // trips across tests; one test drives it on purpose.
  let n = 0
  const req = (q: string, ip = `10.0.0.${++n}`) =>
    new Request(`http://x/api/v1/swaps${q}`, { headers: { "x-forwarded-for": ip } }) as any

  it("refuses bad filters with a named code", async () => {
    for (const [q, code] of [
      ["?status=sold", "INVALID_STATUS"],
      ["?seller=bob", "INVALID_SELLER"],
      ["?before=0", "INVALID_CURSOR"],
      ["?limit=500", "INVALID_LIMIT"],
    ]) {
      const res = await getBoardRoute(req(q))
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe(code)
    }
  })

  it("503 CHAIN_UNREADABLE, never an empty board, when the Gateway fails", async () => {
    gatewayStub({ failComponent: true })
    const res = await getBoardRoute(req(""))
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe("CHAIN_UNREADABLE")
  })

  it("200 with the board", async () => {
    gatewayStub()
    const res = await getBoardRoute(req("?status=all"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.listings).toHaveLength(2)
    expect(body.data.component).toBe(SWAP)
  })

  it("the detail route: 400 on a non-integer id, 404 past the last listing, 200 with the record", async () => {
    gatewayStub()
    const call = async (id: string) =>
      getDetailRoute(new Request("http://x", { headers: { "x-forwarded-for": `10.1.0.${++n}` } }) as any, {
        params: Promise.resolve({ id }),
      })
    expect((await call("1e3")).status).toBe(400)
    expect((await call("0")).status).toBe(400)
    expect((await call("9")).status).toBe(404)
    const res = await call("1")
    expect(res.status).toBe(200)
    expect((await res.json()).data.listing.state).toBe("Filled")
  })

  it("rate-limits one address at 60 a minute", async () => {
    gatewayStub()
    let last = 0
    for (let i = 0; i < 61; i++) last = (await getBoardRoute(req("?status=sold", "10.9.9.9"))).status
    expect(last).toBe(429)
  })
})
