import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { privateInputs, REPO_ROOT } from "../support/private-input"

/**
 * The cron reconciler's entitlement wire, guarded at SOURCE level.
 *
 * `scripts/reconcile-escrow.mjs` is a standalone script that opens a DB and a
 * Gateway connection at import time, so no unit test drives it. That is exactly
 * how the defect this guards against survived: its event gate read
 *
 *     if (!EVENT_TO_KIND[ev?.name]) continue
 *
 * which dropped SettlementCreditedEvent and WithdrawalEvent silently, so the
 * reconciler had NO entitlement handling at all. A withdrawal made by an agent,
 * the CLI or a wallet was recorded only if a human later clicked "Resync from
 * chain" on that exact task — while the writer's own docstring claimed both
 * scanners replayed these events.
 *
 * A source check is a weak instrument and is not pretending otherwise: it cannot
 * prove the ingestion WORKS (tests/unit/escrow-resync.test.ts does that, against
 * the shared `ingestEntitlements` the script calls). What it can do is fail if
 * the wire is removed or quietly rerouted through a private copy — which is the
 * failure that actually happened, twice, in this phase.
 */
// scripts/ (outside a small allowlist) stays EXCLUDE at the open-source flip,
// so this whole file skips in the public export and still runs (throwing if
// the input vanishes for any other reason) in the private tree.
const PRIV = privateInputs("guild-app/scripts/reconcile-escrow.mjs")
const SRC = PRIV.skip ? "" : readFileSync(join(REPO_ROOT, "guild-app", "scripts/reconcile-escrow.mjs"), "utf8")

/**
 * Comment-stripped source, for the NEGATIVE assertions only.
 *
 * Two comments in that file quote the old broken gate verbatim in order to
 * explain the defect — which is exactly what a comment should do, and which made
 * the first version of the check below fail on its own documentation. Same trap
 * schema-ddl-drift.test.ts records: a substring search over a whole file cannot
 * tell code from prose about code.
 */
const CODE = SRC.split("\n")
  .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
  .join("\n")

describe.skipIf(PRIV.skip)("reconcile-escrow.mjs — the entitlement wire", () => {
  it("lets entitlement events past the event gate", () => {
    // The gate must not be a bare EVENT_TO_KIND lookup again.
    expect(CODE).toMatch(/if \(!EVENT_TO_KIND\[ev\?\.name\] && !isEntitlement\) continue/)
    expect(CODE).not.toMatch(/if \(!EVENT_TO_KIND\[ev\?\.name\]\) continue\s*$/m)
  })

  it("recognises entitlement events from the shared name list, not a local literal", () => {
    // A hand-typed copy of the two event names is how the resync's EVENT_TO_KIND
    // fell out of step with the reconciler's in the first place.
    expect(SRC).toMatch(/ENTITLEMENT_EVENT_NAMES\.includes\(ev\?\.name\)/)
    expect(SRC).toMatch(/from "\.\.\/src\/lib\/escrow-entitlements"/)
  })

  it("routes them to ingestion and does NOT fall through to the lifecycle handler", () => {
    // An entitlement event advances no status. Reaching handleEvent would send
    // it through an ALLOWED_FROM gate and drop real collections.
    expect(SRC).toMatch(/if \(isEntitlement\) \{[\s\S]{0,120}handleEntitlementEvent\([\s\S]{0,80}continue/)
  })

  it("calls the SHARED ingestEntitlements rather than a private copy", () => {
    expect(SRC).toMatch(/ingestEntitlements,?\n?\s*\} from "\.\.\/src\/lib\/escrow-resync"/)
    expect(SRC).toMatch(/await ingestEntitlements\(task, \[\{ rows, intentHash \}\]\)/)
    // A second recordEntitlementLedgerRow call site here would BE the duplicate.
    expect(SRC).not.toContain("recordEntitlementLedgerRow")
  })

  it("resolves the task on (on-chain id, component), like every other handler", () => {
    // on_chain_task_id collides across the old->vNext cutover; resolving without
    // the component pin would attribute a withdrawal to the wrong task.
    expect(SRC).toMatch(/findTaskByOnChainIdOnComponent\(onChainId, ESCROW_COMPONENT\)/)
  })

  it("honours --dry-run: no ledger write without --apply", () => {
    expect(SRC).toMatch(/if \(!apply\) \{[\s\S]{0,300}would-ingest/)
  })

  it("reports ledger rows separately from heals", () => {
    // An entitlement row records money that MOVED; it does not heal a status.
    expect(SRC).toContain("ledger rows")
    expect(SRC).toMatch(/counts\.entitlementRows/)
  })
})

/**
 * The summary must be able to tell its two zeros apart.
 *
 * MEASURED, not hypothetical. Over 2,288 apply runs on the Guild VPS the
 * reconciler printed `healed 0` every single time, and the repo recorded that as
 * a suspected "reconciler blind spot" (P3-2's exit criterion asks to name the
 * class or declare it dead under PULL).
 *
 * It is neither. The class is alive and simply has not occurred: every on-chain
 * event so far was already reflected, because every confirm succeeded. What made
 * it LOOK blind is that the 2026-08-20 run — the first live two-party settlement
 * — printed `events scanned 5 / skipped 2 / healed 0 / ledger rows 0` and NOTHING
 * accounted for the other three. Those three were `SettlementCreditedEvent` plus
 * two `WithdrawalEvent`s, already ingested by the confirm route (verified
 * directly against production `escrow_transactions`: all four settle/withdraw
 * rows present for task 66).
 *
 * So `ledger rows 0` had two causes printing identically — "already ingested"
 * (healthy) and "parsed to zero rows and dropped" (a real money-path hole). This
 * guards the split, because a counter that cannot go red is not a counter.
 */
describe.skipIf(PRIV.skip)("reconcile-escrow.mjs — the summary can distinguish its zeros", () => {
  it("counts entitlement events at EVENT level, so the accounting can balance", () => {
    // Row-level counters can never balance against `events scanned`: one
    // SettlementCreditedEvent yields two rows.
    expect(CODE).toMatch(/counts\.entitlementEvents\+\+/)
    expect(CODE).toMatch(/entitlementEvents:\s*0/)
  })

  it("an entitlement event that parses to ZERO rows is counted and logged, never silent", () => {
    // The original code was `if (rows.length === 0) return` — money moves on
    // chain, the ledger learns nothing, and the summary says all-clear.
    expect(CODE).toMatch(/counts\.entitlementUnparsed\+\+/)
    expect(CODE).toMatch(/\[unparsed\]/)
    expect(CODE).not.toMatch(/if \(rows\.length === 0\) return/)
  })

  it("distinguishes 'already ingested' from 'wrote nothing'", () => {
    expect(CODE).toMatch(/counts\.entitlementAlreadyIngested \+= rows\.length/)
  })

  it("asserts every scanned event lands in exactly one bucket", () => {
    // The check that would have made the 08-20 gap visible on the day.
    expect(CODE).toMatch(/const accounted =/)
    expect(CODE).toMatch(/accounted !== counts\.events/)
    expect(CODE).toContain("UNACCOUNTED")
    // And it must sum the EVENT-level counter, not the row-level one — summing
    // entitlementRows there is the bug this test exists to prevent.
    const block = CODE.slice(
      CODE.indexOf("const accounted ="),
      CODE.indexOf("accounted !== counts.events"),
    )
    expect(block).toContain("counts.entitlementEvents")
    expect(block).not.toContain("counts.entitlementRows")
  })
})
