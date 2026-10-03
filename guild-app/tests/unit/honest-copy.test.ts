import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  BANNED,
  PULL_BANNED,
  CLIENT_RENDERED,
  COLD_ROUTES,
  DETAIL_COMPONENTS,
  DETAIL_ROUTES,
  DYNAMIC_ROUTES,
  OPERATOR_ROUTES,
  OPTIONAL_ROUTES,
  REDIRECT_ROUTES,
  fileFor,
  violation,
  visibleText,
} from "../../scripts/honest-copy.mjs";
import { LIB_RS_PATH } from "../../scripts/gen-instantiate-manifest.mjs";

/**
 * scripts/honest-copy.mjs is a DEPLOY GATE — launch-check.sh CHECK 4 imports it
 * and a red result is what stops `pm2 restart`. It is also the e2e spec's rule
 * table. So it gets tested like a gate, not like a helper.
 *
 * The specific thing being defended against: this module's whole reason to exist
 * is that the two gates previously drifted while a comment claimed they were in
 * sync. A matcher that quietly stops matching is the same failure with fewer
 * witnesses. Every rule below is proven to fire AND proven to stay quiet on
 * copy that must remain legal.
 */

// Resolve a rule by the NAME at the head of its label (everything before the
// " — " that separates name from rationale), matched EXACTLY.
//
// ⚠️ This was `b.label.includes(needle)` until 2026-09-02, and substring
// matching made a whole class of mutation unfalsifiable. Renaming a rule to
// `delivery-pays-DISABLED` — the obvious way to check "is this rule still
// wired?" — left every `ruleFor("delivery-pays")` lookup resolving to the
// renamed rule, so the suite stayed green over a rule that had been pointedly
// disabled. A lookup that cannot tell a rule from a rule-shaped near-miss is
// the same defect the rules themselves exist to catch, one level up.
//
// Exact-matching also makes ambiguity loud instead of silent: `includes` would
// quietly return the FIRST of two rules sharing a prefix, so adding a
// `fee-cap-v2` beside `fee-cap` would have silently repointed the fee-cap
// tests at whichever came first in the array.
const ruleFor = (name: string) => {
  const head = (label: string) => label.split(" — ")[0].replace(/^"|"$/g, "");
  const matches = BANNED.filter((b: { label: string }) => head(b.label) === name);
  if (matches.length === 0) {
    throw new Error(
      `no BANNED rule named "${name}" — the rule table changed, or the rule was ` +
        `renamed/removed. Rule names present: ${BANNED.map((b: { label: string }) => head(b.label)).join(", ")}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(`"${name}" matches ${matches.length} BANNED rules — names must be unique`);
  }
  return matches[0];
};

describe("visibleText", () => {
  it("drops script/style content so the RSC payload cannot double-report", () => {
    const html = `<body><script>var x = "trustless";</script><p>honest</p></body>`;
    const text = visibleText(html);
    expect(text).not.toContain("trustless");
    expect(text).toContain("honest");
  });

  it("keeps <head> metadata — an overclaim once lived in a description", () => {
    const html = `<head><title>Guild</title><meta name="description" content="fully trustless escrow"></head><body>ok</body>`;
    expect(visibleText(html)).toContain("fully trustless escrow");
  });

  it("decodes entities, so escaped prose is still matchable", () => {
    // Next escapes apostrophes and ampersands in rendered copy; a rule written
    // against readable prose must still see it.
    expect(visibleText("<p>Post &amp; fund &mdash; it&#x27;s one step</p>")).toBe(
      "Post & fund — it's one step",
    );
  });

  it("reads user-facing ATTRIBUTE copy — alt, aria-label, placeholder, title", () => {
    // A claim in an aria-label is read aloud to the user least able to verify
    // it. Tag-stripping alone would drop every one of these silently.
    for (const attr of ["alt", "aria-label", "placeholder", "title"]) {
      const text = visibleText(`<img ${attr}="a trustless marketplace">`);
      expect(text, `${attr} must be scanned`).toContain("trustless");
    }
  });

  it("does NOT scan framework attributes, which are not copy", () => {
    // class/href/data-* would drag in minified class names and payloads.
    const text = visibleText(`<div class="trustless-grid" data-x="trustless" href="/trustless">hi</div>`);
    expect(text).not.toContain("trustless");
  });

  it("skips a data-honest-copy=\"quote\" region, and COUNTS it", async () => {
    // The disavowal case: a page naming a false claim in order to reject it.
    const hc = await import("../../scripts/honest-copy.mjs");
    const html = `<p>We never say <span data-honest-copy="quote">"trustless payout"</span> here.</p>`;
    const text = hc.visibleText(html);
    expect(text).not.toContain("trustless");
    // Never silent: launch-check prints this on every run, so a skipped region
    // cannot masquerade as "nothing to skip".
    expect(hc.lastQuotedRegions).toBe(1);
  });

  it("resets the skipped-region count per call, so it cannot accumulate", async () => {
    const hc = await import("../../scripts/honest-copy.mjs");
    hc.visibleText(`<span data-honest-copy="quote">trustless</span>`);
    expect(hc.lastQuotedRegions).toBe(1);
    hc.visibleText(`<p>clean page</p>`);
    expect(hc.lastQuotedRegions).toBe(0);
  });

  it("exempts ONLY inside the marked element, not the rest of the page", async () => {
    // The abuse case that matters: a real overclaim outside the region must
    // still be caught even when a quote region exists on the same page.
    const hc = await import("../../scripts/honest-copy.mjs");
    const html = `<span data-honest-copy="quote">"trustless payout"</span><p>Our escrow is trustless.</p>`;
    const text = hc.visibleText(html);
    expect(hc.lastQuotedRegions).toBe(1);
    expect(violation(text, ruleFor("trustless"))).toBe("trustless");
  });

  it("strips tags without welding adjacent words together", () => {
    // "<b>trust</b><b>less</b>" must not become the banned word "trustless".
    expect(visibleText("<p><b>trust</b><b>less</b></p>")).toBe("trust less");
  });
});

describe("the audit-kit citation ruling (2026-09-02)", () => {
  // P3-4 ruled NOT externally citable. These two rules encode that, and they
  // were added BEFORE any copy made the claim — so unlike most of this table,
  // they were never retrofitted onto a page that had already shipped it.
  //
  // The number the ban rests on: the static tier caught 0 OF 4 independently
  // known defects in the same source it scanned. "0 critical" from an
  // instrument with measured-zero sensitivity here is evidence about the tool,
  // not about the code.

  it("bans the completed claim — 'audited'", () => {
    const rule = ruleFor("audited");
    expect(violation("the escrow has been audited", rule)).toBe("audited");
    expect(violation("independently audited by a third party", rule)).toBe("audited");
  });

  it("still allows honest FUTURE tense — the distinction the ruling turns on", () => {
    // Live copy on /trust says a formal audit is planned. Banning the plan
    // rather than the claim would push the page toward saying nothing, which is
    // not what honest copy means.
    const rule = ruleFor("audited");
    expect(violation("a formal audit is planned", rule)).toBeNull();
    expect(violation("Source audit: opens at launch (Wave C)", rule)).toBeNull();
    expect(violation("read the auditor guide", rule)).toBeNull();
    expect(violation("auditors can reproduce the build", rule)).toBeNull();
  });

  it("bans the clean-bill headline in every phrasing it would actually be written in", () => {
    const rule = ruleFor("0 critical");
    expect(violation("0 critical findings", rule)).toBeTruthy();
    expect(violation("zero critical issues", rule)).toBeTruthy();
    expect(violation("no critical vulnerabilities", rule)).toBeTruthy();
    expect(violation("0 high-severity findings", rule)).toBeTruthy();
    // The trap this guards: a writer who cannot say "0 critical" reaching for a
    // synonym rather than reaching for the truth.
  });

  it("does not fire on unrelated prose containing the words apart", () => {
    const rule = ruleFor("0 critical");
    expect(violation("critical path scheduling", rule)).toBeNull();
    expect(violation("no high fees", rule)).toBeNull();
  });
});

describe("violation", () => {
  it("returns the offending substring, not just a boolean", () => {
    const hit = violation("this is a trustless marketplace", ruleFor("trustless"));
    expect(hit).toBe("trustless");
  });

  it("returns null on clean copy", () => {
    expect(violation("settlement is manifest-routed", ruleFor("trustless"))).toBeNull();
  });

  it("exempts an allowed phrase that OVERLAPS the hit", () => {
    // "trustee-verified identity" is a real >$50k offering and lives on three
    // live pages today. It must not redden the deploy.
    const rule = ruleFor("verified dev/agent");
    expect(violation("trustee-verified developer identity", rule)).toBeNull();
  });

  it("does NOT let an allowed phrase elsewhere launder a real overclaim", () => {
    // The regression that an allow-list implemented as "does the page contain
    // the exempt phrase anywhere" would introduce.
    const rule = ruleFor("verified dev/agent");
    const text = "We offer trustee-verified identity. Hire a verified developer today.";
    expect(violation(text, rule)).toBe("verified developer");
  });

  it("keeps scanning past an exempt hit to find a later real one", () => {
    const rule = ruleFor("verified dev/agent");
    const text = "trustee-verified dev is fine. But a verified agent is not.";
    expect(violation(text, rule)).toBe("verified agent");
  });

  it("does not mutate rule regex state between calls (lastIndex leak)", () => {
    const rule = ruleFor("trustless");
    const text = "trustless";
    expect(violation(text, rule)).toBe("trustless");
    expect(violation(text, rule)).toBe("trustless");
  });
});

describe("the rule table fires on the exact copy that shipped", () => {
  it("catches posting-is-funding", () => {
    const rule = ruleFor("posting-is-funding");
    expect(
      violation("There is no separate fund step: a task is never claimable unless funded.", rule),
    ).toBeTruthy();
    expect(violation("Post the task, then fund it in a second signature.", rule)).toBeNull();
  });

  it("catches per-task disputability", () => {
    const rule = ruleFor("per-task disputability");
    expect(violation("the guild posts no disputable tasks", rule)).toBeTruthy();
    expect(violation("Tasks are chosen to be non-disputable.", rule)).toBeTruthy();
    expect(
      violation("Every funded task that reaches Submitted can be disputed by either party.", rule),
    ).toBeNull();
  });

  it("lets the correct DENIAL through while still catching the claim", () => {
    // Verbatim from /how-it-works:160 (that copy now lives on /guide after
    // the 2026-08-14 merge). Stating the true fact necessarily uses the
    // same word as the falsehood; without this the gate reddens on honest copy
    // and the only way to ship becomes deleting an accurate sentence.
    const rule = ruleFor("per-task disputability");
    expect(
      violation("None of that second half is live, and no task today can be posted as non-disputable.", rule),
    ).toBeNull();
    expect(violation("Every task we post is non-disputable.", rule)).toBe("non-disputable");
  });

  it("catches the sybil claim — pinned to the VERBATIM string that shipped", () => {
    const rule = ruleFor("sybil defence");
    // Was src/app/how-it-works/page.tsx:46 (the fixed copy now lives on
    // /guide after the 2026-08-14 merge), live copy on a gated cold route, and
    // the ONE instance that survived both #289 and #290. Pinned verbatim: this
    // exact sentence is what the rule was written to stop.
    expect(
      violation(
        "The Guild Member badge is a separate thing: a public mint that stops sybils, not a review or a rating.",
        rule,
      ),
    ).toBe("stops sybils");
    // The other phrasings the same claim has worn in this repo.
    expect(violation("the badge is a sybil gate, not KYC", rule)).toBe("sybil gate");
    expect(violation("an anti-sybil credential", rule)).toBe("anti-sybil");
    expect(violation("badge scarcity is the sybil gate", rule)).toBe("badge scarcity");
    // The replacement copy has to stay legal, or the fix cannot ship.
    expect(
      violation(
        "a public mint anyone can call for the network fee — it records membership, not identity",
        rule,
      ),
    ).toBeNull();
  });

  it("catches CV2 misattribution — pinned to the VERBATIM string that shipped", () => {
    const rule = ruleFor("CV2 attribution");
    // src/app/.../page.tsx:167 as submitted in PR #265. The first cut of this
    // rule required "third-party" and "Foundation" to be adjacent and so could
    // not fire on this sentence at all.
    expect(
      violation("CV2 is a third-party Radix Foundation Consultation-v2 component.", rule),
    ).toBe("third-party Radix Foundation");
    expect(violation("CV2 is a third-party Foundation component.", rule)).toBeTruthy();
    // The honest phrasing must stay legal, or the fix cannot ship.
    expect(
      violation("CV2 is our own fork of the Foundation's consultation_v2 blueprint.", rule),
    ).toBeNull();
  });
});

describe("the journey-widget rules fire on what shipped and clear what replaced it", () => {
  // Added with the /docs journey-widget rewrite. Each rule is proven in BOTH
  // directions against verbatim strings: the one that was live on /docs, and the
  // one that replaced it. A rule that only fires proves nothing about whether
  // the corrected copy can still ship.

  it("badge-per-vote fires on both places the claim shipped", () => {
    const rule = ruleFor("badge-per-vote");
    // /docs VOTING_GUIDE and the widget's Governance tab, verbatim.
    expect(violation("1 badge = 1 vote", rule)).toBeTruthy();
    expect(violation("Free — no transaction fees 1 badge = 1 vote", rule)).toBeTruthy();
    // Variants a rewrite could reach for.
    expect(violation("One badge, one vote", rule)).toBeTruthy();
    expect(violation("badge-weighted voting", rule)).toBeTruthy();
  });

  it("badge-per-vote leaves the corrected copy legal", () => {
    const rule = ruleFor("badge-per-vote");
    expect(violation("A Guild badge is required to vote, and each Telegram account gets one vote", rule)).toBeFalsy();
    expect(violation("One vote per Telegram account", rule)).toBeFalsy();
    expect(violation("A Guild badge is required to vote", rule)).toBeFalsy();
  });

  it("badge-as-identity fires on the shipped Quick Start line", () => {
    const rule = ruleFor("badge-as-identity");
    expect(violation("Free on-chain NFT badge — your identity, vote, and XP tracker.", rule)).toBeTruthy();
  });

  it("badge-as-identity leaves the corrected copy — and /check-badge — legal", () => {
    const rule = ruleFor("badge-as-identity");
    expect(violation("It records Guild membership, not identity: anyone can mint one and one person can hold several.", rule)).toBeFalsy();
    expect(violation("It records membership, not identity — it does not check who you are, and one person can hold several", rule)).toBeFalsy();
  });

  it("badge-tracks-xp fires on the shipped Quick Start line", () => {
    const rule = ruleFor("badge-tracks-xp");
    expect(violation("Free on-chain NFT badge — your identity, vote, and XP tracker.", rule)).toBeTruthy();
    expect(violation("your XP is tracked on-chain", rule)).toBeTruthy();
  });

  it("badge-tracks-xp leaves the corrected copy legal", () => {
    const rule = ruleFor("badge-tracks-xp");
    expect(violation("XP accrues in the Guild database from votes, bounties and proposals. It is not written to the badge NFT.", rule)).toBeFalsy();
    expect(violation("the XP field on the badge itself has never been written", rule)).toBeFalsy();
    expect(violation("Your XP lives in the Guild database.", rule)).toBeFalsy();
  });
});

describe("the governance-era claim family fires on what shipped and clears what replaced it", () => {
  // Six rules added 2026-08-16 for the lineage that lived in
  // components/guides/guides.ts (and, it turned out, on /docs, /mint and /gift).
  // Every rule is proven in BOTH directions against VERBATIM strings: the ones
  // that were live, and the honest sentences that already ship and must stay
  // legal — a rule that reddens /guide's "Posters can require a minimum trust
  // tier" would make the correction unshippable.

  it("tier-gating fires on the tour, /docs and their variants", () => {
    const rule = ruleFor("tier-gating");
    // guides.ts L42/L43/L64, verbatim.
    expect(violation("Each card shows reward in XRD, required tier, and deadline.", rule)).toBe("required tier");
    expect(violation("Set reward, XP bonus, required tier, and deadline.", rule)).toBe("required tier");
    expect(violation("Higher tiers unlock higher-reward tasks and increase vote weight.", rule)).toBeTruthy();
    // /docs QUICK_START step 6, verbatim — a COLD route that carried this ungated.
    expect(violation("Voting and completing tasks earn XP. Level up your badge tier to unlock higher-reward work.", rule)).toBeTruthy();
    // Rewordings the family could reach for.
    expect(violation("Reach Builder tier to unlock premium bounties", rule)).toBeTruthy();
    expect(violation("this task is tier-locked", rule)).toBe("tier-locked");
  });

  it("tier-gating leaves the true tier sentences legal", () => {
    const rule = ruleFor("tier-gating");
    // /guide FLOW step 6 — the trust-tier gate IS enforced (by the app).
    expect(violation("Posters can require a minimum trust tier to claim; that gate is enforced by this app, not by the contract.", rule)).toBeNull();
    // /check-badge — the denials.
    expect(violation("Claiming is not tier-gated. Claiming a task needs a badge and a bond.", rule)).toBeNull();
    expect(violation("claiming is badge-gated, not tier-gated.", rule)).toBeNull();
    // / (home) — the BADGE does unlock claiming; the rule is about tiers.
    expect(violation("Your on-chain badge unlocks voting, task claiming, and XP rewards.", rule)).toBeNull();
    // /tasks/create term label, and the replacement /docs copy.
    expect(violation("Min trust to claim", rule)).toBeNull();
    expect(violation("Your badge tier is a public progression marker on your profile — it does not gate which tasks you can claim.", rule)).toBeNull();
    // /guide heading followed (after tag-stripping) by the tier grid.
    expect(violation("Level Up Your Badge Member 0 XP Contributor 100 XP Builder 500 XP", rule)).toBeNull();
  });

  it("weighted-voting fires on the tour and /mint", () => {
    const rule = ruleFor("weighted-voting");
    // guides.ts L50, L54, L64 and /mint:231, near-verbatim (2026-09-07: "charter" dropped from the first).
    expect(violation("Shape the Guild. Vote on proposals, parameters, treasury. Reputation-weighted — your tier matters.", rule)).toBe("Reputation-weighted");
    expect(violation("Your vote weight is proportional to reputation tier.", rule)).toBe("vote weight is proportional");
    expect(violation("Higher tiers unlock higher-reward tasks and increase vote weight.", rule)).toBe("increase vote weight");
    expect(violation("Participating earns XP. XP determines your tier and voting weight.", rule)).toBe("determines your tier and voting weight");
    expect(violation("votes are weighted by reputation", rule)).toBe("weighted by reputation");
  });

  it("weighted-voting leaves the honest equal-vote copy — and CV2's real weighting — legal", () => {
    const rule = ruleFor("weighted-voting");
    // /guide, /docs FAQ — verbatim.
    expect(violation("Every badge counts the same — no tier weighting exists or is planned — and CV2's own weighting is XRD-based.", rule)).toBeNull();
    expect(violation("Do higher badge tiers give more voting weight?", rule)).toBeNull();
    expect(violation("CV2 records formal, non-binding temperature checks on the Radix ledger, weighted by XRD holdings.", rule)).toBeNull();
    // The replacement copy on /mint and in the tour.
    expect(violation("XP determines your tier; votes are one per Telegram account, and XP and tier do not weight them.", rule)).toBeNull();
    expect(violation("no token, no tier weighting, and it cannot move escrowed funds", rule)).toBeNull();
  });

  it("dispute-raiser-wins fires on all four sites that shipped it", () => {
    const rule = ruleFor("dispute-raiser-wins");
    // escrow-actions.tsx — the caption, the confirmation dialog, the FinalizeDisputeButton
    // description, and the button label itself, all verbatim as they shipped.
    expect(violation("If left unresolved it auto-resolves after the 72h window in favour of whoever raised it.", rule)).toBe("in favour of whoever rais");
    expect(violation("After the 72h window, the party who raised the dispute automatically wins the full reward + insurance when the dispute is finalized.", rule)).toBe("the party who raised the dispute automatically wins");
    expect(violation("Settles the dispute with the contract's default ruling: whoever raised it receives the reward + insurance.", rule)).toBe("whoever raised it receives");
    expect(violation("Raise dispute in my favour", rule)).toBe("Raise dispute in my favour");
  });

  it("dispute-raiser-wins leaves the DENIALS and the replacement copy legal", () => {
    const rule = ruleFor("dispute-raiser-wins");
    // No negation heuristic exists (the module header forbids one), so these
    // are load-bearing: each is a TRUE sentence that shares the rule's words.
    expect(violation("raising a dispute does not win it", rule)).toBeNull();
    expect(violation("Raising a dispute does not win it — it costs the worker half the reward and the poster the other half.", rule)).toBeNull();
    expect(violation("who raised it makes no difference to the money", rule)).toBeNull();
    expect(violation("Who raised it makes no difference: the reward splits 50/50 and the insurance returns to the poster.", rule)).toBeNull();
    expect(violation("Dispute raised by the worker.", rule)).toBeNull();
    expect(violation("Raising it wins you nothing.", rule)).toBeNull();
    // The ARBITER path is a different method and a different outcome; nothing
    // here should stop us describing it accurately if it is ever reachable.
    expect(violation("An arbiter-ruled resolve_dispute applies one ruling to both the reward and the insurance.", rule)).toBeNull();
  });

  it("dispute-insurance-splits fires on the three sites that shipped it", () => {
    const rule = ruleFor("dispute-insurance-splits");
    // escrow-truth.tsx (the half-right FIX) and /money, twice, verbatim.
    expect(violation("the escrow splits the reward + insurance evenly between both parties after the 72h window", rule)).toBe("splits the reward + insurance");
    expect(violation("the live component's default ruling is an even split of the reward AND the insurance", rule)).toBe("even split of the reward AND the insurance");
    expect(violation("governed by the live component's default ruling, an even split — of the reward and the insurance", rule)).toBe("even split — of the reward and the insurance");
  });

  it("dispute-insurance-splits leaves the true SplitEvenly copy alone", () => {
    const rule = ruleFor("dispute-insurance-splits");
    // The default IS SplitEvenly and it IS a 50/50 — of the reward. Saying so
    // must stay legal, or the rule would ban the correction it exists to force.
    expect(violation("The default ruling is SplitEvenly (a 50/50 split), re-verified against the live component via the Gateway.", rule)).toBeNull();
    expect(violation("After the 72h window, this settles the task with the component's configured default ruling — SplitEvenly (50/50) — and takes no arbiter fee.", rule)).toBeNull();
    expect(violation("the default ruling is a fixed 50/50 SplitEvenly with no arbiter fee", rule)).toBeNull();
    // The replacement copy on every site this PR touches.
    expect(violation("the escrow splits the reward evenly between both parties and returns the insurance whole to the poster", rule)).toBeNull();
    expect(violation("the reward splits 50/50 and the insurance returns to the poster", rule)).toBeNull();
    // Reward and insurance are legitimately named together elsewhere — funding,
    // custody, vault location — and none of that is a payout claim.
    expect(violation("Reward and insurance are locked together, atomically, in one signature", rule)).toBeNull();
    expect(violation("Reward and insurance sit in a Scrypto component on Radix mainnet today.", rule)).toBeNull();
    // ⚠️ The witness that made this rule tighter. A first draft matched
    // `insurance` within 30 chars of a split verb, and CHECK 4 fired on this
    // TRUE /guide sentence — a vNext2 feature LIST where "mutual split offers"
    // is a different feature that merely lands nearby. The window was doing the
    // work instead of the grammar.
    expect(violation("optional dispute insurance (\u201cno insurance, no dispute\u201d), mutual split offers, instant-settlement mode.", rule)).toBeNull();
    // And the tightening must not have cost the third-person form.
    expect(violation("the insurance splits 50/50 too", rule)).toBe("insurance splits");
  });

  it("governance-controlled fires on the tour and the /docs revenue card", () => {
    const rule = ruleFor("governance-controlled");
    // guides.ts L55 and /docs:606, verbatim.
    expect(violation("Quorum, fees, decay rates — all governance-controlled. No single admin can change them.", rule)).toBe("governance-controlled");
    expect(violation("No single admin can change them.", rule)).toBe("No single admin can");
    expect(violation("Any fee change goes through a published RFC first — the community controls the economics.", rule)).toBe("the community controls");
    expect(violation("parameters set by community vote", rule)).toBe("set by community vote");
  });

  it("governance-controlled leaves the honest custody and hand-over copy legal", () => {
    const rule = ruleFor("governance-controlled");
    // /about, /docs, settlement-copy — verbatim.
    expect(violation("Holds the admin badge (on-ledger); the aim is to hand it to the Radix DAO once the DAO is formed, with no date set.", rule)).toBeNull();
    expect(violation("No admin wallet can withdraw the reward or the insurance", rule)).toBeNull();
    expect(violation("bigdev holds the admin badge, and who holds it is on the ledger for anyone to check. The aim is to hand it to the Radix DAO once the DAO is formed; no date is set.", rule)).toBeNull();
    // Replacement copy.
    expect(violation("Any fee change is published as an RFC before the dial moves; the dial itself is held by the operator, not by a vote.", rule)).toBeNull();
    expect(violation("Community contributions stay pure.", rule)).toBeNull();
  });

  it("reputation-decay fires on the tour", () => {
    const rule = ruleFor("reputation-decay");
    // guides.ts L64 verbatim, and L55's parameter name.
    expect(violation("Higher tiers unlock higher-reward tasks and increase vote weight. Reputation decays with inactivity.", rule)).toBe("Reputation decays");
    expect(violation("your XP decays over time", rule)).toBe("XP decays");
    expect(violation("scores decay after inactivity", rule)).toBe("decay after inactivity");
  });

  it("reputation-decay leaves the corrected copy legal", () => {
    const rule = ruleFor("reputation-decay");
    expect(violation("XP is a score in the Guild database, credited when a task pays out; it does not decay.", rule)).toBeNull();
    expect(violation("Reputation is non-transferable by guild policy", rule)).toBeNull();
  });

  it("permanent-record fires on the tour", () => {
    const rule = ruleFor("permanent-record");
    // guides.ts L65 verbatim.
    expect(violation("Every task claimed, submitted, completed. Earnings in XRD. Permanent on-chain record.", rule)).toBe("Permanent on-chain record");
    expect(violation("an on-chain record of your tasks", rule)).toBe("on-chain record of your tasks");
    expect(violation("your task history is stored on-chain", rule)).toBeTruthy();
    expect(violation("XP history is immutable", rule)).toBeTruthy();
  });

  it("permanent-record leaves TRUE ledger permanence legal", () => {
    const rule = ruleFor("permanent-record");
    // /docs VOTING_GUIDE (CV2), /money, /guide — verbatim; all genuinely on-ledger.
    expect(violation("Recorded on the Radix ledger permanently", rule)).toBeNull();
    expect(violation("submission time is recorded on-chain but no timeout ever reads it", rule)).toBeNull();
    expect(violation("Work is submitted with its evidence committed on-chain.", rule)).toBeNull();
    // Replacement copy in the tour.
    expect(violation("The money legs (fund, claim, settle) are transactions on the Radix ledger under the escrow component; the history list itself is an app record, not an on-chain one.", rule)).toBeNull();
    expect(violation("Each is a signed transaction against the Badge Manager component (a small royalty per call), visible on the Radix dashboard like any other.", rule)).toBeNull();
  });

  it("fee-cap fires on every form the on-ledger 2.5% cap claim shipped in", () => {
    const rule = ruleFor("fee-cap");
    // /docs:603, /docs:606, /gift, settlement-copy docsFeesAnswer — verbatim.
    // (Two alternatives overlap on "fee capped on-ledger at 2.5%"; the earlier
    // one in source order wins the reported substring. Both are the claim.)
    expect(violation("Planned: a poster-side settlement fee capped on-ledger at 2.5%, dialed 0% (closed beta) → ~1% (public beta) → 2.5% only with real volume.", rule)).toMatch(/capped/);
    expect(violation("The 2.5% cap is planned to be fixed on-ledger at deployment.", rule)).toBe("2.5% cap");
    expect(violation("a poster-side settlement fee, capped on-ledger at 2.5%, dialed to 0% during beta", rule)).toMatch(/capped/);
    expect(violation("a poster-side settlement fee with an on-ledger cap of 2.5%", rule)).toBe("on-ledger cap");
    // Rewordings.
    expect(violation("the royalty is capped at 2.5%", rule)).toBe("royalty is capped at");
    expect(violation("posters pay a fee capped at 1%", rule)).toBe("fee capped at");
    expect(violation("settlement is capped at 2.5%", rule)).toBe("capped at 2.5%");
    expect(violation("an on-chain fee cap", rule)).toBe("on-chain fee cap");
    expect(violation("the fee is hard-capped by the contract", rule)).toBe("fee is hard-capped by");
  });

  it("fee-cap leaves the TRUE fee copy legal — 0% today, flat royalty, protocol max", () => {
    const rule = ruleFor("fee-cap");
    // Live sentences, verbatim.
    expect(violation("Zero today. The deployed escrow charges no platform fee — workers receive 100% of the reward", rule)).toBeNull();
    expect(violation("Workers pay 0%, forever.", rule)).toBeNull();
    expect(violation("the platform fee is 0% and fee revenue to date is $0", rule)).toBeNull();
    expect(violation("on-chain component royalties, and SaaS hosting fees", rule)).toBeNull();
    expect(violation("the Badge Manager blueprint supports per-method royalties (0.1–1 XRD).", rule)).toBeNull();
    expect(violation("Requires admin badge in connected wallet. Royalties apply.", rule)).toBeNull();
    // The corrected sentences this rule must let ship.
    expect(violation("a poster-side royalty charged when a task is funded — a flat XRD amount per funded post, not a percentage of the reward — starting at 0, movable only by the operator's royalty-admin badge, and bounded only by the network's per-call royalty maximum (about 166 XRD).", rule)).toBeNull();
    expect(violation("There is no percentage fee, and the contract enforces no percentage bound.", rule)).toBeNull();
  });

  it("every family rule is a distinct entry in BANNED (so interaction-copy and the gates run all six)", () => {
    const labels = BANNED.map((b: { label: string }) => b.label);
    for (const needle of ["tier-gating", "weighted-voting", "governance-controlled", "reputation-decay", "permanent-record", "fee-cap"]) {
      expect(labels.filter((l: string) => l.includes(needle)).length, needle).toBe(1);
    }
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("soulbound — the member badge is transferable and can never be made soulbound (added 2026-09-19)", () => {
  // Chain fact (docs/TRUST-BACKING-PLAN.md): withdrawer=AllowAll with
  // withdrawer_updater=DenyAll. "Non-transferable" shipped once (#296); this is
  // the same claim in the one word no rule matched.
  it("fires on the claim in every spelling", () => {
    const rule = ruleFor("soulbound");
    expect(violation("Mint your soulbound Guild badge.", rule)).toBe("soulbound");
    expect(violation("A Soul-Bound membership NFT", rule)).toBe("Soul-Bound");
    expect(violation("the badge is soul bound to your account", rule)).toBe("soul bound");
  });

  it("still fires when the negation comes AFTER the term — that is the claim, not a disavowal", () => {
    const rule = ruleFor("soulbound");
    expect(violation("Your badge is soulbound, not transferable.", rule)).toBe("soulbound");
  });

  it("still fires when a negation is too far back to govern the term", () => {
    const rule = ruleFor("soulbound");
    expect(
      violation("You do not need an invite. Every member holds one badge, and that badge is soulbound.", rule),
    ).toBe("soulbound");
  });

  it("leaves a disavowal legal", () => {
    const rule = ruleFor("soulbound");
    expect(violation("The badge is transferable — it is not soulbound.", rule)).toBeNull();
    expect(violation("It is transferable and can never be made soulbound.", rule)).toBeNull();
    expect(violation("The badge isn’t soulbound; anyone can send it on.", rule)).toBeNull();
    expect(violation("A soulbound badge would need a new resource and a holder migration.", rule)).toBeNull();
  });

  it("one page carrying both a disavowal and the claim still fails on the claim", () => {
    const rule = ruleFor("soulbound");
    expect(violation("The badge is not soulbound. Later: mint your soulbound badge today.", rule)).toBe("soulbound");
  });

  it("does not fire on copy that never uses the word", () => {
    const rule = ruleFor("soulbound");
    expect(violation("Reputation is non-transferable by guild policy", rule)).toBeNull();
    expect(violation("The badge records membership and is transferable.", rule)).toBeNull();
  });
});

describe("the self-claim guard family — overclaiming the worker!=poster assert (added 2026-09-02)", () => {
  // /lifecycle told cold readers "You cannot claim your own task; self-claim
  // is asserted away on-chain." The assert is real (worker != task.poster,
  // proven by test_self_claim_rejects), but lib.rs's own comment on it says
  // the framing is false: `poster` is a FREE PARAMETER of create_task, and
  // this assert is the ONLY place it is ever read, so a decoy poster address
  // disables the gate for the cost of gas. "Asserted away" reads as
  // bypass-proof, which it is not.
  it("fires on the shipped /lifecycle sentence", () => {
    const rule = ruleFor("self-claim-absolute");
    expect(
      violation("You cannot claim your own task; self-claim is asserted away on-chain.", rule),
    ).toBe("self-claim is asserted away");
  });

  it("fires on the claim family's other overclaim shapes", () => {
    const rule = ruleFor("self-claim-absolute");
    expect(violation("Self-dealing is fully prevented on-chain.", rule)).toBeTruthy();
    expect(violation("This assert blocks self-dealing.", rule)).toBeTruthy();
    expect(violation("Self-claiming cannot be bypassed.", rule)).toBeTruthy();
  });

  it("leaves the fixed /lifecycle copy and /auditor-guide's honest form legal", () => {
    const rule = ruleFor("self-claim-absolute");
    // The exact replacement this PR ships on /lifecycle.
    expect(
      violation(
        "The contract also asserts worker != poster on claim — an honest-mistake guard, not a self-dealing defence: poster is a caller-supplied parameter of create_task, so a decoy poster address bypasses it for the cost of gas.",
        rule,
      ),
    ).toBeNull();
    // /auditor-guide's existing, already-correct sentence (src/app/auditor-
    // guide/page.tsx:19) — this rule must never redden the page it was
    // written to match. No `allow` entry needed: this is a DENIAL that uses
    // "bypasses," not any of the banned overclaim verbs, unlike the
    // sybil-defence rule where the honest denial reuses the banned noun phrase
    // verbatim.
    expect(
      violation(
        "asserts worker != poster — an honest-mistake guard, not a self-dealing defence: poster is a caller-supplied parameter of create_task, so a decoy poster address bypasses it for the cost of gas",
        rule,
      ),
    ).toBeNull();
    // The bare, true fact must also stay legal.
    expect(violation("The contract asserts worker != poster on claim.", rule)).toBeNull();
  });
});

describe("the delivery-pays family — delivering has never paid anyone (added 2026-09-02)", () => {
  // FOUR shipped strings coordinated a delivery verb straight to payment.
  // Approval is what credits; under pull a separately signed withdrawal is
  // what collects. Nothing in the deployed component pays on delivery, and
  // Wave B's review window does not change that — its auto-release credits an
  // entitlement that still needs a withdrawal.
  const SHIPPED = [
    "browse funded tasks, claim one, submit the deliverable, and get paid from on-chain escrow",
    "a badge-holding dev or agent claims it, ships, and is paid from on-chain escrow in XRD.",
    "a badge-holding worker claims it, delivers, and gets paid from the escrow vault.",
    // The fourth is why a `grep "paid from"` sweep is not enough: it says
    // paid THROUGH, and a narrower grep reported the tree clean while this
    // line was live on a cold route.
    "claim, submit and get paid through the same escrow (proven end-to-end on mainnet)",
  ];

  it.each(SHIPPED)("fires on the shipped sentence: %s", (text) => {
    expect(violation(text, ruleFor("delivery-pays"))).toBeTruthy();
  });

  const FIXED = [
    "claim one, submit the deliverable, and collect their reward from on-chain escrow",
    "claims it, ships, and collects their reward from on-chain escrow in XRD.",
    "claims it, delivers, and is credited their reward from the escrow vault once the poster approves",
    "claim, submit, and collect their reward from the same escrow once the poster approves it (proven end-to-end on mainnet)",
    // A correct two-step sentence still says "paid from escrow" — the rule
    // must not ban the words, only the delivery->payment coordination.
    "You submit the work; once the poster approves, the contract credits you, and you are paid from escrow when you withdraw.",
  ];

  it.each(FIXED)("stays quiet on the honest form: %s", (text) => {
    expect(violation(text, ruleFor("delivery-pays"))).toBeNull();
  });

  it("leaves both pinned auto-release witnesses alone", () => {
    // These two are the regression set that matters: an earlier rule in this
    // family reddened the vNext2 feature name, and a rule that reddens honest
    // copy gets disabled within a week.
    const rule = ruleFor("delivery-pays");
    expect(
      violation(
        "there is no auto-release. Once you submit, the only route to the money in the deployed component is the poster approving it.",
        rule,
      ),
    ).toBeNull();
    expect(
      violation("Review-window auto-release (silence pays the worker) \u00b7 optional", rule),
    ).toBeNull();
  });
});

describe("unbacked-reward-total — a reward figure nobody holds (added 2026-09-16)", () => {
  // MUTATIONS, each applied to scripts/honest-copy.mjs and verified red here:
  //  (a) delete the rule → ruleFor throws;
  //  (b) drop the `(?:in|of|worth\s+of)\s+(?:total\s+)?(?:rewards|bounties|prizes)`
  //      branch → the shipped catalogue strings go quiet;
  //  (c) let a bare "reward pool" fire with no figure (replace the
  //      `pool\s+of\s+…figure` branch with `pool\b`) → the /bug-bounty sentence
  //      below fires;
  //  (d) make the leading figure optional → "1,530 XRD paid in rewards to
  //      date" fires on its bare "in rewards".

  it("fires on the catalogue segment every project description shipped — verbatim", () => {
    const rule = ruleFor("unbacked-reward-total");
    // From tests/unit/project-summary.test.ts's live fixtures (fetched
    // 2026-09-15) and the PATCH route's own comment for P5.
    expect(violation("— Catalogue: 27 tasks · 22,000 XRD in rewards (docs/guild-task-board.json, project P1). — Done when:", rule)).toBe("22,000 XRD in rewards");
    expect(violation("— Catalogue: 20 tasks · 67,100 XRD in rewards (docs/guild-task-board.json, project P4).", rule)).toBe("67,100 XRD in rewards");
    expect(violation("Catalogue: 9 tasks · 8,000 XRD in rewards", rule)).toBe("8,000 XRD in rewards");
    expect(violation("— Catalogue: 12 tasks · 23,100 XRD in rewards (docs/guild-task-board.json, project P6).", rule)).toBe("23,100 XRD in rewards");
    // P7 also names a real acceptance term, "(5,000 XRD, or a specific NFT" —
    // the hit must be the catalogue total, not the swap price before it.
    expect(violation("fixed digital acceptance terms (5,000 XRD, or a specific NFT, or any-of a list) … — Catalogue: 7 tasks · 5,500 XRD in rewards (docs/guild-task-board.json, project P7).", rule)).toBe("5,500 XRD in rewards");
  });

  it("fires on the same claim reworded", () => {
    const rule = ruleFor("unbacked-reward-total");
    expect(violation("196,700 XRD in total rewards across seven projects", rule)).toBe("196,700 XRD in total rewards");
    expect(violation("over $500 in rewards this month", rule)).toBe("$500 in rewards");
    expect(violation("5k XRD in bounties", rule)).toBe("5k XRD in bounties");
    expect(violation("a 10,000 XRD reward pool", rule)).toBe("10,000 XRD reward pool");
    expect(violation("backed by a bounty pool of 5,000 XRD", rule)).toBe("bounty pool of 5,000 XRD");
    expect(violation("bounties worth over 1,000 XRD", rule)).toBe("bounties worth over 1,000 XRD");
    expect(violation("40,000 XRD in rewards available to agents", rule)).toMatch(/^40,000 XRD in rewards/);
    expect(violation("2,000 XRD worth of prizes", rule)).toBe("2,000 XRD worth of prizes");
  });

  it("leaves backed figures and figureless pools legal", () => {
    const rule = ruleFor("unbacked-reward-total");
    // The starter tasks' own descriptions (board 99/100), verbatim.
    expect(violation("765 XRD is worth well under a dollar at today's rate. This is not compensation", rule)).toBeNull();
    // One funded task's reward, and what happened to money that exists.
    expect(violation("Reward: 765 XRD", rule)).toBeNull();
    expect(violation("posted with a 765 XRD reward", rule)).toBeNull();
    expect(violation("8,500 XRD reward + 425 insurance", rule)).toBeNull();
    expect(violation("12.5 XRD paid", rule)).toBeNull();
    expect(violation("1,530 XRD paid in rewards to date", rule)).toBeNull();
    expect(violation("0 XRD escrowed", rule)).toBeNull();
    expect(violation("the whole estate is about 41,361 XRD", rule)).toBeNull();
    // /bug-bounty's metadata, verbatim — a pool named without a figure.
    expect(violation("Reports earn public credit and a recorded claim on a community-funded reward pool. No prices are quoted, because none can yet be honoured.", rule)).toBeNull();
    // Other live sentences carrying an XRD figure.
    expect(violation("Not enough XRD in this account to cover this transaction. Add some XRD and try again.", rule)).toBeNull();
    expect(violation("the Badge Manager blueprint supports per-method royalties (0.1–1 XRD).", rule)).toBeNull();
  });
});

describe("the affiliation family — EXTERNAL-V1-FRAMEWORK §7.0's CANNOT list, as rules (added 2026-09-19)", () => {
  // Until this family existed, "backed by the Radix Foundation" passed every
  // rule in the table and §7.0 said so: "this list IS the gate, and it must be
  // read by a human."
  it("affiliation-backed fires on the claim the framework names, and its siblings", () => {
    const rule = ruleFor("affiliation-backed");
    expect(violation("Radix Guild is backed by the Radix Foundation.", rule)).toBe("backed by the Radix Foundation");
    expect(violation("Endorsed by RDX Works", rule)).toBe("Endorsed by RDX Works");
    expect(violation("a marketplace sponsored by the DAO", rule)).toBe("sponsored by the DAO");
    expect(violation("funded by the Radix DAO treasury", rule)).toBe("funded by the Radix DAO");
    expect(violation("recognised by Radix", rule)).toBe("recognised by Radix");
  });

  it("affiliation-backed leaves the disavowal and the true third-party sentences legal", () => {
    const rule = ruleFor("affiliation-backed");
    expect(violation("Independent and self-funded — not backed by the Radix Foundation or anyone else.", rule)).toBeNull();
    expect(violation("The Guild is neither endorsed nor sponsored by the Radix DAO.", rule)).toBeNull();
    // /docs verbatim shape: the Foundation wrote a blueprint; that is not backing.
    expect(violation("Our own deployment of the Radix Foundation's consultation_v2 blueprint.", rule)).toBeNull();
    expect(violation("Gifts are backed by nothing but bigdev's word.", rule)).toBeNull();
  });

  it("affiliation-backed: a disavowal elsewhere on the page does not launder the claim", () => {
    const rule = ruleFor("affiliation-backed");
    expect(
      violation("We are not backed by any VC. Later on the page: proudly backed by the Radix Foundation.", rule),
    ).toBe("backed by the Radix Foundation");
  });

  it("affiliation-partner fires on partnership and affiliation claims, not on their denial", () => {
    const rule = ruleFor("affiliation-partner");
    expect(violation("In partnership with the Radix Foundation", rule)).toBe("In partnership with the Radix Foundation");
    expect(violation("We partnered with RDX Works to launch", rule)).toBe("partnered with RDX Works");
    expect(violation("affiliated with the Radix DAO", rule)).toBe("affiliated with the Radix DAO");
    expect(violation("The Guild is not affiliated with the Radix Foundation.", rule)).toBeNull();
    expect(violation("No partnership with RDX Works exists.", rule)).toBeNull();
    // A third-party price API path and a wallet partner are not Radix bodies.
    expect(violation("Prices from our data partner Astrolescent.", rule)).toBeNull();
  });

  it("affiliation-official fires on the Guild calling itself official, and spares the wallet and the DAO venue", () => {
    const rule = ruleFor("affiliation-official");
    expect(violation("The official Radix guild for builders", rule)).toBe("The official Radix guild");
    expect(violation("the official marketplace of the ecosystem", rule)).toBe("the official marketplace");
    expect(violation("Radix Guild is officially recognised", rule)).toBe("officially recognised");
    expect(violation("The Guild is an official project", rule)).toBe("Guild is an official");
    // 2026-09-21: the product's own noun phrase walked through until a planted control caught it.
    expect(violation("This is the official Radix task marketplace.", rule)).toBe("the official Radix task marketplace");
    expect(violation("the official bounty board for Radix agents", rule)).toBe("the official bounty board");
    // Shipping today and TRUE — must stay legal (guide/page.tsx, ui-constants.ts).
    expect(violation("Download the official Radix Wallet and connect with one click.", rule)).toBeNull();
    expect(violation("The official mobile wallet. Free, and your keys stay on your phone.", rule)).toBeNull();
    expect(violation("Radix DAO — Official venue — governance framework at github.com/RadixDAO", rule)).toBeNull();
    expect(violation("This is not an official Radix guild; it is one builder's project.", rule)).toBeNull();
  });

  it("dao-ratified fires on ratification stated as fact or as imminent", () => {
    const rule = ruleFor("dao-ratified");
    expect(violation("The Radix DAO has ratified its framework.", rule)).toBeTruthy();
    expect(violation("a charter ratified by the DAO", rule)).toBe("ratified by the DAO");
    expect(violation("The framework is about to be ratified.", rule)).toBe("about to be ratified");
    expect(violation("Ratification is imminent", rule)).toBe("Ratification is imminent");
  });

  it("dao-ratified leaves the hope, the conditional and the honest status legal", () => {
    const rule = ruleFor("dao-ratified");
    expect(violation("The Radix DAO is working toward ratification.", rule)).toBeNull();
    expect(violation("Once the DAO ratifies a framework, we hope to contribute.", rule)).toBeNull();
    expect(violation("The DAO has not ratified anything yet, and no vote has a date.", rule)).toBeNull();
    // src/content/lights-on.ts verbatim — the live probe fired on this before the `allow` existed.
    expect(violation("The Radix DAO, when it is ratified", rule)).toBeNull();
    expect(violation("If the framework is ratified, the Guild hopes to contribute.", rule)).toBeNull();
  });

  it("coop-present-tense fires on the present tense and leaves the direction legal", () => {
    const rule = ruleFor("coop-present-tense");
    expect(violation("Radix Guild is a co-op of builders.", rule)).toBe("Guild is a co-op");
    expect(violation("We are a worker cooperative.", rule)).toBe("We are a worker cooperative");
    expect(violation("a member-owned marketplace", rule)).toBe("member-owned marketplace");
    expect(violation("We are building toward a cooperative model.", rule)).toBeNull();
    expect(violation("The Guild is not a co-op today; it is one operator.", rule)).toBeNull();
  });

  it("builds-radix-engine fires on claiming the engine or the RVM, not on building ON Radix", () => {
    const rule = ruleFor("builds-radix-engine");
    expect(violation("The Guild maintains the Radix engine.", rule)).toBe("Guild maintains the Radix engine");
    expect(violation("We build the RVM", rule)).toBe("We build the RVM");
    expect(violation("maintainers of the Radix protocol", rule)).toBe("maintainers of the Radix protocol");
    expect(violation("Built on Radix mainnet.", rule)).toBeNull();
    expect(violation("We build on the Radix network.", rule)).toBeNull();
    expect(violation("We do not maintain the Radix engine or the RVM.", rule)).toBeNull();
  });

  it("all six are distinct entries in BANNED, so the page gates and the write gate run them", () => {
    const labels = BANNED.map((b: { label: string }) => b.label);
    for (const needle of ["affiliation-backed", "affiliation-partner", "affiliation-official", "dao-ratified", "coop-present-tense", "builds-radix-engine"]) {
      expect(labels.filter((l: string) => l.startsWith(needle + " ")).length, needle).toBe(1);
    }
  });
});

describe("audit-claim — the noun form the \"audited\" rule could not see (added 2026-09-20)", () => {
  it("fires on the /agents sentence that shipped, and its siblings", () => {
    const rule = ruleFor("audit-claim");
    // src/app/agents/page.tsx, verbatim until 2026-09-20.
    expect(violation("Chain↔DB parity reconciled to exit 0; an independent Gateway audit found value conservation exact.", rule)).toBeTruthy();
    expect(violation("A third-party audit cleared the escrow.", rule)).toBeTruthy();
    expect(violation("The blueprint passed its audit in August.", rule)).toBeTruthy();
    expect(violation("Our security audit is complete.", rule)).toBeTruthy();
  });

  it("leaves the denial, the future and the replacement copy legal", () => {
    const rule = ruleFor("audit-claim");
    expect(violation("No independent audit has been done.", rule)).toBeNull();
    expect(violation("No independent audit of the live contract.", rule)).toBeNull();
    expect(violation("That is a self-check, not an audit — no independent audit has been done.", rule)).toBeNull();
    expect(violation("A formal audit is planned.", rule)).toBeNull();
    expect(violation("Read the auditor's guide before you start.", rule)).toBeNull();
  });
});

describe("two claims a live Telegram test found (added 2026-09-20)", () => {
  it("open-source-claim fires on what the bot and the OpenGraph card shipped", () => {
    const rule = ruleFor("open-source-claim");
    // guild-public bot SOURCE_STATUS, verbatim.
    expect(violation("The public half (this bot, the reference dashboard, docs) is open source, Apache 2.0:", rule)).toBeTruthy();
    // public/og-image.svg, verbatim.
    expect(violation("Apache-2.0 licensed • Built on Radix", rule)).toBe("Apache-2.0 licensed");
    expect(violation("The escrow blueprint is licensed under the Apache licence.", rule)).toBeTruthy();
    expect(violation("The source code is public on GitHub.", rule)).toBeTruthy();
  });

  it("open-source-claim leaves the honest sentences legal", () => {
    const rule = ruleFor("open-source-claim");
    // src/app/about/page.tsx, verbatim.
    expect(violation("the dashboard and bot in front of them are not open source yet.", rule)).toBeNull();
    // src/content/lights-on.ts — a promise about things not yet published.
    expect(violation("Anything we publish as part of this effort, code, tooling and designs, is Apache-2.0, forever", rule)).toBeNull();
    // A licence NAME as a task term.
    expect(violation("Licence: Apache-2.0", rule)).toBeNull();
    expect(violation("The code is not public yet.", rule)).toBeNull();
    // src/app/trust/page.tsx verbatim — the live probe fired on this before the `allow` existed.
    expect(violation("Posted as real on-chain Guild tasks once the source is public — the pot is provably funded", rule)).toBeNull();
  });

  it("onchain-xp-never-written fires on all four sentences that shipped", () => {
    const rule = ruleFor("onchain-xp-never-written");
    expect(violation("Your tier, XP and governance history are tracked off-chain: nothing has written the badge's on-chain XP field since mint.", rule)).toBeTruthy();
    expect(violation("they are read from the Guild database, not from the badge’s own fields: the tier and XP fields have never been written.", rule)).toBeTruthy();
    expect(violation("It carries tier and XP fields that nothing has ever written: your score lives in the Guild database.", rule)).toBeTruthy();
    // /check-badge body + metadata — found by the live probe, not by grep.
    expect(violation("It carries tier, XP and level fields — but nothing has ever written them, so the numbers you see come from the database.", rule)).toBeTruthy();
    expect(violation("the XP and tier you see in the app are tracked off-chain, and the on-chain value stays at its minted state.", rule)).toBeTruthy();
  });

  it("onchain-xp-never-written leaves the corrected sentence legal", () => {
    const rule = ruleFor("onchain-xp-never-written");
    // The shipped wording since 2026-09-24 ("once, by hand" was wrong: six update_xp calls, April 2026).
    expect(violation("The badge's XP field can be written only by the operator, with an admin badge — it was written six times in April 2026, never since — and a task payout never reaches it.", rule)).toBeNull();
    expect(violation("XP is a score in the Guild database, credited when a task pays out; it does not decay.", rule)).toBeNull();
  });
});

describe("ruleFor resolves rules exactly (added 2026-09-02)", () => {
  const head = (label: string) => label.split(" — ")[0].replace(/^"|"$/g, "");

  it("refuses a name that is only a PREFIX of a real rule name", () => {
    // The exact mutation that used to pass green: rename a rule to
    // `<name>-DISABLED` and the old substring lookup still found it, so a
    // label-based "is this rule wired?" check could not fail.
    expect(() => ruleFor("delivery")).toThrow(/no BANNED rule named/);
    expect(() => ruleFor("self-claim")).toThrow(/no BANNED rule named/);
  });

  it("refuses a name that does not exist at all", () => {
    expect(() => ruleFor("not-a-rule")).toThrow(/no BANNED rule named/);
  });

  it("every rule name in the table is unique, so no lookup is ambiguous", () => {
    const names = BANNED.map((b: { label: string }) => head(b.label));
    expect(names.length).toBeGreaterThan(15); // vacuous-pass guard
    expect(new Set(names).size).toBe(names.length);
  });

  it("every name this file looks up still resolves", () => {
    // Reads the needles out of this file's own source, so a rule renamed in
    // honest-copy.mjs without updating its tests reddens HERE with a clear
    // message rather than in whichever assertion happened to run first.
    const self = readFileSync(join(import.meta.dirname, "honest-copy.test.ts"), "utf8");
    const needles = [...self.matchAll(/ruleFor\("([^"]+)"\)/g)].map((m) => m[1]);
    const looked = [...new Set(needles)].filter((n) => !["delivery", "self-claim", "not-a-rule"].includes(n));
    expect(looked.length).toBeGreaterThan(10); // vacuous-pass guard
    // NB: the label below deliberately avoids the literal text this test greps
    // for — an earlier draft used it and the scan matched its OWN assertion
    // message, so the test failed on a needle that only existed inside itself.
    for (const n of looked) expect(() => ruleFor(n), `rule name: ${n}`).not.toThrow();
  });
});

describe("the detail routes — [param] pages no gate had ever loaded (added 2026-09-02)", () => {
  // WHAT THIS PROVES, AND WHAT IT DOES NOT. It applies the full rule table to
  // the SOURCE of every DETAIL_ROUTE and the settlement-copy-bearing components
  // they render. That catches an inline false sentence typed into the JSX —
  // which is how all four falsehoods fixed on 2026-09-02 got in, every one of
  // them sitting beside a properly gated settlementCopy() call.
  //
  // It does NOT prove the rendered page is clean. Copy composed at runtime, or
  // reached only in a particular escrow state, is invisible to a source scan.
  // Closing that needs cold-user.spec to navigate to a seeded id and run its
  // hydrated pass; there is no such fixture today. Saying so here rather than
  // letting a green tick imply the stronger claim is the entire point — the
  // route list this test backs exists because a walker's silent exclusion made
  // a weaker check look like a complete one.
  const ALL_RULES = [...BANNED, ...PULL_BANNED];

  const targets = [...DETAIL_ROUTES.map((d: { file: string }) => d.file), ...DETAIL_COMPONENTS];

  it.each(targets)("has no banned settlement claim in its source: %s", (rel: string) => {
    const abs = join(import.meta.dirname, "../../", rel);
    expect(existsSync(abs), `${rel} does not exist — DETAIL_ROUTES is stale`).toBe(true);
    const src = readFileSync(abs, "utf8");

    const hits = ALL_RULES.map((r: unknown) => violation(src, r))
      .filter(Boolean)
      .slice(0, 5);
    expect(hits, `banned claim(s) in ${rel}: ${hits.join(" | ")}`).toEqual([]);
  });

  it("actually scans a non-trivial amount of source", () => {
    // Vacuous-pass guard. An empty or unreadable target list would make every
    // assertion above pass over nothing.
    expect(targets.length).toBeGreaterThanOrEqual(6);
    const total = targets.reduce((n: number, rel: string) => {
      const abs = join(import.meta.dirname, "../../", rel);
      return n + (existsSync(abs) ? readFileSync(abs, "utf8").length : 0);
    }, 0);
    expect(total).toBeGreaterThan(50_000);
  });

  it("every DETAIL_ROUTE is a [param] route and is classified nowhere else", () => {
    const others = new Set([
      ...COLD_ROUTES,
      ...DYNAMIC_ROUTES,
      ...OPTIONAL_ROUTES,
      ...REDIRECT_ROUTES,
      ...OPERATOR_ROUTES,
    ]);
    for (const d of DETAIL_ROUTES as { route: string }[]) {
      expect(d.route, `${d.route} has no [param] segment`).toContain("[");
      // Double-listing would send it to CHECK 4, which computes a prerendered
      // .html path that these routes will never produce — a fail-closed on a
      // route that is fine.
      expect(others.has(d.route), `${d.route} is in two lists`).toBe(false);
    }
  });
});

describe("route lists", () => {
  it("derives NESTED artifact paths, which flat pairs could not express", () => {
    expect(fileFor("/")).toBe(".next/server/app/index.html");
    expect(fileFor("/tasks/create")).toBe(".next/server/app/tasks/create.html");
  });

  it("keeps the optional and dynamic routes OUT of the required list", () => {
    // launch-check fails closed on a missing REQUIRED artifact. /gift has none
    // when unconfigured and a DYNAMIC_ROUTES entry (e.g. /ledger) never has
    // one, so either sitting in COLD_ROUTES would redden a correct deploy.
    for (const r of [...OPTIONAL_ROUTES, ...DYNAMIC_ROUTES]) {
      expect(COLD_ROUTES).not.toContain(r);
    }
  });

  it("has no duplicate routes across the lists the e2e spec concatenates", () => {
    const all = [...COLD_ROUTES, ...DYNAMIC_ROUTES, ...OPTIONAL_ROUTES];
    expect(new Set(all).size).toBe(all.length);
  });

  it("only lists client-rendered routes the spec can actually visit", () => {
    const visitable = new Set([...COLD_ROUTES, ...DYNAMIC_ROUTES, ...OPTIONAL_ROUTES]);
    for (const r of CLIENT_RENDERED) expect(visitable.has(r)).toBe(true);
  });

  // ── the one that stops this recurring ──────────────────────────────────────
  //
  // Three separate times, a cold-user page has shipped with no gate over it:
  // /money, /lifecycle and /disputes (caught in #290, structurally — no PR could
  // add itself), then /governance-status (caught by a pre-deploy sweep on
  // 2026-08-01, clean by luck rather than by design).
  //
  // Every one of those was "someone should have added the route to the list".
  // Exhortation has now lost to that three times, so this reads the routes off
  // the FILESYSTEM and requires each to be classified deliberately. A new page
  // fails CI until its author says which kind it is. That is the whole point:
  // the failure mode was silence, and silence is what this removes.
  it("classifies every static page under src/app — a new page cannot escape the gate", () => {
    const appDir = join(import.meta.dirname, "../../src/app");

    const routes: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        // Route groups `(x)` do not appear in the URL.
        if (entry.name.startsWith("(")) {
          walk(join(dir, entry.name), prefix);
          continue;
        }
        // ⚠️ THIS USED TO BE `if (entry.name.startsWith("[")) continue;`.
        //
        // Read the comment above this test: "the failure mode was silence, and
        // silence is what this removes." That line skipped every dynamic
        // segment at every depth, so five real pages — /tasks/[id],
        // /tasks/[id]/submit, /profile/[address], /projects/[slug] and
        // /proposals/[id] — were never produced by the walk, never appeared in
        // `unclassified`, and were therefore never required to be classified.
        // The empty `unclassified` assertion below was passing because the
        // walker could not see them, and the vacuous-pass guard stayed happy on
        // the ~29 static routes it did find. A gate against silence with a
        // silent exclusion in it.
        //
        // Its stated reason ("no prerendered artifact for launch-check to
        // read") was true and irrelevant: that is an argument for keeping these
        // out of COLD_ROUTES, not out of classification. DYNAMIC_ROUTES and
        // DETAIL_ROUTES both exist for routes with no artifact.
        const child = join(dir, entry.name);
        const route = `${prefix}/${entry.name}`;
        if (readdirSync(child).includes("page.tsx")) routes.push(route);
        walk(child, route);
      }
    };
    walk(appDir, "");
    if (readdirSync(appDir).includes("page.tsx")) routes.push("/");

    const classified = new Set([
      ...COLD_ROUTES,
      ...DYNAMIC_ROUTES,
      ...OPTIONAL_ROUTES,
      ...REDIRECT_ROUTES,
      ...OPERATOR_ROUTES,
      ...DETAIL_ROUTES.map((d: { route: string }) => d.route),
    ]);

    const unclassified = routes.filter((r) => !classified.has(r)).sort();
    expect(
      unclassified,
      `Unclassified page route(s): ${unclassified.join(", ")}.\n` +
        `Every page under src/app must appear in exactly one list in ` +
        `scripts/honest-copy.mjs:\n` +
        `  COLD_ROUTES     — a cold-user page; its copy gets scanned every deploy\n` +
        `  DYNAMIC_ROUTES  — no prerendered artifact; guarded by the e2e spec only\n` +
        `  OPTIONAL_ROUTES — may legitimately 404 (env-conditional)\n` +
        `  REDIRECT_ROUTES — a redirect() shell with no copy of its own\n` +
        `  OPERATOR_ROUTES — operator-only, not a cold-user surface\n` +
        `  DETAIL_ROUTES   — a [param] page with real copy; scanned at source\n` +
        `If it shows copy to a stranger, it belongs in COLD_ROUTES.`,
    ).toEqual([]);

    // Guard the guard: if the walk ever stops finding routes, the assertion
    // above passes vacuously and this test becomes decoration.
    expect(routes.length).toBeGreaterThan(15);

    // And guard the guard's blind spot SPECIFICALLY. The count above stayed
    // satisfied by static routes alone for as long as the bracket skip existed,
    // so it could never have caught it. This one can: restore the skip and it
    // reddens immediately.
    const dynamic = routes.filter((r) => r.includes("["));
    // Floor was 5 until 2026-09-04, when /proposals/[id] (a redirect shell into
    // the removed /decisions page) was deleted; four [param] routes remain and
    // still prove the walk descends into bracket directories.
    expect(
      dynamic.length,
      "the walk found no [param] routes — the dynamic-segment skip is back, and " +
        "every detail page is invisible to this test again",
    ).toBeGreaterThanOrEqual(4);
  });
});

// ── PULL rules — dormant today, armed at cutover (redesign §11b chunk H) ─────
//
// These are the inverse of every other rule in this file: the copy they ban is
// TRUE right now and becomes false when the pull escrow goes live. That makes
// them uniquely easy to get wrong in a way nothing notices — a dormant rule is
// never exercised by a normal deploy, so if it matched nothing at all, CHECK 4
// would still pass on the day it was supposed to fire and the sweep would be
// skipped silently.
//
// So they are tested harder than the live ones: pinned to verbatim shipped
// sentences, proven to leave the auto-release copy alone, and — the guard that
// actually generalises — proven to still match real source files today.

const pullRuleFor = (needle: string) => {
  const r = PULL_BANNED.find((b: { label: string }) => b.label.includes(needle));
  if (!r) throw new Error(`no PULL_BANNED rule matching ${needle} — rule table changed`);
  return r;
};

describe("PULL_BANNED is dormant, not live", () => {
  it("is a separate table — none of its rules leak into the always-on set", () => {
    const live = new Set(BANNED.map((b: { label: string }) => b.label));
    for (const rule of PULL_BANNED) {
      expect(live.has(rule.label), `${rule.label} must not be in BANNED`).toBe(false);
    }
    expect(PULL_BANNED.length).toBeGreaterThan(0);
  });
});

describe("PULL_BANNED fires on the exact copy that shipped", () => {
  // Verbatim from the pages, so a reworded rule that no longer matches the real
  // sentence fails here rather than at cutover.
  it.each([
    ["approval-pays", "When the poster approves, that same transaction pays the worker out of escrow", "that same transaction pays"],
    ["approval-pays", "the poster approves to release payment from on-chain escrow", "approves to release payment"],
    ["approval-pays", "The poster’s approval transaction releases the reward to you.", "approval transaction releases"],
    ["approval-pays", "Approve and the escrow releases in that one signed transaction", "releases in that one signed transaction"],
    ["approval-pays", "The poster reviews the evidence, approves, and the reward is released to the worker.", "reward is released to the worker"],
    ["approval-pays", "Released to the worker on approval.", "Released to the worker on approval"],
    ["approval-pays", "Escrow releases XRD to your wallet — 100% of the reward", "releases XRD to you"],
    // The landing hero, verbatim as it served on the live pull component until
    // 2026-08-21. Every case above is third-person; this one addresses the
    // poster, which is exactly why the rule missed it.
    [
      "approval-pays",
      "a badge-holding developer or AI agent delivers, and you release the payment on-chain when you approve the work",
      "you release the payment",
    ],
    ["step-count", "Four steps, each a wallet transaction — money never passes through a platform account.", "Four steps, each a wallet transaction"],
    ["settlement-returns-buckets", "Release hands the funds back to whoever submits the settlement transaction", "Release hands the funds back"],
    ["settlement-returns-buckets", "approve_and_release burns the poster’s task receipt", "burns the poster’s task receipt"],
    ["settlement-returns-buckets", "The web app builds the manifest that routes the reward to the worker’s wallet", "routes the reward to the worker’s wallet"],
    // The three word-order misses of 2026-08-21. Each shipped for three days
    // after the cutover with the rule measuring CLEAN on it.
    [
      "settlement-destination",
      "No method deposits into stored addresses — funds return to the caller’s manifest for routing",
      "No method deposits into stored address",
    ],
    [
      "settlement-destination",
      "Settlement is routed by the app’s transaction manifest, not enforced by the contract.",
      "routed by the app’s transaction manifest",
    ],
    [
      "settlement-destination",
      "Under the deployed component the reward goes to whoever submits the settlement transaction.",
      "reward goes to whoever submits the settlement transaction",
    ],
    // Round 7, 2026-09-02: the "pays" shape and the bare "release to" word
    // order, both found live on /guide and /lifecycle by an audit that ran the
    // full table against every inline (non-settlementCopy) string on those
    // pages. Verbatim as shipped.
    [
      "approval-pays",
      "The poster approves and escrow pays you, plus XP. No timer yet — if a poster goes quiet after you submit, the funds stay locked until they act.",
      "escrow pays you",
    ],
    [
      "approval-pays",
      "post (permissionless, free), fund (a second signed transaction), claim (badge-gated, 10 XRD bond, no self-claim), submit (evidence hash), approve (release to the worker). All on Radix mainnet.",
      "release to the worker",
    ],
  ])("%s fires on: %s", (needle, copy, expected) => {
    expect(violation(copy, pullRuleFor(needle))).toBe(expected);
  });

  // The "pays" branch is anchored to a subject (escrow/contract/component/
  // approving) rather than left bare — a bare `pays? (you|the worker)` fired
  // on a TRUE pinned witness (see "PULL_BANNED leaves the auto-release copy
  // alone" below: "silence pays the worker" names a vNext2 feature, not
  // approval). Requiring the subject is what separates the false claim from
  // the true one, same technique as the settlement-destination rule above.
  it("approval-pays' new branches leave the Round 7 fixes legal", () => {
    const rule = pullRuleFor("approval-pays");
    expect(
      violation(
        "The poster approves, which credits your reward inside escrow, plus XP — you collect it with your own signed withdrawal. No timer yet — if a poster goes quiet after you submit, the funds stay locked until they act.",
        rule,
      ),
    ).toBeNull();
    expect(
      violation(
        "claim (badge-gated, 10 XRD bond, no self-claim), submit (evidence hash), approve (credits the worker, who withdraws separately). All on Radix mainnet.",
        rule,
      ),
    ).toBeNull();
    // The claim family's true forms elsewhere in this codebase must stay
    // legal too — none of these name escrow/the contract/the component as the
    // subject of "pays".
    expect(violation("Workers pay no percentage of the reward, ever.", rule)).toBeNull();
    expect(violation("the contract pays only the accounts it pinned at claim and funding time", rule)).toBeNull();
    expect(violation("so the insurance pays nobody.", rule)).toBeNull();
    expect(violation("a stranger who calls it pays the network fee and moves no money to themselves", rule)).toBeNull();
  });
});

describe("PULL_BANNED leaves the auto-release copy alone", () => {
  /**
   * §11b's stated trap for this chunk, encoded so it cannot be walked into.
   * When this test was written, the deployed blueprint had NO timeout that
   * read submitted_at, and pull did not add one — grep confirmed zero hits for
   * auto_release / push_entitlement / review_window in lib.rs. Wave B
   * (2026-09-13) changed that: lib.rs now has review_window_secs and a PUBLIC
   * release_after_review_timeout, so most of the sentences below are STALE as
   * served copy today (see settlement-copy.ts and the pages that render it —
   * fixed separately, and now banned by the "no-review-window-release" rule
   * in honest-copy.mjs, whose own fixtures live in this file too).
   *
   * They stay here anyway, as pure regex-behaviour fixtures: this describes
   * release TIMING, and a rule about release MECHANISM (approval CREDITS vs
   * pays) must not fire on a sentence about timing regardless of whether that
   * timing claim is itself still true. Do not read a passing case here as
   * license to bring any of these sentences back as live copy.
   *
   * The third one below is also what forced the Round 7 "pays" branch to be
   * subject-anchored (escrow/contract/component/approving) rather than a bare
   * pays? (you|the worker): the bare form reddened on "silence pays the
   * worker" — a vNext2 feature name whose subject is poster inaction, not
   * approval. Measured before narrowing: RED; after anchoring the subject:
   * quiet.
   */
  it.each([
    "there is no auto-release. Once you submit, the only route to the money in the deployed component is the poster approving it.",
    "the review-window auto-release is designed, not deployed",
    "Review-window auto-release (silence pays the worker) · optional",
    "The deployed escrow has no auto-release, so submitted work waits until the poster acts.",
    "Closing that asymmetry — auto-release on poster silence — is the headline change in vNext2.",
    "there is no automatic release yet",
  ])("stays quiet on: %s", (copy) => {
    for (const rule of PULL_BANNED) {
      expect(violation(copy, rule), `${rule.label} must not fire`).toBeNull();
    }
  });

  /**
   * The sharp case, and the reason "do not touch these four sites" is not a
   * safe reading of §11b's row. /docs:158 carried a becomes-FALSE clause and a
   * (then-true, now stale — see the "no-review-window-release" rule below)
   * second clause in ONE sentence. The rule must fire on the first without
   * being excused by the second — allow spans exempt an overlapping hit, not
   * the whole sentence. This fixture is a standalone literal, not read from
   * settlement-copy.ts, so it is unaffected by that string's since-fixed copy.
   */
  it("still fires on a sentence whose OTHER clause is legitimately about auto-release", () => {
    const shipped =
      "When the poster approves, that same transaction pays the worker out of escrow; there is no automatic release yet.";
    expect(violation(shipped, pullRuleFor("approval-pays"))).toBe("that same transaction pays");
  });
});

describe("no-review-window-release — the deployed escrow HAS a public review-window auto-release (added 2026-09-16)", () => {
  // Wave B (live since 2026-09-13, component_rdx1czka…88yly) added
  // release_after_review_timeout: PUBLIC, zero auth, fires once a Submitted
  // task's review_deadline (submitted_at + review_window_secs, pinned at
  // submit_task; live value 259200s / 3 days) has passed, and settles exactly
  // like approve_and_release. 13+ served sites asserted the opposite — this
  // is BANNED, not PULL_BANNED, because it is a claim about the CURRENTLY
  // deployed component, not one that flips with the push/pull era.
  const rule = ruleFor("no-review-window-release");

  it.each([
    // Verbatim pre-fix strings, one per shipped site this PR touched.
    ["there is no auto-release.", "money/page.tsx bold lead"],
    [
      "A Submitted task has no auto-release in the deployed component: a poster who goes silent can leave a worker waiting indefinitely (auto-release is a vNext2 change).",
      "trust/page.tsx safety-releases card",
    ],
    [
      "the contract assigns the reward to the worker, who collects it with their own signed withdrawal; there is no automatic release yet.",
      "settlement-copy.ts docsFundingAnswer.pull (pre-fix)",
    ],
    [
      "Nothing releases on its own — the deployed escrow has no auto-release, so submitted work waits until the poster acts.",
      "settlement-copy.ts tourSubmitBody.pull (pre-fix)",
    ],
    [
      "Waiting on the poster. The escrow has no automatic release, so a poster who goes quiet leaves this task submitted indefinitely.",
      "settlement-copy.ts taskSubmittedWaitingNote.pull (pre-fix)",
    ],
    [
      "Be aware there is no timer yet: the deployed escrow has no review-window auto-release, so if a poster goes quiet after a worker submits, the funds stay locked until the poster acts.",
      "settlement-copy.ts DISPUTE_COPY.aboutDisputeDisclosure.off (pre-fix)",
    ],
    [
      "There is still no timer on review: the deployed escrow has no review-window auto-release, so if a poster goes quiet after a worker submits, the funds stay locked until someone acts — raising a dispute is the worker's one on-chain way out, and it recovers half the reward, not all of it.",
      "settlement-copy.ts DISPUTE_COPY.aboutDisputeDisclosure.on (pre-fix)",
    ],
    [
      "Once you submit, the only route to the full reward is the poster approving it — the submission time is recorded on-chain but no timeout ever reads it; the review-window auto-release is designed, not deployed.",
      "settlement-copy.ts DISPUTE_COPY.moneyWorkerEscapeNote.on (pre-fix)",
    ],
    [" No timer yet — if a poster goes quiet after you submit, the funds stay locked until they act.", "settlement-copy.ts DISPUTE_COPY.guidePipelinePayoutTail.off (pre-fix)"],
    [
      "The escrow has no auto-release by design, so if a poster goes quiet after a worker submits, disputing is that worker's only on-chain way out",
      "settlement-copy.ts DISPUTE_COPY.disputesHonestyLead.on (pre-fix)",
    ],
    [
      "The deployed escrow has no auto-release, so submitted work waits until the poster acts. Workers do face a hard on-chain submission deadline; posters do not yet face one. Closing that asymmetry — auto-release on poster silence — is the headline change in vNext2.",
      "guide/page.tsx FLOW step 4 body (pre-fix)",
    ],
    [
      "Your promise to review a submission within this many days. It is committed into the on-chain brief as evidence — the escrow does not enforce it, and nothing auto-releases if you go quiet.",
      "tasks/create/page.tsx review-window field note (pre-fix)",
    ],
    ["auto-release is not being built", "auditor-guide/page.tsx two-corrections paragraph (pre-fix)"],
  ])("fires on the pre-fix sentence (%s): %s", (text) => {
    expect(violation(text, rule)).toBeTruthy();
  });

  it("stays quiet on the corrected copy — the rule is not over-broad", () => {
    // One witness per site family this PR fixed, plus the two adjacent true
    // claims this rule must not swallow (the poster's own promised
    // review-days number is genuinely not enforced; the arbiter's turnaround
    // time genuinely has no SLA).
    expect(
      violation("nothing is credited until the poster approves, or the review window lapses and someone triggers the release.", rule),
    ).toBeNull();
    expect(
      violation(
        "if the poster never acts, anyone can trigger the escrow's review-window release once the window lapses, which credits that same reward, and the worker collects it the same way.",
        rule,
      ),
    ).toBeNull();
    expect(
      violation(
        "If the poster stays quiet, you are not stuck waiting on them: once the review window lapses, anyone can trigger that same release for you.",
        rule,
      ),
    ).toBeNull();
    expect(
      violation(
        "The escrow does not wait forever: once the review window lapses, anyone can trigger the same release without the poster acting.",
        rule,
      ),
    ).toBeNull();
    expect(
      violation(
        "release_after_review_timeout is callable only once the review window lapses (currently 3 days from submission) — until then a silent poster still leaves a worker waiting.",
        rule,
      ),
    ).toBeNull();
    // The live feature's accurate name — a draft branch banned this phrase outright.
    expect(violation("Review-window auto-release on poster silence is live on the deployed escrow.", rule)).toBeNull();
    expect(
      violation(
        "Wave B has since added a review-window release that needs no dispute at all and credits the same full reward — the better exit on a merely silent poster now",
        rule,
      ),
    ).toBeNull();
    expect(
      violation(
        "it does enforce its own 3-day review window: after that, anyone may trigger a release for the full reward without your approval.",
        rule,
      ),
    ).toBeNull();
    // The two adjacent true claims a broader rule could swallow by accident.
    expect(violation("it is a promise recorded in the committed brief, not a timer tied to that number.", rule)).toBeNull();
    expect(
      violation(
        "We promise no turnaround time for a human ruling — there is no public SLA, only that 72-hour backstop",
        rule,
      ),
    ).toBeNull();
    // A genuinely different, still-unbuilt vNext2 feature (instant settlement
    // ON DELIVERY) must not be swept up just because it also says "auto-release".
    expect(
      violation(
        "Instant settlement (auto-release on delivery, gated by automatic checks) is a vNext2 design, not a live mode.",
        rule,
      ),
    ).toBeNull();
  });
});

describe("config-immutable + arbiter-council-exists — /auditor-guide's two false 'known limits' (added 2026-09-21)", () => {
  const immutable = ruleFor("config-immutable");
  const council = ruleFor("arbiter-council-exists");

  it("fire on the sentences that shipped", () => {
    expect(
      violation(
        "Blueprint upgrades are migrations (new component + env swap), not in-place — config is immutable per instantiation by design.",
        immutable,
      ),
    ).toBeTruthy();
    expect(
      violation(
        "Wallet-side MFA/multisig UX is not yet on Radix mainnet; arbiter-council M-of-N is enforced at the method-auth layer when activated.",
        council,
      ),
    ).toBeTruthy();
  });

  it("stay quiet on the corrected copy and on the true neighbours", () => {
    for (const text of [
      "the code behind a component address does not change. Its settings can — the owner badge can move the parameters listed under the owner's powers above",
      "There is one arbiter badge (supply 1) and the operator holds it. The deployed blueprint has no multi-arbiter rule to switch on",
      "a panel with recall and assignment is a next-blueprint design, not a setting.",
      // /auditor-guide's corrected wording (2026-09-23): parameters are pinned at the
      // step that uses them — funding, claim, submission or dispute — not all at creation.
      "Most are pinned into a task at the step that uses them, so a change reaches only tasks that get there afterwards; the two expiry settings apply to claims already in flight.",
      // an accepted-token's divisibility genuinely is fixed per resource.
      "Cached: it is immutable per resource.",
    ]) {
      expect(violation(text, immutable), text).toBeNull();
      expect(violation(text, council), text).toBeNull();
    }
  });

  it("are anchored to the live blueprint: owner setters exist, and no multi-arbiter rule does", () => {
    const LIB_RS = readFileSync(LIB_RS_PATH, "utf8");
    const setters = [...LIB_RS.matchAll(/pub\s+fn\s+(set_[a-z_]+)\s*\(/g)].map((m) => m[1]);
    // If the setters ever go, "config is immutable" becomes TRUE and the rule must be revisited.
    expect(setters.length).toBeGreaterThanOrEqual(10);
    expect(setters).toContain("set_claim_bond_params");
    expect(setters).toContain("set_review_window_secs");
    // If a council ever lands, the second rule must be revisited the same way.
    expect(LIB_RS).not.toMatch(/require_n_of|CountOf|arbiter_council/);
  });
});

describe("no-review-window-release is anchored to the live blueprint", () => {
  // The rule above only makes sense while the deployed escrow actually HAS a
  // public, callable review-window release. If lib.rs ever drops
  // release_after_review_timeout, or re-auths it away from PUBLIC, this test
  // goes red — on purpose. That is the signal to revisit (relax or remove)
  // the rule above, not to leave it silently banning what would then be a
  // true "no auto-release" sentence again.
  const LIB_RS = readFileSync(LIB_RS_PATH, "utf8");

  it("lib.rs still declares release_after_review_timeout PUBLIC", () => {
    expect(LIB_RS).toMatch(/release_after_review_timeout\s*=>\s*PUBLIC\s*;/);
    expect(LIB_RS).toMatch(/pub\s+fn\s+release_after_review_timeout\s*\(/);
  });
});

describe("bond-returned-on-submit — since Wave B submit_task moves no money (added 2026-09-21)", () => {
  // Found eight days after the Wave B cutover, serving on seventeen sites
  // including the Submit button. Chain proof is in the rule's own comment.
  const rule = pullRuleFor("bond-returned-on-submit");

  it.each([
    // Verbatim pre-fix strings, one per shipped site.
    ["You get the bond back when you submit — but read the deadline note below", "lifecycle/page.tsx claim eli5"],
    ["submit_task returns the bond in full and has no deadline check, so a late submit still gets it back IF you win the race", "lifecycle/page.tsx claim does"],
    ["Returned in full when you submit — submit has no deadline check, so even a late submission returns it.", "money/page.tsx claim-bond detail"],
    ["so a late submit inside that hour still returns your bond.", "money/page.tsx grace-hour sentence"],
    ["Claiming locks a bond of 10% of the task reward — never less than 76.45 XRD, capped on-chain — returned when you submit, at risk once your deadline passes.", "guide/page.tsx pipeline CLAIM card"],
    ["The bond returns in full on submit.", "settlement-copy.ts guideClaimBody.pull + its dispute-on overlay"],
    ["locked when you claim and returned in full when you submit — an expired claim forfeits it", "settlement-copy.ts docsFeesAnswer.pull"],
    ["stakes a claim bond — 10% of the reward, never less than 76.45 XRD, capped on-chain — returned when you submit.", "guides.ts tasks-claim tour step"],
    ["the claim bond is 10% of the task's reward and never less than 76.45 XRD, returned in full when you submit, plus well under 1 XRD in network fees", "agent-cold-start.ts COLD_START_NEEDS"],
    ["Then send submit_task on-chain with two hashes (below) — your bond comes back in that transaction — and confirm", "agent-cold-start.ts submit step"],
    ["Submit Work (returns bond)", "escrow-actions.tsx submit button"],
    ["a bond of 10% of the reward, never less than 76.45 XRD, capped on-chain, returned when you submit", "docs/page.tsx For Workers list — found by launch-check CHECK 4 on the BUILT page; split across JSX lines, so no source sweep saw it"],
    ["then submit on-chain to lock its hash in escrow (that step returns your claim bond).", "escrow-actions.tsx describe-first note — found BY this rule, the sweep missed it"],
    ["Submitting your work on-chain returns the bond.", "escrow-truth.tsx bond-at-risk alert — found BY this rule, the sweep missed it"],
    ["Submit your work returns your claim bond", "task-stage.ts label + detail as rendered together"],
    ["a holder of a free Guild Member badge claims it with a bond (returned on submit, lost if the deadline passes first)", "public/llms.txt summary"],
  ])("fires on the pre-fix sentence: %s (%s)", (text) => {
    expect(violation(text, rule)).toBeTruthy();
  });

  it("stays quiet on the corrected copy, including the honest denials", () => {
    for (const text of [
      "You do not get the bond back when you submit: it stays in the escrow until the task settles, then it is credited back to you in full",
      "It is not handed back when you submit: it stays in the escrow until the task settles",
      "submit_task moves no money — the bond stays in its vault until a settlement path credits it",
      "Submitting moves no money: the bond stays in the escrow until the task settles.",
      "so a late submit inside that hour still saves your bond from forfeiture.",
      "Submit has no deadline check, so even a late submission protects it.",
      "claims it with a bond (held by the escrow until the task settles, then credited back; lost if the deadline passes first)",
      "it moves no money: your bond stays in the escrow until the task settles",
      "starts the review window — your claim bond stays in escrow until the task settles",
      "Submitting your work on-chain ends that risk — the bond then stays in escrow until the task settles.",
      "(that step moves no money — your claim bond stays in escrow until the task settles).",
      // cancel-after-claim genuinely does return the bond, and says so without "submit":
      "the worker's claim bond returns to THEM in full",
    ]) {
      expect(violation(text, rule), text).toBeNull();
    }
  });

  it("leaves /agents' dated history of the retired component legal — and only with that qualifier", () => {
    const history =
      "On 2026-07-22 a pilot agent ran it live on mainnet (on an earlier escrow component, since retired) end to end: create → fund → badge-gated claim (bond returned on submit) → submit";
    expect(violation(history, rule)).toBeNull();
    expect(violation(history.replace("(on an earlier escrow component, since retired) ", ""), rule)).toBeTruthy();
  });
});

describe("bond-returned-on-submit is anchored to the live blueprint", () => {
  // The rule is only right while submit_task hands nothing back. If lib.rs ever
  // returns a Bucket from submit_task again, this goes red — the signal to
  // revisit the rule AND the copy, not to leave either standing.
  const LIB_RS = readFileSync(LIB_RS_PATH, "utf8");

  it("lib.rs submit_task returns nothing, and the bond is credited on the settlement paths", () => {
    const sig = LIB_RS.match(/pub\s+fn\s+submit_task\s*\(([^)]*)\)\s*(->\s*[^{]+)?\{/);
    expect(sig, "submit_task not found in lib.rs").not.toBeNull();
    expect(sig![2], "submit_task has a return type again").toBeUndefined();
    // Control: the same regex DOES see a return type where one exists, so the
    // assertion above cannot pass merely because the pattern never captures one.
    const control = LIB_RS.match(/pub\s+fn\s+expire_claim\s*\(([^)]*)\)\s*(->\s*[^{]+)?\{/);
    expect(control?.[2]).toMatch(/Bucket/);
    expect(LIB_RS).toMatch(/credit_bond_entitlement\(task_id,\s*EntitledParty::Worker/);
  });
});

describe("bond-dispute-branch — once a dispute is raised the bond splits like the reward, ruled or not (added 2026-10-02)", () => {
  // Twelve served sites told a claimer what a dispute does to their bond only for a RULED
  // dispute, or promised the bond back at settlement with no dispute branch at all. lib.rs
  // splits it like the reward on BOTH ways out of Disputed (pinned below), and the live
  // default is SplitEvenly, so a dispute nobody rules still sends half of it to the poster.
  const rule = pullRuleFor("bond-dispute-branch");

  const BEFORE_YOU_CLAIM =
    "Before you claim Claiming locks a bond of exactly 76.45 XRD from this account — the escrow accepts only that exact amount. You then have 7 days to submit. An hour after that deadline, anyone can close your claim and the bond is forfeited: 90% to a vault only the operator can withdraw, 10% to whoever closes it. It comes back to you in full when the task is approved or released after the review window, or if the poster cancels. If a dispute is raised, it is split the same way as the reward instead, whether an arbiter rules or the 72-hour default applies.";

  it.each([
    // Verbatim pre-fix strings, one per shipped site.
    ["(held by the escrow: credited back on approval, on the review-window release or if the poster cancels; split like the reward if a dispute is ruled; forfeited if the claim runs an hour past its deadline and anyone ends it)", "public/llms.txt summary"],
    ["held until the task settles: credited back in full on approval, on the review-window release or if the poster cancels, split like the reward if a dispute is ruled, and forfeited if the claim runs an hour past its deadline and anyone ends it", "docs/page.tsx For Workers list"],
    ["it stays in the escrow until the task settles, is credited back to you in full when the work is approved or the review window lapses, splits the way the reward does if a dispute is ruled, and is collected with the same withdrawal as the reward.", "money/page.tsx claim-bond detail"],
    ["the bond stays in its vault until a settlement path credits it: in full to you on approval, on the review-window release, or if the poster cancels after your claim; split the way the reward is if a dispute is ruled.", "lifecycle/page.tsx claim does"],
    ["it is credited back to you in full and you collect it with the same withdrawal as the reward; if a dispute is ruled, the bond splits the way the reward does.", "settlement-copy.ts guideClaimBody.pull + its dispute-on overlay"],
    ["credited back to you in full when the work is approved or the review window lapses, split the way the reward is if a dispute is ruled, and collected with the same withdrawal as the reward", "settlement-copy.ts docsFeesAnswer.pull"],
    ["It comes back to you in full when the task is approved or released after the review window, or if the poster cancels. A dispute ruling splits it the same way as the reward.", "escrow-actions.tsx Before you claim"],
    ["It comes back to you in full when the task is approved or released after the review window, or if the poster cancels; a dispute ruling splits it the same way as the reward.", "guides.ts tasks-claim tour step + agent-cold-start.ts COLD_START_NEEDS"],
    ["This covers everything the escrow owes you on this task: your insurance, a refunded reward, or your share of the worker's claim bond after a dispute ruling.", "escrow-actions.tsx the poster's Collect note"],
    ["Claiming locks a bond of 10% of the task reward — never less than 76.45 XRD, capped on-chain — held until the task settles and then credited back to you, at risk once your deadline passes.", "guide/page.tsx Task Pipeline CLAIM card"],
    ["You do not get the bond back when you submit: it stays in the escrow until the task settles, then it is credited back to you in full — on approval, or once the review window lapses and the release is triggered — and you collect it with the same withdrawal as the reward. Read the deadline note below, because missing the submit deadline can cost you the bond outright.", "lifecycle/page.tsx claim eli5"],
  ])("fires on the pre-fix sentence: %s (%s)", (text) => {
    expect(violation(text, rule)).toBeTruthy();
  });

  it("stays quiet on the corrected copy", () => {
    for (const text of [
      "(held by the escrow: credited back on approval, on the review-window release or if the poster cancels; split like the reward if a dispute is raised; forfeited if the claim runs an hour past its deadline and anyone ends it)",
      "held until the task settles: credited back in full on approval, on the review-window release or if the poster cancels, split like the reward if a dispute is raised, and forfeited if the claim runs an hour past its deadline and anyone ends it",
      "it stays in the escrow until the task settles, is credited back to you in full when the work is approved or released after the review window, splits the way the reward does if a dispute is raised, and is collected with the same withdrawal as the reward.",
      "credited back to you in full when the work is approved or released after the review window, split the way the reward is if a dispute is raised, and collected with the same withdrawal as the reward",
      "it is credited back to you in full and you collect it with the same withdrawal as the reward; if a dispute is raised, the bond splits the way the reward does.",
      BEFORE_YOU_CLAIM,
      "This covers everything the escrow owes you on this task: your insurance, a refunded reward, or your share of the worker's claim bond after a dispute.",
      "Claiming locks a bond of 10% of the task reward, at least 76.45 XRD today (an owner setting), held until the task settles and then credited back to you, unless a dispute is raised, in which case it is split the same way as the reward. It is at risk once your deadline passes.",
      "You do not get the bond back when you submit: it stays in the escrow until the task settles, then it is credited back to you in full — on approval, or once the review window lapses and the release is triggered — unless a dispute is raised, in which case it is split the same way as the reward. You collect your part with the same withdrawal as the reward.",
      // The outsider task rows' wording (drafts/outsider-tasks, 2026-10-02).
      "Claiming stakes a bond of 10% of the reward; it stays in the escrow until the task settles and is then credited back to you, unless a dispute is raised, in which case it is split the same way as the reward; it is forfeited if you miss the submit deadline the task page shows and the claim is then ended.",
    ]) {
      expect(violation(text, rule), text).toBeNull();
    }
  });

  it("leaves the task page's dispute panel, the cancel-after-claim promises and the true neighbours legal", () => {
    for (const text of [
      // escrow-actions.tsx RaiseDisputeButton — already right: it names the default beside the ruling.
      "Raising takes no stake beyond the network fee — but it puts the worker's claim bond on the table: a ruling, or the default below, splits it with the reward.",
      "Opens a dispute on this submission. If nobody rules within 72h, anyone can settle it by the default: the reward and the worker's claim bond each split 50/50, and the insurance returns to the poster.",
      // cancel_task_by_poster_after_claim credits the bond back whole, and a Claimed task can never be disputed.
      "If they cancel this one after you claim it, your claim bond returns to you in full — there is no payment for time you already spent on the task.",
      "Before you submit, the poster can cancel a task you have claimed. Your claim bond comes back in full, but the time you spent is not paid.",
      "The contract credits your reward + insurance back to you, and credits the worker's claim bond back to them in full — the worker did nothing wrong here.",
      // The review-window release button describes the release itself.
      "it pays exactly what an approval pays: the reward and your held claim bond credited to the worker, the insurance credited home to the poster.",
      // /money's priced dispute, an insurance return beside a bond mention, and a forfeiture denial.
      "The worker's claim bond is split the same way as the reward, so half of it is credited to you as well.",
      "funding it costs the reward plus 5% insurance (approving credits the insurance back to you, and you collect it with one more signed transaction), and claiming one locks a bond of 10% of the reward",
      "The bond is the one exception worth knowing: a forfeited bond is not returned to you.",
    ]) {
      expect(violation(text, rule), text).toBeNull();
    }
  });

  it("a ruling-conditioned sentence is legal once it names the default too — and only then", () => {
    const both = "If a dispute is ruled, the arbiter picks how the bond splits; if nobody rules, the default splits it evenly.";
    expect(violation(both, rule)).toBeNull();
    expect(violation(both.replace("; if nobody rules, the default splits it evenly", ""), rule)).toBeTruthy();
  });

  it("sees the bond one sentence back, so the pronoun form cannot drop its dispute sentence unseen", () => {
    expect(violation(BEFORE_YOU_CLAIM, rule)).toBeNull();
    // Delete the dispute sentence: "It comes back…" now promises the bond back and nothing follows.
    const cut = BEFORE_YOU_CLAIM.replace(/ If a dispute is raised[^.]*\./, "");
    expect(cut).not.toBe(BEFORE_YOU_CLAIM);
    expect(violation(cut, rule)).toBeTruthy();
    // A decimal point is not a sentence end: "76.45 XRD" must not hide the bond from the promise.
    expect(violation("Claiming locks a bond of 76.45 XRD, held until the task settles and then credited back to you.", rule)).toBeTruthy();
  });
});

describe("bond-dispute-branch is anchored to the live blueprint", () => {
  // The rule is only right while EVERY way out of Disputed splits the bond like the reward.
  // If lib.rs ever gives one exit its own bond rule, this goes red — revisit the rule AND
  // the copy, rather than leave either standing.
  const LIB_RS = readFileSync(LIB_RS_PATH, "utf8");
  const FN_START = /\n {8}(?:pub\s+)?fn\s+\w+\s*\(/g;
  const fnBody = (name: string) => {
    const start = LIB_RS.search(new RegExp(`\\n {8}(?:pub\\s+)?fn\\s+${name}\\s*\\(`));
    expect(start, `fn ${name} not found in lib.rs`).toBeGreaterThan(-1);
    FN_START.lastIndex = start + 1;
    const next = FN_START.exec(LIB_RS);
    return LIB_RS.slice(start, next ? next.index : undefined);
  };

  it("both dispute exits credit the bond through credit_split_for_parties, by the reward ruling", () => {
    for (const exit of ["resolve_dispute", "auto_resolve_dispute"]) {
      expect(fnBody(exit), exit).toMatch(/self\.credit_split_for_parties\(/);
    }
    const split = fnBody("credit_split_for_parties");
    expect(split).toMatch(/worker_share\(reward_ruling,\s*bond_total\)/);
    expect(split).toMatch(/credit_bond_entitlement\(task_id,\s*EntitledParty::Poster,\s*bond_combined\)/);
    // Control: the helper really isolates one function — approval credits the bond its own way.
    expect(fnBody("approve_and_release")).not.toMatch(/credit_split_for_parties/);
  });

  it("raise_dispute is the only way into Disputed, and it needs a Submitted task", () => {
    expect(LIB_RS.match(/task\.state\s*=\s*TaskState::Disputed\b/g)).toHaveLength(1);
    const raise = fnBody("raise_dispute");
    expect(raise).toMatch(/task\.state\s*=\s*TaskState::Disputed\b/);
    expect(raise).toMatch(/TaskState::Submitted,\s*"task must be Submitted to dispute"/);
  });
});

describe("bond-dispute-branch over every source that states the bond's fate (added 2026-10-02)", () => {
  // CHECK 4 and the cold-user spec read the BUILT pages, in CI and at deploy. This reads the
  // SOURCES at `bun run test` time, comments stripped, so a page no other unit test scans
  // (/lifecycle, /trust, /agents, /disputes, /auditor-guide) cannot bring the omission back
  // unseen until the build. settlement-copy.ts is not listed: its push column is dead copy
  // that trips this rule on purpose (TEETH in settlement-copy.test.ts), which reads it per era.
  const rule = pullRuleFor("bond-dispute-branch");
  const SOURCES = [
    "src/app/guide/page.tsx",
    "src/app/docs/page.tsx",
    "src/app/money/page.tsx",
    "src/app/lifecycle/page.tsx",
    "src/app/trust/page.tsx",
    "src/app/about/page.tsx",
    "src/app/agents/page.tsx",
    "src/app/disputes/page.tsx",
    "src/app/auditor-guide/page.tsx",
    "src/app/mint/page.tsx",
    "src/app/check-badge/page.tsx",
    "src/components/tasks/escrow-actions.tsx",
    "src/components/tasks/escrow-truth.tsx",
    "src/components/guides/guides.ts",
    "src/content/agent-cold-start.ts",
    "src/content/agent-manifests.ts",
    "public/llms.txt",
    "public/.well-known/agent-card.json",
  ];
  const stripped = (rel: string) =>
    readFileSync(join(process.cwd(), rel), "utf8")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1 ")
      .replace(/&rsquo;|&apos;|&lsquo;/g, "'")
      .replace(/&ldquo;|&rdquo;/g, '"')
      .replace(/&mdash;/g, "—")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ");

  it.each(SOURCES)("%s", (rel) => {
    const v = violation(stripped(rel), rule);
    expect(v, `${rel}: "${v}"`).toBeNull();
  });

  it("reads real bond copy (vacuous-pass guard)", () => {
    const all = SOURCES.map(stripped).join(" ");
    expect((all.match(/\bbond\b/gi) ?? []).length).toBeGreaterThan(60);
    expect(all).toMatch(/if a dispute is raised/i);
  });

  it("the scan can fail (control): /docs' pre-fix clause, put back in memory, trips it", () => {
    const docs = stripped("src/app/docs/page.tsx");
    const planted = docs.replace("split like the reward if a dispute is raised", "split like the reward if a dispute is ruled");
    expect(planted).not.toBe(docs);
    expect(violation(planted, rule)).toBeTruthy();
  });
});

// The "PULL_BANNED is live ammunition" describe stood here until 2026-08-15.
// It scanned page SOURCES to prove every dormant rule still matched shipped
// copy — and its own comment ordered its deletion in the commit that lands the
// sweep, because after the sweep the pages no longer carry push sentences. The
// guarantee did not retire with it: settlement-copy.test.ts asserts every
// PULL_BANNED rule fires on at least one PUSH string in settlement-copy.ts —
// which IS the shipped copy until the cutover — plus a pinned TEETH set per
// sentence. Same ammunition, one move earlier in the pipeline.

describe("rac-handover — the admin badge 'handed over' to the RAC (added 2026-09-23)", () => {
  const rule = ruleFor("rac-handover");

  it("fires on the sentences that shipped on /docs, /about and /bigdev", () => {
    for (const text of [
      "bigdev holds the admin badge with no committed transfer date — handover is gated on the Permanent RAC once elected under GP-ELECT-1 (not yet drafted), and it is not gated on any Guild milestone.",
      "bigdev holds the admin badge. No transfer date is committed — handover is gated on the Permanent RAC once elected under GP-ELECT-1 (not yet drafted).",
      "Holds the admin badge — no committed transfer date; handover is gated on the Permanent RAC once elected under GP-ELECT-1 (not yet drafted).",
      "The admin badge and platform operations are managed by bigdev. Handover is gated on the Permanent RAC once elected under GP-ELECT-1 (not yet drafted) — no date is committed.",
      "The admin badge stays with bigdev until the Permanent RAC is elected under GP-ELECT-1 (not yet drafted) — interim by design",
      "the admin badge hands over to the Radix Accountability Council",
    ]) {
      expect(violation(text, rule), text).toBeTruthy();
    }
  });

  it("stays quiet on the replacement copy", () => {
    for (const text of [
      "bigdev built Radix Guild and runs it today, and holds its admin badge — anyone can check that on the ledger.",
      "ideas and issues are raised in the open and turned into funded Guild tasks, and the Guild is handed to the Radix DAO once the DAO is formed.",
      "bigdev holds the admin badge, and who holds it is on the ledger for anyone to check. The aim is to hand it to the Radix DAO once the DAO is formed; no date is set.",
      "Holds the admin badge (on-ledger); the aim is to hand it to the Radix DAO once the DAO is formed, with no date set.",
      "The admin badge and platform operations are managed by bigdev. The aim is to hand them to the Radix DAO once the DAO is formed; no date is set. This is an interim arrangement, not permanent centralisation.",
      "The admin badge stays with bigdev for now. The aim is to hand it to the Radix DAO once the DAO is formed — interim by design, no date set, and who holds it today is on-ledger.",
    ]) {
      expect(violation(text, rule), text).toBeNull();
    }
  });
});

describe("the 2026-09-23 copy-audit family — six claims the evidence refutes (added 2026-09-23)", () => {
  // Each rule is pinned to the sentences that SHIPPED (verbatim, from the live
  // site on 2026-09-23 — the live probe in the PR found 11 hits across /guide,
  // /docs, /about, /disputes, /agents and /check-badge) and must stay quiet on
  // the replacement copy and on true neighbours that share its words.
  const cases: { rule: string; fires: string[]; quiet: string[] }[] = [
    {
      rule: "watchers-paused",
      fires: [
        "Watchers that would normally page a human within 30 minutes of any task entering Disputed are paused right now; that paging resumes once they are back running.",
        "Two, detection: a watch-only keeper and an escrow drift watcher normally alert a human within 30 minutes of any task entering or leaving the Disputed state — both are paused right now, so treat that alert as not watching until they are back running.",
        "The automated alert that would normally tell us when someone does is paused right now, so tell us on Telegram if you raise one by hand and we will follow it up with you.",
        "the keeper and drift-watcher alert that normally pages a human within 30 minutes of a Disputed task is paused right now, so nothing pages anyone until the watchers are back running.",
      ],
      quiet: [
        // The replacement that shipped (2026-09-24: the task pager has no value threshold).
        "Watchers read the escrow every 30 minutes and page the operator on every claim, submission, dispute and settlement, with reminders before a review window closes.",
        "Two, detection: watchers read the escrow every 30 minutes and page the operator on every claim, submission, dispute and settlement, with reminders before a review window closes.",
        // True neighbours that say "paused" about other things.
        "Cash rewards are paused",
        "New-task posting is paused ahead of a planned escrow upgrade — existing tasks are unaffected.",
        "The Telegram bot is paused while Radix mainnet is halted, so bot commands will not answer until the network resumes.",
      ],
    },
    {
      rule: "xp-from-votes",
      fires: [
        "Vote (+10 XP), create a proposal or poll (+25 XP), run a temperature check (+10 XP), plus dice-roll bonuses (up to +100 for a jackpot) — those all run through the Telegram bot.",
        "Earn XP through voting, proposing, completing tasks, and playing the dice game.",
        "Five tiers, Member to Elder, driven by XP earned through voting, proposals, temperature checks, completed tasks and the dice game.",
        "One running total. Earned by voting, proposing, posting and completing tasks, and dice-game bonuses.",
        "3. Vote on proposals to earn XP and level up your tier",
        "Participating earns XP. XP determines your tier; votes are one per Telegram account, and XP and tier do not weight them.",
        "Free badge NFT (Scrypto v4). Earn XP by participating.",
        "they are a separate counter and do not add to the XP that comes from voting, proposing, and completing work.",
      ],
      quiet: [
        "By completing tasks. Each task pays XP by reward tier — 10, 25, 50 or 100 — credited when the task settles.",
        "The Telegram bot keeps its own points for votes and polls; they are not added to your Guild XP.",
        "Completed tasks earn XP. Badge holders can also propose ideas and vote in the Telegram bot's optional community polls — one vote per Telegram account.",
        "Earn XRD and XP by completing tasks for the community.",
        "Complete tasks → earn XP. XP is a score in the Guild database, credited when a task pays out (the Telegram bot keeps its own points for votes and polls); it does not decay.",
      ],
    },
    {
      rule: "badge-xp-telegram",
      fires: [
        "Badge XP (Telegram)",
        "Badge XP (Telegram) is a separate field on the badge NFT itself, written only by the Telegram bot's XP queue for votes, polls and dice; the two never sync.",
        "The other four write Badge XP, a separate field on the badge NFT itself, via the Telegram bot's XP queue.",
      ],
      quiet: [
        "Badge XP (on-chain)",
        "Badge XP (on-chain) is a separate field on the badge NFT itself, which only the operator can write; a task payout never reaches it, and the two never sync.",
        "The XP above is the badge's on-chain field, which only the operator writes, and rarely.",
      ],
    },
    {
      rule: "tier-from-xp",
      fires: [
        "Participating earns XP. XP determines your tier; votes are one per Telegram account, and XP and tier do not weight them.",
        "Complete tasks → earn XP → advance tiers (member → contributor → builder → steward → elder).",
        "Five tiers, Member to Elder, driven by XP earned through voting, proposals, temperature checks, completed tasks and the dice game.",
        "Level Up Your Badge",
        "3. Vote on proposals to earn XP and level up your tier",
      ],
      quiet: [
        "Five tiers, Member to Elder, are defined by XP thresholds; the tier shown on your badge is its own on-chain field, which only the operator sets.",
        "The tier shown on your badge is the badge's own on-chain field, which only the operator can set — Guild XP does not move it automatically. A tier carries no permissions.",
        "Complete tasks → earn XP.",
        "XP & Tiers",
      ],
    },
    {
      rule: "agent-human-accountable",
      fires: [
        "Instant settlement (auto-release on delivery, gated by automatic checks) is a vNext2 design, not a live mode. Agents work under badge-holding humans who answer for them.",
        "An agent works under a badge-holding human who answers for it — the badge is a public mint that records membership, not identity verification.",
        "The badge is a public mint anyone can call; the human behind it is accountable.",
      ],
      quiet: [
        "Nothing on-chain ties an agent to a human: the member badge is a public mint that any key can hold.",
        // /auditor-guide's honest-gaps line, true, and it shares the words.
        "so no human currently answers for an agent.",
      ],
    },
    {
      rule: "xp-zeroed-on-transfer",
      fires: [
        "The NFT itself is technically transferable, and because reputation lives off-chain the Guild zeroes XP on any transferred badge — today that is Host-enforced policy, not a blueprint rule.",
        "Reputation is non-transferable by guild policy — the badge NFT itself can technically be moved.",
      ],
      quiet: [
        "The NFT itself is transferable. Your XP and trust record belong to your account in the Guild's records, not to the badge, so moving the badge does not move them.",
        "XP and trust come from completed tasks and belong to your account, not the badge.",
      ],
    },
  ]

  for (const c of cases) {
    const rule = ruleFor(c.rule)
    it(`${c.rule} fires on every sentence that shipped`, () => {
      for (const text of c.fires) expect(violation(text, rule), text).toBeTruthy()
    })
    it(`${c.rule} stays quiet on the replacement copy and the true neighbours`, () => {
      for (const text of c.quiet) expect(violation(text, rule), text).toBeNull()
    })
  }

  it("the evidence each rule rests on is still what the code says", () => {
    // xp-from-votes / tier-from-xp: one writer of users.xp, and it is task settlement.
    const users = readFileSync(join(process.cwd(), "src/db/queries/users.ts"), "utf8")
    expect(users).toMatch(/export async function awardTaskCompletion/)
    expect((users.match(/xp:\s*sql`\$\{users\.xp\}\s*\+/g) ?? []).length).toBe(1)
    // tier-from-xp: the tier the app shows is the badge's own field.
    const card = readFileSync(join(process.cwd(), "src/components/badge-card.tsx"), "utf8")
    expect(card).toMatch(/badge\.tier\.toUpperCase\(\)/)
    // xp-zeroed-on-transfer: XP lives on the account row, keyed by address.
    const schema = readFileSync(join(process.cwd(), "src/db/schema/users.ts"), "utf8")
    expect(schema).toMatch(/id: text\("id"\)\.primaryKey\(\), \/\/ Radix account address/)
    expect(schema).toMatch(/xp: integer\("xp"\)/)
  })
})

