// dispute-ruling-ordinal.test.ts — pins manifests.ts's `Enum<Nu8>` literals for
// DisputeRuling to the BLUEPRINT'S OWN variant order, read from source.
//
// WHY THIS EXISTS (P3-3a)
// ------------------------
// manifest-abi-gate.test.ts already proves resolveDisputeManifest calls the
// right method with the right argument KINDS (u64, Proof, Bucket, Enum, ...).
// manifests.test.ts already proves `encodeRuling` emits `Enum<0u8>()` for
// PayWorker, `Enum<1u8>()` for RefundPoster, `Enum<2u8>(...)` for Split. Both
// are real coverage, and NEITHER catches a REORDER of the Rust enum: they
// assert what `encodeRuling` does against itself, never against `lib.rs`. SBOR
// enums are positional — variant `i` IS `Enum<iu8>` on the wire, regardless of
// what it's named — so if `DisputeRuling` in the blueprint were ever declared
// `RefundPoster, PayWorker, Split` instead of the current order, every
// existing `Enum<0u8>()`/`Enum<1u8>()` in this codebase would silently start
// meaning the OPPOSITE ruling, and every test that only checks TS-against-TS
// would stay green throughout.
//
// This file reads the ordering fact from the one place it is actually
// decided — `escrow/scrypto/guild-marketplace-escrow/src/lib.rs` — the same
// scraper `blueprint-methods.mjs` already uses for method signatures
// (`test_every_scrypto_event_is_registered_in_the_events_attribute`'s
// source-scrape shape: cheap, local, no ledger simulator, mutation-proof).
//
// MUTATION-PROVEN (see the P3-3a report for the exact commands): temporarily
// reordering `DisputeRuling` in lib.rs to `RefundPoster, PayWorker, Split`
// turns BOTH tests below red — the first because the scraped order no longer
// equals the pinned expectation, the second because `encodeRuling`'s
// hard-coded `Enum<0u8>()` for PayWorker no longer matches PayWorker's
// (now-1) scraped index. Reverting the file restores both to green.

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { scrapeEnumVariants } from "../../scripts/lib/blueprint-methods.mjs"
import * as manifests from "../../src/lib/manifests"
import type { DisputeRuling } from "../../src/lib/manifests"

const REPO = resolve(__dirname, "../../..")
const LIB_RS = resolve(REPO, "escrow/scrypto/guild-marketplace-escrow/src/lib.rs")

// Real-format dummy addresses (must pass the anchored `[a-z0-9]{20,}$` check) —
// same values manifest-abi-gate.test.ts already uses, not a live account.
const ESCROW = "component_rdx1cr690hkrk2kv933cw3qdr6amkaphdlu2whjhhh8wppus922yx335r2"
const ARBITER = "account_rdx12ynlx369jmpfg23n709g0w7fuk0wwe0lft6h5r0m8sksdjpg858g0z"
const BADGE_RES = "resource_rdx1n22hp6ydy0lkl0vqrk20cge43cm0lr64v9bldqzhq60g89fnp7j7s9"

describe("DisputeRuling ordinal pin (source-scrape, mutation-proof)", () => {
  const src = readFileSync(LIB_RS, "utf8")
  const variants = scrapeEnumVariants(src, "DisputeRuling")

  it("blueprint declares the variants PayWorker, RefundPoster, Split — in that order", () => {
    // This IS the fact every Enum<Nu8> literal in manifests.ts assumes. If this
    // goes red, the enum was reordered or renamed and nothing downstream can
    // be trusted until this line (and encodeRuling) are re-derived together.
    expect(variants).toEqual(["PayWorker", "RefundPoster", "Split"])
  })

  it("resolveDisputeManifest's Enum<Nu8> for each ruling matches its SCRAPED index", () => {
    const rulingByVariant: Record<string, DisputeRuling> = {
      PayWorker: { kind: "PayWorker" },
      RefundPoster: { kind: "RefundPoster" },
      Split: { kind: "Split", workerPct: "0.5", posterPct: "0.5" },
    }
    expect.assertions(variants.length)
    variants.forEach((variantName, scrapedIndex) => {
      const ruling = rulingByVariant[variantName]
      if (!ruling) {
        throw new Error(
          `scraped DisputeRuling variant "${variantName}" has no TS-side mapping in this test — ` +
            `extend rulingByVariant before trusting encodeRuling against it`,
        )
      }
      const manifest = manifests.resolveDisputeManifest(ESCROW, ARBITER, BADGE_RES, "#1#", 7, ruling)
      // The scraped POSITION is the expected discriminant — never a literal
      // hard-coded here — so a Rust reorder changes what this line expects,
      // not just what encodeRuling emits.
      expect(manifest).toContain(`Enum<${scrapedIndex}u8>`)
    })
  })
})
