import { describe, it, expect } from "vitest"
import {
  createStepBlockers,
  isFieldBlocked,
  TITLE_MIN_CHARS,
  DESCRIPTION_MIN_CHARS,
  REWARD_BELOW_MIN_MESSAGE,
  REWARD_SHAPE_MESSAGE,
  REWARD_TOO_LARGE_MESSAGE,
} from "@/lib/create-task-blockers"
import { MIN_REWARD_XRD, REWARD_SHAPE_RE, XRD_MAX_INT_DIGITS } from "@/lib/marketplace"

/**
 * The rule behind the create form's disabled "Continue" button, as data.
 *
 * What this file is FOR: the button used to be disabled with nothing on screen
 * saying why (stranger walkthrough 2026-09-17). The page now prints exactly the
 * messages this function returns, so "the button is disabled" and "the page says
 * what is missing" cannot come apart — IF this function returns a message for
 * every way a step can be blocked. That is what is pinned here.
 *
 * It also pins the reward FLOOR. A reward in (0, 1) XRD is not fundable on
 * chain — `create_task` asserts `reward_amount >= min_amount` and the live
 * component registered XRD with min_amount 1 — and until 2026-09-17 this rule
 * was `> 0`, so "0.5" sailed through, became a task row, and stranded its
 * poster at a funding tx that could only revert. This file used to list "0.5"
 * among the rewards that block NOTHING; that expectation was the defect, pinned.
 *
 * And it pins the reward SHAPE. The floor was checked with `Number()`, which
 * takes "1e3" and "1.000000001"; the API's regex does not, so both cleared step 2
 * and failed only at Post Task. A shape failure has its own message, because
 * "at least 1 XRD" is false of 1e3.
 *
 * What it does NOT prove: that the page renders the messages (that is
 * create-task-continue-reason.test.tsx), that the API refuses the same band
 * (validation.test.ts + the two route tests; create-task-reward-parity.test.ts
 * holds the two sides to one table), or that MIN_REWARD_XRD is the
 * number the chain actually enforces (escrow-address-drift.test.ts ties it to
 * the registry; nothing in CI reads the ledger).
 */

const OK = { title: "A real task title", description: "A description long enough", rewardXrd: "500" }

describe("createStepBlockers — step 1 (what)", () => {
  it("a valid title + description blocks nothing", () => {
    expect(createStepBlockers("what", OK)).toEqual([])
  })

  it("an empty form names BOTH missing fields, title first", () => {
    const b = createStepBlockers("what", { ...OK, title: "", description: "" })
    expect(b.map((x) => x.field)).toEqual(["title", "description"])
    expect(b[0].message).toContain(String(TITLE_MIN_CHARS))
    expect(b[1].message).toContain(String(DESCRIPTION_MIN_CHARS))
  })

  it("whitespace does not count toward either minimum", () => {
    const b = createStepBlockers("what", { ...OK, title: "  Hi   ", description: "   short   " })
    expect(b.map((x) => x.field)).toEqual(["title", "description"])
  })

  it("the boundary is inclusive: exactly the minimum length passes", () => {
    const b = createStepBlockers("what", {
      ...OK,
      title: "x".repeat(TITLE_MIN_CHARS),
      description: "y".repeat(DESCRIPTION_MIN_CHARS),
    })
    expect(b).toEqual([])
  })

  it("one char under either minimum blocks that field alone", () => {
    expect(
      createStepBlockers("what", { ...OK, title: "x".repeat(TITLE_MIN_CHARS - 1) }).map((x) => x.field),
    ).toEqual(["title"])
    expect(
      createStepBlockers("what", { ...OK, description: "y".repeat(DESCRIPTION_MIN_CHARS - 1) }).map((x) => x.field),
    ).toEqual(["description"])
  })

  it("an empty reward does NOT block step 1 — it is not this step's question", () => {
    expect(createStepBlockers("what", { ...OK, rewardXrd: "" })).toEqual([])
  })
})

