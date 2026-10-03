// Offline coverage for the UNTESTED-UNTIL-PILOT tx pipeline: building +
// signing a real claim manifest must produce a valid notarized transaction
// and a mainnet intent hash WITHOUT any network access. (Submission and
// status polling stay untested until the pilot funds an agent account.)

import { describe, test, expect } from 'bun:test';
import {
  approveAndReleaseOnChain,
  autoResolveDisputeOnChain,
  buildSignedTransaction,
  cancelTaskAfterClaimOnChain,
  cancelTaskOnChain,
  claimTaskOnChain,
  composeFeeLockedManifest,
  createTaskOnChain,
  raiseDisputeOnChain,
  releaseAfterReviewTimeoutOnChain,
  withdrawPosterOnChain,
} from './tx.js';
import { MINT_USERNAME_RE } from './mint.js';
import {
  claimTaskManifest,
  raiseDisputeManifest,
  autoResolveDisputeManifest,
} from './manifests.js';
import { AgentIdentity } from './identity.js';
import { generateThrowawayPrivateKeyHex } from './throwaway-key.js';
import {
  loadConfig,
  LIVE_ESCROW_COMPONENT,
  MAINNET_XRD,
  RETIRED_LIVE_ESCROW_COMPONENTS,
} from './config.js';

const CONFIG = loadConfig();
const BADGE = 'resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl';

describe('buildSignedTransaction (offline)', () => {
  test('compiles + notarizes a claim manifest into a mainnet intent hash', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const manifest = claimTaskManifest(
      CONFIG.escrowComponent,
      identity.address,
      BADGE,
      '#1#',
      1,
      MAINNET_XRD,
      '10'
    );
    const signed = await buildSignedTransaction({
      manifest,
      identity,
      currentEpoch: 100_000,
    });
    expect(signed.intentHash).toStartWith('txid_rdx1');
    expect(signed.notarizedTransactionHex).toMatch(/^[0-9a-f]+$/);
    expect(signed.notarizedTransactionHex.length).toBeGreaterThan(200);
  });

  test('two builds of the same manifest differ (fresh nonce each time)', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const manifest = claimTaskManifest(
      CONFIG.escrowComponent,
      identity.address,
      BADGE,
      '#1#',
      1,
      MAINNET_XRD,
      '10'
    );
    const a = await buildSignedTransaction({ manifest, identity, currentEpoch: 100_000 });
    const b = await buildSignedTransaction({ manifest, identity, currentEpoch: 100_000 });
    expect(a.intentHash).not.toBe(b.intentHash);
  });

  test('invalid manifest text fails the build (RET validation)', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    expect(
      buildSignedTransaction({
        manifest: 'CALL_METHOD this is not a manifest;',
        identity,
        currentEpoch: 100_000,
      })
    ).rejects.toThrow();
  });
});

describe('claimTaskOnChain guard rails', () => {
  test('refuses to run without the agent badge env (TODO(pilot))', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const config = loadConfig({ agentBadgeResource: '', agentBadgeLocalId: '' });
    // Badge check fires first, so the work brief here is never verified.
    expect(
      claimTaskOnChain(1, identity, config, { title: 't', description: 'd' })
    ).rejects.toThrow('Agent badge env not set');
  });
});

