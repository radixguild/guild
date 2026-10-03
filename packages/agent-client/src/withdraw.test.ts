// withdraw.test.ts — P3-1's guards.
//
// The behaviour worth testing here is not "does it build a manifest" — it is
// the REFUSALS. Every branch in resolveWithdrawal is a decision about real
// money, and the two that matter most (`unreadable` vs `nothing-owed`, and
// `no-entitlement-fields` vs `nothing-owed`) are indistinguishable on the wire.
// A withdraw that reported "nothing owed" on an unreadable chain would tell an
// agent its money was already collected.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  explainRefusal,
  resolveWithdrawal,
  withdrawWorkerReward,
  type WithdrawRefusal,
} from './withdraw.js';
import type { WorkerEntitlement } from './gateway.js';
import { isPositiveDecimal } from './gateway.js';

const WORKER = 'account_rdx12890803ct999t5ss4qatjyktay82gfy295rr6p4qmhks8twekeqgp9';
const OTHER = 'account_rdx1283xglqdjv6w8jreccxwp7d0u55a8ejrkpegc3uunqedsyqt4mtg5q';
const MEMBER_BADGE = 'resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl';
const AGENT_BADGE = 'resource_rdx1nf3zadak8vdywgx3gdx5xq3svu6tf7x9dsjllvtfh97d6freptcxeh';
const ESCROW = 'component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly';
const BADGE_ID = '<guild_member_poster>';

function entitlement(over: Partial<WorkerEntitlement> = {}): WorkerEntitlement {
  return {
    reward: '1500',
    bond: '0',
    workerAccount: WORKER,
    claimerBadgeId: BADGE_ID,
    claimerIsAgent: false,
    entitlementsPresent: true,
    ...over,
  };
}

describe('isPositiveDecimal — 18dp, no float', () => {
  test('zero forms are not positive', () => {
    for (const v of ['0', '0.0', '0.000000000000000000']) {
      expect(isPositiveDecimal(v)).toBe(false);
    }
  });

  test('the smallest representable amount IS positive', () => {
    // 1 attoXRD. Number() would round this to 0 and silently strand it.
    expect(isPositiveDecimal('0.000000000000000001')).toBe(true);
  });

  test('non-decimal junk is not positive', () => {
    for (const v of ['', 'abc', '-1', '1e3']) expect(isPositiveDecimal(v)).toBe(false);
  });
});

describe('resolveWithdrawal — the refusals', () => {
  test('a readable, owed, correctly-badged entitlement is collectable', () => {
    const d = resolveWithdrawal(entitlement(), WORKER, BADGE_ID);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.badgeLocalId).toBe(BADGE_ID);
  });

  test('UNREADABLE is never reported as nothing-owed', () => {
    const d = resolveWithdrawal(null, WORKER, BADGE_ID);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal).toBe('unreadable');
  });

  test('a pre-PULL component is no-entitlement-fields, NOT nothing-owed', () => {
    // The D trap: a push component reports every entitlement absent, which
    // looks exactly like a fully-collected task if presence is not checked
    // separately from value. Both lanes read "0" here precisely because the
    // fields do not exist — and the answer must still be "cannot say".
    const d = resolveWithdrawal(
      entitlement({ entitlementsPresent: false, reward: '0', bond: '0' }),
      WORKER,
      BADGE_ID,
    );
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal).toBe('no-entitlement-fields');
  });

  test('both lanes zero on a pull component is nothing-owed', () => {
    const d = resolveWithdrawal(entitlement({ reward: '0', bond: '0' }), WORKER, BADGE_ID);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal).toBe('nothing-owed');
  });

  test('a bond-only entitlement is still collectable (poster cancelled after claim)', () => {
    // The lanes are DIFFERENT RESOURCES and are never summed. A cancel-after-
    // claim owes the worker a bond and no reward, and that must still collect.
    const d = resolveWithdrawal(entitlement({ reward: '0', bond: '10' }), WORKER, BADGE_ID);
    expect(d.ok).toBe(true);
  });

  test('refuses when this account is not the pinned payee', () => {
    const d = resolveWithdrawal(entitlement({ workerAccount: OTHER }), WORKER, BADGE_ID);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal).toBe('not-the-payee');
  });

  test('refuses when the escrow recorded no claimer badge', () => {
    const d = resolveWithdrawal(entitlement({ claimerBadgeId: null }), WORKER, BADGE_ID);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal).toBe('claimer-badge-unknown');
  });

  // ── THE MUTATION PROOF the task's acceptance criteria call for ────────────
  test('MUTATION: a badge that is not the claimer is refused', () => {
    // Chain-verified on the live component 2026-08-20: presenting a valid
    // member badge that is not the one recorded at claim reverts with
    // "you are not the worker who claimed this task" (lib.rs's
    // `withdraw_worker` claimer-badge assert). The CLI
    // must refuse BEFORE signing rather than spend a fee discovering that.
    const d = resolveWithdrawal(entitlement(), WORKER, '<guild_member_androidtg5q>');
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal).toBe('badge-unavailable');
  });

  test('MUTATION: holding no badge at all is refused, not attempted', () => {
    const d = resolveWithdrawal(entitlement(), WORKER, null);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal).toBe('badge-unavailable');
  });

  test('an UNCONFIGURED badge resource is its own refusal, not badge-unavailable', () => {
    // "We never looked" and "we looked and you don't hold it" send an operator
    // to two different places — an env var vs their wallet. Collapsing them
    // reads as an accusation about holdings that were never checked.
    const d = resolveWithdrawal(entitlement({ claimerIsAgent: true }), WORKER, null, false);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal).toBe('badge-not-configured');
  });
});

