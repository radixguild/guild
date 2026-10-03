import { describe, it, expect } from "vitest"
import {
  TEMP_CHECK_IDS,
  TEMP_CHECKS,
  WHAT_THIS_IS_NOT,
  WIDGET_COPY,
  type CheckId,
} from "@/content/lights-on"

/**
 * Content-only assertions for /lights-on's data module. Structure and copy
 * are checked independently of rendering here — the page itself pulls
 * everything from this module, so a hole here is a hole on the live page.
 */

describe("lights-on content — the nine temperature checks", () => {
  it("has exactly the nine expected check ids, in order", () => {
    expect(TEMP_CHECK_IDS).toEqual(["q1", "q2", "q3a", "q3b", "q3c", "q4", "q5", "q6", "q7"])
  })

  it.each(TEMP_CHECK_IDS)("%s is present in TEMP_CHECKS with a matching id and at least two options", (id) => {
    const check = TEMP_CHECKS[id as CheckId]
    expect(check).toBeDefined()
    expect(check.id).toBe(id)
    expect(check.heading.length).toBeGreaterThan(0)
    expect(check.options.length).toBeGreaterThanOrEqual(2)
  })

  it("every option has a non-empty, unique key within its own check", () => {
    for (const id of TEMP_CHECK_IDS) {
      const check = TEMP_CHECKS[id]
      const keys = check.options.map((o) => o.key)
      expect(keys.length, `${id} has no options`).toBeGreaterThan(0)
      expect(new Set(keys).size, `${id} has duplicate option keys: ${keys.join(", ")}`).toBe(keys.length)
      for (const opt of check.options) {
        expect(opt.key.length, `${id} has an empty option key`).toBeGreaterThan(0)
        expect(opt.label.length, `${id} option "${opt.key}" has an empty label`).toBeGreaterThan(0)
      }
    }
  })

  it("q3a/q3b/q3c are the non-heading sub-questions; every other check is a main heading", () => {
    for (const id of TEMP_CHECK_IDS) {
      const expected = id === "q3a" || id === "q3b" || id === "q3c" ? false : true
      expect(TEMP_CHECKS[id].isMainHeading, id).toBe(expected)
    }
  })

  it("q3c carries the accountable-person caution paragraph verbatim", () => {
    expect(TEMP_CHECKS.q3c.body.join(" ")).toContain(
      'This is a real legal role, not a title. It likely means your name on a hosting account, a bank account or a contract, with personal exposure if something goes wrong. Please do not answer "yes, publicly" without thinking that through.',
    )
  })
})

describe("lights-on content — the three sentences that must survive verbatim", () => {
  // These three are the load-bearing honesty claims of the whole page — the
  // draft's approval hinged on them staying exact. A paraphrase that keeps
  // the "same meaning" is exactly the failure mode a verbatim test exists to
  // catch: meaning is a matter of judgment, and this page is not supposed to
  // need anyone's judgment to trust it.
  // The first was re-pinned 2026-09-17 (operator-approved): the old wording,
  // "…and legally never will. That is the network's constitution", claimed more
  // than its source. The source is the 2018 Radix Tokens (Jersey) token sale
  // terms, and no network constitution is operative, so the pin now holds the
  // sourced claim instead.
  // Re-pinned 2026-09-24: the third was "Apache-2.0, forever". bigdev's
  // 2026-09-20 ruling allows no licence or open-source claim on any surface
  // until a repository is actually public, and none is.
  const REQUIRED_SENTENCES = [
    "XRD pays no dividend. The 2018 token sale terms gave holders no right to dividends, profits or distributions",
    "We are not raising money, taking payment, or selling anything",
    "Licensing is not decided; nothing is published yet.",
  ]

  it.each(REQUIRED_SENTENCES)('WHAT_THIS_IS_NOT contains "%s" verbatim', (sentence) => {
    const allText = WHAT_THIS_IS_NOT.items.join(" ")
    expect(allText).toContain(sentence)
  })

  it("WHAT_THIS_IS_NOT has exactly the four expected disclaimer items", () => {
    expect(WHAT_THIS_IS_NOT.items).toHaveLength(4)
  })
})

describe("lights-on content — widget copy", () => {
  it("is the exact, fixed disclaimer sentence", () => {
    expect(WIDGET_COPY).toBe(
      "Web temperature check: unweighted, one vote per browser; votes from signed-in accounts are counted separately. Not binding.",
    )
  })
})
