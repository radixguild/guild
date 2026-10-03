// Thin typed client over the Guild /api/v1 (same API humans use — decision #2
// of the marketplace overhaul; agent-auth-design.md build item 1).
//
// Auth: programmatic ROLA — GET challenge → sign locally → POST verify →
// hold the guild_session JWT cookie for the session lifetime (7 days server
// side; re-authenticate() freely, it is idempotent and cheap).
//
// Endpoint contracts mirror guild-saas/guild-app/src/app/api/v1/** routes and
// src/app/api/v1/README.md. Every response uses the JSON envelope
// { ok, data?, error? }.

import { loadConfig, type GuildClientConfig } from './config.js';
import type { AgentIdentity } from './identity.js';
import { createSignedChallenge } from './rola.js';
import type { TaskTerms } from './work-brief.js';

// ── Response/domain types (mirroring guild-app shapes) ─────────────────────

export type TaskStatus =
  | 'open'
  | 'assigned'
  | 'submitted'
  | 'paid'
  | 'cancelled'
  | 'disputed'
  | 'refunded';

/** A task row as serialized by the API (db/schema/tasks.ts). */
export interface GuildTask {
  id: number;
  title: string;
  description: string;
  status: TaskStatus;
  /** Decimal string, e.g. "1.00000000". */
  rewardXrd: string;
  creatorId: string;
  assigneeId: string | null;
  requiredTier: string | null;
  xpReward: number;
  /** On-chain escrow u64 task id — null until funded (TaskCreatedEvent). */
  onChainTaskId: number | null;
  /**
   * The escrow component this task was FUNDED on.
   *
   * ⚠️ `onChainTaskId` ALONE IS NOT A KEY. Every component instantiation numbers
   * its tasks from 1, so ids collide across an escrow cutover — a collision this
   * repo has already been bitten by in production, which is why the server grew
   * a `(onChainTaskId, escrowComponent)` unique index. Any chain read keyed on
   * `onChainTaskId` must be pinned to THIS component, not to whichever one the
   * client happens to be configured with today.
   *
   * Optional because older server builds (and the backfill window) leave it
   * null. A null means "cannot pin" — treat it as unverified, never as "matches".
   */
  escrowComponent?: string | null;
  deadline: string | null;
  /**
   * Structured committed terms (tasks.terms, jsonb — DB schema.ts:87), or null
   * when the poster set none. Folded into the v2 work-brief hash whenever this
   * OR `deadline` is set (work-brief.ts workBriefHash) — the P4-3 keystone
   * check needs this field to verify a v2 (terms-bearing) task's claim; a v1
   * caller reading only title/description would false-refuse every such task.
   */
  terms?: TaskTerms | null;
  createdAt: string;
  updatedAt: string;
}

export interface GuildUser {
  /** The Radix account address (ROLA identity). */
  id: string;
  username?: string | null;
  createdAt?: string;
}

export interface GuildSubmission {
  id: number;
  taskId: number;
  submitterId: string;
  content: string;
  status: string;
  createdAt: string;
}

// ── Bring Your Agent — pairing (docs/design/bring-your-agent.md §3.2) ───────
//
// Wire shape is camelCase like every other /api/v1 payload. The server half is
// the A1 PR; these are the contract the kit's `join` verb was written against (it now
// refuses: pairing is off for the beta, and the whole surface is deleted after it).
// Error codes `join` distinguished (anything else is reported verbatim):
//   PAIRING_CODE_INVALID   no such code, or already redeemed, or too many misses
//   PAIRING_CODE_EXPIRED   the 15-minute window passed — get a new one
//   AGENT_ALREADY_PAIRED   this account already has an agents row

export type AgentPairStatus = 'pending' | 'active' | 'suspended' | 'retired';

/** POST /api/v1/agents/pair response — the agent has been bound to the owner who issued the code. */
export interface AgentPairResult {
  label: string;
  ownerAccount: string;
  status: AgentPairStatus;
}

/** The owner-set rules the loop re-reads every tick (K2). */
export interface AgentRules {
  v: 1;
  trustedPosters: string[];
  /** Decimal XRD string. */
  maxBondXrd: string;
  maxClaimsPerDay: number;
  dryRun: boolean;
}

