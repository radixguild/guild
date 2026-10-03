import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { privateInputs } from "../support/private-input"

// guild-app/scripts/escrow-drift-watch.mjs stays private at the open-source
// flip (operational, DB/Gateway-reading — publish/MANIFEST.md).
const PRIV = privateInputs("guild-app/scripts/escrow-drift-watch.mjs")
const SRC = PRIV.skip
  ? ""
  : readFileSync(join(process.cwd(), "scripts/escrow-drift-watch.mjs"), "utf8")

/**
 * The drift watcher's SECOND pass is the money pass — the only check anywhere
 * that finds settled-but-uncollected entitlements ("DB paid, chain Released,
 * worker's funds still in the component").
 *
 * 🔴 It shipped selecting on `isNotNull(tasks.escrowComponent)`, which silently
 * excluded every pre-backfill NULL-component row — while pass 1's fallback
 * comment claimed "a genuine drift is NEVER silently skipped on the money
 * path", and CLAUDE.md said the same. True of status parity, false of money
 * parity, and invisible because the pass still ran and still reported.
 *
 * Why a SOURCE test and not a behavioural one: the defect was in the QUERY, not
 * in any function's logic. A unit test of the resolution decision passes either
 * way — the excluded rows never reach it. The thing to pin is that the money
 * pass does not filter out the population it exists to protect.
 *
 * Wave B relevance: the swap gate is "zero non-terminal AND zero uncollected
 * entitlements". A NULL-component row holding uncollected funds was invisible
 * to the only check that looks for uncollected funds, so the gate could read
 * clear while money sat unpaid.
 */
describe.skipIf(PRIV.skip)("drift watcher — the money pass must not exclude NULL-component rows", () => {
  const marker = "const settledCandidates = await db"
  const idx = SRC.indexOf(marker)

  it("finds the money pass's candidate query (vacuous-pass guard)", () => {
    // If this scrape breaks, every assertion below would pass over an empty
    // string forever — the exact failure class this file is about.
    expect(idx).toBeGreaterThan(-1)
  })

  it("does not filter the money pass on escrowComponent", () => {
    const query = SRC.slice(idx, idx + 400)
    expect(query).toContain("isNotNull(tasks.onChainTaskId)")
    expect(query).not.toContain("isNotNull(tasks.escrowComponent)")
  })

  it("establishes identity per-row via the shared resolver, which has the fallback", () => {
    // Removing the filter is only safe because identity is re-established
    // per row — otherwise the pass would compare old-component tasks against
    // the wrong component's state (false drift, the thing the filter guarded).
    const loop = SRC.slice(SRC.indexOf("for (const task of settledCandidates)"))
    expect(loop).toContain("resolveOnCurrentComponent(task)")
    // And the direct-equality shortcut this replaced must not come back.
    expect(loop.slice(0, 400)).not.toContain("task.escrowComponent !== ESCROW_COMPONENT")
  })

  it("both passes use the SAME resolver — divergence is what caused the bug", () => {
    // Count CALL sites only — the function's own declaration line matches the
    // same substring, which is why this asserted 2 and saw 3 on first run.
    const calls = SRC.split("await resolveOnCurrentComponent(task)").length - 1
    expect(calls).toBe(2)
    expect(SRC.split("async function resolveOnCurrentComponent").length - 1).toBe(1)
  })
})
