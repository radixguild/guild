// Adversarial hardening for the exported manifest builders. Companion to
// manifests.test.ts (which asserts the VALID byte-shapes / server parity); this
// file exercises the fail-closed edges of the internal validators THROUGH the
// public builders. Two edges here PROVE fixes that were previously exploitable:
//
//   1. validateAddress anchoring — a valid-looking prefix + 20 alnums followed by
//      an injected manifest fragment. Before the trailing `$` anchor, `.test()`
//      stopped after 20 chars and the hostile tail flowed verbatim into
//      Address("${addr}"), breaking out of the string literal and smuggling an
//      extra CALL_METHOD. It must now THROW before emitting anything.
//   2. u64 overflow — a taskId/claimReceiptId past Number.MAX_SAFE_INTEGER stays
//      Number.isInteger===true but is no longer exactly representable, so `${n}u64`
//      would emit a DIFFERENT id (2^53+1 → 2^53) — a manifest signed against the
//      wrong task. It must now THROW instead of silently rounding.
//
// The golden VALID shapes are already covered in manifests.test.ts — this file
// does NOT duplicate them; it only asserts a valid input is NOT falsely rejected
// at the same edges it hardens.

import { describe, test, expect } from 'bun:test';
import {
  claimTaskManifest,
  submitTaskManifest,
  expireClaimManifest,
  raiseDisputeManifest,
  autoResolveDisputeManifest,
  publicMintManifest,
} from './manifests.js';
import { loadConfig, MAINNET_XRD } from './config.js';

const CONFIG = loadConfig();
const WORKER = 'account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw';
const BADGE = 'resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl';
const MEMBER_LOCAL_ID = '<guild_member_alice>';
const MANAGER = CONFIG.badgeManagerComponent;
const EVIDENCE = 'ab'.repeat(32);
// Wave B stage 6: submit_task's new 4th arg (brief_hash) — distinct from
// EVIDENCE so a positional swap between the two would not go unnoticed.
const BRIEF = 'cd'.repeat(32);
// Wave B: claimTaskManifest takes the bond RESOURCE + AMOUNT (as derived by
// tx.ts's resolveClaimBond from live chain state), not a flat XRD number.
// These stand in for "some valid bond" in every case below that isn't
// specifically about the bond fields themselves.
const BOND_RESOURCE = MAINNET_XRD;
const BOND_AMOUNT = '10';

// A hostile "address": a genuine-looking prefix + exactly 20 alnums (so the
// un-anchored `[a-z0-9]{20,}` body matches), immediately followed by a manifest
// break-out that closes the Address string, ends the instruction, and injects a
// withdraw CALL_METHOD to an attacker account. The `$` anchor is what rejects it.
function inject(prefix: string): string {
  return `${prefix}1aaaaaaaaaaaaaaaaaaaa")\nCALL_METHOD\n  Address("account_rdx1evil")\n  "withdraw"\n;`;
}