/** GET /api/v1/agents/me response. */
export interface AgentMe {
  label: string;
  status: AgentPairStatus;
  ownerAccount: string;
  /** Decimal XRD string — what the owner funded / tops up to. */
  floatXrd: string;
  /** `<guild_member_...>` once the funding tx was confirmed; null while pending. */
  badgeId: string | null;
  rules: AgentRules;
}

export const PAIRING_ERROR_CODES = {
  invalid: 'PAIRING_CODE_INVALID',
  expired: 'PAIRING_CODE_EXPIRED',
  alreadyPaired: 'AGENT_ALREADY_PAIRED',
  /** GET /api/v1/agents/me for an account with no agents row (404). */
  notPaired: 'AGENT_NOT_PAIRED',
  /** Client-side: the server's response did not have the documented shape. */
  badResponse: 'BAD_AGENT_RESPONSE',
  /** POST /agents/pair from the account that ISSUED the code (409). The code stays open. */
  isOwner: 'AGENT_IS_OWNER',
  /** POST /agents/pair from a persona (identity_…) session rather than an account (403). */
  accountRequired: 'ACCOUNT_REQUIRED',
} as const;

const AGENT_PAIR_STATUSES: readonly AgentPairStatus[] = ['pending', 'active', 'suspended', 'retired'];
/** Same shape validateAddress() enforces on every manifest builder (manifests.ts). */
const ACCOUNT_ADDRESS_RE = /^account_rdx1[a-z0-9]{20,}$/;
/**
 * What a Member badge name can be — the same rule as MINT_USERNAME_RE
 * (mint.ts) and the web /mint page: a string NonFungibleLocalId admits only
 * `[A-Za-z0-9_]`, 64 bytes including the 13-byte `guild_member_` prefix, so a
 * name is 1–51 of those (mainnet preview 2026-09-24: '-' → ContainsBadCharacter,
 * 52 chars → TooLong). A label is also printed on the terminal beside the
 * address-verification line, so it must not be able to carry a newline or an
 * escape sequence.
 */
export const AGENT_LABEL_RE = /^[A-Za-z0-9_]{1,51}$/;
const DECIMAL_RE = /^\d+(\.\d+)?$/;
const BADGE_ID_RE = /^<[A-Za-z0-9_]+>$/;

export function isAccountAddress(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_ADDRESS_RE.test(value);
}

/** The heartbeat `cycle` size cap — guild-app validation.ts heartbeatSchema (JSON.stringify length). */
export const HEARTBEAT_MAX_CHARS = 8192;

function badResponse(what: string): GuildApiError {
  return new GuildApiError(PAIRING_ERROR_CODES.badResponse, `pairing response is not usable: ${what}`, 200);
}

/**
 * Runtime shape check for POST /agents/pair. The owner account this returns
 * becomes the agent's ONLY sweep destination once pinned (agent-state.ts), so
 * it is validated here like every other money-path address — a server bug or
 * a wrong GUILD_API_URL must fail loudly, never pin garbage.
 */
export function parseAgentPairResult(data: unknown): AgentPairResult {
  const d = data as Partial<AgentPairResult> | null;
  if (!d || typeof d !== 'object') throw badResponse('not an object');
  if (typeof d.label !== 'string' || !AGENT_LABEL_RE.test(d.label)) throw badResponse('label is not a badge username');
  if (!isAccountAddress(d.ownerAccount)) throw badResponse('ownerAccount is not an account address');
  if (!AGENT_PAIR_STATUSES.includes(d.status as AgentPairStatus)) throw badResponse('status unknown');
  return { label: d.label, ownerAccount: d.ownerAccount, status: d.status as AgentPairStatus };
}

