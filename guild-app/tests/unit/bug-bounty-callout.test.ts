/**
 * Homepage bug-bounty callout copy (src/content/bug-bounty-callout.ts).
 *
 * TWO gates cover this text and they prove different things. `/` is a
 * COLD_ROUTE in scripts/honest-copy.mjs, so launch-check CHECK 4 scans the
 * rendered string inside the prerendered homepage at deploy time — but only
 * once a build exists, on the box. This file scans the source strings, which
 * is what catches a bad edit in CI before there is anything to build.
 *
 * The payment assertions are the point of the file, not decoration. The draft
 * that proposed this callout described /bug-bounty as "paid by DM"; that
 * became false the same day, when the price table came off the page because
 * the whole Guild estate (~41,361 XRD, about $34) was smaller than one Medium
 * payout had been priced at. A callout implying payment would put that exact
 * asymmetry back on the highest-traffic page on the site.
 */
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { BANNED, violation } from "../../scripts/honest-copy.mjs"
import { BUG_BOUNTY_CALLOUT } from "@/content/bug-bounty-callout"

const ALL_COPY = [
  BUG_BOUNTY_CALLOUT.title,
  BUG_BOUNTY_CALLOUT.body,
  BUG_BOUNTY_CALLOUT.fundingNote,
  BUG_BOUNTY_CALLOUT.ctaLabel,
].join(" ")

describe("bug-bounty callout — honest-copy rules", () => {
  for (const rule of BANNED) {
    it(`does not trip: ${rule.label}`, () => {
      expect(violation(ALL_COPY, rule), rule.label).toBeNull()
    })
  }

  it("catches a planted violation — the harness can go red", () => {
    // Without this, a BANNED list that silently stopped matching anything
    // would leave every assertion above passing vacuously.
    const planted = "this trustless, audited bounty is escrow-guaranteed"
    expect(BANNED.some((r: { re: RegExp }) => violation(planted, r))).toBe(true)
  })
})

describe("bug-bounty callout — never promises a payment", () => {
  /**
   * MUTATION CHECK — each of these fails the moment someone writes the
   * obvious marketing line. Swap the title for "Earn XRD for finding bugs"
   * and the first case goes red; drop `fundingNote` from the card and the
   * last two do.
   *
   * ⚠️ A first draft of this asserted on the bare words earn/paid/reward and
   * went red against the callout's own DISCLAIMERS — "Cash rewards are
   * paused", "earns a credit". Widening it to tolerate those would mean
   * teaching it to spot negation, which scripts/honest-copy.mjs refuses by
   * design ("a negation heuristic silently WIDENS over time and turns a
   * fail-closed gate into one that quietly excuses hits"). So the rule below
   * matches the PROMISE CONSTRUCTIONS positively instead — each one is a
   * phrase that can only appear if someone is offering money — which needs no
   * negation handling at all, because a disclaimer never takes these shapes.
   */
  it("makes no promise of money — no payment construction appears", () => {
    const PAYMENT_PROMISES = [
      /\bearn\s+(xrd|usd|cash|money|a\s+(reward|payout|bounty|fee))/i,
      /\b(we|the guild|guild)\s+(will\s+)?pays?\b/i,
      /\bpaid\s+(out|in\s+xrd|in\s+usd|by\s+dm|per\s+)/i,
      /\bbount(y|ies)\s+of\b/i,
      /\b(cash|xrd)\s+(reward|payout)s?\s+(for|per|on)\b/i,
      /\bget\s+paid\b/i,
    ]
    for (const re of PAYMENT_PROMISES) {
      expect(ALL_COPY, re.source).not.toMatch(re)
    }
  })

  it("quotes no currency amount — not XRD, not USD", () => {
    expect(ALL_COPY).not.toMatch(/\$\s*\d|\d[\d,.]*\s*(XRD|USD)\b/i)
  })

  it("states in the callout, before the click, that no cash is paid — and what a report does get", () => {
    expect(BUG_BOUNTY_CALLOUT.fundingNote).toMatch(/cash rewards are paused/i)
    expect(BUG_BOUNTY_CALLOUT.fundingNote).toMatch(/straight answer/i)
    expect(BUG_BOUNTY_CALLOUT.fundingNote).toMatch(/credit when the fix ships/i)
  })

  it("promises nothing the Guild does not implement (bigdev 2026-09-24: 'cut to what's real')", () => {
    // Until 2026-09-24 the note said a report "earns a credit and a recorded
    // claim on a pool the community funds". No pool, no claim record and no
    // public bug-credit ledger exist; Guild XP is written only by task settlement.
    expect(ALL_COPY).not.toMatch(/recorded claim|claim on (a|the) (reward )?pool|reward pool|public ledger/i)
    expect(ALL_COPY).not.toMatch(/XP/)
  })

  it("keeps the claim that makes it worth surfacing: no wallet, badge, bond or repo", () => {
    // This is the ONLY reason the callout earns homepage space. If an edit
    // ever weakens it, the callout should be removed rather than softened.
    for (const term of [/no wallet/i, /no badge/i, /no bond/i, /no repo access/i]) {
      expect(BUG_BOUNTY_CALLOUT.body + " " + BUG_BOUNTY_CALLOUT.title, term.source).toMatch(term)
    }
  })

  it("points at the real route", () => {
    expect(BUG_BOUNTY_CALLOUT.href).toBe("/bug-bounty")
  })
})

describe("bug-bounty callout — every surface that shows it shows the funding state", () => {
  /**
   * The callout is rendered on more than one page (`/` since #684, `/guide`
   * since the launch runway). The copy tests above only prove the STRINGS are
   * honest; they cannot see a page that renders the title and CTA but drops
   * `fundingNote` — which would put the "go here" without the "cash rewards
   * are paused" in front of exactly the visitor it was written for.
   *
   * MUTATION CHECK — delete the `{BUG_BOUNTY_CALLOUT.fundingNote}` line from
   * either page and the per-file case goes red; delete the import from
   * `/guide` and the surface-count guard goes red.
   */
  const appDir = path.resolve(__dirname, "../../src/app")
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name)) files.push(full)
    }
  }
  walk(appDir)
  const surfaces = files.filter((f) =>
    /import\s*\{[^}]*\bBUG_BOUNTY_CALLOUT\b[^}]*\}\s*from\s*["']@\/content\/bug-bounty-callout["']/.test(
      fs.readFileSync(f, "utf8"),
    ),
  )

  it("finds the known surfaces — the scan is not vacuous", () => {
    const rel = surfaces.map((f) => path.relative(appDir, f)).sort()
    expect(rel).toEqual(expect.arrayContaining(["guide/page.tsx", "page.tsx"]))
  })

  for (const f of surfaces) {
    it(`${path.relative(appDir, f)} renders fundingNote alongside the CTA`, () => {
      const src = fs.readFileSync(f, "utf8")
      expect(src).toMatch(/\{\s*BUG_BOUNTY_CALLOUT\.href\s*\}/)
      expect(src).toMatch(/\{\s*BUG_BOUNTY_CALLOUT\.fundingNote\s*\}/)
    })
  }
})
