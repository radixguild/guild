/**
 * Source-level guard for reconcile-escrow.mjs's `/stream/transactions` fetch
 * (C2-R2 audit defect 2's Gateway-side half — "no fetch timeout").
 *
 * Same constraint as tests/unit/reconciler-entitlement-wire.test.ts explains:
 * `scripts/reconcile-escrow.mjs` opens a DB connection and parses `--from`
 * from real argv at import time (and calls `process.exit(1)` when it's
 * missing), so no unit test can safely `import` it — doing so under vitest
 * would kill the whole test worker. A source check is a weak instrument and
 * is not pretending otherwise: it cannot prove the timeout actually fires
 * (that needs a live hang, which this repo cannot exercise against a stalled
 * mainnet). What it CAN do is fail if the timeout, or the transient-failure
 * rethrow that makes it distinguishable from a clean Gateway HTTP error, is
 * ever quietly removed.
 *
 * The defect: before this fix, `fetchPage`'s fetch to `/stream/transactions`
 * had no `AbortSignal`, so a genuinely hung connection blocked the reconciler
 * forever. Cron is `15,45 * * * *`; a hang past 30 minutes let the next tick
 * start a second scan on top of the still-hung first one, both racing the
 * same $CURSOR_FILE (see reconcile-cron.sh's flock -n, and its own test).
 *
 * Every assertion below is scoped to the extracted `fetchPage` FUNCTION BODY,
 * not the whole file. An earlier draft of this test matched against the
 * whole-file source and its "rethrows, not swallowed" check passed even
 * against the pre-fix code — not because fetchPage rethrew anything (it had
 * no try/catch at all), but because an UNRELATED catch block elsewhere in
 * the file (the claim/expire on-chain re-read in handleEvent) happened to
 * match the same loose pattern. Scoping to the function body is what makes
 * these checks actually about the thing they claim to guard.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { privateInputs } from "../support/private-input"

// guild-app/scripts/reconcile-escrow.mjs stays private at the open-source
// flip (opens a DB/Gateway connection at import time — publish/MANIFEST.md).
const PRIV = privateInputs("guild-app/scripts/reconcile-escrow.mjs")
const SRC = PRIV.skip ? "" : readFileSync(join(process.cwd(), "scripts/reconcile-escrow.mjs"), "utf8")

function extractFunction(src: string, signatureLine: string): string {
  const lines = src.split("\n")
  const start = lines.findIndex((l) => l.trim() === signatureLine)
  if (start === -1) {
    throw new Error(`"${signatureLine}" not found in reconcile-escrow.mjs — has it been renamed?`)
  }
  // The closing brace of a top-level function is a bare "}" back at column 0.
  const end = lines.findIndex((l, i) => i > start && l === "}")
  if (end === -1) {
    throw new Error(`closing brace for "${signatureLine}" not found — extraction is out of sync`)
  }
  return lines.slice(start, end + 1).join("\n")
}

const FETCH_PAGE = PRIV.skip ? "" : extractFunction(SRC, "async function fetchPage(cursor, pinnedSv) {")

// Comment-stripped, for the negative assertion only — mirrors
// reconciler-entitlement-wire.test.ts's CODE constant so a comment
// explaining the OLD bug (which quotes the old shape) can't false-positive
// the check meant to catch that same shape reappearing in real code.
const FETCH_PAGE_CODE = PRIV.skip
  ? ""
  : FETCH_PAGE.split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n")

describe.skipIf(PRIV.skip)("reconcile-escrow.mjs fetchPage() — /stream/transactions carries a real timeout", () => {
  it("passes an AbortSignal.timeout to the fetch call", () => {
    expect(FETCH_PAGE_CODE).toMatch(/signal:\s*AbortSignal\.timeout\(/)
  })

  it("the timeout is a finite, positive, deliberately-chosen number of milliseconds", () => {
    const m = SRC.match(/const FETCH_TIMEOUT_MS\s*=\s*([0-9_]+)/)
    expect(m).not.toBeNull()
    const ms = Number(m![1].replace(/_/g, ""))
    expect(Number.isFinite(ms)).toBe(true)
    // Lower bound: anything under 1s would trip on a normal Gateway response
    // and turn healthy latency into spurious cursor-holding retries — that
    // would be a real regression, not a tighter guard.
    expect(ms).toBeGreaterThan(1_000)
    // Upper bound: cron is 15,45 * * * * (every 30 min) and reconcile-cron.sh
    // now holds an flock for the run's whole duration — a fetch timeout
    // anywhere near that interval would defeat the point of bounding it.
    expect(ms).toBeLessThan(5 * 60_000)
  })

  it("the timeout constant is used INSIDE the actual fetch() call, not just declared and forgotten", () => {
    expect(FETCH_PAGE_CODE).toMatch(
      /fetch\(`\$\{GATEWAY\}\/stream\/transactions`,\s*\{[\s\S]{0,400}signal:\s*AbortSignal\.timeout\(FETCH_TIMEOUT_MS\)/,
    )
  })

  it("a network exception or timeout inside fetchPage is RETHROWN, not swallowed into a silent null/empty page", () => {
    // The old shape had NO try/catch at all around this fetch — an unhandled
    // rejection propagated by accident, not by design. The regression this
    // guards against is a FUTURE `catch { return null }` (or an empty-page
    // fallback) that would make a timeout indistinguishable from a real
    // empty page, silently advancing the cursor past unscanned history.
    expect(FETCH_PAGE_CODE).toMatch(/catch \(err\) \{[\s\S]{0,400}throw new Error/)
    expect(FETCH_PAGE_CODE).not.toMatch(/catch \(err\) \{[\s\S]{0,200}return (null|\{[^}]*items:\s*\[\][^}]*\})/)
  })

  it("tags the rethrown error distinctively (greppable in the cron log) and distinguishes timeout from a plain network error", () => {
    expect(FETCH_PAGE).toContain("[gateway-transient]")
    expect(FETCH_PAGE_CODE).toMatch(/err\?\.name === "TimeoutError"/)
  })

  it("still throws a distinct message for a clean non-2xx Gateway response (the pre-existing HTTP-status branch, unchanged)", () => {
    expect(FETCH_PAGE_CODE).toMatch(
      /if \(!resp\.ok\) \{\s*\n\s*throw new Error\(`Gateway \/stream\/transactions HTTP \$\{resp\.status\}`\)/,
    )
  })
})