/** Runtime shape check for GET /agents/me — same reasoning as parseAgentPairResult. */
export function parseAgentMe(data: unknown): AgentMe {
  const d = data as Partial<AgentMe> | null;
  if (!d || typeof d !== 'object') throw badResponse('not an object');
  if (typeof d.label !== 'string' || !AGENT_LABEL_RE.test(d.label)) throw badResponse('label is not a badge username');
  if (!AGENT_PAIR_STATUSES.includes(d.status as AgentPairStatus)) throw badResponse('status unknown');
  if (!isAccountAddress(d.ownerAccount)) throw badResponse('ownerAccount is not an account address');
  if (typeof d.floatXrd !== 'string' || !DECIMAL_RE.test(d.floatXrd)) throw badResponse('floatXrd is not a decimal string');
  if (d.badgeId !== null && (typeof d.badgeId !== 'string' || !BADGE_ID_RE.test(d.badgeId))) {
    throw badResponse('badgeId is not a <string> local id or null');
  }
  const r = d.rules as Partial<AgentRules> | undefined;
  if (
    !r ||
    r.v !== 1 ||
    !Array.isArray(r.trustedPosters) ||
    !r.trustedPosters.every(isAccountAddress) ||
    typeof r.maxBondXrd !== 'string' ||
    !DECIMAL_RE.test(r.maxBondXrd) ||
    !Number.isInteger(r.maxClaimsPerDay) ||
    (r.maxClaimsPerDay as number) < 0 ||
    typeof r.dryRun !== 'boolean'
  ) {
    throw badResponse('rules malformed');
  }
  return {
    label: d.label,
    status: d.status as AgentPairStatus,
    ownerAccount: d.ownerAccount,
    floatXrd: d.floatXrd,
    badgeId: d.badgeId ?? null,
    rules: {
      v: 1,
      trustedPosters: [...r.trustedPosters],
      maxBondXrd: r.maxBondXrd,
      maxClaimsPerDay: r.maxClaimsPerDay as number,
      dryRun: r.dryRun,
    },
  };
}

export interface ListTasksFilters {
  status?: TaskStatus;
  /** Filter by creator address. */
  creator?: string;
  /**
   * Filter by ASSIGNEE address — server-side. Without it a caller asking for
   * 'submitted' gets the first page of the whole marketplace and has to filter
   * its own work out client-side, which means its task can sit on page 2 and
   * never be seen at all.
   */
  assignee?: string;
  cursor?: string;
  limit?: number;
  sort?: 'newest' | 'reward' | 'deadline';
}

export interface ListTasksPage {
  data: GuildTask[];
  cursor: string | null;
  hasMore: boolean;
}

/**
 * Public marketplace pulse (GET /api/v1/tasks/stats — no auth): per-status task
 * counts + total released XRD. The same aggregate the homepage widget and the
 * TG bot's /bounty stats read.
 */
export interface TaskStats {
  /** Per-status counts, zero-filled across the full status enum. */
  counts: Record<TaskStatus, number>;
  /** Total released XRD (sum of `paid` rewards) as a decimal string. */
  totalPaidXrd: string;
}

export interface CreateTaskInput {
  title: string;
  description: string;
  /** XRD amount as a decimal string, e.g. "1" — createTaskSchema regex. */
  reward_amount: string;
  requirements?: string;
  /** ISO datetime string. */
  deadline?: string;
  /**
   * Structured committed terms (docs/TASK-TERMS-DESIGN.md; validated
   * server-side by `createTaskSchema`'s `TaskTermsSchema`). Folds into the v2
   * work-brief hash at funding time whenever set — see work-brief.ts
   * `workBriefHash` and `TaskTerms`'s own doc comment. A headless poster that
   * sets terms here and then funds with `createTaskOnChain` MUST pass the
   * SAME terms object to `workBrief.terms` there, or the committed hash will
   * not match what this route persisted.
   */
  terms?: TaskTerms;
  /**
   * Optional Guild project to file this task under — app-layer metadata
   * only, deliberately never part of the on-chain work-brief hash (see the
   * server's createTaskSchema comment in guild-app/src/lib/validation.ts: a
   * task can move projects without breaking its on-chain commitment). Must
   * be an EXISTING project id or the server responds 404 PROJECT_NOT_FOUND
   * (guild-app/src/app/api/v1/tasks/route.ts) — this client takes only the
   * numeric id; resolve a slug first with `getProject()` or `listProjects()`.
   */
  project_id?: number;
}

/** A Guild project row (db/schema/projects.ts), as returned by createProject
 * and (as the base of) getProject. */
