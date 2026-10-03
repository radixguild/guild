// UI-specific constants: colors, links, quick actions

export const TIER_COLORS: Record<string, string> = {
  member: "var(--guild-tier-member)",
  contributor: "var(--guild-tier-contributor)",
  builder: "var(--guild-tier-builder)",
  steward: "var(--guild-tier-steward)",
  elder: "var(--guild-tier-elder)",
  admin: "var(--guild-tier-elder)",
  moderator: "var(--guild-tier-steward)",
};

export interface EcosystemLink {
  name: string;
  desc: string;
  url: string;
  pill: string;
  status: string;
}

export const ECOSYSTEM_LINKS: EcosystemLink[] = [
  { name: "RadixTalk", desc: "Community forum", url: "https://radixtalk.com", pill: "g-pill-blue", status: "Link" },
  { name: "Radix Wiki", desc: "Community wiki + ecosystem directory", url: "https://radix.wiki/ecosystem", pill: "g-pill-blue", status: "Link" },
  // ⚠️ CrumbsUp REMOVED 2026-08-29. It was never integrated — the entry was a
  // link to a third-party DAO portal where a Guild entry happened to exist,
  // which is not the same as the Guild using it for anything. Muan is the
  // chosen DAO venue and supersedes it; carrying both implied a live choice
  // between two venues that was in fact already made. Do not re-add CrumbsUp
  // without an actual integration to point at.
  // ⚠️ Removed 2026-09-20: "Muan Protocol" → https://muanprotocol.com serves an EXPIRED TLS
  // certificate (curl ssl_verify_result 10; http:// 301s to the same broken https://), so the
  // link put a browser security warning in front of a homepage visitor. It was "Planned — not
  // yet stood up" anyway. Re-add when the venue exists and its certificate is valid.
  // ⚠️ Removed 2026-08-21: "Radix Consultation" → consultation.radixdlt.com is
  // NXDOMAIN (not a 404 — the host does not resolve). It shipped with the only
  // GREEN pill in this list, so the one entry a cold visitor was most steered
  // toward was the one that went nowhere. Resolve the domain before re-adding.
  // ⚠️ Removed 2026-09-24 (bigdev: list only what is live or actually decided): "Astra AI —
  // Astrolescent assistant — Planned". No ruling or integration stood behind "Planned".
];

export const RESOURCES = [
  // "Getting started" moved OUT of this description 2026-08-21 with the /docs
  // retitle: /guide owns getting started, /docs is the reference and the FAQ.
  { name: "Docs & FAQ", url: "/docs", desc: "Reference, bot commands, costs, FAQ" },
  { name: "How it works", url: "/guide#how-it-works", desc: "The marketplace flow, on the getting-started guide" },
  { name: "Auditor's guide", url: "/auditor-guide", desc: "State machine, trust claims, verification recipes" },
  { name: "Trust & verification", url: "/trust", desc: "Known issues first, then what you can check on-chain" },
  { name: "Transparency", url: "/docs#transparency", desc: "Costs, on-chain verification, source plan" },
  // The single Radix DAO link. Operator ruling 2026-08-29: the DAO is external
  // and not the Guild's concern — one reference link, nothing else. If you are
  // adding a second DAO link, stop.
  //
  // ⚠️ Repointed 2026-09-23 from radixdao.org to the framework repo. #471
  // (2026-08-31) had moved it to radixdao.org, which walked into the STANDING
  // 2026-08-26 decision not to link that site (docs/PROJECT-STATE.md, the
  // 2026-08-26 and 2026-08-29 blocks): pre-formation, and the revisit condition —
  // ratification AND official cross-linking — is still unmet (GP-PRE-1 vote not
  // opened, checked 2026-09-23). The framework repo is the authoritative source
  // the 2026-08-29 sitting named, and it claims nothing about the Guild.
  { name: "Radix DAO", url: "https://github.com/RadixDAO/governance-framework", desc: "External — the Radix DAO's governance framework" },
  // ⚠️ Removed 2026-08-21: "Guild Discourse" → radix-guild.discourse.group is
  // NXDOMAIN. The Telegram group is the live discussion surface; it is already
  // linked from the nav and the Ecosystem card, so nothing replaces this row.
  { name: "MVD Discussion", url: "https://radixtalk.com/t/design-our-minimum-viable-dao-mvd/2258", desc: "Minimum Viable DAO" },
];
