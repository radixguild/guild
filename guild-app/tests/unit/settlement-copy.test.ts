/**
 * Both escrow worlds' copy, gated statically — closing the CI blind spot.
 *
 * CHECK 4 and the cold-user e2e scan the BAKED artifact, so they gate whichever
 * era the build compiled — and CI compiles push until the cutover, which means
 * the pull branch of every era-varying sentence would reach the ceremony
 * unscanned. This file runs the honest-copy rule tables over BOTH eras of every
 * string in settlement-copy.ts, so the cutover's copy flip is pre-verified the
 * day it is written, not discovered red mid-ceremony.
 *
 * The TEETH set is the load-bearing part. It pins, by measurement (2026-08-15),
 * exactly which push strings trip PULL_BANNED — i.e. which sentences the module
 * exists to swap. If a rule regex silently loses a branch, a pinned key stops
 * tripping and the set equality fails; if a push sentence is softened until the
 * rule cannot see it, same failure. Either direction, the gate names the key.
 */
import { describe, it, expect, vi } from "vitest"
import {
  SETTLEMENT_COPY,
  DISPUTE_ON_OVERLAY,
  DISPUTE_COPY,
  settlementEra,
  settlementCopy,
  disputeEra,
  disputeCopy,
} from "@/lib/settlement-copy"
import { BANNED, PULL_BANNED, violation } from "../../scripts/honest-copy.mjs"

type Rule = { label: string; re: RegExp }
const trips = (text: string, rules: Rule[]) =>
  rules.map((r) => violation(text, r)).filter(Boolean)

const entries = Object.entries(SETTLEMENT_COPY) as Array<
  [string, { push: string | null; pull: string | null }]
>

