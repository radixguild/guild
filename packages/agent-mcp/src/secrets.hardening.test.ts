// Adversarial hardening for the readiness secret-scrubbing invariant.
//
// tools.ts:scrubSecrets is the ONE guardrail standing between a REMOTE MCP caller
// and the operator's env: the `readiness` tool wraps runDoctor, and runDoctor's
// `dowork` check renders GUILD_DOWORK_CMD's value (its first 48 chars) into a
// human detail. scrubSecrets must strip every sensitive env VALUE — and doctor's
// 48-char prefix of it — before the report leaves the process.
//
// These tests drive the REAL doctor (realRunDoctor + offline network deps, the
// sibling tools.test.ts OFFLINE_DOCTOR_DEPS pattern) with sentinels planted in
// process.env, so what gets scrubbed is a genuinely-rendered report, never a
// hand-built fixture. They pin four sharp edges the happy-path test cannot:
//   • scrub width couples to doctor's render width (48) — future drift leaks.
//   • the length>=8 filter boundary (48/49 redacted, 7 passed through).
//   • literal (split/join) scrub, not regex — a metachar-laden secret is removed
//     verbatim and does NOT eat the rest of the report.
//   • the GUILD_AGENT_MNEMONIC name-pattern (SENSITIVE_ENV_NAME_RE) auto-scrub.
//   • the production wiring (createServer over a real MCP transport, env:process.env).
//
// scrubSecrets is not exported, so every assertion goes through the public seam
// (readiness → the rendered report), which is also exactly the attacker's view.

import { describe, test, expect } from 'bun:test';
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

// Offline runDoctor deps — real report generation, zero network (from tools.test.ts).
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

// ── shared harness ────────────────────────────────────────────────────────────

// Bind the REAL doctor to offline network deps; env defaults to process.env inside
// runDoctor (so the dowork check reads the sentinel we plant there), and deps.env is
// process.env too — the exact coupling realDeps() wires in server.ts.
function offlineReadinessDeps(configOverride?: Partial<ToolDeps['config']>): ToolDeps {
  const config = configOverride ? { ...loadConfig(), ...configOverride } : loadConfig();
  const offlineDoctor: ToolDeps['runDoctor'] = ({ includeAuth }) =>
    realRunDoctor({ includeAuth, config, deps: OFFLINE_DOCTOR_DEPS });
  return fakeDeps({ runDoctor: offlineDoctor, env: process.env, config }).deps;
}

// Run the readiness tool through the real doctor and return { raw text, parsed report }.
async function runReadiness(): Promise<{ text: string; report: DoctorReport }> {
  const res = await invokeTool(tool(offlineReadinessDeps(), 'readiness'));
  const text = textOf(res);
  return { text, report: JSON.parse(text) as DoctorReport };
}

// Set env vars for the duration of fn, then restore prior values exactly (incl. absence).
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k]!;
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k]!;
    }
  }
}

const doworkDetail = (report: DoctorReport): string | undefined =>
  report.checks.find((c) => c.id === 'dowork')?.detail;

// ── 1. scrub width tracks doctor's render width ───────────────────────────────

