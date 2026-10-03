import { describe, it, expect } from "vitest"
import { createStepBlockers } from "@/lib/create-task-blockers"
import { createTaskSchema, updateTaskSchema } from "@/lib/validation"
import { XRD_MAX_INT_DIGITS } from "@/lib/marketplace"

/**
 * The create form and the API must agree on which rewards are acceptable.
 *
 * The defect (found 2026-09-17 in an adversarial test review of PR #704): the
 * form's step-2 rule judged the reward with `Number()`, the API with a shape
 * regex. "1e3" and "1.000000001" passed the form, so the poster cleared step 2,
 * reached Review, clicked Post Task, and only then got a 400 carrying a raw zod
 * error. No row was created. The poster was just told "fine" by one side and
 * "no" by the other.
 *
 * ONE table goes through BOTH sides: `createStepBlockers("reward", …)` (does the
 * form let the poster advance?) and `createTaskSchema.safeParse` (would
 * POST /api/v1/tasks take it?). Every row must get the same answer from both.
 *
 * THE ONE EXCEPTION, from validation.ts's rewardAmountSchema note: the API takes
 * a ZERO reward (the unfunded off-chain lane, decision F3), and the form has no
 * free lane, so it blocks zero. That covers EVERY well-formed spelling of zero
 * the API's regex allows, not only "0" ("00", "0.0" and "0.00000000" are
 * accepted too, and Chromium's number input delivers "00" and "0.0" as typed).
 * The exception is matched by a regex written out here, not taken from either
 * side, so a change on one side cannot quietly widen it.
 *
 * Falsifiable, and mutation-run 2026-09-17:
 *  - remove the REWARD_SHAPE_RE test from createStepBlockers (Number() only):
 *    the 7 exponent / 9-place rows and the 6 Chromium-filtered ones that
 *    Number() takes go red (form yes, API no), and so does the table guard.
 *  - in validation.ts, swap the imported regex for a local `\d{1,9}` one:
 *    "1.000000000", "1.000000001", "100.123456789" and "0.000000000" go red
 *    (API yes, form no).
 *  - the same local swap in create-task-blockers.ts instead: the first three of
 *    those go red the other way (form yes, API no).
 *  - change the SHARED digit count in marketplace.ts to 9: both sides move
 *    together, so the only row red here is "0.000000000", which the zero-lane
 *    literal below no longer covers. create-task-blockers.test.ts's literal
 *    pin is the check meant to catch that change.
 *
 * What this does NOT prove: that the page shows the message (see
 * create-task-continue-reason.test.tsx and the e2e spec), or anything about
 * PATCH (updateTaskSchema uses the same rewardAmountSchema; there is no form
 * for it). It also cannot tell whether a browser would ever deliver a row. The
 * rows marked `browser: false` are ones Chromium 147's number input filters
 * before React sees them. Firefox and Safari were not measured.
 */

type Row = { reward: string; browser: boolean }

