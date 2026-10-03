import { describe, it, expect } from "vitest"
import { createStepBlockers } from "@/lib/create-task-blockers"
import { createTaskSchema } from "@/lib/validation"

/**
 * The create form and the API must agree on which titles and descriptions are
 * too long.
 *
 * The defect (found 2026-09-17 while building PR #705): the form's step-1 rule
 * checked only MINIMUM lengths, while createTaskSchema also caps the title at
 * 200 and the description at 5000. A poster with a 201-character title cleared
 * step 1 and step 2, reached Review, clicked Post Task, and only then got a 400
 * — shown as raw zod JSON. No row was created.
 *
 * ONE table goes through BOTH sides: `createStepBlockers("what", …)` (does the
 * form let the poster advance?) and `createTaskSchema.safeParse` (would
 * POST /api/v1/tasks take it?). The reward is a valid one, so only the title and
 * description decide.
 *
 * THE ONE EXCEPTION: the form's MINIMUMS are stricter than the API's (title ≥ 5
 * and description ≥ 10 characters after trimming; the API asks for 1,
 * untrimmed). A row under a form minimum must be refused by the form, whatever
 * the API says. That lane is picked by a predicate written out here, not taken
 * from either side, so a change on one side cannot quietly widen it. The guard
 * below requires rows in that lane that the API DOES take, so if the API ever
 * tightens its minimum, this goes red and the exception gets re-read.
 *
 * Falsifiable, and mutation-run 2026-09-17 (each against the defect it names):
 *  - the parent branch's createStepBlockers (minimums only — THE DEFECT): all 11
 *    over-the-max rows go red (form yes, API no).
 *  - delete only the title max check: the 6 over-long title rows go red.
 *  - measure the form's max on the TRIMMED string: the 4 padded rows (200 chars
 *    plus a space, a space plus 200, and the description twins) go red.
 *  - measure the form's title max in code points (`[...title].length`): the 2
 *    emoji rows that are 201+ code units but ≤ 200 code points go red.
 *  - in validation.ts, swap TASK_TITLE_MAX_CHARS for a local 201: the 4 rows of
 *    exactly 201 code units go red the other way (API yes, form no), and so does
 *    the guard's over-max count.
 *  - add `.trim()` to createTaskSchema's title: the 2 padded title rows go red
 *    (API yes, form no), and the guard.
 *  - raise the API's minimums to the form's (5 / 10): no row goes red — the lane
 *    asserts only the form — but the guard's "form stricter" count does.
 *  - change the SHARED constant in marketplace.ts: both sides move together and
 *    this stays green, by design. `gen-openapi --check` in CI is what catches
 *    that change (public/openapi.json publishes maxLength).
 *
 * What this does NOT prove: that the page shows the message (see
 * create-task-continue-reason.test.tsx), or anything about PATCH
 * (updateTaskSchema uses the same constants; there is no edit form). It says
 * nothing about what a browser delivers: a text input or textarea keeps every
 * character here, including the leading and trailing spaces, and React passes
 * the value through untouched.
 */

type Row = { label: string; title: string; description: string }

const T = "A real task title"
const D = "A description long enough to pass."
const EMOJI = "\u{1F600}" // 1 code point, 2 UTF-16 code units

const x = (n: number) => "x".repeat(n)
const y = (n: number) => "y".repeat(n)

