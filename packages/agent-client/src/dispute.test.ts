// dispute.test.ts — P1-16's guards.
//
// The behaviour worth testing here is not "does it build a manifest" — it is
// (a) that a dry run genuinely signs nothing, (b) that --live signs the RIGHT
// task with the RIGHT evidence commitment (a spy that discards its arguments
// turns every test into a call-counter — see withdraw.test.ts's own note on
// this, and the real historical bug it cites), and (c) that the production
// fuse warning surfaces during PREVIEW, before an operator burns a round trip
// discovering tx.ts will refuse to sign.

import { describe, expect, test } from 'bun:test';
import { raiseDispute, resolveDispute } from './dispute.js';
import { disputeEvidenceHash } from './evidence.js';
import { LIVE_ESCROW_COMPONENT } from './config.js';

const WORKER = 'account_rdx12890803ct999t5ss4qatjyktay82gfy295rr6p4qmhks8twekeqgp9';
const MEMBER_BADGE = 'resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl';
const NON_PROD_ESCROW = 'component_rdx1cthrowawayrehearsalcomponentxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const BADGE_ID = '<guild_member_alice>';

const identity = { address: WORKER } as never;

const config = {
  escrowComponent: NON_PROD_ESCROW,
  gatewayBaseUrl: 'https://mainnet.radixdlt.com',
  workerBadgeResource: MEMBER_BADGE,
} as never;

