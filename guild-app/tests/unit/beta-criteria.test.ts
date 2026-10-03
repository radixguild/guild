import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BETA_CRITERIA, type BetaCriterionStatus } from "@/content/beta-criteria"
import { BANNED, PULL_BANNED, violation } from "../../scripts/honest-copy.mjs"
import { privateInputs, REPO_ROOT } from "../support/private-input"

/**
 * The beta checklist on /agents#closed-beta must say what the decision record
 * says. docs/design/closed-beta-gate.md §4 marks each numbered criterion: a
 * trailing "✅" is met, "✅ except …" is partly met, no mark is not met. When
 * the doc's marks move, this fails until the page moves with them.
 *
 * docs/design/ stays EXCLUDE at the open-source flip, so the two tests below
 * that parse this doc skip in the public export; "passes the site's
 * honest-copy rules" needs no doc (scripts/honest-copy.mjs ships) and always
 * runs.
 */
const PRIV = privateInputs("docs/design/closed-beta-gate.md")
const DOC = PRIV.skip ? "" : readFileSync(join(REPO_ROOT, "docs", "design", "closed-beta-gate.md"), "utf8")

function docStatuses(): Map<number, BetaCriterionStatus> {
  const section = DOC.split(/^## 4\. /m)[1]?.split(/^## /m)[0] ?? ""
  const items = section.split(/^(?=\d\. \*\*)/m).filter((s) => /^\d\. \*\*/.test(s))
  return new Map(
    items.map((item) => {
      const n = Number(item.slice(0, 1))
      const status: BetaCriterionStatus = /✅ except\b/.test(item) ? "partly met" : /✅/.test(item) ? "met" : "not met"
      return [n, status]
    }),
  )
}

describe("the beta checklist follows closed-beta-gate.md §4", () => {
  it.skipIf(PRIV.skip)("finds the four numbered criteria in the doc", () => {
    expect([...docStatuses().keys()]).toEqual([1, 2, 3, 4])
  })

  it.skipIf(PRIV.skip)("shows each criterion with the doc's status", () => {
    const doc = docStatuses()
    for (const c of BETA_CRITERIA) expect(c.status, `criterion ${c.id}: "${c.criterion}"`).toBe(doc.get(c.id))
  })

  it("passes the site's honest-copy rules", () => {
    const text = BETA_CRITERIA.map((c) => `${c.criterion} — ${c.status}. ${c.detail}`).join(" ")
    const hits: string[] = []
    for (const r of [...BANNED, ...PULL_BANNED] as Array<{ label: string; re: RegExp; allow?: RegExp[] }>) {
      const v = violation(text, r)
      if (v) hits.push(`"${v}" — ${r.label.split(" ")[0]}`)
    }
    expect(hits).toEqual([])
  })
})
