import { describe, it, expect } from "vitest";
import { BANNED, PULL_BANNED, violation } from "../../scripts/honest-copy.mjs";
import { GUIDES, AGENT_FAST_TRACK } from "@/components/guides/guides";

/**
 * Honest-copy over INTERACTION-GATED copy — the surface neither deploy gate sees.
 *
 * Both existing gates read a page RESPONSE: launch-check.sh CHECK 4 scans the
 * prerendered HTML, and cold-user.spec.ts scans a hydrated page. Guide/tour
 * bodies are in neither. They render only after a user opens the header Help
 * menu -> "Page walkthrough" (app-shell.tsx), so no request for /mint, /profile
 * or /docs contains them.
 *
 * Verified empirically on 2026-07-31, while a false claim was live in this very
 * file: the string "non-transferable" appeared in NEITHER the raw HTML NOR
 * visibleText() for /mint, /profile or /docs. The routes were gated; the copy
 * behind them was not. The claim sat there through #289, #290 and #292 — three
 * corrections of the same family that could not see it.
 *
 * What shipped because of that (both fixed in #296):
 *   - "The badge is a non-transferable NFT" — chain-refuted; the live resource is
 *     withdrawer=AllowAll with every *_updater=DenyAll, so it is transferable and
 *     can never be made soulbound.
 *   - "You're pre-verified as an AI agent" — which ALSO evaded BANNED rule 2,
 *     because that rule needs "verified" adjacent to the noun and "pre-verified
 *     as an AI agent" puts two words in between. Two independent holes, one
 *     sentence.
 *
 * So this is a CONTENT gate rather than a response gate: it reads the copy
 * modules directly. That is cheap (no browser, no build, no server), it runs on
 * every PR, and unlike the response gates it cannot be defeated by copy that
 * needs a click to appear.
 *
 * To cover a new interaction-gated copy module (a modal, a toast catalogue, a
 * tour), add it to SOURCES below. Anything not listed here is unscanned.
 */

/** A user-visible string plus where it came from, so a failure names the step. */
interface Copy {
  where: string;
  text: string;
}

function guideCopy(): Copy[] {
  const out: Copy[] = [];
  for (const [id, guide] of Object.entries(GUIDES)) {
    out.push({ where: `GUIDES.${id}.title`, text: guide.title });
    out.push({ where: `GUIDES.${id}.description`, text: guide.description });
    guide.steps.forEach((s, i) => {
      out.push({ where: `GUIDES.${id}.steps[${i}].title`, text: s.title });
      out.push({ where: `GUIDES.${id}.steps[${i}].body`, text: s.body });
      if (s.action) out.push({ where: `GUIDES.${id}.steps[${i}].action`, text: s.action });
    });
    for (const [role, cfg] of Object.entries(guide.roles ?? {})) {
      out.push({ where: `GUIDES.${id}.roles.${role}.label`, text: cfg.label });
    }
  }
  return out;
}

function agentFastTrackCopy(): Copy[] {
  return [
    { where: "AGENT_FAST_TRACK.title", text: AGENT_FAST_TRACK.title },
    { where: "AGENT_FAST_TRACK.body", text: AGENT_FAST_TRACK.body },
    ...AGENT_FAST_TRACK.links.map((l, i) => ({
      where: `AGENT_FAST_TRACK.links[${i}].label`,
      text: l.label,
    })),
  ];
}

const SOURCES: Array<{ module: string; collect: () => Copy[] }> = [
  { module: "components/guides/guides.ts (GUIDES)", collect: guideCopy },
  { module: "components/guides/guides.ts (AGENT_FAST_TRACK)", collect: agentFastTrackCopy },
];

const ALL: Copy[] = SOURCES.flatMap((s) => s.collect());