describe('explainRefusal', () => {
  const reasons: WithdrawRefusal[] = [
    'unreadable',
    'no-entitlement-fields',
    'nothing-owed',
    'claimer-badge-unknown',
    'not-the-payee',
    'badge-unavailable',
    'badge-not-configured',
    'not-committed',
  ];

  test('every refusal has a non-empty explanation naming the task', () => {
    for (const r of reasons) {
      const msg = explainRefusal(r, 7);
      expect(msg.length).toBeGreaterThan(30);
    }
  });

  test('unreadable does NOT tell the agent its money is gone', () => {
    const msg = explainRefusal('unreadable', 1).toLowerCase();
    expect(msg).toContain('unknown');
    expect(msg).not.toContain('already collected');
  });

  test('nothing-owed names every way both lanes read zero — not only "the poster must approve first"', () => {
    // escrow lib.rs: collected (withdraw_worker, or anyone's push_entitlement —
    // both pay the pinned account); not settled yet (approve_and_release,
    // release_after_review_timeout, cancel_task_by_poster_after_claim, or a dispute
    // settled by resolve_dispute / auto_resolve_dispute); or nothing due —
    // expire_claim forfeits the bond, and a RefundPoster ruling gives the worker
    // no share of reward or bond. Until kit 0.7.2 this named only approval.
    const msg = explainRefusal('nothing-owed', 9);
    for (const fact of [
      'Task 9 owes you nothing',
      'already collected',
      'your withdraw, or the public push_entitlement anyone may call, pays it into the account pinned at claim',
      'when the poster approves',
      'when anyone triggers the release after the review window',
      'when the poster cancels after your claim',
      'when a dispute is settled, whether an arbiter rules or the 72-hour default applies',
      'an expired claim forfeits its bond',
      'a dispute settled as a full refund to the poster credits the worker nothing',
    ]) {
      expect(msg).toContain(fact);
    }
    expect(msg).not.toContain('must approve first');
  });

  test('claimer-badge-unknown reassures that nothing is lost', () => {
    expect(explainRefusal('claimer-badge-unknown', 1)).toContain('Nothing is lost');
  });

  test('not-the-payee does NOT claim the transaction would revert', () => {
    // withdraw_worker asserts ONLY that the badge is the claimer's — there is
    // no caller-account check (lib.rs's `withdraw_worker` method, in full).
    // Signing anyway SUCCEEDS and pays the pinned account. An earlier message
    // said it "would revert", which sends an operator hunting for a chain
    // error that never happens.
    const msg = explainRefusal('not-the-payee', 1);
    expect(msg).not.toContain('would revert');
    expect(msg).toContain('SUCCEED');
  });

  test('badge-not-configured does not imply holdings were checked', () => {
    const msg = explainRefusal('badge-not-configured', 1);
    expect(msg).toContain('never looked up');
  });

  test('not-committed says NOT collected and does not read as a payout', () => {
    const msg = explainRefusal('not-committed', 1);
    expect(msg).toContain('NOT collected');
    expect(msg).toContain('CommittedSuccess');
    expect(msg).not.toMatch(/^Collected/);
  });
});

