// Pins the "claim, and STOP" cycle shape that the time-gated setup drivers need.
//
// A worker cycle has two sections that read DIFFERENT flags:
//   section 1 — find open tasks, claim on-chain   → gated on `onChain` alone
//   section 2 — work tasks already assigned to me → short-circuits on
//               `!doWork || dryRun` (worker.ts:269)
// and section 1's `processedThisCycle` dedup Set does not reach section 2. So a
// task claimed in section 1 becomes `assigned` and is picked up by section 2 IN
// THE SAME CYCLE.
//
// That is fine for the happy path and fatal for every setup that needs a task
// left sitting Claimed:
//   · battle-test-timegated.mjs  — expire_claim asserts state==Claimed. A submit
//     here means the 24-hour wait ends in a revert.
//   · battle-test-campaign.mjs   — cancel_task_by_poster_after_claim asserts
//     state==Claimed, so the leg under test could never pass --live.
// Both passed `dryRun:false` with a `doWork`, and so submitted the task they
// needed left alone. Neither failure was visible until after the wait.
//
// The mock matrix cannot catch this: its cancelTaskAfterClaim does not enforce
// state==Claimed, so the journey goes green either way. Hence a unit test here.

import { describe, test, expect } from 'bun:test';
import type { EscrowConfirmKind, GuildApiClient, GuildTask } from './api.js';
import type { AgentIdentity } from './identity.js';
import { runWorkerCycle } from './worker.js';

const ME = 'account_rdx1me';
const CLAIM_RESOURCE = 'resource_rdx1_claim';

function task(partial: Partial<GuildTask>): GuildTask {
  return {
    id: 1, title: 't', description: 'd', status: 'open', rewardXrd: '1',
    creatorId: 'account_rdx1other', assigneeId: null, requiredTier: 'member',
    xpReward: 0, onChainTaskId: null, deadline: null, createdAt: '', updatedAt: '',
    ...partial,
  };
}

/**
 * A fake board that MUTATES like the real one: a confirmed claim flips the task
 * to `assigned` and puts it in the assigned list, which is what lets section 2
 * see it in the same cycle. A static fake would hide the whole defect.
 */
function movingBoard() {
  const open: GuildTask[] = [task({ id: 30, status: 'open', onChainTaskId: 42 })];
  const assigned: GuildTask[] = [];
  const confirms: { taskId: number; kind: EscrowConfirmKind }[] = [];
  const submissions: { taskId: number; content: string }[] = [];

  const api = {
    config: { claimReceiptResource: CLAIM_RESOURCE, gatewayBaseUrl: 'http://gateway.test' },
    get isAuthenticated() { return true; },
    authenticate: () => Promise.resolve({ id: ME }),
    listTasks: ({ status }: { status: string }) =>
      Promise.resolve({ data: status === 'open' ? open : assigned }),
    getTask: (id: number) =>
      Promise.resolve([...open, ...assigned].find(t => t.id === id) ?? task({ id })),
    createSubmission: (taskId: number, content: string) => {
      submissions.push({ taskId, content });
      return Promise.resolve({ id: 1, taskId, submitterId: ME, content, status: 'pending', createdAt: '' });
    },
    confirmEscrow: (taskId: number, kind: EscrowConfirmKind) => {
      confirms.push({ taskId, kind });
      if (kind === 'claim') {
        const i = open.findIndex(t => t.id === taskId);
        if (i !== -1) {
          const [t] = open.splice(i, 1);
          assigned.push({ ...t, status: 'assigned', assigneeId: ME });
        }
      }
      return Promise.resolve(task({ id: taskId, status: kind === 'claim' ? 'assigned' : 'submitted' }));
    },
  };
  return { api: api as unknown as GuildApiClient, confirms, submissions, assigned };
}

function spyTxFns() {
  const calls = {
    claim: [] as number[],
    submit: [] as number[],
    // Both legs take a REQUIRED workBrief. These spies declared 1 parameter
    // each and discarded it — see the cast note below.
    claimBrief: [] as unknown[],
    submitBrief: [] as unknown[],
  };
  const txFns = {
    claimTaskOnChain: (id: number, _identity: unknown, _config: unknown, workBrief: unknown) => {
      calls.claim.push(id);
      calls.claimBrief.push(workBrief);
      return Promise.resolve({ intentHash: 'txid_rdx1claim', status: 'CommittedSuccess' });
    },
    submitTaskOnChain: (
      id: number,
      _claimReceiptId: number,
      _evidenceHashHex: string,
      _identity: unknown,
      _config: unknown,
      workBrief: unknown
    ) => {
      calls.submit.push(id);
      calls.submitBrief.push(workBrief);
      return Promise.resolve({ intentHash: 'txid_rdx1submit', status: 'CommittedSuccess' });
    },
    // ⚠️ THE CAST IS WHY ARITY BREAKS LIVE HERE. Casting through `unknown` lets
    // a spy declare fewer parameters than the real function takes; the extras
    // are discarded in silence. `submitTaskOnChain` sat 6-args-into-7 for three
    // days behind 416 green tests that way (3e58183), and this file was not in
    // that fix — both spies declared exactly one parameter. `tsc` guards the
    // real call sites in worker.ts, so ARITY is compile-checked; what nothing
    // checked is the VALUE forwarded. Assert captured arguments, not shape.
  } as unknown as NonNullable<Parameters<typeof runWorkerCycle>[0]['txFns']>;
  return { calls, txFns };
}

