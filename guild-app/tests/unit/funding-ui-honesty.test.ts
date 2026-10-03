/**
 * The funding surface must not imply a pledge is a payment.
 *
 * `funding_pools` is an app-layer pledging ledger. The FundingPool Scrypto
 * blueprint it is shaped to reconcile against does not exist (see
 * src/db/schema/funding-pools.ts's header and funding-state-machine.ts's
 * module doc). So a pledge moves no XRD, holds no XRD, and gives a
 * contributor no on-chain claim — and the screen where someone types a number
 * is exactly where that has to be said, not a doc page they will not read.
 *
 * ── Why a test and not only an honest-copy rule ─────────────────────────────
 * scripts/honest-copy.mjs CHECK 4 scans BUILT pages, and /fund is behind an
 * off-by-default flag: with NEXT_PUBLIC_FEATURE_CROWDFUND unset these pages
 * notFound() and render no prose for the gate to read. The rule would go green
 * on a page that says anything at all. This file holds the two guarantees the
 * build gate structurally cannot: that the notice keeps its load-bearing
 * claims, and that every funding page actually renders it.
 *
 * It is a source-text test on purpose (the dispute-dialog-copy.test.ts
 * pattern): what is being guarded is that a future edit cannot quietly drop
 * the disclosure from a page, which is a fact about the files, not about one
 * rendered tree.
 */
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import {
  FUNDING_LEDGER_NOTICE,
  FUNDING_SETTLE_NOTICE,
} from "@/components/funding/funding-disclosure"

const FUND_DIR = join(process.cwd(), "src/app/fund")

function fundingPages(dir = FUND_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? fundingPages(join(dir, e.name)) : e.name === "page.tsx" ? [join(dir, e.name)] : [],
  )
}

describe("the pledge disclosure", () => {
  it("says a pledge is not a payment", () => {
    expect(FUNDING_LEDGER_NOTICE).toMatch(/not a payment/i)
  })

  it("says no XRD leaves the contributor's wallet", () => {
    expect(FUNDING_LEDGER_NOTICE).toMatch(/no xrd leaves your wallet/i)
  })

  it("says there is no on-chain component behind the pool", () => {
    expect(FUNDING_LEDGER_NOTICE).toMatch(/no on-chain component/i)
  })

  it("does not describe the pooled figure as held, locked or escrowed", () => {
    expect(FUNDING_LEDGER_NOTICE).not.toMatch(/\b(held in|locked|escrow(ed)?|custod)/i)
  })

  it("says meeting a target does not itself pay anyone", () => {
    expect(FUNDING_SETTLE_NOTICE).toMatch(/does not by itself pay anyone/i)
  })
})

describe("every funding page", () => {
  const pages = fundingPages()

  it("exists — the list, the detail and the create form", () => {
    expect(pages).toHaveLength(3)
  })

  it.each(pages)("renders the disclosure: %s", (page) => {
    const src = readFileSync(page, "utf8")
    expect(src).toContain("<FundingDisclosure")
  })

  it.each(pages)("stays behind the crowdfund flag: %s", (page) => {
    // The API hard-503s behind this flag; a page that rendered anyway could
    // only ever show an error, and would leak a half-built feature into the
    // nav's blast radius. Same gate shape as /admin and /deploy-escrow.
    const src = readFileSync(page, "utf8")
    expect(src).toMatch(/if \(!isEnabled\("crowdfund"\)\) notFound\(\)/)
  })

  it.each(pages)("never promises a payout or a lock: %s", (page) => {
    const src = readFileSync(page, "utf8")
    // Deliberately narrow: these are the phrasings that would turn a pledge
    // into a promise. Broad words ("fund", "target") are the feature's own
    // vocabulary and are fine.
    expect(src).not.toMatch(/your (funds|xrd) (are|is) (held|locked|secured)/i)
    expect(src).not.toMatch(/guaranteed/i)
    expect(src).not.toMatch(/escrow(ed)? (here|below|for you)/i)
  })
})
