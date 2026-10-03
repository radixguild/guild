// The catalogue's own copy must survive the public-text scrub unchanged.
//
// WHY THIS EXISTS. `sanitizeTaskTextForPublic` rewrites a task's title and
// description for anyone who is not a party to it. On-chain `submit_task`
// asserts sha256(canonicalWorkBrief(title, description)) against the hash the
// POSTER funded — so a task whose text the scrub touches can be claimed and
// then never submitted. That is not hypothetical: it happened to board task 90
// on 2026-09-15, and the trigger was the single word "VPS" in the catalogue's
// P7-02 Notes line, which the host-alias rule rewrites to <host>.
//
// Two gates were added after that: `POST /api/v1/tasks` refuses with
// SCRUB_UNSTABLE_TEXT (#656), and post-micro-tasks.mjs validates a whole batch
// before funding any row of it. Both fire at POSTING time, on text a human has
// already written and is about to pay for. Neither looks at
// docs/guild-task-board.json, which is where that text is drafted — so the
// catalogue could (and did) go on accumulating rows that are unpostable as
// written. Scanning all 113 rows on 2026-09-16 found five more: P1-13
// (GUILD_AGENT_PRIVATE_KEY), P2-12 (a quoted remote-shell command plus the
// Guild host alias), P5-06 (TG_BOT_TOKEN), P5-08 and P6-10 ("VPS", and
// P6-10 also DATABASE_URL + JWT_SECRET). All five were reworded; this test is
// what stops the sixth.
//
// It checks the SOURCE fields rather than a reconstructed description because
// a posting is assembled by hand from them — scope, acceptance, notes and the
// title all end up in the copy, and any one of them can carry the trigger.
// Deliberately NOT checked: `files` (bare repo-relative paths, no leading
// slash, so no rule matches) and `source`/`depends_on`/`id` (identifiers, never
// prose). Add a field here the day it starts reaching task copy.
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { scrubWouldChange } from "@/lib/public-task-text"
import { privateInputs } from "../support/private-input"

const CATALOGUE_PATH = join(process.cwd(), "..", "docs", "guild-task-board.json")

type CatalogueRow = {
  id: string
  title?: string
  scope?: string
  notes?: string
  acceptance?: string[]
}

// docs/guild-task-board.json stays private at the open-source flip — skip in
// the public export, throw in the private tree if it ever goes missing
// (tests/support/private-input.ts).
const PRIV = privateInputs("docs/guild-task-board.json")
const rows: CatalogueRow[] = PRIV.skip ? [] : JSON.parse(readFileSync(CATALOGUE_PATH, "utf8"))

describe.skipIf(PRIV.skip)("docs/guild-task-board.json is postable as written (public-text scrub stability)", () => {
  it("the catalogue is a non-empty array of identified rows", () => {
    // A guard that cannot disarm itself: if the file's shape changes and `rows`
    // comes back empty, it.each below would silently register zero cases and
    // the suite would go green having checked nothing.
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(50)
    expect(rows.every((r) => typeof r.id === "string" && r.id.length > 0)).toBe(true)
  })

  it.each(rows.map((r) => [r.id, r] as const))(
    "%s: no field would be rewritten before a claimer reads it",
    (id, row) => {
      const fields: [string, string][] = [
        ["title", row.title ?? ""],
        ["scope", row.scope ?? ""],
        ["notes", row.notes ?? ""],
        ...(row.acceptance ?? []).map((a, i) => [`acceptance[${i}]`, a] as [string, string]),
      ]
      for (const [field, text] of fields) {
        if (!text) continue
        // scrubWouldChange takes (title, description) and reports which one
        // moved; pass the field under test as the description so the empty
        // title can never be the one that trips, and the reported fragment is
        // always from the text we are naming.
        const unstable = scrubWouldChange("", text)
        expect(
          unstable,
          `${id} ${field} would be rewritten by the public-text scrub (near: "${unstable?.fragment ?? ""}") — ` +
            `posting it would be refused by POST /api/v1/tasks (SCRUB_UNSTABLE_TEXT), and on an older ` +
            `path it would post and then be unsubmittable. Reword the catalogue, do not weaken the scrub.`,
        ).toBeNull()
      }
    },
  )
})