describe('scrub width tracks doctor render width', () => {
  // A 61-char command: a unique HEAD token inside the first 48 chars (doctor
  // renders slice(0,48)), a unique TAIL token starting at offset 49 (doctor never
  // renders it). If doctor's slice ever widens past scrub's 48-char prefix, the
  // rendered-but-unscrubbed tail leaks and this test goes red.
  const HEAD = 'HEADTOKENxyz';
  const TAIL = 'TAILTOKENxyz';
  const VALUE = `${HEAD} ${'p'.repeat(35)} ${TAIL}`; // len 61, TAIL at index 49
  const RENDER_SLICE = VALUE.slice(0, 48); // exactly what doctor's dowork detail shows

  test('the entire rendered 48-char slice is redacted, not just a prefix of it', async () => {
    await withEnv({ GUILD_DOWORK_CMD: VALUE }, async () => {
      expect(VALUE.length).toBe(61);
      expect(VALUE.indexOf(TAIL)).toBeGreaterThan(48); // guard the fixture's own premise
      const { text, report } = await runReadiness();
      // Non-vacuous: the value WAS set, so a dowork check exists and was scrubbed.
      expect(doworkDetail(report)).toContain('[redacted]');
      // Coupling assertion: the full rendered slice is gone (scrub prefix >= 48).
      expect(text).not.toContain(RENDER_SLICE);
      expect(text).not.toContain(HEAD); // HEAD is inside the render slice
      // Drift catcher: TAIL lives past char 48; current code never renders it.
      expect(text).not.toContain(TAIL);
    });
  });
});

// ── 2. length boundaries of the >=8 scrub filter ──────────────────────────────

describe('scrub length boundaries', () => {
  // Each row plants GUILD_DOWORK_CMD of a precise length and asserts whether its
  // unique sentinel survives. The >=8 filter is the guard that a too-short value
  // (which cannot carry a real secret) never mangles unrelated output.
  const cases: { name: string; value: string; sentinel: string; redacted: boolean }[] = [
    {
      name: 'exactly 48 chars → rendered in full, redacted',
      value: `DW48_${'x'.repeat(43)}`, // len 48 (<=48 → doctor renders the whole value)
      sentinel: 'DW48_',
      redacted: true,
    },
    {
      name: 'exactly 49 chars → truncated to 48 + …, redacted via the 48-prefix entry',
      value: `DW49_${'y'.repeat(44)}`, // len 49 (>48 → doctor renders slice(0,48))
      sentinel: 'DW49_',
      redacted: true,
    },
    {
      name: '7-char value → intentionally passed through (len < 8 skip)',
      value: 'SntP7Qz', // len 7 — below the filter; a 7-char value can hold no secret
      sentinel: 'SntP7Qz',
      redacted: false,
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      await withEnv({ GUILD_DOWORK_CMD: c.value }, async () => {
        const { text, report } = await runReadiness();
        // The dowork check must exist regardless (proves the value reached the report).
        expect(report.checks.some((ch) => ch.id === 'dowork')).toBe(true);
        if (c.redacted) {
          expect(text).not.toContain(c.sentinel);
          expect(doworkDetail(report)).toContain('[redacted]');
        } else {
          // Documented pass-through: the short value is rendered verbatim, unscrubbed.
          expect(text).toContain(c.sentinel);
          expect(doworkDetail(report)).toContain(c.sentinel);
        }
      });
    });
  }
});

// ── 3. literal (split/join) scrub, not regex ──────────────────────────────────

describe('regex-special secret is scrubbed literally', () => {
  // A metachar-laden value. If scrubSecrets built a RegExp from it, the `.*` would
  // match every check detail and redact the whole report; split/join treats it as a
  // literal, so ONLY the verbatim value is removed and sibling checks survive intact.
  const VALUE = '.*|(secret)+ x'; // len 14: >=8 and <=48 → rendered in full

  test('the literal value is removed and the rest of the report is untouched', async () => {
    await withEnv({ GUILD_DOWORK_CMD: VALUE }, async () => {
      const { text, report } = await runReadiness();
      expect(VALUE.length).toBeGreaterThanOrEqual(8);
      // The verbatim secret is gone.
      expect(text).not.toContain(VALUE);
      expect(doworkDetail(report)).toContain('[redacted]');
      // Proof it was literal, not `.*`-as-regex: an unrelated check detail that a
      // greedy regex WOULD have eaten is still present verbatim.
      const gateway = report.checks.find((c) => c.id === 'gateway');
      expect(gateway?.detail).toContain('no ledger state'); // offline gateway text intact
      expect(text).toContain('no ledger state');
    });
  });
});