const TABLE: Row[] = [
  // Within every limit: both sides take it.
  { label: "ordinary title + description", title: T, description: D },
  { label: "title exactly at the form minimum (5)", title: x(5), description: D },
  { label: "description exactly at the form minimum (10)", title: T, description: y(10) },
  { label: "title 199", title: x(199), description: D },
  { label: "title exactly 200", title: x(200), description: D },
  { label: "title 200 with its padding inside the 200", title: `  ${x(196)}  `, description: D },
  { label: "title 198 + one emoji = 200 code units", title: x(198) + EMOJI, description: D },
  { label: "title of 100 emoji = 200 code units", title: EMOJI.repeat(100), description: D },
  { label: "description 4999", title: T, description: y(4999) },
  { label: "description exactly 5000", title: T, description: y(5000) },
  { label: "description of 1000 five-char lines = 5000", title: T, description: "line\n".repeat(1000) },
  { label: "both exactly at the max", title: x(200), description: y(5000) },

  // THE DEFECT: over the API's max, but clear of the form's minimums.
  { label: "title 201", title: x(201), description: D },
  { label: "title 1000", title: x(1000), description: D },
  { label: "title 200 + a trailing space", title: x(200) + " ", description: D },
  { label: "title a leading space + 200", title: " " + x(200), description: D },
  { label: "title 199 + one emoji = 201 code units", title: x(199) + EMOJI, description: D },
  { label: "title of 101 emoji = 202 code units", title: EMOJI.repeat(101), description: D },
  { label: "description 5001", title: T, description: y(5001) },
  { label: "description 5000 + a trailing newline", title: T, description: y(5000) + "\n" },
  { label: "description a leading newline + 5000", title: T, description: "\n" + y(5000) },
  { label: "description 4999 + one emoji = 5001 code units", title: T, description: y(4999) + EMOJI },
  { label: "both over the max", title: x(201), description: y(5001) },

  // Under a form minimum, inside the API's limits: form no, API yes.
  { label: "title of 4", title: x(4), description: D },
  { label: "title of whitespace only", title: "     ", description: D },
  { label: "title padded to 7, 3 after trim", title: "  abc  ", description: D },
  { label: "description of 9", title: T, description: y(9) },
  { label: "description of 10 spaces", title: T, description: " ".repeat(10) },

  // Under a form minimum AND over the API's max: both refuse.
  { label: "title of 2 + 300 spaces", title: "ab" + " ".repeat(300), description: D },
  { label: "description of 5001 spaces", title: T, description: " ".repeat(5001) },

  // Under the API's minimum too: both refuse.
  { label: "empty title", title: "", description: D },
  { label: "empty description", title: T, description: "" },
]

/** Written out, not imported: the form's minimums, which are stricter than the API's. */
const BELOW_FORM_MIN = (r: Row) => r.title.trim().length < 5 || r.description.trim().length < 10

const formAccepts = (r: Row) =>
  createStepBlockers("what", { title: r.title, description: r.description, rewardXrd: "500" }).length === 0

const apiAccepts = (r: Row) =>
  createTaskSchema.safeParse({ title: r.title, description: r.description, reward_amount: "500" }).success

describe("length parity — the create form's step 1 advances exactly when POST /api/v1/tasks would accept", () => {
  it.each(TABLE.map((r) => [r.label, r]))("%s", (_label, row) => {
    const form = formAccepts(row)
    const api = apiAccepts(row)
    if (BELOW_FORM_MIN(row)) {
      expect(form).toBe(false)
    } else {
      expect({ form, api }).toEqual({ form: api, api })
    }
  })

  // Vacuous-pass guard. A table of rows both sides accept would pass against a
  // form with no max at all.
  it("the table has rows on every side of the rule, including the ones each mutation needs", () => {
    const both = TABLE.filter((r) => formAccepts(r) && apiAccepts(r))
    const overMaxOnly = TABLE.filter((r) => !BELOW_FORM_MIN(r) && !apiAccepts(r))
    const formStricter = TABLE.filter((r) => BELOW_FORM_MIN(r) && apiAccepts(r))
    // Written-out limits, so the guard does not lean on the constants under test.
    const over = (r: Row) => r.title.length > 200 || r.description.length > 5000
    const overOnlyUntrimmed = TABLE.filter((r) => over(r) && r.title.trim().length <= 200 && r.description.trim().length <= 5000)
    const overOnlyInCodeUnits = TABLE.filter((r) => over(r) && [...r.title].length <= 200 && [...r.description].length <= 5000)
    const atTheMax = TABLE.filter((r) => r.title.length === 200 || r.description.length === 5000)
    const oneOver = TABLE.filter((r) => r.title.length === 201 || r.description.length === 5001)

    expect(both.length).toBeGreaterThanOrEqual(10)
    expect(overMaxOnly.length).toBeGreaterThanOrEqual(10)
    expect(formStricter.length).toBeGreaterThanOrEqual(4)
    expect(overOnlyUntrimmed.length).toBeGreaterThanOrEqual(4)
    expect(overOnlyInCodeUnits.length).toBeGreaterThanOrEqual(3)
    expect(atTheMax.length).toBeGreaterThanOrEqual(4)
    expect(oneOver.length).toBeGreaterThanOrEqual(4)
  })
})
