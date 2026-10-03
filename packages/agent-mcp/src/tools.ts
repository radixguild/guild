// Read-only MCP tool definitions over the Guild marketplace — the adapter core.
//
// SDK-AGNOSTIC BY DESIGN: each tool is a plain record
//   { name, title, description, inputSchema (a zod raw shape), handler }
// whose handler is pure over injectable deps (the doctor.ts / worker.ts seam
// pattern this repo favours). The whole surface is therefore unit-tested by
// calling handlers directly with fakes — no stdio server, no network. server.ts
// does the MCP/stdio wiring and nothing else.
//
// SECRETS (the critique-locked guardrail): every tool here is a PUBLIC read.
//   • Nothing returns process.env.
//   • The one config-echo tool (escrow_config) returns an EXPLICIT field
//     allowlist — it never spreads loadConfig() or env, so a future secret field
//     on GuildClientConfig can't leak by accident.
//   • readiness wraps runDoctor with includeAuth:false (no server write) — the
//     report contains only the agent's PUBLIC account address, never the key.
// A regression test (tools.test.ts) plants a sentinel key in env+config and
// asserts no tool's output ever contains it.

import { z } from 'zod';
import {
  GuildApiError,
  type DoctorReport,
  type GatewayStatus,
  type GuildApiClient,
  type GuildClientConfig,
  type OnChainTaskState,
} from '@radix-guild/agent-client';

// A zod raw shape without depending on zod 4's exact type-export name.
type ZodRawShape = Record<string, z.ZodType>;

/** The MCP text result shape (a structural subset of the SDK's CallToolResult). */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  // The SDK's CallToolResult is a Result with a `[x: string]: unknown` passthrough;
  // mirroring it here lets a ToolResult flow into registerTool with no cast, while
  // tools.ts stays free of any SDK import.
  [key: string]: unknown;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/**
 * The narrow set of agent-client behaviours the tools touch — declared
 * structurally (not `typeof`) so tests inject fakes with zero network and the
 * real functions in server.ts satisfy them by shape. Only PUBLIC reads appear
 * here; there is deliberately no authenticated method (`me`, `listSubmissions`
 * were dropped from the MVP as the only secret-adjacent hazards).
 */
export interface ToolDeps {
  client: Pick<GuildApiClient, 'listTasks' | 'getTask' | 'getStats'>;
  config: GuildClientConfig;
  /** runDoctor bound to includeAuth:false at the call site (server passes the real one). */
  runDoctor: (opts: { includeAuth?: boolean }) => Promise<DoctorReport>;
  fetchGatewayStatus: (gatewayBaseUrl: string) => Promise<GatewayStatus | null>;
  resolveBadgeLocalId: (
    account: string,
    resource: string,
    gatewayBaseUrl: string
  ) => Promise<string | null>;
  /**
   * A task's LIVE on-chain TaskState on the given escrow component, or null when
   * unknown (never "gone"). The `task_chain_state` tool pins it to the CONFIGURED
   * component, exactly as the worker's claim loop does.
   */
  readTaskState: (
    onChainTaskId: number,
    escrowComponent: string,
    gatewayBaseUrl: string
  ) => Promise<OnChainTaskState | null>;
  /** Env readiness scrubs sensitive values out of the doctor report (server passes process.env). */
  env: Record<string, string | undefined>;
}

/**
 * doctor.ts renders GUILD_DOWORK_CMD's value (its first 48 chars) into a check
 * detail — harmless in the operator's own terminal, but the `readiness` tool
 * exposes that report to a REMOTE caller, so scrub any sensitive env VALUE (and
 * doctor's 48-char prefix of it) out before returning. The private key never
 * reaches the report (address-only) but is scrubbed defensively.
 *
 * Two sources are unioned so the guarantee does NOT rest on a hand-maintained list:
 *   1. SENSITIVE_ENV — the vars doctor renders a (possibly truncated) value of today.
 *   2. SENSITIVE_ENV_NAME_RE — ANY env key whose NAME looks secret-bearing. A future
 *      doctor check that echoes e.g. GUILD_AGENT_MNEMONIC (which derives the whole agent
 *      fleet) is then scrubbed automatically, even if nobody updates SENSITIVE_ENV.
 */
