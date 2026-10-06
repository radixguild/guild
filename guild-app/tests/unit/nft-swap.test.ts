// The swap model (src/lib/nft-swap.ts) against the live component's own
// records: tests/fixtures/nft-swap/listings-kv-mainnet-2026-10-06.json is the
// Gateway's key-value-store/data answer for listings 1-3 on
// component_rdx1cq80zarwh84mmrkn95xc7glgg5yvz0vkvqs9amxsnpwxuhkldd5mp4, read
// 2026-10-06 (listing 1 filled and withdrawn, listing 2 cancelled, 3 absent).
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  askProblems,
  canonicalLocalId,
  displayText,
  expiryForDays,
  extendedExpiry,
  formatAmount,
  isHidden,
  MAX_LISTING_HORIZON_SECS,
  normalizeDecimal,
  parseHiddenList,
  parseSwapListing,
  proceedsOwed,
  receiptBurnable,
  safeImageUrl,
  sameAsk,
  shortAddress,
  swapStatus,
  type AskResourceKind,
  type SwapAsk,
  type SwapListing,
} from "@/lib/nft-swap"

const kv = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "nft-swap", "listings-kv-mainnet-2026-10-06.json"), "utf8"),
)
const XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"
const NFT = "resource_rdx1ng3k9ll8yygujlamrszv5qu58nv9kqtala6cry2xql4006ccyrykdk"
const SELLER = "account_rdx12y6ch4m8wjcgu7hrnwfqjeqt70w4kh7qy7k3gs2j9wyx3596fgt3fm"
const entry = (id: number) => kv.entries.find((e: any) => e.key.programmatic_json.value === String(id))
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))

describe("parseSwapListing — the two live listings", () => {
  it("listing 1: filled with alternative 0, proceeds withdrawn", () => {
    expect(parseSwapListing(1, entry(1).value.programmatic_json)).toEqual({
      listingId: 1,
      seller: SELLER,
      assetResource: NFT,
      assetId: "#1#",
      asks: [{ kind: "fungible", resource: XRD, amount: "1" }],
      createdAt: 1789514014,
      expiresAt: 1790114665,
      state: "Filled",
      filledWith: 0,
      proceedsWithdrawn: true,
    } satisfies SwapListing)
  })

  it("listing 2: cancelled, never filled", () => {
    const l = parseSwapListing(2, entry(2).value.programmatic_json)!
    expect(l.state).toBe("Cancelled")
    expect(l.filledWith).toBeNull()
    expect(l.proceedsWithdrawn).toBe(false)
    expect(l.asks).toEqual([{ kind: "fungible", resource: XRD, amount: "5000" }])
  })

  it("reads a NonFungible alternative", () => {
    const json = clone(entry(2).value.programmatic_json)
    const asks = json.fields.find((f: any) => f.field_name === "asks")
    asks.elements.push({
      kind: "Enum", type_name: "Ask", variant_id: "1", variant_name: "NonFungible",
      fields: [
        { kind: "Reference", type_name: "ResourceAddress", field_name: "resource", value: NFT },
        { kind: "NonFungibleLocalId", field_name: "id", value: "<gold_1>" },
      ],
    })
    expect(parseSwapListing(2, json)!.asks[1]).toEqual({ kind: "nonFungible", resource: NFT, id: "<gold_1>" })
  })

  // Fail closed: each of these is a shape the blueprint cannot produce, and a
  // guess would show a stranger the wrong terms — or shift an alternative index.
  const mutate = (fn: (fields: any[]) => void) => {
    const json = clone(entry(1).value.programmatic_json)
    fn(json.fields)
    return parseSwapListing(1, json)
  }
  const fieldOf = (fields: any[], name: string) => fields.find((f) => f.field_name === name)

  it.each([
    ["a seller that is not an account", (fs: any[]) => (fieldOf(fs, "seller").value = "component_rdx1cq80zarwh84mmrkn95xc7glgg5yvz0vkvqs9amxsnpwxuhkldd5mp4")],
    ["no alternatives", (fs: any[]) => (fieldOf(fs, "asks").elements = [])],
    ["an unknown Ask variant", (fs: any[]) => (fieldOf(fs, "asks").elements[0].variant_name = "Bundle")],
    ["an amount that is not a decimal", (fs: any[]) => (fieldOf(fs, "asks").elements[0].fields[1].value = "1e3")],
    ["an unknown state", (fs: any[]) => (fieldOf(fs, "state").variant_name = "Disputed")],
    ["Filled without filled_with", (fs: any[]) => Object.assign(fieldOf(fs, "filled_with"), { variant_name: "None", fields: [] })],
    ["filled_with past the last alternative", (fs: any[]) => (fieldOf(fs, "filled_with").fields[0].value = "1")],
    ["an expiry that is not a positive integer", (fs: any[]) => (fieldOf(fs, "expires_at").value = "-5")],
    ["a non-bool proceeds_withdrawn", (fs: any[]) => (fieldOf(fs, "proceeds_withdrawn").value = 1)],
    ["a hostile local id", (fs: any[]) => (fieldOf(fs, "asset_id").value = '#1#")')],
  ])("null on %s", (_label, fn) => {
    expect(mutate(fn)).toBeNull()
  })

  it("null on a non-object", () => {
    expect(parseSwapListing(1, null)).toBeNull()
    expect(parseSwapListing(1, { fields: "x" })).toBeNull()
  })
})

