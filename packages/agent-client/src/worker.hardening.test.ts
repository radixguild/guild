// Adversarial hardening for runWorkerCycle — recovery + lifecycle orderings.
//
// Reuses the sibling worker.test.ts injected-fake pattern (fake api, spy txFns,
// injected readTaskState / resolveClaimReceiptId, confirmEscrow via the api fake,
// tiny confirmRetryDelayMs, log capture). These tests PROVE the applied fixes:
//   - in-cycle duplicate task id ⇒ dedup Set ⇒ exactly ONE bond (no double-bond)
//   - claim confirm 422-exhausted ⇒ error recorded + breadcrumb persisted, no hang
//   - claim confirm non-422 ⇒ surfaces immediately (no retry) + breadcrumb persisted
//   - resolveClaimReceiptId throwing in the dedup step is swallowed ⇒ proceed to pin
//   - submit not CommittedSuccess ⇒ error recorded, never confirmed
//   - self-authored open task ⇒ never claimed
//   - pin terminal on-chain states ⇒ never bonded

import { describe, test, expect } from 'bun:test';
import { GuildApiError, type EscrowConfirmKind, type GuildApiClient, type GuildTask } from './api.js';
import type { AgentIdentity } from './identity.js';
import type { TransactionStatus } from './tx.js';
import { runWorkerCycle, type IntentRecord } from './worker.js';

const ME = 'account_rdx1me';
const CLAIM_RESOURCE = 'resource_rdx1_claim';
const GW = 'http://gateway.test';

function task(partial: Partial<GuildTask>): GuildTask {
  return {
    id: 1,
    title: 't',
    description: 'd',
    status: 'open',
    rewardXrd: '1',
    creatorId: 'account_rdx1other',
    assigneeId: null,
    requiredTier: 'member',
    xpReward: 0,
    onChainTaskId: null,
    deadline: null,
    createdAt: '',
    updatedAt: '',
    ...partial,
  };
}

interface FakeApi {
  authenticated: boolean;
  submissions: { taskId: number; content: string }[];
  confirms: { taskId: number; kind: EscrowConfirmKind; intentHash: string }[];
  failWith?: GuildApiError;
  /** Reject the first N confirmEscrow calls with HTTP 422 (Gateway-lag sim). */
  confirmFailTimes?: number;
  /** Reject EVERY confirmEscrow call with this error (non-422 / exhaustion sims). */
  confirmRejectWith?: GuildApiError;
  openTasks?: GuildTask[];
  assignedTasks?: GuildTask[];
}

function fakeApi(state: FakeApi): GuildApiClient {
  const api = {
    config: { claimReceiptResource: CLAIM_RESOURCE, gatewayBaseUrl: GW },
    get isAuthenticated(): boolean {
      return state.authenticated;
    },
    authenticate: () => {
      state.authenticated = true;
      return Promise.resolve({ id: ME });
    },
    listTasks: (filters: { status?: string } = {}) => {
      if (filters.status === 'open') {
        return Promise.resolve({
          data: state.openTasks ?? [task({ id: 10, status: 'open' })],
          cursor: null,
          hasMore: false,
        });
      }
      return Promise.resolve({
        data: state.assignedTasks ?? [
          task({ id: 20, status: 'assigned', assigneeId: ME }),
          task({ id: 21, status: 'assigned', assigneeId: 'account_rdx1someoneelse' }),
        ],
        cursor: null,
        hasMore: false,
      });
    },
    createSubmission: (taskId: number, content: string) => {
      if (state.failWith) return Promise.reject(state.failWith);
      state.submissions.push({ taskId, content });
      return Promise.resolve({
        id: 1,
        taskId,
        submitterId: ME,
        content,
        status: 'pending',
        createdAt: '',
      });
    },
    confirmEscrow: (taskId: number, kind: EscrowConfirmKind, intentHash: string) => {
      state.confirms.push({ taskId, kind, intentHash });
      if (state.confirmRejectWith) return Promise.reject(state.confirmRejectWith);
      if (state.confirmFailTimes && state.confirmFailTimes > 0) {
        state.confirmFailTimes -= 1;
        return Promise.reject(new GuildApiError('UNVERIFIED_EVENT', 'not indexed yet', 422));
      }
      return Promise.resolve(
        task({ id: taskId, status: kind === 'claim' ? 'assigned' : 'submitted' })
      );
    },
  };
  return api as unknown as GuildApiClient;
}