const SENSITIVE_ENV = ['GUILD_AGENT_PRIVATE_KEY', 'GUILD_DOWORK_CMD'];
const SENSITIVE_ENV_NAME_RE = /(MNEMONIC|SEED|PRIVATE|SECRET|PASSWORD|PASSPHRASE|TOKEN|APIKEY|API_KEY|_KEY)/i;

// Chars of GUILD_DOWORK_CMD that doctor.ts:360 renders when the value exceeds this
// length. MUST stay ≥ doctor's slice width or the rendered tail leaks; the
// "scrub width tracks doctor's render width" test in tools.test.ts pins the two together.
const DOWORK_RENDER_PREFIX = 48;

function scrubSecrets(report: DoctorReport, env: Record<string, string | undefined>): DoctorReport {
  const names = new Set<string>(SENSITIVE_ENV);
  for (const k of Object.keys(env)) {
    if (SENSITIVE_ENV_NAME_RE.test(k)) names.add(k);
  }
  const secrets = [...names]
    .map((k) => env[k])
    // length ≥ 8 so a trivially short value (that can't hold a secret) never
    // mangles unrelated output by coincidence.
    .filter((v): v is string => typeof v === 'string' && v.length >= 8)
    .flatMap((v) =>
      v.length > DOWORK_RENDER_PREFIX ? [v, v.slice(0, DOWORK_RENDER_PREFIX)] : [v]
    );
  if (secrets.length === 0) return report;
  const scrub = (s: string): string =>
    secrets.reduce((acc, secret) => acc.split(secret).join('[redacted]'), s);
  return {
    ...report,
    checks: report.checks.map((c) => ({
      ...c,
      detail: scrub(c.detail),
      ...(c.hint !== undefined ? { hint: scrub(c.hint) } : {}),
    })),
  };
}

const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

const fail = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

/**
 * Uniform error boundary: turn any throw into a clean `isError` result rather
 * than a protocol error. GuildApiError.message is already `CODE: message`; a
 * bare fetch failure surfaces its (public) message. Neither carries a secret.
 */
async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GuildApiError) return fail(err.message);
    return fail(err instanceof Error ? err.message : String(err));
  }
}

const TASK_STATUS = [
  'open',
  'assigned',
  'submitted',
  'paid',
  'cancelled',
  'disputed',
  'refunded',
] as const;

const ACCOUNT_RE = /^account_rdx1[0-9a-z]+$/;
const RESOURCE_RE = /^resource_rdx1[0-9a-z]+$/;

/**
 * A one-line, honest reading of claimability from the DB view + live chain state —
 * the same pin the worker's claim loop applies (worker.ts): only `Open` on the
 * configured escrow component is safe to bond; `null` is UNKNOWN (never "gone");
 * any other known state fails the blueprint's must-be-Open assert, and a claim
 * that reverts moves no bond — only its network fee is spent (escrow lib.rs
 * `claim_task`). It reports on-chain claimability ONLY — not this agent's
 * eligibility.
 */
function stateNote(
  dbStatus: string,
  onChainTaskId: number | null,
  chainState: OnChainTaskState | null
): string {
  if (onChainTaskId === null) {
    return 'Unfunded: no on-chain task id yet — not claimable.';
  }
  if (chainState === null) {
    return (
      'On-chain state unknown — the Gateway was unreachable, or this task id is not on ' +
      'the configured escrow component. Unknown ≠ gone; retry, do not bond.'
    );
  }
  if (chainState === 'Open') {
    return 'Open on the configured escrow component — a claim is safe to bond now.';
  }
  const base =
    `On-chain state is ${chainState} — not Open; a claim would fail the ` +
    "blueprint's must-be-Open assert: the transaction reverts, moves no bond and " +
    'still costs the network fee.';
  return dbStatus === 'open'
    ? `${base} ⚠ The board still shows this task open (DB↔chain divergence).`
    : base;
}

