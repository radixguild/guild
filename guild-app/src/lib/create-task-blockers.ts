/**
 * Why the create-task form's "Continue" button is disabled — as data.
 *
 * The button was `disabled={!canAdvance}` with the rule inlined in the page and
 * NOTHING on screen saying what it was waiting for. A first-time poster who
 * reached step 2 and left Reward empty saw a dead button: no message, no
 * `aria-invalid`, no hint (signed-out stranger walkthrough, 2026-09-17 —
 * docs/PROJECT-STATE.md). The same was true of step 1's title/description
 * minimums, which the helper text never mentioned.
 *
 * This module is the single source of both answers — "may the poster advance?"
 * and "if not, what exactly is missing?" — so the page cannot disable the
 * button for a reason it does not also print. It is pure so the rule is
 * unit-testable without rendering the page (which drags in the whole escrow
 * action tree — see tests/unit/create-task-github-reality.test.tsx's mocks).
 *
 * The review step never blocks. Step 1 is the old inlined rule's MINIMUMS
 * (title ≥ 5 trimmed chars AND description ≥ 10) PLUS the API's MAXIMA.
 *
 * STEP 1 HAS A MAXIMUM, from the API's own constants. The minimums alone let a
 * 201-character title (or a 5001-character description) clear step 1 and step 2
 * and fail only at Post Task, as a raw zod error — after the poster has written
 * the whole task. The maxima are TASK_TITLE_MAX_CHARS /
 * TASK_DESCRIPTION_MAX_CHARS (src/lib/marketplace.ts — the same numbers
 * createTaskSchema enforces), measured the way zod measures them: `.length` of
 * the UNTRIMMED value, because that is the string the page posts. The minimums
 * trim; the maxima must NOT, or 200 characters plus a trailing space would pass
 * here and be refused there. `.length` counts UTF-16 code units, so an emoji
 * counts as 2 on both sides — the message's "(it is N)" uses the same count, so
 * it can read higher than the characters a poster sees. That is the honest
 * number to show, because it is the number the API will apply.
 *
 * No `maxLength` attribute on the inputs, deliberately: it truncates a paste
 * silently, so a long description would lose its tail — often the acceptance
 * details — with nothing on screen saying so. A blocker names the limit and
 * leaves the text for the poster to cut.
 *
 * THE REWARD RULE IS NOT THE OLD ONE, deliberately. It was `Number(x) > 0`, and
 * that let a reward in (0, 1) XRD through — "0.5" passed here, passed the API,
 * created a DB task row, and then FUNDING reverted on chain: `create_task`
 * asserts `reward_amount >= min_amount` ("reward below per-token minimum") and
 * the live component registered XRD with min_amount 1. The input's `min`
 * attribute is a browser hint that nothing enforces. The rule is now `>= MIN_REWARD_XRD`
 * (src/lib/marketplace.ts — the same constant the API schema enforces), and the
 * message names the number so the poster is told the floor, not just "no".
 *
 * AND THE REWARD'S SHAPE IS THE API'S, not `Number()`'s. The floor alone was
 * `Number(x) >= min`, and `Number()` accepts what the API's regex refuses:
 * "1e3" (= 1000) and "1.000000001" (9 places) both cleared step 2, and the
 * poster met the refusal only after Post Task, as a raw zod error. Both reach
 * React from a real number input (Chromium, measured 2026-09-17). The rule now
 * tests REWARD_SHAPE_RE — the same object rewardAmountSchema tests — and the
 * floor with the API's own exact comparison, so the form advances exactly when
 * the API would take the reward (bar the API's zero lane; the form has none).
 *
 * AND IT IS BOUNDED ABOVE, since 2026-09-18. Sharing the API's regex is not the
 * same as sharing a CORRECT one: that regex bounded only the decimal half, so a
 * 21-digit reward cleared this module AND the schema in perfect agreement, and
 * then overflowed the numeric(38,18) column at the INSERT — a 500, and a poster
 * who had cleared every step. Both sides being wrong together is precisely what
 * a parity test cannot see, so the cap is pinned against the real column in
 * tests/unit/xrd-int-digits-column-parity.test.ts and end-to-end in
 * tests/integration/reward-column-overflow.pg.test.ts.
 */

import {
  MIN_REWARD_XRD,
  REWARD_MAX_DECIMALS,
  REWARD_SHAPE_RE,
  TASK_DESCRIPTION_MAX_CHARS,
  TASK_TITLE_MAX_CHARS,
  XRD_MAX_INT_DIGITS,
} from "@/lib/marketplace"
import { compareXrd, isAtLeastXrd } from "@/lib/xrd-decimal"

export type CreateStep = "what" | "reward" | "review" | "done"

export type CreateBlockerField = "title" | "description" | "reward"

export interface CreateBlocker {
  field: CreateBlockerField
  /** A complete sentence, shown to the poster verbatim. */
  message: string
}

export const TITLE_MIN_CHARS = 5
export const DESCRIPTION_MIN_CHARS = 10
/** Built from the constant, never typed out: a message that names a number
 *  the rule does not enforce is the defect this module exists to prevent. */
export const REWARD_BELOW_MIN_MESSAGE = `Enter a reward of at least ${MIN_REWARD_XRD} XRD.`
/** For a reward the API would refuse for its SHAPE while it is NOT below the
 *  floor ("1e3", "1.000000001") — where "at least 1 XRD" would be false. */