const TABLE: Row[] = [
  // Well-formed and at least the floor: both sides take it.
  { reward: "1", browser: true },
  { reward: "1.00000000", browser: true },
  { reward: "1.00000001", browser: true },
  { reward: "50", browser: true },
  { reward: "1500.25", browser: true },
  { reward: "12.12345678", browser: true },
  { reward: "01", browser: true },
  { reward: "0001.5", browser: true },
  { reward: "99999999999999999999", browser: true },
  // The column boundary, both halves at their maximum at once.
  { reward: "99999999999999999999.12345678", browser: true },

  // Well-formed but below the floor: both refuse.
  { reward: "0.5", browser: true },
  { reward: "0.99999999", browser: true },
  { reward: "0.00000001", browser: true },
  { reward: "00.5", browser: true },

  // Zero: the one documented disagreement (API yes, form no).
  { reward: "0", browser: true },
  { reward: "00", browser: true },
  { reward: "0.0", browser: true },
  { reward: "0.00000000", browser: true },

  // THE DEFECT: `Number()` says at least 1, the regex says no.
  { reward: "1e3", browser: true },
  { reward: "1E3", browser: true },
  { reward: "1e+3", browser: true },
  { reward: "1e0", browser: true },
  { reward: "1.000000000", browser: true },
  { reward: "1.000000001", browser: true },
  { reward: "100.123456789", browser: true },

  // Malformed and below the floor: both refuse.
  { reward: "", browser: true },
  { reward: "-5", browser: true },
  { reward: "-0", browser: true },
  { reward: "-1e3", browser: true },
  { reward: "1e-3", browser: true },
  { reward: ".5", browser: true },
  { reward: "0.000000001", browser: true },
  { reward: "0.999999999", browser: true },
  { reward: "0.000000000", browser: true },
  // Past a double's precision, and measured in Chromium (typed and pasted):
  // 17 places rounds UP to exactly 1 in float, 22 places rounds to 1 either way.
  // Both sides refuse them on shape; which SENTENCE the form shows for them is
  // create-task-blockers.test.ts's business, not this file's.
  { reward: "0.99999999999999999", browser: true },
  { reward: "1.0000000000000000000001", browser: true },
  { reward: "0.9999999999999999999999", browser: true },

  // ONE DIGIT OVER THE COLUMN. `tasks.reward_xrd` is numeric(38,18) = 20
  // integer digits, and until 2026-09-18 the shared regex bounded only the
  // DECIMAL half, so these cleared the form AND the schema, reached the INSERT,
  // and came back as a 500 (see BOUNDARY below). Chromium's number input
  // delivers them: it filters shape, never magnitude.
  { reward: "999999999999999999999", browser: true },
  { reward: "999999999999999999999.5", browser: true },
  { reward: "100000000000000000000", browser: true },

  // Refused by the API, filtered out by Chromium's number input first.
  { reward: "   ", browser: false },
  { reward: " 1", browser: false },
  { reward: "1 ", browser: false },
  { reward: "+1", browser: false },
  { reward: "1.", browser: false },
  { reward: "0x1", browser: false },
  { reward: "Infinity", browser: false },
  { reward: "NaN", browser: false },
  { reward: "abc", browser: false },
  { reward: "1,5", browser: false },
  { reward: "1_000", browser: false },
]

/** Written out, not imported: every well-formed spelling of zero. */
const ZERO_LANE = /^0+(\.0{1,8})?$/

const formAccepts = (reward: string) =>
  createStepBlockers("reward", { title: "A real task title", description: "A description long enough", rewardXrd: reward })
    .length === 0

const apiAccepts = (reward: string) =>
  createTaskSchema.safeParse({ title: "Fix bug in auth", description: "The auth flow fails when...", reward_amount: reward })
    .success

describe("reward parity — the create form advances exactly when POST /api/v1/tasks would accept", () => {
  it.each(TABLE.map((r) => [r.reward, r]))("%j", (_label, row) => {
    const form = formAccepts(row.reward)
    const api = apiAccepts(row.reward)
    if (ZERO_LANE.test(row.reward)) {
      // Asserted in full, not just "they may differ": if the API ever stops
      // taking zero, this goes red and the exception gets re-read.
      expect({ form, api }).toEqual({ form: false, api: true })
    } else {
      expect({ form, api }).toEqual({ form: api, api })
    }
  })

  // Vacuous-pass guard. A table that only held rows both sides refuse would pass
  // against a form that blocked everything.
  it("the table has rows on every side of the rule", () => {
    const accepted = TABLE.filter((r) => formAccepts(r.reward) && apiAccepts(r.reward))
    const refused = TABLE.filter((r) => !formAccepts(r.reward) && !apiAccepts(r.reward))
    const zero = TABLE.filter((r) => ZERO_LANE.test(r.reward))
    // The rows the old Number() rule got wrong: no API regex match, yet Number() >= 1.
    const numberOnly = TABLE.filter((r) => !/^\d+(\.\d{1,8})?$/.test(r.reward) && Number(r.reward) >= 1)
    expect(accepted.length).toBeGreaterThanOrEqual(8)
    expect(refused.length).toBeGreaterThanOrEqual(20)
    expect(zero.length).toBeGreaterThanOrEqual(4)
    expect(numberOnly.filter((r) => r.browser).length).toBeGreaterThanOrEqual(5)
    // The rows that ONLY the integer-digit cap refuses. The integer-length term
    // is what makes this isolate them: without it the filter is also satisfied
    // by the four below-floor rows ("0.5", "00.5", …), which match the old
    // unbounded shape and are refused for a different reason entirely — so the
    // guard would stay green under the very mutation it exists to catch
    // (measured while writing it, 2026-09-18).
    const oversizeOnly = TABLE.filter(
      (r) =>
        /^\d+(\.\d{1,8})?$/.test(r.reward) &&
        r.reward.split(".")[0].length > XRD_MAX_INT_DIGITS &&
        !apiAccepts(r.reward),
    )
    expect(oversizeOnly.length).toBeGreaterThanOrEqual(3)
  })
})