describe('withdrawWorkerReward — end to end with injected chain reads', () => {
  const identity = { address: WORKER } as never;
  const config = {
    escrowComponent: ESCROW,
    gatewayBaseUrl: 'https://mainnet.radixdlt.com',
    workerBadgeResource: MEMBER_BADGE,
    agentBadgeResource: AGENT_BADGE,
  } as never;

  test('dry run builds the manifest and signs nothing', async () => {
    let signed = false;
    const r = await withdrawWorkerReward({
      taskId: 1,
      live: false,
      identity,
      config,
      deps: {
        readWorkerEntitlement: async () => entitlement(),
        resolveBadgeLocalId: async () => BADGE_ID,
        withdrawWorkerOnChain: (async () => {
          signed = true;
          return { intentHash: 'x', status: 'CommittedSuccess' };
        }) as never,
      },
    });
    expect(signed).toBe(false);
    expect(r.refused).toBe(false);
    expect(r.dryRun).toBe(true);
    expect(r.manifest).toContain('"withdraw_worker"');
    expect(r.manifest).toContain('1u64');
  });

  test('the manifest passes NO destination — the payee is pinned on chain', async () => {
    const r = await withdrawWorkerReward({
      taskId: 1,
      live: false,
      identity,
      config,
      deps: {
        readWorkerEntitlement: async () => entitlement(),
        resolveBadgeLocalId: async () => BADGE_ID,
        withdrawWorkerOnChain: (async () => ({ intentHash: '', status: '' })) as never,
      },
    });
    // withdraw_worker takes exactly (task_id, badge). A deposit_batch or any
    // second account address would mean someone added a destination — which
    // the blueprint would reject, and which would misrepresent the design.
    expect(r.manifest).not.toContain('deposit_batch');
    const accountRefs = (r.manifest!.match(/account_rdx/g) ?? []).length;
    expect(accountRefs).toBe(1); // only create_proof_of_non_fungibles' account
  });

  test('an agent-badge claim resolves against the AGENT badge resource', async () => {
    const seen: string[] = [];
    await withdrawWorkerReward({
      taskId: 1,
      live: false,
      identity,
      config,
      deps: {
        readWorkerEntitlement: async () =>
          entitlement({ claimerIsAgent: true, claimerBadgeId: '#1#' }),
        resolveBadgeLocalId: async (_a: string, resource: string) => {
          seen.push(resource);
          return '#1#';
        },
        withdrawWorkerOnChain: (async () => ({ intentHash: '', status: '' })) as never,
      },
    });
    // Decided by the chain's claimer_is_agent, never by local config.
    expect(seen).toEqual([AGENT_BADGE]);
  });

  test('refuses without signing when nothing is owed', async () => {
    let signed = false;
    const r = await withdrawWorkerReward({
      taskId: 1,
      live: true, // even --live must not sign into a zero entitlement
      identity,
      config,
      deps: {
        readWorkerEntitlement: async () => entitlement({ reward: '0', bond: '0' }),
        resolveBadgeLocalId: async () => BADGE_ID,
        withdrawWorkerOnChain: (async () => {
          signed = true;
          return { intentHash: 'x', status: 'CommittedSuccess' };
        }) as never,
      },
    });
    expect(signed).toBe(false);
    expect(r.refused).toBe(true);
    expect(r.refusal).toBe('nothing-owed');
  });

  // Captures what the signing call actually RECEIVED. Every mock in this file
  // used to be `(async () => …) as never` — a shape that accepts any arity and
  // discards every argument — so the only thing assertable was that a call
  // happened. That is the same defect that let `submitTaskOnChain` sit
  // 6-args-into-7 behind 416 green tests (fixed in 3e58183): a spy that cannot
  // see its arguments turns every test using it into a call-counter.
  type SignArgs = { taskId: number; badgeResource: string; badgeLocalId: string };
  function capturingSigner(calls: SignArgs[], intentHash = 'txid_rdx1abc') {
    return (async (taskId: number, badgeResource: string, badgeLocalId: string) => {
      calls.push({ taskId, badgeResource, badgeLocalId });
      return { intentHash, status: 'CommittedSuccess' };
    }) as never;
  }

  test('--live signs exactly once, and signs the RIGHT task and badge', async () => {
    const calls: SignArgs[] = [];
    const r = await withdrawWorkerReward({
      taskId: 42,
      live: true,
      identity,
      config,
      deps: {
        readWorkerEntitlement: async () => entitlement(),
        resolveBadgeLocalId: async () => BADGE_ID,
        withdrawWorkerOnChain: capturingSigner(calls),
      },
    });
    expect(calls.length).toBe(1);
    // The VALUES, not the count. `calls.length === 1` was the whole assertion
    // here before 2026-09-02, and it holds just as well when the wrong task is
    // withdrawn with the wrong badge — which on chain is a reverted tx at best
    // and a withdrawal against someone else's claim at worst.
    expect(calls[0]).toEqual({
      taskId: 42,
      badgeResource: MEMBER_BADGE, // claimerIsAgent: false -> workerBadgeResource
      badgeLocalId: BADGE_ID,
    });
    expect(r.dryRun).toBe(false);
    expect(r.refused).toBe(false);
    expect(r.status).toBe('CommittedSuccess');
    expect(r.intentHash).toBe('txid_rdx1abc');
  });

  test('an AGENT claim signs with the agent badge, not the member badge', async () => {
    // withdraw.ts picks the resource from the CHAIN's claimerIsAgent, not from
    // config. The existing agent-badge test only checks what
    // `resolveBadgeLocalId` was asked to look up — nothing checked what was
    // actually handed to the signer, so passing the member badge through to
    // `withdraw_worker` was invisible.
    const calls: SignArgs[] = [];
    await withdrawWorkerReward({
      taskId: 7,
      live: true,
      identity,
      config,
      deps: {
        readWorkerEntitlement: async () =>
          entitlement({ claimerIsAgent: true, claimerBadgeId: '#1#' }),
        resolveBadgeLocalId: async () => '#1#',
        withdrawWorkerOnChain: capturingSigner(calls, 'txid_rdx1agent'),
      },
    });
    expect(calls.length).toBe(1);
    expect(calls[0].badgeResource).toBe(AGENT_BADGE);
    expect(calls[0].badgeResource).not.toBe(MEMBER_BADGE);
    expect(calls[0]).toEqual({ taskId: 7, badgeResource: AGENT_BADGE, badgeLocalId: '#1#' });
  });

  test('no identity refuses rather than previewing an unverifiable payee', async () => {
    const r = await withdrawWorkerReward({ taskId: 1, live: false, identity: null, config });
    expect(r.refused).toBe(true);
  });
});