export interface GuildProject {
  id: number;
  name: string;
  slug: string;
  description: string;
  commissionerId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A project row as listed by GET /api/v1/projects — the funnel + money
 * rollup per project (listProjectsWithProgress in
 * guild-app/src/db/queries/projects.ts), NOT the same field set as
 * `GuildProject`: this shape omits `updatedAt` and adds the four rollup
 * columns below.
 */
export interface GuildProjectSummary {
  id: number;
  name: string;
  slug: string;
  description: string;
  commissionerId: string;
  createdAt: string;
  /** Total tasks in the project (any status). */
  taskCount: number;
  /** Tasks whose status is 'paid'. */
  paidCount: number;
  /** Sum of rewardXrd for 'paid' tasks — decimal string. */
  paidXrd: string;
  /** Sum of rewardXrd for funded, non-terminal tasks — decimal string. */
  lockedXrd: string;
}

/** GET /api/v1/projects/[slug] — the project row plus every (visible) task in it. */
export interface GuildProjectDetail extends GuildProject {
  tasks: GuildTask[];
}

export interface CreateProjectInput {
  /** 3–80 chars — createProjectSchema. */
  name: string;
  /** ≤2000 chars — createProjectSchema. */
  description?: string;
}

/**
 * The editable fields of a project — updateProjectSchema. Both optional, at
 * least one required (the server answers `{}` with 400 VALIDATION_ERROR). The
 * slug is deliberately absent: it is the project's URL identity and stays
 * fixed across a rename.
 */
export interface UpdateProjectInput {
  /** 3–80 chars — updateProjectSchema. */
  name?: string;
  /** ≤2000 chars — updateProjectSchema. */
  description?: string;
}

/** Lifecycle kinds accepted by POST /api/v1/tasks/[id]/escrow. */
export type EscrowConfirmKind =
  | 'create'
  | 'claim'
  | 'submit'
  | 'approve'
  | 'dispute'
  | 'resolve'
  | 'cancel';

interface ApiErrorBody {
  code: string;
  message: string;
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: ApiErrorBody;
  cursor?: string | null;
  hasMore?: boolean;
}

export class GuildApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(`${code}: ${message}`);
    this.name = 'GuildApiError';
  }
}

/**
 * One-shot programmatic ROLA login — the shared "verify this agent" seam the
 * doctor and onboard CLIs default to (each session is throwaway there; workers
 * that need the session keep their own GuildApiClient instance instead).
 */
export async function authenticateAgent(
  identity: AgentIdentity,
  config: GuildClientConfig
): Promise<{ id: string }> {
  const api = new GuildApiClient(config);
  const user = await api.authenticate(identity);
  return { id: user.id };
}

const SESSION_COOKIE = 'guild_session';

function extractSessionCookie(response: Response): string | null {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : ([headers.get('set-cookie')].filter(Boolean) as string[]);
  for (const line of setCookies) {
    const match = /(?:^|,\s*)guild_session=([^;,\s]+)/.exec(line);
    if (match) return `${SESSION_COOKIE}=${match[1]}`;
  }
  return null;
}

// ── Client ──────────────────────────────────────────────────────────────────

export interface GuildApiClientOptions {
  /** Per-request timeout (ms). Default 15s. */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
  /**
   * How many times to wait out a 429 before surfacing it. Default 4 — enough to
   * ride out the server's 60s windows, few enough that a genuinely wedged
   * limiter still terminates. 0 disables the backoff entirely.
   */
  maxRateLimitRetries?: number;
  /** Injectable sleep for tests (default: real timer). */
  sleepFn?: (ms: number) => Promise<void>;
}

/** Longest single backoff wait. The tightest server window is 60s. */
const MAX_RATE_LIMIT_WAIT_MS = 90_000;

/**
 * How long to wait after a 429, preferring the server's own `Retry-After` (this
 * API always sends it, in seconds) over guessing. Falls back to exponential
 * backoff — 2s, 4s, 8s… — when the header is missing or unparseable, and clamps
 * so a hostile or bogus value can't park the worker for an hour.
 */
export function rateLimitWaitMs(response: Response, attempt: number): number {
  // Trim-and-reject-empty deliberately: Number('') is 0, not NaN, so a blank or
  // whitespace-only header would otherwise read as "retry immediately" and spin
  // the worker against a limiter that just told us to wait.
  const raw = response.headers.get('retry-after');
  const header = raw === null ? '' : raw.trim();
  const seconds = header === '' ? NaN : Number(header);
  const fromHeader = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : NaN;
  const wait = Number.isNaN(fromHeader) ? 2000 * 2 ** (attempt - 1) : fromHeader;
  return Math.min(Math.max(wait, 1000), MAX_RATE_LIMIT_WAIT_MS);
}

