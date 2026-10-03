import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

/**
 * THE XRD DISPLAY STANDARD, ENFORCED.
 *
 * `src/lib/format-xrd-usd.ts` is the single place XRD and USD amounts are
 * rendered. That was already true as a convention and it did not hold:
 * `projects/[slug]/page.tsx` grew its own
 *
 *     const fmtXrd = (n) => n >= 1000 ? `${(n/1000).toFixed(1)}k` : ...
 *
 * which abbreviated a TASK REWARD. So the same 1500.5 XRD reward read
 * "1.5k XRD" on the project page and "1,500.5 XRD" on the task card — and the
 * project page carried no USD label at all, because the private helper had no
 * concept of one.
 *
 * Nothing caught it. It was not a rule anyone broke; it was a rule with no
 * enforcement, which in this repo is the same as no rule. This file is the
 * enforcement: prose asking future editors to use the shared formatter is
 * exactly what already failed.
 */

const SRC = join(process.cwd(), "src")

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}

const FILES = walk(SRC).map((p) => ({ path: relative(process.cwd(), p), text: readFileSync(p, "utf8") }))

/**
 * Non-money `toFixed` calls. Each entry must name WHY the quantity is not money
 * — a duration, a percentage, a count. Adding an entry is a deliberate act;
 * adding one for an XRD amount is the thing this guard exists to prevent.
 */
const NON_MONEY_TOFIXED: { file: string; reason: string }[] = [
  {
    file: "src/app/profile/[address]/page.tsx",
    reason: "avgDeliveryDays — a duration in days, not an amount of XRD",
  },
]