export const REWARD_SHAPE_MESSAGE = `Enter the reward as a plain number (like 250 or 12.5) with up to ${REWARD_MAX_DECIMALS} decimal places.`
/** For a reward refused for SIZE rather than form. It needs its own sentence
 *  because REWARD_SHAPE_MESSAGE is FALSE of this input: a 21-digit reward IS
 *  "a plain number with up to 8 decimal places" — it is simply larger than the
 *  numeric(38,18) column can hold (XRD_MAX_INT_DIGITS, marketplace.ts), which
 *  is the one thing wrong with it and so the one thing to say. */
export const REWARD_TOO_LARGE_MESSAGE = `Enter a reward with at most ${XRD_MAX_INT_DIGITS} digits before the decimal point.`

export interface CreateFormValues {
  title: string
  description: string
  rewardXrd: string
}

/** What is stopping the poster from leaving `step`? Empty = nothing; advance. */
export function createStepBlockers(step: CreateStep, values: CreateFormValues): CreateBlocker[] {
  const blockers: CreateBlocker[] = []
  if (step === "what") {
    if (values.title.trim().length < TITLE_MIN_CHARS) {
      blockers.push({
        field: "title",
        message: `Give the task a title of at least ${TITLE_MIN_CHARS} characters.`,
      })
    }
    // Untrimmed, on purpose — see the module note.
    if (values.title.length > TASK_TITLE_MAX_CHARS) {
      blockers.push({
        field: "title",
        message: tooLongMessage("title", TASK_TITLE_MAX_CHARS, values.title.length),
      })
    }
    if (values.description.trim().length < DESCRIPTION_MIN_CHARS) {
      blockers.push({
        field: "description",
        message: `Describe the work in at least ${DESCRIPTION_MIN_CHARS} characters.`,
      })
    }
    if (values.description.length > TASK_DESCRIPTION_MAX_CHARS) {
      blockers.push({
        field: "description",
        message: tooLongMessage(
          "description",
          TASK_DESCRIPTION_MAX_CHARS,
          values.description.length,
        ),
      })
    }
  } else if (step === "reward") {
    const message = rewardBlockerMessage(values.rewardXrd)
    if (message) blockers.push({ field: "reward", message })
  }
  return blockers
}

/** Built from the constant it names, like REWARD_BELOW_MIN_MESSAGE. The length
 *  is included because nobody can eyeball 5000 characters. */
function tooLongMessage(field: "title" | "description", max: number, length: number): string {
  return `Shorten the ${field} to ${max} characters or fewer (it is ${length}).`
}

/** True when `reward`'s integer part is all digits but longer than the reward
 *  column holds — i.e. the ONE thing REWARD_SHAPE_RE refuses it for. */
function hasOversizeIntegerPart(reward: string): boolean {
  const whole = reward.split(".")[0]
  return /^\d+$/.test(whole) && whole.length > XRD_MAX_INT_DIGITS
}

/** -1/0/1 against the floor, or null when `reward` is not an exact decimal at
 *  all — "1e3", ".5", "abc", or more places than `Decimal` holds. `compareXrd`
 *  throws on those (src/lib/xrd-decimal.ts), and a throw here is the ANSWER
 *  "no exact comparison exists", not an error to swallow blindly. */
function compareToFloor(reward: string): number | null {
  try {
    return compareXrd(reward, MIN_REWARD_XRD)
  } catch {
    return null
  }
}

/** null = the API would take this reward for a funded task. Otherwise the ONE
 *  sentence that is true of this input. */
function rewardBlockerMessage(reward: string): string | null {
  if (REWARD_SHAPE_RE.test(reward)) {
    // Well-formed: the API's own exact decimal comparison, not a float one —
    // literally the function rewardAmountSchema's floor refinement calls.
    return isAtLeastXrd(reward, MIN_REWARD_XRD) ? null : REWARD_BELOW_MIN_MESSAGE
  }
  // Malformed — the API refuses it whatever it is worth, so the only question
  // left is which sentence is TRUE of it.
  if (reward.trim() === "") return REWARD_BELOW_MIN_MESSAGE
  // Refused for SIZE, before the floor comparison below: a reward this long is
  // always ABOVE the floor, so that comparison would fall through to the shape
  // message — the sentence that is false of it (see REWARD_TOO_LARGE_MESSAGE).
  // Checked on the written integer part, matching what REWARD_SHAPE_RE counts;
  // an input whose integer part is not all digits ("999…9e5") is malformed for
  // a different reason and keeps the shape message.
  if (hasOversizeIntegerPart(reward)) return REWARD_TOO_LARGE_MESSAGE
  // Below the floor however it is written ("-5", "0.000000001", and the
  // 17-place "0.99999999999999999" that a double rounds UP to exactly 1) is
  // still too small: the floor is the true thing to say. Exact, because
  // `Number()` is not — it called that 17-place value "not below 1" and showed
  // the shape message for a reward that is genuinely under the minimum
  // (adversarial review, 2026-09-18; pinned in create-task-blockers.test.ts).
  const cmp = compareToFloor(reward)
  if (cmp !== null) return cmp < 0 ? REWARD_BELOW_MIN_MESSAGE : REWARD_SHAPE_MESSAGE
  // Not an exact decimal at all ("1e3", ".5", "1e-3", "abc", or 19+ places):
  // no exact answer exists, so `Number()` picks between two sentences that are
  // both true — and for the float-unsafe 19+-place case it picks the shape
  // message, which is the one that names what is actually wrong. It never
  // decides WHETHER the reward blocks; the regex already did.
  return Number(reward) < Number(MIN_REWARD_XRD) ? REWARD_BELOW_MIN_MESSAGE : REWARD_SHAPE_MESSAGE
}

/** True when `field` is one of the things currently blocking the step. */
export function isFieldBlocked(blockers: CreateBlocker[], field: CreateBlockerField): boolean {
  return blockers.some((b) => b.field === field)
}
