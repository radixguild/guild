// AG-13 drift guard: the SDK's default escrow addresses must agree with the
// two other places that also claim to know them — docs/ESCROW-ADDRESSES.md
// (the chain-verified canonical record) and guild-app/src/lib/config.ts (the
// app this SDK submits the SAME manifests against, per manifests.test.ts's
// byte-parity guard). All three drifted apart silently at the 2026-09-13 Wave
// B cutover: this package's config.ts kept the retired PULL addresses for a
// full day before an agent-lane audit caught it (AG-13), not CI. This file is
// what makes the next cutover fail loud instead of silent.
//
// Mirrors manifests.test.ts's cross-package parity guard on purpose: sibling
// sources are read/imported DYNAMICALLY (never hand-copied into this file as
// literal "expected" values — a hand-copied value is just a fourth place to
// forget to update), the STANDALONE/GUILD_NO_SIBLING escape hatch is
// identical, and a disarmed guard THROWS instead of silently skipping. See
// that file's header for why "disarm silently" was a real, previously
// shipped bug in this repo (a HAS_SERVER existsSync flag that quietly went
// false and turned every parity assertion into a no-op) and not a
// hypothetical worth waving off here.

import { describe, test, expect, beforeAll } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STANDALONE = !!process.env.GUILD_NO_SIBLING;

const CONFIG = loadConfig();

// ── private-input guard, inlined (this package can't import guild-app's
// tests/support/private-input.ts — see this file's task header — so the
// same logic is duplicated here rather than factored into a new src file,
// which would change the published kit tarball and need a version bump).
//
// docs/ESCROW-ADDRESSES.md stays EXCLUDE at the open-source flip
// (publish/MANIFEST.md), so the 5 tests below that compare against it must
// SKIP in the public export and still run — and fail loudly if the doc goes
// missing for any other reason — in the private tree. "Private tree" = the
// exporter (publish/extract-snapshot.mjs) is present; the export never
// carries its own exporter. GUILD_SIMULATE_PUBLIC_EXPORT=1 treats the doc as
// absent and the tree as public, for checking this skips cleanly without
// running a real export.
//
// GUILD_REQUIRE_PRIVATE_INPUTS=1 is the strict switch, same rule as
// private-input.ts: a missing doc THROWS in every tree, exporter or not. The ops
// repo's composed tree (the public tree plus the private files) has no publish/,
// so without it this file would skip there and the composed check would pass
// having checked nothing (post-flip topology note §5.6, private operations repository, F16). "1" turns
// it on; unset, "" and "0" leave it off; any other value throws, so a typo cannot
// leave it off. GUILD_NO_SIBLING reads no doc at all, so the two together are
// refused rather than allowed to pass vacuously.
// src/escrow-address-drift-strict.test.ts runs this file under each switch.
const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const SIMULATE_PUBLIC = process.env.GUILD_SIMULATE_PUBLIC_EXPORT === '1';
const REQUIRE_SWITCH = process.env.GUILD_REQUIRE_PRIVATE_INPUTS;
if (REQUIRE_SWITCH !== undefined && !['', '0', '1'].includes(REQUIRE_SWITCH)) {
  throw new Error(
    `GUILD_REQUIRE_PRIVATE_INPUTS must be "1" (strict) or unset/"0" (off), not ${JSON.stringify(REQUIRE_SWITCH)}: ` +
      'refusing to guess whether a missing private input may skip.'
  );
}
const REQUIRE_PRIVATE_INPUTS = REQUIRE_SWITCH === '1';
if (REQUIRE_PRIVATE_INPUTS && STANDALONE) {
  throw new Error(
    'GUILD_REQUIRE_PRIVATE_INPUTS=1 with GUILD_NO_SIBLING: a standalone run reads no private input, ' +
      'so the strict check would pass having checked nothing. Unset one of them.'
  );
}
const PRIVATE_TREE = !SIMULATE_PUBLIC && existsSync(join(REPO_ROOT, 'publish', 'extract-snapshot.mjs'));
const DOC_ABSENT = !STANDALONE && (SIMULATE_PUBLIC || !existsSync(join(REPO_ROOT, 'docs', 'ESCROW-ADDRESSES.md')));
if (DOC_ABSENT && PRIVATE_TREE) {
  throw new Error(
    'private test input missing from the PRIVATE tree: docs/ESCROW-ADDRESSES.md — renamed or deleted? ' +
      'A test may only skip for it in the public export.'
  );
}
if (DOC_ABSENT && REQUIRE_PRIVATE_INPUTS) {
  throw new Error(
    'private test input missing under GUILD_REQUIRE_PRIVATE_INPUTS=1: docs/ESCROW-ADDRESSES.md — ' +
      'this tree must carry every private input; only the plain public export may skip.'
  );
}
const SKIP_DOC = DOC_ABSENT;