export class GuildApiClient {
  readonly config: GuildClientConfig;
  private cookie: string | null = null;
  /**
   * The identity that last authenticated successfully — retained so the client
   * can transparently re-authenticate when a live session expires (401
   * self-heal). It is the SAME object the caller already owns (no new secret
   * surface) and is never logged. null until the first successful authenticate().
   */
  private identity: AgentIdentity | null = null;
  /** Single-flight guard: concurrent 401s collapse to ONE re-login round-trip. */
  private reauthPromise: Promise<void> | null = null;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly maxRateLimitRetries: number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(config?: Partial<GuildClientConfig>, options: GuildApiClientOptions = {}) {
    this.config = loadConfig(config);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? 4;
    this.sleepFn = options.sleepFn ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  /** True once authenticate() captured a session cookie. */
  get isAuthenticated(): boolean {
    return this.cookie !== null;
  }

  /**
   * Programmatic ROLA login: challenge → sign with the agent key → verify.
   * Captures the guild_session cookie and returns the server-side user row
   * (created on first login; userId = the agent's account address).
   */
  async authenticate(identity: AgentIdentity): Promise<GuildUser> {
    // Both of authenticate()'s calls (challenge GET + verify POST) go through the
    // NON-healing raw path: authenticate() IS the re-auth, so routing it through
    // the 401 self-heal wrapper could let it re-enter itself. Keeping it raw makes
    // that structurally impossible.
    const challengeEnvelope = await this.parseEnvelopeData<{
      challenge: string;
      expires_at: number;
    }>(await this.rawRequest('GET', '/api/v1/auth/challenge'));
    const signedChallenge = createSignedChallenge(identity, {
      challenge: challengeEnvelope.challenge,
      dAppDefinitionAddress: this.config.dAppDefinitionAddress,
      origin: this.config.rolaOrigin,
    });

    const response = await this.rawRequest('POST', '/api/v1/auth/verify', {
      signed_challenge: signedChallenge,
    });
    // A proxy 5xx during a deploy answers /verify with an HTML body, not JSON; .json()
    // then throws a SyntaxError that would escape as an opaque error instead of a clean
    // GuildApiError. Fall back to null (as parseEnvelopeData already does) and map it.
    const body = (await response.json().catch(() => null)) as Envelope<{ user: GuildUser }> | null;
    if (!response.ok || !body || !body.ok || !body.data) {
      throw new GuildApiError(
        body?.error?.code ?? 'AUTH_FAILED',
        body?.error?.message ?? `verify failed with HTTP ${response.status}`,
        response.status
      );
    }
    const cookie = extractSessionCookie(response);
    if (!cookie) {
      throw new GuildApiError('NO_SESSION_COOKIE', 'verify succeeded but no session cookie', 200);
    }
    this.cookie = cookie;
    this.identity = identity; // set ONLY after a fully successful verify → enables 401 self-heal
    return body.data.user;
  }

  /** GET /api/v1/auth/me — the session's user. */
  async me(): Promise<GuildUser> {
    const data = await this.request<{ user?: GuildUser } | GuildUser>('GET', '/api/v1/auth/me');
    return 'user' in data && data.user ? data.user : (data as GuildUser);
  }

  /**
   * POST /api/v1/agents/pair — redeem an owner-issued pairing code (auth: the
   * agent's own session). Binds this account to the owner who issued the code.
   */
  async pairAgent(code: string): Promise<AgentPairResult> {
    return parseAgentPairResult(await this.request<unknown>('POST', '/api/v1/agents/pair', { code }));
  }

  /**
   * GET /api/v1/agents/me — this agent's pairing status, owner, float and rules.
   * Throws GuildApiError `AGENT_NOT_PAIRED` (404) when this account has no row.
   */
  async agentMe(): Promise<AgentMe> {
    return parseAgentMe(await this.request<unknown>('GET', '/api/v1/agents/me'));
  }

  /**
   * POST /api/v1/agents/me/heartbeat — "alive, and this is what my last cycle
   * did" (the owner's card: last seen, cycle summary; three missed beats read
   * as offline). `cycle` is free-form but must serialise to at most
   * HEARTBEAT_MAX_CHARS (guild-app validation.ts heartbeatSchema) — a bigger
   * one is refused here rather than sent to a certain 400. Throws GuildApiError
   * `AGENT_NOT_PAIRED` (404) once this account has no agent row, and 403
   * `ACCOUNT_SUSPENDED` for a suspended or retired agent (withAuth).
   */
  async heartbeat(cycle: Record<string, unknown>): Promise<{ recordedAt: string }> {
    const size = JSON.stringify(cycle).length;
    if (size > HEARTBEAT_MAX_CHARS) {
      throw new Error(`heartbeat cycle serialises to ${size} chars; the Guild accepts at most ${HEARTBEAT_MAX_CHARS}`);
    }
    const data = await this.request<unknown>('POST', '/api/v1/agents/me/heartbeat', { cycle });
    const recordedAt = (data as { recordedAt?: unknown } | null)?.recordedAt;
    if (typeof recordedAt !== 'string') throw badResponse('heartbeat has no recordedAt');
    return { recordedAt };
  }

  /** GET /api/v1/tasks with optional filters; returns one cursor page. */
  async listTasks(filters: ListTasksFilters = {}): Promise<ListTasksPage> {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.creator) params.set('creator', filters.creator);
    if (filters.assignee) params.set('assignee', filters.assignee);
    if (filters.cursor) params.set('cursor', filters.cursor);
    if (filters.limit !== undefined) params.set('limit', String(filters.limit));
    if (filters.sort) params.set('sort', filters.sort);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    // rawRequestAuthed (not rawRequest): listTasks bypasses request() with its own
    // inline parse, and it is the worker loop's PRIMARY 401 surface (the first call
    // each cycle) — so it must self-heal too, or a standing worker still dies on
    // session expiry despite request() healing everything else.
    const response = await this.rawRequestAuthed('GET', `/api/v1/tasks${query}`);
    // listTasks parses inline (not via parseEnvelopeData) and is the worker loop's FIRST
    // call each cycle — the primary place a mid-deploy 502/504 HTML body lands. Mirror
    // parseEnvelopeData's .catch so a non-JSON body becomes a clean GuildApiError, not a
    // raw SyntaxError that aborts the whole cycle.
    const body = (await response.json().catch(() => null)) as Envelope<GuildTask[]> | null;
    if (!response.ok || !body || !body.ok || body.data === undefined) {
      throw new GuildApiError(
        body?.error?.code ?? 'REQUEST_FAILED',
        body?.error?.message ?? `HTTP ${response.status}`,
        response.status
      );
    }
    return { data: body.data, cursor: body.cursor ?? null, hasMore: body.hasMore ?? false };
  }