const identity = { address: ME } as AgentIdentity;
const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

/** Spy txFns returning fixed statuses; records the args each leg was called with. */
function spyTxFns(claimStatus: TransactionStatus, submitStatus: TransactionStatus) {
  const calls = {
    claim: [] as number[],
    submit: [] as {
      onChainTaskId: number;
      claimReceiptId: number;
      evidenceHashHex: string;
      workBrief: unknown;
    }[],
    // Captured separately from `claim`/`submit` so the ~7 existing id-shaped
    // assertions below stay untouched. Both legs take a REQUIRED workBrief and
    // both spies used to discard it — see the cast note below.
    claimBrief: [] as unknown[],
  };
  const txFns = {
    claimTaskOnChain: (
      onChainTaskId: number,
      _identity: unknown,
      _config: unknown,
      workBrief: unknown
    ) => {
      calls.claim.push(onChainTaskId);
      calls.claimBrief.push(workBrief);
      return Promise.resolve({ intentHash: 'txid_rdx1claim', status: claimStatus });
    },
    submitTaskOnChain: (
      onChainTaskId: number,
      claimReceiptId: number,
      evidenceHashHex: string,
      _identity: unknown,
      _config: unknown,
      workBrief: unknown
    ) => {
      calls.submit.push({ onChainTaskId, claimReceiptId, evidenceHashHex, workBrief });
      return Promise.resolve({ intentHash: 'txid_rdx1submit', status: submitStatus });
    },
    // ⚠️ THE CAST IS WHY ARITY BREAKS LIVE HERE. Every spy is cast through
    // `unknown`, so a spy may declare FEWER parameters than the real function
    // takes and the suite still passes — the extra arguments are silently
    // discarded. That is exactly how `submitTaskOnChain` sat 6-args-into-7 for
    // three days behind 416 green tests (fixed in 3e58183), and this file was
    // NOT part of that fix: its submit spy declared 3 of 6 parameters and its
    // claim spy 1 of 4. `tsc` still checks worker.ts's real call sites, so a
    // wrong ARITY is caught at compile time — what nothing checked was the
    // VALUE each leg forwards. Assert on captured arguments, never on the shape.
  } as unknown as NonNullable<Parameters<typeof runWorkerCycle>[0]['txFns']>;
  return { calls, txFns };
}

