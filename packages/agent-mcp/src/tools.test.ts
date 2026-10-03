// agent-mcp tool suite. Three layers:
//   1. unit — each tool driven through invokeTool() with injected fakes (no net).
//   2. secret-leak regression — a sentinel key in env + config, swept across
//      EVERY tool, asserting no output ever carries it (the critique guardrail).
//   3. protocol round-trip — a real MCP Client ↔ createServer() over an in-memory
//      transport, proving registration + the JSON-RPC wiring.
// Live-Gateway checks hit the real mainnet and are skip-by-default behind
// GUILD_MCP_LIVE.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  GuildApiError,
  loadConfig,
  runDoctor as realRunDoctor,
  type DoctorReport,
  type GatewayStatus,
  type GuildTask,
  type ListTasksFilters,
  type ListTasksPage,
  type TaskStats,
} from '@radix-guild/agent-client';
import { buildTools, invokeTool, type ToolDef, type ToolDeps } from './tools';
import { createServer } from './server';

// ── canned data ──────────────────────────────────────────────────────────────

const FAKE_TASK: GuildTask = {
  id: 5,
  title: 'Fix the flux capacitor',
  description: 'It only works at 88mph.',
  status: 'open',
  rewardXrd: '10.00000000',
  creatorId: 'account_rdx1creator',
  assigneeId: null,
  requiredTier: 'member',
  xpReward: 100,
  onChainTaskId: 42,
  deadline: null,
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
};

const FAKE_PAGE: ListTasksPage = { data: [FAKE_TASK], cursor: null, hasMore: false };

const FAKE_STATS: TaskStats = {
  counts: { open: 3, assigned: 1, submitted: 0, paid: 2, cancelled: 0, disputed: 0, refunded: 0 },
  totalPaidXrd: '25',
};

const FAKE_REPORT: DoctorReport = {
  checks: [{ id: 'gateway', label: 'radix gateway', status: 'pass', detail: 'mainnet' }],
  verdict: 'ready',
  lane: 'member-badge',
  address: 'account_rdx1agentself',
};

const FAKE_GW: GatewayStatus = { network: 'mainnet', epoch: 1000, stateVersion: 999_999 };

const MEMBER_BADGE = loadConfig().workerBadgeResource;

// ── fakes ────────────────────────────────────────────────────────────────────

interface FakeState {
  lastFilters: ListTasksFilters | null;
  lastDoctorOpts: { includeAuth?: boolean } | null;
  lastBadgeArgs: { account: string; resource: string } | null;
  lastChainRead: { onChainTaskId: number; escrowComponent: string } | null;
}

function fakeDeps(overrides: Partial<ToolDeps> = {}): { deps: ToolDeps; state: FakeState } {
  const state: FakeState = {
    lastFilters: null,
    lastDoctorOpts: null,
    lastBadgeArgs: null,
    lastChainRead: null,
  };
  const deps: ToolDeps = {
    client: {
      listTasks: async (filters: ListTasksFilters = {}) => {
        state.lastFilters = filters;
        return FAKE_PAGE;
      },
      getTask: async (id: number) => {
        if (id === 999) throw new GuildApiError('TASK_NOT_FOUND', `task ${id} not found`, 404);
        return { ...FAKE_TASK, id };
      },
      getStats: async () => FAKE_STATS,
    },
    config: loadConfig(),
    runDoctor: async (opts) => {
      state.lastDoctorOpts = opts;
      return FAKE_REPORT;
    },
    fetchGatewayStatus: async () => FAKE_GW,
    readTaskState: async (onChainTaskId: number, escrowComponent: string) => {
      state.lastChainRead = { onChainTaskId, escrowComponent };
      // FAKE_TASK's onChainTaskId (42) reads back Open; anything else is unknown.
      return onChainTaskId === 42 ? 'Open' : null;
    },
    resolveBadgeLocalId: async (account: string, resource: string) => {
      state.lastBadgeArgs = { account, resource };
      return account === 'account_rdx1holder' ? '<guild_member_holder>' : null;
    },
    env: {},
    ...overrides,
  };
  return { deps, state };
}

function tool(deps: ToolDeps, name: string): ToolDef {
  const t = buildTools(deps).find((x) => x.name === name);
  if (!t) throw new Error(`no such tool: ${name}`);
  return t;
}

