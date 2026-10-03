// P1-22: `--auto-withdraw` CLI-flag gating.
//
// `--auto-withdraw` signs a REAL transaction (the existing `withdraw` leg) for
// every entitlement the post-submit survey reports, every cycle — so, like
// every other signing path in this CLI, it must refuse to run at all without
// `--live`. Unlike `--on-chain` (which only WARNS when used without --live,
// because it is simply inert then), this is a HARD ERROR: a silent no-op
// would look identical to "running and doing nothing wrong" while quietly
// collecting nothing.
//
// worker.ts's own guard (autoWithdraw + dryRun) is covered in
// worker.auto-withdraw.test.ts; these tests pin the CLI-level gate — the one
// an operator actually hits when they typo a flag.

import { describe, expect, test } from 'bun:test';
import type { GuildApiClient, GuildTask } from './api.js';
import type { AgentIdentity } from './identity.js';
import { workerCliMain } from './worker-cli.js';

const ME = 'account_rdx1me';

function fakeApi(): GuildApiClient {
  const api = {
    config: {
      claimReceiptResource: 'resource_rdx1_claim',
      gatewayBaseUrl: 'http://gateway.test',
      apiBaseUrl: 'http://api.test',
    },
    isAuthenticated: false,
    authenticate: () => Promise.resolve({ id: ME }),
    listTasks: () => Promise.resolve({ data: [] as GuildTask[], cursor: null, hasMore: false }),
  };
  return api as unknown as GuildApiClient;
}

const identity = { address: ME } as AgentIdentity;

describe('workerCliMain --auto-withdraw — hard error without --live', () => {
  test('--auto-withdraw alone throws, mentioning --live', async () => {
    await expect(workerCliMain(['--auto-withdraw'])).rejects.toThrow(/--auto-withdraw needs --live/);
  });

  test('--auto-withdraw --loop (still no --live) also throws', async () => {
    await expect(workerCliMain(['--auto-withdraw', '--loop'])).rejects.toThrow(/--auto-withdraw needs --live/);
  });

  test('--auto-withdraw --on-chain (still no --live) also throws', async () => {
    await expect(workerCliMain(['--auto-withdraw', '--on-chain'])).rejects.toThrow(
      /--auto-withdraw needs --live/
    );
  });

  /**
   * MUTATION: check the flag AFTER identity/api are built. This confirms the
   * refusal fires with NO overrides at all — no identity, no api, no
   * GUILD_AGENT_PRIVATE_KEY in env — proving it is a pure argv check that
   * cannot be masked by (or blamed on) missing credentials.
   */
  test('refuses before touching identity or api — no overrides needed to observe it', async () => {
    let threw: unknown;
    try {
      await workerCliMain(['--auto-withdraw']);
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toMatch(/--auto-withdraw needs --live/);
  });
});

describe('workerCliMain --auto-withdraw — accepted alongside --live', () => {
  /**
   * With --live present, the auto-withdraw gate must NOT fire — the run
   * should fail for the NEXT reason instead (no GUILD_DOWORK_CMD, --live's
   * own long-standing requirement), proving the auto-withdraw check itself
   * passes cleanly rather than papering over failure with a vague message.
   */
  test('--live --auto-withdraw passes the auto-withdraw gate (fails later, on GUILD_DOWORK_CMD)', async () => {
    const saved = process.env.GUILD_DOWORK_CMD;
    delete process.env.GUILD_DOWORK_CMD;
    try {
      await expect(
        workerCliMain(['--live', '--auto-withdraw'], { identity, api: fakeApi() })
      ).rejects.toThrow(/needs a work function/);
    } finally {
      if (saved === undefined) delete process.env.GUILD_DOWORK_CMD;
      else process.env.GUILD_DOWORK_CMD = saved;
    }
  });

  /** A full single cycle with --live --auto-withdraw and nothing to collect resolves cleanly. */
  test('--live --auto-withdraw runs one cycle without throwing when there is nothing to collect', async () => {
    const saved = process.env.GUILD_DOWORK_CMD;
    process.env.GUILD_DOWORK_CMD = 'true'; // a no-op shell command; never invoked (no assigned tasks)
    try {
      await expect(
        workerCliMain(['--live', '--auto-withdraw'], { identity, api: fakeApi() })
      ).resolves.toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.GUILD_DOWORK_CMD;
      else process.env.GUILD_DOWORK_CMD = saved;
    }
  });

  test('--live --on-chain --auto-withdraw --loop is accepted by the gate (stopped via signal, not an error)', async () => {
    const saved = process.env.GUILD_DOWORK_CMD;
    process.env.GUILD_DOWORK_CMD = 'true';
    const controller = new AbortController();
    try {
      const runPromise = workerCliMain(['--live', '--on-chain', '--auto-withdraw', '--loop'], {
        identity,
        api: fakeApi(),
        intervalMs: 5,
        signal: controller.signal,
      });
      // Give it a tick to prove it didn't reject synchronously on the gate.
      await new Promise(resolve => setTimeout(resolve, 20));
      controller.abort();
      await expect(runPromise).resolves.toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.GUILD_DOWORK_CMD;
      else process.env.GUILD_DOWORK_CMD = saved;
    }
  });
});

// ── custody ruling R1: --sweep-to is the second half of collecting ───────────
describe('workerCliMain --sweep-to — flag gating', () => {
  test('--sweep-to without a value throws, naming the two legal values', async () => {
    await expect(workerCliMain(['--live', '--auto-withdraw', '--sweep-to'])).rejects.toThrow(/--sweep-to needs a value/);
    await expect(workerCliMain(['--live', '--auto-withdraw', '--sweep-to', '--loop'])).rejects.toThrow(/--sweep-to needs a value/);
  });

  test('--sweep-to without --auto-withdraw throws rather than looking accepted', async () => {
    await expect(workerCliMain(['--live', '--sweep-to', 'owner'])).rejects.toThrow(/--sweep-to needs --auto-withdraw/);
    await expect(workerCliMain(['--live', '--sweep-to=owner'])).rejects.toThrow(/--sweep-to needs --auto-withdraw/);
  });

  test('--sweep-to with --auto-withdraw but no --live still hits the --live gate first', async () => {
    await expect(workerCliMain(['--auto-withdraw', '--sweep-to', 'owner'])).rejects.toThrow(/--auto-withdraw needs --live/);
  });
});