// ── guild-app/src/lib/config.ts — same dynamic-import shape as
// manifests.test.ts's SERVER_SPEC, for the same reason: a string-literal
// relative import would TS2307 in a standalone checkout, and the whole point
// is to read the sibling's CURRENT exports, not a value copied from them at
// the time this file was written.
const APP_CONFIG_SPEC = '../../../guild-app/src/lib/config';
const APP_CONFIG_EXPORTS = [
  'ESCROW_COMPONENT',
  'ESCROW_CLAIM_RECEIPT_RESOURCE',
  'ESCROW_RECEIPT_RESOURCE',
  'BADGE_NFT',
  'MANAGER',
  'DAPP_DEF',
  'NFT_SWAP_COMPONENT',
] as const;
type AppConfig = Record<(typeof APP_CONFIG_EXPORTS)[number], string>;
let appConfig: AppConfig | null = null;
let appConfigError: string | null = null;

// ── docs/ESCROW-ADDRESSES.md — the canonical, chain-verified record (its own
// header: every Wave B row was read back from the Gateway at the 2026-09-13
// ceremony). Read as text and scraped below, not hand-copied, same reasoning.
const DOC_PATH = resolve(HERE, '../../../docs/ESCROW-ADDRESSES.md');
let docText: string | null = null;
let docError: string | null = null;

beforeAll(async () => {
  if (STANDALONE) return;
  try {
    const m = (await import(APP_CONFIG_SPEC)) as Record<string, unknown>;
    const missing = APP_CONFIG_EXPORTS.filter((k) => typeof m[k] !== 'string');
    if (missing.length) {
      appConfigError = `guild-app config.ts resolved, but these exports are missing or not strings: ${missing.join(', ')}`;
    } else {
      appConfig = m as unknown as AppConfig;
    }
  } catch (err) {
    appConfigError = `could not import guild-app's config via "${APP_CONFIG_SPEC}" — ${(err as Error).message}`;
  }

  if (!SKIP_DOC) {
    try {
      docText = readFileSync(DOC_PATH, 'utf8');
    } catch (err) {
      docError = `could not read docs/ESCROW-ADDRESSES.md at "${DOC_PATH}" — ${(err as Error).message}`;
    }
  }
});

function requireDoc(): string {
  if (docError || docText === null) throw new Error(`drift guard disarmed (doc): ${docError}`);
  return docText;
}
function requireAppConfig(): AppConfig {
  if (appConfigError || appConfig === null) {
    throw new Error(`drift guard disarmed (guild-app config): ${appConfigError}`);
  }
  return appConfig;
}

describe('the drift guard itself', () => {
  // Runs first, so a disarmed harness is reported as its own named failure
  // rather than as a confusing cascade of address mismatches below.
  test('is armed — guild-app config.ts loaded', () => {
    if (STANDALONE) {
      expect(process.env.GUILD_NO_SIBLING).toBeTruthy();
      return;
    }
    expect(appConfigError).toBeNull();
    expect(appConfig).not.toBeNull();
  });

  // Split from the check above: docs/ESCROW-ADDRESSES.md stays EXCLUDE in the
  // public export, so this half alone skips there.
  test.skipIf(STANDALONE || SKIP_DOC)('is armed — docs/ESCROW-ADDRESSES.md loaded', () => {
    expect(docError).toBeNull();
    expect(docText).not.toBeNull();
  });
});

