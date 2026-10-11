import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_DISPUTE_WINDOW_DAYS, DEFAULT_DISPUTE_WINDOW_HOURS, ESCROW_REVIEW_WINDOW_SECS } from "@/lib/marketplace"
import { settlementCopy } from "@/lib/settlement-copy"

/**
 * The DISPUTE window the app states is the live one: 7 days.
 *
 * On 2026-10-11 the owner raised the live component's `dispute_auto_resolve_secs`
 * from 259200 (72h, what it was instantiated with) to 604800. A dispute pins the
 * window in force when it is raised (TaskInfo.dispute_auto_resolve_secs), so the
 * app's copy — which describes a dispute raised now — says 7 days, and the
 * countdown prefers a task's pinned value where it already holds one.
 *
 * Source-scraping, like dispute-payout-symmetry.test.ts: much of this copy only
 * mounts once a dispute exists, so no HTTP sweep reaches it. Whitespace is
 * collapsed first, because JSX wraps a phrase across lines and a raw-source regex
 * would test the formatter instead of the copy.
 *
 * NOT covered, on purpose: the poster's REVIEW window (`review_window_secs`, the
 * "3 days" / "72h" before release_after_review_timeout opens). It is a different
 * setting and it did not change — the last test pins that.
 */

const ROOT = process.cwd()

function sources(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) {
        // generated/ holds the instantiate spec: what the component was CREATED
        // with (72h, correctly), not what it reads now.
        if (name !== "generated") walk(p)
      } else if (/\.(ts|tsx)$/.test(name)) {
        out.push(p)
      }
    }
  }
  walk(join(ROOT, "src"))
  out.push(join(ROOT, "public", "llms.txt"))
  return out
}

/** Dispute-window phrasing that was true until 2026-10-11 and is not now. */
const STALE =
  /\b72[-\s]?h(?:our)?s?\s+(?:dispute\s+)?(?:default|backstop|auto-?resolve|fallback|timeout)|\bdispute\s+window\s+(?:is\s+)?72|\bwindow\s+is\s+72\s+hours|\{DEFAULT_DISPUTE_WINDOW_HOURS\}(?:-hour|h)\b|\bdefault\s+(?:fires\s+)?after\s+72\s+hours|\brules?\s+within\s+72|\bdispute\s+not\s+ruled\s+within\s+72/gi

/**
 * Sentences that name 72h as HISTORY and stay true: the task-3 timeout proof ran
 * under the old window on the previous component. Each entry is the exact
 * stretch that must surround the hit, so a new stale sentence cannot hide
 * behind one.
 */
const HISTORY = [
  "its 72h auto-resolve settled on 2026-08-26",
  "its 72h auto-resolve is scheduled for 2026-08-26",
  "(nobody ruled; the 72h fallback fired)",
]

describe("dispute window copy — 7 days, the live value", () => {
  it("the display constant is the live component's 604800 s", () => {
    expect(DEFAULT_DISPUTE_WINDOW_HOURS * 3600).toBe(604_800)
    expect(DEFAULT_DISPUTE_WINDOW_DAYS).toBe(7)
  })

  it("no app source states the old 72h dispute window as current", () => {
    const hits: string[] = []
    for (const file of sources()) {
      const text = readFileSync(file, "utf8").replace(/\s+/g, " ")
      for (const m of text.matchAll(STALE)) {
        const around = text.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80)
        if (HISTORY.some((h) => around.includes(h))) continue
        hits.push(`${file.slice(ROOT.length + 1)}: …${around}…`)
      }
    }
    expect(hits).toEqual([])
  })

  it("the guard bites on the sentences that shipped", () => {
    for (const shipped of [
      "If nobody rules within {DEFAULT_DISPUTE_WINDOW_HOURS}h, anyone can settle it by the default",
      "Under the {DEFAULT_DISPUTE_WINDOW_HOURS}-hour default, a dispute can only lose a worker money",
      "the contract applies its own default after 72 hours: a plain 50/50 split",
      "only that 72-hour backstop",
      "a dispute left to the 72h default returns only half.",
      "The auto-resolve window is 72 hours.",
      "dispute window 72h, default SplitEvenly",
      "the dispute path — raise, arbiter ruling, and the 72h auto-resolve default.",
    ]) {
      expect(shipped.match(STALE), shipped).not.toBeNull()
    }
  })

  it("the copy a reader of a dispute sees names 7 days", () => {
    expect(settlementCopy("disputesResolutionMechanism")).toContain("once the 7-day window passes")
    expect(settlementCopy("disputesAutoResolveBody")).toContain("After the 7-day dispute window")
  })

  it("the REVIEW window is a different setting and stays 72h", () => {
    expect(ESCROW_REVIEW_WINDOW_SECS).toBe(259_200)
  })
})
