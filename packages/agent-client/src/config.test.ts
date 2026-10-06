// normalizeLocalId guards the operator's most likely first-claim footgun:
// pasting the bare string-derived Member badge id (guild_member_alice) where
// the manifest builder requires the angle-bracketed NonFungibleLocalId.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  normalizeLocalId,
  bareLocalId,
  badgeEnvExports,
  loadConfig,
  loadPosterPrivateKeyHex,
  loadPosterAccountAddress,
  LIVE_NFT_SWAP_PACKAGE,
} from './config.js';

describe('loadConfig — the NFT swap pin', () => {
  test('defaults to the live component and package; GUILD_NFT_SWAP_PACKAGE overrides the package', () => {
    const saved = process.env.GUILD_NFT_SWAP_PACKAGE;
    try {
      delete process.env.GUILD_NFT_SWAP_PACKAGE;
      expect(loadConfig().nftSwapPackage).toBe(LIVE_NFT_SWAP_PACKAGE);
      process.env.GUILD_NFT_SWAP_PACKAGE = 'package_rdx1pkgoverride';
      expect(loadConfig().nftSwapPackage).toBe('package_rdx1pkgoverride');
    } finally {
      if (saved === undefined) delete process.env.GUILD_NFT_SWAP_PACKAGE;
      else process.env.GUILD_NFT_SWAP_PACKAGE = saved;
    }
  });
});

describe('normalizeLocalId', () => {
  test('wraps a bare string id in angle brackets', () => {
    expect(normalizeLocalId('guild_member_alice')).toBe('<guild_member_alice>');
    expect(normalizeLocalId('agent_007')).toBe('<agent_007>');
  });

  test('leaves an already-valid local id untouched', () => {
    expect(normalizeLocalId('<guild_member_alice>')).toBe('<guild_member_alice>');
    expect(normalizeLocalId('#42#')).toBe('#42#');
    expect(normalizeLocalId('{1234abcd-...}'.replace('...', '5678'))).toBe('{1234abcd-5678}');
    expect(normalizeLocalId('[deadbeef]')).toBe('[deadbeef]');
  });

  test('passes undefined through (env var unset)', () => {
    expect(normalizeLocalId(undefined)).toBeUndefined();
  });

  test('leaves malformed input for validateLocalId to reject downstream', () => {
    // contains characters illegal in a bare string id -> not wrapped, returned as-is
    expect(normalizeLocalId('guild member alice')).toBe('guild member alice');
    expect(normalizeLocalId('<bad spaces>')).toBe('<bad spaces>');
  });
});

describe('bareLocalId + badgeEnvExports (the one badge-env contract)', () => {
  test('bareLocalId strips ONLY a well-formed angle-bracketed string id', () => {
    expect(bareLocalId('<guild_member_x>')).toBe('guild_member_x');
    expect(bareLocalId('guild_member_x')).toBe('guild_member_x'); // already bare
    expect(bareLocalId('#7#')).toBe('#7#'); // integer ids untouched
    expect(bareLocalId('<guild_member_x')).toBe('<guild_member_x'); // malformed: never "repaired"
  });

  test('badgeEnvExports emits the exact two persistable exports, bare form', () => {
    expect(badgeEnvExports('resource_rdx1abc', '<guild_member_x>')).toEqual([
      'export GUILD_AGENT_BADGE_RESOURCE="resource_rdx1abc"',
      'export GUILD_AGENT_BADGE_LOCAL_ID="guild_member_x"',
    ]);
  });
});

// ── env save/restore so mutations never leak to sibling files ───────────────
const ENV_KEYS = ['POSTER_PRIVATE_KEY', 'POSTER_ACCOUNT_ADDRESS', 'GUILD_ESCROW_TASK_RECEIPT_RESOURCE'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe('taskReceiptResource (P1-19)', () => {
  test('defaults to the live Wave B Task Receipt resource', () => {
    delete process.env.GUILD_ESCROW_TASK_RECEIPT_RESOURCE;
    expect(loadConfig().taskReceiptResource).toBe(
      'resource_rdx1n2gxh84q62taekne4d5mys5yk23du7yyvma6zjuh0vvhn4w2vrtkju'
    );
  });

  test('is overridable, moving independently of the escrowComponent override', () => {
    process.env.GUILD_ESCROW_TASK_RECEIPT_RESOURCE = 'resource_rdx1_rehearsal_receipt';
    expect(loadConfig().taskReceiptResource).toBe('resource_rdx1_rehearsal_receipt');
  });
});

describe('loadPosterPrivateKeyHex — a DIFFERENT key from the agent/worker one', () => {
  test('throws with an actionable message when unset', () => {
    delete process.env.POSTER_PRIVATE_KEY;
    expect(() => loadPosterPrivateKeyHex()).toThrow(/POSTER_PRIVATE_KEY is not set/);
  });

  test('returns the raw hex when set', () => {
    process.env.POSTER_PRIVATE_KEY = 'aa'.repeat(32);
    expect(loadPosterPrivateKeyHex()).toBe('aa'.repeat(32));
  });
});

describe('loadPosterAccountAddress — optional cross-check input', () => {
  test('returns undefined when unset (opt-in, never required)', () => {
    delete process.env.POSTER_ACCOUNT_ADDRESS;
    expect(loadPosterAccountAddress()).toBeUndefined();
  });

  test('returns the address when set', () => {
    process.env.POSTER_ACCOUNT_ADDRESS = 'account_rdx1poster';
    expect(loadPosterAccountAddress()).toBe('account_rdx1poster');
  });
});