/**
 * Scrape the address of the one "🟢 LIVE" row in a doc table section, keyed
 * by a NAME SUBSTRING rather than a cutover label ("Wave B", "PULL", …).
 * Anchoring on the doc's own live/retired-glyph convention is what survives
 * the NEXT rename; anchoring on today's cutover name is exactly the kind of
 * thing that silently stops matching at the one after that.
 *
 * The live/retired check matches on `**LIVE` after skipping a handful of
 * leading non-word characters, rather than on the 🟢/⚰️ glyphs themselves —
 * deliberately: it is one transcription risk fewer (an emoji retyped by hand
 * can silently carry a different variation selector than the source file's),
 * and every LIVE row in this doc opens with "**LIVE" regardless of which
 * glyph precedes it. Verified against the live file (all five rows this
 * module scrapes) before being written into this test.
 *
 * Throws — loud, like `requireDoc`/`requireAppConfig` above — when the
 * section is missing or the live-row count isn't exactly 1. Both are real
 * drift signals: zero means nothing is marked live (or the doc's structure
 * changed under this parser), more than one means either the doc contradicts
 * itself or this parser is too loose to trust; either way, silently picking
 * one would defeat the point of a drift guard.
 */
function scrapeLiveAddress(
  doc: string,
  sectionHeader: string,
  nameContains: string,
  addressPrefix: 'component_rdx' | 'resource_rdx' | 'package_rdx'
): string {
  const section = docSection(doc, sectionHeader);
  const rowRe = new RegExp(`^\\|\\s*\`(${addressPrefix}[a-z0-9]+)\`\\s*\\|([^|]*)\\|([^|]*)\\|`, 'gm');
  const all = [...section.matchAll(rowRe)].map((m) => ({
    address: m[1],
    name: m[2].trim(),
    status: m[3].trim(),
  }));
  const candidates = all.filter((r) => r.name.includes(nameContains));
  const isLiveStatus = (status: string) => /^[^\w]{0,4}\*\*LIVE\b/.test(status);
  const live = candidates.filter((r) => isLiveStatus(r.status));
  if (live.length !== 1) {
    throw new Error(
      `ESCROW-ADDRESSES.md "${sectionHeader}": expected exactly one LIVE row for "${nameContains}", ` +
        `found ${live.length} (of ${candidates.length} candidates: ${JSON.stringify(candidates.map((c) => c.name))})`
    );
  }
  return live[0].address;
}

/**
 * The counterpart for an address that carries NO live/retired marker because
 * it is stable across cutovers (e.g. the worker badge has been the same
 * BadgeFactory resource since before any escrow component existed) — this
 * just requires exactly one matching row in the section, full stop.
 */
function scrapeStableAddress(
  doc: string,
  sectionHeader: string,
  nameContains: string,
  addressPrefix: 'component_rdx' | 'resource_rdx' | 'package_rdx'
): string {
  const section = docSection(doc, sectionHeader);
  const rowRe = new RegExp(`^\\|\\s*\`(${addressPrefix}[a-z0-9]+)\`\\s*\\|([^|]*)\\|`, 'gm');
  const matches = [...section.matchAll(rowRe)].filter((m) => m[2].includes(nameContains));
  if (matches.length !== 1) {
    throw new Error(
      `ESCROW-ADDRESSES.md "${sectionHeader}": expected exactly one row for "${nameContains}", found ${matches.length}`
    );
  }
  return matches[0][1];
}

