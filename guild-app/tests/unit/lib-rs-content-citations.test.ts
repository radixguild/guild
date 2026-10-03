/**
 * Cite the escrow blueprint by CONTENT, never by line number.
 *
 * Measured 2026-09-16: 66 `lib.rs:NNN` citations across 26 files. Wave B grew
 * lib.rs past 3,500 lines, so most pointed at unrelated code — `lib.rs:710` for
 * the self-claim assert was `remove_accepted_token` by the time anyone read it.
 * Four of them were propping up claims that had since become false (submit_task
 * "already returned their claim bond"; worker_account "cleared ONLY via
 * expire_claim and cancel_task_by_poster_after_claim"; claim_task's "five asserts";
 * "value leaves only via withdraw_worker/withdraw_poster"). A line number cannot
 * go stale loudly; a method or assert name that stops existing can be grepped.
 *
 * Two occurrences are exempt, each by exact text, because neither is a pointer:
 * an incident record quoting what an earlier comment used to say, and a REAL
 * mainnet preview error string used as a classifier fixture.
 */
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join, resolve, relative } from "node:path"
import { privateInputs } from "../support/private-input"

// scripts/launch-check.sh stays EXCLUDE at the open-source flip; the rest of
// this file's scan (src/, tests/, the rest of scripts/, agent-client) is all
// shipped, so only the one assertion that names it needs to skip.
const PRIV_LAUNCH_CHECK = privateInputs("guild-app/scripts/launch-check.sh")

const APP = resolve(__dirname, "../..")
const REPO = resolve(APP, "..")
const CITATION = /\blib\.rs:\d+/g

const EXEMPT: Array<{ file: string; text: string; why: string }> = [
  {
    file: "guild-app/src/lib/dispute-outcome.ts",
    text: 'cited "lib.rs:1768-1786" for both facts',
    why: "incident record: quotes the wrong citation this comment used to carry",
  },
  {
    file: "guild-app/tests/unit/autoresolve-classify.test.ts",
    text: "@ src/lib.rs:1659:17",
    why: "verbatim mainnet /transaction/preview error_message, a classifier fixture",
  },
]

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|tsx|mjs|js|sh)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name))
    .filter((p) => !p.includes("node_modules") && p !== __filename)
}

const FILES = [
  ...walk(join(APP, "src")),
  ...walk(join(APP, "scripts")),
  ...walk(join(APP, "tests")),
  ...walk(join(REPO, "packages/agent-client/src")),
]

function citations(rel: string, src: string): string[] {
  let text = src
  for (const e of EXEMPT) if (e.file === rel) text = text.split(e.text).join("")
  return [...text.matchAll(CITATION)].map((m) => m[0])
}

describe("escrow blueprint citations are by content", () => {
  it("the pattern catches the forms that shipped (teeth)", () => {
    for (const s of ["(lib.rs:710)", "(lib.rs:1716-1723)", "(lib.rs:1886/1937)", "(lib.rs:376,378)", "lib.rs:1345)"]) {
      expect(citations("x", s), s).not.toEqual([])
    }
    expect(citations("x", "(lib.rs `claim_task`'s self-claim assert)")).toEqual([])
  })

  it("scans a real tree", () => {
    const rel = FILES.map((p) => relative(REPO, p))
    expect(rel.length).toBeGreaterThan(300)
    expect(rel).toContain("guild-app/tests/support/mock-ledger.ts")
    if (!PRIV_LAUNCH_CHECK.skip) expect(rel).toContain("guild-app/scripts/launch-check.sh")
    expect(rel).toContain("packages/agent-client/src/gateway.ts")
  })

  it("each exemption still exists verbatim (a stale exemption would hide nothing and excuse anything)", () => {
    for (const e of EXEMPT) expect(readFileSync(join(REPO, e.file), "utf8"), e.file).toContain(e.text)
  })

  it("no scanned file cites lib.rs by line number", { timeout: 20_000 }, () => {
    const found = FILES.flatMap((p) => {
      const rel = relative(REPO, p)
      return citations(rel, readFileSync(p, "utf8")).map((c) => `${rel}: ${c}`)
    })
    expect(found).toEqual([])
  })
})