describe("status and what each state allows", () => {
  const listed = (expiresAt: number): SwapListing => ({
    ...parseSwapListing(2, entry(2).value.programmatic_json)!,
    state: "Listed",
    expiresAt,
  })
  it("Listed reads open strictly before expiry, expired from the expiry second on (fill asserts now < expires_at)", () => {
    expect(swapStatus(listed(1000), 999)).toBe("open")
    expect(swapStatus(listed(1000), 1000)).toBe("expired")
  })
  it("terminal states ignore the clock", () => {
    const filled = parseSwapListing(1, entry(1).value.programmatic_json)!
    const cancelled = parseSwapListing(2, entry(2).value.programmatic_json)!
    expect(swapStatus(filled, 0)).toBe("filled")
    expect(swapStatus(cancelled, 0)).toBe("cancelled")
    expect(proceedsOwed(filled)).toBe(false)
    expect(proceedsOwed({ ...filled, proceedsWithdrawn: false })).toBe(true)
    expect(receiptBurnable(filled)).toBe(true)
    expect(receiptBurnable(cancelled)).toBe(true)
    expect(receiptBurnable({ ...filled, proceedsWithdrawn: false })).toBe(false)
    expect(receiptBurnable(listed(1000))).toBe(false)
  })
  it("extend_listing adds 30 days to max(now, expiry) — a lapsed listing extends from now", () => {
    expect(extendedExpiry(listed(5000), 1000)).toBe(5000 + MAX_LISTING_HORIZON_SECS)
    expect(extendedExpiry(listed(1000), 5000)).toBe(5000 + MAX_LISTING_HORIZON_SECS)
  })
})

describe("expiryForDays stays inside the 30-day ceiling list() enforces", () => {
  const now = 1_790_000_000
  it("whole days from the ledger clock", () => {
    expect(expiryForDays(now, 7)).toBe(now + 7 * 86400)
  })
  it("30 days is pulled in by the margin, never over the ceiling", () => {
    expect(expiryForDays(now, 30)).toBeLessThan(now + MAX_LISTING_HORIZON_SECS)
    expect(expiryForDays(now, 30)).toBeGreaterThan(now + 29 * 86400)
  })
  it("clamps nonsense to 1..30 days", () => {
    expect(expiryForDays(now, 0)).toBe(now + 86400)
    expect(expiryForDays(now, 90)).toBe(expiryForDays(now, 30))
  })
})

describe("askProblems — the list() checks, before the wallet opens", () => {
  const kinds: Record<string, AskResourceKind> = {
    [XRD]: { kind: "fungible", divisibility: 18 },
    [NFT]: { kind: "nonFungible" },
    resource_rdx1tfakedivisibilitytwoxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx: { kind: "fungible", divisibility: 2 },
  }
  const kindOf = (r: string) => kinds[r] ?? null
  const XUSD = "resource_rdx1tfakedivisibilitytwoxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  const run = (asks: SwapAsk[]) => askProblems(asks, kindOf, { resource: NFT, id: "#1#" })

  it("clean asks pass", () => {
    expect(run([{ kind: "fungible", resource: XRD, amount: "5000" }, { kind: "nonFungible", resource: NFT, id: "#2#" }])).toEqual([null, null])
  })
  it("duplicates by VALUE, the way the blueprint's PartialEq sees Decimals", () => {
    expect(run([{ kind: "fungible", resource: XRD, amount: "5" }, { kind: "fungible", resource: XRD, amount: "5.000" }])).toEqual([null, "duplicate"])
  })
  it("divisibility is the resource's own", () => {
    expect(run([{ kind: "fungible", resource: XUSD, amount: "1.005" }])).toEqual(["too_precise"])
    expect(run([{ kind: "fungible", resource: XUSD, amount: "1.50" }])).toEqual([null])
  })
  it("refuses the asks that would make an unfillable listing", () => {
    expect(run([{ kind: "fungible", resource: XRD, amount: "0.0" }])).toEqual(["zero_amount"])
    expect(run([{ kind: "fungible", resource: NFT, amount: "1" }])).toEqual(["not_fungible"])
    expect(run([{ kind: "nonFungible", resource: XRD, id: "#1#" }])).toEqual(["not_non_fungible"])
    expect(run([{ kind: "nonFungible", resource: NFT, id: "#1#" }])).toEqual(["same_as_asset"])
    expect(run([{ kind: "fungible", resource: "resource_rdx1unknownunknownunknownunknown", amount: "1" }])).toEqual(["bad_resource"])
  })
  // The ledger parses "#01#" as integer 1 and hex in either case, so these
  // are the same NFT and list() would see the same ask.
  it("compares NFT ids in their canonical form", () => {
    expect(run([{ kind: "nonFungible", resource: NFT, id: "#001#" }])).toEqual(["same_as_asset"])
    expect(run([{ kind: "nonFungible", resource: NFT, id: "#2#" }, { kind: "nonFungible", resource: NFT, id: "#02#" }])).toEqual([null, "duplicate"])
    expect(run([{ kind: "nonFungible", resource: NFT, id: "[ab01]" }, { kind: "nonFungible", resource: NFT, id: "[AB01]" }])).toEqual([null, "duplicate"])
    expect(run([{ kind: "nonFungible", resource: NFT, id: "<Gold>" }, { kind: "nonFungible", resource: NFT, id: "<gold>" }])).toEqual([null, null])
  })
})

