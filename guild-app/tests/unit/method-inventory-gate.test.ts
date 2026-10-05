// The method-catalog gate. Mirrors escrow-instantiate-gate.test.ts: a gate that
// reimplements the thing it guards is a test of the reimplementation, so these
// import the SAME functions the CLI and CI run.
//
// The mutations below are the point. `docs/ESCROW-METHOD-INVENTORY.md` was
// already wrong once, for months, in a way nothing detected — so a green check
// here is only worth what it can be shown to REJECT.

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  splitTopLevel,
  renderTable,
  spliceBlock,
  scrapeMethods,
  BEGIN,
  END,
  NFT_SWAP_BEGIN,
  NFT_SWAP_END,
} from "../../scripts/lib/blueprint-methods.mjs"

const REPO = resolve(__dirname, "../../..")
const LIB_RS = resolve(REPO, "escrow/scrypto/guild-marketplace-escrow/src/lib.rs")
// P7-02 (task 90): the standalone NftSwap blueprint, own module, same package.
const NFT_SWAP_RS = resolve(REPO, "escrow/scrypto/guild-marketplace-escrow/src/nft_swap.rs")
const DOC = resolve(REPO, "docs/ESCROW-METHOD-INVENTORY.md")

describe("splitTopLevel", () => {
  it("does not split inside generics — the arity-inflation bug", () => {
    // `Option<ResourceAddress>` is ONE param. A naive split(',') on
    // `Vec<(A, B)>` would report three, which is how a doc ends up claiming an
    // arity the code does not have.
    expect(splitTopLevel("a: u64, b: Option<ResourceAddress>")).toEqual([
      "a: u64",
      "b: Option<ResourceAddress>",
    ])
    expect(splitTopLevel("x: Vec<(ResourceAddress, AcceptedTokenConfig)>")).toEqual([
      "x: Vec<(ResourceAddress, AcceptedTokenConfig)>",
    ])
  })

  it("does not split inside tuples", () => {
    expect(splitTopLevel("a: (Decimal, Decimal), b: u64")).toEqual([
      "a: (Decimal, Decimal)",
      "b: u64",
    ])
  })
})

describe("scrapeMethods against the real blueprint", () => {
  const methods = scrapeMethods(LIB_RS)

  it("finds every public method", () => {
    expect(methods.length).toBeGreaterThan(20)
    const names = methods.map((m) => m.name)
    for (const required of [
      "instantiate",
      "create_task",
      "claim_task",
      "submit_task",
      "approve_and_release",
      "raise_dispute",
      "auto_resolve_dispute",
      "expire_claim",
    ]) {
      expect(names).toContain(required)
    }
  })

  it("reads a multi-line signature's TUPLE RETURN as a return, not as a parameter", () => {
    // The first cut used lastIndexOf(')'), which closes the RETURN tuple rather
    // than the argument list. It reported `) -> (Global<Escrow>, Bucket, Bucket`
    // as a twelfth parameter and `()` as the return type — on the one method
    // whose arity the whole cutover depends on.
    const inst = methods.find((m) => m.name === "instantiate")!
    expect(inst.returns).toBe("(Global<Escrow>, Bucket, Bucket)")
    // 15 as of Wave B stage 6 (was 11 after DB-3). The number is pinned rather
    // than derived on purpose: arity is write-once at deploy, so a silent change
    // here is a different component.
    expect(inst.params).toHaveLength(15)
    expect(inst.params.some((p) => p.includes("->"))).toBe(false)
    expect(inst.params.some((p) => p.includes("Global<Escrow>"))).toBe(false)
  })

  it("pins the Wave B arity and the DB-2 three-tuple at the source", () => {
    const inst = methods.find((m) => m.name === "instantiate")!
    expect(inst.params).toHaveLength(15)
    // Heartbeat pair removed by DB-3 — if either returns, this reddens.
    expect(inst.params.some((p) => p.startsWith("heartbeat_"))).toBe(false)
    // Wave B W4 replaced the flat bond with the proportional trio. The old name
    // returning would mean the blueprint regressed to a flat XRD bond.
    expect(inst.params.some((p) => p.startsWith("claim_bond_xrd"))).toBe(false)
    for (const added of [
      "claim_bond_pct",
      "claim_bond_floor",
      "claim_bond_cap",
      "expire_bounty_pct",
      "review_window_secs",
    ]) {
      expect(inst.params.some((p) => p.startsWith(added))).toBe(true)
    }
    // DB-2's royalty-admin badge is the third element.
    expect(inst.returns.split(",")).toHaveLength(3)
  })

  it("distinguishes &self from &mut self", () => {
    const getter = methods.find((m) => m.name === "get_config")!
    expect(getter.readOnly).toBe(true)
    expect(getter.mutates).toBe(false)
    const mutator = methods.find((m) => m.name === "create_task")!
    expect(mutator.mutates).toBe(true)
  })

  it("refuses to report an empty ABI rather than passing vacuously", () => {
    // An empty scrape must be loud. A silent zero-method result would render an
    // empty table that byte-matches an empty committed block — a green check
    // over nothing at all.
    expect(() => scrapeMethods(resolve(REPO, "guild-app/package.json"))).toThrow(
      /NO public methods/
    )
  })
})