/**
 * Mirrors the real Claim Receipt: absent before the claim mints it, present
 * after. Both sections consult this, and they read opposite meanings into it —
 * section 1 skips the claim when a receipt already exists (dedup), section 2
 * skips the submit when one does NOT. A constant would silently disable one of
 * the two sections and make the test prove nothing.
 */
function receiptResolver(calls: { claim: number[] }) {
  return () => Promise.resolve(calls.claim.length > 0 ? 1 : null);
}

const base = {
  identity: { address: ME } as AgentIdentity,
  onChain: true,
  // movingBoard()'s open task uses the task() helper's default creatorId
  // ('account_rdx1other'); the default-deny claim allowlist must explicitly
  // trust it or these on-chain-claim-focused tests would never bond anything.
  trustedPosters: ['account_rdx1other'],
  readTaskState: () => Promise.resolve('Open' as const),
  confirmRetryDelayMs: 1,
  log: { info: () => {}, warn: () => {}, error: () => {} },
};

describe('runWorkerCycle — claim without submit (the setup-driver shape)', () => {
  test('dryRun:true still CLAIMS on-chain — the flag gates section 2, not section 1', async () => {
    const board = movingBoard();
    const { calls, txFns } = spyTxFns();

    await runWorkerCycle({ ...base, api: board.api, txFns, resolveClaimReceiptId: receiptResolver(calls), dryRun: true });

    expect(calls.claim).toEqual([42]);
    // The brief rides the claim even on a dryRun cycle — dryRun gates section 2
    // (submit), never section 1. claim_task commits work_brief_hash on chain
    // (P4-3), so a claim that forgot the brief would be a mainnet abort.
    // Falsifier: drop the 4th argument at worker.ts's claimTaskOnChain call and
    // this reads [undefined]. Verified by doing exactly that before committing.
    expect(calls.claimBrief).toStrictEqual([{ title: 't', description: 'd', terms: undefined, dueIso: null }]);
    expect(board.confirms.map(c => c.kind)).toEqual(['claim']);
  });

  test('dryRun:true does NOT submit, even though the task is now assigned to us', async () => {
    const board = movingBoard();
    const { calls, txFns } = spyTxFns();

    await runWorkerCycle({ ...base, api: board.api, txFns, resolveClaimReceiptId: receiptResolver(calls), dryRun: true });

    // The claim moved it into the assigned list inside this same cycle...
    expect(board.assigned.map(t => t.id)).toEqual([30]);
    // ...and section 2 still left it alone. This is the property the timegated
    // and cancel-after-claim setups depend on.
    expect(calls.submit).toEqual([]);
    expect(board.submissions).toEqual([]);
    expect(board.confirms.some(c => c.kind === 'submit')).toBe(false);
  });

  test('THE TRAP: dryRun:false + doWork claims AND submits in ONE cycle', async () => {
    // Documents the defect the two setup drivers hit. Not a bug in runWorkerCycle
    // — this is correct for the happy path — but it is the reason a setup that
    // wants a Claimed task must not pass these two options together.
    const board = movingBoard();
    const { calls, txFns } = spyTxFns();

    await runWorkerCycle({
      ...base, api: board.api, txFns,
      resolveClaimReceiptId: receiptResolver(calls),
      dryRun: false,
      doWork: async () => 'work',
    });

    expect(calls.claim).toEqual([42]);
    expect(calls.submit).toEqual([42]); // same cycle, same task
    // Both legs forwarded the brief. The submit leg's must match what the claim
    // leg committed or the component refuses the submission.
    //
    // ⚠️ BOTH legs are pinned against the LITERAL, and the cross-check below is
    // kept as well rather than instead. The cross-check alone is spy-against-spy:
    // it passes when both legs receive the SAME WRONG brief, which is a real
    // failure mode (worker.ts builds both objects from the same `task`, so one
    // bad field corrupts both identically). It reads as the redundant line, so
    // it is the one a future tidy-up deletes — leaving the weaker assertion
    // standing alone. Deleting either of the two literal pins is the change that
    // actually costs coverage.
    expect(calls.claimBrief).toStrictEqual([{ title: 't', description: 'd', terms: undefined, dueIso: null }]);
    expect(calls.submitBrief).toStrictEqual([{ title: 't', description: 'd', terms: undefined, dueIso: null }]);
    // The RELATIONAL property, which the literals cannot express: whatever was
    // committed at claim is what is presented at submit. This is what the
    // component enforces, so it is worth stating even though it is implied here.
    expect(calls.submitBrief).toStrictEqual(calls.claimBrief);
    expect(board.confirms.map(c => c.kind)).toEqual(['claim', 'submit']);
    // A task left in this state makes expire_claim and
    // cancel_task_by_poster_after_claim revert: both assert state==Claimed.
  });
});