const textOf = (r: { content: { text: string }[] }): string => r.content[0].text;
const jsonOf = (r: { content: { text: string }[] }): unknown => JSON.parse(textOf(r));

// ── 1. registry invariants ───────────────────────────────────────────────────

describe('tool registry', () => {
  test('exposes exactly the 8 read-only tools, none authenticated', () => {
    const names = buildTools(fakeDeps().deps)
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(
      [
        'escrow_config',
        'gateway_status',
        'get_task',
        'list_tasks',
        'readiness',
        'resolve_badge',
        'task_chain_state',
        'task_stats',
      ].sort()
    );
    // The auth-gated hazards the critique told us to drop must be absent.
    expect(names).not.toContain('me');
    expect(names).not.toContain('list_submissions');
    expect(names).not.toContain('create_task');
  });

  test('every tool has a non-empty description', () => {
    for (const t of buildTools(fakeDeps().deps)) {
      expect(t.description.length).toBeGreaterThan(20);
    }
  });
});

// ── 2. per-tool units ────────────────────────────────────────────────────────

describe('list_tasks', () => {
  test('returns a page and forwards filters', async () => {
    const { deps, state } = fakeDeps();
    const res = await invokeTool(tool(deps, 'list_tasks'), {
      status: 'open',
      limit: 10,
      sort: 'reward',
    });
    expect(res.isError).toBeUndefined();
    expect((jsonOf(res) as ListTasksPage).data[0].id).toBe(5);
    expect(state.lastFilters).toMatchObject({ status: 'open', limit: 10, sort: 'reward' });
  });

  test('rejects a limit above 100 (zod)', async () => {
    await expect(invokeTool(tool(fakeDeps().deps, 'list_tasks'), { limit: 500 })).rejects.toThrow();
  });

  test('rejects an unknown status (zod)', async () => {
    await expect(
      invokeTool(tool(fakeDeps().deps, 'list_tasks'), { status: 'archived' })
    ).rejects.toThrow();
  });

  // creator was the one parameterised input validated only as a string, so a
  // garbage address forwarded straight to the API filter.
  test('rejects a malformed creator address (zod)', async () => {
    await expect(
      invokeTool(tool(fakeDeps().deps, 'list_tasks'), { creator: 'not-an-account' })
    ).rejects.toThrow();
  });

  test('rejects a non-account Radix address as creator (zod)', async () => {
    await expect(
      invokeTool(tool(fakeDeps().deps, 'list_tasks'), { creator: 'resource_rdx1abc' })
    ).rejects.toThrow();
  });

  test('still forwards a well-formed creator', async () => {
    const { deps, state } = fakeDeps();
    await invokeTool(tool(deps, 'list_tasks'), { creator: 'account_rdx1creator' });
    expect(state.lastFilters?.creator).toBe('account_rdx1creator');
  });
});

