import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BANNED, PULL_BANNED, violation } from "../../scripts/honest-copy.mjs"
import { ESCROW_CLAIM_BOND_XRD } from "@/lib/config"

/**
 * /money's claim-bond copy states the Wave B rule (2026-09-13). Wave B
 * deleted the deployed component's flat `claim_bond_xrd` field: the bond is
 * now `clamp(reward * claim_bond_pct, claim_bond_floor, claim_bond_cap)` in
 * the task's own reward token. This page previously hardcoded "10 XRD" —
 * label, ELI5 card, and the "free to use" qualifier all asserted a flat
 * figure, and the ELI5 card additionally reasoned about it being "worth about
 * a US cent", a framing that only makes sense for a fixed number.
 *
 * A source-text assertion rather than a render assertion, matching
 * tests/unit/about-claims.test.tsx's rationale: /money's content lives in
 * module-level arrays and JSX literals inside a large "use client" page, and
 * what needs pinning is the CLAIM, not the markup. The page is prerendered
 * and cold (COLD_ROUTES in scripts/honest-copy.mjs), so its BUILT output is
 * also scanned by launch-check.sh CHECK 4 and the cold-user e2e spec — this
 * test is the one that runs at `bun run test` time, without a build.
 */

const SRC = readFileSync(
  join(process.cwd(), "src/app/money/page.tsx"),
  "utf8",
)

/** Slice out one named section of the file by its start/end markers. Used to
 *  scope the honest-copy scan below to the blocks this fix actually touched —
 *  see that test for why the whole file cannot be scanned this way. */
function section(startNeedle: string, endNeedle: string): string {
  const start = SRC.indexOf(startNeedle)
  if (start === -1) throw new Error(`section start marker not found in money/page.tsx: ${startNeedle}`)
  const end = SRC.indexOf(endNeedle, start + startNeedle.length)
  if (end === -1) throw new Error(`section end marker not found in money/page.tsx: ${endNeedle}`)
  return SRC.slice(start, end + endNeedle.length)
}

// The four blocks this fix edited: the WORKER_COSTS claim-bond entry, the
// ELI5 card, the "no platform fee" qualifier paragraph, and the "verify it
// yourself" on-chain field list.
const EDITED_COPY = [
  section("const WORKER_COSTS = [", "];"),
  section("{/* What this is (ELI5) */}", "</Card>"),
  section("{/* No platform fee */}", "</Card>"),
  section("{/* Verify it yourself */}", "</Card>"),
].join("\n")

describe("/money states ONE proportional claim-bond rule, never a flat figure", () => {
  it("actually read a non-trivial amount of source (vacuous-pass guard)", () => {
    expect(SRC.length).toBeGreaterThan(2000)
  })

  it("contains no flat '10 XRD' (or any other bare number) claim-bond claim", () => {
    // The three sites that used to hardcode it: the WORKER_COSTS label, its
    // detail sentence (twice — "worth about a US cent" AND "lose 10 XRD to a
    // stranger"), and the ELI5 card. None may state a bare number tied to
    // "bond" any more — every mention must go through the proportional rule.
    const flatBondClaim = /\b\d+(\.\d+)?\s*XRD\b[^.;!?]{0,20}\bbond\b|\bbond\b[^.;!?]{0,20}\b\d+(\.\d+)?\s*XRD\b/gi
    const hits = [...SRC.matchAll(flatBondClaim)].map((m) => m[0])
    expect(hits, `flat bond figure(s) found: ${hits.join(" | ")}`).toEqual([])

    // The old reasoning ("10 XRD is about a US cent, so it deters nobody")
    // only makes sense for a fixed amount — Wave B's bond scales with the
    // reward, so this framing must be gone from the claim-bond copy too.
    expect(SRC).not.toMatch(/US cent/i)
  })

  it("states the proportional rule — 10% of the reward with a floor, as an owner setting", () => {
    expect(SRC).toMatch(/10% of the (task.s )?reward/i)
    // The floor is the existing ESCROW_CLAIM_BOND_XRD constant, reused rather
    // than a second hardcoded number — pin that the source actually threads
    // it through as the floor, not just that "floor" appears somewhere.
    expect(SRC).toMatch(/floor(ed)? at \$\{ESCROW_CLAIM_BOND_XRD\}|at least \$\{ESCROW_CLAIM_BOND_XRD\} XRD today \(an owner setting\)/)
    // The size is the escrow owner's setting (set_claim_bond_params), so the copy must not
    // promise a minimum or a cap as if the contract guaranteed them.
    expect(SRC).not.toMatch(/never less than|capped on-chain/i)
    // No invented USD figure took the old cent framing's place. `\$\d` (not a
    // bare `$`) so this doesn't trip on the file's own `${ESCROW_CLAIM_BOND_XRD}`
    // template-literal interpolations.
    expect(SRC).not.toMatch(/\$\d|USD|dollar/i)
  })

  it("the on-chain 'verify it yourself' section names the real Wave B fields, not the old flat one", () => {
    // Wave B has no flat claim_bond_xrd field on the deployed component — the
    // page must point a verifier at the fields that actually exist.
    expect(SRC).toMatch(/claim_bond_pct\/floor\/cap|claim_bond_pct.{0,20}claim_bond_floor.{0,20}claim_bond_cap/)
  })

  it("ESCROW_CLAIM_BOND_XRD is still imported and used only as the FLOOR, never as the whole bond", () => {
    // Guards against a future edit reintroducing it as a flat quoted amount.
    expect(SRC).toContain("ESCROW_CLAIM_BOND_XRD")
    // Sanity: the constant this test reasons about actually resolves (default
    // env, "10") — if this ever throws/NaNs the fixture assumptions above are
    // moot.
    expect(Number.isFinite(ESCROW_CLAIM_BOND_XRD)).toBe(true)
  })

  it("the edited blocks clear the real honest-copy rule table (the same table CHECK 4 and cold-user run against the built page)", () => {
    // /money is a COLD_ROUTE (scripts/honest-copy.mjs) but is not in
    // DETAIL_COMPONENTS, so nothing else scans its SOURCE at unit-test time —
    // only the built artifact, at deploy/e2e time. Applying the table
    // directly here (same technique as
    // tests/unit/poster-cancel-disclosure-honest-copy.test.tsx) gets the
    // regression protection into `bun run test` without adding this file to
    // that shared gate list, which is a separate, bigger decision.
    //
    // Scoped to EDITED_COPY, not the whole file: /money also carries a
    // deliberate disavowal paragraph (`data-honest-copy="quote"`, further
    // down the page) that NAMES banned phrases in order to reject them — the
    // real gate skips that region via visibleText()'s HTML-level marker scan,
    // which only works on parsed/rendered HTML, not raw TSX source. Scanning
    // the whole file's source here would flag that pre-existing, correctly-
    // exempted paragraph as a false positive unrelated to this fix.
    expect(EDITED_COPY.length).toBeGreaterThan(200) // vacuous-pass guard
    const ALL_RULES = [...BANNED, ...PULL_BANNED]
    const hits = ALL_RULES.map((r: unknown) => violation(EDITED_COPY, r)).filter(Boolean)
    expect(hits, `banned claim(s) in the edited /money copy: ${hits.join(" | ")}`).toEqual([])
  })
})