describe("the pages this audit rewrote clear EVERY rule, not just the new ones (added 2026-09-23)", () => {
  // Found while writing the audit: the first draft of the tier copy said
  // "Tiers gate nothing" — a true denial that the tier-gating rule bans anyway,
  // because it matches the phrase, not the claim. No unit test read these pages,
  // so it would first have gone red in CI's cold-user spec or, worse, in
  // launch-check on the box. This reads the SOURCE of the five pages whose tier
  // and XP copy changed, strips comments (they quote the old claims on purpose),
  // and runs the full BANNED + PULL_BANNED table. None of the five carries a
  // data-honest-copy="quote" region, so there is nothing to exempt.
  const PAGES = [
    "src/app/docs/page.tsx",
    "src/app/guide/page.tsx",
    "src/app/mint/page.tsx",
    "src/app/check-badge/page.tsx",
    "src/app/about/page.tsx",
  ]
  const stripped = (rel: string) =>
    readFileSync(join(process.cwd(), rel), "utf8")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1 ")
      .replace(/&rsquo;|&apos;|&lsquo;/g, "'")
      .replace(/&ldquo;|&rdquo;/g, '"')
      .replace(/&mdash;/g, "—")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")

  it.each(PAGES)("%s", (rel) => {
    const text = stripped(rel)
    expect(text.includes("data-honest-copy")).toBe(false)
    const hits: string[] = []
    for (const r of [...BANNED, ...PULL_BANNED] as Array<{ label: string; re: RegExp; allow?: RegExp[] }>) {
      const v = violation(text, r)
      if (v) hits.push(`"${v}" — ${r.label.split(" ")[0]}`)
    }
    expect(hits).toEqual([])
  })

  it("the scan can fail (control): the shipped draft sentence trips tier-gating", () => {
    const tierGating = ruleFor("tier-gating")
    expect(violation("A tier on your badge is its own field. Tiers gate nothing.", tierGating)).toBeTruthy()
  })
})
