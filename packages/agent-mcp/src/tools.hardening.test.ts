// agent-mcp ADVERSARIAL hardening suite — a sibling of tools.test.ts.
//
// Surface under attack:
//   1. guarded() error boundary — a dep that throws a NON-GuildApiError (a plain
//      Error, a thrown string, a thrown plain object) must become a clean
//      { isError:true } result carrying its message, never a protocol throw.
//   2. task_chain_state claimability semantics — the full non-Open stateNote
//      matrix (Submitted/Disputed/Released/Refunded), the divergence vs
//      non-divergence branch, and the onChainTaskId===0 edge.
//   3. input validation — invokeTool's zod boundary for get_task, the
//      resolve_badge account regex, gateway_status URL echo, and the list_tasks
//      `creator` regex (previously an unvalidated bare string; now closed).
//
// Harness/fake pattern is copied verbatim from tools.test.ts so the two read as
// one suite. Everything is offline — no net, no stdio server.

import { describe, test, expect } from 'bun:test';
import {
  GuildApiError,
  loadConfig,
  type DoctorReport,
  type GatewayStatus,
  type GuildTask,
  type ListTasksFilters,
  type ListTasksPage,
  type TaskStats,
} from '@radix-guild/agent-client';
import { buildTools, invokeTool, type ToolDef, type ToolDeps } from './tools';

// ── canned data (mirrors tools.test.ts) ──────────────────────────────────────

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

// ── fakes (mirrors tools.test.ts) ────────────────────────────────────────────

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

interface ChainStateOut {
  taskId: number;
  onChainTaskId: number | null;
  escrowComponent: string;
  dbStatus: string;
  chainState: string | null;
  claimable: boolean;
  note: string;
}

// ── 1. guarded() — NON-GuildApiError throws become clean isError results ──────