// ── signed ≠ collected ───────────────────────────────────────────────────────
//
// Before this gate existed, `withdrawWorkerReward` returned `refused: false`
// for ANY status once the transaction was signed, and guild-worker — which
// branches only on `refused` — printed "Collected." over a CommittedFailure.
// The poster side (`guild-poster runWithdraw`, PR #638) already refused with
// the Gateway's error_message via describeCommitFailure; this is the worker
// half of the same contract. A local Bun.serve stands in for the Gateway
// (same idiom as guild-poster.test.ts / gateway.test.ts) so the
// fetch-and-extract of `error_message` is exercised for real.
describe('withdrawWorkerReward — a --live submission that did not commit is REFUSED, never "Collected."', () => {
  const identity = { address: WORKER } as never;
  const REVERT_REASON = 'you are not the worker who claimed this task';
  let server: ReturnType<typeof Bun.serve>;
  let gatewayBaseUrl: string;
  // Per-test canned /transaction/status body.
  let statusReply: Record<string, unknown> = {};

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req: Request): Promise<Response> {
        const path = new URL(req.url).pathname;
        if (path === '/transaction/status') return Response.json(statusReply);
        return new Response('not found', { status: 404 });
      },
    });
    gatewayBaseUrl = `http://localhost:${server.port}`;
  });
  afterAll(() => server.stop(true));

  function configAt(url: string) {
    return {
      escrowComponent: ESCROW,
      gatewayBaseUrl: url,
      workerBadgeResource: MEMBER_BADGE,
      agentBadgeResource: AGENT_BADGE,
    } as never;
  }

  function signerReturning(status: string, intentHash: string) {
    return (async () => ({ intentHash, status })) as never;
  }

  test('CommittedFailure: refused, with the Gateway error_message, intent hash and status carried', async () => {
    statusReply = { status: 'CommittedFailure', error_message: REVERT_REASON };
    const r = await withdrawWorkerReward({
      taskId: 42,
      live: true,
      identity,
      config: configAt(gatewayBaseUrl),
      deps: {
        readWorkerEntitlement: async () => entitlement(),
        resolveBadgeLocalId: async () => BADGE_ID,
        withdrawWorkerOnChain: signerReturning('CommittedFailure', 'txid_rdx1fake_failed_withdraw'),
      },
    });
    expect(r.refused).toBe(true);
    expect(r.refusal).toBe('not-committed');
    expect(r.dryRun).toBe(false);
    expect(r.status).toBe('CommittedFailure');
    expect(r.intentHash).toBe('txid_rdx1fake_failed_withdraw');
    // The operator-facing line names the leg, the status, the hash AND the chain's reason.
    expect(r.message).toContain('withdraw_worker not committed: CommittedFailure');
    expect(r.message).toContain('txid_rdx1fake_failed_withdraw');
    expect(r.message).toContain(REVERT_REASON);
    expect(r.message).toContain('NOT collected');
    // What was owed is still reported — it is still owed.
    expect(r.entitlement).toEqual({ reward: '1500', bond: '0' });
  });

  test('Rejected with no error_message from the Gateway: still refused, says so', async () => {
    statusReply = { status: 'Rejected' };
    const r = await withdrawWorkerReward({
      taskId: 42,
      live: true,
      identity,
      config: configAt(gatewayBaseUrl),
      deps: {
        readWorkerEntitlement: async () => entitlement(),
        resolveBadgeLocalId: async () => BADGE_ID,
        withdrawWorkerOnChain: signerReturning('Rejected', 'txid_rdx1fake_rejected'),
      },
    });
    expect(r.refused).toBe(true);
    expect(r.refusal).toBe('not-committed');
    expect(r.status).toBe('Rejected');
    expect(r.message).toContain('withdraw_worker not committed: Rejected (txid_rdx1fake_rejected)');
    expect(r.message).toContain('(no error_message from the Gateway)');
  });

  test('Unknown (waitForCommit timed out) against an UNROUTABLE Gateway: refused, the re-read failure never masks the status', async () => {
    // Nothing listens on port 1 — the best-effort error_message fetch fails
    // and must be swallowed, leaving status + hash for the operator.
    const r = await withdrawWorkerReward({
      taskId: 42,
      live: true,
      identity,
      config: configAt('http://127.0.0.1:1'),
      deps: {
        readWorkerEntitlement: async () => entitlement(),
        resolveBadgeLocalId: async () => BADGE_ID,
        withdrawWorkerOnChain: signerReturning('Unknown', 'txid_rdx1fake_unknown'),
      },
    });
    expect(r.refused).toBe(true);
    expect(r.refusal).toBe('not-committed');
    expect(r.status).toBe('Unknown');
    expect(r.intentHash).toBe('txid_rdx1fake_unknown');
    expect(r.message).toContain('withdraw_worker not committed: Unknown (txid_rdx1fake_unknown)');
    expect(r.message).toContain('timed out');
  });

  test('CommittedSuccess is the ONLY status that is not refused', async () => {
    statusReply = { status: 'CommittedSuccess' };
    const r = await withdrawWorkerReward({
      taskId: 42,
      live: true,
      identity,
      config: configAt(gatewayBaseUrl),
      deps: {
        readWorkerEntitlement: async () => entitlement(),
        resolveBadgeLocalId: async () => BADGE_ID,
        withdrawWorkerOnChain: signerReturning('CommittedSuccess', 'txid_rdx1ok'),
      },
    });
    expect(r.refused).toBe(false);
    expect(r.refusal).toBeUndefined();
    expect(r.message).toBeUndefined();
    expect(r.status).toBe('CommittedSuccess');
  });
});