describe('raiseDispute', () => {
  test('dry run resolves the badge, builds the manifest, computes the evidence hash, and signs nothing', async () => {
    let signed = false;
    const seenBadgeAccount: string[] = [];
    const r = await raiseDispute({
      taskId: 7,
      reason: 'the PR was never opened',
      live: false,
      identity,
      config,
      deps: {
        resolveBadgeLocalId: (async (account: string) => {
          seenBadgeAccount.push(account);
          return BADGE_ID;
        }) as never,
        raiseDisputeOnChain: (async () => {
          signed = true;
          return { intentHash: 'x', status: 'CommittedSuccess' };
        }) as never,
      },
    });

    expect(signed).toBe(false);
    expect(refusedOrThrow(r)).toBe(false);
    expect(r.dryRun).toBe(true);
    expect(r.manifest).toContain('"raise_dispute"');
    expect(r.manifest).toContain('7u64');
    expect(seenBadgeAccount).toEqual([WORKER]);
    expect(r.evidenceHash).toBe(await disputeEvidenceHash('the PR was never opened'));
    expect(r.manifest).toContain(r.evidenceHash!);
  });

  test('the manifest carries Enum<1u8> evidence, never Enum<0u8> — --reason is mandatory here', async () => {
    const r = await raiseDispute({
      taskId: 1,
      reason: 'anything',
      live: false,
      identity,
      config,
      deps: {
        resolveBadgeLocalId: async () => BADGE_ID,
        raiseDisputeOnChain: (async () => ({ intentHash: '', status: '' })) as never,
      },
    });
    expect(r.manifest).toContain('Enum<1u8>(Bytes(');
    expect(r.manifest).not.toContain('Enum<0u8>()');
  });

  test('refuses without signing when there is no identity — even for a dry run', async () => {
    let signed = false;
    const r = await raiseDispute({
      taskId: 1,
      reason: 'x',
      live: false,
      identity: null,
      config,
      deps: {
        resolveBadgeLocalId: async () => BADGE_ID,
        raiseDisputeOnChain: (async () => {
          signed = true;
          return { intentHash: '', status: '' };
        }) as never,
      },
    });
    expect(signed).toBe(false);
    expect(r.refused).toBe(true);
    if (r.refused) expect(r.refusal).toBe('no-identity');
  });

  test('refuses an empty reason (whitespace-only counts as empty) without ever reading the chain', async () => {
    let badgeReadCount = 0;
    const r = await raiseDispute({
      taskId: 1,
      reason: '   \n  ',
      live: false,
      identity,
      config,
      deps: {
        resolveBadgeLocalId: (async () => {
          badgeReadCount++;
          return BADGE_ID;
        }) as never,
        raiseDisputeOnChain: (async () => ({ intentHash: '', status: '' })) as never,
      },
    });
    expect(r.refused).toBe(true);
    if (r.refused) expect(r.refusal).toBe('empty-reason');
    expect(badgeReadCount).toBe(0);
  });

  test('refuses a reason over the 2000-char storage limit — the commitment would be unopenable', async () => {
    const r = await raiseDispute({
      taskId: 1,
      reason: 'x'.repeat(2001),
      live: false,
      identity,
      config,
      deps: {
        resolveBadgeLocalId: async () => BADGE_ID,
        raiseDisputeOnChain: (async () => ({ intentHash: '', status: '' })) as never,
      },
    });
    expect(r.refused).toBe(true);
    if (r.refused) expect(r.refusal).toBe('reason-too-long');
  });

  test('refuses without signing when the worker badge resource is not configured', async () => {
    let signed = false;
    const r = await raiseDispute({
      taskId: 1,
      reason: 'x',
      live: true, // even --live must not sign past a missing config
      identity,
      config: { ...config, workerBadgeResource: '' } as never,
      deps: {
        resolveBadgeLocalId: async () => BADGE_ID,
        raiseDisputeOnChain: (async () => {
          signed = true;
          return { intentHash: '', status: '' };
        }) as never,
      },
    });
    expect(signed).toBe(false);
    expect(r.refused).toBe(true);
    if (r.refused) expect(r.refusal).toBe('badge-not-configured');
  });

  test('refuses without signing when this agent holds no configured badge', async () => {
    let signed = false;
    const r = await raiseDispute({
      taskId: 1,
      reason: 'x',
      live: true,
      identity,
      config,
      deps: {
        resolveBadgeLocalId: async () => null,
        raiseDisputeOnChain: (async () => {
          signed = true;
          return { intentHash: '', status: '' };
        }) as never,
      },
    });
    expect(signed).toBe(false);
    expect(r.refused).toBe(true);
    if (r.refused) expect(r.refusal).toBe('badge-unavailable');
  });

  // Captures what the signing call actually RECEIVED — a mock that only counts
  // calls cannot tell "signed task 7" from "signed task 9 by mistake" apart.
  type SignArgs = { taskId: number; evidenceHashHex: string | undefined };
  function capturingSigner(calls: SignArgs[], intentHash = 'txid_rdx1abc') {
    return (async (
      taskId: number,
      _identity: unknown,
      _config: unknown,
      opts?: { evidenceHashHex?: string }
    ) => {
      calls.push({ taskId, evidenceHashHex: opts?.evidenceHashHex });
      return { intentHash, status: 'CommittedSuccess' };
    }) as never;
  }

  test('--live signs exactly once, and signs the RIGHT task with the RIGHT evidence commitment', async () => {
    const calls: SignArgs[] = [];
    const expectedHash = await disputeEvidenceHash('shipped nothing');
    const r = await raiseDispute({
      taskId: 42,
      reason: 'shipped nothing',
      live: true,
      identity,
      config,
      deps: {
        resolveBadgeLocalId: async () => BADGE_ID,
        raiseDisputeOnChain: capturingSigner(calls),
      },
    });

    expect(calls).toEqual([{ taskId: 42, evidenceHashHex: expectedHash }]);
    expect(refusedOrThrow(r)).toBe(false);
    expect(r.dryRun).toBe(false);
    expect(r.intentHash).toBe('txid_rdx1abc');
  });

  test('dry run against the LIVE production component warns; --live would be fused by tx.ts itself', async () => {
    const r = await raiseDispute({
      taskId: 1,
      reason: 'x',
      live: false,
      identity,
      config: { ...config, escrowComponent: LIVE_ESCROW_COMPONENT } as never,
      deps: {
        resolveBadgeLocalId: async () => BADGE_ID,
        raiseDisputeOnChain: (async () => ({ intentHash: '', status: '' })) as never,
      },
    });
    expect(refusedOrThrow(r)).toBe(false);
    expect(r.productionFuseWarning).toBeDefined();
    expect(r.productionFuseWarning).toContain('GUILD_ALLOW_LIVE_DISPUTE');
  });

  test('no warning against a non-production (rehearsal) component', async () => {
    const r = await raiseDispute({
      taskId: 1,
      reason: 'x',
      live: false,
      identity,
      config,
      deps: {
        resolveBadgeLocalId: async () => BADGE_ID,
        raiseDisputeOnChain: (async () => ({ intentHash: '', status: '' })) as never,
      },
    });
    expect(refusedOrThrow(r)).toBe(false);
    expect(r.productionFuseWarning).toBeUndefined();
  });
});