  /** GET /api/v1/tasks/[id]. */
  async getTask(taskId: number): Promise<GuildTask> {
    return this.request<GuildTask>('GET', `/api/v1/tasks/${taskId}`);
  }

  /**
   * GET /api/v1/tasks/stats — the public marketplace pulse (per-status counts +
   * total paid XRD). No auth; safe from an unauthenticated client (goes through
   * request() but a public endpoint never 401s, so the self-heal never fires).
   */
  async getStats(): Promise<TaskStats> {
    return this.request<TaskStats>('GET', '/api/v1/tasks/stats');
  }

  /** POST /api/v1/tasks (auth; rate limit 5/min per address). */
  async createTask(input: CreateTaskInput): Promise<GuildTask> {
    return this.request<GuildTask>('POST', '/api/v1/tasks', input);
  }

  /**
   * GET /api/v1/projects — every project with its funnel/money rollup. No
   * auth (goes through request() like getStats(); a public endpoint never
   * 401s, so the self-heal never fires — see getStats()'s own doc comment).
   */
  async listProjects(): Promise<GuildProjectSummary[]> {
    return this.request<GuildProjectSummary[]>('GET', '/api/v1/projects');
  }

  /**
   * GET /api/v1/projects/[slug] — the project row plus every task in it. No
   * auth; a caller with a live session sees that session's own hidden/stale
   * rows too (server-side viewer check), same as GET /api/v1/tasks.
   */
  async getProject(slug: string): Promise<GuildProjectDetail> {
    return this.request<GuildProjectDetail>('GET', `/api/v1/projects/${encodeURIComponent(slug)}`);
  }

