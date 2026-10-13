// The NFT swap builders against the manifests that actually ran on mainnet.
//
// tests/fixtures/nft-swap/proving-run-*.rtm are the signed files from the
// 2026-09-15 proving run on the live component (list 1 → fill 1 → withdraw
// proceeds 1; list 2 → cancel 2) — byte-identical copies of the ceremony record,
// txids in the comments below and on the /swaps page. Each builder must emit the
// same instructions with the same arguments; only whitespace may differ (the
// builders put the `asks` array on one line for the manifest↔ABI gate). One
// addition since the run: the fill manifest asserts the listed NFT is on the
// worktop before its deposit, so its expectation is the proven file with that
// one instruction spliced in ahead of the deposit.
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  burnListingReceiptManifest,
  cancelSwapManifest,
  extendSwapListingManifest,
  fillSwapManifest,
  listSwapManifest,
  withdrawSwapProceedsManifest,
} from "@/lib/manifests"

const FIX = join(__dirname, "..", "fixtures", "nft-swap")
const proven = (name: string) => readFileSync(join(FIX, name), "utf8")
// Whitespace is not significant in a manifest outside string literals, and no
// literal here contains any.
const norm = (m: string) => m.replace(/\s+/g, "")

const SWAP = "component_rdx1cq80zarwh84mmrkn95xc7glgg5yvz0vkvqs9amxsnpwxuhkldd5mp4"
const RECEIPT = "resource_rdx1nfq47l0t7glmntfjuandqdmlejzvffq4cvlvrha94kqr52mdrvt2e7"
const THROWAWAY_NFT = "resource_rdx1ng3k9ll8yygujlamrszv5qu58nv9kqtala6cry2xql4006ccyrykdk"
const XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"
const GUILD_ADMIN_2 = "account_rdx12y6ch4m8wjcgu7hrnwfqjeqt70w4kh7qy7k3gs2j9wyx3596fgt3fm"
const POSTER_2 = "account_rdx12y5senkxfxg38swfv4tg88lx73jqnkdvcnzv8kwwdmg0efl40r2p7u"

/** The instruction every fill carries after `fill`: the listed NFT, by id. */
const assertListed = (resource: string, id: string) =>
  `ASSERT_WORKTOP_CONTAINS_NON_FUNGIBLES Address("${resource}") Array<NonFungibleLocalId>(NonFungibleLocalId("${id}")) ;`

describe("the builders reproduce the proving run", () => {
  it("list 1 — txid_rdx1hdkp85sp…gjq6", () => {
    const m = listSwapManifest(SWAP, GUILD_ADMIN_2, THROWAWAY_NFT, "#1#", [
      { kind: "fungible", resource: XRD, amount: "1" },
    ], 1790114665)
    expect(norm(m)).toBe(norm(proven("proving-run-list-1.rtm")))
  })

  it("fill 1 — txid_rdx1qma458rp…wuntq, plus the assertion on listing 1's NFT", () => {
    // Listing 1 listed THROWAWAY_NFT #1# (list 1 above).
    const m = fillSwapManifest(SWAP, POSTER_2, 1, 0, { kind: "fungible", resource: XRD, amount: "1" }, THROWAWAY_NFT, "#1#")
    const run = proven("proving-run-fill-1.rtm")
    const deposit = run.lastIndexOf("CALL_METHOD")
    expect(run.slice(deposit)).toContain('"try_deposit_batch_or_abort"')
    const expected = run.slice(0, deposit) + assertListed(THROWAWAY_NFT, "#1#") + run.slice(deposit)
    expect(norm(m)).toBe(norm(expected))
  })

  it("withdraw proceeds 1 — txid_rdx1tudezuld…vwwk9", () => {
    const m = withdrawSwapProceedsManifest(SWAP, GUILD_ADMIN_2, RECEIPT, 1)
    expect(norm(m)).toBe(norm(proven("proving-run-withdraw-proceeds-1.rtm")))
  })

  it("cancel 2 — txid_rdx1nv7zpn6c…74lzj", () => {
    const m = cancelSwapManifest(SWAP, GUILD_ADMIN_2, RECEIPT, 2)
    expect(norm(m)).toBe(norm(proven("proving-run-cancel-2.rtm")))
  })
})

