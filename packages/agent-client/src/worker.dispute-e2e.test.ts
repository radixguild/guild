// worker.dispute-e2e.test.ts — P1-17 (catalogue task 83): the full dispute
// path exercised ENTIRELY through agent-client's own exported functions —
// never a hand-built manifest, never guild-app's DB — against a scripted mock
// ledger whose state machine mirrors escrow/scrypto/guild-marketplace-escrow's
// TaskState transitions (Open → Claimed → Submitted → Disputed →
// Released/Refunded).
//
// WHAT THIS COVERS THAT tx.test.ts / dispute.test.ts / withdraw.test.ts DO NOT.
// Those three files prove each verb's OWN guard rails in isolation, each
// against a freshly-typed fixture. Nothing anywhere threads runWorkerCycle's
// claim/submit legs, dispute.ts's raiseDispute/resolveDispute, and
// withdraw.ts's withdrawWorkerReward through ONE shared, stateful ledger and
// checks that what one leg produces is what the next leg actually consumes —
// e.g. that the claim receipt id runWorkerCycle bonds is the SAME one it burns
// at submit, that the badge id raiseDispute resolves is the SAME one the
// (mock) chain recorded at claim, and that auto-resolve's credited amount is
// the SAME amount withdraw collects. That is the gap gate1-e2e.mjs's own
// `--mock --dispute` leaves: its mock models DB status transitions
// (open→assigned→submitted→disputed→paid) and stubs raiseDisputeOnChain /
// autoResolveDisputeOnChain as one-line canned returns — it never exercises
// dispute.ts's raiseDispute/resolveDispute orchestration (badge resolution,
// evidence hashing, the production fuse) and never calls withdraw.ts at all.
//
// THE MOCK LEDGER'S FIDELITY, AND ITS DELIBERATE LIMITS. `MockLedger` below
// enforces the blueprint's state preconditions (raise_dispute needs
// Submitted, auto_resolve_dispute needs Disputed AND the window elapsed,
// withdraw only pays what auto-resolve credited) and its PULL entitlement
// math for the SplitEvenly default that is actually deployed (DB-1,
// 2026-08-06): the reward splits 50/50, the insurance premium returns to the
// poster in full (nobody judged the work — see auto_resolve_dispute's own
// doc comment), and the claim bond follows the REWARD ruling proportionally
// (W5). It uses plain integer XRD amounts rather than 18dp Decimal strings —
// the exact-decimal-string discipline is tx.test.ts / gateway.ts's own
// territory (isPositiveDecimal, checked_round) and is not what this file is
// proving.
//
// THE PRODUCTION FUSE STAYS ARMED. `assertLiveDisputeAllowed` (tx.ts) is not
// reimplemented or weakened anywhere here — the fuse tests at the bottom call
// the REAL raiseDisputeOnChain/autoResolveDisputeOnChain (and the REAL
// raiseDispute orchestration) against the shipped LIVE_ESCROW_COMPONENT and
// require them to refuse, proving this journey's mocked ledger can never
// substitute for signing against production.
//
// WHAT worker.ts's DESIGN MEANS FOR "DB CONFIRMS SENT": claim and submit each
// end in `api.confirmEscrow(...)` (worker.ts's confirmEscrowWithRetry) — this
// file asserts those two DB confirms happen, exactly as worker.test.ts does.
// raiseDispute / resolveDispute / withdrawWorkerReward do NOT call the DB at
// all — dispute.ts and withdraw.ts import nothing from api.ts. That is not a
// gap in this test; it is the documented "chain-first, not DB-first" property
// worker.ts's post-submit survey exists to bridge (its own comment: "a
// dispute raised by a hand-built manifest moves the task to Disputed on chain
// while the API still says submitted — that is not hypothetical, it is how
// live task 3 was disputed"). This file reproduces exactly that gap on
// purpose and proves the survey closes it by reading the chain.

