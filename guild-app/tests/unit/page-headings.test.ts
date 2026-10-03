import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { globSync } from "node:fs"
import { join } from "node:path"

/**
 * Every route has exactly one `<h1>`, and every one is the same size.
 *
 * WHY A TEST AND NOT A COMPONENT
 * ------------------------------
 * The obvious fix for "24 page titles, two sizes, no rule" is a shared
 * `<PageTitle>`. One was written during this change and then deleted, because a
 * component only helps the pages that import it — and this repo has measured
 * what happens to a convention nothing enforces: CLAUDE.md's docs rule records
 * a rule that was written into the codebase in the same commit that last obeyed
 * it, and was then ignored for 35 days while 44 documents were born.
 *
 * A source scan is enforcement. It costs one file, it cannot be forgotten by a
 * page that hand-rolls its own heading, and when it fails it names the file.
 * Same shape as xrd-display-standard.test.ts, which pins compact-mode sites the
 * same way and has already caught a real regression this week.
 *
 * If a future page genuinely needs a different heading treatment, change the
 * rule here deliberately — that edit is reviewable, which a silent `text-xl`
 * was not.
 */

const APP = join(process.cwd(), "src/app")

/** Routes that legitimately have no `<h1>` of their own. */
const NO_H1_ALLOWED = new Set([
  // `redirect()` shells — they render nothing and immediately navigate away.
  // governance/page.tsx, governance-status/page.tsx, proposals/page.tsx and
  // proposals/[id]/page.tsx used to be redirect shells here too (into
  // /decisions); all four, and /decisions itself, were REMOVED outright
  // 2026-09-04 (bigdev's instruction), so none exists under src/app any more.
  "start/page.tsx",
  "how-it-works/page.tsx",
])

/** The one deliberate exception to the size rule, with its reason. */
const HERO_EXCEPTION = "guide/page.tsx"

function pageFiles(): string[] {
  return globSync("**/page.tsx", { cwd: APP }).sort()
}

/**
 * Source with comment LINES dropped, so prose about `<h1>` is not counted as an
 * `<h1>`.
 *
 * ⚠️ This function got it wrong twice before it got it right, and both failures
 * are the same family this repo keeps relearning — a naive scan reading its own
 * text as data:
 *
 *  1. The first version scanned raw source and reported `/mint` as having TWO
 *     h1s: the real one, and the string "<h1>" inside the comment explaining
 *     why the real one was added.
 *  2. The second stripped `/* … *\/` blocks by regex — and reported
 *     `/bug-bounty` as having NONE. Line 66 of that file is the STRING
 *     "The v1 API under /api/v1/*", whose `/*` opened a comment the regex then
 *     closed 125 lines later, eating the heading in between. Regex
 *     comment-stripping cannot tell a comment from a string literal.
 *
 * Dropping whole comment LINES is sound for both: a JSX/JS comment line starts
 * with a marker, and a string containing `/*` does not. It would miss an h1
 * buried mid-line in a comment, which is not a thing anyone writes.
 */
function code(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
    .join("\n")
}

describe("page headings", () => {
  it("every route has exactly one h1, except the redirect shells", () => {
    const missing: string[] = []
    const duplicated: string[] = []
    for (const rel of pageFiles()) {
      const src = code(readFileSync(join(APP, rel), "utf8"))
      const count = (src.match(/<h1[\s>]/g) ?? []).length
      if (count === 0) {
        if (!NO_H1_ALLOWED.has(rel)) missing.push(rel)
      } else if (count > 1) {
        // More than one h1 on a page is the same defect as none: it tells a
        // screen reader the page has two subjects.
        duplicated.push(`${rel} (${count})`)
      }
    }
    expect(missing, "routes with no <h1> — a page with no title has no subject").toEqual([])
    expect(duplicated, "routes with more than one <h1>").toEqual([])
  })

  it("every page h1 is text-2xl — one size, no exceptions but the guide hero", () => {
    const wrong: string[] = []
    for (const rel of pageFiles()) {
      if (rel === HERO_EXCEPTION) continue
      const src = code(readFileSync(join(APP, rel), "utf8"))
      for (const m of src.match(/<h1 className="[^"]*"/g) ?? []) {
        if (!m.includes("text-2xl")) wrong.push(`${rel}: ${m}`)
      }
    }
    expect(
      wrong,
      "page titles must all be text-2xl — 12 of 25 were text-xl with no rule distinguishing them",
    ).toEqual([])
  })

  it("the guide hero is still the ONE exception, and still a hero", () => {
    // Pinned so the exception cannot quietly become the norm, and so nobody
    // "fixes" a deliberate landing headline into a page title.
    const src = readFileSync(join(APP, HERO_EXCEPTION), "utf8")
    expect(src).toMatch(/<h1 className="text-4xl sm:text-5xl/)
  })

  it("CardTitle renders a heading, not a div", () => {
    // 108 usages across 27 files, all of them section headings. When this was a
    // <div> the entire section structure of the product was invisible to
    // heading navigation.
    const card = readFileSync(join(process.cwd(), "src/components/ui/card.tsx"), "utf8")
    expect(card).toMatch(/as:\s*Tag\s*=\s*"h2"/)
    expect(card).toMatch(/<Tag\s/)
  })
})