describe('runWorkerCycle — claim leg hardening (dedup + confirm recovery)', () => {
  const fundedOpen = () => [task({ id: 30, status: 'open', onChainTaskId: 42 })];

  test('in-cycle duplicate task id is bonded only ONCE (dedup Set, no double-bond)', async () => {
    // Same funded, open task id appears TWICE in one page (pagination overlap or a
    // hostile server). With budget 2 both could theoretically be claimed — the
    // processedThisCycle Set must collapse them to a single bond.
    const dup = task({ id: 30, status: 'open', onChainTaskId: 42 });
    const state: FakeApi = {
      authenticated: true,
      submissions: [],
      confirms: [],
      openTasks: [dup, dup],
      assignedTasks: [],
    };
    const persisted: IntentRecord[] = [];
    const { calls, txFns } = spyTxFns('CommittedSuccess', 'CommittedSuccess');
    const report = await runWorkerCycle({
      api: fakeApi(state),
      identity,
      onChain: true,
      // Default-deny gate: without this the worker claims nothing and these
      // fixtures test the gate instead of the claim leg they are about.
      trustedPosters: ['account_rdx1other'],
      maxClaimsPerCycle: 2, // budget would allow two — dedup, not budget, must stop it
      txFns,
      resolveClaimReceiptId: () => Promise.resolve(null),
      readTaskState: () => Promise.resolve('Open'),
      persistIntentHash: rec => persisted.push(rec),
      confirmRetryDelayMs: 1,
      log: silentLog,
    });
    expect(calls.claim).toEqual([42]); // signed exactly once, not [42, 42]
    // ...and it carried the brief. claim_task takes a REQUIRED work_brief_hash
    // (P4-3): the component pins the brief at claim time and refuses a later
    // submission that does not match it. Until 2026-09-02 this spy declared
    // ONE of four parameters, so the worker could have stopped forwarding the
    // brief entirely and every test in this file would still have passed.
    //
    // Falsifier, so this cannot pass vacuously: drop the 4th argument at the
    // `txFns.claimTaskOnChain(...)` call in worker.ts and this reads
    // [undefined]. Verified by doing exactly that before committing.
    expect(calls.claimBrief).toStrictEqual([{ title: 't', description: 'd', terms: undefined, dueIso: null }]);
    expect(report.claimedTaskIds).toEqual([30]);
    expect(state.confirms).toEqual([{ taskId: 30, kind: 'claim', intentHash: 'txid_rdx1claim' }]);
    expect(persisted).toEqual([{ taskId: 30, kind: 'claim', intentHash: 'txid_rdx1claim' }]);
  });

  test('claim confirm 422-exhausted: breadcrumb persisted, error recorded, no throw/hang', async () => {
    // Every confirm attempt 422s (>=4). confirmEscrowWithRetry exhausts and throws;
    // the claim try/catch must convert that to a recorded error (not an escape),
    // and the intent breadcrumb must already be durable from BEFORE the confirm.
    const state: FakeApi = {
      authenticated: true,
      submissions: [],
      confirms: [],
      confirmFailTimes: 10, // far more than the 4 attempts → all fail
      openTasks: fundedOpen(),
      assignedTasks: [],
    };
    const persisted: IntentRecord[] = [];
    const { calls, txFns } = spyTxFns('CommittedSuccess', 'CommittedSuccess');
    const report = await runWorkerCycle({
      api: fakeApi(state),
      identity,
      onChain: true,
      // Default-deny gate: without this the worker claims nothing and these
      // fixtures test the gate instead of the claim leg they are about.
      trustedPosters: ['account_rdx1other'],
      txFns,
      resolveClaimReceiptId: () => Promise.resolve(null),
      readTaskState: () => Promise.resolve('Open'),
      persistIntentHash: rec => persisted.push(rec),
      confirmRetryDelayMs: 1,
      log: silentLog,
    });
    expect(calls.claim).toEqual([42]); // the bond WAS posted (committed)
    expect(state.confirms.length).toBe(4); // 4 attempts, all 422, then gives up
    expect(report.claimedTaskIds).toEqual([]); // confirm never landed
    // Breadcrumb persisted BEFORE the confirm so the dropped confirm can be replayed.
    expect(persisted).toEqual([{ taskId: 30, kind: 'claim', intentHash: 'txid_rdx1claim' }]);
    expect(report.intentHashes).toEqual([{ taskId: 30, kind: 'claim', intentHash: 'txid_rdx1claim' }]);
    expect(report.errors.length).toBe(1);
    expect(report.errors[0]).toContain('#30'); // the cycle surfaced it, did not escape
  });

  test('claim confirm non-422 (500) surfaces immediately — NOT retried — breadcrumb persisted', async () => {
    const state: FakeApi = {
      authenticated: true,
      submissions: [],
      confirms: [],
      confirmRejectWith: new GuildApiError('INTERNAL_ERROR', 'boom', 500),
      openTasks: fundedOpen(),
      assignedTasks: [],
    };
    const persisted: IntentRecord[] = [];
    const { calls, txFns } = spyTxFns('CommittedSuccess', 'CommittedSuccess');
    const report = await runWorkerCycle({
      api: fakeApi(state),
      identity,
      onChain: true,
      // Default-deny gate: without this the worker claims nothing and these
      // fixtures test the gate instead of the claim leg they are about.
      trustedPosters: ['account_rdx1other'],
      txFns,
      resolveClaimReceiptId: () => Promise.resolve(null),
      readTaskState: () => Promise.resolve('Open'),
      persistIntentHash: rec => persisted.push(rec),
      confirmRetryDelayMs: 1,
      log: silentLog,
    });
    expect(calls.claim).toEqual([42]);
    expect(state.confirms.length).toBe(1); // 500 is not 422 → tried exactly once, no backoff loop
    expect(report.claimedTaskIds).toEqual([]);
    expect(persisted).toEqual([{ taskId: 30, kind: 'claim', intentHash: 'txid_rdx1claim' }]);
    expect(report.errors.length).toBe(1);
    expect(report.errors[0]).toContain('#30');
  });

  test('resolveClaimReceiptId throwing (Gateway 5xx) in dedup is swallowed — proceeds to the pin', async () => {
    // The dedup receipt read wraps resolveClaimReceiptId in try/catch and treats a
    // throw as "resolver lag non-fatal": fall through to the on-chain pin + claim.
    const state: FakeApi = {
      authenticated: true,
      submissions: [],
      confirms: [],
      openTasks: fundedOpen(),
      assignedTasks: [],
    };
    let pinReads = 0;
    const { calls, txFns } = spyTxFns('CommittedSuccess', 'CommittedSuccess');
    const report = await runWorkerCycle({
      api: fakeApi(state),
      identity,
      onChain: true,
      // Default-deny gate: without this the worker claims nothing and these
      // fixtures test the gate instead of the claim leg they are about.
      trustedPosters: ['account_rdx1other'],
      txFns,
      resolveClaimReceiptId: () => Promise.reject(new Error('Gateway 503 gone')),
      readTaskState: () => {
        pinReads += 1;
        return Promise.resolve('Open');
      },
      confirmRetryDelayMs: 1,
      log: silentLog,
    });
    expect(pinReads).toBe(1); // did NOT abort at the dedup — reached the pin
    expect(calls.claim).toEqual([42]); // and went on to bond
    expect(report.claimedTaskIds).toEqual([30]);
    expect(report.errors).toEqual([]); // the swallowed resolver throw is not an error
  });

  test('self-authored open funded task is never claimed (creatorId === me)', async () => {
    const state: FakeApi = {
      authenticated: true,
      submissions: [],
      confirms: [],
      openTasks: [task({ id: 30, status: 'open', onChainTaskId: 42, creatorId: ME })],
      assignedTasks: [],
    };
    let receiptReads = 0;
    let pinReads = 0;
    const { calls, txFns } = spyTxFns('CommittedSuccess', 'CommittedSuccess');
    const report = await runWorkerCycle({
      api: fakeApi(state),
      identity,
      onChain: true,
      // Default-deny gate: without this the worker claims nothing and these
      // fixtures test the gate instead of the claim leg they are about.
      trustedPosters: ['account_rdx1other'],
      txFns,
      resolveClaimReceiptId: () => {
        receiptReads += 1;
        return Promise.resolve(null);
      },
      readTaskState: () => {
        pinReads += 1;
        return Promise.resolve('Open');
      },
      confirmRetryDelayMs: 1,
      log: silentLog,
    });
    expect(calls.claim).toEqual([]); // skipped before any on-chain read or bond
    expect(receiptReads).toBe(0);
    expect(pinReads).toBe(0);
    expect(report.claimedTaskIds).toEqual([]);
    expect(report.openTaskIds).toEqual([30]); // still surveyed/reported
  });

  test.each([['Released'], ['Refunded'], ['Submitted']] as const)(
    'claim PIN: on-chain state %s (terminal / not Open) is never bonded',
    async pinnedState => {
      const state: FakeApi = {
        authenticated: true,
        submissions: [],
        confirms: [],
        openTasks: fundedOpen(), // DB still says open
        assignedTasks: [],
      };
      const { calls, txFns } = spyTxFns('CommittedSuccess', 'CommittedSuccess');
      const report = await runWorkerCycle({
        api: fakeApi(state),
        identity,
        onChain: true,
        // Default-deny gate: without this the worker claims nothing and these
        // fixtures test the gate instead of the claim leg they are about.
        trustedPosters: ['account_rdx1other'],
        txFns,
        resolveClaimReceiptId: () => Promise.resolve(null),
        readTaskState: () => Promise.resolve(pinnedState),
        confirmRetryDelayMs: 1,
        log: silentLog,
      });
      expect(calls.claim).toEqual([]); // no bond burned on a non-Open task
      expect(report.claimedTaskIds).toEqual([]);
      expect(state.confirms).toEqual([]);
    }
  );
});