import { describe, test, expect } from 'bun:test';
import {
  type EscrowConfirmKind,
  type GuildApiClient,
  type GuildTask,
  type ListTasksFilters,
} from './api.js';
import type { GuildClientConfig } from './config.js';
import { LIVE_ESCROW_COMPONENT, MAINNET_XRD } from './config.js';
import { raiseDispute, resolveDispute } from './dispute.js';
import { disputeEvidenceHash, evidenceHash } from './evidence.js';
import type { AgentIdentity } from './identity.js';
import {
  autoResolveDisputeManifest,
  claimTaskManifest,
  raiseDisputeManifest,
  submitTaskManifest,
  withdrawWorkerManifest,
} from './manifests.js';
import { autoResolveDisputeOnChain, raiseDisputeOnChain } from './tx.js';
import { withdrawWorkerReward } from './withdraw.js';
import { workBriefHash, type TaskTerms } from './work-brief.js';
import { runWorkerCycle } from './worker.js';

// ── Fixtures shared by the whole journey ────────────────────────────────────

const WORKER = 'account_rdx12890803ct999t5ss4qatjyktay82gfy295rr6p4qmhks8twekeqgp9';
const POSTER = 'account_rdx1283xglqdjv6w8jreccxwp7d0u55a8ejrkpegc3uunqedsyqt4mtg5q';
// The Guild Member badge resource. Claim_task "takes either" the agent badge
// or the Member badge (tx.ts's own doc comment on claimTaskOnChain) — this
// journey claims with the Member badge, so config.agentBadgeResource is
// pointed at the SAME resource as config.workerBadgeResource. That is what
// makes claimer_is_agent=false the correct value for the mock ledger below,
// not an arbitrary choice.
const MEMBER_BADGE = 'resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl';
const CLAIM_RECEIPT_RESOURCE =
  'resource_rdx1n2z2rpjuwg2fu54qmcga862q7kl0qkp4rl9pvfh20z55utku84u9al';
// A non-production rehearsal component — the same literal tx.test.ts uses for
// its "a non-production component is NOT fused" case, so this journey is
// provably NOT the address the live-dispute fuse exists to refuse.
const ESCROW = 'component_rdx1cqudk8vxaf24xevekzu49mw0292qmhaa85klypxu5sh4yh7nsddhwj';
const GW = 'https://mock.gateway.test';
const BADGE_ID = '<guild_member_alice>';
const ONCHAIN_TASK_ID = 42;
const DB_TASK_ID = 7;
const CLAIM_RECEIPT_ID = 501;
const BOND_XRD = '10';
// 72h — mirrors the blueprint's deployed `dispute_auto_resolve_secs` and the
// window `auto_resolve_dispute` pins at raise_dispute time.
const AUTO_RESOLVE_WINDOW_MS = 72 * 60 * 60 * 1000;

const identity = { address: WORKER } as unknown as AgentIdentity;

const config = {
  escrowComponent: ESCROW,
  gatewayBaseUrl: GW,
  workerBadgeResource: MEMBER_BADGE,
  agentBadgeResource: MEMBER_BADGE,
  agentBadgeLocalId: BADGE_ID,
  claimReceiptResource: CLAIM_RECEIPT_RESOURCE,
} as unknown as GuildClientConfig;

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

// ── The mock ledger: mirrors escrow/scrypto/guild-marketplace-escrow's
// TaskState machine + PULL entitlement crediting (lib.rs raise_dispute /
// auto_resolve_dispute / credit_split_for_parties / withdraw_worker). ────────

type LedgerState = 'Open' | 'Claimed' | 'Submitted' | 'Disputed' | 'Released' | 'Refunded';

class MockLedger {
  state: LedgerState = 'Open';
  /** Manual clock — advanced explicitly, never wall-clock, so the "before the
   *  window" / "after the window" cases are deterministic and fast. */
  nowMs = 1_800_000_000_000;

  claimReceiptId: number | null = null;
  workerAccount: string | null = null;
  claimerBadgeId: string | null = null;
  claimerIsAgent = false;

