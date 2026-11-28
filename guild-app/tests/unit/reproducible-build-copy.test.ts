import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { REPRO_BUILD_GUIDE_URL, REPRO_BUILD_RUN_URL } from "@/lib/config"

// C2 (guild#110): both live packages built from the escrow crate rebuilt byte for byte in CI.
// Claims rule: a page says they "matched" only with the run link beside it, and no page still
// calls the reproducible build planned. Recipe: docs/AUDITOR-GUIDE.md §5.
const PAGES = [
  "src/app/trust/page.tsx",
  "src/app/auditor-guide/page.tsx",
  "src/app/agents/page.tsx",
  "src/app/check-badge/page.tsx",
  "src/app/disputes/page.tsx",
  "src/app/lifecycle/page.tsx",
]
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

describe("reproducible-build copy (C2)", () => {
  it("points at the guide's section and the run the guide links", () => {
    expect(REPRO_BUILD_GUIDE_URL).toBe(
      "https://github.com/radixguild/guild/blob/main/docs/AUDITOR-GUIDE.md#reproducible-build-check-it-yourself",
    )
    expect(REPRO_BUILD_RUN_URL).toBe("https://github.com/radixguild/guild/actions/runs/46105575492")
  })

  for (const p of PAGES) {
    it(`${p}: no "still planned", and every "matched" sits beside the run link`, () => {
      const src = read(p)
      expect(src).not.toMatch(/reproducible[- ]build[^"`<]{0,120}(still )?planned/i)
      expect(src).not.toMatch(/Until a reproducible build/)
      const matches = [...src.matchAll(/matched the deployed bytes/g)]
      expect(matches.length, "the page states the match").toBeGreaterThan(0)
      for (const m of matches) {
        const near = src.slice(Math.max(0, m.index! - 200), m.index! + 200)
        expect(near, `"matched" at ${m.index} without the run link`).toContain("REPRO_BUILD_RUN_URL")
      }
    })
  }
})