describe("shapes the proving run did not exercise", () => {
  const NFT_ASK = { kind: "nonFungible" as const, resource: RECEIPT, id: "<rare_7>" }

  it("an AnyOf list emits every alternative in order, in one Array<Enum>", () => {
    const m = listSwapManifest(SWAP, GUILD_ADMIN_2, THROWAWAY_NFT, "#2#", [
      { kind: "fungible", resource: XRD, amount: "5000.25" },
      NFT_ASK,
    ], 1790114665)
    expect(m).toContain(
      `Array<Enum>(Enum<0u8>(Address("${XRD}"), Decimal("5000.25")), Enum<1u8>(Address("${RECEIPT}"), NonFungibleLocalId("<rare_7>")))`,
    )
  })

  it("a non-fungible fill withdraws exactly that one id and passes it as the payment bucket", () => {
    const m = fillSwapManifest(SWAP, POSTER_2, 9, 1, NFT_ASK, THROWAWAY_NFT, "#4#")
    expect(norm(m)).toBe(
      norm(`CALL_METHOD Address("${POSTER_2}") "withdraw_non_fungibles" Address("${RECEIPT}")
        Array<NonFungibleLocalId>(NonFungibleLocalId("<rare_7>")) ;
      TAKE_NON_FUNGIBLES_FROM_WORKTOP Address("${RECEIPT}")
        Array<NonFungibleLocalId>(NonFungibleLocalId("<rare_7>")) Bucket("payment") ;
      CALL_METHOD Address("${SWAP}") "fill" 9u64 1u8 Bucket("payment") ;
      ${assertListed(THROWAWAY_NFT, "#4#")}
      CALL_METHOD Address("${POSTER_2}") "try_deposit_batch_or_abort" Expression("ENTIRE_WORKTOP") Enum<0u8>() ;`),
    )
  })

  it("every fill asserts the listed NFT after fill and before the deposit, whatever the payment", () => {
    // Paying with an NFT of the listed NFT's own collection is the case where
    // a resource-level check would not tell the two apart: the assertion names
    // the listed id, and the payment id has already left in Bucket("payment").
    const sameCollection = { kind: "nonFungible" as const, resource: THROWAWAY_NFT, id: "#1#" }
    for (const ask of [{ kind: "fungible" as const, resource: XRD, amount: "5000.25" }, NFT_ASK, sameCollection]) {
      const m = norm(fillSwapManifest(SWAP, POSTER_2, 9, 0, ask, THROWAWAY_NFT, "#2#"))
      const fill = m.indexOf(norm(`Address("${SWAP}") "fill"`))
      const check = m.indexOf(norm(assertListed(THROWAWAY_NFT, "#2#")))
      const deposit = m.indexOf(norm(`"try_deposit_batch_or_abort"`))
      expect(fill).toBeGreaterThan(-1)
      expect(check).toBeGreaterThan(fill)
      expect(deposit).toBeGreaterThan(check)
      expect(m.split("ASSERT_WORKTOP_CONTAINS_NON_FUNGIBLES")).toHaveLength(2)
    }
  })

  it("extend presents the receipt and returns nothing to deposit", () => {
    const m = extendSwapListingManifest(SWAP, GUILD_ADMIN_2, RECEIPT, 3)
    expect(norm(m)).toBe(
      norm(`CALL_METHOD Address("${GUILD_ADMIN_2}") "create_proof_of_non_fungibles" Address("${RECEIPT}")
        Array<NonFungibleLocalId>(NonFungibleLocalId("#3#")) ;
      POP_FROM_AUTH_ZONE Proof("receipt") ;
      CALL_METHOD Address("${SWAP}") "extend_listing" Proof("receipt") ;`),
    )
  })

  it("burn hands the receipt itself over as a bucket", () => {
    const m = burnListingReceiptManifest(SWAP, GUILD_ADMIN_2, RECEIPT, 2)
    expect(norm(m)).toBe(
      norm(`CALL_METHOD Address("${GUILD_ADMIN_2}") "withdraw_non_fungibles" Address("${RECEIPT}")
        Array<NonFungibleLocalId>(NonFungibleLocalId("#2#")) ;
      TAKE_NON_FUNGIBLES_FROM_WORKTOP Address("${RECEIPT}")
        Array<NonFungibleLocalId>(NonFungibleLocalId("#2#")) Bucket("receipt") ;
      CALL_METHOD Address("${SWAP}") "burn_listing_receipt" Bucket("receipt") ;`),
    )
  })
})

