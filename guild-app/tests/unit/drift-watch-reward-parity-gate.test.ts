import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { privateInputs } from "../support/private-input"

// guild-app/scripts/escrow-drift-watch.mjs stays private at the open-source
// flip (operational, DB/Gateway-reading — publish/MANIFEST.md).
const PRIV = privateInputs("guild-app/scripts/escrow-drift-watch.mjs")
const SRC = PRIV.skip ? "" : readFileSync(join(process.cwd(), "scripts/escrow-drift-watch.mjs"), "utf8")

/**
 * The drift watcher's pass 1 checks REWARD parity as well as state parity
 * (2026-09-23 funding audit): the board advertises `reward_xrd`, the escrow
 * holds what `create_task` took, and nothing else compares the two.
 *
 * Why a SOURCE test (same reasoning as drift-watch-money-pass-gate.test.ts):
 * the property is about where the check sits, not what it computes — that half
 * is unit-tested in funded-reward.test.ts. The case it exists for has its
 * status perfectly in sync (`open` in the DB, `Open` on chain), so a reward
 * check placed AFTER the in-sync `continue` would never run for it, and would
 * still look present to anyone reading the file.
 */
describe.skipIf(PRIV.skip)("drift watcher — pass 1 checks reward parity before the in-sync short-circuit", () => {
  const loopStart = SRC.indexOf("for (const task of candidates)")
  const loopEnd = SRC.indexOf("// ── PASS 2")
  const loop = SRC.slice(loopStart, loopEnd)

  it("finds pass 1's loop (vacuous-pass guard)", () => {
    expect(loopStart).toBeGreaterThan(-1)
    expect(loopEnd).toBeGreaterThan(loopStart)
  })

  it("reads the full TaskInfo, which carries the funded reward", () => {
    expect(loop).toContain("await readEscrowTaskInfo(task.onChainTaskId, ESCROW_COMPONENT)")
    expect(loop).not.toContain("readEscrowTaskState(")
  })

  it("runs checkFundedReward BEFORE the state-parity `continue`", () => {
    const rewardCheck = loop.indexOf("checkFundedReward(task, info)")
    const inSync = loop.indexOf("if (isDbStatusInSyncWithChain(task.status, state))")
    expect(rewardCheck).toBeGreaterThan(-1)
    expect(inSync).toBeGreaterThan(-1)
    expect(rewardCheck).toBeLessThan(inSync)
  })

  it("records a mismatch as a drift, so it reaches the alert and the exit code", () => {
    expect(loop).toMatch(/drifts\.push\(\{ task, kind: "reward"/)
  })
})
