import { describe, expect, test } from "vitest"
import fs from "node:fs"
import path from "node:path"

/**
 * Source-scraping guards, deliberately.
 *
 * `DisputeRaiserNotice` (escrow-truth.tsx) is NOT flag-gated — it renders on any
 * disputed task — but it only mounts once a dispute exists, so no HTTP sweep or
 * cold-user e2e reaches it. The same reasoning that made
 * `dispute-dialog-copy.test.ts` scrape source applies here.
 *
 * WHAT THESE PIN, and why each is not a style preference:
 *
 * 1. A dispute does NOT cost the poster half the reward. Per lib.rs
 *    (`auto_resolve_dispute` -> `credit_split_for_parties`) the reward's
 *    non-worker half is credited BACK to the poster and the insurance premium
 *    returns to them in full — so relative to an honest approval the poster is
 *    better off, and only the worker loses. `dispute-outcome.ts` exists to be
 *    the one place that answers "what does a dispute pay"; its own doc comment
 *    records six sites that once had this wrong in two different directions.
 *    It regrew here anyway, because this string never routed through the helper.
 *
 * 2. The arbiter runbook IS written (docs/architecture/dispute-resolution.md §0,
 *    2026-08-23). Copy claiming otherwise was served publicly on /disputes and
 *    /about for four days after it stopped being true.
 */
/**
 * ⚠️ Collapse whitespace before matching. JSX wraps prose across lines, so a
 * contiguous-phrase regex silently misses the very thing it guards: the first
 * version of this file passed while `disputes/page.tsx` was still serving "the
 * arbiter runbook\n is not written" to the public, because the phrase spanned a
 * line break. A source-scraping guard that reads raw source is testing the
 * formatter, not the copy.
 */
const read = (p: string) =>
  fs.readFileSync(path.join(process.cwd(), p), "utf8").replace(/\s+/g, " ")

const SURFACES = [
  "src/app/disputes/page.tsx",
  "src/components/tasks/escrow-truth.tsx",
  "src/components/tasks/escrow-actions.tsx",
  "src/lib/settlement-copy.ts",
  "src/app/about/page.tsx",
]

describe("dispute copy never claims the poster loses half the reward", () => {
  test.each(SURFACES)("%s", (rel) => {
    const src = read(rel)
    // The specific false framings, not a generic word ban.
    expect(src).not.toMatch(/poster the other half/i)
    expect(src).not.toMatch(/both sides (to )?lose/i)
    expect(src).not.toMatch(/costs the worker half the reward and the poster/i)
  })
})

describe("copy does not claim the arbiter runbook is unwritten", () => {
  test.each(SURFACES)("%s", (rel) => {
    expect(read(rel)).not.toMatch(/runbook is not written/i)
  })
})

describe("the honest framing is actually present, not merely the false one absent", () => {
  test("DisputeRaiserNotice states the worker bears the loss", () => {
    const src = read("src/components/tasks/escrow-truth.tsx")
    expect(src).toMatch(/half the reward instead of all of it/i)
    // 2026-09-24: was "poster keeps the other half plus their premium" beside
    // "raising a dispute does not win it" — false for a poster, who recovers
    // half the reward and half the worker's bond when nobody rules. And the
    // worker's loss is scoped to the default: an arbiter ruling for the worker
    // pays the reward, the insurance and the bond — more than an approval.
    expect(src).toMatch(/Under the \{DEFAULT_DISPUTE_WINDOW_HOURS\}-hour default, a dispute can only lose a worker money/)
    expect(src).toMatch(/for the poster, an unruled dispute recovers half the reward and half the worker(&apos;|')s bond/i)
  })
})