// ── 4. GUILD_AGENT_MNEMONIC name-pattern auto-scrub ───────────────────────────

describe('GUILD_AGENT_MNEMONIC name-pattern scrub', () => {
  // SENSITIVE_ENV_NAME_RE adds ANY env key whose NAME looks secret-bearing
  // (…MNEMONIC/SEED/PRIVATE/SECRET/…/_KEY) to the scrub set, so a future doctor
  // check that echoes GUILD_AGENT_MNEMONIC is stripped even without touching the
  // explicit SENSITIVE_ENV list. Today the doctor's only env-VALUE render channel
  // is GUILD_DOWORK_CMD, so to make the mnemonic value actually appear in a real
  // report we embed the mnemonic sentinel inside the dowork command AND set
  // GUILD_AGENT_MNEMONIC to the same sentinel; the scrub then removes it.
  const MNEMONIC = 'correcthorsebatterystaple_MNEMO'; // >=8, distinctive

  test('a mnemonic-valued sentinel rendered in the report is scrubbed', async () => {
    // Embed within the first 48 chars so the rendered dowork slice carries it.
    const dowork = `worker --run ${MNEMONIC} then pad to exceed forty-eight chars total`;
    await withEnv(
      { GUILD_AGENT_MNEMONIC: MNEMONIC, GUILD_DOWORK_CMD: dowork },
      async () => {
        expect(dowork.indexOf(MNEMONIC)).toBeLessThan(48); // fixture premise: it renders
        const { text, report } = await runReadiness();
        expect(report.checks.some((c) => c.id === 'dowork')).toBe(true);
        // The mnemonic value never survives to the remote caller.
        expect(text).not.toContain(MNEMONIC);
        expect(doworkDetail(report)).toContain('[redacted]');
      }
    );
  });

  test('a mnemonic with NO other render channel is silently absent (no accidental echo)', async () => {
    // With GUILD_DOWORK_CMD unset there is no value channel at all, so the mnemonic
    // must simply never appear — the name-pattern is a belt-and-braces guard, and the
    // report must not leak it by some other path.
    await withEnv(
      { GUILD_AGENT_MNEMONIC: MNEMONIC, GUILD_DOWORK_CMD: undefined },
      async () => {
        const { text } = await runReadiness();
        expect(text).not.toContain(MNEMONIC);
      }
    );
  });
});

// ── 5. production wiring (createServer over a real MCP transport) ─────────────

describe('production scrub coupling over the wire', () => {
  // realDeps() in server.ts wires env: process.env and binds runDoctor to the real
  // doctor. That private function is not exported, so we reproduce its coupling
  // exactly (env:process.env + real doctor) and drive it through a real MCP
  // Client↔Server round-trip, the same transport the sibling round-trip test uses.
  // Proves the scrub fires end-to-end, not just in a direct handler call.
  test('readiness called over JSON-RPC does not leak GUILD_DOWORK_CMD', async () => {
    const SENTINEL = 'SENTINEL_WIRE_DOWORK_do_not_leak_me_over_json_rpc_channel';
    await withEnv({ GUILD_DOWORK_CMD: SENTINEL }, async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createServer(offlineReadinessDeps());
      await server.connect(serverTransport);
      const client = new Client({ name: 'secrets-test-client', version: '0.0.0' });
      await client.connect(clientTransport);
      try {
        const res = await client.callTool({ name: 'readiness' });
        expect(res.isError).toBeFalsy();
        const content = res.content as { type: string; text: string }[];
        const out = content[0].text;
        const report = JSON.parse(out) as DoctorReport;
        // Non-vacuous: the value was set, so a dowork check exists and it was scrubbed.
        expect(report.checks.some((c) => c.id === 'dowork')).toBe(true);
        expect(out).not.toContain(SENTINEL);
        expect(doworkDetail(report)).toContain('[redacted]');
      } finally {
        await client.close();
      }
    });
  });
});
