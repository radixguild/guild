import { describe, it, expect } from "vitest"
import {
  DISPUTE_STAGES,
  disputeStageFor,
  isDisputeStageNew,
  isDisputeWorthPaging,
  pruneDisputeStamp,
  disputeStampKey,
  formatDisputeAlert,
  type DisputeAlertItem,
} from "@/lib/escrow-drift"
import {
  AUTO_RESOLVE_DEFAULT,
  autoResolveCredits,
  autoResolvePayout,
} from "@/lib/dispute-outcome"

/**
 * The escalation half of the live-dispute alert (scripts/escrow-drift-watch.mjs
 * pass 3), which decides HOW OFTEN a human is paged about money and WHAT NUMBER
 * they are shown. Both were wrong in production:
 *
 *   frequency — one live dispute produced 144 identical messages over its 72h
 *               window, on a half-hourly cron
 *   content   — the message said "the blueprint's default ruling fires", and a
 *               draft summarising it said "SplitEvenly (60/60)", wrong on both
 *               the mechanism and the amount
 *
 * Every test below names the mutation it catches, because a test that cannot
 * fail would not have caught either defect.
 */

const H = 3600_000
const WINDOW = 72 * H

describe("dispute escalation — stage machine", () => {
  it("walks raised → half → closing as the window burns down", () => {
    expect(disputeStageFor(72 * H, WINDOW)).toBe("raised")
    expect(disputeStageFor(40 * H, WINDOW)).toBe("raised")
    expect(disputeStageFor(36 * H, WINDOW)).toBe("half") // exactly 0.5
    expect(disputeStageFor(10 * H, WINDOW)).toBe("half")
    expect(disputeStageFor(7.2 * H, WINDOW)).toBe("closing") // exactly 0.1
    expect(disputeStageFor(1 * H, WINDOW)).toBe("closing")
  })

  it("reports lapsed at and past the deadline", () => {
    expect(disputeStageFor(0, WINDOW)).toBe("lapsed")
    expect(disputeStageFor(-1, WINDOW)).toBe("lapsed")
    expect(disputeStageFor(-99 * H, WINDOW)).toBe("lapsed")
  })

  /**
   * MUTATION: return "closing" for a null msLeft (the shipped first version,
   * commented "unknown deadline reads as urgent"). That stamps the dispute as
   * told-about and then goes permanently silent, because only `lapsed` re-fires
   * — so the ONE dispute nobody can put a clock on gets the quietest treatment.
   */
  it("treats an UNREADABLE deadline as lapsed, not as closing", () => {
    expect(disputeStageFor(null, WINDOW)).toBe("lapsed")
  })

  /** MUTATION: drop the windowMs guard. 0 divides to Infinity, NaN compares
   *  false against both thresholds, and every dispute silently reads `raised`. */
  it.each([0, -1, Number.NaN])("treats an unusable window (%s) as lapsed", (w) => {
    expect(disputeStageFor(10 * H, w)).toBe("lapsed")
  })

  it("never returns a stage outside the declared list", () => {
    for (const ms of [null, -1, 0, 1, H, 36 * H, 71 * H, Number.MAX_SAFE_INTEGER]) {
      expect(DISPUTE_STAGES).toContain(disputeStageFor(ms, WINDOW))
    }
  })
})

describe("dispute escalation — fire once per stage", () => {
  it("fires on first sight and stays quiet until the stage advances", () => {
    expect(isDisputeStageNew(undefined, "raised")).toBe(true)
    expect(isDisputeStageNew("raised", "raised")).toBe(false)
    expect(isDisputeStageNew("raised", "half")).toBe(true)
    expect(isDisputeStageNew("half", "closing")).toBe(true)
  })

  it("never re-fires a stage the clock has already passed", () => {
    expect(isDisputeStageNew("closing", "half")).toBe(false)
    expect(isDisputeStageNew("closing", "raised")).toBe(false)
  })

  /**
   * MUTATION: make `lapsed` fire once like the others. Past the window the
   * outcome is a race — anyone may call auto_resolve_dispute and lock in the
   * default, while an arbiter can still rule until they do — so a single
   * message that scrolls away is exactly the wrong behaviour. This is the one
   * case where the original "be noisy" posture was right.
   */
  it("re-fires lapsed on every run, forever", () => {
    expect(isDisputeStageNew("lapsed", "lapsed")).toBe(true)
    expect(isDisputeStageNew("closing", "lapsed")).toBe(true)
    expect(isDisputeStageNew(undefined, "lapsed")).toBe(true)
  })

  /** A corrupt or hand-edited stamp value must not suppress anything. */
  it("treats an unrecognised stored stage as never-sent", () => {
    expect(isDisputeStageNew("garbage", "raised")).toBe(true)
    expect(isDisputeStageNew(null, "closing")).toBe(true)
  })
})