describe('validateAddress anchoring — manifest injection is rejected (PROVES FIX)', () => {
  // Each row drives one builder with a hostile value in ONE address position; all
  // other args are valid, so the ONLY reason to throw is the anchored validator.
  const cases: { name: string; run: () => string; match: RegExp }[] = [
    {
      name: 'claimTaskManifest / escrowComponent',
      run: () =>
        claimTaskManifest(inject('component_rdx'), WORKER, BADGE, '#7#', 42, BOND_RESOURCE, BOND_AMOUNT),
      match: /Invalid component_rdx address/,
    },
    {
      name: 'claimTaskManifest / workerAccount',
      run: () =>
        claimTaskManifest(CONFIG.escrowComponent, inject('account_rdx'), BADGE, '#7#', 42, BOND_RESOURCE, BOND_AMOUNT),
      match: /Invalid account_rdx address/,
    },
    {
      name: 'claimTaskManifest / badgeResource',
      run: () =>
        claimTaskManifest(CONFIG.escrowComponent, WORKER, inject('resource_rdx'), '#7#', 42, BOND_RESOURCE, BOND_AMOUNT),
      match: /Invalid resource_rdx address/,
    },
    {
      name: 'claimTaskManifest / bondResource',
      run: () =>
        claimTaskManifest(CONFIG.escrowComponent, WORKER, BADGE, '#7#', 42, inject('resource_rdx'), BOND_AMOUNT),
      match: /Invalid resource_rdx address/,
    },
    {
      name: 'submitTaskManifest / escrowComponent',
      run: () =>
        submitTaskManifest(inject('component_rdx'), WORKER, CONFIG.claimReceiptResource, 7, 42, EVIDENCE, BRIEF),
      match: /Invalid component_rdx address/,
    },
    {
      name: 'submitTaskManifest / claimReceiptResource',
      run: () =>
        submitTaskManifest(CONFIG.escrowComponent, WORKER, inject('resource_rdx'), 7, 42, EVIDENCE, BRIEF),
      match: /Invalid resource_rdx address/,
    },
    {
      name: 'raiseDisputeManifest / proofResource',
      run: () =>
        raiseDisputeManifest(CONFIG.escrowComponent, WORKER, inject('resource_rdx'), MEMBER_LOCAL_ID, 42, null),
      match: /Invalid resource_rdx address/,
    },
    {
      name: 'expireClaimManifest / escrowComponent',
      run: () => expireClaimManifest(inject('component_rdx'), WORKER, 42),
      match: /Invalid component_rdx address/,
    },
    {
      name: 'expireClaimManifest / callerAccount',
      run: () => expireClaimManifest(CONFIG.escrowComponent, inject('account_rdx'), 42),
      match: /Invalid account_rdx address/,
    },
    {
      name: 'publicMintManifest / manager',
      run: () => publicMintManifest(inject('component_rdx'), 'alice', WORKER),
      match: /Invalid component_rdx address/,
    },
    {
      name: 'publicMintManifest / account',
      run: () => publicMintManifest(MANAGER, 'alice', inject('account_rdx')),
      match: /Invalid account_rdx address/,
    },
    {
      // PULL finalize is a bare trigger; its only injectable surface is the
      // component address (no accounts, no amounts). The anchored validator
      // rejects a hostile tail before any manifest text is emitted.
      name: 'autoResolveDisputeManifest / component',
      run: () => autoResolveDisputeManifest(inject('component_rdx'), 42),
      match: /Invalid component_rdx address/,
    },
  ];

  for (const { name, run, match } of cases) {
    test(`${name} — throws before emitting injected manifest`, () => {
      // Throws with the anchored-validator message...
      expect(run).toThrow(match);
      // ...and the hostile tail never reaches an output string. Belt-and-braces:
      // if the builder ever regressed to NOT throwing, this proves no injection
      // leaked into the emitted manifest.
      let out: string | undefined;
      try {
        out = run();
      } catch {
        out = undefined;
      }
      expect(out).toBeUndefined();
    });
  }

  test('a genuinely valid address at every position still builds (no false rejection)', () => {
    const m = claimTaskManifest(CONFIG.escrowComponent, WORKER, BADGE, '#7#', 42, BOND_RESOURCE, BOND_AMOUNT);
    expect(m).toContain(`Address("${CONFIG.escrowComponent}")`);
    expect(m).toContain(`Address("${WORKER}")`);
    expect(m).toContain(`Address("${BADGE}")`);
    // No stray break-out artifacts.
    expect(m).not.toContain('account_rdx1evil');
  });
});

describe('u64 overflow — ids past MAX_SAFE_INTEGER are rejected (PROVES FIX)', () => {
  // 9007199254740993 === MAX_SAFE_INTEGER + 2; the literal already rounds to
  // 9007199254740992 (2^53), which is > MAX_SAFE_INTEGER → the validator refuses.
  const OVERFLOW = 9007199254740993; // Number.MAX_SAFE_INTEGER + 2
  const MAX = Number.MAX_SAFE_INTEGER; // 9007199254740991 — the accepted boundary

  const overflowCases: { name: string; run: () => string }[] = [
    {
      name: 'claimTaskManifest / taskId',
      run: () =>
        claimTaskManifest(CONFIG.escrowComponent, WORKER, BADGE, '#7#', OVERFLOW, BOND_RESOURCE, BOND_AMOUNT),
    },
    {
      name: 'submitTaskManifest / taskId',
      run: () =>
        submitTaskManifest(CONFIG.escrowComponent, WORKER, CONFIG.claimReceiptResource, 7, OVERFLOW, EVIDENCE, BRIEF),
    },
    {
      name: 'submitTaskManifest / claimReceiptId',
      run: () =>
        submitTaskManifest(CONFIG.escrowComponent, WORKER, CONFIG.claimReceiptResource, OVERFLOW, 42, EVIDENCE, BRIEF),
    },
    {
      name: 'expireClaimManifest / taskId',
      run: () => expireClaimManifest(CONFIG.escrowComponent, WORKER, OVERFLOW),
    },
    {
      name: 'raiseDisputeManifest / taskId',
      run: () => raiseDisputeManifest(CONFIG.escrowComponent, WORKER, BADGE, MEMBER_LOCAL_ID, OVERFLOW, null),
    },
  ];

  for (const { name, run } of overflowCases) {
    test(`${name} — throws 'must be a positive integer' (no silent rounding)`, () => {
      expect(run).toThrow(/must be a positive integer/);
      // Sanity: the rounded id (2^53) never leaked into a signed manifest.
      let out: string | undefined;
      try {
        out = run();
      } catch {
        out = undefined;
      }
      expect(out).toBeUndefined();
    });
  }

  test('MAX_SAFE_INTEGER itself is accepted (boundary) — taskId', () => {
    const m = claimTaskManifest(CONFIG.escrowComponent, WORKER, BADGE, '#7#', MAX, BOND_RESOURCE, BOND_AMOUNT);
    expect(m).toContain(`${MAX}u64`);
    expect(m).toContain('9007199254740991u64');
  });

  test('MAX_SAFE_INTEGER itself is accepted (boundary) — claimReceiptId local id', () => {
    const m = submitTaskManifest(CONFIG.escrowComponent, WORKER, CONFIG.claimReceiptResource, MAX, 42, EVIDENCE, BRIEF);
    // The receipt id becomes an integer NonFungibleLocalId `#<n>#`.
    expect(m).toContain(`NonFungibleLocalId("#${MAX}#")`);
  });
});

