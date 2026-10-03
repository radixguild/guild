import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BANNED, PULL_BANNED, violation } from "../../scripts/honest-copy.mjs";
import { ESCROW_COMPONENT } from "@/lib/config";
import {
  ESCROW_COMPONENT_LEGACY,
  ESCROW_COMPONENT_HISTORY,
} from "@/lib/escrow-history";

/**
 * Tripwires for the trust-sensitive claims on /about and /docs.
 *
 * These are source-text assertions rather than render assertions on purpose:
 * both pages are large "use client" components whose content lives in
 * module-level arrays, and what needs pinning is the CLAIM, not the markup.
 * The failure these exist to prevent is silent — nothing breaks when a number
 * rots or an address goes stale, so nothing tells you. That is exactly the
 * class of bug that needs a test rather than a review.
 *
 * Background: /about's "On-Chain Verification" card linked "Task Escrow" to the
 * PAUSED v1 component while every money path ran on the vNext component (§8b
 * cutover 2026-06-14), and /docs showed the same dead address under the label
 * "TaskEscrow V2" plus a second escrow that transacts nothing. The live escrow
 * was on neither list — so the two pages that invite a reader to verify the
 * guild pointed them at contracts with no live state.
 */

const SRC = join(process.cwd(), "src");

/**
 * Strip comments before asserting on claims. A comment explaining WHY a bad
 * claim was removed necessarily quotes the bad claim — without this, the
 * no-counts guard below fires on its own changelog. Only user-visible text
 * should be able to fail these.
 */
