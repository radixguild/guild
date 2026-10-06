import { describe, it, expect } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { REPO_ROOT } from "../support/private-input"

/**
 * STATE.md says it wins over every other doc, so a verb it calls unbuilt is unbuilt for
 * anyone reading it. Found 2026-10-06: kit 0.8.0 shipped `list-swap`, `cancel-swap`,
 * `withdraw-swap` (guild-poster) and `fill-swap` (guild-worker), and STATE.md's "What is not
 * built or released yet" still said the agent kit had "no list or fill verbs yet".
 *
 * The verbs are read from the CLIs' own dispatch (`case '<verb>':`), not typed here, so a verb
 * the kit adds later is held to the same rule.
 */

const KIT = join(REPO_ROOT, "packages", "agent-client", "src")
const CLIS = ["guild-worker.ts", "guild-poster.ts"]

function shippedVerbs(): string[] {
  return CLIS.flatMap((f) =>
    [...readFileSync(join(KIT, f), "utf8").matchAll(/^\s*case\s+'([a-z][a-z-]+)':/gm)].map((m) => m[1]),
  )
}

// In the archived private tree STATE.md shipped as publish/STATE.public.md (the same choice
// repo-visibility-flip.test.ts makes); in this repository it is STATE.md.
const STATE_FILE = existsSync(join(REPO_ROOT, "publish", "STATE.public.md")) ? "publish/STATE.public.md" : "STATE.md"
const STATE = readFileSync(join(REPO_ROOT, STATE_FILE), "utf8")

function section(md: string, heading: string): string {
  const start = md.indexOf(`## ${heading}`)
  if (start < 0) return ""
  const next = md.indexOf("\n## ", start + 3)
  return md.slice(start, next < 0 ? undefined : next)
}

// A sentence saying the kit lacks verbs: "has no list or fill verbs", "no swap verbs yet".
const DENIES_VERBS = /\bno\b[^.;!?]{0,40}\bverbs?\b/i

function problems(md: string, verbs: string[]): string[] {
  const notBuilt = section(md, "What is not built or released yet")
  const out: string[] = []
  if (!notBuilt) out.push(`no "What is not built or released yet" section`)
  // A verb counts as named when it is a word of an inline code span (`guild-worker fill-swap`).
  const codeWords = new Set([...notBuilt.matchAll(/`([^`]+)`/g)].flatMap((m) => m[1].split(/\s+/)))
  for (const v of verbs) if (codeWords.has(v)) out.push(`names shipped verb ${v} as not built`)
  const denial = notBuilt.replace(/\s+/g, " ").match(DENIES_VERBS)
  if (denial) out.push(`denies kit verbs: "${denial[0]}"`)
  return out
}

describe("STATE.md and the agent kit's shipped verbs agree", () => {
  const verbs = shippedVerbs()
  const swapVerbs = verbs.filter((v) => v.endsWith("-swap"))

  it("reads the kit's verbs from its CLIs (floor, so a broken reader cannot pass)", () => {
    expect(verbs.length).toBeGreaterThanOrEqual(8)
    expect(swapVerbs.sort()).toEqual(["cancel-swap", "fill-swap", "list-swap", "withdraw-swap"])
  })

  it("'What is not built or released yet' names no shipped verb and denies none", () => {
    expect(problems(STATE, verbs)).toEqual([])
  })

  it("the swap verbs are named where STATE.md says what is live", () => {
    const live = section(STATE, "Live today")
    for (const v of swapVerbs) expect(live, v).toContain(v)
  })

  it("control: the sentence that shipped before 0.8.0 is caught", () => {
    const stale =
      "## What is not built or released yet\n\n- **NFT swaps for agents.** The swap pages need a wallet; the agent kit has no list or fill\n  verbs yet (project P7, criterion 5).\n"
    expect(problems(stale, verbs)).toEqual([expect.stringMatching(/^denies kit verbs/)])
    expect(problems("## What is not built or released yet\n\n- `guild-worker fill-swap` is not built.\n", verbs)).toEqual([
      "names shipped verb fill-swap as not built",
    ])
  })
})
