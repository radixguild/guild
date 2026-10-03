import { describe, it, expect } from "vitest"
import { BANNED } from "../../scripts/honest-copy.mjs"

/**
 * The engine-scope rule is the ONLY pre-emptive rule in honest-copy.mjs.
 *
 * Every other BANNED rule was written reactively — a false claim shipped,
 * someone caught it, a rule was added. That makes the gate permanently one
 * NOVEL claim behind. On 2026-08-23 a positioning ladder was drafted with a
 * rung reading "the Guild helps build the Radix Engine"; measured against the
 * full rule set it tripped NOTHING and would have shipped green.
 *
 * So this rule guards a claim that has never been served — and a rule with no
 * live text to fire on is exactly the kind that rots unnoticed. These tests are
 * the only thing keeping it honest in both directions.
 */
describe("honest-copy: engine-scope (pre-emptive)", () => {
  const rule = BANNED.find((r: { label: string }) => r.label.startsWith("engine-scope"))

  it("the rule exists and is findable by label", () => {
    expect(rule, "engine-scope rule missing from BANNED").toBeDefined()
  })

  // The overclaim: we do not build core protocol. The Guild coordinates work at
  // the Scrypto / blueprint / dApp layer.
  it.each([
    "The Guild helps build the Radix Engine",
    "we build the Xi'an engine",
    "our community maintains the core protocol",
    "The Guild is building the Radix Engine with the DAO",
    "Guild members develop the Radix protocol",
  ])("FIRES on the overclaim: %s", (sentence) => {
    expect(rule!.re.test(sentence)).toBe(true)
  })

  // ⚠️ The half that matters more. A rule this broad could easily swallow true
  // sentences, and this file's own history has a rule that failed by being too
  // WIDE. "build ON the engine" is TRUE and must stay legal — the first draft
  // of this rule fired on it.
  it.each([
    "built on Radix",
    "we build on the Radix Engine",
    "The Radix Engine enforces this at the system level",
    "we coordinate contribution to the Xi'an engine",
    "post Xi'an migration tasks as bounties",
    "The Guild coordinates Scrypto and dApp work",
    "Testing tasks, documentation and tooling updates for the Xi'an migration",
  ])("stays SILENT on true copy: %s", (sentence) => {
    expect(rule!.re.test(sentence)).toBe(false)
  })
})