  disputedAtMs: number | null = null;
  /** Pinned at raise_dispute, exactly as lib.rs pins it — a later window/
   *  default change must not move a dispute already in flight. */
  pinnedWindowMs: number | null = null;

  readonly rewardAmount = 100;
  readonly bondAmount = 10;
  readonly insuranceAmount = 5;

  workerEntitledReward = 0;
  posterEntitledReward = 0;
  workerEntitledBond = 0;
  posterEntitledBond = 0;

  advance(ms: number): void {
    this.nowMs += ms;
  }

  /** Mirrors lib.rs claim_task: `assert_eq!(task.state, TaskState::Open, ...)`. */
  claim(workerAccount: string, badgeLocalId: string): void {
    if (this.state !== 'Open') throw new Error('task must be Open to claim');
    this.state = 'Claimed';
    this.workerAccount = workerAccount;
    this.claimerBadgeId = badgeLocalId;
    this.claimerIsAgent = false; // claimed with the Member badge, not the agent badge
    this.claimReceiptId = CLAIM_RECEIPT_ID;
  }

  /** Mirrors lib.rs submit_task: needs Claimed, burns the claim receipt. */
  submit(claimReceiptId: number): void {
    if (this.state !== 'Claimed') throw new Error('task must be Claimed to submit');
    if (this.claimReceiptId !== claimReceiptId) {
      throw new Error('claim receipt does not match the one this task was claimed with');
    }
    this.state = 'Submitted';
    this.claimReceiptId = null; // burned, exactly like the real submit_task
  }

  /** Mirrors lib.rs raise_dispute: needs Submitted, checks the claimer badge,
   *  pins the window at raise time. */
  raiseDispute(badgeLocalId: string): void {
    if (this.state !== 'Submitted') throw new Error('task must be Submitted to dispute');
    if (this.claimerBadgeId !== badgeLocalId) {
      throw new Error('you are not the worker who claimed this task');
    }
    this.state = 'Disputed';
    this.disputedAtMs = this.nowMs;
    this.pinnedWindowMs = AUTO_RESOLVE_WINDOW_MS;
  }

  /**
   * Mirrors lib.rs auto_resolve_dispute under the deployed SplitEvenly
   * default: needs Disputed AND the pinned window elapsed, applies a 50/50
   * reward split, returns the insurance premium to the poster in full (no
   * arbiter judged the work), and splits the claim bond proportionally to
   * the SAME (reward) ruling — credit_split_for_parties's W5 rule.
   */
  autoResolve(): void {
    if (this.state !== 'Disputed') throw new Error('task must be Disputed to auto-resolve');
    const elapsed = this.nowMs - (this.disputedAtMs ?? 0);
    if (elapsed < (this.pinnedWindowMs ?? 0)) {
      throw new Error('dispute auto-resolve window has not elapsed');
    }
    const workerReward = Math.floor(this.rewardAmount * 0.5);
    this.workerEntitledReward = workerReward;
    this.posterEntitledReward = this.rewardAmount - workerReward + this.insuranceAmount;
    const workerBond = Math.floor(this.bondAmount * 0.5);
    this.workerEntitledBond = workerBond;
    this.posterEntitledBond = this.bondAmount - workerBond;
    // Split maps to Released, same as PayWorker — only RefundPoster maps to
    // Refunded (lib.rs: `DisputeRuling::PayWorker | Split => Released`).
    this.state = 'Released';
  }

  /** Mirrors lib.rs withdraw_worker: pays whatever is currently entitled and
   *  zeroes it — collectable ONLY once auto-resolve (or an arbiter) credited
   *  something, never before. */
  withdrawWorker(): { reward: number; bond: number } {
    const reward = this.workerEntitledReward;
    const bond = this.workerEntitledBond;
    this.workerEntitledReward = 0;
    this.workerEntitledBond = 0;
    return { reward, bond };
  }
}

/** WorkerEntitlement-shaped read of the ledger's worker-side credit, in the
 *  exact decimal-string shape gateway.ts's readWorkerEntitlement returns. */
