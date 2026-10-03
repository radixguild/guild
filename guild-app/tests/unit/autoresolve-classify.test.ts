import { describe, it, expect } from "vitest"
import {
  classifyPreview,
  CLOCK_REVERT,
  SHAPE_REVERT,
} from "../../scripts/edge-autoresolve-shape.mjs"

/**
 * The `auto_resolve_dispute` shape probe classifies a Gateway preview receipt
 * into "the blueprint ran and stopped on its clock" (the proof we want) versus
 * "the blueprint rejected the call outright" (the defect we are hunting).
 *
 * Both outcomes are `status: "Failed"`. Only the error message separates them,
 * so the message patterns ARE the probe — and they are the part that was wrong.
 *
 * ⚠️ THIS TEST EXISTS BECAUSE THE FIRST CLASSIFIER PRODUCED A FALSE GREEN.
 * It matched the clock on /auto_resolve/i. Pointing the manifest at a method
 * that does not exist (`auto_resolve_disputes`) still classified as a clock
 * revert, because the blueprint's rejection *quotes the method name back* —
 * the pattern matched its own input. A revert message always contains the thing
 * you asked for; matching on that proves only that you asked.
 *
 * Every string below is a REAL error_message captured from
 * mainnet `/transaction/preview` against the live PULL component on 2026-08-23,
 * not a hand-written approximation of one.
 */

// Live, 2026-08-23, component_rdx1cz468e… task 3, correct builder.
const CLOCK_ERR =
  'ApplicationError(PanicMessage("dispute auto-resolve window has not elapsed @ src/lib.rs:1659:17"))'

// Live, same run: wrong arg type (3u32), missing arg, and a push-era extra arg
// all produce this same class.
const TYPE_ERR =
  'SystemError(TypeCheckError(BlueprintPayloadValidationError(BlueprintInfo { blueprint_id: BlueprintId { package_address: PackageAddress("package_rdx1p4da84x3xknr7qtnqdcn28fkqsj6mjgv9ya4ez7h2p0p3cav8gw662"), blueprint_name: "Escrow" }, ...)))'

// Live, same run: the method-name mutation. Note it CONTAINS the method name —
// that is precisely what fooled the first classifier.
const NO_METHOD_ERR =
  'SystemModuleError(AuthError(NoMethodMapping(FnIdentifier { blueprint_id: BlueprintId { package_address: PackageAddress("package_rdx1p4da84x3xknr7qtnqdcn28fkqsj6mjgv9ya4ez7h2p0p3cav8gw662"), blueprint_name: "Escrow" }, ident: "auto_resolve_disputes" })))'

describe("auto_resolve_dispute preview classifier", () => {
  it("classifies the real clock revert as a proof of shape", () => {
    expect(classifyPreview("Failed", CLOCK_ERR)).toBe("clock")
  })

  it("classifies a type/ABI rejection as a broken builder", () => {
    expect(classifyPreview("Failed", TYPE_ERR)).toBe("shape")
  })

  // The regression. If this ever returns "clock" again, the probe is lying.
  it("does NOT read a NoMethodMapping rejection as a clock revert, though it quotes the method name", () => {
    expect(NO_METHOD_ERR).toContain("auto_resolve_dispute") // the bait is really there
    expect(classifyPreview("Failed", NO_METHOD_ERR)).toBe("shape")
  })

  it("shape is tested before clock, so a receipt carrying both reads as shape", () => {
    expect(classifyPreview("Failed", `${TYPE_ERR} ${CLOCK_ERR}`)).toBe("shape")
  })

  it("a success is never silently treated as a shape proof", () => {
    expect(classifyPreview("Succeeded", "")).toBe("succeeded")
  })

  it("an unrecognised revert is inconclusive, not a pass", () => {
    expect(classifyPreview("Failed", "ApplicationError(PanicMessage(\"task is not disputed\"))")).toBe(
      "inconclusive",
    )
  })

  it("the clock pattern requires the blueprint's own panic, not a loose mention", () => {
    // A panic is the blueprint running and choosing to stop — the only outcome
    // that proves the argument types were accepted.
    expect(CLOCK_REVERT.test("dispute auto-resolve window has not elapsed")).toBe(false)
    expect(CLOCK_REVERT.test(CLOCK_ERR)).toBe(true)
  })

  it("NoMethodMapping is in the shape class, where it belongs", () => {
    expect(SHAPE_REVERT.test(NO_METHOD_ERR)).toBe(true)
  })
})
