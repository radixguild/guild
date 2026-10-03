// task-stage.test.ts — the lifecycle signpost's logic.
//
// The case that matters most is "the worker collected and the poster has not",
// because that is EXACTLY the state the live component sat in on 2026-08-20
// during the first real two-party settlement, and it is the state in which the
// poster did not notice that anything remained for them to do. A stage strip
// that called that task "Collected" would have actively confirmed the mistake.

import { describe, expect, it } from "vitest"
import { resolveTaskStage, viewerFor, TASK_STAGES } from "@/lib/task-stage"
import type { OnChainTaskInfo } from "@/lib/gateway"

const WORKER = "account_rdx12890803ct999t5ss4qatjyktay82gfy295rr6p4qmhks8twekeqgp9"
const POSTER = "account_rdx1283xglqdjv6w8jreccxwp7d0u55a8ejrkpegc3uunqedsyqt4mtg5q"
const STRANGER = "account_rdx12xm464txr74x9srzmmy5404lyqv650kkgy8ezrx76tmjpl5djvnnwv"

function info(over: Partial<OnChainTaskInfo> = {}): OnChainTaskInfo {
  return {
    state: "Claimed",
    entitlementsPresent: true,
    entitlements: { workerReward: "0", posterReward: "0", workerBond: "0", posterBond: "0" },
    workerAccount: WORKER,
    posterAccount: POSTER,
    claimerBadgeId: "<guild_member_poster>",
    claimerIsAgent: false,
    disputeRaisedBy: null,
    ...over,
  } as OnChainTaskInfo
}

const idx = (s: string) => TASK_STAGES.indexOf(s as never)

describe("viewerFor — identity comes from the chain pins", () => {
  it("matches the worker and poster pins", () => {
    expect(viewerFor(info(), WORKER)).toBe("worker")
    expect(viewerFor(info(), POSTER)).toBe("poster")
  })

  it("anyone else is an observer, including when disconnected", () => {
    expect(viewerFor(info(), STRANGER)).toBe("observer")
    expect(viewerFor(info(), null)).toBe("observer")
  })
})

describe("resolveTaskStage — unknown is not a stage", () => {
  it("returns null while the chain read is unresolved", () => {
    // Rendering a guessed lifecycle would be worse than rendering nothing:
    // a wrong "Collected" tells a payee their money already arrived.
    expect(resolveTaskStage(null, WORKER)).toBeNull()
  })
})

describe("resolveTaskStage — progress along the happy path", () => {
  it("Open has reached only Funded", () => {
    expect(resolveTaskStage(info({ state: "Open" }), POSTER)!.reached).toBe(idx("Funded"))
  })

  it("Claimed has reached Claimed", () => {
    expect(resolveTaskStage(info({ state: "Claimed" }), WORKER)!.reached).toBe(idx("Claimed"))
  })

  it("Submitted has reached Submitted", () => {
    expect(resolveTaskStage(info({ state: "Submitted" }), POSTER)!.reached).toBe(idx("Submitted"))
  })

  it("Released with money still owed is Approved, NOT Collected", () => {
    const v = resolveTaskStage(
      info({
        state: "Released",
        entitlements: { workerReward: "1500", posterReward: "75", workerBond: "0", posterBond: "0" },
      }),
      POSTER,
    )!
    expect(v.reached).toBe(idx("Approved"))
  })

  it("Released with nothing owed to anyone is Collected", () => {
    expect(resolveTaskStage(info({ state: "Released" }), POSTER)!.reached).toBe(idx("Collected"))
  })

  // ── THE CASE FROM 2026-08-20 ─────────────────────────────────────────────
  it("worker collected but poster has not is NOT Collected", () => {
    const half = info({
      state: "Released",
      entitlements: { workerReward: "0", posterReward: "75", workerBond: "0", posterBond: "0" },
    })
    // A one-sided check ("am *I* owed anything?") would call this Collected for
    // the worker, who is owed nothing. Completion is a property of the TASK.
    expect(resolveTaskStage(half, WORKER)!.reached).toBe(idx("Approved"))
    expect(resolveTaskStage(half, POSTER)!.reached).toBe(idx("Approved"))
  })

  it("a pre-PULL component never reads as Collected", () => {
    // Entitlement lanes do not exist there, so every lane reads "0" — which
    // must not be mistaken for "everyone has been paid out".
    const prePull = info({ state: "Released", entitlementsPresent: false })
    expect(resolveTaskStage(prePull, POSTER)!.reached).toBe(idx("Approved"))
  })
})

describe("resolveTaskStage — off-path states", () => {
  it("flags Disputed without pretending the path continues", () => {
    const v = resolveTaskStage(info({ state: "Disputed" }), WORKER)!
    expect(v.offPath).toBe("Disputed")
  })

  it("Refunded is off-path too", () => {
    expect(resolveTaskStage(info({ state: "Refunded" }), POSTER)!.offPath).toBe("Refunded")
  })

  it("the happy path has no off-path marker", () => {
    expect(resolveTaskStage(info({ state: "Submitted" }), POSTER)!.offPath).toBeNull()
  })
})

describe("nextAction — money outranks everything", () => {
  it("tells the poster to collect what is settled and waiting", () => {
    const v = resolveTaskStage(
      info({
        state: "Released",
        entitlements: { workerReward: "0", posterReward: "75", workerBond: "0", posterBond: "0" },
      }),
      POSTER,
    )!
    expect(v.nextAction?.isMoney).toBe(true)
    expect(v.nextAction?.label).toContain("Collect")
    expect(v.nextAction?.label).toContain("75")
  })

  it("names both lanes separately, never a total", () => {
    // Reward and bond can be different resources; summing them would be wrong
    // the moment a non-XRD reward token is whitelisted.
    const v = resolveTaskStage(
      info({
        state: "Released",
        entitlements: { workerReward: "1500", posterReward: "0", workerBond: "10", posterBond: "0" },
      }),
      WORKER,
    )!
    expect(v.nextAction?.label).toContain("1500 XRD")
    expect(v.nextAction?.label).toContain("10 XRD claim bond")
  })

  it("prompts the worker to submit while claimed", () => {
    const v = resolveTaskStage(info({ state: "Claimed" }), WORKER)!
    expect(v.nextAction?.label).toBe("Submit your work")
    expect(v.nextAction?.isMoney).toBe(false)
  })

  it("prompts the poster to approve once submitted", () => {
    const v = resolveTaskStage(info({ state: "Submitted" }), POSTER)!
    expect(v.nextAction?.label).toContain("approve")
  })

  it("does not prompt the wrong party", () => {
    expect(resolveTaskStage(info({ state: "Claimed" }), POSTER)!.nextAction).toBeNull()
    expect(resolveTaskStage(info({ state: "Submitted" }), WORKER)!.nextAction).toBeNull()
  })

  it("observers are never given an action", () => {
    const v = resolveTaskStage(
      info({
        state: "Released",
        entitlements: { workerReward: "1500", posterReward: "75", workerBond: "0", posterBond: "0" },
      }),
      STRANGER,
    )!
    expect(v.nextAction).toBeNull()
  })

  it("a settled, fully-collected task asks nothing of anyone", () => {
    expect(resolveTaskStage(info({ state: "Released" }), POSTER)!.nextAction).toBeNull()
    expect(resolveTaskStage(info({ state: "Released" }), WORKER)!.nextAction).toBeNull()
  })
})
