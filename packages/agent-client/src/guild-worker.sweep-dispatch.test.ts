// The CLI DISPATCH for custody ruling R1 — which flag reaches which leg, in what order,
// and which exit code comes back.
//
// WHY THIS FILE EXISTS. sweep.test.ts tests the decisions and worker.sweep.test.ts the loop,
// and both call the module directly — so nothing exercised guild-worker.ts's own wiring. That
// is exactly the layer where `run` was found dropping `--sweep-to` on the way to the loop
// (it looked accepted and never swept). An adversarial review named this gap; these tests
// close it. Zero network: both money legs and the identity loader are injected whole.

import { describe, expect, test } from 'bun:test';
import type { AgentIdentity } from './identity.js';
import type { SweepOptions, SweepResult } from './sweep.js';
import type { WithdrawOptions, WithdrawResult } from './withdraw.js';
import { EXIT_COLLECTED_NOT_SWEPT, main, parseArgv } from './guild-worker.js';

const identity = { address: 'account_rdx1me' } as AgentIdentity;
const COLLECTED: WithdrawResult = { refused: false, dryRun: false, intentHash: 'txid_w', status: 'CommittedSuccess', entitlement: { reward: '765', bond: '76.5' } };
const PREVIEWED: WithdrawResult = { refused: false, dryRun: true, manifest: 'M', entitlement: { reward: '765', bond: '76.5' } };
const SWEPT: SweepResult = { refused: false, dryRun: false, owner: 'account_rdx1owner', amount: '841.5', floatXrd: '200', intentHash: 'txid_s', status: 'CommittedSuccess' };

function harness(withdraw: WithdrawResult, sweep: SweepResult) {
  const events: string[] = [];
  const withdrawCalls: WithdrawOptions[] = [];
  const sweepCalls: SweepOptions[] = [];
  return {
    events,
    withdrawCalls,
    sweepCalls,
    deps: {
      loadIdentity: async () => identity,
      withdrawWorkerReward: async (o: WithdrawOptions) => {
        events.push('withdraw');
        withdrawCalls.push(o);
        return withdraw;
      },
      sweepToOwner: async (o: SweepOptions) => {
        events.push('sweep');
        sweepCalls.push(o);
        return sweep;
      },
    },
  };
}

describe('guild-worker withdraw --sweep-to', () => {
  test('collects FIRST, then sweeps — live, with exactly what was typed', async () => {
    const h = harness(COLLECTED, SWEPT);
    const code = await main(['withdraw', '35', '--sweep-to', 'owner', '--live'], h.deps);
    expect(code).toBe(0);
    expect(h.events).toEqual(['withdraw', 'sweep']);
    expect(h.withdrawCalls[0]).toMatchObject({ taskId: 35, live: true });
    expect(h.sweepCalls[0]).toMatchObject({ live: true, requested: 'owner', identity });
  });

  test('without --sweep-to the sweep leg is never touched — the old behaviour, unchanged', async () => {
    const h = harness(COLLECTED, SWEPT);
    expect(await main(['withdraw', '35', '--live'], h.deps)).toBe(0);
    expect(h.events).toEqual(['withdraw']);
  });

  test('a REFUSED withdraw never sweeps, and exits 1', async () => {
    const h = harness({ refused: true, refusal: 'nothing-owed', message: 'nothing owed', dryRun: false }, SWEPT);
    expect(await main(['withdraw', '35', '--sweep-to', 'owner', '--live'], h.deps)).toBe(1);
    expect(h.events).toEqual(['withdraw']);
  });

  test('🔴 collected but NOT swept is exit 3 — never 1 (which means nothing was collected), never 0', async () => {
    const h = harness(COLLECTED, { refused: true, refusal: 'owner-mismatch', message: 'mismatch', dryRun: false, floatXrd: '200' });
    expect(await main(['withdraw', '35', '--sweep-to', 'owner', '--live'], h.deps)).toBe(EXIT_COLLECTED_NOT_SWEPT);
    expect(EXIT_COLLECTED_NOT_SWEPT).toBe(3);
  });

  test('collected, and the balance was already within the float: that is success', async () => {
    const h = harness(COLLECTED, { refused: true, refusal: 'within-float', message: 'within', dryRun: false, floatXrd: '200' });
    expect(await main(['withdraw', '35', '--sweep-to', 'owner', '--live'], h.deps)).toBe(0);
  });

  test('a dry run previews both legs, signs neither, and a refused sweep PREVIEW is a plain 1', async () => {
    const ok = harness(PREVIEWED, { ...SWEPT, dryRun: true, intentHash: undefined, status: undefined, manifest: 'T' });
    expect(await main(['withdraw', '35', '--sweep-to', 'owner'], ok.deps)).toBe(0);
    expect(ok.withdrawCalls[0]).toMatchObject({ live: false });
    expect(ok.sweepCalls[0]).toMatchObject({ live: false });
    const bad = harness(PREVIEWED, { refused: true, refusal: 'owner-not-set', message: 'no owner', dryRun: true, floatXrd: '200' });
    expect(await main(['withdraw', '35', '--sweep-to', 'owner'], bad.deps)).toBe(1);
  });

  test('`withdraw --to …` is a usage error — it must not look like a sweep was asked for and do nothing', async () => {
    const h = harness(COLLECTED, SWEPT);
    expect(await main(['withdraw', '35', '--to', 'owner', '--live'], h.deps)).toBe(2);
    expect(h.events).toEqual([]);
  });
});