describe("createStepBlockers — step 2 (reward)", () => {
  // The walkthrough's exact case first: reward left EMPTY.
  it.each([
    ["empty", ""],
    ["zero", "0"],
    ["negative", "-5"],
    ["non-numeric", "abc"],
    ["whitespace", "   "],
  ])("a %s reward blocks with a message naming the reward", (_label, rewardXrd) => {
    const b = createStepBlockers("reward", { ...OK, rewardXrd })
    expect(b).toHaveLength(1)
    expect(b[0].field).toBe("reward")
    expect(b[0].message).toMatch(/reward/i)
  })

  // THE DEFECT, pinned from the other side. Every value here is a positive,
  // well-formed XRD amount — the old `> 0` rule let all of them through — and
  // every one reverts `create_task` ("reward below per-token minimum").
  // Falsifiable: restore `Number(x) > 0` in createStepBlockers and all three go
  // red, because `toEqual([])` is what that rule returns for them.
  it.each([["0.5"], ["0.99999999"], ["0.00000001"]])(
    "a positive reward BELOW the escrow minimum (%s) blocks, and the message names the minimum",
    (rewardXrd) => {
      const b = createStepBlockers("reward", { ...OK, rewardXrd })
      expect(b).toEqual([{ field: "reward", message: REWARD_BELOW_MIN_MESSAGE }])
      expect(b[0].message).toContain(`at least ${MIN_REWARD_XRD} XRD`)
    },
  )

  // "abc" used to be in this list. It blocked with "at least 1 XRD", which is not
  // what is wrong with it; it now gets the shape message (see the SHAPE block).
  it("empty, zero, negative and too-small all get the SAME message — they are one instruction", () => {
    for (const rewardXrd of ["", "   ", "0", "-5", "0.5"]) {
      expect(createStepBlockers("reward", { ...OK, rewardXrd })[0].message).toBe(REWARD_BELOW_MIN_MESSAGE)
    }
  })

  it("the minimum is inclusive: exactly MIN_REWARD_XRD blocks nothing", () => {
    expect(createStepBlockers("reward", { ...OK, rewardXrd: MIN_REWARD_XRD })).toEqual([])
    expect(createStepBlockers("reward", { ...OK, rewardXrd: `${MIN_REWARD_XRD}.00000000` })).toEqual([])
  })

  it.each([["1"], ["1.00000001"], ["50"], ["1500.25"]])("a reward at or above the minimum (%s) blocks nothing", (rewardXrd) => {
    expect(createStepBlockers("reward", { ...OK, rewardXrd })).toEqual([])
  })

  // The literal, once. Everything above follows the constant, so it would stay
  // green if MIN_REWARD_XRD were changed to a number the chain does not
  // enforce; this is the line that makes such a change a visible, deliberate
  // edit in a diff (escrow-address-drift.test.ts is the check that it is RIGHT).
  it("reads, today, 'Enter a reward of at least 1 XRD.'", () => {
    expect(REWARD_BELOW_MIN_MESSAGE).toBe("Enter a reward of at least 1 XRD.")
  })

  it("an invalid TITLE does not block step 2 — the poster already passed step 1's gate", () => {
    expect(createStepBlockers("reward", { ...OK, title: "" })).toEqual([])
  })
})

