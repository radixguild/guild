// The NFT swap builders against the manifests that actually ran on mainnet.
//
// tests/fixtures/nft-swap/proving-run-*.rtm are the signed files from the
// 2026-09-15 proving run on the live component (list 1 → fill 1 → withdraw
// proceeds 1; list 2 → cancel 2) — byte-identical copies of the ceremony record,
// txids in the comments below and on the /swaps page. Each builder must emit the
// same instructions with the same arguments; only whitespace may differ (the
// builders put the `asks` array on one line for the manifest↔ABI gate).
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

describe("the builders reproduce the proving run", () => {
  it("list 1 — txid_rdx1hdkp85sp…gjq6", () => {
    const m = listSwapManifest(SWAP, GUILD_ADMIN_2, THROWAWAY_NFT, "#1#", [
      { kind: "fungible", resource: XRD, amount: "1" },
    ], 1790114665)
    expect(norm(m)).toBe(norm(proven("proving-run-list-1.rtm")))
  })

  it("fill 1 — txid_rdx1qma458rp…wuntq", () => {
    const m = fillSwapManifest(SWAP, POSTER_2, 1, 0, { kind: "fungible", resource: XRD, amount: "1" })
    expect(norm(m)).toBe(norm(proven("proving-run-fill-1.rtm")))
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
    const m = fillSwapManifest(SWAP, POSTER_2, 9, 1, NFT_ASK)
    expect(norm(m)).toBe(
      norm(`CALL_METHOD Address("${POSTER_2}") "withdraw_non_fungibles" Address("${RECEIPT}")
        Array<NonFungibleLocalId>(NonFungibleLocalId("<rare_7>")) ;
      TAKE_NON_FUNGIBLES_FROM_WORKTOP Address("${RECEIPT}")
        Array<NonFungibleLocalId>(NonFungibleLocalId("<rare_7>")) Bucket("payment") ;
      CALL_METHOD Address("${SWAP}") "fill" 9u64 1u8 Bucket("payment") ;
      CALL_METHOD Address("${POSTER_2}") "try_deposit_batch_or_abort" Expression("ENTIRE_WORKTOP") Enum<0u8>() ;`),
    )
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

describe("the builders refuse what the chain would refuse, or worse, accept", () => {
  const ok = { kind: "fungible" as const, resource: XRD, amount: "1" }

  it("no alternatives", () => {
    expect(() => listSwapManifest(SWAP, GUILD_ADMIN_2, THROWAWAY_NFT, "#1#", [], 1790114665)).toThrow(/at least one/)
  })

  it.each(["0", "0.000", "-1", "1e3", "1.0000000000000000001", "", "1,000"])("amount %j", (amount) => {
    expect(() =>
      listSwapManifest(SWAP, GUILD_ADMIN_2, THROWAWAY_NFT, "#1#", [{ ...ok, amount }], 1790114665),
    ).toThrow(/Invalid asks\[0\]\.amount/)
    expect(() => fillSwapManifest(SWAP, POSTER_2, 1, 0, { ...ok, amount })).toThrow(/Invalid ask\.amount/)
  })

  it("an injected address or local id never reaches the manifest text", () => {
    const evil = `${XRD}")\nCALL_METHOD Address("${POSTER_2}") "withdraw"`
    expect(() => listSwapManifest(SWAP, GUILD_ADMIN_2, evil, "#1#", [ok], 1790114665)).toThrow(/Invalid resource_rdx/)
    expect(() => listSwapManifest(SWAP, GUILD_ADMIN_2, THROWAWAY_NFT, '#1#")', [ok], 1790114665)).toThrow(/assetId/)
    expect(() =>
      fillSwapManifest(SWAP, POSTER_2, 1, 0, { kind: "nonFungible", resource: RECEIPT, id: "<a>\n;" }),
    ).toThrow(/ask\.id/)
  })

  it("listing, alternative and expiry numbers are bounded", () => {
    expect(() => fillSwapManifest(SWAP, POSTER_2, 0, 0, ok)).toThrow(/listingId/)
    expect(() => fillSwapManifest(SWAP, POSTER_2, 1, 256, ok)).toThrow(/alternative/)
    expect(() => fillSwapManifest(SWAP, POSTER_2, 1, -1, ok)).toThrow(/alternative/)
    expect(() => fillSwapManifest(SWAP, POSTER_2, 1, 0.5, ok)).toThrow(/alternative/)
    expect(() => listSwapManifest(SWAP, GUILD_ADMIN_2, THROWAWAY_NFT, "#1#", [ok], 0)).toThrow(/expiresAt/)
    expect(() => cancelSwapManifest(SWAP, GUILD_ADMIN_2, RECEIPT, 1.5)).toThrow(/listingId/)
  })
})