/** The read-only tool set. `deps` is injected so every tool is testable offline. */
export function buildTools(deps: ToolDeps): ToolDef[] {
  return [
    {
      name: 'list_tasks',
      title: 'List marketplace tasks',
      description:
        'Browse Guild marketplace tasks (public, no auth). Filter by status/creator, ' +
        'page with cursor, sort by newest/reward/deadline. Returns one page: ' +
        '{ data: Task[], cursor, hasMore }.',
      inputSchema: {
        status: z.enum(TASK_STATUS).optional().describe('Filter by task status'),
        // Validated as an ADDRESS, not merely a string: the API filter expects an
        // account, and the README's "every parameterised tool validates its
        // arguments" claim was only true in letter while a garbage creator
        // forwarded straight through. Same guard as resolve_badge.address.
        creator: z
          .string()
          .regex(ACCOUNT_RE, 'must be a mainnet Radix account address (account_rdx1…)')
          .optional()
          .describe('Filter by creator account address'),
        cursor: z.string().optional().describe('Pagination cursor from a previous page'),
        limit: z.number().int().min(1).max(100).optional().describe('Max tasks per page (1–100)'),
        sort: z
          .enum(['newest', 'reward', 'deadline'])
          .optional()
          .describe('Sort order (default newest)'),
      },
      handler: (args) =>
        guarded(async () => {
          const page = await deps.client.listTasks({
            status: args.status as (typeof TASK_STATUS)[number] | undefined,
            creator: args.creator as string | undefined,
            cursor: args.cursor as string | undefined,
            limit: args.limit as number | undefined,
            sort: args.sort as 'newest' | 'reward' | 'deadline' | undefined,
          });
          return ok(page);
        }),
    },

    {
      name: 'get_task',
      title: 'Get one task',
      description:
        'Fetch a single marketplace task by its numeric id (public, no auth). ' +
        'Errors with NOT_FOUND if the id does not exist.',
      inputSchema: {
        id: z.number().int().positive().describe('Numeric task id'),
      },
      handler: (args) =>
        guarded(async () => ok(await deps.client.getTask(args.id as number))),
    },

    {
      name: 'task_stats',
      title: 'Marketplace stats',
      description:
        'The public marketplace pulse (no auth): per-status task counts and total ' +
        'released XRD. Returns { counts: { open, assigned, ... }, totalPaidXrd }.',
      inputSchema: {},
      handler: () => guarded(async () => ok(await deps.client.getStats())),
    },

    {
      name: 'readiness',
      title: 'Agent readiness preflight',
      description:
        'Run the guild-worker readiness preflight for THIS server\'s configured agent ' +
        'key (read-only — no signing, no server write). Answers "can this key earn ' +
        'right now, and if not, what is the first thing to fix?". Returns the doctor ' +
        'report (checks, verdict, lane, public account address). Never returns the key.',
      inputSchema: {},
      handler: () =>
        // includeAuth:false is mandatory here — the auth probe is runDoctor's only
        // server-side write (a ROLA login row), which a read-only tool must not do.
        // scrubSecrets strips any sensitive env value doctor may have echoed (e.g.
        // GUILD_DOWORK_CMD) before the report leaves the process.
        guarded(async () =>
          ok(scrubSecrets(await deps.runDoctor({ includeAuth: false }), deps.env))
        ),
    },

    {
      name: 'escrow_config',
      title: 'Escrow / marketplace config',
      description:
        'The pinned public marketplace parameters an agent needs to reason about costs ' +
        'and addresses: escrow component, claim bond, badge/receipt resources, gateway ' +
        'and API URLs, network id. Local echo — no secrets, no network.',
      inputSchema: {},
      handler: () =>
        guarded(async () => {
          // EXPLICIT allowlist — never spread deps.config / process.env. Adding a
          // field here is a deliberate act; a new secret-ish field cannot leak by
          // default. (agentBadge*/private key are intentionally absent.)
          const c = deps.config;
          return ok({
            apiBaseUrl: c.apiBaseUrl,
            gatewayBaseUrl: c.gatewayBaseUrl,
            networkId: c.networkId,
            escrowComponent: c.escrowComponent,
            claimBondXrd: c.claimBondXrd,
            claimReceiptResource: c.claimReceiptResource,
            workerBadgeResource: c.workerBadgeResource,
            badgeManagerComponent: c.badgeManagerComponent,
            dAppDefinitionAddress: c.dAppDefinitionAddress,
          });
        }),
    },

    {
      name: 'gateway_status',
      title: 'Radix Gateway status',
      description:
        'Read the live Radix Babylon Gateway ledger state (keyless): network, epoch, ' +
        'state version. Errors if the gateway is unreachable.',
      inputSchema: {},
      handler: () =>
        guarded(async () => {
          const status = await deps.fetchGatewayStatus(deps.config.gatewayBaseUrl);
          return status ? ok(status) : fail(`gateway unreachable at ${deps.config.gatewayBaseUrl}`);
        }),
    },

    {
      name: 'resolve_badge',
      title: 'Resolve a badge NFT',
      description:
        'Check whether a Radix account holds a Guild badge NFT (keyless Gateway read). ' +
        'Defaults to the Guild Member badge resource. Returns { address, resource, ' +
        'localId, holds } — localId is null (holds:false) when the account holds none.',
      inputSchema: {
        address: z
          .string()
          .regex(ACCOUNT_RE, 'must be a mainnet Radix account address (account_rdx1…)')
          .describe('Account address to check'),
        resource: z
          .string()
          .regex(RESOURCE_RE, 'must be a resource address (resource_rdx1…)')
          .optional()
          .describe('Badge resource address (default: Guild Member badge)'),
      },
      handler: (args) =>
        guarded(async () => {
          const address = args.address as string;
          const resource = (args.resource as string | undefined) ?? deps.config.workerBadgeResource;
          const localId = await deps.resolveBadgeLocalId(
            address,
            resource,
            deps.config.gatewayBaseUrl
          );
          return ok({ address, resource, localId, holds: localId !== null });
        }),
    },

    {
      name: 'task_chain_state',
      title: 'Task on-chain state',
      description:
        "Read a task's LIVE on-chain escrow TaskState (Open/Claimed/Submitted/Disputed/" +
        'Released/Refunded) on the configured escrow component, next to the marketplace ' +
        '(DB) view — so an agent can tell chain truth from the board BEFORE it bonds a ' +
        'claim. Keyless Gateway read. Returns { taskId, onChainTaskId, escrowComponent, ' +
        'dbStatus, chainState, claimable, note }. chainState is null when unknown (gateway ' +
        "hiccup, or the task isn't on this component — never means 'gone'); onChainTaskId is " +
        "null for an unfunded task. claimable is true ONLY when chainState is Open (a claim " +
        "then won't revert the must-be-Open assert) — it does NOT check this agent's badge " +
        'or balance; use readiness for that.',
      inputSchema: {
        id: z
          .number()
          .int()
          .positive()
          .describe('Numeric task id (the marketplace/board id, as returned by list_tasks)'),
      },
      handler: (args) =>
        guarded(async () => {
          const taskId = args.id as number;
          // Start from the DB view (also the clean NOT_FOUND boundary), then pin
          // the live state against the CONFIGURED escrow component — exactly the
          // worker's claim pin (worker.ts): on-chain ids collide across escrow
          // cutovers, so a task's state is only meaningful on config.escrowComponent.
          // Unfunded (onChainTaskId null) short-circuits — no Gateway read, not claimable.
          const task = await deps.client.getTask(taskId);
          const escrowComponent = deps.config.escrowComponent;
          const onChainTaskId = task.onChainTaskId;
          const chainState =
            onChainTaskId === null
              ? null
              : await deps.readTaskState(
                  onChainTaskId,
                  escrowComponent,
                  deps.config.gatewayBaseUrl
                );
          return ok({
            taskId,
            onChainTaskId,
            escrowComponent,
            dbStatus: task.status,
            chainState,
            claimable: chainState === 'Open',
            note: stateNote(task.status, onChainTaskId, chainState),
          });
        }),
    },
  ];
}

/**
 * Parse `rawArgs` against a tool's own input shape, then run it — the exact
 * contract the MCP SDK enforces at the protocol boundary, reused so tests and
 * server share one validation path. Throws ZodError on a bad shape.
 */
export async function invokeTool(tool: ToolDef, rawArgs?: unknown): Promise<ToolResult> {
  const parsed = z.object(tool.inputSchema).parse(rawArgs ?? {});
  return tool.handler(parsed as Record<string, unknown>);
}
