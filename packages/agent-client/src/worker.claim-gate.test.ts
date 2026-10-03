// The claim gate inside runWorkerCycle (K2-D; claim-gate.ts). Set only by
// `guild-agent run`: the bond must be XRD, at most maxBondXrd, and the balance
// must cover it plus the fee reserve — checked after the task is verified
// Open, before any signature. With a gate a DRY run walks the whole claim path
// except the signature, so "would claim" is honest. Without a gate (the
// fleet) the claim path is exactly what it was — pinned here too.

import { describe, expect, test } from 'bun:test';
import type { GuildApiClient, GuildTask } from './api.js';
import { MAINNET_XRD } from './config.js';
import { runWorkerCycle } from './worker.js';
import { claimTaskOnChain, claimWasNotSubmitted, waitForCommit } from './tx.js';
import { AgentIdentity } from './identity.js';
import { generateThrowawayPrivateKeyHex } from './throwaway-key.js';
import { loadConfig } from './config.js';
import type { ClaimGate } from './claim-gate.js';

const ME = 'account_rdx1me';
const POSTER = 'account_rdx1poster';

function task(id: number, onChainTaskId: number): GuildTask {
  return {
    id, title: `t${id}`, description: 'd', status: 'open', rewardXrd: '100',
    creatorId: POSTER, assigneeId: null, requiredTier: 'member',
    xpReward: 0, onChainTaskId, deadline: null, createdAt: '', updatedAt: '',
  };
}

function board(open: GuildTask[]) {
  const confirms: number[] = [];
  const api = {
    config: { claimReceiptResource: 'resource_rdx1_claim', gatewayBaseUrl: 'http://gateway.test', escrowComponent: 'component_rdx1x' },
    get isAuthenticated() { return true; },
    authenticate: () => Promise.resolve({ id: ME }),
    listTasks: ({ status }: { status: string }) => Promise.resolve({ data: status === 'open' ? open : [] }),
    getTask: (id: number) => Promise.resolve(open.find(t => t.id === id)),
    confirmEscrow: (taskId: number) => {
      confirms.push(taskId);
      return Promise.resolve({ ...open[0], status: 'assigned' });
    },
  };
  return { api: api as unknown as GuildApiClient, confirms };
}

function spies() {
  const claimed: number[] = [];
  const ceilings: unknown[] = [];
  const reads = { state: 0, bond: 0, balance: 0 };
  const txFns = {
    claimTaskOnChain: (id: number, _identity: unknown, _config: unknown, _brief: unknown, ceiling?: unknown) => {
      claimed.push(id);
      ceilings.push(ceiling);
      return Promise.resolve({ intentHash: `txid_${id}`, status: 'CommittedSuccess' });
    },
    submitTaskOnChain: () => Promise.reject(new Error('no submit in these tests')),
  } as unknown as NonNullable<Parameters<typeof runWorkerCycle>[0]['txFns']>;
  return { claimed, ceilings, reads, txFns };
}

function gate(reads: { bond: number; balance: number }, over: Partial<ClaimGate> & { bond?: { resource: string; amount: string }; balance?: string | null } = {}): ClaimGate {
  return {
    maxBondXrd: over.maxBondXrd ?? '100',
    feeReserveXrd: over.feeReserveXrd ?? '20',
    resolveBond: async () => {
      reads.bond++;
      return over.bond ?? { resource: MAINNET_XRD, amount: '76.45' };
    },
    readBalance: async () => {
      reads.balance++;
      return over.balance === undefined ? '200' : over.balance;
    },
  };
}