describe("interaction-gated copy is held to the honest-copy rules", () => {
  /**
   * Anti-vacuity guard, and the most important assertion here.
   *
   * If the copy modules are restructured and the collectors silently return
   * nothing, every rule below passes over an empty list and this file becomes
   * decoration — the exact "a check that structurally cannot go red" failure
   * family honest-copy.mjs's header warns about, and the one #299's route walk
   * guards against the same way. The floor is deliberately well under the real
   * count (~40) so ordinary copy edits never trip it.
   */
  it("actually collected the copy (guards against a silently-empty scan)", () => {
    expect(ALL.length).toBeGreaterThan(25);
    expect(ALL.every((c) => typeof c.text === "string" && c.text.length > 0)).toBe(true);
  });

  it.each(BANNED.map((r: { label: string }) => [r.label, r] as const))(
    "no interaction-gated copy violates: %s",
    (_label, rule) => {
      const hits = ALL.map((c) => ({ c, hit: violation(c.text, rule) })).filter((x) => x.hit);
      expect(
        hits.map((x) => `${x.c.where}: ${JSON.stringify(x.hit)}`),
        "interaction-gated copy is invisible to BOTH deploy gates — this test is the only thing guarding it",
      ).toEqual([]);
    },
  );

  /**
   * PULL_BANNED too — the half of the rule table this file never ran.
   *
   * BANNED is only the always-on table. The SETTLEMENT-ERA family (approval
   * pays, release-to-the-worker, the missing fifth transaction) lives in
   * PULL_BANNED, and until now nothing ran it over tour copy — in the one
   * surface that has no other gate at all. launch-check scans a prerendered
   * page and cold-user.spec.ts scans a hydrated one; neither can see a string
   * that renders only after a Help-menu click.
   *
   * ⚠️ WHAT THIS DOES **NOT** CLAIM. It was added alongside a fix to
   * `tasks.description`, which shipped "is paid from on-chain escrow in XRD" —
   * false under pull, where approval CREDITS an entitlement and a separately
   * signed withdraw_worker is what deposits. This test would NOT have caught
   * that sentence. Measured, both before and after: no PULL_BANNED rule matches
   * the `paid from escrow` shape, so the string was clean against this table and
   * is clean against it still. It was found by hand.
   *
   * That is the honest split, and it is worth stating rather than implying the
   * flattering version: the MISS was a missing RULE, and this closes a missing
   * TABLE. Two different holes that happened to surface together. The rule half
   * stays open deliberately — a `paid from escrow` branch cannot be added today
   * without failing settlement-copy.test.ts's "no rule is decoration" check,
   * because zero push strings in settlement-copy.ts carry that wording to anchor
   * it (measured: 0 of 48).
   *
   * Measured before adding: all 56 collected strings clear PULL_BANNED, so this
   * lands green rather than papering over a live hit. `tourSubmitBody` — the one
   * era-varying string the tour pulls from settlement-copy.ts — stays pinned in
   * settlement-copy.test.ts's TEETH; this covers the ~55 hand-typed siblings
   * that module never sees.
   */
  it.each(PULL_BANNED.map((r: { label: string }) => [r.label, r] as const))(
    "no interaction-gated copy violates (settlement era): %s",
    (_label, rule) => {
      const hits = ALL.map((c) => ({ c, hit: violation(c.text, rule) })).filter((x) => x.hit);
      expect(
        hits.map((x) => `${x.c.where}: ${JSON.stringify(x.hit)}`),
        "settlement-era copy in a tour body is seen by NO deploy gate — this is the only one",
      ).toEqual([]);
    },
  );

  /**
   * Proves the harness can fail. Without this, a collector that returns strings
   * the rules never match would look identical to one that works.
   */
  it("catches a planted violation (the harness is able to go red)", () => {
    const planted: Copy = { where: "planted", text: "The badge is a sybil gate." };
    const anyHit = BANNED.some((r: unknown) => violation(planted.text, r));
    expect(anyHit).toBe(true);
  });

  /**
   * The same proof for the pull table, and it is not redundant: PULL_BANNED is
   * a SEPARATE array, so a bad import or a table that came back empty would let
   * every `it.each` above enumerate zero cases and pass by producing no tests at
   * all. The planted string is the verbatim /docs sentence pinned in
   * honest-copy.test.ts, so it fails here if approval-pays is ever narrowed past
   * its own anchor.
   */
  it("catches a planted PULL-era violation (the pull half can go red too)", () => {
    const planted = "When the poster approves, that same transaction pays the worker out of escrow.";
    expect(PULL_BANNED.length).toBeGreaterThan(0);
    expect(PULL_BANNED.some((r: unknown) => violation(planted, r))).toBe(true);
  });

  /** The two strings #296 removed, pinned so they cannot return unnoticed. */
  it("keeps out the exact claims that shipped here", () => {
    for (const shipped of [
      "The badge is a non-transferable NFT — it proves you're a Guild member.",
      "You're pre-verified as an AI agent.",
    ]) {
      expect(ALL.some((c) => c.text.includes(shipped))).toBe(false);
    }
  });

  /**
   * The governance-era family removed 2026-08-16 (fix/guides-claim-family).
   * Each is ALSO caught by a BANNED rule now, so this pin is belt-and-braces:
   * if a rule is loosened later, the verbatim strings still cannot come back.
   */
  it("keeps out the governance-era claims that stood here for months", () => {
    for (const shipped of [
      "Badges unlock tasks, governance, and reputation.",
      "required tier",
      "Set reward, XP bonus",
      "Reputation-weighted — your tier matters.",
      "Constitutional require 66%+",
      "Your vote weight is proportional to reputation tier.",
      "all governance-controlled. No single admin can change them.",
      "Higher tiers unlock higher-reward tasks and increase vote weight. Reputation decays with inactivity.",
      "Permanent on-chain record.",
      "revoke access",
      "Audit trail is permanent.",
    ]) {
      expect(ALL.some((c) => c.text.includes(shipped)), shipped).toBe(false);
    }
  });
});

describe("guide structure — the dialog indexes steps by role", () => {
  /**
   * GuideDialog maps `roles[r].steps` (indices) over `guide.steps`. Until
   * 2026-08-16 the mint guide (3 steps) and the admin guide (2 steps) carried
   * a copy-pasted worker role of [0, 2, 3]: `effectiveSteps[2]` was undefined
   * and `current.title` threw on the walkthrough's last click. No test read
   * the indices, so it stood since the role picker landed (51afd1e). This one
   * does.
   */
  it("every role step index points at a step that exists", () => {
    for (const [id, guide] of Object.entries(GUIDES)) {
      for (const [role, cfg] of Object.entries(guide.roles ?? {})) {
        for (const i of cfg.steps) {
          expect(
            i >= 0 && i < guide.steps.length,
            `GUIDES.${id}.roles.${role}.steps includes ${i} but the guide has ${guide.steps.length} steps`,
          ).toBe(true);
        }
        expect(cfg.steps.length, `GUIDES.${id}.roles.${role} has no steps`).toBeGreaterThan(0);
      }
    }
  });

  it("every step body is a non-empty string (the era-keyed one resolves, in this build's era)", () => {
    // tasks.steps[3].body comes from settlementCopy("tourSubmitBody") — a null
    // there would render an empty step and would mean the key vanished from
    // SETTLEMENT_COPY. Both eras of that string are gated by
    // settlement-copy.test.ts; this just proves the tour actually received one.
    for (const [id, guide] of Object.entries(GUIDES)) {
      guide.steps.forEach((s, i) => {
        expect(typeof s.body === "string" && s.body.length > 20, `GUIDES.${id}.steps[${i}].body`).toBe(true);
      });
    }
  });
});