// ── Poster on-chain legs (P1-19) — offline-only, same posture as the worker
// legs above: none of these six functions has a local guard that fires
// BEFORE signAndSubmitManifest (unlike claimTaskOnChain's badge check or the
// dispute fuse), so a genuine happy-path test would need a live or mocked
// Gateway — UNTESTED-UNTIL-PILOT, exactly like claimTaskOnChain/
// submitTaskOnChain's own network legs (this file's header comment). What IS
// safely offline-testable, and asserted below: the manifest builder's own
// input validation throws BEFORE any network call, because manifest
// construction happens before signAndSubmitManifest is ever reached — proven
// by pointing the Gateway at an unroutable port (the exact technique the
// live-dispute fuse tests below use) and confirming a BAD input still throws
// the VALIDATION message, never a network error.
describe('poster on-chain legs — offline validation fires before any network call', () => {
  const UNROUTABLE = loadConfig({ gatewayBaseUrl: 'http://127.0.0.1:1' });

  test('createTaskOnChain rejects a non-positive reward before touching the network', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    await expect(
      createTaskOnChain(0, identity, UNROUTABLE, { title: 't', description: 'd' })
    ).rejects.toThrow(/must be positive/);
  });

  test('createTaskOnChain rejects a negative reward before touching the network', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    await expect(
      createTaskOnChain(-5, identity, UNROUTABLE, { title: 't', description: 'd' })
    ).rejects.toThrow(/not be negative/);
  });

  test('approveAndReleaseOnChain rejects a non-integer task id before touching the network', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    await expect(approveAndReleaseOnChain(1.5, identity, UNROUTABLE)).rejects.toThrow(/positive integer/);
  });

  test('cancelTaskOnChain rejects task id 0 before touching the network', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    await expect(cancelTaskOnChain(0, identity, UNROUTABLE)).rejects.toThrow(/positive integer/);
  });

  test('cancelTaskAfterClaimOnChain rejects a negative task id before touching the network', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    await expect(cancelTaskAfterClaimOnChain(-1, identity, UNROUTABLE)).rejects.toThrow(/positive integer/);
  });

  test('releaseAfterReviewTimeoutOnChain rejects a non-integer task id before touching the network', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    await expect(releaseAfterReviewTimeoutOnChain(2.2, identity, UNROUTABLE)).rejects.toThrow(
      /positive integer/
    );
  });

  test('withdrawPosterOnChain rejects task id 0 before touching the network', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    await expect(withdrawPosterOnChain(0, identity, UNROUTABLE)).rejects.toThrow(/positive integer/);
  });

  // Belt-and-braces on the happy path reaching the network at all (and only
  // the network — not a synchronous throw first): a VALID call against the
  // unroutable Gateway must reject with a CONNECTION error, not a validation
  // one, proving the manifest built successfully and signAndSubmitManifest
  // was actually reached.
  test('a VALID createTaskOnChain call reaches the network (rejects with a connection error, not a validation one)', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    let threw: unknown;
    try {
      await createTaskOnChain(5, identity, UNROUTABLE, { title: 't', description: 'd' });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).not.toMatch(/Invalid|positive integer/);
  });
});

// ⚠️ THIS BLOCK USED TO REPLICATE THE GUARD INSTEAD OF IMPORTING IT.
//
// The old helper was `manifest.includes('lock_fee') ? manifest : LINE + manifest`
// — a byte-for-byte copy of tx.ts's logic, asserted against itself. So it could
// not fail when tx.ts changed (deleting the prepend entirely left 317/317 green,
// measured), and it enshrined the defect as correct behaviour. Its own comment
// said "replicate the exact guard", which is the tell: a test that replicates
// the thing under test is testing the copy.
//
// It now imports the real `composeFeeLockedManifest`. Same shape of assertion,
// but wired to the code that ships.
function countLockFee(manifest: string): number {
  return manifest.match(/"lock_fee"/g)?.length ?? 0;
}

describe('dispute manifests inherit exactly one lock_fee', () => {
  const EVIDENCE = 'ab'.repeat(32);

  test('raiseDisputeManifest carries no lock_fee → prepend adds exactly one', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const manifest = raiseDisputeManifest(
      CONFIG.escrowComponent,
      identity.address,
      BADGE,
      '<guild_member_alice>',
      42,
      EVIDENCE
    );
    // Dispute manifest is fee-less on its own.
    expect(countLockFee(manifest)).toBe(0);
    // The pipeline's prepend produces exactly one lock_fee (idempotent guard).
    const composed = composeFeeLockedManifest(manifest, identity.address);
    expect(countLockFee(composed)).toBe(1);
    // Opting out is now an explicit PARAMETER, never inferred from content.
    expect(composeFeeLockedManifest(composed, identity.address, true)).toBe(composed);
    // And the prepended manifest is valid RET (compiles + notarizes offline).
    const signed = await buildSignedTransaction({ manifest, identity, currentEpoch: 100_000 });
    expect(signed.intentHash).toStartWith('txid_rdx1');
  });

  test('autoResolveDisputeManifest carries no lock_fee → prepend adds exactly one', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const manifest = autoResolveDisputeManifest(CONFIG.escrowComponent, 42);
    expect(countLockFee(manifest)).toBe(0);
    const composed = composeFeeLockedManifest(manifest, identity.address);
    expect(countLockFee(composed)).toBe(1);
    expect(composeFeeLockedManifest(composed, identity.address, true)).toBe(composed);
    const signed = await buildSignedTransaction({ manifest, identity, currentEpoch: 100_000 });
    expect(signed.intentHash).toStartWith('txid_rdx1');
  });
});