function ledgerEntitlement(ledger: MockLedger) {
  return {
    reward: String(ledger.workerEntitledReward),
    bond: String(ledger.workerEntitledBond),
    workerAccount: ledger.workerAccount,
    claimerBadgeId: ledger.claimerBadgeId,
    claimerIsAgent: ledger.claimerIsAgent,
    entitlementsPresent: true,
  };
}

// ── The fake API: one mutable DB task, driven by confirmEscrow exactly like
// worker.test.ts's fakeApi — and, deliberately, NEVER advanced by
// raiseDispute/resolveDispute/withdrawWorkerReward, because nothing in this
// package calls the DB from those three. ───────────────────────────────────

function makeDbTask(): GuildTask {
  return {
    id: DB_TASK_ID,
    title: 'P1-17 dispute e2e smoke task',
    description: 'Programmatic worker-side dispute journey proof (task 83).',
    status: 'open',
    rewardXrd: '100',
    creatorId: POSTER,
    assigneeId: null,
    requiredTier: 'member',
    xpReward: 0,
    onChainTaskId: ONCHAIN_TASK_ID,
    deadline: null,
    createdAt: '',
    updatedAt: '',
  };
}

interface FakeApiState {
  dbTask: GuildTask;
  authenticated: boolean;
  submissions: { taskId: number; content: string }[];
  confirms: { taskId: number; kind: EscrowConfirmKind; intentHash: string }[];
}

function fakeApi(state: FakeApiState): GuildApiClient {
  const api = {
    // The SAME `config` used for dispute.ts/withdraw.ts below — worker.ts
    // forwards `api.config` straight through to txFns.claimTaskOnChain, so
    // this must carry agentBadgeResource/agentBadgeLocalId too, not just the
    // three fields the claim/submit dedup reads use directly.
    config,
    get isAuthenticated(): boolean {
      return state.authenticated;
    },
    authenticate: () => {
      state.authenticated = true;
      return Promise.resolve({ id: WORKER });
    },
    listTasks: (filters: ListTasksFilters = {}) => {
      const match = state.dbTask.status === filters.status;
      return Promise.resolve({ data: match ? [state.dbTask] : [], cursor: null, hasMore: false });
    },
    createSubmission: (taskId: number, content: string) => {
      state.submissions.push({ taskId, content });
      return Promise.resolve({
        id: 1,
        taskId,
        submitterId: WORKER,
        content,
        status: 'pending',
        createdAt: '',
      });
    },
    confirmEscrow: (taskId: number, kind: EscrowConfirmKind, intentHash: string) => {
      state.confirms.push({ taskId, kind, intentHash });
      if (kind === 'claim') {
        state.dbTask = { ...state.dbTask, status: 'assigned', assigneeId: WORKER };
      } else if (kind === 'submit') {
        state.dbTask = { ...state.dbTask, status: 'submitted' };
      }
      return Promise.resolve(state.dbTask);
    },
  };
  return api as unknown as GuildApiClient;
}

// ── The full journey ─────────────────────────────────────────────────────

