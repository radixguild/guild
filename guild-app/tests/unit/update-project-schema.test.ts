// updateProjectSchema — the validation half of the first edit path this table
// has ever had.
//
// WHY THIS MATTERS ENOUGH TO PIN. Until PATCH /api/v1/projects/{slug} existed,
// the only write to `projects` was the create insert: a project's PUBLIC
// description was write-once, and correcting it meant a database shell on the
// box. That is not hypothetical — it is how
// /projects/p5-operations-ci-and-observability came to state
// "Catalogue: 9 tasks · 8,000 XRD in rewards" directly above its own funnel
// reading 0 / 0 / 0 / 0, with no operator path to fix the copy.
//
// Two properties are load-bearing and are what this file exists to hold:
//   1. `slug` must NEVER be accepted. It is the project's URL identity
//      (/projects/[slug]) and stable-after-create by design, so letting a
//      rename change it would silently break every existing link.
//   2. An empty PATCH must be REFUSED rather than accepted as a no-op. A body
//      that changes nothing is a client bug; answering 200 hides it, and the
//      route would still bump updatedAt and claim an edit that never happened.
import { describe, it, expect } from "vitest"
import { updateProjectSchema } from "@/lib/validation"

describe("updateProjectSchema", () => {
  it("accepts a description-only edit (the reason this route exists)", () => {
    const r = updateProjectSchema.safeParse({
      description: "P5 · Operations, CI and observability.",
    })
    expect(r.success).toBe(true)
  })

  it("accepts a name-only edit", () => {
    const r = updateProjectSchema.safeParse({ name: "P5 · Operations" })
    expect(r.success).toBe(true)
  })

  it("accepts both together", () => {
    const r = updateProjectSchema.safeParse({ name: "P5 · Operations", description: "Rewritten." })
    expect(r.success).toBe(true)
  })

  it("REFUSES an empty body rather than treating it as a no-op", () => {
    const r = updateProjectSchema.safeParse({})
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.message).toMatch(/at least one of/i)
    }
  })

  it("does not let a caller change the slug — it is the URL identity", () => {
    const r = updateProjectSchema.safeParse({ description: "ok", slug: "something-else" })
    // zod strips unknown keys by default rather than rejecting, so the
    // assertion that matters is that `slug` never reaches the update payload —
    // the route spreads parsed.data straight into the UPDATE.
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data).not.toHaveProperty("slug")
    }
  })

  it("does not let a caller change commissionerId either", () => {
    const r = updateProjectSchema.safeParse({ description: "ok", commissionerId: "account_rdx1..." })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data).not.toHaveProperty("commissionerId")
    }
  })

  it("enforces the same bounds as create: name 3..80, description <=2000", () => {
    expect(updateProjectSchema.safeParse({ name: "ab" }).success).toBe(false)
    expect(updateProjectSchema.safeParse({ name: "a".repeat(81) }).success).toBe(false)
    expect(updateProjectSchema.safeParse({ description: "d".repeat(2001) }).success).toBe(false)
    expect(updateProjectSchema.safeParse({ description: "d".repeat(2000) }).success).toBe(true)
  })

  it("allows clearing the description to empty", () => {
    // Deliberate: the whole point of the first real use of this route is
    // REMOVING a sentence that outran the truth. An operator must be able to
    // delete copy, not only replace it.
    expect(updateProjectSchema.safeParse({ description: "" }).success).toBe(true)
  })
})
