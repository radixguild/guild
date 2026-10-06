// `--on-chain` without `--live` is a HARD ERROR.
//
// It used to print "--on-chain has no effect without --live" and carry on with
// dryRun:true + onChain:true. That warning was false: the cycle's claim section
// is gated on onChain alone, so it signed a real claim bond, and the submit
// section (gated on dryRun) then never submitted the claimed task — every
// cycle could bond a claim and leave it to expire. These tests pin the CLI
// refusal; worker.on-chain-dry-run.test.ts pins runWorkerCycle's own guard.

import { describe, expect, test } from 'bun:test';
import type { GuildApiClient } from './api.js';
import type { AgentIdentity } from './identity.js';
import { workerCliMain } from './worker-cli.js';

/** An override that fails the test the moment anything reads from it. */
function untouchable<T>(name: string): { value: T; touched: () => boolean } {
  let touched = false;
  const value = new Proxy(
    {},
    {
      get() {
        touched = true;
        throw new Error(`${name} was touched before the --on-chain refusal`);
      },
    }
  ) as T;
  return { value, touched: () => touched };
}

describe('workerCliMain --on-chain — hard error without --live', () => {
  test('--on-chain alone throws, mentioning --live', async () => {
    await expect(workerCliMain(['--on-chain'])).rejects.toThrow(/--on-chain needs --live/);
  });

  test('--on-chain --loop (still no --live) also throws', async () => {
    await expect(workerCliMain(['--on-chain', '--loop'])).rejects.toThrow(/--on-chain needs --live/);
  });

  test('refuses before identity or api are touched', async () => {
    const identity = untouchable<AgentIdentity>('identity');
    const api = untouchable<GuildApiClient>('api');
    for (const argv of [['--on-chain'], ['--on-chain', '--loop']]) {
      await expect(
        workerCliMain(argv, { identity: identity.value, api: api.value })
      ).rejects.toThrow(/--on-chain needs --live/);
    }
    expect(identity.touched()).toBe(false);
    expect(api.touched()).toBe(false);
  });

  test('--live --on-chain passes the gate (fails later, on GUILD_DOWORK_CMD)', async () => {
    const saved = process.env.GUILD_DOWORK_CMD;
    delete process.env.GUILD_DOWORK_CMD;
    const identity = { address: 'account_rdx1me' } as AgentIdentity;
    const api = { config: { apiBaseUrl: 'http://api.test' } } as unknown as GuildApiClient;
    try {
      await expect(workerCliMain(['--live', '--on-chain'], { identity, api })).rejects.toThrow(
        /needs a work function/
      );
    } finally {
      if (saved === undefined) delete process.env.GUILD_DOWORK_CMD;
      else process.env.GUILD_DOWORK_CMD = saved;
    }
  });
});