describe("canonicalLocalId", () => {
  it.each([
    ["#007#", "#7#"],
    ["#0#", "#0#"],
    ["#000#", "#0#"],
    ["#10#", "#10#"],
    ["[ABcd]", "[abcd]"],
    ["{AAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBB-CCCCCCCCCCCCCCCC-DDDDDDDDDDDDDDDD}", "{aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-cccccccccccccccc-dddddddddddddddd}"],
    ["<Gold_01>", "<Gold_01>"],
    ["not an id", "not an id"],
  ])("%s → %s", (raw, canonical) => {
    expect(canonicalLocalId(raw)).toBe(canonical)
  })
})

describe("display helpers", () => {
  it("normalizeDecimal / sameAsk", () => {
    expect(normalizeDecimal("0005000.5000")).toBe("5000.5")
    expect(normalizeDecimal("1.000")).toBe("1")
    expect(normalizeDecimal("0.0")).toBe("0")
    expect(sameAsk({ kind: "fungible", resource: XRD, amount: "1" }, { kind: "fungible", resource: XRD, amount: "1.0" })).toBe(true)
    expect(sameAsk({ kind: "fungible", resource: XRD, amount: "1" }, { kind: "nonFungible", resource: XRD, id: "#1#" })).toBe(false)
  })
  it("formatAmount is exact — no float on the way", () => {
    expect(formatAmount("1234567.123456789012345678")).toBe("1,234,567.123456789012345678")
    expect(formatAmount("5000")).toBe("5,000")
  })
  it("shortAddress keeps the network prefix and the tail", () => {
    expect(shortAddress(SELLER)).toBe("account_rdx12y6c…fgt3fm")
  })
  it("only https image URLs", () => {
    expect(safeImageUrl("https://example.com/a.png")).toBe("https://example.com/a.png")
    expect(safeImageUrl("http://example.com/a.png")).toBeNull()
    expect(safeImageUrl("javascript:alert(1)")).toBeNull()
    expect(safeImageUrl("data:image/png;base64,AAAA")).toBeNull()
    expect(safeImageUrl(42)).toBeNull()
  })
  // Every viewer's browser fetches these, so none may point into the
  // viewer's own network or carry credentials.
  it.each([
    "https://192.168.0.1/x",
    "https://0x7f.1/x",
    "https://[::1]/x",
    "https://localhost/x",
    "https://router.localhost/x",
    "https://printer.local/x",
    "https://nas.internal/x",
    "https://intranet/x",
    "https://user:p@a.com/x",
    "https://user@a.com/x",
    "https://a.com:8443/x",
  ])("refuses %s", (u) => {
    expect(safeImageUrl(u)).toBeNull()
  })
  it("keeps ordinary public hosts, the default port included", () => {
    expect(safeImageUrl("https://ipfs.io/ipfs/abc")).toBe("https://ipfs.io/ipfs/abc")
    expect(safeImageUrl("https://a.com:443/x.png")).toBe("https://a.com/x.png")
  })
  it("displayText strips control and bidi characters and bounds the length", () => {
    expect(displayText("  Wefty‮ V2\n")).toBe("Wefty V2")
    expect(displayText("x".repeat(100), 10)).toBe("xxxxxxxxx…")
    expect(displayText("   ")).toBeNull()
  })
})

describe("the operator's hide list", () => {
  const l = parseSwapListing(1, entry(1).value.programmatic_json)!
  it("hides by listing id, by the listed resource, or by an asked-for resource", () => {
    expect(isHidden(l, parseHiddenList("1"))).toBe(true)
    expect(isHidden(l, parseHiddenList(` ${NFT} `))).toBe(true)
    expect(isHidden(l, parseHiddenList(XRD))).toBe(true)
    expect(isHidden(l, parseHiddenList("2, junk,"))).toBe(false)
    expect(isHidden(l, parseHiddenList(undefined))).toBe(false)
  })
  it("reports the tokens it could not use instead of dropping them silently", () => {
    const h = parseHiddenList(`12;13, ${SELLER}, 7, ${NFT}`)
    expect(h.invalid).toEqual(["12;13", SELLER])
    expect([...h.ids]).toEqual([7])
    expect([...h.resources]).toEqual([NFT])
    expect(parseHiddenList(undefined).invalid).toEqual([])
  })
})