describe("dispute escalation — value threshold", () => {
  it("pages at or above the threshold and stays quiet below it", () => {
    expect(isDisputeWorthPaging({ reward: 100, insurance: 5 }, 100)).toBe(true)
    expect(isDisputeWorthPaging({ reward: 95, insurance: 5 }, 100)).toBe(true) // exactly 100
    expect(isDisputeWorthPaging({ reward: 20, insurance: 1 }, 100)).toBe(false) // task 3
  })

  it("pages on everything when the threshold is 0", () => {
    expect(isDisputeWorthPaging({ reward: 0, insurance: 0 }, 0)).toBe(true)
  })

  /**
   * MUTATION: treat an unreadable value as 0 (the natural `value?.reward ?? 0`
   * spelling). A Gateway hiccup would then silence a 30,000 XRD dispute — the
   * threshold's whole purpose inverted. Never silence what you cannot price.
   */
  it("pages when the escrowed value is UNREADABLE", () => {
    expect(isDisputeWorthPaging(null, 100)).toBe(true)
    expect(isDisputeWorthPaging({ reward: Number.NaN, insurance: 5 }, 100)).toBe(true)
    expect(isDisputeWorthPaging({ reward: 100, insurance: Number.NaN }, 100)).toBe(true)
  })

  /** MUTATION: drop the threshold guard. A typo'd env var parses to NaN, every
   *  `>=` comparison is false, and the alert goes silent on ALL disputes. */
  it("pages when the threshold itself is unusable", () => {
    expect(isDisputeWorthPaging({ reward: 1, insurance: 0 }, Number.NaN)).toBe(true)
  })
})

describe("dispute escalation — stamp pruning", () => {
  it("keeps live tasks and drops settled ones", () => {
    expect(pruneDisputeStamp({ "c:3": "half", "c:7": "lapsed" }, ["c:3"])).toEqual({ "c:3": "half" })
  })

  it("empties when nothing is disputed", () => {
    expect(pruneDisputeStamp({ "c:3": "half" }, [])).toEqual({})
  })

  it("does not invent entries for live tasks it has never seen", () => {
    expect(pruneDisputeStamp({}, ["c:1", "c:2", "c:3"])).toEqual({})
  })
})

describe("autoResolvePayout — what the operator is actually told", () => {
  /**
   * The number in the message. The ruling governs the REWARD only; insurance is
   * hard-coded RefundPoster on the auto path (lib.rs's `auto_resolve_dispute`
   * calling `credit_split_for_parties(.., &ruling, &DisputeRuling::RefundPoster, ..)`).
   *
   * MUTATION: split the insurance too — i.e. worker (100+10)/2 = 55, the exact
   * belief that produced "SplitEvenly (60/60)" in a draft summary and
   * "wins reward + insurance" in gateway.ts's doc comment.
   */
  it("SplitEvenly splits the reward and returns ALL insurance to the poster", () => {
    expect(autoResolvePayout("SplitEvenly", "worker", 100, 10)).toEqual({ worker: 50, poster: 60 })
    expect(autoResolvePayout("SplitEvenly", "poster", 100, 10)).toEqual({ worker: 50, poster: 60 })
  })

  it("reproduces the live task-3 figures the alert quoted", () => {
    // 20 XRD reward + 1 XRD insurance, the on-chain probe task.
    expect(autoResolvePayout("SplitEvenly", "worker", 20, 1)).toEqual({ worker: 10, poster: 11 })
  })

  it("ReturnToPoster pays the worker nothing and the poster everything", () => {
    expect(autoResolvePayout("ReturnToPoster", "worker", 100, 10)).toEqual({
      worker: 0,
      poster: 110,
    })
  })

  it("FavorDisputeRaiser turns on who raised it — and only the reward moves", () => {
    expect(autoResolvePayout("FavorDisputeRaiser", "worker", 100, 10)).toEqual({
      worker: 100,
      poster: 10,
    })
    expect(autoResolvePayout("FavorDisputeRaiser", "poster", 100, 10)).toEqual({
      worker: 0,
      poster: 110,
    })
  })

  /**
   * MUTATION: keep the shipped `raisedBy === "worker" ? reward : 0`, which reads
   * an unknown raiser as the poster. That silently names the wrong winner in an
   * operator's message on the one ruling where the raiser decides the outcome.
   */
  it("says nothing when FavorDisputeRaiser meets an unknown raiser", () => {
    expect(autoResolvePayout("FavorDisputeRaiser", null, 100, 10)).toBeNull()
  })

  it("says nothing for an unreadable or unrecognised ruling", () => {
    expect(autoResolvePayout(null, "worker", 100, 10)).toBeNull()
    expect(autoResolvePayout("SomeFutureRuling", "worker", 100, 10)).toBeNull()
    expect(autoResolvePayout("", "worker", 100, 10)).toBeNull()
  })

  it("says nothing rather than printing NaN XRD", () => {
    expect(autoResolvePayout("SplitEvenly", "worker", Number.NaN, 10)).toBeNull()
    expect(autoResolvePayout("SplitEvenly", "worker", 100, Number.POSITIVE_INFINITY)).toBeNull()
  })

  it("conserves the pot under every ruling — nothing is created or lost", () => {
    for (const ruling of ["SplitEvenly", "ReturnToPoster", "FavorDisputeRaiser"]) {
      for (const raisedBy of ["worker", "poster"] as const) {
        const p = autoResolvePayout(ruling, raisedBy, 137, 7)!
        expect(p.worker + p.poster).toBeCloseTo(144, 10)
      }
    }
  })

  /**
   * The money page's example numbers and the operator alert's numbers must
   * agree — they are now produced by one function, and this pins the agreement
   * so a re-introduced second copy has to match to survive.
   *
   * MUTATION: change either arithmetic (e.g. split the combined bucket rather
   * than the reward) and this goes red. It cannot catch a duplicate that
   * happens to be identical — nothing at this level can; it catches the
   * divergence, which is the failure that actually hurt.
   */
  it("agrees with autoResolveCredits on every reward, at the live default", () => {
    for (const reward of [1, 30, 100, 1500]) {
      const credits = autoResolveCredits(reward)
      const direct = autoResolvePayout(AUTO_RESOLVE_DEFAULT, null, reward, credits.insurance)!
      expect(credits.worker).toBe(direct.worker)
      expect(credits.poster).toBe(direct.poster)
    }
  })
})

