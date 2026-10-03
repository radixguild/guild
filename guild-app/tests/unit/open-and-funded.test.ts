/**
 * "Funded" on the board means open AND funded on-chain (2026-09-24).
 *
 * onChainTaskId stays set for a task's whole life, so the id alone put
 * "Funded" on paid and submitted tasks — the card chip, the task page's Escrow
 * row and the "Funded only" filter all said it. isOpenAndFunded
 * (src/lib/marketplace-utils.ts) is the one predicate behind all of them.
 *
 * The API's `?funded=true` is deliberately WIDER (any status); this also pins
 * that the OpenAPI spec now says so, instead of leaving `funded` undocumented
 * beside an `open` described as "claimable now".
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isOpenAndFunded } from "@/lib/marketplace-utils"

describe("isOpenAndFunded", () => {
  it("is true only for an open task with an on-chain id", () => {
    expect(isOpenAndFunded({ status: "open", onChainTaskId: 7 })).toBe(true)
    expect(isOpenAndFunded({ status: "open", onChainTaskId: 0 })).toBe(true)
    expect(isOpenAndFunded({ status: "open", onChainTaskId: null })).toBe(false)
    expect(isOpenAndFunded({ status: "open" })).toBe(false)
  })

  it.each(["assigned", "submitted", "disputed", "paid", "refunded", "cancelled"])(
    "is false for a %s task even with an on-chain id",
    (status) => {
      expect(isOpenAndFunded({ status, onChainTaskId: 7 })).toBe(false)
    },
  )
})

describe("every board surface uses it", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

  it.each([
    "src/components/tasks/task-card.tsx",
    "src/components/tasks/project-group.tsx",
    "src/app/tasks/page.tsx",
    "src/app/tasks/[id]/page.tsx",
  ])("%s", (file) => {
    expect(read(file)).toMatch(/isOpenAndFunded/)
  })
})

describe("the spec documents ?funded for what it is", () => {
  const spec = JSON.parse(readFileSync(join(process.cwd(), "public", "openapi.json"), "utf8"))
  const params: { name: string; description?: string }[] = spec.paths["/tasks"].get.parameters

  it("lists `funded` and says it spans every status", () => {
    const funded = params.find((p) => p.name === "funded")
    expect(funded, "funded param").toBeDefined()
    expect(funded!.description).toMatch(/whatever their status/)
    expect(funded!.description).toMatch(/status=open/)
  })

  it("no longer calls every open task claimable", () => {
    const status = params.find((p) => p.name === "status")
    expect(status!.description).not.toMatch(/claimable now/)
    expect(status!.description).toMatch(/claimable only once it is funded/)
  })
})