describe("XRD display standard", () => {
  it("the formatter module exists and exports both modes", () => {
    const mod = FILES.find((f) => f.path.endsWith("src/lib/format-xrd-usd.ts"))
    expect(mod, "src/lib/format-xrd-usd.ts must exist — it is the standard").toBeDefined()
    expect(mod!.text).toContain('export type XrdUsdMode = "exact" | "compact"')
  })

  /**
   * The shape of the defect that actually shipped: divide by a magnitude, call
   * toFixed, append a unit suffix. Catches a re-implementation regardless of
   * what it is named, which a grep for "fmtXrd" would not.
   */
  it("no module re-implements compact abbreviation by hand", () => {
    const offenders = FILES.filter(
      (f) =>
        !f.path.endsWith("src/lib/format-xrd-usd.ts") &&
        /\/\s*1_?0{3,}\s*\)?\s*\)?\s*\.toFixed\s*\(/.test(f.text),
    ).map((f) => f.path)

    expect(
      offenders,
      `these divide-and-toFixed by hand instead of using formatXrdUsd(..., { mode: "compact" }): ${offenders.join(", ")}`,
    ).toEqual([])
  })

  /**
   * `toFixed` on a money value rounds it, and rounding what someone is owed is
   * the failure this standard exists to prevent. Non-money uses are allowlisted
   * above with a stated reason.
   */
  it("no module formats an XRD amount with toFixed", () => {
    const allowed = new Set(NON_MONEY_TOFIXED.map((e) => e.file))
    const offenders = FILES.filter(
      (f) =>
        !f.path.endsWith("src/lib/format-xrd-usd.ts") &&
        !allowed.has(f.path) &&
        f.text.includes(".toFixed("),
    ).map((f) => f.path)

    expect(
      offenders,
      `toFixed outside the formatter — if the quantity is not money, add it to NON_MONEY_TOFIXED with a reason: ${offenders.join(", ")}`,
    ).toEqual([])
  })

  it("every allowlisted non-money toFixed still exists and still states a reason", () => {
    // An allowlist that outlives the code it excuses silently widens the guard.
    for (const entry of NON_MONEY_TOFIXED) {
      const f = FILES.find((x) => x.path === entry.file)
      expect(f, `${entry.file} is allowlisted but no longer exists — drop the entry`).toBeDefined()
      expect(f!.text, `${entry.file} no longer calls toFixed — drop the entry`).toContain(".toFixed(")
      expect(entry.reason.length, `${entry.file} needs a real reason`).toBeGreaterThan(20)
    }
  })

  /**
   * Compaction must be ASKED for. This does not judge whether a given surface
   * chose correctly — it pins the count, so adding compact to a new surface is a
   * visible decision in the diff rather than a quiet one.
   *
   * Matches BOTH call conventions: `formatXrdUsd(..., { mode: "compact" })`
   * (the object-literal form most call sites still use) and `<XrdAmount
   * mode="compact" />` (components/XrdAmount.tsx's JSX prop form, added
   * 2026-09-03 — same formatXrdAmount/formatUsdAmount underneath, just a
   * different call shape). Missing the second form would not catch a NEW
   * compacted surface added via the component, which defeats the guard.
   */
  const COMPACT_MODE_RE = /mode:\s*"compact"|mode=\{?"compact"\}?/g

  it("compact mode is used only on informational rollups", () => {
    const compactSites = FILES.flatMap((f) => {
      const n = (f.text.match(COMPACT_MODE_RE) ?? []).length
      return n > 0 ? [{ path: f.path, n }] : []
    })

    const expected = [
      { path: "src/app/profile/[address]/page.tsx", n: 3 }, // lifetime / monthly / funded
      { path: "src/app/projects/[slug]/page.tsx", n: 2 }, // project locked + paid
      { path: "src/app/projects/page.tsx", n: 2 }, // project locked + paid
      // 2 since 2026-08-21, not a new KIND of site: the same lifetime-earnings
      // rollup, rendered a second time for the mobile breakpoint. Below 640px
      // the three stat columns were hidden outright while the sort control
      // still offered to order by them, so the row now shows whichever metric
      // the list is sorted by. Same value, same informational rollup, one more
      // call site.
      { path: "src/components/Leaderboard.tsx", n: 2 }, // lifetime earnings (desktop + mobile)
      // /tasks projects-first board (task 89): the SAME project locked/paid
      // rollup as the two /app/projects/* entries above, rendered a third
      // place — the project card embedded in the board instead of the
      // standalone /projects list or /projects/[slug] detail page.
      { path: "src/components/tasks/project-group.tsx", n: 2 }, // project escrowed + paid
    ]

    expect(
      compactSites.sort((a, b) => a.path.localeCompare(b.path)),
      "compact mode moved. It is for rollups nobody acts on — a reward, bond, insurance, balance or outstanding amount must stay exact.",
    ).toEqual(expected)
  })

  /**
   * The surfaces that render money someone acts on. If one of these ever starts
   * compacting, a worker is being shown a rounded version of what they are owed.
   */
  it("actionable money surfaces never compact", () => {
    const ACTIONABLE = [
      "src/components/tasks/task-card.tsx",
      "src/components/tasks/escrow-actions.tsx",
      "src/app/tasks/[id]/page.tsx",
      "src/app/tasks/[id]/submit/page.tsx",
      "src/app/mint/page.tsx",
      "src/lib/task-terms.ts",
      // an agent's float and bond ceiling — the owner funds and tops up from these
      "src/components/agents/agent-card.tsx",
      // the float the owner is about to send, and their balance beside it
      "src/components/agents/fund-agent-dialog.tsx",
    ]

    for (const path of ACTIONABLE) {
      const f = FILES.find((x) => x.path === path)
      expect(f, `${path} not found — update this list if the file moved`).toBeDefined()
      // .match() (not .test()) deliberately: COMPACT_MODE_RE carries the `g`
      // flag, and .test() on a global regex mutates + reuses `lastIndex`
      // across calls — a real footgun in a loop over multiple files sharing
      // one regex object. .match() has no such carry-over.
      expect(
        f!.text.match(COMPACT_MODE_RE),
        `${path} renders actionable money and must not compact it`,
      ).toBeNull()
    }
  })
})