describe("formatDisputeAlert — the message that has to tell you what to do", () => {
  const base: DisputeAlertItem = {
    onChainTaskId: 3,
    raisedBy: "worker",
    deadline: new Date("2026-08-26T22:36:42.000Z"),
    msLeft: 12 * H,
    value: { reward: 20, insurance: 1 },
    stage: "closing",
  }
  const msg = (over: Partial<DisputeAlertItem> = {}, ruling: string | null = "SplitEvenly") =>
    formatDisputeAlert([{ ...base, ...over }], { ruling, minXrd: 100 })

  it("names the payout to each party, not just the ruling", () => {
    const m = msg()
    expect(m).toContain("worker 10, poster 11 XRD")
    expect(m).toContain("escrowed 20 reward + 1 insurance XRD")
  })

  /**
   * MUTATION: drop the WHAT TO DO block, i.e. the message this replaces. It
   * carried a countdown and a ruling name and left the reader to work out
   * whether that required anything of them. 144 times.
   */
  it("always names the next action", () => {
    for (const stage of DISPUTE_STAGES) {
      expect(msg({ stage })).toContain("WHAT TO DO")
    }
  })

  it("tells you the do-nothing option before the window closes", () => {
    const m = msg({ stage: "half", msLeft: 40 * H })
    expect(m).toContain("To accept the default: do nothing")
    expect(m).toContain("arbiter-harness.mjs resolve")
  })

  /**
   * MUTATION: keep one fixed instruction for every stage (the shipped version).
   * Past the window "arbitrate before it closes" is stale advice: it has closed.
   * What is true instead is that arbitration still works but is now a race.
   */
  it("changes the instruction once the window has lapsed", () => {
    const lapsed = msg({ stage: "lapsed", msLeft: -1 })
    expect(lapsed).toContain("First one wins")
    expect(lapsed).toContain("resolve_dispute asserts only")
    expect(lapsed).not.toContain("before the window closes")
  })

  /**
   * MUTATION: restore "the pot is drainable by anyone" / "auto_resolve_dispute
   * is callable BY ANYONE now" without the correction. Under the deployed PULL
   * component that is FALSE — settlement credits entitlements to payees pinned
   * at create/claim — and it is the same superseded BUG-7 belief this branch
   * removed from keeper.mjs. A scare claim in a money alert is not a safe
   * default; it is the thing that gets alerts ignored.
   */
  it("never tells the operator their pot can be stolen", () => {
    const lapsed = msg({ stage: "lapsed", msLeft: -1 })
    expect(lapsed).toContain("Nobody can steal the pot")
    expect(lapsed.toLowerCase()).not.toContain("drain")
  })

  it("says the amount is unreadable rather than implying zero", () => {
    const m = msg({ value: null })
    expect(m).toContain("escrowed amount unreadable")
    expect(m).not.toContain("worker 0")
  })

  it("refuses to state a payout it could not compute", () => {
    const m = msg({ raisedBy: null }, "FavorDisputeRaiser")
    expect(m).toContain("payout NOT COMPUTED")
    // The escrowed total is still knowable and still worth showing.
    expect(m).toContain("escrowed 20 reward + 1 insurance XRD")
  })

  it("says so when the ruling itself is unreadable", () => {
    expect(msg({}, null)).toContain("ruling UNREADABLE from chain")
  })

  /** Float noise in a message about someone's money reads as a bug. */
  it("trims double-arithmetic noise out of the amounts", () => {
    const m = formatDisputeAlert(
      [{ ...base, value: { reward: 0.1, insurance: 0.2 } }],
      { ruling: "ReturnToPoster", minXrd: 100 },
    )
    expect(m).toContain("poster 0.3 XRD")
    expect(m).not.toContain("0.30000000000000004")
  })

  it("points at the disputes it deliberately did not page about", () => {
    const m = formatDisputeAlert([base], { ruling: "SplitEvenly", minXrd: 100, quietCount: 2 })
    expect(m).toContain("2 further dispute(s) below the 100 XRD threshold")
  })

  it("omits the below-threshold note when there is nothing below it", () => {
    expect(msg()).not.toContain("below the")
  })

  it("carries the deadline so the reader can check the clock themselves", () => {
    expect(msg()).toContain("2026-08-26T22:36:42.000Z")
  })
})

