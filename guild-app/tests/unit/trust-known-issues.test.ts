import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BANNED, violation } from "../../scripts/honest-copy.mjs"

/**
 * /trust's Known Issues list — the single place a beta tester reads what is NOT
 * there yet. bigdev, 2026-09-19: "if we have issues they are known and ready to
 * be solved and the messaging is always 100% transparent."
 *
 * Two properties are worth pinning:
 *
 * 1. IT COMES FIRST. A known-issues list below the reassurance is a list nobody
 *    reads. It must render before "Checkable Today".
 *
 * 2. IT MAKES NO BANNED CLAIM. A list of limitations is exactly where a careless
 *    edit slips in "audited" or "trustless" while describing them. The CI copy
 *    gate scans the BUILT page, so it cannot run in a unit test; this scans the
 *    source strings directly, and a control proves the scan can fail.
 *
 * What this CANNOT check is whether each item is still TRUE. "Nobody outside
 * the operator has used it yet" stops being true the moment Beta 1 works — and
 * then it must be DELETED, in the same change. A stale known-issue is its own
 * false claim. That is a human's job; the comment in trust/page.tsx says so.
 */
const SRC = readFileSync(join(process.cwd(), "src/app/trust/page.tsx"), "utf8")

const listBlock = SRC.slice(SRC.indexOf("const KNOWN_ISSUES"), SRC.indexOf("const CHECKABLE_TODAY"))
const strings = [...listBlock.matchAll(/(?:title|body): "([^"]+)"/g)].map((m) => m[1])

describe("/trust known issues", () => {
  it("exists and has content (vacuous-pass guard)", () => {
    expect(SRC.includes("const KNOWN_ISSUES")).toBe(true)
    expect(strings.length).toBeGreaterThanOrEqual(2)
  })

  it("renders BEFORE Checkable Today — read what is missing first", () => {
    const known = SRC.indexOf("KNOWN_ISSUES.map")
    const checkable = SRC.indexOf("CHECKABLE_TODAY.map")
    expect(known).toBeGreaterThan(-1)
    expect(checkable).toBeGreaterThan(-1)
    expect(known).toBeLessThan(checkable)
  })

  it("makes no claim the honest-copy rules ban", () => {
    const hits: string[] = []
    for (const t of strings) {
      for (const rule of BANNED as Array<{ label: string; re: RegExp }>) {
        const f = violation(t, rule)
        if (f) hits.push(`"${f}" — ${rule.label}`)
      }
    }
    expect(hits).toEqual([])
  })

  it("the scan above can fail (control)", () => {
    // If this passes vacuously, the assertion above means nothing.
    const control = (BANNED as Array<{ re: RegExp }>).some((r) =>
      violation("a fully audited, trustless escrow", r as never),
    )
    expect(control).toBe(true)
  })
})

// ── Hard Questions (added 2026-09-20) ────────────────────────────────────────
// The block answers what a sceptic asks first. Two properties matter: it must
// pass the same copy rules as everything else (a first draft said "on-chain cap"
// and would have turned launch-check red), and it must not claim a defence the
// blueprint does not have (a first draft said junk "can be rejected"; lib.rs has
// no reject method).
import { readFileSync as readSrc } from "node:fs";
import { join as joinPath } from "node:path";
import { BANNED as ALL_BANNED, PULL_BANNED as ALL_PULL, violation as findViolation } from "../../scripts/honest-copy.mjs";

describe("/trust Hard Questions", () => {
  const src = readSrc(joinPath(__dirname, "../../src/app/trust/page.tsx"), "utf8");
  const block = src.slice(src.indexOf("const HARD_QUESTIONS"), src.indexOf("// The canonical known-issues list"));
  const strings = [...block.matchAll(/(?:q|a): (["`])((?:\\.|(?!\1).)*)\1/gs)].map((m) => m[2]);

  it("reads the real block (vacuous-pass guard)", () => {
    expect(strings.length).toBeGreaterThanOrEqual(10);
  });

  it("passes every honest-copy rule, live and dormant", () => {
    const hits: string[] = [];
    for (const t of strings) for (const r of [...ALL_BANNED, ...ALL_PULL] as Array<{ label: string; re: RegExp; allow?: RegExp[] }>) {
      const v = findViolation(t, r);
      if (v) hits.push(`"${v}" — ${r.label.split(" ")[0]}`);
    }
    expect(hits).toEqual([]);
  });

  it("does not claim a poster can reject a submission — the blueprint has no such method", () => {
    const lib = readSrc(joinPath(__dirname, "../../../escrow/scrypto/guild-marketplace-escrow/src/lib.rs"), "utf8");
    expect(lib).not.toMatch(/pub fn reject/);
    // It said "there is no reject button" until 2026-09-23 — but the app's
    // review form DOES render a Reject button (review-form.tsx), which records a
    // decision and moves no money. The true claim is about the CONTRACT.
    expect(block).toMatch(/has no reject method/);
    expect(block).toMatch(/Reject button[^"`]{0,80}moves no money/);
    expect(block).not.toMatch(/no reject button/);
    expect(block).not.toMatch(/can be rejected/);
  });

  it("answers the five questions a sceptic asks first", () => {
    // The code question was "…but the code is closed." until the open-source flip; it is
    // "…can I check the code?" since (F21 review, F1).
    for (const needle of [/cents/i, /check the code/i, /take the money/i, /squat or spam/i, /paying himself/i]) {
      expect(block, needle.source).toMatch(needle);
    }
  });

  it("says the source is public but does not claim the deployed package is proven to be it", () => {
    // Reading the source is possible since the flip; proving the package on the ledger was built
    // from it is the reproducible build, which is still planned. The answer must say both.
    expect(block).toMatch(/source is public at github\.com\/radixguild\/guild/);
    expect(block).toMatch(/reproducible build[^"`]{0,60}still planned/);
    expect(block).not.toMatch(/code is closed|repositories are private/);
  });
});
