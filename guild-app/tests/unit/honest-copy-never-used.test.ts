import { describe, it, expect } from "vitest"
import { BANNED } from "../../scripts/honest-copy.mjs"

/**
 * The never-used rule was written from a real miss, not a hypothetical.
 *
 * /disputes told the public two checkable falsehoods while on-chain task 3 had
 * been sitting in `Disputed` since 2026-08-23 — put there by OUR OWN probe:
 *
 *   "No task has ever entered Disputed on mainnet."
 *   "None of it has ever been used"
 *
 * Both sat inside the page's "verify it yourself" framing, which is the worst
 * possible place to be checkably wrong: the reader is being invited to go and
 * check, and the ledger disagrees.
 *
 * The failure generalises. A never-claim about ledger history is true only
 * until the next probe, and whoever runs the probe is never whoever remembers
 * the marketing copy. So the UNQUALIFIED form is banned outright.
 *
 * A QUALIFIED claim must still pass, or the rule would forbid the honest
 * replacement — "no OUTSIDE user has ever been in a dispute" is both true and
 * checkable. That is why the subject qualifiers are a negative lookahead
 * rather than the whole shape being forbidden, and it is the half of this rule
 * most likely to be broken by someone widening the regex later.
 */
describe("honest-copy: never-used (dispute history)", () => {
  const rule = BANNED.find((r: { label: string }) => r.label.startsWith("never-used"))

  it("the rule exists and is findable by label", () => {
    expect(rule).toBeDefined()
  })

  describe("FIRES on the unqualified claims that were actually live", () => {
    const banned = [
      "No task has ever entered Disputed on mainnet.",
      "None of it has ever been used",
      "no dispute has ever been raised here",
      "none of the dispute methods have ever been invoked",
    ]
    for (const text of banned) {
      it(`fires: ${text.slice(0, 48)}`, () => {
        expect(rule!.re.test(text)).toBe(true)
      })
    }
  })

  describe("STAYS QUIET on qualified, true claims — the direction that matters most", () => {
    const allowed = [
      // The honest replacement now shipping on /disputes.
      "No outside user has ever been in a dispute here",
      "No external user has ever been disputed",
      "No third-party dispute has ever been raised",
      // Stating that we DID exercise it must never trip a rule about never.
      "We have exercised it ourselves: task 3 was moved into Disputed on 2026-08-23",
      "Disputes are dormant in our UI",
      // A never-claim about arbiters ruling is a different claim; not this rule's job.
      "No arbiter has ever ruled on a task",
    ]
    for (const text of allowed) {
      it(`quiet: ${text.slice(0, 48)}`, () => {
        expect(rule!.re.test(text)).toBe(false)
      })
    }
  })

  it("the exact corrected /disputes sentences pass the rule they were written for", () => {
    // Pinned verbatim from src/app/disputes/page.tsx. If someone re-words the
    // page back toward an unqualified never-claim, this goes red.
    const live = [
      "Live and verifiable — and reachable by anyone who builds the manifest themselves, not just by us. We have exercised it ourselves: on-chain task 3 was moved into Disputed on 2026-08-23 as a deliberate internal probe, and its 72h auto-resolve is scheduled for 2026-08-26. Both are readable on the ledger.",
      "No outside user has ever been in a dispute here — because the fallback method is callable by anyone, so at pilot scale we keep the surface small",
    ]
    for (const text of live) expect(rule!.re.test(text)).toBe(false)
  })
})