/**
 * THE COLUMN BOUNDARY — the rule that makes the cap falsifiable.
 *
 * Reproduced end-to-end 2026-09-18 against a real Postgres (pglite) through the
 * REAL route handlers, before the fix: 20 digits -> 201 with the row written,
 * 21 digits -> 500 {"code":"INTERNAL_ERROR","message":"Internal server error"}
 * on BOTH `POST /api/v1/tasks` and `PATCH /api/v1/tasks/[id]`, from an
 * unmapped Postgres `22003 numeric field overflow` — where the API's contract
 * is a 400 VALIDATION_ERROR, and where the poster had already cleared every
 * step of the wizard.
 *
 * MUTATION-PROVEN against THE NAMED DEFECT, run 2026-09-18: restore the
 * unbounded integer part in marketplace.ts — `^\d+(\.\d{1,8})?$`, exactly what
 * shipped before this fix — and four assertions go red: both halves of "one
 * digit over the column is refused", the PATCH one, the constant-is-the-cap
 * one, and (in xrd-int-digits-column-parity.test.ts) the regex round-trip.
 * The `oversizeOnly` guard goes red too — but ONLY since its integer-length
 * term was added; the first version of it stayed green, see the note there.
 * Narrowing the cap to 19 instead turns "the last width the column can hold is
 * accepted" red on "99999999999999999999", so it is anchored in both
 * directions and cannot pass for a regex that is merely *different*.
 *
 * What the three new TABLE rows do NOT prove, and why they are still here: the
 * table asserts AGREEMENT, and under the unbounded regex both sides accept 21
 * digits, so they agree and the rows stay green. That is the shared
 * definition working as designed. The rows guard the other regression — one
 * side capped and the other not — which is the shape this whole file exists
 * for; the boundary block below is what pins the cap itself.
 */
describe("reward integer digits — the numeric(38,18) column boundary", () => {
  const AT_LIMIT = "9".repeat(XRD_MAX_INT_DIGITS)
  const OVER_LIMIT = "9".repeat(XRD_MAX_INT_DIGITS + 1)

  it("the last width the column can hold is accepted by both sides", () => {
    expect(AT_LIMIT).toHaveLength(20)
    expect(formAccepts(AT_LIMIT)).toBe(true)
    expect(apiAccepts(AT_LIMIT)).toBe(true)
    expect(apiAccepts(`${AT_LIMIT}.12345678`)).toBe(true)
  })

  it("one digit over the column is refused by both sides", () => {
    expect(OVER_LIMIT).toHaveLength(21)
    expect(formAccepts(OVER_LIMIT)).toBe(false)
    expect(apiAccepts(OVER_LIMIT)).toBe(false)
  })

  it("PATCH refuses it too — the same schema, and the path with no form in front of it", () => {
    // updateTaskSchema reuses rewardAmountSchema, so a cap on create alone
    // would be a cap with a side door: post at "1", PATCH to 21 digits, and
    // the UPDATE overflows the same column. Measured as a 500 before the fix.
    expect(updateTaskSchema.safeParse({ reward_amount: AT_LIMIT }).success).toBe(true)
    expect(updateTaskSchema.safeParse({ reward_amount: OVER_LIMIT }).success).toBe(false)
  })

  it("the constant is the cap the regex actually enforces, not just a label", () => {
    // A message naming a number the rule does not enforce is the defect
    // create-task-blockers.ts exists to prevent; same standard for the schema.
    expect(apiAccepts("9".repeat(XRD_MAX_INT_DIGITS))).toBe(true)
    expect(apiAccepts("9".repeat(XRD_MAX_INT_DIGITS + 1))).toBe(false)
  })
})