describe('resolveDispute', () => {
  test('dry run needs no identity at all — auto_resolve_dispute is a bare, accountless trigger', async () => {
    let signed = false;
    const r = await resolveDispute({
      taskId: 9,
      live: false,
      identity: null,
      config,
      deps: {
        autoResolveDisputeOnChain: (async () => {
          signed = true;
          return { intentHash: '', status: '' };
        }) as never,
      },
    });
    expect(signed).toBe(false);
    expect(r.dryRun).toBe(true);
    expect(r.manifest).toContain('"auto_resolve_dispute"');
    expect(r.manifest).toContain('9u64');
  });

  test('the manifest passes NO accounts and NO amounts — a bare trigger, per the design', async () => {
    const r = await resolveDispute({
      taskId: 9,
      live: false,
      identity: null,
      config,
      deps: { autoResolveDisputeOnChain: (async () => ({ intentHash: '', status: '' })) as never },
    });
    // No proof, no account, no ruling parameter — a stranger calling this
    // performs the accounting and receives nothing, which is what makes a
    // PUBLIC method safe here. If a future change adds any of those, this
    // fails before the underlying semantics do.
    expect(r.manifest).not.toContain('account_rdx');
    expect(r.manifest).not.toContain('Proof');
    expect(r.manifest).not.toContain('deposit_batch');
  });

  type SignArgs = { taskId: number };
  function capturingSigner(calls: SignArgs[], intentHash = 'txid_rdx1resolve') {
    return (async (taskId: number) => {
      calls.push({ taskId });
      return { intentHash, status: 'CommittedSuccess' };
    }) as never;
  }

  test('--live signs exactly once, and signs the RIGHT task', async () => {
    const calls: SignArgs[] = [];
    const r = await resolveDispute({
      taskId: 55,
      live: true,
      identity,
      config,
      deps: { autoResolveDisputeOnChain: capturingSigner(calls) },
    });
    expect(calls).toEqual([{ taskId: 55 }]);
    expect(r.dryRun).toBe(false);
    expect(r.intentHash).toBe('txid_rdx1resolve');
  });

  test('--live without an identity throws rather than silently no-op-ing (defensive; the CLI layer already guards this)', async () => {
    await expect(
      resolveDispute({
        taskId: 1,
        live: true,
        identity: null,
        config,
        deps: { autoResolveDisputeOnChain: (async () => ({ intentHash: '', status: '' })) as never },
      })
    ).rejects.toThrow();
  });

  test('dry run against the LIVE production component warns the same way raiseDispute does', async () => {
    const r = await resolveDispute({
      taskId: 1,
      live: false,
      identity: null,
      config: { ...config, escrowComponent: LIVE_ESCROW_COMPONENT } as never,
      deps: { autoResolveDisputeOnChain: (async () => ({ intentHash: '', status: '' })) as never },
    });
    expect(r.productionFuseWarning).toBeDefined();
  });
});

/** Narrow a RaiseDisputeResult's `refused` flag for the tests above that only
 *  care "did this actually get refused" without repeating the discriminated
 *  union check inline every time. */
function refusedOrThrow(r: { refused: boolean; message?: string }): boolean {
  if (r.refused) throw new Error(`unexpectedly refused: ${r.message}`);
  return r.refused;
}
