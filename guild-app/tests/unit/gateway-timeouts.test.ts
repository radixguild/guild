/**
 * Every Gateway fetch is bounded in wall-clock time.
 *
 * WHY THIS EXISTS. Until 2026-09-02 all ten `fetch()` calls in `src/lib/gateway.ts`
 * ran unbounded. That is worse than a missing timeout usually is, because nearly
 * every reader in that module is built around `try/catch → return null` and a
 * catch only runs once a promise SETTLES. A connection that hangs rather than
 * fails never reaches the handler, so the careful null-means-unknown behaviour
 * never fires and the caller waits instead. On a request path that wedges a
 * handler; on the reconcile cron (`15,45 * * * *`) it wedges a job.
 *
 * WHY THE MAIN TEST IS STRUCTURAL, AND WHY IT IS NOT A BEHAVIOUR TEST.
 * A hang cannot be reproduced in a unit test — that is the entire nature of the
 * bug. Any test shaped like "assert it gives up after N seconds" either fakes
 * the clock (proving something about the fake) or sleeps (slow and flaky), and
 * in both cases it is a check that cannot fail for the reason that matters.
 * Asserting the SIGNAL IS PRESENT at every call site is the only honest gate.
 *
 * And it is deliberately a source scan rather than ten per-function assertions:
 * per-function tests protect the ten functions that exist today and say nothing
 * about the eleventh someone adds next month. This one fails on the new one.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  GATEWAY_READ_TIMEOUT_MS,
  GATEWAY_SUBMIT_TIMEOUT_MS,
  readXrdPostingFrozen,
  submitNotarizedTransaction,
  __resetPostingFrozenCacheForTests,
} from "@/lib/gateway"

const SOURCE = readFileSync(join(process.cwd(), "src/lib/gateway.ts"), "utf8")

/** Each `await fetch(` together with the ~20 lines that follow it — enough to
 *  contain its init object, short enough not to swallow the next call. */
function fetchCallSites(): { line: number; body: string }[] {
  const lines = SOURCE.split("\n")
  const sites: { line: number; body: string }[] = []
  lines.forEach((l, i) => {
    if (l.includes("await fetch(")) {
      sites.push({ line: i + 1, body: lines.slice(i, i + 20).join("\n") })
    }
  })
  return sites
}

describe("every Gateway fetch carries an AbortSignal", () => {
  it("finds the call sites at all (guards against the scan silently matching nothing)", () => {
    // Without this, a rename of `fetch` or a reformat would make the sweep below
    // vacuously pass over zero sites — a green test proving nothing, which is
    // the failure family this repo keeps hitting.
    // 11 since the halt detector's readLedgerTip landed on main (#476). The
    // floor is a real assertion, not a formality: a scan that silently matches
    // nothing passes every other case in this file vacuously.
    expect(fetchCallSites().length).toBeGreaterThanOrEqual(11)
  })

  for (const site of fetchCallSites()) {
    it(`gateway.ts:${site.line} passes signal`, () => {
      expect(site.body).toMatch(/signal:\s*AbortSignal\.timeout\(/)
    })
  }

  it("the submit path uses the LOOSER bound, and reads use the tighter one", () => {
    // Not cosmetic. submitNotarizedTransaction returns false on any transport
    // failure and its caller treats false as "submit_rejected" and stops — so an
    // abort converts "we do not know" into a definite wrong answer while the
    // payer's transaction may be committing. Reads collapse to null, which every
    // caller already treats as unknown.
    const submit = fetchCallSites().find((s) => s.body.includes("/transaction/submit"))
    expect(submit, "the submit call site").toBeDefined()
    expect(submit!.body).toContain("GATEWAY_SUBMIT_TIMEOUT_MS")
    expect(GATEWAY_SUBMIT_TIMEOUT_MS).toBeGreaterThan(GATEWAY_READ_TIMEOUT_MS)
  })

  it("bounds are finite and sane", () => {
    for (const ms of [GATEWAY_READ_TIMEOUT_MS, GATEWAY_SUBMIT_TIMEOUT_MS]) {
      expect(Number.isFinite(ms)).toBe(true)
      expect(ms).toBeGreaterThan(0)
      // Well under the 30-minute reconcile interval, so a stuck socket costs one
      // skipped cycle rather than overlapping runs.
      expect(ms).toBeLessThan(30 * 60_000)
    }
  })
})

describe("an aborted request lands in the same bucket as any other failure", () => {
  afterEach(() => { vi.unstubAllGlobals() })
  it("a read that aborts returns null, not a throw and not a fabricated value", async () => {
    __resetPostingFrozenCacheForTests()
    // AbortSignal.timeout rejects with a DOMException; the readers' catch must
    // treat it exactly like an unreachable Gateway.
    const abort = () => Promise.reject(new DOMException("timed out", "TimeoutError"))
    vi.stubGlobal("fetch", vi.fn(abort))
    // readXrdPostingFrozen stands in for the reader family here. Most of the
    // others (fetchTxDetails, resolveTasksKvStore, readOnChainClaimInfo) are
    // module-private, and exporting them so a test can reach them would widen
    // the module's API for the test's convenience — the structural scan above
    // already covers every one of them, which is the better guarantee anyway.
    await expect(
      readXrdPostingFrozen("component_rdx1cz468eqyr0fklyrlcsznadrwfnqnesw37vlm9j0xmq2s7427akd82f"),
    ).resolves.toBeNull()
  })

  it("a submit that aborts returns false — and that is a KNOWN false negative", async () => {
    // Documented, not endorsed. The pre-existing `catch → false` already
    // collapses unknown into rejected; the timeout widens the window it fires
    // in. The real fix is for the caller to poll the intent hash before
    // concluding rejection (duplicate submits are explicitly safe), and that
    // belongs in the x402 facilitator. Pinned here so the behaviour is not
    // mistaken for correctness by the next reader.
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new DOMException("timed out", "TimeoutError"))))
    await expect(submitNotarizedTransaction("00deadbeef")).resolves.toBe(false)
  })
})