describe('get_task', () => {
  test('returns the task', async () => {
    const res = await invokeTool(tool(fakeDeps().deps, 'get_task'), { id: 5 });
    expect((jsonOf(res) as GuildTask).id).toBe(5);
  });

  test('missing task → clean isError, not a throw', async () => {
    const res = await invokeTool(tool(fakeDeps().deps, 'get_task'), { id: 999 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('TASK_NOT_FOUND');
  });

  test('rejects a non-integer id (zod)', async () => {
    await expect(invokeTool(tool(fakeDeps().deps, 'get_task'), { id: 1.5 })).rejects.toThrow();
    await expect(invokeTool(tool(fakeDeps().deps, 'get_task'), {})).rejects.toThrow();
  });
});

describe('task_stats', () => {
  test('returns the marketplace pulse', async () => {
    const res = await invokeTool(tool(fakeDeps().deps, 'task_stats'));
    expect((jsonOf(res) as TaskStats).counts.open).toBe(3);
    expect((jsonOf(res) as TaskStats).totalPaidXrd).toBe('25');
  });
});

describe('readiness', () => {
  test('returns the doctor report and NEVER runs the auth probe', async () => {
    const { deps, state } = fakeDeps();
    const res = await invokeTool(tool(deps, 'readiness'));
    expect((jsonOf(res) as DoctorReport).verdict).toBe('ready');
    // includeAuth:false is the guarantee that readiness performs no server write.
    expect(state.lastDoctorOpts).toEqual({ includeAuth: false });
  });
});

describe('escrow_config', () => {
  test('returns exactly the whitelisted fields', async () => {
    const res = await invokeTool(tool(fakeDeps().deps, 'escrow_config'));
    expect(Object.keys(jsonOf(res) as object).sort()).toEqual(
      [
        'apiBaseUrl',
        'badgeManagerComponent',
        'claimBondXrd',
        'claimReceiptResource',
        'dAppDefinitionAddress',
        'escrowComponent',
        'gatewayBaseUrl',
        'networkId',
        'workerBadgeResource',
      ].sort()
    );
  });

  test('drops config fields outside the allowlist (agent badge identity)', async () => {
    const config = {
      ...loadConfig(),
      agentBadgeResource: 'resource_rdx1SENTINEL_BADGE',
      agentBadgeLocalId: '<SENTINEL_LOCAL>',
    };
    const res = await invokeTool(tool(fakeDeps({ config }).deps, 'escrow_config'));
    expect(textOf(res)).not.toContain('SENTINEL');
  });
});

describe('gateway_status', () => {
  test('returns live ledger state', async () => {
    const res = await invokeTool(tool(fakeDeps().deps, 'gateway_status'));
    expect((jsonOf(res) as GatewayStatus).network).toBe('mainnet');
  });

  test('unreachable gateway → isError', async () => {
    const { deps } = fakeDeps({ fetchGatewayStatus: async () => null });
    const res = await invokeTool(tool(deps, 'gateway_status'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('unreachable');
  });
});

describe('resolve_badge', () => {
  test('holder → holds:true with the local id', async () => {
    const res = await invokeTool(tool(fakeDeps().deps, 'resolve_badge'), {
      address: 'account_rdx1holder',
    });
    const out = jsonOf(res) as { holds: boolean; localId: string | null; resource: string };
    expect(out.holds).toBe(true);
    expect(out.localId).toBe('<guild_member_holder>');
    expect(out.resource).toBe(MEMBER_BADGE); // defaulted to the Member badge
  });

  test('non-holder → holds:false, localId null', async () => {
    const res = await invokeTool(tool(fakeDeps().deps, 'resolve_badge'), {
      address: 'account_rdx1nobody',
    });
    expect((jsonOf(res) as { holds: boolean }).holds).toBe(false);
  });

  test('honours an explicit resource override', async () => {
    const { deps, state } = fakeDeps();
    await invokeTool(tool(deps, 'resolve_badge'), {
      address: 'account_rdx1holder',
      resource: 'resource_rdx1other',
    });
    expect(state.lastBadgeArgs?.resource).toBe('resource_rdx1other');
  });

  test('rejects a non-account address (zod)', async () => {
    await expect(
      invokeTool(tool(fakeDeps().deps, 'resolve_badge'), { address: 'resource_rdx1nope' })
    ).rejects.toThrow();
  });

  test('rejects a malformed resource override (zod)', async () => {
    await expect(
      invokeTool(tool(fakeDeps().deps, 'resolve_badge'), {
        address: 'account_rdx1holder',
        resource: 'not-a-resource',
      })
    ).rejects.toThrow();
  });
});

describe('task_chain_state', () => {
  interface ChainStateOut {
    taskId: number;
    onChainTaskId: number | null;
    escrowComponent: string;
    dbStatus: string;
    chainState: string | null;
    claimable: boolean;
    note: string;
  }

  test('funded + Open → claimable, pinned to the configured escrow component', async () => {
    const { deps, state } = fakeDeps();
    const res = await invokeTool(tool(deps, 'task_chain_state'), { id: 5 });
    const out = jsonOf(res) as ChainStateOut;
    expect(out.taskId).toBe(5);
    expect(out.onChainTaskId).toBe(42); // FAKE_TASK.onChainTaskId
    expect(out.chainState).toBe('Open');
    expect(out.claimable).toBe(true);
    expect(out.escrowComponent).toBe(loadConfig().escrowComponent);
    // the pin reads against config.escrowComponent, exactly like the worker
    expect(state.lastChainRead).toEqual({
      onChainTaskId: 42,
      escrowComponent: loadConfig().escrowComponent,
    });
  });

  test('funded but not Open → not claimable, warns of a bond burn + divergence', async () => {
    const { deps } = fakeDeps({ readTaskState: async () => 'Claimed' });
    const res = await invokeTool(tool(deps, 'task_chain_state'), { id: 5 });
    const out = jsonOf(res) as ChainStateOut;
    expect(out.chainState).toBe('Claimed');
    expect(out.claimable).toBe(false);
    expect(out.note).toContain('burn');
    // FAKE_TASK.status is 'open' while chain says Claimed → divergence surfaced.
    expect(out.note).toContain('divergence');
  });

  test('unfunded (onChainTaskId null) → not claimable, never touches the chain', async () => {
    const { deps, state } = fakeDeps({
      client: {
        listTasks: async () => FAKE_PAGE,
        getTask: async (id: number) => ({ ...FAKE_TASK, id, onChainTaskId: null }),
        getStats: async () => FAKE_STATS,
      },
    });
    const res = await invokeTool(tool(deps, 'task_chain_state'), { id: 7 });
    const out = jsonOf(res) as ChainStateOut;
    expect(out.onChainTaskId).toBeNull();
    expect(out.chainState).toBeNull();
    expect(out.claimable).toBe(false);
    expect(out.note).toContain('Unfunded');
    expect(state.lastChainRead).toBeNull(); // short-circuited before any Gateway read
  });

  test('unknown chain state (null) → not claimable, unknown ≠ gone', async () => {
    const { deps } = fakeDeps({ readTaskState: async () => null });
    const res = await invokeTool(tool(deps, 'task_chain_state'), { id: 5 });
    const out = jsonOf(res) as ChainStateOut;
    expect(out.chainState).toBeNull();
    expect(out.claimable).toBe(false);
    expect(out.note).toContain('Unknown');
  });

  test('missing task → clean isError (getTask boundary), not a throw', async () => {
    const res = await invokeTool(tool(fakeDeps().deps, 'task_chain_state'), { id: 999 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('TASK_NOT_FOUND');
  });

  test('rejects a non-integer / missing id (zod)', async () => {
    await expect(
      invokeTool(tool(fakeDeps().deps, 'task_chain_state'), { id: 1.5 })
    ).rejects.toThrow();
    await expect(invokeTool(tool(fakeDeps().deps, 'task_chain_state'), {})).rejects.toThrow();
  });
});

// ── 3. secret-leak regression (the guardrail) ────────────────────────────────

// Offline runDoctor deps — real report generation, zero network.
const OFFLINE_DOCTOR_DEPS = {
  fetchGatewayStatus: async () => null,
  fetchXrdBalance: async () => 0,
  resolveBadgeLocalId: async () => null,
  probeEscrowComponent: async () => false,
  fetchFn: async () =>
    new Response('{"ok":true,"dApps":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  authenticate: async () => ({ id: 'account_rdx1agentself' }),
};

describe('secret-leak regression', () => {
  test('no tool surfaces the private key or GUILD_DOWORK_CMD — readiness runs a REAL doctor', async () => {
    const SENTINEL_KEY = '5e'.repeat(32); // valid 64-hex → parses to an address (a fixed sentinel: the kit has no key generator)
    // >48 chars, with the secret inside doctor's rendered 48-char prefix.
    const SENTINEL_DOWORK =
      'worker --secret SENTINEL_DOWORK_abcdefghij plus padding to exceed forty-eight';
    const prevKey = process.env.GUILD_AGENT_PRIVATE_KEY;
    const prevCmd = process.env.GUILD_DOWORK_CMD;
    process.env.GUILD_AGENT_PRIVATE_KEY = SENTINEL_KEY;
    process.env.GUILD_DOWORK_CMD = SENTINEL_DOWORK;
    try {
      // Pass the sentinel-bearing config to the REAL doctor so the badge check
      // renders it — a PUBLIC resource address, legitimately shown; the secrets we
      // guard are the KEY and the DOWORK command, not the badge resource. env is the
      // same process.env the doctor read, so the scrub sees the same values.
      const config = {
        ...loadConfig(),
        agentBadgeResource: 'resource_rdx1sentinelbadge',
        agentBadgeLocalId: '<sentinel_local>',
      };
      const offlineDoctor: ToolDeps['runDoctor'] = ({ includeAuth }) =>
        realRunDoctor({ includeAuth, config, deps: OFFLINE_DOCTOR_DEPS });
      const { deps } = fakeDeps({ runDoctor: offlineDoctor, env: process.env });

      const calls: Record<string, unknown> = {
        list_tasks: {},
        get_task: { id: 5 },
        task_stats: {},
        task_chain_state: { id: 5 },
        readiness: {},
        escrow_config: {},
        gateway_status: {},
        resolve_badge: { address: 'account_rdx1holder' },
      };
      for (const t of buildTools(deps)) {
        const out = textOf(await invokeTool(t, calls[t.name]));
        expect(out).not.toContain(SENTINEL_KEY); // the private key, in NO tool's output
        expect(out).not.toContain('SENTINEL_DOWORK'); // GUILD_DOWORK_CMD value, scrubbed
      }

      // Prove the scrub isn't vacuous: readiness DID render a real report whose
      // dowork check exists — i.e. the value was present pre-scrub and removed.
      const report = jsonOf(await invokeTool(tool(deps, 'readiness'))) as DoctorReport;
      expect(report.checks.some((c) => c.id === 'dowork')).toBe(true);
    } finally {
      if (prevKey === undefined) delete process.env.GUILD_AGENT_PRIVATE_KEY;
      else process.env.GUILD_AGENT_PRIVATE_KEY = prevKey;
      if (prevCmd === undefined) delete process.env.GUILD_DOWORK_CMD;
      else process.env.GUILD_DOWORK_CMD = prevCmd;
    }
  });

  test('readiness scrubs the key even on the parse-FAILURE branch', async () => {
    const SENTINEL_BAD = 'SENTINEL_NOT_HEX_zzzzzzzzzz';
    const prev = process.env.GUILD_AGENT_PRIVATE_KEY;
    process.env.GUILD_AGENT_PRIVATE_KEY = SENTINEL_BAD;
    try {
      const offlineDoctor: ToolDeps['runDoctor'] = ({ includeAuth }) =>
        realRunDoctor({ includeAuth, deps: OFFLINE_DOCTOR_DEPS });
      const { deps } = fakeDeps({ runDoctor: offlineDoctor, env: process.env });
      const out = textOf(await invokeTool(tool(deps, 'readiness')));
      expect(out).not.toContain(SENTINEL_BAD);
      const report = JSON.parse(out) as DoctorReport;
      expect(report.checks.find((c) => c.id === 'key')?.status).toBe('fail');
    } finally {
      if (prev === undefined) delete process.env.GUILD_AGENT_PRIVATE_KEY;
      else process.env.GUILD_AGENT_PRIVATE_KEY = prev;
    }
  });
});

// ── 4. protocol round-trip (real MCP Client ↔ Server) ────────────────────────

describe('MCP protocol round-trip', () => {
  let client: Client;

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(fakeDeps().deps);
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
  });

  test('lists all 8 tools over JSON-RPC', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toContain('task_chain_state');
    expect(tools.length).toBe(8);
  });

  test('a no-arg tool works with NO arguments field (the omitted-schema fix)', async () => {
    const res = await client.callTool({ name: 'task_stats' });
    expect(res.isError).toBeFalsy();
    const content = res.content as { type: string; text: string }[];
    expect((JSON.parse(content[0].text) as TaskStats).counts.paid).toBe(2);
  });

  test('a param tool works with an empty arguments object', async () => {
    const res = await client.callTool({ name: 'list_tasks', arguments: {} });
    expect(res.isError).toBeFalsy();
    const content = res.content as { type: string; text: string }[];
    expect((JSON.parse(content[0].text) as ListTasksPage).data[0].id).toBe(5);
  });

  test('a missing task surfaces isError over the wire', async () => {
    const res = await client.callTool({ name: 'get_task', arguments: { id: 999 } });
    expect(res.isError).toBe(true);
  });
});

// ── 5. live Gateway (skip-by-default; GUILD_MCP_LIVE=1 to run) ────────────────

const LIVE = !!process.env.GUILD_MCP_LIVE;

describe.skipIf(!LIVE)('live mainnet reads', () => {
  test('gateway_status reports mainnet', async () => {
    const { fetchGatewayStatus, resolveBadgeLocalId } = await import('@radix-guild/agent-client');
    const { deps } = fakeDeps({ fetchGatewayStatus, resolveBadgeLocalId });
    const res = await invokeTool(tool(deps, 'gateway_status'));
    expect((jsonOf(res) as GatewayStatus).network).toBe('mainnet');
  });
});