// Measured 2026-08-15 with the then-current rule tables: the push sentences the
// armed gate actually fails on (7 page sites) plus the two widget strings the
// artifact gates cannot see (the widget renders on a non-cold route).
//
// EXTENDED 2026-08-18 by six sites that were never in this module at all. They
// shipped inline in /money and /disputes, so no test here could see them, and
// they SERVED push-era claims on the live PULL component for ~23h after the
// cutover. Measured before the fix: the armed gate caught 0 of 6 — every one was
// a paraphrase of a pinned sentence ("release METHOD hands the ESCROWED BUCKETS
// back" vs the pinned "release hands the funds back"), and PULL_BANNED's rules
// were precise to the wording they shipped beside. The four rules added to
// PULL_BANNED in the same commit match the CLAIM instead, and now catch 6 of 6.
// Their push forms are retained here purely to anchor those rules — the
// no-decoration test above fails the build if a rule has nothing to match.
const TEETH = [
  "docsAgentPayoutStep",
  "docsBountiesAnswer",
  "docsFundingAnswer",
  "guideSettleBody",
  "lifecycleApproveDoes",
  "lifecycleApproveEli5",
  "lifecycleIntroSteps",
  "moneyHonestLimit",
  "moneyRewardDetail",
  // The six that shipped inline — see the note above this array.
  "disputesAutoResolveBody",
  "disputesResolutionMechanism", // renamed 2026-08-27 from disputesDormantMechanism (P3-3 flip)
  "moneyStatusFeeRow",
  "moneyStatusRoutingRow",
  "moneyTrustPostureBody",
  "moneyTrustPostureLabel",
  // Round 2: CHECK 4, newly armed with the claim-matching rules, failed the
  // build on FOUR more served sites the first pass missed — /trust, /lifecycle,
  // and /money twice, one of them the page's <head> metadata description. The
  // first pass had checked its own work case-SENSITIVELY while the rules are
  // case-insensitive, so lower-case "manifest-routed" survived it.
  "lifecycleSettlementNote",
  "moneyFeeBadge",
  "moneyMetaDescription",
  "moneySettlementBadge",
  "trustKeeperSettlementNote",
  // The Help-menu tour's worker step (guides.ts) — the first INTERACTION-GATED
  // era-varying sentence. Its push form says "the reward is released to you"
  // deliberately, so the cutover cannot leave the tour describing push while
  // every artifact-gated page has flipped.
  "tourSubmitBody",
  // Round 4, 2026-08-21: the landing hero. It shipped inline in page.tsx and
  // served its push form on the live pull component; the gate was green on it
  // because approval-pays pinned only THIRD-person wordings. Its push form now
  // trips the rule's new second-person branch, which is what puts it here.
  "landingHeroBody",
  // And the second-person branch immediately found a site nobody was looking
  // for: fundInsuranceNote.push ("the insurance comes back to you when you
  // release payment") makes the same false-under-pull claim about the OTHER
  // leg, and had sat in this module untripped since it was written. Its pull
  // form was already correct, so nothing false ever served — but the rule that
  // was supposed to guarantee that could not see it. This set equality is what
  // surfaced it; the alternative was adding the hero and never knowing.
  "fundInsuranceNote",
  // Round 5, 2026-08-21: the two sites the 08-18 round left serving. Both were
  // named as open in PROJECT-STATE, both shipped inline, and both were measured
  // CLEAN against the shipped rule before it was broadened — three word-order
  // blind spots (noun→verb, the clause form of "not contract-enforced", and the
  // deposit-target denial, which is the same claim stated as an absence).
  "auditorAuthPatternNote",
  "agentsSettlementNote",
  // Round 6, same day: the "what comes back, and when" form. Three more inline
  // era-varying sentences, found by a UX/accuracy audit rather than by the
  // gate. taskSubmittedWaitingNote is the one that mattered most — it is shown
  // to the WORKER on every submitted task and told them the poster's signature
  // is what moves the money, which under pull is the one thing it does not do.
  "guideInsuranceTodayNote",
  "docsIsItFreeAnswer",
  "taskSubmittedWaitingNote",
  // Round 8, 2026-09-21: bond-returned-on-submit. Both push forms say the bond
  // comes back at submit — true on the push component, false since Wave B —
  // and their pull forms said the same thing until this round. Seventeen served
  // sites carried it, the Submit button among them.
  "guideClaimBody",
  "docsFeesAnswer",
  // Round 9, 2026-10-02: bond-dispute-branch added no key. Its only push hit is
  // tourSubmitBody.push ("your claim bond has already come back", beside an
  // approval, with no dispute branch), already pinned above, and that hit is what
  // keeps the new rule from being decoration. Its pull forms, and guideClaimBody's
  // and docsFeesAnswer's, said the bond splits "if a dispute is ruled" until the
  // same day; they now say "raised", and the pull sweep below holds them there.
].sort()

// Sites that legitimately render NOTHING in one era — a method or cost that
// does not exist there. Pinned so a null cannot appear (or vanish) silently.
// Shrank 2026-08-21 with the deletion of user-journey-widget.tsx — 585 lines
// re-teaching four other pages in carousel form. Its SEVEN settlement-copy keys
// went with it rather than being left as dead copy: they were the component's
// strings and nothing else rendered them. Checked before deleting — the
// "no rule is decoration" test above still passes, so no PULL_BANNED rule was
// anchored solely on a widget push string.
const NULL_IN_PULL = ["moneyHeartbeatRow"].sort()
const NULL_IN_PUSH = [
  // The collect affordance in escrow-actions.tsx has no push equivalent — under
  // push the money is already in the account and there is nothing to collect.
  "collectWorkerNote",
].sort()