describe("createStepBlockers — step 2, the reward's SHAPE (the API's regex, not Number())", () => {
  // THE DEFECT. Each value is at or above the floor as far as `Number()` can
  // tell, and each is refused by the API's shape regex with a 400. The old rule
  // `!(Number(x) >= min)` returned [] for every one: step 2 cleared, the poster
  // reached Review, and Post Task answered with a raw zod error.
  // All of these reach React from a real <input type="number"> (Chromium 147,
  // typed, pasted and filled — measured 2026-09-17).
  // Falsifiable: delete the REWARD_SHAPE_RE test from createStepBlockers (back
  // to Number() alone) and every row goes red at `toEqual`, because the rule
  // then returns [] for them.
  it.each([["1e3"], ["1E3"], ["1e+3"], ["1e0"], ["1.000000000"], ["1.000000001"], ["100.123456789"]])(
    "%j blocks with the SHAPE message — it is not below the floor, so the floor message would be false",
    (rewardXrd) => {
      expect(createStepBlockers("reward", { ...OK, rewardXrd })).toEqual([{ field: "reward", message: REWARD_SHAPE_MESSAGE }])
      expect(REWARD_SHAPE_MESSAGE).not.toMatch(/at least/)
    },
  )

  // Also refused by the API, but a real Chromium number input does NOT hand
  // these to React as typed: it drops " ", "+", "x", "," and "_" ("0x1" arrives
  // as "01", "1_000" as "1000"), "1." reports "1", and "Infinity" / "abc" arrive
  // as nothing at all. Pinned at the pure
  // level anyway — the function must not depend on the browser's filtering.
  it.each([[" 1"], ["1 "], ["+1"], ["1."], ["0x1"], ["Infinity"], ["abc"], ["1,5"], ["1_000"]])(
    "%j (not reachable from Chromium's number input) also blocks with the SHAPE message",
    (rewardXrd) => {
      expect(createStepBlockers("reward", { ...OK, rewardXrd })).toEqual([{ field: "reward", message: REWARD_SHAPE_MESSAGE }])
    },
  )

  // Malformed AND below the floor: the floor is still the true thing to say
  // ("-5" is not "at least 1 XRD"; telling its poster to write a "plain number"
  // would not fix it). Every row here reaches React from Chromium's number input.
  // "0.99999999999999999" is the row that matters: 17 places, genuinely below 1,
  // but `Number()` rounds it UP to exactly 1, so a float comparison calls it
  // "not below the floor" and shows the shape message for a reward that IS too
  // small (adversarial review, 2026-09-18). Chromium delivers it verbatim,
  // typed and pasted. Falsifiable: put `Number(reward) < Number(MIN_REWARD_XRD)`
  // back in front of the exact compare in rewardBlockerMessage and this row
  // alone goes red.
  it.each([["-5"], ["-0"], ["-1e3"], ["1e-3"], [".5"], ["0.000000001"], ["0.999999999"], ["0.99999999999999999"]])(
    "%j is malformed AND below the floor — blocks with the FLOOR message",
    (rewardXrd) => {
      expect(createStepBlockers("reward", { ...OK, rewardXrd })).toEqual([{ field: "reward", message: REWARD_BELOW_MIN_MESSAGE }])
    },
  )

  // Odd but well-formed: the API takes these ("01" is what Chromium makes of a
  // typed "0x1"), so blocking them would be the opposite disagreement.
  it.each([["01"], ["0001.5"], ["1.00000000"], ["99999999999999999999"]])(
    "%j is well-formed and at least the floor — blocks nothing",
    (rewardXrd) => {
      expect(createStepBlockers("reward", { ...OK, rewardXrd })).toEqual([])
    },
  )

  // The invariant this module exists for, checked against a regex LITERAL
  // written here rather than the shared object, so it cannot pass by comparing
  // the rule with itself: whenever step 2 blocks, the sentence is true of the
  // input. The shape message only for input that is not a plain ≤8-place
  // decimal; the floor message only for input that is blank or below 1.
  // The oracle for "at least 1 XRD" is written out here in whole-part terms —
  // a plain decimal is >= 1 exactly when its integer part has a non-zero digit,
  // at any precision — so it is neither the code under test nor the `Number()`
  // compare that code falls back to. With `Number()` as the oracle (what this
  // test used until 2026-09-18) the 17-place row below agreed with the
  // implementation's own rounding error and the invariant passed vacuously.
  it("every reward message is TRUE of the input it is shown for", () => {
    const PLAIN_8DP = /^\d+(\.\d{1,8})?$/
    const atLeastOneXrd = (v: string): boolean | null => {
      if (/^-\d+(\.\d+)?$/.test(v)) return false // any negative is under 1
      if (!/^\d+(\.\d+)?$/.test(v)) return null // "1e3", ".5", "abc": no exact answer
      return /[1-9]/.test(v.split(".")[0])
    }
    const rows = [
      "", "   ", "0", "00", "0.5", "0.99999999", "-5", "-0", "1e-3", ".5", "0.000000001", "0.999999999",
      "0.99999999999999999", "1.0000000000000000000001",
      "1e3", "1E3", "1e+3", "1.000000000", "1.000000001", " 1", "+1", "1.", "0x1", "Infinity", "abc", "1,5",
      // Over the numeric(38,18) column (2026-09-18). These are the rows that
      // make the third message necessary: they ARE plain decimals, so
      // REWARD_SHAPE_MESSAGE is false of them, and they are far ABOVE the
      // floor, so REWARD_BELOW_MIN_MESSAGE is false of them too.
      "9".repeat(21), "9".repeat(21) + ".5", "1" + "0".repeat(20),
      // Oversize AND malformed: the integer part is not all digits, so the
      // shape message is the apt one and this must NOT take the size branch.
      "9".repeat(21) + "e5",
    ]
    let shapeRows = 0
    let floorRows = 0
    let sizeRows = 0
    for (const rewardXrd of rows) {
      const b = createStepBlockers("reward", { ...OK, rewardXrd })
      expect(b, rewardXrd).toHaveLength(1)
      if (b[0].message === REWARD_TOO_LARGE_MESSAGE) {
        sizeRows++
        // True of the input: it really does have more digits before the point
        // than the column holds — and it is NOT below the floor, which is what
        // makes the other two sentences false of it.
        expect(
          rewardXrd.split(".")[0],
          `${JSON.stringify(rewardXrd)} got the size message but its integer part is not oversize digits`,
        ).toMatch(new RegExp(`^\\d{${XRD_MAX_INT_DIGITS + 1},}$`))
      } else if (b[0].message === REWARD_SHAPE_MESSAGE) {
        shapeRows++
        // PLAIN_8DP is unbounded in its integer part on purpose: it asks "is
        // this a plain decimal?", which is the thing REWARD_SHAPE_MESSAGE
        // claims is wrong. An oversize-but-plain reward matches it, and that
        // is precisely why such a reward must have taken the branch above.
        expect(PLAIN_8DP.test(rewardXrd), `${JSON.stringify(rewardXrd)} got the shape message but is a plain decimal`).toBe(false)
      } else {
        floorRows++
        expect(b[0].message).toBe(REWARD_BELOW_MIN_MESSAGE)
        const exact = atLeastOneXrd(rewardXrd)
        if (rewardXrd.trim() === "") continue // "enter a reward" is true of nothing entered
        if (exact !== null) {
          expect(exact, `${JSON.stringify(rewardXrd)} got the floor message but IS at least 1 XRD`).toBe(false)
        } else {
          // Not a plain decimal, so no exact answer exists; the float read is
          // the only one available and must at least agree.
          expect(Number(rewardXrd) < 1, `${JSON.stringify(rewardXrd)} got the floor message but is not below 1`).toBe(true)
        }
      }
    }
    // Vacuous-pass guard: both branches were actually exercised.
    expect(shapeRows).toBeGreaterThanOrEqual(5)
    expect(floorRows).toBeGreaterThanOrEqual(5)
    expect(sizeRows).toBe(3)
  })

  // The literals, once — the same role as the floor message's pin above. This
  // line makes changing the digit count a visible edit (the parity test cannot,
  // since both sides share the regex). Where the 8 comes from is measured in
  // marketplace.ts — NOT the manifest builder, which takes 18; this comment
  // said otherwise until an adversarial review checked it, 2026-09-18.
  it("reads, today, a plain decimal of up to 20 digits and 8 places — and says so", () => {
    // The integer bound joined this literal on 2026-09-18. It was `^\d+(...)`,
    // unbounded, while the column is numeric(38,18) = 20 integer digits, so a
    // 21-digit reward cleared this form and the API and then 500'd on the
    // INSERT. This pin is the whole point of pinning a literal: had the count
    // been only in a comment, the mismatch would have stayed invisible.
    expect(REWARD_SHAPE_RE.source).toBe(String.raw`^\d{1,20}(\.\d{1,8})?$`)
    expect(REWARD_SHAPE_RE.flags).toBe("") // a `g` or `y` flag would make .test() stateful across calls
    expect(REWARD_SHAPE_MESSAGE).toBe("Enter the reward as a plain number (like 250 or 12.5) with up to 8 decimal places.")
    expect(REWARD_TOO_LARGE_MESSAGE).toBe("Enter a reward with at most 20 digits before the decimal point.")
    // The size message must not claim the floor or the decimal rule — the two
    // things that are NOT what is wrong with an oversize reward.
    expect(REWARD_TOO_LARGE_MESSAGE).not.toMatch(/at least|decimal places/)
  })
})

describe("createStepBlockers — steps with no gate", () => {
  it.each([["review"], ["done"]] as const)("%s never blocks, whatever the values", (step) => {
    expect(createStepBlockers(step, { title: "", description: "", rewardXrd: "" })).toEqual([])
  })
})

describe("isFieldBlocked", () => {
  it("is true only for fields present in the blocker list", () => {
    const b = createStepBlockers("what", { ...OK, title: "" })
    expect(isFieldBlocked(b, "title")).toBe(true)
    expect(isFieldBlocked(b, "description")).toBe(false)
    expect(isFieldBlocked(b, "reward")).toBe(false)
  })
})