describe('guarded() error boundary: a non-GuildApiError dep throw is caught, not rethrown', () => {
  // Each thrown shape is injected through client.getStats (task_stats' dep) AND
  // client.listTasks (list_tasks' dep) so we prove the boundary, not one call site.
  const cases: { name: string; thrown: unknown; expectText: string }[] = [
    { name: 'a plain Error', thrown: new Error('boom from the network'), expectText: 'boom from the network' },
    { name: 'a thrown string', thrown: 'raw string failure', expectText: 'raw string failure' },
    { name: 'a thrown plain object', thrown: { code: 'WEIRD', detail: 'x' }, expectText: '[object Object]' },
  ];

  for (const c of cases) {
    test(`task_stats: getStats rejects with ${c.name} → { isError:true } carrying the message`, async () => {
      const { deps } = fakeDeps({
        client: {
          listTasks: async () => FAKE_PAGE,
          getTask: async (id: number) => ({ ...FAKE_TASK, id }),
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          getStats: async () => {
            throw c.thrown;
          },
        },
      });
      // Must NOT reject — the boundary converts it to a result.
      const res = await invokeTool(tool(deps, 'task_stats'));
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe(c.expectText);
    });

    test(`list_tasks: listTasks rejects with ${c.name} → { isError:true } carrying the message`, async () => {
      const { deps } = fakeDeps({
        client: {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          listTasks: async () => {
            throw c.thrown;
          },
          getTask: async (id: number) => ({ ...FAKE_TASK, id }),
          getStats: async () => FAKE_STATS,
        },
      });
      const res = await invokeTool(tool(deps, 'list_tasks'), {});
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe(c.expectText);
    });
  }

  test('a GuildApiError still gets its CODE: message form (the other branch, for contrast)', async () => {
    const { deps } = fakeDeps({
      client: {
        listTasks: async () => FAKE_PAGE,
        getTask: async (id: number) => ({ ...FAKE_TASK, id }),
        getStats: async () => {
          throw new GuildApiError('RATE_LIMITED', 'slow down', 429);
        },
      },
    });
    const res = await invokeTool(tool(deps, 'task_stats'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('RATE_LIMITED');
  });
});

// ── 2. task_chain_state claimability semantics ───────────────────────────────

describe('task_chain_state: non-Open chain states are never claimable and warn of a bond burn', () => {
  // The sibling only exercises 'Claimed'. Every OTHER known non-Open state must
  // read identically: not claimable, note mentions the burn.
  const NON_OPEN: string[] = ['Submitted', 'Disputed', 'Released', 'Refunded'];

  for (const chain of NON_OPEN) {
    test(`chain='${chain}' on an 'open' DB task → claimable:false, note mentions 'burn' + divergence`, async () => {
      const { deps } = fakeDeps({ readTaskState: async () => chain as never });
      const res = await invokeTool(tool(deps, 'task_chain_state'), { id: 5 });
      const out = jsonOf(res) as ChainStateOut;
      expect(out.chainState).toBe(chain);
      expect(out.claimable).toBe(false);
      expect(out.note).toContain('burn');
      // FAKE_TASK.status is 'open' → the DB↔chain divergence clause fires.
      expect(out.note).toContain('divergence');
    });
  }

  test("non-divergence branch: DB status 'assigned' + chain 'Claimed' → note omits 'divergence'", async () => {
    const { deps } = fakeDeps({
      client: {
        listTasks: async () => FAKE_PAGE,
        getTask: async (id: number) => ({ ...FAKE_TASK, id, status: 'assigned' }),
        getStats: async () => FAKE_STATS,
      },
      readTaskState: async () => 'Claimed',
    });
    const res = await invokeTool(tool(deps, 'task_chain_state'), { id: 5 });
    const out = jsonOf(res) as ChainStateOut;
    expect(out.dbStatus).toBe('assigned');
    expect(out.chainState).toBe('Claimed');
    expect(out.claimable).toBe(false);
    expect(out.note).toContain('burn'); // still a non-Open burn warning
    expect(out.note).not.toContain('divergence'); // but NOT flagged as board divergence
  });

  test('onChainTaskId === 0 is handled safely (funded-id zero is not treated as null)', async () => {
    // 0 !== null, so the handler DOES read the chain for id 0; the fake returns
    // null for anything but 42 → unknown, not claimable. The point: no crash and
    // the null/0 distinction is preserved (0 is a real, if unfunded-looking, id).
    const { deps, state } = fakeDeps({
      client: {
        listTasks: async () => FAKE_PAGE,
        getTask: async (id: number) => ({ ...FAKE_TASK, id, onChainTaskId: 0 }),
        getStats: async () => FAKE_STATS,
      },
    });
    const res = await invokeTool(tool(deps, 'task_chain_state'), { id: 7 });
    const out = jsonOf(res) as ChainStateOut;
    expect(res.isError).toBeUndefined();
    expect(out.onChainTaskId).toBe(0);
    expect(out.claimable).toBe(false);
    // 0 is NOT short-circuited as unfunded — the chain WAS read with id 0.
    expect(state.lastChainRead).toEqual({ onChainTaskId: 0, escrowComponent: loadConfig().escrowComponent });
    expect(out.note).not.toContain('Unfunded');
  });
});

// ── 3. gateway_status URL echo ───────────────────────────────────────────────

describe('gateway_status: an unreachable non-default gateway names that exact URL', () => {
  test('config.gatewayBaseUrl is surfaced in the isError message', async () => {
    const CUSTOM = 'https://gw.example.invalid:9999/state';
    const { deps } = fakeDeps({
      config: { ...loadConfig(), gatewayBaseUrl: CUSTOM },
      fetchGatewayStatus: async () => null,
    });
    const res = await invokeTool(tool(deps, 'gateway_status'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(CUSTOM);
  });
});

// ── 4. invokeTool zod boundary (get_task) ────────────────────────────────────

describe('invokeTool zod boundary: get_task id validation', () => {
  const rejecting: { name: string; args: unknown }[] = [
    { name: 'id=0 (not positive)', args: { id: 0 } },
    { name: 'id=-1 (not positive)', args: { id: -1 } },
    { name: 'id=1.5 (not integer)', args: { id: 1.5 } },
    { name: 'id=NaN (not a number)', args: { id: NaN } },
    { name: "id='5' (string, not number)", args: { id: '5' } },
    { name: 'rawArgs=null (id required after ?? {})', args: null },
  ];

  for (const c of rejecting) {
    test(`rejects ${c.name}`, async () => {
      await expect(invokeTool(tool(fakeDeps().deps, 'get_task'), c.args)).rejects.toThrow();
    });
  }

  test('unknown extra key {id:5, bogus:1}: zod STRIPS it (lenient object) — call succeeds, bogus dropped', async () => {
    // Empirically locking current behavior: z.object(shape) is non-strict, so an
    // unknown key is silently stripped rather than rejected. If tools.ts ever adds
    // .strict(), this test flips and flags the contract change.
    const res = await invokeTool(tool(fakeDeps().deps, 'get_task'), { id: 5, bogus: 1 });
    expect(res.isError).toBeUndefined();
    expect((jsonOf(res) as GuildTask).id).toBe(5);
  });
});

// ── 5. resolve_badge account-address regex ───────────────────────────────────

describe('resolve_badge: the account regex rejects near-miss addresses', () => {
  const rejecting: { name: string; address: string }[] = [
    { name: 'uppercase scheme (ACCOUNT_RDX1…)', address: 'ACCOUNT_RDX1holder' },
    { name: 'empty data part (account_rdx1)', address: 'account_rdx1' },
    { name: 'trailing newline (account_rdx1abc\\n)', address: 'account_rdx1abc\n' },
  ];

  for (const c of rejecting) {
    test(`rejects ${c.name}`, async () => {
      await expect(
        invokeTool(tool(fakeDeps().deps, 'resolve_badge'), { address: c.address })
      ).rejects.toThrow();
    });
  }

  test('a valid lowercase account with data still passes (guards against an over-tight regex)', async () => {
    const res = await invokeTool(tool(fakeDeps().deps, 'resolve_badge'), {
      address: 'account_rdx1holder',
    });
    expect((jsonOf(res) as { holds: boolean }).holds).toBe(true);
  });
});

// ── 6. list_tasks creator — the validation gap, now CLOSED ───────────────────

describe('list_tasks: creator is validated as an address, not a bare string', () => {
  test('a garbage creator is rejected at the zod boundary and never reaches the client', async () => {
    // Was a documented gap: `creator` was z.string().optional() with no regex,
    // unlike resolve_badge's `address`, so a non-address string passed straight
    // through to the API filter. Now guarded by the same ACCOUNT_RE.
    const GARBAGE = "not-an-account'; DROP TABLE tasks; --";
    const { deps, state } = fakeDeps();
    await expect(invokeTool(tool(deps, 'list_tasks'), { creator: GARBAGE })).rejects.toThrow(
      /account address/
    );
    // The point of the fix: nothing reached the client at all (lastFilters
    // starts null and only the client call sets it).
    expect(state.lastFilters).toBeNull();
  });

  test('a well-formed creator still reaches the client unchanged', async () => {
    const { deps, state } = fakeDeps();
    const res = await invokeTool(tool(deps, 'list_tasks'), { creator: 'account_rdx1creator' });
    expect(res.isError).toBeUndefined();
    expect(state.lastFilters?.creator).toBe('account_rdx1creator');
  });
});