function cycle(open: GuildTask[], opts: { onChain: boolean; claimGate?: ClaimGate; maxClaimsPerCycle?: number }, s: ReturnType<typeof spies>) {
  const b = board(open);
  return runWorkerCycle({
    api: b.api,
    identity: { address: ME } as AgentIdentity,
    dryRun: !opts.onChain,
    onChain: opts.onChain,
    trustedPosters: [POSTER],
    maxClaimsPerCycle: opts.maxClaimsPerCycle ?? 1,
    txFns: s.txFns,
    readTaskState: () => {
      s.reads.state++;
      return Promise.resolve('Open' as const);
    },
    resolveClaimReceiptId: () => Promise.resolve(null),
    readWorkerEntitlement: () => Promise.resolve(null),
    confirmRetryDelayMs: 1,
    persistIntentHash: () => {},
    ...(opts.claimGate ? { claimGate: opts.claimGate } : {}),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

describe('dry run WITH a gate — everything but the signature', () => {
  test('a task that passes every check is reported as wouldClaim, nothing is signed', async () => {
    const s = spies();
    const r = await cycle([task(1, 11)], { onChain: false, claimGate: gate(s.reads) }, s);
    expect(r.wouldClaimTaskIds).toEqual([1]);
    expect(s.claimed).toEqual([]);
    expect(s.reads).toEqual({ state: 1, bond: 1, balance: 1 });
    expect(r.balanceXrd).toBe('200');
  });

  test('would-claims respect the per-cycle budget like real claims', async () => {
    const s = spies();
    const r = await cycle([task(1, 11), task(2, 12)], { onChain: false, claimGate: gate(s.reads), maxClaimsPerCycle: 1 }, s);
    expect(r.wouldClaimTaskIds).toEqual([1]);
  });

  test('a spent budget (0) would-claims nothing and reads no bond', async () => {
    const s = spies();
    const r = await cycle([task(1, 11)], { onChain: false, claimGate: gate(s.reads), maxClaimsPerCycle: 0 }, s);
    expect(r.wouldClaimTaskIds).toEqual([]);
    expect(s.reads.bond).toBe(0);
  });
});

describe('the rules refuse — dry or live, nothing is signed', () => {
  for (const onChain of [false, true]) {
    const mode = onChain ? 'live' : 'dry';
    test(`${mode}: a bond above maxBondXrd`, async () => {
      const s = spies();
      const r = await cycle([task(1, 11)], { onChain, claimGate: gate(s.reads, { maxBondXrd: '76.44' }) }, s);
      expect(s.claimed).toEqual([]);
      expect(r.ruleSkips?.[0].reason).toContain('above the owner');
      expect(r.wouldClaimTaskIds ?? []).toEqual([]);
    });

    test(`${mode}: a bond EXACTLY at maxBondXrd is allowed`, async () => {
      const s = spies();
      const r = await cycle([task(1, 11)], { onChain, claimGate: gate(s.reads, { maxBondXrd: '76.45' }) }, s);
      expect(r.ruleSkips).toEqual([]);
      expect(onChain ? s.claimed : r.wouldClaimTaskIds).toEqual(onChain ? [11] : [1]);
    });

    test(`${mode}: a bond in another token is refused rather than compared`, async () => {
      const s = spies();
      const r = await cycle([task(1, 11)], { onChain, claimGate: gate(s.reads, { bond: { resource: 'resource_rdx1other', amount: '1' } }) }, s);
      expect(s.claimed).toEqual([]);
      expect(r.ruleSkips?.[0].reason).toContain('not XRD');
      expect(s.reads.balance).toBe(0);
    });

    test(`${mode}: a balance under bond + fee reserve`, async () => {
      const s = spies();
      // 76.45 + 20 = 96.45 — one atto short.
      const r = await cycle([task(1, 11)], { onChain, claimGate: gate(s.reads, { balance: '96.449999999999999999' }) }, s);
      expect(s.claimed).toEqual([]);
      expect(r.ruleSkips?.[0].reason).toContain('fee reserve');
    });

    test(`${mode}: a balance of exactly bond + fee reserve is enough`, async () => {
      const s = spies();
      const r = await cycle([task(1, 11)], { onChain, claimGate: gate(s.reads, { balance: '96.45' }) }, s);
      expect(r.ruleSkips).toEqual([]);
    });

    test(`${mode}: an unreadable balance or bond is a refusal, never a pass`, async () => {
      const s = spies();
      const g = gate(s.reads, { balance: null });
      const r1 = await cycle([task(1, 11)], { onChain, claimGate: g }, s);
      expect(r1.ruleSkips?.[0].reason).toContain('could not be read');
      const s2 = spies();
      const r2 = await cycle([task(1, 11)], {
        onChain,
        claimGate: { ...gate(s2.reads), resolveBond: () => Promise.reject(new Error('gateway 503')) },
      }, s2);
      expect(r2.ruleSkips?.[0].reason).toContain('gateway 503');
      expect(s.claimed).toEqual([]);
      expect(s2.claimed).toEqual([]);
    });
  }
});

describe('live WITH a gate that passes', () => {
  test('claims — and hands the owner\'s cap to the signing call, so the bond actually signed is held to it', async () => {
    const s = spies();
    const r = await cycle([task(1, 11)], { onChain: true, claimGate: gate(s.reads, { maxBondXrd: '90' }) }, s);
    expect(s.claimed).toEqual([11]);
    expect(s.ceilings).toEqual([{ resource: MAINNET_XRD, maxAmount: '90' }]);
    expect(r.claimedTaskIds).toEqual([1]);
    expect(r.wouldClaimTaskIds).toEqual([]);
  });
});

describe('without a gate (the fleet) — unchanged', () => {
  test('a dry run still stops at the candidate: no Gateway reads at all', async () => {
    const s = spies();
    const r = await cycle([task(1, 11)], { onChain: false }, s);
    expect(s.reads).toEqual({ state: 0, bond: 0, balance: 0 });
    expect(r.wouldClaimTaskIds).toBeUndefined();
    expect(r.ruleSkips).toBeUndefined();
  });

  test('a live claim reads no gate and passes no ceiling', async () => {
    const s = spies();
    await cycle([task(1, 11)], { onChain: true }, s);
    expect(s.claimed).toEqual([11]);
    expect(s.ceilings).toEqual([undefined]);
    expect(s.reads.bond).toBe(0);
    expect(s.reads.balance).toBe(0);
  });
});

// K2-D review round 2: every claim whose fate is not "refused before signing"
// spends the per-cycle budget — a Pending/Unknown claim may still bond.
describe('claim outcomes and the per-cycle budget', () => {
  function outcomeCycle(claim: (id: number) => Promise<{ intentHash: string; status: string }>) {
    const b = board([task(1, 11), task(2, 12)]);
    const attempted: number[] = [];
    const outcomes: Array<[number, string]> = [];
    return runWorkerCycle({
      api: b.api,
      identity: { address: ME } as AgentIdentity,
      dryRun: false,
      onChain: true,
      trustedPosters: [POSTER],
      maxClaimsPerCycle: 1,
      txFns: {
        claimTaskOnChain: (id: number) => {
          attempted.push(id);
          return claim(id);
        },
        submitTaskOnChain: () => Promise.reject(new Error('no submit')),
      } as unknown as NonNullable<Parameters<typeof runWorkerCycle>[0]['txFns']>,
      readTaskState: () => Promise.resolve('Open' as const),
      resolveClaimReceiptId: () => Promise.resolve(null),
      readWorkerEntitlement: () => Promise.resolve(null),
      confirmRetryDelayMs: 1,
      persistIntentHash: () => {},
      onClaimOutcome: (taskId, outcome) => void outcomes.push([taskId, outcome]),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    }).then(report => ({ report, attempted, outcomes }));
  }

  test('a submitted claim that is still PENDING spends the budget — no second claim this cycle', async () => {
    const { attempted, outcomes } = await outcomeCycle(async id => ({ intentHash: `txid_${id}`, status: 'Pending' }));
    expect(attempted).toEqual([11]);
    expect(outcomes).toEqual([[1, 'submitted']]);
  });

  test('a claim that throws AFTER it may have been submitted spends the budget too (unknown)', async () => {
    const { attempted, outcomes } = await outcomeCycle(async () => {
      throw new TypeError('socket hang up');
    });
    expect(attempted).toEqual([11]);
    expect(outcomes).toEqual([[1, 'unknown']]);
  });

  test('a claim refused BEFORE signing does not — the next task is tried', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const unbadged = loadConfig({ agentBadgeResource: '', agentBadgeLocalId: '' });
    const { attempted, outcomes } = await outcomeCycle(id =>
      // The real claimTaskOnChain refusing before any network call (badge env unset).
      claimTaskOnChain(id, identity, unbadged, { title: 't', description: 'd' })
    );
    expect(attempted).toEqual([11, 12]);
    expect(outcomes).toEqual([
      [1, 'not-submitted'],
      [2, 'not-submitted'],
    ]);
  });
});

describe('tx: what "not submitted" means, and a commit wait that never throws', () => {
  test('claimWasNotSubmitted: true for a refusal before signing (message and class unchanged), false otherwise', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const error = await claimTaskOnChain(1, identity, loadConfig({ agentBadgeResource: '', agentBadgeLocalId: '' }), {
      title: 't',
      description: 'd',
    }).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Agent badge env not set');
    expect(claimWasNotSubmitted(error)).toBe(true);
    expect(claimWasNotSubmitted(new Error('socket hang up'))).toBe(false);
    expect(claimWasNotSubmitted(null)).toBe(false);
  });

  test('waitForCommit: a network error while polling (the tx is already submitted) ends as Unknown, never a throw', async () => {
    // Port 1 on loopback refuses at once: every poll throws inside fetch.
    expect(await waitForCommit('http://127.0.0.1:1', 'txid_x', { timeoutMs: 150, intervalMs: 20 })).toBe('Unknown');
  });
});