describe('guild-worker sweep', () => {
  test('no flag → the recorded owner (requested undefined); dry-run unless --live', async () => {
    const h = harness(COLLECTED, { ...SWEPT, dryRun: true, manifest: 'T' });
    expect(await main(['sweep'], h.deps)).toBe(0);
    expect(h.sweepCalls[0]).toMatchObject({ live: false, requested: undefined });
    expect(h.events).toEqual(['sweep']); // never collects
  });

  test('--to and --sweep-to both reach the leg; --live is passed through', async () => {
    const a = harness(COLLECTED, SWEPT);
    await main(['sweep', '--to', 'account_rdx1x', '--live'], a.deps);
    expect(a.sweepCalls[0]).toMatchObject({ live: true, requested: 'account_rdx1x' });
    const b = harness(COLLECTED, SWEPT);
    await main(['sweep', '--sweep-to=owner'], b.deps);
    expect(b.sweepCalls[0]).toMatchObject({ live: false, requested: 'owner' });
  });

  test('two destination flags that disagree are a usage error, and nothing runs', async () => {
    const h = harness(COLLECTED, SWEPT);
    expect(await main(['sweep', '--to', 'account_rdx1x', '--sweep-to', 'owner'], h.deps)).toBe(2);
    expect(h.events).toEqual([]);
  });

  test('every refusal except "within the float" exits 1', async () => {
    for (const refusal of ['owner-mismatch', 'owner-not-set', 'owner-invalid', 'link-invalid', 'balance-unreadable', 'not-committed', 'no-identity'] as const) {
      const h = harness(COLLECTED, { refused: true, refusal, message: refusal, dryRun: false, floatXrd: '200' });
      expect(await main(['sweep'], h.deps)).toBe(1);
    }
    const benign = harness(COLLECTED, { refused: true, refusal: 'within-float', message: 'within', dryRun: false, floatXrd: '200' });
    expect(await main(['sweep'], benign.deps)).toBe(0);
  });

  test('--live with no key is a usage error before anything is attempted', async () => {
    const h = harness(COLLECTED, SWEPT);
    expect(await main(['sweep', '--live'], { ...h.deps, loadIdentity: async () => null })).toBe(2);
    expect(h.events).toEqual([]);
  });
});

describe('parseArgv — an empty --key= is "needs a value", like the spaced form', () => {
  test.each([['--sweep-to='], ['--owner='], ['--to=']])('%s throws', flag => {
    expect(() => parseArgv(['sweep', flag])).toThrow(/needs a value/);
  });
  test('a non-empty --key=value still parses', () => {
    expect(parseArgv(['sweep', '--to=owner']).options.get('to')).toBe('owner');
  });
});