// The proving run flew list (one fungible ask), fungible fill, withdraw and
// cancel; the shapes below never ran on mainnet, and the string expectations
// above are written by the same hand as the builders. The toolkit is the
// wallet's own compiler: it resolves every Bucket/Proof name and types every
// argument, so a slip in an unflown shape fails here, not in a user's wallet.
describe("every builder compiles in the real Radix Engine Toolkit", () => {
  async function compile(manifest: string) {
    const { RadixEngineToolkit } = await import("@radixdlt/radix-engine-toolkit")
    const parsed = await RadixEngineToolkit.Instructions.convert({ kind: "String", value: manifest }, 1, "Parsed")
    return parsed.value as any[]
  }
  /** Instruction kind, and the method for a call — the transaction's outline. */
  const outline = (ins: any[]) => ins.map((i) => (i.kind === "CallMethod" ? `${i.kind} ${i.methodName}` : i.kind))
  const swapCall = (ins: any[], method: string) => ins.find((i) => i.kind === "CallMethod" && i.methodName === method)
  const kinds = (call: any) => call.args.fields.map((f: any) => f.kind)

  const NFT_ASK = { kind: "nonFungible" as const, resource: RECEIPT, id: "<rare_7>" }
  const XRD_ASK = { kind: "fungible" as const, resource: XRD, amount: "5000.25" }
  const proof = ["CallMethod create_proof_of_non_fungibles", "PopFromAuthZone"]

  it("extend: proof of the receipt, then extend_listing(Proof)", async () => {
    const ins = await compile(extendSwapListingManifest(SWAP, GUILD_ADMIN_2, RECEIPT, 3))
    expect(outline(ins)).toEqual([...proof, "CallMethod extend_listing"])
    expect(kinds(swapCall(ins, "extend_listing"))).toEqual(["Proof"])
  })

  it("burn: the receipt itself, as burn_listing_receipt(Bucket)", async () => {
    const ins = await compile(burnListingReceiptManifest(SWAP, GUILD_ADMIN_2, RECEIPT, 2))
    expect(outline(ins)).toEqual([
      "CallMethod withdraw_non_fungibles",
      "TakeNonFungiblesFromWorktop",
      "CallMethod burn_listing_receipt",
    ])
    expect(kinds(swapCall(ins, "burn_listing_receipt"))).toEqual(["Bucket"])
  })

  it("non-fungible fill: fill(u64, u8, Bucket) with exactly that one id, then the listed-NFT assertion", async () => {
    const ins = await compile(fillSwapManifest(SWAP, POSTER_2, 9, 1, NFT_ASK, THROWAWAY_NFT, "#4#"))
    expect(outline(ins)).toEqual([
      "CallMethod withdraw_non_fungibles",
      "TakeNonFungiblesFromWorktop",
      "CallMethod fill",
      "AssertWorktopContainsNonFungibles",
      "CallMethod try_deposit_batch_or_abort",
    ])
    expect(kinds(swapCall(ins, "fill"))).toEqual(["U64", "U8", "Bucket"])
    const check = ins.find((i) => i.kind === "AssertWorktopContainsNonFungibles")
    expect(JSON.stringify(check)).toContain(THROWAWAY_NFT)
    expect(JSON.stringify(check)).toContain("#4#")
  })

  it("fungible fill compiles with the assertion too", async () => {
    const ins = await compile(fillSwapManifest(SWAP, POSTER_2, 1, 0, XRD_ASK, THROWAWAY_NFT, "#1#"))
    expect(outline(ins)).toEqual([
      "CallMethod withdraw",
      "TakeFromWorktop",
      "CallMethod fill",
      "AssertWorktopContainsNonFungibles",
      "CallMethod try_deposit_batch_or_abort",
    ])
  })

  it.each([
    ["two alternatives", [XRD_ASK, NFT_ASK]],
    ["three mixed alternatives", [NFT_ASK, XRD_ASK, { kind: "fungible" as const, resource: THROWAWAY_NFT, amount: "1" }]],
  ])("list with %s: list(Address, Bucket, Array<Enum>, i64), one Enum per alternative in order", async (_n, asks) => {
    const ins = await compile(listSwapManifest(SWAP, GUILD_ADMIN_2, THROWAWAY_NFT, "#2#", asks, 1790114665))
    expect(outline(ins)).toEqual([
      "CallMethod withdraw_non_fungibles",
      "TakeNonFungiblesFromWorktop",
      "CallMethod list",
      "CallMethod try_deposit_batch_or_abort",
    ])
    const call = swapCall(ins, "list")
    expect(kinds(call)).toEqual(["Address", "Bucket", "Array", "I64"])
    const arr = call.args.fields[2]
    expect(arr.elementValueKind).toBe("Enum")
    // Ask::Fungible { resource, amount } = 0, Ask::NonFungible { resource, id } = 1 (nft_swap.rs).
    expect(arr.elements.map((e: any) => [e.discriminator, e.fields.map((f: any) => f.kind)])).toEqual(
      asks.map((a) => (a.kind === "fungible" ? [0, ["Address", "Decimal"]] : [1, ["Address", "NonFungibleLocalId"]])),
    )
  })

  it("the gate has teeth: a bucket name used but never declared does not compile", async () => {
    const m = fillSwapManifest(SWAP, POSTER_2, 9, 1, NFT_ASK, THROWAWAY_NFT, "#4#").replace(/Bucket\("payment"\)/, 'Bucket("pay")')
    await expect(compile(m)).rejects.toThrow(/UndefinedBucket/)
  })
})