// CRITICAL fix (2026-08-31 adversarial review): the open task board is public
// and permissionless, so the sole prior filter ("not my own task") let a
// standing/campaign worker bond a claim on ANY stranger's funded task. Once
// claimed, that task's title/description reaches doWork() unreviewed — the host
// executor ops/agent-env/dowork-claude.sh spliced it into a `claude -p "$PROMPT"
// --dangerously-skip-permissions` run, so an attacker-authored task brief became
// unrestricted host shell the moment it was claimed. That executor is now the
// isolated sandbox (ops/agent-env/sandbox/dowork-sandboxed.sh) — but that sandbox
// is wired, not yet rolled out, so TODAY this allowlist is the live control gating
// claim ELIGIBILITY (the assigned-loop re-run is guarded by a complementary
// re-check); the container is the boundary-in-waiting. Claim eligibility is now
// DEFAULT-DENY: only posters explicitly named in `trustedPosters`
// (WORKER_TRUSTED_POSTERS at the CLI) are ever claim candidates, and every
// skip is logged with the poster address so an operator can see exactly what
// the allowlist filtered before any real XRD is at stake.
describe('runWorkerCycle — claim allowlist (default-deny, CRITICAL fix)', () => {
  const openFrom = (creatorId: string) => [
    task({ id: 30, status: 'open', onChainTaskId: 42, creatorId }),
  ];

  test('trustedPosters omitted (undefined) ⇒ claims NOTHING, even a funded Open task', async () => {
    const state: FakeApi = {
      authenticated: true,
      submissions: [],
      confirms: [],
      openTasks: openFrom('account_rdx1stranger'),
      assignedTasks: [],
    };
    const { calls, txFns } = spyTxFns('CommittedSuccess', 'CommittedSuccess');
    const report = await runWorkerCycle({
      api: fakeApi(state),
      identity,
      onChain: true,
      // trustedPosters intentionally omitted — this is the field's default.
      txFns,
      resolveClaimReceiptId: () => Promise.resolve(null),
      readTaskState: () => Promise.resolve('Open'),
      log: silentLog,
    });
    expect(calls.claim).toEqual([]);
    expect(report.claimedTaskIds).toEqual([]);
    expect(report.openTaskIds).toEqual([30]); // still surveyed/reported, just not claimed
  });

  test('trustedPosters: [] (explicit empty) ⇒ claims NOTHING and logs why, per skipped task', async () => {
    const state: FakeApi = {
      authenticated: true,
      submissions: [],
      confirms: [],
      openTasks: openFrom('account_rdx1stranger'),
      assignedTasks: [],
    };
    const logs: string[] = [];
    const { calls, txFns } = spyTxFns('CommittedSuccess', 'CommittedSuccess');
    const report = await runWorkerCycle({
      api: fakeApi(state),
      identity,
      onChain: true,
      trustedPosters: [],
      txFns,
      resolveClaimReceiptId: () => Promise.resolve(null),
      readTaskState: () => Promise.resolve('Open'),
      log: { info: m => logs.push(m), warn: () => {}, error: () => {} },
    });
    expect(calls.claim).toEqual([]);
    expect(report.claimedTaskIds).toEqual([]);
    const skipLine = logs.find(l => l.includes('#30') && l.includes('SKIPPED'));
    expect(skipLine).toBeDefined();
    expect(skipLine).toContain('account_rdx1stranger'); // names the poster that was denied
    expect(skipLine).toContain('WORKER_TRUSTED_POSTERS');
  });

  test('poster on the allowlist ⇒ claimed normally', async () => {
    const state: FakeApi = {
      authenticated: true,
      submissions: [],
      confirms: [],
      openTasks: openFrom('account_rdx1trusted'),
      assignedTasks: [],
    };
    const { calls, txFns } = spyTxFns('CommittedSuccess', 'CommittedSuccess');
    const report = await runWorkerCycle({
      api: fakeApi(state),
      identity,
      onChain: true,
      trustedPosters: ['account_rdx1someone_else', 'account_rdx1trusted'],
      txFns,
      resolveClaimReceiptId: () => Promise.resolve(null),
      readTaskState: () => Promise.resolve('Open'),
      log: silentLog,
    });
    expect(calls.claim).toEqual([42]);
    expect(report.claimedTaskIds).toEqual([30]);
  });

  test('poster NOT on a non-empty allowlist ⇒ still denied (not "any non-empty list passes all")', async () => {
    const state: FakeApi = {
      authenticated: true,
      submissions: [],
      confirms: [],
      openTasks: openFrom('account_rdx1stranger'),
      assignedTasks: [],
    };
    const { calls, txFns } = spyTxFns('CommittedSuccess', 'CommittedSuccess');
    const report = await runWorkerCycle({
      api: fakeApi(state),
      identity,
      onChain: true,
      trustedPosters: ['account_rdx1someone_else'], // does not include the poster
      txFns,
      resolveClaimReceiptId: () => Promise.resolve(null),
      readTaskState: () => Promise.resolve('Open'),
      log: silentLog,
    });
    expect(calls.claim).toEqual([]);
    expect(report.claimedTaskIds).toEqual([]);
  });

  test('allowlist gate also applies in dry-run (onChain: false) — visible before real XRD is at stake', async () => {
    const state: FakeApi = {
      authenticated: true,
      submissions: [],
      confirms: [],
      openTasks: openFrom('account_rdx1stranger'),
      assignedTasks: [],
    };
    const logs: string[] = [];
    const report = await runWorkerCycle({
      api: fakeApi(state),
      identity,
      // onChain omitted (default false) — this is the pilot's dry-run mode.
      log: { info: m => logs.push(m), warn: () => {}, error: () => {} },
    });
    // A denied poster never even prints "(claim candidate)".
    expect(logs.some(l => l.includes('#30') && l.includes('claim candidate'))).toBe(false);
    expect(logs.some(l => l.includes('#30') && l.includes('SKIPPED'))).toBe(true);
    expect(report.openTaskIds).toEqual([30]);
  });

  test('self-authorship is still checked FIRST — an allowlisted self-authored task is never claimed', async () => {
    // Belt-and-braces: even if an operator's own address ends up in
    // WORKER_TRUSTED_POSTERS, the pre-existing "not my own task" guard must
    // still win, so the worker can never bond a claim against itself.
    const state: FakeApi = {
      authenticated: true,
      submissions: [],
      confirms: [],
      openTasks: openFrom(ME),
      assignedTasks: [],
    };
    const { calls, txFns } = spyTxFns('CommittedSuccess', 'CommittedSuccess');
    const report = await runWorkerCycle({
      api: fakeApi(state),
      identity,
      onChain: true,
      trustedPosters: [ME],
      txFns,
      resolveClaimReceiptId: () => Promise.resolve(null),
      readTaskState: () => Promise.resolve('Open'),
      log: silentLog,
    });
    expect(calls.claim).toEqual([]);
    expect(report.claimedTaskIds).toEqual([]);
  });
});