describe('worker dispute journey — claim → submit → dispute → resolve → withdraw, through agent-client\'s own functions', () => {
  test('end to end against the scripted mock ledger', async () => {
    const ledger = new MockLedger();
    const state: FakeApiState = {
      dbTask: makeDbTask(),
      authenticated: false,
      submissions: [],
      confirms: [],
    };
    const claimManifests: string[] = [];
    const submitManifests: string[] = [];

    // txFns replaces the WHOLE tx.ts leg (worker.test.ts's own spyTxFns
    // pattern) — but each fake still builds its manifest with the REAL
    // builder from manifests.ts, so what it records is byte-identical to
    // what claimTaskOnChain/submitTaskOnChain would themselves have produced
    // from the same arguments, not a stub string.
    const txFns = {
      claimTaskOnChain: async (
        onChainTaskId: number,
        ident: { address: string },
        cfg: GuildClientConfig,
        _workBrief: unknown
      ) => {
        const manifest = claimTaskManifest(
          cfg.escrowComponent,
          ident.address,
          cfg.agentBadgeResource,
          cfg.agentBadgeLocalId,
          onChainTaskId,
          MAINNET_XRD,
          BOND_XRD
        );
        claimManifests.push(manifest);
        ledger.claim(ident.address, cfg.agentBadgeLocalId);
        return { intentHash: 'txid_rdx1mockclaim', status: 'CommittedSuccess' as const };
      },
      submitTaskOnChain: async (
        onChainTaskId: number,
        claimReceiptId: number,
        evidenceHashHex: string,
        ident: { address: string },
        cfg: GuildClientConfig,
        workBrief: { title: string; description: string; terms?: TaskTerms | null; dueIso: string | null }
      ) => {
        const briefHashHex = await workBriefHash(
          workBrief.title,
          workBrief.description,
          workBrief.terms,
          workBrief.dueIso
        );
        const manifest = submitTaskManifest(
          cfg.escrowComponent,
          ident.address,
          cfg.claimReceiptResource,
          claimReceiptId,
          onChainTaskId,
          evidenceHashHex,
          briefHashHex
        );
        submitManifests.push(manifest);
        ledger.submit(claimReceiptId);
        return { intentHash: 'txid_rdx1mocksubmit', status: 'CommittedSuccess' as const };
      },
    } as unknown as NonNullable<Parameters<typeof runWorkerCycle>[0]['txFns']>;

    // ── 1–2. Claim then submit. worker.test.ts's own "claim and submit may
    // land in the same cycle" note (mirrored from gate1-e2e.mjs) applies
    // here: the fake DB flips open→assigned inside step 1's confirmEscrow,
    // so step 2's `assigned` survey (same cycle) immediately sees and works
    // it. That is a real, documented worker.ts behaviour, not a test
    // shortcut. ──────────────────────────────────────────────────────────
    const cycle1 = await runWorkerCycle({
      api: fakeApi(state),
      identity,
      dryRun: false,
      onChain: true,
      trustedPosters: [POSTER],
      txFns,
      resolveClaimReceiptId: async () => ledger.claimReceiptId,
      readTaskState: async () => ledger.state,
      // The task is only 'Submitted' by the time this cycle's own post-submit
      // survey pass runs, so entitlements must never be read here — belt and
      // braces against an accidental real network default (worker.test.ts's
      // own "no accidental network" regression, reproduced defensively).
      readWorkerEntitlement: () => {
        throw new Error('must not read entitlements before the task settles');
      },
      doWork: async task => `Dispute e2e worker output for task #${task.id}.`,
      log: silentLog,
    });

    expect(cycle1.claimedTaskIds).toEqual([DB_TASK_ID]);
    expect(cycle1.submittedTaskIds).toEqual([DB_TASK_ID]);
    expect(ledger.state).toBe('Submitted');
    expect(ledger.claimReceiptId).toBeNull(); // burned at submit
    // DB confirms sent — the only two legs that touch the DB at all.
    expect(state.confirms).toEqual([
      { taskId: DB_TASK_ID, kind: 'claim', intentHash: 'txid_rdx1mockclaim' },
      { taskId: DB_TASK_ID, kind: 'submit', intentHash: 'txid_rdx1mocksubmit' },
    ]);
    expect(state.dbTask.status).toBe('submitted');

    // Manifests byte-exact against the real builders, fed the SAME arguments
    // runWorkerCycle actually threaded through (on-chain id, the claim
    // receipt runWorkerCycle just bonded, the config's badge fields).
    expect(claimManifests).toHaveLength(1);
    expect(claimManifests[0]).toBe(
      claimTaskManifest(
        ESCROW,
        WORKER,
        MEMBER_BADGE,
        BADGE_ID,
        ONCHAIN_TASK_ID,
        MAINNET_XRD,
        BOND_XRD
      )
    );
    expect(submitManifests).toHaveLength(1);
    const expectedBriefHash = await workBriefHash(
      'P1-17 dispute e2e smoke task',
      'Programmatic worker-side dispute journey proof (task 83).',
      null,
      null
    );
    // The frozen-v1 evidence hash worker.ts itself computes from the doWork
    // output — independently derived here (not read back out of the manifest
    // under test), so this is a real check that runWorkerCycle hashed the
    // ACTUAL submission content, not a tautology.
    const expectedEvidenceHashHex = await evidenceHash(`Dispute e2e worker output for task #${DB_TASK_ID}.`);
    expect(submitManifests[0]).toBe(
      submitTaskManifest(
        ESCROW,
        WORKER,
        CLAIM_RECEIPT_RESOURCE,
        CLAIM_RECEIPT_ID,
        ONCHAIN_TASK_ID,
        expectedEvidenceHashHex,
        expectedBriefHash
      )
    );

    // ── 3. Worker raises the dispute — dispute.ts's raiseDispute(), live. ──
    const DISPUTE_REASON = 'The delivered work does not match the posted brief.';
    const raised = await raiseDispute({
      taskId: ONCHAIN_TASK_ID,
      reason: DISPUTE_REASON,
      live: true,
      identity,
      config,
      deps: {
        resolveBadgeLocalId: async () => BADGE_ID,
        raiseDisputeOnChain: async () => {
          ledger.raiseDispute(BADGE_ID);
          return { intentHash: 'txid_rdx1mockraise', status: 'CommittedSuccess' };
        },
      },
    });
    expect(raised.refused).toBe(false);
    expect(raised.dryRun).toBe(false);
    expect(ledger.state).toBe('Disputed');
    const expectedEvidenceHash = await disputeEvidenceHash(DISPUTE_REASON);
    expect(raised.evidenceHash).toBe(expectedEvidenceHash);
    // dispute.ts builds this manifest itself, BEFORE calling the (mocked)
    // signer — so this is production code's own output, not a copy of it.
    expect(raised.manifest).toBe(
      raiseDisputeManifest(ESCROW, WORKER, MEMBER_BADGE, BADGE_ID, ONCHAIN_TASK_ID, expectedEvidenceHash)
    );

    // ── 4. Post-submit survey sees the dispute and REPORTS it — never acts.
    // The DB never heard about the dispute (raiseDispute touches no API), so
    // this is the exact "chain says Disputed, API still says submitted"
    // blind spot worker.ts's own comment names, and the survey has to find
    // it under the SUBMITTED listing, not a disputed one. ─────────────────
    const warnLines: string[] = [];
    const cycle2 = await runWorkerCycle({
      api: fakeApi(state),
      identity,
      readTaskState: async () => ledger.state,
      readWorkerEntitlement: () => {
        throw new Error('must not read entitlements before the task settles');
      },
      log: { info: () => {}, warn: m => warnLines.push(m), error: () => {} },
    });
    expect(cycle2.disputedTaskIds).toEqual([DB_TASK_ID]);
    expect(cycle2.uncollectedTaskIds).toEqual([]);
    expect(cycle2.driftedTaskIds).toEqual([]); // Disputed has its own branch, not the drift branch
    expect(warnLines.some(w => w.includes(`task #${DB_TASK_ID} is DISPUTED`))).toBe(true);
    expect(
      warnLines.some(w => w.includes('this agent will not raise or resolve a dispute on its own'))
    ).toBe(true);
    // Structural proof, not just a log line: nothing above ever handed
    // runWorkerCycle a way to reach raiseDisputeOnChain / autoResolveDisputeOnChain
    // at all — WorkerOptions has no such seam — so "reports, never acts" holds
    // by construction, not merely by this cycle's fixtures happening not to fire it.

    // ── 5. Auto-resolve refused before the window, accepted after. ────────
    await expect(
      resolveDispute({
        taskId: ONCHAIN_TASK_ID,
        live: true,
        identity,
        config,
        deps: {
          autoResolveDisputeOnChain: async () => {
            ledger.autoResolve(); // throws — window not elapsed
            return { intentHash: 'unreachable', status: 'CommittedSuccess' };
          },
        },
      })
    ).rejects.toThrow('dispute auto-resolve window has not elapsed');
    expect(ledger.state).toBe('Disputed'); // unchanged by the refused attempt

    ledger.advance(AUTO_RESOLVE_WINDOW_MS + 1); // past the pinned window

    const resolved = await resolveDispute({
      taskId: ONCHAIN_TASK_ID,
      live: true,
      identity,
      config,
      deps: {
        autoResolveDisputeOnChain: async () => {
          ledger.autoResolve();
          return { intentHash: 'txid_rdx1mockresolve', status: 'CommittedSuccess' };
        },
      },
    });
    expect(resolved.dryRun).toBe(false);
    expect(resolved.manifest).toBe(autoResolveDisputeManifest(ESCROW, ONCHAIN_TASK_ID));
    expect(ledger.state).toBe('Released');
    // SplitEvenly: reward 100 → 50/50; insurance 5 stays with the poster in
    // full; bond 10 follows the reward ruling → 5/5.
    expect(ledger.workerEntitledReward).toBe(50);
    expect(ledger.posterEntitledReward).toBe(55);
    expect(ledger.workerEntitledBond).toBe(5);
    expect(ledger.posterEntitledBond).toBe(5);

    // ── 6. The next survey now sees BOTH a drift (DB still 'submitted',
    // chain now 'Released') AND uncollected money — the exact scenario
    // worker.ts's step-3 comments describe as "almost never still sitting in
    // submitted", except here it genuinely is, because nothing in this
    // package ever told the DB. ────────────────────────────────────────────
    const cycle3 = await runWorkerCycle({
      api: fakeApi(state),
      identity,
      readTaskState: async () => ledger.state,
      readWorkerEntitlement: async () => ledgerEntitlement(ledger),
      log: silentLog,
    });
    expect(cycle3.driftedTaskIds).toEqual([DB_TASK_ID]);
    expect(cycle3.uncollectedTaskIds).toEqual([DB_TASK_ID]);

    // ── 7. Withdraw collects exactly the ruled amounts. ────────────────────
    const withdrawn = await withdrawWorkerReward({
      taskId: ONCHAIN_TASK_ID,
      live: true,
      identity,
      config,
      deps: {
        readWorkerEntitlement: async () => ledgerEntitlement(ledger),
        resolveBadgeLocalId: async () => BADGE_ID,
        withdrawWorkerOnChain: async () => {
          ledger.withdrawWorker();
          return { intentHash: 'txid_rdx1mockwithdraw', status: 'CommittedSuccess' };
        },
      },
    });
    expect(withdrawn.refused).toBe(false);
    expect(withdrawn.dryRun).toBe(false);
    expect(withdrawn.entitlement).toEqual({ reward: '50', bond: '5' });
    expect(withdrawn.manifest).toBe(
      withdrawWorkerManifest(ESCROW, WORKER, MEMBER_BADGE, BADGE_ID, ONCHAIN_TASK_ID)
    );
    expect(ledger.workerEntitledReward).toBe(0);
    expect(ledger.workerEntitledBond).toBe(0);

    // ── 8. One more survey: the entitlement is now present but zero, so
    // uncollectedTaskIds clears — proving withdraw actually moved the number
    // the survey reads, not just that withdraw "succeeded". ───────────────
    const cycle4 = await runWorkerCycle({
      api: fakeApi(state),
      identity,
      readTaskState: async () => ledger.state,
      readWorkerEntitlement: async () => ledgerEntitlement(ledger),
      log: silentLog,
    });
    expect(cycle4.uncollectedTaskIds).toEqual([]);
  });

  test('withdraw is refused (nothing-owed) while the dispute is still open — settlement is a precondition, not a formality', async () => {
    const ledger = new MockLedger();
    ledger.claim(WORKER, BADGE_ID);
    ledger.submit(CLAIM_RECEIPT_ID);
    ledger.raiseDispute(BADGE_ID);
    expect(ledger.state).toBe('Disputed');

    let signed = false;
    const r = await withdrawWorkerReward({
      taskId: ONCHAIN_TASK_ID,
      live: true, // even --live must not sign into a zero (unsettled) entitlement
      identity,
      config,
      deps: {
        readWorkerEntitlement: async () => ledgerEntitlement(ledger), // reward/bond both still 0
        resolveBadgeLocalId: async () => BADGE_ID,
        withdrawWorkerOnChain: async () => {
          signed = true;
          return { intentHash: 'x', status: 'CommittedSuccess' };
        },
      },
    });
    expect(signed).toBe(false);
    expect(r.refused).toBe(true);
    expect(r.refusal).toBe('nothing-owed');
  });
});