describe("settlement copy — both eras against the full rule tables", () => {
  it("every string, both eras, clears BANNED — era never excuses an overclaim", () => {
    for (const [key, eras] of entries) {
      for (const era of ["push", "pull"] as const) {
        const text = eras[era]
        if (text == null) continue
        expect(trips(text, BANNED), `${key}.${era} trips BANNED`).toEqual([])
      }
    }
  })

  it("every PULL string clears PULL_BANNED — the sweep is complete by construction", () => {
    for (const [key, eras] of entries) {
      if (eras.pull == null) continue
      expect(trips(eras.pull, PULL_BANNED), `${key}.pull trips PULL_BANNED`).toEqual([])
    }
  })

  it("every PULL_BANNED rule fires on at least one push string — no rule is decoration", () => {
    // Successor to honest-copy.test.ts's "live ammunition" describe, which
    // scanned page SOURCES and therefore had to die the day the sweep moved
    // era-varying copy out of the pages. The guarantee it carried survives
    // here: a dormant rule that matches nothing would sit looking like
    // protection and do nothing on the one day it matters. Push strings ARE
    // the shipped copy until the cutover, so firing on them is firing on the
    // product, not on a fixture.
    for (const rule of PULL_BANNED as Rule[]) {
      const hit = entries.some(
        ([, eras]) => eras.push != null && violation(eras.push!, rule) !== null,
      )
      expect(hit, `${rule.label} matches NO push string — decoration, not a gate`).toBe(true)
    }
  })

  it("the TEETH: exactly the pinned push strings trip PULL_BANNED", () => {
    const tripping = entries
      .filter(([, eras]) => eras.push != null && trips(eras.push!, PULL_BANNED).length > 0)
      .map(([key]) => key)
      .sort()
    // Set EQUALITY, not subset: a new era-varying sentence added here whose
    // push form does not trip any rule deserves a look (is the rule blind, or
    // does the sentence not vary by era at all?) — and a pinned key that stops
    // tripping means a rule or a sentence quietly lost its meaning.
    expect(tripping).toEqual(TEETH)
  })

  it("null sites are exactly the pinned ones, and no key is null in both eras", () => {
    const nullPull = entries.filter(([, e]) => e.pull == null).map(([k]) => k).sort()
    const nullPush = entries.filter(([, e]) => e.push == null).map(([k]) => k).sort()
    expect(nullPull).toEqual(NULL_IN_PULL)
    expect(nullPush).toEqual(NULL_IN_PUSH)
    for (const [key, eras] of entries) {
      expect(eras.push != null || eras.pull != null, `${key} is null in BOTH eras`).toBe(true)
    }
  })

  it("heartbeat and deadline-extension language exists ONLY in push strings", () => {
    // The pull blueprint has no heartbeat leg (DB-3). A pull string mentioning
    // one would be describing a method that does not exist — the exact class
    // the cutover sweep exists to remove. This check already earned its keep
    // twice before this file first went green: it caught a disavowal-by-name
    // in guideClaimBody.pull ("there are no deadline extensions") that dragged
    // dead machinery into a cold reader's mental model.
    //
    // Named exemptions only, with reasons — the same philosophy as
    // honest-copy.mjs's explicit allow lists, and for the same reason: a
    // blanket negation heuristic would silently excuse real leaks.
    const HEARTBEAT_EXEMPT = new Set([
      // /auditor-guide: the string completes a paragraph that IS the
      // historical record of the heartbeat removal (P1-3c → cutover). An
      // auditor page naming the removed leg is the record working, not a leak
      // — and the surrounding static prose names it regardless.
      "auditorHeartbeatStatus",
    ])
    for (const [key, eras] of entries) {
      if (eras.pull == null || HEARTBEAT_EXEMPT.has(key)) continue
      expect(
        /heartbeat|deadline extension/i.test(eras.pull),
        `${key}.pull mentions the heartbeat/extension leg`,
      ).toBe(false)
    }
  })
})