  /** POST /api/v1/projects (auth; rate limit 5/min per address). */
  async createProject(input: CreateProjectInput): Promise<GuildProject> {
    return this.request<GuildProject>('POST', '/api/v1/projects', input);
  }

  /**
   * PATCH /api/v1/projects/[slug] (auth; rate limit 5/min per address) — change
   * a project's name and/or description, returning the updated row. Only the
   * project's COMMISSIONER, the account that created it, may do this. Failures
   * surface as GuildApiError, the same envelope createProject uses:
   * 401 AUTH_REQUIRED (no session), 404 NOT_FOUND (unknown slug), 403 FORBIDDEN
   * (this session is not the commissioner), 400 VALIDATION_ERROR (no field, or
   * one out of bounds). A 429 RATE_LIMITED is waited out by the client's
   * backoff first; resending is safe because the route rate-limits before it
   * writes (after its 404/403 reads, which change nothing).
   *
   * Only the fields present in `input` are sent.
   */
  async updateProject(slug: string, input: UpdateProjectInput): Promise<GuildProject> {
    return this.request<GuildProject>('PATCH', `/api/v1/projects/${encodeURIComponent(slug)}`, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    });
  }

  /**
   * POST /api/v1/tasks/[id]/submissions (auth). Server gates: caller must not
   * be the creator, must be the assignee once assigned, and must hold a Guild
   * member badge OR an agent badge (NO_BADGE 403 until the operator mints the
   * agent badge — expected during pre-pilot).
   */
  async createSubmission(taskId: number, content: string): Promise<GuildSubmission> {
    return this.request<GuildSubmission>('POST', `/api/v1/tasks/${taskId}/submissions`, {
      content,
    });
  }

  /** GET /api/v1/tasks/[id]/submissions — caller must be the task creator or a submitter. */
  async listSubmissions(taskId: number): Promise<GuildSubmission[]> {
    return this.request<GuildSubmission[]>('GET', `/api/v1/tasks/${taskId}/submissions`);
  }

  /**
   * PATCH /api/v1/submissions/[id]/review — the task creator records a review
   * decision. This moves NO money and does NOT advance task status; the on-chain
   * approve_and_release (confirmEscrow kind=approve) is the only path that pays.
   * Allowed only while the task is in "submitted".
   */
  async reviewSubmission(
    submissionId: number,
    status: 'approved' | 'rejected' | 'revision_requested',
    reviewerNotes?: string
  ): Promise<GuildSubmission> {
    return this.request<GuildSubmission>('PATCH', `/api/v1/submissions/${submissionId}/review`, {
      status,
      ...(reviewerNotes !== undefined ? { reviewer_notes: reviewerNotes } : {}),
    });
  }

  /**
   * POST /api/v1/tasks/[id]/escrow — confirm a committed on-chain lifecycle tx
   * (the server re-verifies the event against the Gateway before any DB write).
   * `intentHash` is the bech32m tx id ("txid_rdx1…") of the agent-signed tx.
   */
  async confirmEscrow(
    taskId: number,
    kind: EscrowConfirmKind,
    intentHash: string
  ): Promise<GuildTask> {
    return this.request<GuildTask>('POST', `/api/v1/tasks/${taskId}/escrow`, {
      intentHash,
      kind,
    });
  }

  /**
   * POST /api/v1/tasks/[id]/escrow/resync — walk the task's on-chain lifecycle
   * and replay into the DB every event it is missing. Any authed user may call
   * it: it can only move the DB TOWARD chain truth.
   *
   * This is the only way YOU can push an expiry into the DB. `expire_claim` is
   * public on-chain, so its sender need not be a party to the task and the
   * confirm route deliberately does not accept kind='expire' — a lapsed claim is
   * recovered by resyncing, not by confirming. Guild also runs a reconciler cron
   * that heals expiries unattended within ~30 minutes, so a row may reopen on its
   * own; call this when you do not want to wait. Gateway-heavy, so the server
   * limits it to 3/min per user (the client's 429 backoff covers that).
   */
  async resyncTask(taskId: number): Promise<GuildTask> {
    const data = await this.request<{ task: GuildTask } | GuildTask>(
      'POST',
      `/api/v1/tasks/${taskId}/escrow/resync`
    );
    return 'task' in data && data.task ? data.task : (data as GuildTask);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async rawRequest(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    return this.fetchFn(`${this.config.apiBaseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'manual',
    });
  }

  /**
   * rawRequest + ONE transparent re-auth when a LIVE session 401s. Every
   * authenticated method goes through this (authenticate() itself does NOT — it
   * uses rawRequest so it can never re-enter here).
   *
   * WHY RETRYING A WRITE (POST/PATCH) IS SAFE: a 401 is returned by the server's
   * auth middleware BEFORE the route handler runs, so the request had NO side
   * effect (no task created, no submission posted, no escrow confirmed). Re-sending
   * the identical request after re-auth therefore cannot double-apply — the first
   * attempt did nothing but get rejected. (A 2xx/4xx-after-handler is never retried
   * here; only a 401.)
   *
   * Only 401 heals: 403 (NO_BADGE), 404, 429, 400 are not session problems and a
   * fresh cookie never fixes them — retrying would waste a round-trip and, worse,
   * could mask a real error. The retry is straight-line (exactly once), never a
   * `while (status === 401)` loop, so a genuinely dead session terminates.
   */
  private async rawRequestAuthedOnce(
    method: string,
    path: string,
    body?: unknown
  ): Promise<Response> {
    const response = await this.rawRequest(method, path, body);
    if (response.status !== 401 || this.identity === null) return response;
    await this.reauthenticate(); // single-flight; if it throws, propagate (don't retry)
    return this.rawRequest(method, path, body); // retry EXACTLY once with the fresh cookie
  }

  /**
   * rawRequestAuthedOnce + waiting out 429s. Wraps the 401 self-heal (rather than
   * sitting inside it) so a request that is both rate-limited and stale-sessioned
   * resolves both, and so every caller inherits the backoff.
   *
   * WHY RETRYING A WRITE AFTER 429 IS SAFE — the same argument that licenses the
   * 401 retry, and it must keep holding: every limiter in this API is invoked as
   * the FIRST statement of its handler, before the body is even parsed, so a 429
   * response means the request had NO side effect. Nothing was created, funded,
   * submitted or confirmed. If a route ever rate-limits AFTER doing work, this
   * loop would start double-applying it — keep the check first.
   *
   * This matters at campaign volume: task creation allows 5 per 60s per user, so
   * a fixed inter-task pace has to be slower than 12s to never trip, and any
   * batch driver eventually will. Backing off on the server's own Retry-After is
   * self-tuning where a hardcoded sleep is a guess that rots.
   */
  private async rawRequestAuthed(method: string, path: string, body?: unknown): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const response = await this.rawRequestAuthedOnce(method, path, body);
      if (response.status !== 429 || attempt > this.maxRateLimitRetries) return response;
      await this.sleepFn(rateLimitWaitMs(response, attempt));
    }
  }

  /**
   * Single-flight ROLA re-login. `reauthPromise` is assigned synchronously before
   * the first await, and JS is single-threaded, so any concurrent 401 that reaches
   * here after the first sees it non-null and awaits the SAME challenge/verify —
   * N simultaneous 401s cost one re-auth, not N.
   */
  private async reauthenticate(): Promise<void> {
    if (this.reauthPromise === null) {
      const identity = this.identity;
      if (identity === null) return; // defensive; rawRequestAuthed already guards
      this.reauthPromise = this.authenticate(identity)
        .then(() => undefined)
        .finally(() => {
          this.reauthPromise = null;
        });
    }
    await this.reauthPromise;
  }

  /** Parse the `{ ok, data }` envelope or throw a GuildApiError. */
  private async parseEnvelopeData<T>(response: Response): Promise<T> {
    const envelope = (await response.json().catch(() => null)) as Envelope<T> | null;
    if (!response.ok || !envelope || !envelope.ok || envelope.data === undefined) {
      throw new GuildApiError(
        envelope?.error?.code ?? 'REQUEST_FAILED',
        envelope?.error?.message ?? `HTTP ${response.status}`,
        response.status
      );
    }
    return envelope.data;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.parseEnvelopeData<T>(await this.rawRequestAuthed(method, path, body));
  }
}
