// scripts/lib/task-text-validate.mjs — the pure scrub-stability decision
// post-micro-tasks.mjs uses for its batch validation pass (P3-24).
//
// post-micro-tasks.mjs itself reads live Gateway/DB state and calls
// process.exit at module scope, so it cannot be imported here — same shape
// as post-micro-project-ref.test.ts (see that file's own header comment).

import { describe, it, expect } from "vitest"
import { privateInputs } from "../support/private-input"

// scripts/lib/task-text-validate.mjs stays private at the open-source flip
// (not one of the guild-app/scripts/** carve-outs) — skip in the public
// export, throw in the private tree if it ever goes missing
// (tests/support/private-input.ts).
const PRIV = privateInputs("guild-app/scripts/lib/task-text-validate.mjs")
const TASK_TEXT_VALIDATE_PATH = "../../scripts/lib/task-text-validate.mjs"
const taskTextValidate = PRIV.skip ? null : await import(TASK_TEXT_VALIDATE_PATH)
const { validateTaskTextStable } = taskTextValidate ?? ({} as NonNullable<typeof taskTextValidate>)

describe.skipIf(PRIV.skip)("validateTaskTextStable", () => {
  it("is empty for ordinary task copy with nothing the scrub would touch", () => {
    expect(
      validateTaskTextStable(
        { title: "Design the escrow claim UI", description: "Add a countdown chip." },
        0,
      ),
    ).toEqual([])
  })

  it("flags a description the scrub would rewrite, naming the row (1-based)", () => {
    const errs = validateTaskTextStable(
      {
        title: "Provisioning runbook",
        description: "Verified it manually (via ssh guild-vps read-only).",
      },
      2, // 0-based index → row #3
    )
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain("#3:")
    expect(errs[0]).toContain("description")
  })

  it("flags a title the scrub would rewrite", () => {
    const errs = validateTaskTextStable(
      { title: "ssh into guild-vps to fix it", description: "Ordinary, harmless copy." },
      0,
    )
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain("title")
  })

  it("is empty (not a crash) for a malformed row — the plain title/description checks in post-micro-tasks.mjs already catch that", () => {
    expect(validateTaskTextStable({}, 0)).toEqual([])
    expect(validateTaskTextStable({ title: 5, description: null }, 0)).toEqual([])
  })
})