/** The text between a `### Heading` and the next `##`/`###` heading (or EOF). */
function docSection(doc: string, sectionHeader: string): string {
  const start = doc.indexOf(`\n${sectionHeader}\n`);
  if (start === -1) {
    throw new Error(`ESCROW-ADDRESSES.md: section "${sectionHeader}" not found — the doc's structure changed`);
  }
  const rest = doc.slice(start + sectionHeader.length + 2);
  const nextHeading = rest.search(/\n#{2,3} /);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

describe.skipIf(SKIP_DOC)('SDK defaults vs docs/ESCROW-ADDRESSES.md (canonical, chain-verified)', () => {
  test('escrowComponent matches the LIVE EscrowComponent row', () => {
    if (STANDALONE) return;
    const doc = requireDoc();
    expect(CONFIG.escrowComponent).toBe(scrapeLiveAddress(doc, '### Components', 'EscrowComponent', 'component_rdx'));
  });

  test('claimReceiptResource matches the LIVE Claim Receipt row', () => {
    if (STANDALONE) return;
    const doc = requireDoc();
    expect(CONFIG.claimReceiptResource).toBe(
      scrapeLiveAddress(doc, '### Receipt NFTs', 'Claim Receipt', 'resource_rdx')
    );
  });

  // Added for P1-19 (poster SDK): GuildClientConfig now carries a
  // taskReceiptResource field (the poster's approve/cancel/withdraw proof),
  // exactly the case this section's old comment said to watch for — "If a
  // future change gives this SDK a reason to carry one of those, add its row
  // here in the SAME commit."
  test('taskReceiptResource matches the LIVE Task Receipt row', () => {
    if (STANDALONE) return;
    const doc = requireDoc();
    expect(CONFIG.taskReceiptResource).toBe(
      scrapeLiveAddress(doc, '### Receipt NFTs', 'Task Receipt', 'resource_rdx')
    );
  });

  test('workerBadgeResource matches the WORKER BADGE ONLY row', () => {
    if (STANDALONE) return;
    const doc = requireDoc();
    expect(CONFIG.workerBadgeResource).toBe(
      scrapeStableAddress(doc, '### Badge Resources', 'WORKER BADGE ONLY', 'resource_rdx')
    );
  });

  // escrowPackage / arbiterBadgeResource are still NOT compared here:
  // GuildClientConfig has no field for either (no manifest builder in this
  // package ever dereferences a package address, and the arbiter badge is an
  // arbiter concern, not a poster/worker one). If a future change gives this
  // SDK a reason to carry one of those, add its row here in the SAME commit —
  // that omission is the whole lesson AG-13 is named after.
});

describe('SDK defaults vs guild-app/src/lib/config.ts', () => {
  // ⚠️ This block previously read "KNOWN FAILING as of 2026-09-14
  // (escrowComponent + claimReceiptResource below): guild-app's OWN
  // ESCROW_COMPONENT / ESCROW_CLAIM_RECEIPT_RESOURCE defaults are ALSO still
  // on the retired PULL addresses." Re-verified while adding
  // taskReceiptResource below (P1-19): both now PASS — guild-app's config.ts
  // was corrected separately at some point after that comment was written,
  // and nobody came back to update the comment that predicted otherwise. Left
  // as a note rather than deleted outright, because the property this block
  // checks (comparing against the file's LIVE exports, never a value copied
  // from them at some point in the past) is exactly what makes "still failing?"
  // a question worth re-asking instead of trusting the prose.
  test('escrowComponent', () => {
    if (STANDALONE) return;
    expect(CONFIG.escrowComponent).toBe(requireAppConfig().ESCROW_COMPONENT);
  });

  // P7-05: the swap verbs act on the component the /swaps pages read.
  test('nftSwapComponent matches NFT_SWAP_COMPONENT', () => {
    if (STANDALONE) return;
    expect(CONFIG.nftSwapComponent).toBe(requireAppConfig().NFT_SWAP_COMPONENT);
  });

  test('claimReceiptResource', () => {
    if (STANDALONE) return;
    expect(CONFIG.claimReceiptResource).toBe(requireAppConfig().ESCROW_CLAIM_RECEIPT_RESOURCE);
  });

  test('taskReceiptResource matches ESCROW_RECEIPT_RESOURCE', () => {
    if (STANDALONE) return;
    expect(CONFIG.taskReceiptResource).toBe(requireAppConfig().ESCROW_RECEIPT_RESOURCE);
  });

  test('workerBadgeResource matches BADGE_NFT', () => {
    if (STANDALONE) return;
    expect(CONFIG.workerBadgeResource).toBe(requireAppConfig().BADGE_NFT);
  });

  test('badgeManagerComponent matches MANAGER', () => {
    if (STANDALONE) return;
    expect(CONFIG.badgeManagerComponent).toBe(requireAppConfig().MANAGER);
  });

  test('dAppDefinitionAddress matches DAPP_DEF', () => {
    if (STANDALONE) return;
    expect(CONFIG.dAppDefinitionAddress).toBe(requireAppConfig().DAPP_DEF);
  });
});