// The bug this file previously could not see. Kept as its own block so the
// reason survives even if the blocks above are rewritten.
describe('fee lock cannot be suppressed by manifest CONTENT', () => {
  test('the username `lock_fee` is accepted by MINT_USERNAME_RE — this is why a substring check was unsafe', () => {
    // Not incidental: it is exactly what made the old guard reachable by a user.
    expect(MINT_USERNAME_RE.test('lock_fee')).toBe(true);
    expect(MINT_USERNAME_RE.test('mylock_feebot')).toBe(true);
  });

  test('a manifest whose CONTENT contains "lock_fee" still gets a real fee lock', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    // Shape of a mint manifest carrying the hostile username as a string arg.
    const hostile = `CALL_METHOD\n  Address("${CONFIG.escrowComponent}")\n  "public_mint"\n  "lock_fee"\n;\n`;
    expect(countLockFee(hostile)).toBe(1); // the DECOY — content, not an instruction

    const composed = composeFeeLockedManifest(hostile, identity.address);
    // Two now: the decoy string plus one REAL prepended lock_fee. Under the old
    // substring guard this was ONE — the decoy — and the agent paid no fee.
    expect(countLockFee(composed)).toBe(2);
    expect(composed.startsWith(`CALL_METHOD\n  Address("${identity.address}")\n  "lock_fee"`)).toBe(
      true,
    );
  });

  test('opting out is explicit, and only the parameter can do it', () => {
    const addr = 'account_rdx12yh4fwevmvnqgdmllrmvmnvhkxvavpmyq2vwvmnvhkxvavpmyqtest';
    const plain = 'CALL_METHOD\n  Address("x")\n  "noop"\n;\n';
    expect(composeFeeLockedManifest(plain, addr, true)).toBe(plain);
    expect(composeFeeLockedManifest(plain, addr, false)).not.toBe(plain);
    expect(composeFeeLockedManifest(plain, addr)).not.toBe(plain); // default = prepend (safe direction)
  });
});

describe('raiseDisputeOnChain guard rails (offline, no network)', () => {
  // Not the live mainnet escrow, so the live-dispute fuse stays out of the way of
  // the guard actually under test here.
  const NON_LIVE_COMPONENT =
    'component_rdx1cz9mh49tt9ckvnnvfxvw0dvqnfpuqhqxpaqfxvw0dvqnfpuqhqtest';

  test('refuses when workerBadgeResource is unset', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const config = loadConfig({ workerBadgeResource: '', escrowComponent: NON_LIVE_COMPONENT });
    expect(raiseDisputeOnChain(42, identity, config)).rejects.toThrow(
      'Worker badge resource not set'
    );
  });

  // The fuse must come FIRST: refusing to touch the live component matters more
  // than which local precondition is missing, and it is the only thing standing
  // between a stray --live --dispute run and arming BUG-7 on real XRD.
  test('refuses against the LIVE component before any other precondition', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const config = loadConfig({
      workerBadgeResource: '',
      escrowComponent: 'component_rdx1cr690hkrk2kv933cw3qdr6amkaphdlu2whjhhh8wppus922yx335r2',
    });
    expect(raiseDisputeOnChain(42, identity, config)).rejects.toThrow('Refusing to sign');
  });

  test('autoResolveDisputeOnChain is fused against the LIVE component too', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const config = loadConfig({
      escrowComponent: 'component_rdx1cr690hkrk2kv933cw3qdr6amkaphdlu2whjhhh8wppus922yx335r2',
    });
    // PULL signature: (taskId, identity, config) — the settlement-facts arg is gone.
    expect(autoResolveDisputeOnChain(42, identity, config)).rejects.toThrow('Refusing to sign');
  });
});

