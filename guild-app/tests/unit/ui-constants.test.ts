import { describe, it, expect } from "vitest";
import {
  TIER_COLORS,
  ECOSYSTEM_LINKS,
  RESOURCES,
  type EcosystemLink,
} from "@/lib/ui-constants";
import { SCHEMAS } from "@/lib/schemas";

/**
 * Coverage for src/lib/ui-constants.ts — a data-only module with no tests to
 * date. Every exported value gets a shape/type assertion plus the invariants
 * the module's own comments (and its real consumers, per `git grep -n
 * "ui-constants"`) depend on:
 *
 * - TIER_COLORS is read by badge-card.tsx, tier-progression.tsx,
 *   app-shell.tsx, admin/page.tsx and profile/[address]/page.tsx, always as
 *   `TIER_COLORS[tier] || "var(--muted)"` — a missing key silently falls
 *   back to muted rather than erroring, so the useful guard is "every tier
 *   SCHEMAS can mint still has a color".
 * - ECOSYSTEM_LINKS is read by app/about/page.tsx, which branches its Badge
 *   variant on `status === "Active"`. Its own inline comment (2026-08-29)
 *   states CrumbsUp was removed and superseded by Muan Protocol and must not
 *   be re-added.
 * - RESOURCES is read by app/page.tsx, which branches on
 *   `url.startsWith("/")` to choose a Next `<Link>` vs. an external `<a>` —
 *   every url must satisfy one side of that branch.
 */

describe("TIER_COLORS", () => {
  const EXPECTED_TIERS = [
    "member",
    "contributor",
    "builder",
    "steward",
    "elder",
    "admin",
    "moderator",
  ];

  it("is a plain object (not an array), keyed by tier name", () => {
    expect(typeof TIER_COLORS).toBe("object");
    expect(TIER_COLORS).not.toBeNull();
    expect(Array.isArray(TIER_COLORS)).toBe(false);
  });

  it("has exactly the expected tier keys", () => {
    expect(Object.keys(TIER_COLORS).sort()).toEqual([...EXPECTED_TIERS].sort());
  });

  it.each(Object.entries(TIER_COLORS))(
    "%s maps to a var(--guild-tier-*) string",
    (_tier, value) => {
      expect(typeof value).toBe("string");
      expect(value).toMatch(/^var\(--guild-tier-[a-z]+\)$/);
    },
  );

  it("pins the exact current color mapping (regression guard)", () => {
    expect(TIER_COLORS).toEqual({
      member: "var(--guild-tier-member)",
      contributor: "var(--guild-tier-contributor)",
      builder: "var(--guild-tier-builder)",
      steward: "var(--guild-tier-steward)",
      elder: "var(--guild-tier-elder)",
      admin: "var(--guild-tier-elder)",
      moderator: "var(--guild-tier-steward)",
    });
  });

  it("aliases admin to the elder color and moderator to the steward color", () => {
    expect(TIER_COLORS.admin).toBe(TIER_COLORS.elder);
    expect(TIER_COLORS.moderator).toBe(TIER_COLORS.steward);
  });

  it("covers every tier SCHEMAS can mint, so no badge tier falls back to var(--muted)", () => {
    const usedTiers = new Set(Object.values(SCHEMAS).flatMap((s) => s.tiers));
    expect(usedTiers.size).toBeGreaterThan(0);
    for (const tier of usedTiers) {
      expect(TIER_COLORS[tier], `TIER_COLORS is missing a color for tier "${tier}"`).toBeDefined();
    }
  });
});