/**
 * MUTATION: hand-roll the amount rendering again (a local toFixed helper was
 * the first version, and tests/unit/xrd-display-standard.test.ts caught it).
 * A 30,000 XRD dispute and a 30 XRD one must not be one misread zero apart in
 * the message that decides whether the operator gets out of bed.
 */
describe("formatDisputeAlert — amounts use the site-wide XRD standard", () => {
  it("groups large amounts so a magnitude cannot be misread", () => {
    const m = formatDisputeAlert(
      [
        {
          onChainTaskId: 11,
          raisedBy: "poster",
          deadline: null,
          msLeft: -1,
          value: { reward: 30000, insurance: 1500 },
          stage: "lapsed",
        },
      ],
      { ruling: "SplitEvenly", minXrd: 100 },
    )
    expect(m).toContain("escrowed 30,000 reward + 1,500 insurance XRD")
    expect(m).toContain("worker 15,000, poster 16,500 XRD")
  })
})

/**
 * The collision this repo has already been bitten by once. `on_chain_task_id`
 * restarts at 0 on every escrow component, so a stamp keyed on the bare id
 * carries a retired component's state onto the new one — the same class of
 * defect that made the event-replay reconciler heal the wrong DB row, fixed for
 * DB rows by adding `tasks.escrow_component` (PR #197).
 */
describe("dispute stamp keys are component-qualified", () => {
  const OLD = "component_rdx1old"
  const NEW = "component_rdx1new"

  /**
   * MUTATION: key on `String(taskId)` alone (the shipped version). The retired
   * component's `lapsed` then outranks raised/half/closing on the NEW
   * component's task 3, so its first message arrives only once its own window
   * has already closed — an alert delivered exactly when it stops being
   * actionable.
   */
  it("does not let a retired component's stage silence the new one", () => {
    const stamp = { [disputeStampKey(OLD, 3)]: "lapsed" }
    expect(isDisputeStageNew(stamp[disputeStampKey(NEW, 3)], "raised")).toBe(true)
    // ...while the old component's own task 3 is still correctly suppressed.
    expect(isDisputeStageNew(stamp[disputeStampKey(OLD, 3)], "closing")).toBe(false)
  })

  it("keeps the same task on the same component suppressed", () => {
    const stamp = { [disputeStampKey(NEW, 3)]: "half" }
    expect(isDisputeStageNew(stamp[disputeStampKey(NEW, 3)], "half")).toBe(false)
    expect(isDisputeStageNew(stamp[disputeStampKey(NEW, 3)], "closing")).toBe(true)
  })

  it("prunes by key, so a component swap clears the retired entries", () => {
    const stamp = {
      [disputeStampKey(OLD, 3)]: "lapsed",
      [disputeStampKey(NEW, 3)]: "raised",
    }
    expect(pruneDisputeStamp(stamp, [disputeStampKey(NEW, 3)])).toEqual({
      [disputeStampKey(NEW, 3)]: "raised",
    })
  })

  /**
   * MUTATION: gate the prune on `liveDisputes.length > 0` (the shipped version).
   * The last dispute to settle is then never pruned, because the run that learns
   * it settled is the run with zero live disputes — so the file never converges
   * to empty, contradicting the function's own stated invariant.
   */
  it("empties completely when the last dispute settles", () => {
    expect(pruneDisputeStamp({ [disputeStampKey(NEW, 3)]: "lapsed" }, [])).toEqual({})
  })
})