// ── The live-dispute fuse: proven to refuse a PRODUCTION component even
// inside this journey's own harness, using the REAL tx.ts functions (not the
// mocked ledger deps above) — so nothing about building this test's mock
// ledger could have quietly weakened `assertLiveDisputeAllowed`. ───────────

describe('the live-dispute fuse still refuses production, exercised through this same journey shape', () => {
  const prodConfig = { ...config, escrowComponent: LIVE_ESCROW_COMPONENT } as unknown as GuildClientConfig;

  test('raiseDisputeOnChain (real, unmocked) refuses against LIVE_ESCROW_COMPONENT', async () => {
    await expect(raiseDisputeOnChain(ONCHAIN_TASK_ID, identity, prodConfig)).rejects.toThrow(
      'Refusing to sign raise_dispute against a PRODUCTION escrow component'
    );
  });

  test('autoResolveDisputeOnChain (real, unmocked) refuses against LIVE_ESCROW_COMPONENT', async () => {
    await expect(autoResolveDisputeOnChain(ONCHAIN_TASK_ID, identity, prodConfig)).rejects.toThrow(
      'Refusing to sign auto_resolve_dispute against a PRODUCTION escrow component'
    );
  });

  // The orchestration layer this journey actually drives (dispute.ts), with
  // ONLY the badge lookup faked — the fuse itself is the real one, called
  // from inside the real raiseDisputeOnChain, exactly as production wires it.
  test('raiseDispute() (dispute.ts orchestration) refuses live against production — the fuse is not bypassable from this layer', async () => {
    await expect(
      raiseDispute({
        taskId: ONCHAIN_TASK_ID,
        reason: 'x',
        live: true,
        identity,
        config: prodConfig,
        deps: {
          resolveBadgeLocalId: async () => BADGE_ID,
          raiseDisputeOnChain, // the REAL function — not a mock
        },
      })
    ).rejects.toThrow('Refusing to sign raise_dispute against a PRODUCTION escrow component');
  });

  test('resolveDispute() (dispute.ts orchestration) refuses live against production — same fuse, same layer', async () => {
    await expect(
      resolveDispute({
        taskId: ONCHAIN_TASK_ID,
        live: true,
        identity,
        config: prodConfig,
        deps: { autoResolveDisputeOnChain }, // the REAL function — not a mock
      })
    ).rejects.toThrow('Refusing to sign auto_resolve_dispute against a PRODUCTION escrow component');
  });

  // A dry run must warn rather than throw (nothing is signed on a preview),
  // matching dispute.test.ts's own coverage — repeated here only to prove
  // this journey's config plumbing (prodConfig) triggers the SAME warning
  // path a real operator preview would hit before ever reaching --live.
  test('a dry run against production warns instead of throwing', async () => {
    const r = await raiseDispute({
      taskId: ONCHAIN_TASK_ID,
      reason: 'x',
      live: false,
      identity,
      config: prodConfig,
      deps: {
        resolveBadgeLocalId: async () => BADGE_ID,
        raiseDisputeOnChain: async () => ({ intentHash: '', status: '' }),
      },
    });
    expect(r.refused).toBe(false);
    expect(r.productionFuseWarning).toContain('GUILD_ALLOW_LIVE_DISPUTE');
  });
});
