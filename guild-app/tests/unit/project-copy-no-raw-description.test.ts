import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { firstSentence, doneWhenLine } from "@/lib/project-summary"

/**
 * No project surface may render a project's RAW description.
 *
 * 🔴 The defect, live until 2026-09-18: /projects and /projects/[slug] both
 * rendered `{project.description}` whole. A live description follows the
 * convention
 *
 *   "<pitch>. — Catalogue: N tasks · X XRD in rewards (...). — Done when: ..."
 *
 * and that Catalogue clause is UNFUNDED BACKLOG typed at project creation. It
 * summed to 195,200 XRD across the cards while 22,900 XRD was actually
 * paid+locked — and it rendered inches from the real `locked`/`paid` figures,
 * which are live SQL aggregates over on-chain state. Two numbers on one screen
 * computed on entirely different bases, with nothing telling a reader that.
 *
 * Worst case measured: P4 advertised 67,100 XRD against 1,500 XRD actually paid.
 *
 * WHY A SOURCE TEST. The copy lives in POSTGRES, so the honest-copy CI gate
 * cannot see it (it scans source files), `launch-check.sh` cannot see it (it
 * inspects the built artifact), and the e2e cold-user spec cannot see it (it
 * runs against an empty CI database). Nothing that exists today would catch a
 * regression here. What IS checkable from source is the rendering decision: a
 * page either passes the description through a helper that drops the clause, or
 * it does not.
 *
 * To mutate-prove: restore `{project.description}` on either page and the
 * matching assertion must fail.
 */

const PROJECT_PAGES = [
  "src/app/projects/page.tsx",
  "src/app/projects/[slug]/page.tsx",
]

describe("project surfaces render the pitch, never the raw description", () => {
  it.each(PROJECT_PAGES)("%s exists (vacuous-pass guard)", (page) => {
    // Without this, a renamed route drops silently out of the sweep below and
    // the suite still reads green — the failure class this file is about.
    expect(() => readFileSync(join(process.cwd(), page), "utf8")).not.toThrow()
  })

  it.each(PROJECT_PAGES)("%s does not interpolate a bare description", (page) => {
    const src = readFileSync(join(process.cwd(), page), "utf8")
    // `{p.description}` / `{project.description}` as a whole JSX expression.
    // A call like `{firstSentence(p.description)}` does not match.
    const bare = /\{\s*(?:p|project)\.description\s*\}/.test(src)
    expect(bare, `${page} renders the raw description, including its unfunded "XRD in rewards" clause`).toBe(false)
  })

  it.each(PROJECT_PAGES)("%s routes the description through a summary helper", (page) => {
    const src = readFileSync(join(process.cwd(), page), "utf8")
    expect(/firstSentence\(/.test(src), `${page} should use firstSentence()`).toBe(true)
  })
})

describe("the helper actually drops the clause (the guard above is only worth having if it does)", () => {
  // Shaped exactly like the live descriptions this defect was found in.
  const LIVE_SHAPE =
    "Tools an outside agent can actually run. — Catalogue: 20 tasks · 67,100 XRD in rewards " +
    "(docs/guild-task-board.json, project P4). — Done when: an outside agent completes a task."

  it("keeps the pitch", () => {
    expect(firstSentence(LIVE_SHAPE)).toBe("Tools an outside agent can actually run.")
  })

  it("drops the unfunded reward total", () => {
    expect(firstSentence(LIVE_SHAPE)).not.toContain("XRD in rewards")
    expect(firstSentence(LIVE_SHAPE)).not.toContain("67,100")
  })

  it("still surfaces the definition of done, which is not a money claim", () => {
    expect(doneWhenLine(LIVE_SHAPE)).toBe("Done when: an outside agent completes a task.")
  })

  it("degrades safely on a hand-written description with no convention", () => {
    // A project created through the New Project dialog has no segments at all.
    expect(firstSentence("Just a plain description")).toBe("Just a plain description")
    expect(doneWhenLine("Just a plain description")).toBeNull()
  })
})