describe("ECOSYSTEM_LINKS", () => {
  it("accepts an object with exactly the EcosystemLink fields (type-level check)", () => {
    // If the `EcosystemLink` interface ever drops/renames a field, this
    // object literal stops satisfying the type and `bun run typecheck`
    // (tsc --noEmit) fails — vitest itself does not type-check by default.
    const sample: EcosystemLink = {
      name: "x",
      desc: "y",
      url: "https://example.com",
      pill: "g-pill-blue",
      status: "Planned",
    };
    expect(sample).toEqual({
      name: "x",
      desc: "y",
      url: "https://example.com",
      pill: "g-pill-blue",
      status: "Planned",
    });
  });

  it("is a non-empty array whose entries have every field as a non-empty string", () => {
    expect(Array.isArray(ECOSYSTEM_LINKS)).toBe(true);
    expect(ECOSYSTEM_LINKS.length).toBeGreaterThan(0);
    for (const link of ECOSYSTEM_LINKS) {
      for (const field of ["name", "desc", "url", "pill", "status"] as const) {
        expect(typeof link[field], `${link.name}.${field}`).toBe("string");
        expect(link[field].length, `${link.name}.${field} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("every url is a parseable https:// URL (all current entries are external)", () => {
    for (const link of ECOSYSTEM_LINKS) {
      expect(() => new URL(link.url), link.url).not.toThrow();
      expect(link.url, link.url).toMatch(/^https:\/\//);
    }
  });

  it("every pill is a g-pill-<color> class name", () => {
    for (const link of ECOSYSTEM_LINKS) {
      expect(link.pill, link.name).toMatch(/^g-pill-[a-z]+$/);
    }
  });

  it("has unique names", () => {
    const names = ECOSYSTEM_LINKS.map((l) => l.name);
    expect(new Set(names).size).toBe(names.length);
  });

  describe("the CrumbsUp -> Muan DAO-venue swap (module comment, 2026-08-29)", () => {
    it("contains no entry named CrumbsUp", () => {
      const names = ECOSYSTEM_LINKS.map((l) => l.name.toLowerCase());
      expect(names).not.toContain("crumbsup");
    });

    // 2026-09-20: the Muan Protocol entry was REMOVED, not the ruling behind it. Its only
    // URL, https://muanprotocol.com, serves an expired TLS certificate, so the homepage link
    // put a browser security warning in front of visitors. Muan is still the chosen DAO
    // venue ("not yet stood up"); re-add the entry when the site's certificate is valid.
    it("lists no Muan Protocol entry while its only URL serves an expired certificate", () => {
      expect(ECOSYSTEM_LINKS.filter((l) => l.name === "Muan Protocol")).toHaveLength(0);
    });
  });

  it("pins the exact current list (regression guard)", () => {
    expect(ECOSYSTEM_LINKS).toEqual([
      { name: "RadixTalk", desc: "Community forum", url: "https://radixtalk.com", pill: "g-pill-blue", status: "Link" },
      { name: "Radix Wiki", desc: "Community wiki + ecosystem directory", url: "https://radix.wiki/ecosystem", pill: "g-pill-blue", status: "Link" },
    ]);
  });

  // bigdev, 2026-09-24: list only what is live or actually decided. "Astra AI — Planned"
  // had no ruling or integration behind it; a "Planned" pill on an external product reads
  // as a commitment the Guild never made.
  it("lists no entry marked Planned", () => {
    expect(ECOSYSTEM_LINKS.filter((l) => l.status === "Planned")).toHaveLength(0);
  });
});

describe("RESOURCES", () => {
  it("is a non-empty array whose entries have name/url/desc as non-empty strings", () => {
    expect(Array.isArray(RESOURCES)).toBe(true);
    expect(RESOURCES.length).toBeGreaterThan(0);
    for (const r of RESOURCES) {
      for (const field of ["name", "url", "desc"] as const) {
        expect(typeof r[field], `${r.name}.${field}`).toBe("string");
        expect(r[field].length, `${r.name}.${field} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("every url is either an internal absolute path or an https:// URL (app/page.tsx branches on this)", () => {
    for (const r of RESOURCES) {
      const isInternalPath = r.url.startsWith("/");
      const isExternalUrl = r.url.startsWith("https://");
      expect(isInternalPath || isExternalUrl, `${r.name}: ${r.url}`).toBe(true);
    }
  });

  it("has unique names", () => {
    const names = RESOURCES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("contains exactly one Radix DAO link (operator ruling 2026-08-29: one reference link, nothing else)", () => {
    const daoLinks = RESOURCES.filter((r) => r.name === "Radix DAO");
    expect(daoLinks).toHaveLength(1);
    // Not radixdao.org: the standing 2026-08-26 decision not to link it holds until
    // ratification AND official cross-linking (docs/PROJECT-STATE.md 2026-08-29 block).
    expect(daoLinks[0].url).toBe("https://github.com/RadixDAO/governance-framework");
    expect(RESOURCES.some((r) => r.url.includes("radixdao.org"))).toBe(false);
  });

  it("pins the exact current list (regression guard)", () => {
    expect(RESOURCES).toEqual([
      { name: "Docs & FAQ", url: "/docs", desc: "Reference, bot commands, costs, FAQ" },
      { name: "How it works", url: "/guide#how-it-works", desc: "The marketplace flow, on the getting-started guide" },
      { name: "Auditor's guide", url: "/auditor-guide", desc: "State machine, trust claims, verification recipes" },
      { name: "Trust & verification", url: "/trust", desc: "Known issues first, then what you can check on-chain" },
      { name: "Transparency", url: "/docs#transparency", desc: "Costs, on-chain verification, source plan" },
      { name: "Radix DAO", url: "https://github.com/RadixDAO/governance-framework", desc: "External — the Radix DAO's governance framework" },
      { name: "MVD Discussion", url: "https://radixtalk.com/t/design-our-minimum-viable-dao-mvd/2258", desc: "Minimum Viable DAO" },
    ]);
  });
});