function claimsOnly(path: string): string {
  return readFileSync(join(SRC, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ") // /* … */ and {/* … */}
    .replace(/^\s*\/\/.*$/gm, " "); // // …
}

const ABOUT = claimsOnly("app/about/page.tsx");
const DOCS = claimsOnly("app/docs/page.tsx");
const CONFIG = readFileSync(join(SRC, "lib/config.ts"), "utf8");

/** Addresses that must never be presented as the guild's escrow. */
const DEAD_ESCROWS = [
  ["v1 TaskEscrow (paused)", "component_rdx1cp8mwwe2pkrrtm05p7txgygf9y9uuwx6p87djkda8stk8nuwpyg56r"],
  ["display-only 'V3'", "component_rdx1czcjn322rhzvu4gwkculx6qvguv2erqu38mschwqkjyqtdpvpcex9s"],
  ["pre-cutover legacy", ESCROW_COMPONENT_LEGACY],
] as const;

describe("on-chain verification cards point at LIVE contracts", () => {
  it.each([
    ["/about", ABOUT],
    ["/docs", DOCS],
  ])("%s renders the live escrow component", (_page, src) => {
    // \b…\b, not toContain: "ESCROW_COMPONENT_LEGACY" CONTAINS
    // "ESCROW_COMPONENT", so a substring check would pass while the page
    // linked the dead pre-cutover address. \b fails there because "_" is a
    // word character — which is the whole point of writing it this way.
    expect(src).toMatch(/\bESCROW_COMPONENT\b/);
  });

  it.each([
    ["/about", ABOUT],
    ["/docs", DOCS],
  ])("%s does not reference a removed or legacy escrow constant", (_page, src) => {
    expect(src).not.toMatch(/\bESCROW_V1_COMPONENT\b/);
    expect(src).not.toMatch(/\bESCROW_V3_COMPONENT\b/);
    expect(src).not.toMatch(/\bESCROW_COMPONENT_LEGACY\b/);
  });

  it.each(
    DEAD_ESCROWS.flatMap(([label, addr]) =>
      [
        ["/about", ABOUT],
        ["/docs", DOCS],
      ].map(([page, src]) => ({ page, src, label, addr })),
    ),
  )("$page never hard-codes the $label address", ({ src, addr }) => {
    expect(src).not.toContain(addr);
  });

  it("the removed constants are gone from config.ts, not just unused", () => {
    // Deleted rather than left dangling: a display-only address constant next
    // to the real one is a trap for the next person wiring a verify link.
    expect(CONFIG).not.toMatch(/^export const ESCROW_V1_COMPONENT/m);
    expect(CONFIG).not.toMatch(/^export const ESCROW_V3_COMPONENT/m);
    // And no RETIRED component address as a literal, anywhere in config.ts.
    // This is the CI-side half of launch-check CHECK 7 ("exactly one escrow
    // component is baked into the artifact"). On 2026-08-18 #404 added
    // ESCROW_COMPONENT_HISTORY here as a module-scope Object.freeze — which the
    // bundler will not drop — so three components reached the build and the gate
    // failed the deploy CLOSED on a correct build. CI could not have caught it:
    // launch-check inspects the BUILT artifact on the box, and nothing in CI
    // builds and greps it. This assertion moves that detection to the PR.
    // Retired addresses belong in src/lib/escrow-history.ts, which app code
    // never imports. Full literals only — the truncated `…cz9mh49…` in a comment
    // is fine, since comments do not survive minification.
    // Iterate ESCROW_COMPONENT_HISTORY, NOT DEAD_ESCROWS. DEAD_ESCROWS covers
    // v1 + the display-only V3 + the pre-cutover legacy, and does NOT include the
    // push component — so a DEAD_ESCROWS-based check stays GREEN against the exact
    // regression this guard exists for. That was written, mutation-tested, and
    // found useless before this line replaced it. The history array is the
    // authoritative retired set and grows at every cutover.
    for (const addr of [
      ...ESCROW_COMPONENT_HISTORY,
      ...DEAD_ESCROWS.map(([, a]) => a),
    ]) {
      expect(CONFIG, `config.ts must not carry retired address ${addr}`).not.toContain(addr);
    }
  });

  it("the live escrow is the Wave B component, not a retired one", () => {
    // Guards the guard: if ESCROW_COMPONENT itself were ever pointed at a dead
    // address, every assertion above would still pass while the pages lied.
    //
    // ⚠️ Update this in the SAME commit as config.ts at every cutover. Until
    // 2026-08-17 it pinned the push component `…cr690h`, which meant CI actively
    // ENFORCED a retired address as the app default — the correct fix would have
    // failed this test. It then did the same thing again: from the Wave B
    // cutover (2026-09-13) until 2026-09-14 it pinned the retired PULL component
    // `…akd82f`, and config.ts's default sat there with it, green. A guard that
    // pins a literal is only as fresh as the commit that moves it, which is the
    // cost of it being a real guard — escrow-address-drift.test.ts is the
    // literal-free half, checking config.ts against docs/ESCROW-ADDRESSES.md.
    expect(ESCROW_COMPONENT).toBe(
      "component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly",
    );
    expect(ESCROW_COMPONENT).not.toBe(ESCROW_COMPONENT_LEGACY);
    // And never any retired component, so appending to the history is enough.
    expect(ESCROW_COMPONENT_HISTORY).not.toContain(ESCROW_COMPONENT);
  });
});

describe("/about carries no hand-maintained counts", () => {
  it("has no stat grid claiming commits / tests / endpoints / pages / commands", () => {
    // Every one of these had drifted, two into OVERCLAIMING ("33 endpoints" for
    // 28, "37 bot commands" for 31) on a page arguing "verify everything".
    // Numbers nothing can falsify are numbers that rot. If you want to state a
    // count, make something compute it.
    const claims = ABOUT.match(
      /\b\d+\+?\s*(?:automated\s+)?(?:commits|tests|endpoints|commands|pages)\b/gi,
    );
    expect(claims ?? []).toEqual([]);
  });

  it("does not carry a second biography — /bigdev is the one bio", () => {
    expect(ABOUT).toContain('href="/bigdev"');
    // The old card's opening claim. Two bios drift; one does not.
    expect(ABOUT).not.toContain("Full-stack Web3 developer");
  });
});

describe("/about privacy + stack claims match the code", () => {
  it("names PostgreSQL, not SQLite alone, for dashboard data", () => {
    // src/db/index.ts is drizzle-orm/postgres-js and throws without
    // DATABASE_URL; SQLite is the BOT's store. The page used to say all data
    // lived "in a SQLite database" — wrong about the database it named.
    expect(ABOUT).toContain("PostgreSQL");
    expect(ABOUT).not.toMatch(/stored in a SQLite database/);
  });

  it("does not claim there are no cookies", () => {
    // auth.ts:setSessionCookie sets an httpOnly JWT session cookie. The flat
    // "no cookies" claim was falsifiable in one devtools click.
    expect(ABOUT).not.toMatch(/does not use cookies/);
    expect(ABOUT).toMatch(/session cookie/i);
  });

  it("does not present CV2 vote-casting as shipped", () => {
    // features.ts: cv2Writes defaults OFF — the ABI is unverified and a vote
    // would land as a CommittedFailure.
    expect(ABOUT).not.toMatch(/formal on-chain \(CV2\)/);
  });
});

describe("/about Risk Disclosure — dispute posture (era-keyed at P3-3/DB-5, 2026-08-27)", () => {
  // The disclosure moved from inline JSX into DISPUTE_COPY so the SAME
  // build-time flag that mounts the dispute buttons picks the paragraph — the
  // old inline version asked for lockstep by hand ("this text must change in
  // the same commit") and the 2026-08-27 audit found that about to fail.
  // These assert on the MODULE STRINGS directly (no source-formatting trap:
  // strings, not JSX) plus one wiring check that the page renders the key.

  it("the real flag module defaults disputes OFF with the env unset (this run)", async () => {
    const { isEnabled } = await import("@/lib/features");
    expect(process.env.NEXT_PUBLIC_FEATURE_DISPUTES).toBeUndefined();
    // The P3-3 posture is carried by .env.example + launch-check's inverted
    // gate, NOT by a code-default flip — an unset env must still mean OFF.
    expect(isEnabled("disputes")).toBe(false);
  });

  it("the page renders the era-keyed disclosure key", () => {
    expect(ABOUT).toContain('disputeCopy("aboutDisputeDisclosure")');
  });

  it("OFF form: discloses the surface is off, synonym-tolerant", async () => {
    const { DISPUTE_COPY } = await import("@/lib/settlement-copy");
    expect(DISPUTE_COPY.aboutDisputeDisclosure.off).toMatch(
      /dispute resolution is (disabled|switched off)|disputes are (disabled|turned off|switched off)/i
    );
  });

  it("ON form: states the DB-5 terms plainly — 50/50 of the reward, insurance home, no public SLA, dispute is the worse move on mere silence", async () => {
    const { DISPUTE_COPY } = await import("@/lib/settlement-copy");
    const on = DISPUTE_COPY.aboutDisputeDisclosure.on!;
    expect(on).toMatch(/dispute resolution is live/i);
    expect(on).toMatch(/50\s*\/\s*50/);
    expect(on).toMatch(/insurance returning to them in full/i);
    expect(on).toMatch(/no public SLA/i);
    // The honest limit the audit demanded stated, not hidden: a dispute
    // recovers HALF, not all of it. Wave B (2026-09-13) added a
    // review-window auto-release, so a dispute is no longer the worker's
    // only on-chain escape from a silent poster — it is now the worse of
    // the two, which this form must say plainly rather than omit.
    expect(on).toMatch(/half the reward, not all of it/i);
  });

  it("neither form promises a turnaround time nobody has committed to", async () => {
    const { DISPUTE_COPY } = await import("@/lib/settlement-copy");
    for (const era of ["off", "on"] as const) {
      const text = DISPUTE_COPY.aboutDisputeDisclosure[era];
      if (text == null) continue;
      expect(text).not.toMatch(/within \d+\s*(hours?|days?)[^.!?]{0,40}(arbiter|rul)/i);
      expect(text).not.toMatch(/we (will|commit to) (rule|respond)[^.!?]{0,30}within/i);
    }
  });

  it("states the FACT, never the mechanism — no exploit recipe on a public page", async () => {
    // Decided disclosure posture (fact, not mechanism): naming HOW the dispute
    // path could be gamed would be a working recipe against any task reaching
    // Disputed. These substrings are the mechanism; none may appear in the
    // page source NOR in either era's disclosure string.
    const { DISPUTE_COPY } = await import("@/lib/settlement-copy");
    const surfaces = [
      ABOUT, // comments already stripped by claimsOnly()
      DISPUTE_COPY.aboutDisputeDisclosure.off ?? "",
      DISPUTE_COPY.aboutDisputeDisclosure.on ?? "",
    ];
    for (const leak of [
      "auto_resolve_dispute",
      "no-auth",
      "no auth",
      "caller's manifest",
      "caller manifest",
      "raise_dispute",
      "drains",
      "route both buckets",
    ]) {
      for (const surface of surfaces) {
        expect(surface.toLowerCase()).not.toContain(leak.toLowerCase());
      }
    }
  });
});

describe("/about says why the Guild exists, near the top, without overclaiming", () => {
  // Visible text only (comments already stripped), JSX line breaks collapsed.
  const text = ABOUT.replace(/\s+/g, " ");
  const PURPOSE =
    "Radix Guild is an independent project that exists to help Radix core developers carry the workload of building Radix, by giving that work a place to be commissioned, done and paid.";

  it("opens the Mission card with the purpose sentence, before anything else on the page", () => {
    expect(text).toContain(PURPOSE);
    const at = text.indexOf(PURPOSE);
    expect(at).toBeLessThan(text.indexOf("What the Guild Offers"));
    expect(at).toBeLessThan(text.indexOf("Open temperature check"));
    expect(at).toBeLessThan(text.indexOf("The Operator"));
  });

  it("states the aim, not a result, and does not read as official or endorsed", () => {
    expect(PURPOSE).toMatch(/\bindependent\b/);
    expect(PURPOSE).not.toMatch(
      /\b(official|officially|endorsed|partner(ed|ship)?|backed by|affiliated with|used by|trusted by|relied on|already (helps|carries))\b/i,
    );
  });

  it("clears the honest-copy rule table", () => {
    const hits: string[] = [];
    for (const rule of [...BANNED, ...PULL_BANNED]) {
      const v = violation(PURPOSE, rule);
      if (v) hits.push(`${rule.label} :: ${v}`);
    }
    expect(hits).toEqual([]);
  });
});