describe("the builders refuse what the chain would refuse, or worse, accept", () => {
  const ok = { kind: "fungible" as const, resource: XRD, amount: "1" }

  it("no alternatives", () => {
    expect(() => listSwapManifest(SWAP, GUILD_ADMIN_2, THROWAWAY_NFT, "#1#", [], 1790114665)).toThrow(/at least one/)
  })

  it.each(["0", "0.000", "-1", "1e3", "1.0000000000000000001", "", "1,000"])("amount %j", (amount) => {
    expect(() =>
      listSwapManifest(SWAP, GUILD_ADMIN_2, THROWAWAY_NFT, "#1#", [{ ...ok, amount }], 1790114665),
    ).toThrow(/Invalid asks\[0\]\.amount/)
    expect(() => fillSwapManifest(SWAP, POSTER_2, 1, 0, { ...ok, amount }, THROWAWAY_NFT, "#1#")).toThrow(/Invalid ask\.amount/)
  })

  it("an injected address or local id never reaches the manifest text", () => {
    const evil = `${XRD}")\nCALL_METHOD Address("${POSTER_2}") "withdraw"`
    expect(() => listSwapManifest(SWAP, GUILD_ADMIN_2, evil, "#1#", [ok], 1790114665)).toThrow(/Invalid resource_rdx/)
    expect(() => listSwapManifest(SWAP, GUILD_ADMIN_2, THROWAWAY_NFT, '#1#")', [ok], 1790114665)).toThrow(/assetId/)
    expect(() =>
      fillSwapManifest(SWAP, POSTER_2, 1, 0, { kind: "nonFungible", resource: RECEIPT, id: "<a>\n;" }, THROWAWAY_NFT, "#1#"),
    ).toThrow(/ask\.id/)
    expect(() => fillSwapManifest(SWAP, POSTER_2, 1, 0, ok, evil, "#1#")).toThrow(/Invalid resource_rdx/)
    expect(() => fillSwapManifest(SWAP, POSTER_2, 1, 0, ok, THROWAWAY_NFT, '#1#")')).toThrow(/assetId/)
  })

  it("a fill cannot be built without the listed NFT, so the assertion cannot be left out", () => {
    const build = fillSwapManifest as unknown as (...a: unknown[]) => string
    expect(() => build(SWAP, POSTER_2, 1, 0, ok)).toThrow(/Invalid resource_rdx/)
    expect(() => build(SWAP, POSTER_2, 1, 0, ok, THROWAWAY_NFT)).toThrow(/assetId/)
    expect(() => build(SWAP, POSTER_2, 1, 0, ok, THROWAWAY_NFT, "")).toThrow(/assetId/)
  })

  it("listing, alternative and expiry numbers are bounded", () => {
    expect(() => fillSwapManifest(SWAP, POSTER_2, 0, 0, ok, THROWAWAY_NFT, "#1#")).toThrow(/listingId/)
    expect(() => fillSwapManifest(SWAP, POSTER_2, 1, 256, ok, THROWAWAY_NFT, "#1#")).toThrow(/alternative/)
    expect(() => fillSwapManifest(SWAP, POSTER_2, 1, -1, ok, THROWAWAY_NFT, "#1#")).toThrow(/alternative/)
    expect(() => fillSwapManifest(SWAP, POSTER_2, 1, 0.5, ok, THROWAWAY_NFT, "#1#")).toThrow(/alternative/)
    expect(() => listSwapManifest(SWAP, GUILD_ADMIN_2, THROWAWAY_NFT, "#1#", [ok], 0)).toThrow(/expiresAt/)
    expect(() => cancelSwapManifest(SWAP, GUILD_ADMIN_2, RECEIPT, 1.5)).toThrow(/listingId/)
  })
})