describe('runWorkerCycle — submit leg hardening', () => {
  const fundedAssigned = () => [task({ id: 50, status: 'assigned', assigneeId: ME, onChainTaskId: 99 })];

  test('submit not CommittedSuccess (Pending): records error, never confirms the submit', async () => {
    const state: FakeApi = {
      authenticated: true,
      submissions: [],
      confirms: [],
      openTasks: [],
      assignedTasks: fundedAssigned(),
    };
    const persisted: IntentRecord[] = [];
    const { calls, txFns } = spyTxFns('CommittedSuccess', 'Pending'); // submit leg lands Pending
    const report = await runWorkerCycle({
      api: fakeApi(state),
      identity,
      dryRun: false,
      onChain: true,
      // fundedAssigned's task #50 is posted by the default fixture creatorId
      // (account_rdx1other) — trust it so this test exercises the Pending-submit
      // hardening it names, not the assigned-loop trust re-check.
      trustedPosters: ['account_rdx1other'],
      txFns,
      resolveClaimReceiptId: () => Promise.resolve(9), // live receipt → submit proceeds
      evidenceHash: content => Promise.resolve(`hash(${content})`),
      persistIntentHash: rec => persisted.push(rec),
      doWork: () => Promise.resolve('the work output'),
      confirmRetryDelayMs: 1,
      log: silentLog,
    });
    // Off-chain submission still posted; the on-chain settle just didn't commit.
    expect(state.submissions).toEqual([{ taskId: 50, content: 'the work output' }]);
    expect(report.submittedTaskIds).toEqual([50]);
    expect(calls.submit).toStrictEqual([
      {
        onChainTaskId: 99,
        claimReceiptId: 9,
        evidenceHashHex: 'hash(the work output)',
        // P4-3: the component recomputes this hash and refuses a submission
        // whose brief does not match the one committed at claim time, so a
        // dropped or mangled brief is a mainnet abort, not a local error.
        workBrief: { title: 't', description: 'd', terms: undefined, dueIso: null },
      },
    ]);
    // Breadcrumb persisted, but NO confirm attempted for a non-committed submit.
    expect(persisted).toEqual([{ taskId: 50, kind: 'submit', intentHash: 'txid_rdx1submit' }]);
    expect(state.confirms).toEqual([]); // never confirmed
    expect(report.errors.length).toBe(1);
    expect(report.errors[0]).toContain('not committed (Pending)');
  });
});