describe("the committed doc matches the source", () => {
  it("is in sync — regenerate with gen-method-inventory.mjs --write (private operations repository) if this fails", () => {
    const doc = readFileSync(DOC, "utf8")
    expect(doc).toBe(spliceBlock(doc, renderTable(scrapeMethods(LIB_RS))))
  })

  it("REDDENS when a method is dropped from the table", () => {
    const doc = readFileSync(DOC, "utf8")
    const methods = scrapeMethods(LIB_RS)
    const mutated = spliceBlock(doc, renderTable(methods.slice(0, -1)))
    expect(mutated).not.toBe(doc)
  })

  it("REDDENS when a parameter is added", () => {
    const doc = readFileSync(DOC, "utf8")
    const methods = scrapeMethods(LIB_RS).map((m) =>
      m.name === "claim_task" ? { ...m, params: [...m.params, "is_agent: bool"] } : m
    )
    expect(spliceBlock(doc, renderTable(methods))).not.toBe(doc)
  })

  it("REDDENS when a return type changes", () => {
    const doc = readFileSync(DOC, "utf8")
    const methods = scrapeMethods(LIB_RS).map((m) =>
      m.name === "expire_claim" ? { ...m, returns: "()" } : m
    )
    expect(spliceBlock(doc, renderTable(methods))).not.toBe(doc)
  })

  it("REDDENS when a line number drifts — the 120-940 line failure", () => {
    const doc = readFileSync(DOC, "utf8")
    const methods = scrapeMethods(LIB_RS).map((m) => ({ ...m, line: m.line + 1 }))
    expect(spliceBlock(doc, renderTable(methods))).not.toBe(doc)
  })

  it("throws rather than silently appending when the markers are gone", () => {
    expect(() => spliceBlock("# doc with no markers\n", "table")).toThrow(/markers are missing/)
  })

  it("keeps the hand-maintained prose outside the generated block", () => {
    const doc = readFileSync(DOC, "utf8")
    const before = doc.slice(0, doc.indexOf(BEGIN))
    const after = doc.slice(doc.indexOf(END) + END.length)
    // The Auth Model table is explicitly NOT covered by the generator; it must
    // survive a regeneration untouched.
    expect(after).toContain("Auth Model")
    expect(before).toContain("Escrow Blueprint — Method Inventory")
    const regenerated = spliceBlock(doc, renderTable(scrapeMethods(LIB_RS)))
    expect(regenerated.slice(regenerated.indexOf(END) + END.length)).toBe(after)
  })
})

// P7-02 (task 90): the NftSwap blueprint's OWN generated block, same file,
// distinct markers (NFT_SWAP_BEGIN/END). Mirrors the escrow's own gate above
// rather than sharing test bodies with it — the two blueprints are scraped
// from different source files and spliced at different markers, so a bug in
// one splice would not necessarily show up in the other.
describe("scrapeMethods against the NftSwap blueprint", () => {
  const methods = scrapeMethods(NFT_SWAP_RS)

  it("finds every public method", () => {
    const names = methods.map((m) => m.name)
    for (const required of [
      "instantiate",
      "list",
      "fill",
      "cancel",
      "extend_listing",
      "withdraw_proceeds",
      "burn_listing_receipt",
      "get_listing",
      "get_config",
      "get_proceeds",
    ]) {
      expect(names).toContain(required)
    }
  })

  it("instantiate takes zero parameters and returns the three-tuple", () => {
    // Mints its own owner + royalty-admin + internal-minter badges, exactly
    // like the escrow — see nft_swap.rs's own header. If this ever changes
    // to accept a pre-existing badge, the doc comments explaining "mints its
    // own" need revisiting in the same change; this is the tripwire.
    const inst = methods.find((m) => m.name === "instantiate")!
    expect(inst.params).toHaveLength(0)
    expect(inst.returns).toBe("(Global<NftSwap>, Bucket, Bucket)")
  })

  it("fill and cancel return NonFungibleBucket — the asset moves atomically", () => {
    const fill = methods.find((m) => m.name === "fill")!
    const cancel = methods.find((m) => m.name === "cancel")!
    expect(fill.returns).toBe("NonFungibleBucket")
    expect(cancel.returns).toBe("NonFungibleBucket")
  })
})

describe("the committed NftSwap doc block matches the source", () => {
  it("is in sync — regenerate with gen-method-inventory.mjs --write (private operations repository) if this fails", () => {
    const doc = readFileSync(DOC, "utf8")
    expect(doc).toBe(
      spliceBlock(doc, renderTable(scrapeMethods(NFT_SWAP_RS)), NFT_SWAP_BEGIN, NFT_SWAP_END)
    )
  })

  it("REDDENS when a method is dropped from the table", () => {
    const doc = readFileSync(DOC, "utf8")
    const methods = scrapeMethods(NFT_SWAP_RS)
    const mutated = spliceBlock(doc, renderTable(methods.slice(0, -1)), NFT_SWAP_BEGIN, NFT_SWAP_END)
    expect(mutated).not.toBe(doc)
  })

  it("REDDENS when a return type changes", () => {
    const doc = readFileSync(DOC, "utf8")
    const methods = scrapeMethods(NFT_SWAP_RS).map((m) =>
      m.name === "fill" ? { ...m, returns: "Bucket" } : m
    )
    expect(spliceBlock(doc, renderTable(methods), NFT_SWAP_BEGIN, NFT_SWAP_END)).not.toBe(doc)
  })

  it("does not disturb the escrow's own generated block", () => {
    const doc = readFileSync(DOC, "utf8")
    const escrowBlockBefore = doc.slice(doc.indexOf(BEGIN), doc.indexOf(END) + END.length)
    const regenerated = spliceBlock(
      doc,
      renderTable(scrapeMethods(NFT_SWAP_RS)),
      NFT_SWAP_BEGIN,
      NFT_SWAP_END
    )
    const escrowBlockAfter = regenerated.slice(
      regenerated.indexOf(BEGIN),
      regenerated.indexOf(END) + END.length
    )
    expect(escrowBlockAfter).toBe(escrowBlockBefore)
  })
})