describe("era selection", () => {
  // Was "settlementCopy follows the escrowPull flag both ways". S3 deleted that
  // flag with the push-form manifest builders, so there is no build left that
  // could honestly describe push settlement — the app cannot produce a push
  // manifest at all. This pins the constant instead, which is the guard that
  // stops the era becoming selectable again by accident while the (now
  // unreachable) push column still sits in the table.
  it("the era is PULL, permanently — there is no push build to describe", () => {
    expect(settlementEra()).toBe("pull")
    // moneyHeartbeatRow is push-only: a pull build must render nothing there.
    expect(settlementCopy("moneyHeartbeatRow")).toBeNull()
    expect(settlementCopy("lifecycleIntroSteps")).toContain("Five signed transactions")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE DISPUTE-ERA AXIS (P3-3/DB-5, 2026-08-27). Same guarantee as above, second
// flag: CI builds with NEXT_PUBLIC_FEATURE_DISPUTES unset, so the ON forms of
// every dispute-era sentence would reach production unscanned by CHECK 4 / the
// cold-user e2e run in CI. This block gates BOTH forms statically, plus
// direction teeth so an `on` string cannot claim the surface is off (the exact
// drift the 2026-08-27 audit caught latent on 7 pages) and vice versa.
// ─────────────────────────────────────────────────────────────────────────────

type DisputeForm = { off: string | null; on: string | null }
const disputeEntries = Object.entries(DISPUTE_COPY) as Array<[string, DisputeForm]>
const overlayEntries = Object.entries(DISPUTE_ON_OVERLAY) as Array<[string, string]>

// A sentence ASSERTING the dispute surface is off/dormant. Word-boundary
// precise on purpose: the ON forms legitimately say "compiles it off" (about
// the gate) and "leaving them off had become the worse option" (history) —
// neither asserts the running surface is off.
const OFF_ASSERT =
  /\b(is|are|stays?) (switched |compiled |turned )?(off|dormant)\b|\bcompiled (off|out)\b|\bswitched off\b|\bdormant\b|\bpolicy-disabled\b|\byou cannot raise\b|\bcannot raise one\b|\bDORMANT\b/
// A sentence ASSERTING the dispute surface is on/live.
const ON_ASSERT =
  /\bdispute resolution is live\b|\bcontrols are switched on\b|\bwith disputes on\b|\bcan raise (a dispute|one here)\b|\braising a dispute is available\b|\bLIVE\b/

describe("dispute-era copy — both forms against the full rule tables", () => {
  it("every DISPUTE_COPY form, both eras, clears BANNED and PULL_BANNED", () => {
    for (const [key, forms] of disputeEntries) {
      for (const era of ["off", "on"] as const) {
        const text = forms[era]
        if (text == null) continue
        expect(trips(text, BANNED), `${key}.${era} trips BANNED`).toEqual([])
        expect(trips(text, PULL_BANNED), `${key}.${era} trips PULL_BANNED`).toEqual([])
      }
    }
  })

  it("every DISPUTE_ON_OVERLAY string clears BANNED and PULL_BANNED", () => {
    for (const [key, text] of overlayEntries) {
      expect(trips(text, BANNED), `overlay ${key} trips BANNED`).toEqual([])
      expect(trips(text, PULL_BANNED), `overlay ${key} trips PULL_BANNED`).toEqual([])
    }
  })

  it("every overlay key overlays a real, non-null pull site", () => {
    for (const [key] of overlayEntries) {
      const site = (SETTLEMENT_COPY as Record<string, { pull: string | null }>)[key]
      expect(site, `overlay key ${key} is not in SETTLEMENT_COPY`).toBeDefined()
      expect(site.pull, `overlay key ${key} would resurrect a null pull site`).not.toBeNull()
    }
  })

  it("the overlay TEETH: every overlaid pull string asserts off-ness — that is WHY it needs an overlay", () => {
    // Set equality, same philosophy as the push/pull TEETH: an overlay on a
    // string that does not vary by dispute era deserves a look, and an
    // era-varying pull string WITHOUT an overlay is the 7-page drift the
    // 2026-08-27 audit found.
    const OVERLAY_KEYS = [
      "disputesResolutionMechanism",
      "guideClaimBody",
      "guideSettleBody",
      "lifecycleApproveDoes",
    ]
    expect(overlayEntries.map(([k]) => k).sort()).toEqual(OVERLAY_KEYS)
    for (const [key] of overlayEntries) {
      const pull = (SETTLEMENT_COPY as Record<string, { pull: string | null }>)[key].pull!
      expect(OFF_ASSERT.test(pull), `${key}.pull does not assert off-ness — why overlay it?`).toBe(true)
    }
  })

  it("direction teeth: no ON form asserts the surface is off, no OFF form asserts it is on", () => {
    for (const [key, text] of overlayEntries) {
      expect(OFF_ASSERT.test(text), `overlay ${key} (an ON form) asserts off-ness`).toBe(false)
    }
    for (const [key, forms] of disputeEntries) {
      if (forms.on != null && key !== "disputesPageStatus") {
        expect(OFF_ASSERT.test(forms.on), `${key}.on asserts off-ness`).toBe(false)
      }
      if (forms.off != null && key !== "disputesPageStatus") {
        expect(ON_ASSERT.test(forms.off), `${key}.off asserts on-ness`).toBe(false)
      }
    }
    // disputesPageStatus is the badge word itself — the one key that IS the
    // assertion, in exactly one word per era. Pin it directly instead.
    expect(DISPUTE_COPY.disputesPageStatus.off).toBe("DORMANT")
    expect(DISPUTE_COPY.disputesPageStatus.on).toBe("LIVE")
  })

  it("the direction markers are live ammunition, not decoration", () => {
    // At least one OFF form must trip OFF_ASSERT and one ON form ON_ASSERT —
    // a marker regex that matches nothing would sit looking like protection.
    expect(disputeEntries.some(([, f]) => f.off != null && OFF_ASSERT.test(f.off))).toBe(true)
    expect(disputeEntries.some(([, f]) => f.on != null && ON_ASSERT.test(f.on))).toBe(true)
  })

  it("null forms are exactly the bug-bounty pair — a scope line lives in ONE list per era", () => {
    const nullOff = disputeEntries.filter(([, f]) => f.off == null).map(([k]) => k).sort()
    const nullOn = disputeEntries.filter(([, f]) => f.on == null).map(([k]) => k).sort()
    expect(nullOff).toEqual(["bugBountyDisputeInScope"])
    expect(nullOn).toEqual(["bugBountyDisputeOutOfScope"])
  })

  it("the asymmetry is stated, never softened: ON forms that price the lapse name the worker's loss", () => {
    // "Both sides lose half" shipped twice and was false both times (the
    // poster is credited the other half PLUS their premium). Any ON form that
    // mentions the 50/50 must not describe it as symmetric loss.
    const SYMMETRIC_LOSS = /\bboth (sides|of you|parties)\b[^.;!?]{0,40}\blos/i
    for (const [key, text] of overlayEntries) {
      expect(SYMMETRIC_LOSS.test(text), `overlay ${key} frames the split as symmetric loss`).toBe(false)
    }
    for (const [key, forms] of disputeEntries) {
      for (const era of ["off", "on"] as const) {
        const text = forms[era]
        if (text == null) continue
        expect(SYMMETRIC_LOSS.test(text), `${key}.${era} frames the split as symmetric loss`).toBe(false)
      }
    }
  })
})

describe("dispute-era selection — the accessors follow the flag both ways", () => {
  it("flag unset (this run): era is off, overlay NOT applied, off forms served", () => {
    expect(process.env.NEXT_PUBLIC_FEATURE_DISPUTES).toBeUndefined()
    expect(disputeEra()).toBe("off")
    expect(disputeCopy("disputesPageStatus")).toBe("DORMANT")
    // The overlaid key serves its stored (off) pull string…
    expect(settlementCopy("disputesResolutionMechanism")).toContain("stays dormant")
    // …and a non-overlaid key is untouched by the machinery.
    expect(settlementCopy("landingHeroBody")).toBe(SETTLEMENT_COPY.landingHeroBody.pull)
  })

  it("flag=true: era is on, overlay applied, on forms served (fresh module import)", async () => {
    vi.resetModules()
    vi.stubEnv("NEXT_PUBLIC_FEATURE_DISPUTES", "true")
    try {
      const fresh = await import("@/lib/settlement-copy")
      expect(fresh.disputeEra()).toBe("on")
      expect(fresh.disputeCopy("disputesPageStatus")).toBe("LIVE")
      expect(fresh.settlementCopy("disputesResolutionMechanism")).toBe(
        DISPUTE_ON_OVERLAY.disputesResolutionMechanism,
      )
      expect(fresh.settlementCopy("landingHeroBody")).toBe(SETTLEMENT_COPY.landingHeroBody.pull)
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})