describe('decimalStringArg boundary — bondAmount is a STRING, not a number (Wave B)', () => {
  const claim = (amount: string) =>
    claimTaskManifest(CONFIG.escrowComponent, WORKER, BADGE, '#7#', 42, BOND_RESOURCE, amount);

  // The float-artifact class this block used to document (0.1 + 0.2 ->
  // "0.30000000000000004" leaking through because decimalArg passed
  // String(n) through) is now STRUCTURALLY IMPOSSIBLE on this path, not
  // merely avoided by convention: bondAmount is a pre-computed exact decimal
  // STRING (requiredBond's BigInt arithmetic in manifests.ts, fed by chain
  // reads in tx.ts's resolveClaimBond) — there is no `number` anywhere on
  // the claim-bond path for float arithmetic to leave a mark on.
  test('an exact decimal string round-trips byte-for-byte, no coercion', () => {
    expect(claim('0.30000000000000004')).toContain('Decimal("0.30000000000000004")');
    expect(claim('10')).toContain('Decimal("10")');
    expect(claim('10.25')).toContain('Decimal("10.25")');
  });

  // decimalStringArg's own validation: it accepts only a plain non-negative
  // decimal string — exponential notation, letters, and a leading '-' are
  // all rejected as malformed rather than coerced.
  test.each(['1e-7', 'abc', '-1', '', '1.2.3', ' 10'])(
    'rejects the malformed decimal string %j (never silently coerced)',
    malformed => {
      expect(() => claim(malformed)).toThrow(/must be a plain non-negative decimal string/);
    }
  );

  test('zero is accepted (a live claim_bond_floor of 0 is a legitimate, if unusual, deploy)', () => {
    expect(claim('0')).toContain('Decimal("0")');
  });
});

/**
 * The 18dp ceiling on the bondAmount STRING itself. Radix `Decimal` is
 * fixed-point at 18dp; `requiredBond` (manifests.ts) only ever produces a
 * string at ≤18dp (it is built from 18dp-scaled BigInt arithmetic and
 * formatted back down), so a caller reaching decimalStringArg with MORE than
 * 18dp would mean something upstream fabricated the string by hand — this is
 * the same fail-closed backstop the number-based ceiling used to be, moved
 * to the string boundary Wave B actually uses.
 */
describe('decimalStringArg — the chain cannot represent more than 18dp', () => {
  const bond = (amount: string) =>
    claimTaskManifest(CONFIG.escrowComponent, WORKER, BADGE, '#7#', 42, BOND_RESOURCE, amount);

  test('19 decimal places THROWS instead of emitting', () => {
    expect(() => bond('1.1234567890123456789')).toThrow(/exceeds the chain's 18/);
  });

  test('the rejection names the count, not just "invalid"', () => {
    expect(() => bond('1.1234567890123456789')).toThrow(/19 decimal places/);
  });

  test('exactly 18 decimal places is ACCEPTED — the chain can represent it', () => {
    const m = bond('1.123456789012345678');
    expect(m).toContain('Decimal("1.123456789012345678")');
  });

  test('ordinary whole and fractional amounts are untouched', () => {
    expect(() => bond('10')).not.toThrow();
    expect(() => bond('10.25')).not.toThrow();
    expect(bond('10')).toContain('Decimal("10")');
  });
});
