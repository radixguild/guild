import { describe, it, expect } from "vitest"
import {
  readTxOutcome,
  commitOrThrow,
  assertRevertedWith,
  describeFailure,
} from "../../scripts/lib/tx-outcome.mjs"

// A scripted Gateway: yields one response per poll, records what it was asked.
function gateway(...responses: any[]) {
  const calls: any[] = []
  let i = 0
  const post = async (path: string, body: any) => {
    calls.push({ path, body })
    return responses[Math.min(i++, responses.length - 1)]
  }
  return { post, calls }
}
const noSleep = { sleep: async () => {}, intervalMs: 0 }

describe("readTxOutcome", () => {
  it("returns the error_message on a CommittedFailure — the whole point", async () => {
    const g = gateway({
      status: "CommittedFailure",
      error_message: 'PanicMessage("self-claim not allowed: worker account must differ from poster")',
    })
    const out = await readTxOutcome(g.post, "txid_rdx1abc", noSleep)
    expect(out.status).toBe("CommittedFailure")
    expect(out.errorMessage).toContain("self-claim not allowed")
    expect(out.intentHash).toBe("txid_rdx1abc")
  })

  it("polls past non-terminal statuses until the tx settles", async () => {
    const g = gateway({ status: "Pending" }, { status: "Pending" }, { status: "CommittedSuccess" })
    const out = await readTxOutcome(g.post, "txid_rdx1abc", noSleep)
    expect(out.status).toBe("CommittedSuccess")
    expect(g.calls.length).toBe(3)
    expect(g.calls[0].body).toEqual({ intent_hash: "txid_rdx1abc" })
  })

  it("distinguishes a missing error_message (null) from an empty one", async () => {
    const g = gateway({ status: "CommittedFailure" })
    const out = await readTxOutcome(g.post, "txid_rdx1abc", noSleep)
    expect(out.errorMessage).toBeNull()
  })

  it("reports Timeout rather than inventing a status", async () => {
    let t = 0
    const g = gateway({ status: "Pending" })
    const out = await readTxOutcome(g.post, "txid_rdx1abc", {
      ...noSleep,
      maxWaitMs: 10,
      now: () => (t += 100),
    })
    expect(out.status).toBe("Timeout")
  })

  it("still reads a real status when maxWaitMs is 0 (one read before the clock check)", async () => {
    const g = gateway({ status: "CommittedSuccess" })
    const out = await readTxOutcome(g.post, "txid_rdx1abc", { ...noSleep, maxWaitMs: 0 })
    expect(out.status).toBe("CommittedSuccess")
  })
})

describe("commitOrThrow", () => {
  it("passes through on success", async () => {
    const g = gateway({ status: "CommittedSuccess" })
    const out = await commitOrThrow(g.post, "txid_rdx1abc", "approve_and_release", noSleep)
    expect(out.status).toBe("CommittedSuccess")
  })

  it("puts the reason in the thrown message — the nine call sites could not", async () => {
    // Label + error were "heartbeat" / "claim_bond depleted" until DB-3. The
    // assertion is generic (any verb, any reason), but a fixture naming a
    // method and a panic the blueprint can no longer produce teaches the next
    // reader a fact that stopped being true.
    const g = gateway({
      status: "CommittedFailure",
      error_message: "claim_receipt is not the active one for this task",
    })
    await expect(
      commitOrThrow(g.post, "txid_rdx1abc", "submit", noSleep)
    ).rejects.toThrow(/submit not committed: CommittedFailure .*claim_receipt is not the active one/)
  })

  it("says so explicitly when the Gateway supplied no reason", async () => {
    const g = gateway({ status: "Rejected" })
    await expect(commitOrThrow(g.post, "txid_rdx1abc", "cancel_task", noSleep)).rejects.toThrow(
      /no error_message from the Gateway/
    )
  })
})

describe("assertRevertedWith — the false greens it exists to stop", () => {
  const failure = (msg: string) => ({
    status: "CommittedFailure",
    errorMessage: msg,
    intentHash: "txid_rdx1abc",
  })

  it("accepts a revert carrying the expected reason", () => {
    const out = failure('PanicMessage("claim_bond amount does not match required")')
    expect(() =>
      assertRevertedWith(out, "claim_bond amount does not match required", "under-bond probe")
    ).not.toThrow()
  })

  it("REJECTS a revert for a different reason — the wrong-assert false green", () => {
    // What a stale bond constant actually produces: the amount assert fires
    // first, and a status-only check would have called this a passing self-claim
    // probe.
    const out = failure('PanicMessage("claim_bond amount does not match required")')
    expect(() => assertRevertedWith(out, "self-claim not allowed", "self-claim probe")).toThrow(
      /WRONG reason/
    )
  })

  it("REJECTS a success — the guard under test never fired", () => {
    const out = { status: "CommittedSuccess", errorMessage: null, intentHash: "txid_rdx1abc" }
    expect(() => assertRevertedWith(out, "self-claim not allowed", "self-claim probe")).toThrow(
      /SUCCEEDED/
    )
  })

  it("REJECTS a Rejected tx — it never reached execution, so nothing was asserted", () => {
    const out = { status: "Rejected", errorMessage: "fee reserve", intentHash: "txid_rdx1abc" }
    expect(() => assertRevertedWith(out, "self-claim not allowed", "self-claim probe")).toThrow(
      /never reached execution/
    )
  })

  it("REJECTS a Timeout for the same reason", () => {
    const out = { status: "Timeout", errorMessage: null, intentHash: "txid_rdx1abc" }
    expect(() => assertRevertedWith(out, "self-claim not allowed", "self-claim probe")).toThrow(
      /never reached execution/
    )
  })

  it("REJECTS a revert with no error_message rather than assuming the reason", () => {
    const out = { status: "CommittedFailure", errorMessage: null, intentHash: "txid_rdx1abc" }
    expect(() => assertRevertedWith(out, "self-claim not allowed", "self-claim probe")).toThrow(
      /WHICH assert fired is unknown/
    )
  })
})

describe("describeFailure", () => {
  it("includes the reason when there is one", () => {
    expect(
      describeFailure({ status: "CommittedFailure", errorMessage: "boom", intentHash: "t" }, "sweep")
    ).toBe("sweep not committed: CommittedFailure (t) — boom")
  })
})
