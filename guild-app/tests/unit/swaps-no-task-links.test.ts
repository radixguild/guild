// /swaps must not link or name board tasks.
//
// The page is a placeholder for the NFT-swap listing UI. The two board tasks once posted
// for that UI (the grid and the headless legs) were cancelled and refunded on 2026-10-03,
// and the page was changed the same day to link to neither. A later edit that re-adds a
// task link, or names a task number in the copy, would send a visitor to a cancelled task
// — exactly the broken-looking path the placeholder exists to avoid. This test pins the
// rendered surface: the page source and every string the content module exports. Code
// comments are not scanned; they may explain the history by number.
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as swaps from "../../src/content/swaps"

const APP = join(__dirname, "..", "..", "src")

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const strings = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === "string") out.push(value)
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out))
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out))
  return out
}

describe("/swaps links to no board task", () => {
  it("the page source has no /tasks/<id> link outside comments", () => {
    const src = stripComments(readFileSync(join(APP, "app", "swaps", "page.tsx"), "utf8"))
    expect(src).not.toMatch(/\/tasks\/\d+/)
  })

  it("the content module's copy names no task link or task number", () => {
    const copy = strings(swaps)
    expect(copy.length).toBeGreaterThan(5)
    for (const s of copy) {
      expect(s, s).not.toMatch(/\/tasks\/\d+/)
      expect(s, s).not.toMatch(/\btasks?\s+#?\d+\b/i)
      expect(s, s).not.toMatch(/#\d{2,}\b/)
    }
  })
})