// ── The tests that would have caught the 2026-08-17..19 open fuse ────────────
//
// The three tests above passed throughout that window and proved nothing, because
// every one of them hand-typed an escrow address as its input — and the address
// they typed was the RETIRED push component, which is not what the client points
// at. The fuse was comparing production against a dead literal and never firing,
// and no test noticed, because no test ever asked what happens on the config the
// client actually ships.
//
// So the rule these encode: a guard must be fed the input it exists to refuse,
// and that input has to be OBTAINED, not typed. `loadConfig()` with no overrides
// is the shipped default, so these cannot be left behind by a cutover the way a
// literal was.
describe('live-dispute fuse fires on the SHIPPED default config', () => {
  const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  // THE regression test. No address literal anywhere in it: it asks loadConfig()
  // for whatever this client ships pointed at, and requires the fuse to refuse it.
  // Mutation-check performed both directions before landing — reverting tx.ts to
  // its own literal makes this test RED and leaves the three tests above green.
  test('raiseDisputeOnChain refuses against loadConfig() with NO overrides', async () => {
    await withEnv(
      { GUILD_ALLOW_LIVE_DISPUTE: undefined, GUILD_ESCROW_COMPONENT: undefined },
      async () => {
        const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
        // workerBadgeResource deliberately blank: if the fuse does NOT fire, the
        // next guard does, and the test would pass on the WRONG error. Asserting
        // the message is what separates the two.
        const config = loadConfig({ workerBadgeResource: '' });
        expect(raiseDisputeOnChain(42, identity, config)).rejects.toThrow(
          'Refusing to sign raise_dispute against a PRODUCTION escrow component'
        );
      }
    );
  });

  // ⚠️ The gateway is pinned to an unroutable loopback port, and that is load-bearing
  // rather than tidiness. `autoResolveDisputeOnChain` is THREE lines — the fuse, the
  // manifest, then `signAndSubmitManifest`. It has no local precondition after the
  // fuse, so the fuse is the only thing between this call and a real mainnet
  // submission. Measured the hard way while mutation-proving this very test: with
  // the fuse reverted, the case fell straight through and spent 64s talking to
  // mainnet (a throwaway unfunded key, so nothing could commit — an unfunded account
  // cannot lock the fee, and task 42 does not exist on the component either). The
  // pin means the NEXT person who mutates this fuse gets a fast offline failure
  // instead of an outbound submission. It cannot weaken the assertion: the fuse
  // throws before any network use, so on the correct code this line is never reached.
  test('autoResolveDisputeOnChain refuses against loadConfig() with NO overrides', async () => {
    await withEnv(
      { GUILD_ALLOW_LIVE_DISPUTE: undefined, GUILD_ESCROW_COMPONENT: undefined },
      async () => {
        const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
        const config = loadConfig({ gatewayBaseUrl: 'http://127.0.0.1:1' });
        expect(config.escrowComponent).toBe(LIVE_ESCROW_COMPONENT); // the thing under test is untouched
        expect(autoResolveDisputeOnChain(42, identity, config)).rejects.toThrow(
          'Refusing to sign auto_resolve_dispute against a PRODUCTION escrow component'
        );
      }
    );
  });

  // Every RETIRED production component too — pointing a dispute leg at one is
  // never deliberate, and those components still hold real state.
  test('refuses against every retired production component', async () => {
    await withEnv(
      { GUILD_ALLOW_LIVE_DISPUTE: undefined, GUILD_ESCROW_COMPONENT: undefined },
      async () => {
        const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
        expect(RETIRED_LIVE_ESCROW_COMPONENTS.length).toBeGreaterThan(0);
        for (const retired of RETIRED_LIVE_ESCROW_COMPONENTS) {
          const config = loadConfig({ workerBadgeResource: '', escrowComponent: retired });
          expect(raiseDisputeOnChain(42, identity, config)).rejects.toThrow(
            'Refusing to sign raise_dispute against a PRODUCTION escrow component'
          );
        }
      }
    );
  });

  // The fuse must remain OPENABLE — deliberately, by the documented override.
  // Without this, a fuse that threw unconditionally would pass every test above
  // and silently make the rehearsal route impossible.
  test('GUILD_ALLOW_LIVE_DISPUTE=1 lets the shipped default through to the next guard', async () => {
    await withEnv(
      { GUILD_ALLOW_LIVE_DISPUTE: '1', GUILD_ESCROW_COMPONENT: undefined },
      async () => {
        const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
        const config = loadConfig({ workerBadgeResource: '' });
        // Reaches the NEXT precondition — i.e. the fuse did not stop it.
        expect(raiseDisputeOnChain(42, identity, config)).rejects.toThrow(
          'Worker badge resource not set'
        );
      }
    );
  });

  // A throwaway/rehearsal component must still be exercisable without the
  // override — the rulings endorse exactly that route, and a blanket
  // "refuse any mainnet component" rule would have blocked the 2026-08-11/15
  // rehearsal dispute that proved the PULL settlement shape.
  test('a non-production component is NOT fused (rehearsal route stays open)', async () => {
    await withEnv(
      { GUILD_ALLOW_LIVE_DISPUTE: undefined, GUILD_ESCROW_COMPONENT: undefined },
      async () => {
        const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
        const config = loadConfig({
          workerBadgeResource: '',
          escrowComponent:
            'component_rdx1cqudk8vxaf24xevekzu49mw0292qmhaa85klypxu5sh4yh7nsddhwj',
        });
        expect(raiseDisputeOnChain(42, identity, config)).rejects.toThrow(
          'Worker badge resource not set'
        );
      }
    );
  });

  // Belt-and-braces on the class itself: the fuse's notion of "production" and
  // the address the client ships must be the same string. True by construction
  // today (one exported constant); this fails the moment someone reintroduces a
  // second copy, which is precisely how the original defect was born.
  test('the shipped default IS the constant the fuse guards', () => {
    expect(loadConfig().escrowComponent).toBe(LIVE_ESCROW_COMPONENT);
    expect(RETIRED_LIVE_ESCROW_COMPONENTS).not.toContain(LIVE_ESCROW_COMPONENT);
  });
});
