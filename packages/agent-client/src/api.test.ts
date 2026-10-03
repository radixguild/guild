// GuildApiClient against a simulated Guild server (Bun.serve, ephemeral port).
// The /auth/verify stub runs the REAL @radixdlt/rola verifier (offline
// gateway stub), so authenticate() is exercised end-to-end: challenge issue →
// programmatic signing → server-side verification → cookie capture → cookie
// replay on authenticated endpoints.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Rola, type SignedChallenge } from '@radixdlt/rola';
import { GuildApiClient, GuildApiError } from './api.js';
import { AgentIdentity } from './identity.js';
import { generateThrowawayPrivateKeyHex } from './throwaway-key.js';
import { loadConfig } from './config.js';

const CONFIG = loadConfig();
const SESSION_TOKEN = 'test-session-token';

const rola = Rola({
  applicationName: 'Radix Guild',
  dAppDefinitionAddress: CONFIG.dAppDefinitionAddress,
  networkId: CONFIG.networkId,
  expectedOrigin: CONFIG.rolaOrigin,
  gatewayApiClient: {
    state: {
      getEntityDetailsVaultAggregated: () => Promise.resolve({ metadata: { items: [] } }),
    },
  } as never,
});

interface Seen {
  challenges: Set<string>;
  verifiedAddress: string | null;
  lastCookie: string | null;
  lastBody: unknown;
}
const seen: Seen = {
  challenges: new Set(),
  verifiedAddress: null,
  lastCookie: null,
  lastBody: null,
};

const TASK = {
  id: 5,
  title: 'Test task',
  description: 'Do the thing',
  status: 'assigned',
  rewardXrd: '1.00000000',
  creatorId: 'account_rdx1_creator',
  assigneeId: 'account_rdx1_worker',
  requiredTier: 'member',
  xpReward: 0,
  onChainTaskId: 42,
  deadline: null,
  createdAt: '2026-06-10T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
};

const PROJECT_SUMMARY = {
  id: 3,
  name: 'P1 Guild Infra',
  slug: 'p1-guild-infra',
  description: 'Infra tasks',
  commissionerId: 'account_rdx1_creator',
  createdAt: '2026-06-01T00:00:00.000Z',
  taskCount: 2,
  paidCount: 1,
  paidXrd: '5.00000000',
  lockedXrd: '1.00000000',
};

const PROJECT_DETAIL = {
  id: 3,
  name: 'P1 Guild Infra',
  slug: 'p1-guild-infra',
  description: 'Infra tasks',
  commissionerId: 'account_rdx1_creator',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  tasks: [TASK],
};

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      seen.lastCookie = req.headers.get('cookie');

      if (req.method === 'GET' && path === '/api/v1/auth/challenge') {
        const challenge = generateThrowawayPrivateKeyHex(); // 32-byte hex
        seen.challenges.add(challenge);
        return Response.json({ ok: true, data: { challenge, expires_at: Date.now() + 60_000 } });
      }

      if (req.method === 'POST' && path === '/api/v1/auth/verify') {
        const body = (await req.json()) as { signed_challenge?: SignedChallenge };
        const signed = body.signed_challenge;
        // verifyAuthSchema shape gate (mirror of the server's zod schema)
        if (
          !signed ||
          typeof signed.challenge !== 'string' ||
          typeof signed.address !== 'string' ||
          typeof signed.proof?.publicKey !== 'string' ||
          typeof signed.proof?.signature !== 'string' ||
          signed.proof.curve !== 'curve25519' ||
          signed.type !== 'account'
        ) {
          return Response.json(
            { ok: false, error: { code: 'VALIDATION_ERROR', message: 'bad shape' } },
            { status: 400 }
          );
        }
        if (!seen.challenges.delete(signed.challenge)) {
          return Response.json(
            { ok: false, error: { code: 'AUTH_FAILED', message: 'unknown_challenge' } },
            { status: 401 }
          );
        }
        const result = await rola.verifySignedChallenge(signed);
        if (result.isErr()) {
          return Response.json(
            { ok: false, error: { code: 'AUTH_FAILED', message: 'rola' } },
            { status: 401 }
          );
        }
        seen.verifiedAddress = signed.address;
        return new Response(JSON.stringify({ ok: true, data: { user: { id: signed.address } } }), {
          headers: {
            'content-type': 'application/json',
            'set-cookie': `guild_session=${SESSION_TOKEN}; Path=/; HttpOnly; SameSite=lax`,
          },
        });
      }

      const authed = seen.lastCookie?.includes(`guild_session=${SESSION_TOKEN}`) === true;

      if (req.method === 'GET' && path === '/api/v1/auth/me') {
        if (!authed) {
          return Response.json(
            { ok: false, error: { code: 'AUTH_REQUIRED', message: 'auth' } },
            { status: 401 }
          );
        }
        return Response.json({ ok: true, data: { user: { id: seen.verifiedAddress } } });
      }

      if (req.method === 'GET' && path === '/api/v1/tasks') {
        const status = url.searchParams.get('status');
        return Response.json({
          ok: true,
          data: status === 'open' ? [] : [TASK],
          cursor: null,
          hasMore: false,
        });
      }

      if (req.method === 'GET' && path === '/api/v1/tasks/5') {
        return Response.json({ ok: true, data: TASK });
      }

      if (req.method === 'GET' && path === '/api/v1/tasks/stats') {
        return Response.json({
          ok: true,
          data: {
            counts: {
              open: 3,
              assigned: 1,
              submitted: 0,
              paid: 2,
              cancelled: 0,
              disputed: 0,
              refunded: 0,
            },
            totalPaidXrd: '12.5',
          },
        });
      }

      if (req.method === 'POST' && path === '/api/v1/tasks') {
        if (!authed) {
          return Response.json(
            { ok: false, error: { code: 'AUTH_REQUIRED', message: 'auth' } },
            { status: 401 }
          );
        }
        seen.lastBody = await req.json();
        return Response.json(
          { ok: true, data: { ...TASK, id: 6, status: 'open' } },
          { status: 201 }
        );
      }

      if (req.method === 'GET' && path === '/api/v1/projects') {
        return Response.json({ ok: true, data: [PROJECT_SUMMARY] });
      }

      if (req.method === 'GET' && path === '/api/v1/projects/p1-guild-infra') {
        return Response.json({ ok: true, data: PROJECT_DETAIL });
      }

      if (req.method === 'GET' && path === '/api/v1/projects/does-not-exist') {
        return Response.json(
          { ok: false, error: { code: 'NOT_FOUND', message: 'Project not found' } },
          { status: 404 }
        );
      }

      if (req.method === 'POST' && path === '/api/v1/projects') {
        if (!authed) {
          return Response.json(
            { ok: false, error: { code: 'AUTH_REQUIRED', message: 'auth' } },
            { status: 401 }
          );
        }
        seen.lastBody = await req.json();
        return Response.json(
          {
            ok: true,
            data: {
              id: 4,
              name: (seen.lastBody as { name?: string }).name,
              slug: 'a-new-project',
              description: (seen.lastBody as { description?: string }).description ?? '',
              commissionerId: seen.verifiedAddress,
              createdAt: '2026-09-15T00:00:00.000Z',
              updatedAt: '2026-09-15T00:00:00.000Z',
            },
          },
          { status: 201 }
        );
      }

      // PATCH /api/v1/projects/[slug], in the real route's order: auth → 404 →
      // commissioner (403) → body → at-least-one-field (400) → updated row.
      // `p1-guild-infra` belongs to someone else; `my-project` belongs to
      // whichever account authenticated.
      if (req.method === 'PATCH' && path.startsWith('/api/v1/projects/')) {
        if (!authed) {
          return Response.json(
            { ok: false, error: { code: 'AUTH_REQUIRED', message: 'auth' } },
            { status: 401 }
          );
        }
        const slug = path.slice('/api/v1/projects/'.length);
        const owned = slug === 'my-project';
        if (!owned && slug !== 'p1-guild-infra') {
          return Response.json(
            { ok: false, error: { code: 'NOT_FOUND', message: 'Project not found' } },
            { status: 404 }
          );
        }
        if (!owned) {
          return Response.json(
            {
              ok: false,
              error: { code: 'FORBIDDEN', message: "Only the project's commissioner can update it" },
            },
            { status: 403 }
          );
        }
        const body = (await req.json()) as { name?: string; description?: string };
        seen.lastBody = body;
        if (body.name === undefined && body.description === undefined) {
          return Response.json(
            { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Provide at least one of: name, description' } },
            { status: 400 }
          );
        }
        return Response.json({
          ok: true,
          data: {
            id: 8,
            name: body.name ?? 'My Project',
            slug: 'my-project',
            description: body.description ?? 'Before',
            commissionerId: seen.verifiedAddress,
            createdAt: '2026-09-15T00:00:00.000Z',
            updatedAt: '2026-09-16T00:00:00.000Z',
          },
        });
      }

      if (req.method === 'POST' && path === '/api/v1/tasks/5/submissions') {
        if (!authed) {
          return Response.json(
            { ok: false, error: { code: 'AUTH_REQUIRED', message: 'auth' } },
            { status: 401 }
          );
        }
        const body = (await req.json()) as { content?: string };
        seen.lastBody = body;
        if (body.content === 'trigger-no-badge') {
          return Response.json(
            { ok: false, error: { code: 'NO_BADGE', message: 'badge required' } },
            { status: 403 }
          );
        }
        return Response.json(
          {
            ok: true,
            data: {
              id: 9,
              taskId: 5,
              submitterId: seen.verifiedAddress,
              content: body.content,
              status: 'pending',
              createdAt: '2026-06-10T00:00:00.000Z',
            },
          },
          { status: 201 }
        );
      }

      if (req.method === 'POST' && path === '/api/v1/tasks/5/escrow') {
        if (!authed) {
          return Response.json(
            { ok: false, error: { code: 'AUTH_REQUIRED', message: 'auth' } },
            { status: 401 }
          );
        }
        const body = (await req.json()) as { intentHash?: string; kind?: string };
        seen.lastBody = body;
        if (typeof body.intentHash !== 'string' || !/^txid_(rdx|tdx)/.test(body.intentHash)) {
          return Response.json(
            { ok: false, error: { code: 'INVALID_BODY', message: 'Valid intentHash required' } },
            { status: 400 }
          );
        }
        if (
          !['create', 'claim', 'submit', 'approve', 'dispute', 'resolve', 'cancel'].includes(
            body.kind ?? ''
          )
        ) {
          return Response.json(
            { ok: false, error: { code: 'INVALID_BODY', message: 'bad kind' } },
            { status: 400 }
          );
        }
        return Response.json({ ok: true, data: { ...TASK, status: 'submitted' } });
      }

      if (req.method === 'GET' && path === '/api/v1/tasks/5/submissions') {
        if (!authed) {
          return Response.json(
            { ok: false, error: { code: 'AUTH_REQUIRED', message: 'auth' } },
            { status: 401 }
          );
        }
        return Response.json({
          ok: true,
          data: [
            {
              id: 9,
              taskId: 5,
              submitterId: seen.verifiedAddress,
              content: 'work result',
              status: 'pending',
              createdAt: '2026-06-10T00:00:00.000Z',
            },
          ],
        });
      }

      if (req.method === 'PATCH' && path === '/api/v1/submissions/9/review') {
        if (!authed) {
          return Response.json(
            { ok: false, error: { code: 'AUTH_REQUIRED', message: 'auth' } },
            { status: 401 }
          );
        }
        const body = (await req.json()) as { status?: string; reviewer_notes?: string };
        seen.lastBody = body;
        if (!['approved', 'rejected', 'revision_requested'].includes(body.status ?? '')) {
          return Response.json(
            { ok: false, error: { code: 'VALIDATION_ERROR', message: 'bad status' } },
            { status: 400 }
          );
        }
        return Response.json({
          ok: true,
          data: {
            id: 9,
            taskId: 5,
            submitterId: seen.verifiedAddress,
            content: 'work result',
            status: body.status,
            createdAt: '2026-06-10T00:00:00.000Z',
          },
        });
      }

      return Response.json(
        { ok: false, error: { code: 'NOT_FOUND', message: path } },
        { status: 404 }
      );
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function clientFor(): GuildApiClient {
  return new GuildApiClient({ apiBaseUrl: baseUrl });
}

describe('GuildApiClient', () => {
  test('authenticate: full programmatic ROLA login captures the session cookie', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const api = clientFor();
    expect(api.isAuthenticated).toBe(false);
    const user = await api.authenticate(identity);
    expect(user.id).toBe(identity.address);
    expect(api.isAuthenticated).toBe(true);

    const me = await api.me();
    expect(me.id).toBe(identity.address);
    expect(seen.lastCookie).toContain(`guild_session=${SESSION_TOKEN}`);
  });

  test('listTasks builds filters and unwraps the page envelope', async () => {
    const api = clientFor();
    const page = await api.listTasks({ status: 'open', limit: 10, sort: 'newest' });
    expect(page.data).toEqual([]);
    expect(page.hasMore).toBe(false);
    const all = await api.listTasks();
    expect(all.data[0].id).toBe(5);
  });

  test('getTask unwraps a single task', async () => {
    const task = await clientFor().getTask(5);
    expect(task.id).toBe(5);
    expect(task.onChainTaskId).toBe(42);
  });

  test('getStats unwraps the public marketplace pulse (no auth)', async () => {
    const stats = await clientFor().getStats();
    expect(stats.counts.open).toBe(3);
    expect(stats.counts.paid).toBe(2);
    expect(stats.totalPaidXrd).toBe('12.5');
  });

  test('createTask posts the createTaskSchema body shape', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const api = clientFor();
    await api.authenticate(identity);
    const task = await api.createTask({
      title: 'Pilot task',
      description: 'One real 1-XRD task',
      reward_amount: '1',
    });
    expect(task.id).toBe(6);
    expect(seen.lastBody).toEqual({
      title: 'Pilot task',
      description: 'One real 1-XRD task',
      reward_amount: '1',
    });
  });

  test('createTask passes project_id through untouched when provided', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const api = clientFor();
    await api.authenticate(identity);
    await api.createTask({
      title: 'Pilot task',
      description: 'One real 1-XRD task',
      reward_amount: '1',
      project_id: 3,
    });
    expect(seen.lastBody).toEqual({
      title: 'Pilot task',
      description: 'One real 1-XRD task',
      reward_amount: '1',
      project_id: 3,
    });
  });

  test('createTask omits project_id when not provided (no regression to the existing body shape)', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const api = clientFor();
    await api.authenticate(identity);
    await api.createTask({ title: 'Pilot task', description: 'One real 1-XRD task', reward_amount: '1' });
    expect(seen.lastBody).not.toHaveProperty('project_id');
  });

  test('listProjects unwraps the array (no auth needed)', async () => {
    const projects = await clientFor().listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toEqual(PROJECT_SUMMARY as never);
  });

  test('getProject unwraps the project + its tasks (no auth needed)', async () => {
    const project = await clientFor().getProject('p1-guild-infra');
    expect(project.id).toBe(3);
    expect(project.slug).toBe('p1-guild-infra');
    expect(project.tasks).toHaveLength(1);
    expect(project.tasks[0].id).toBe(5);
  });

  test('getProject surfaces a GuildApiError NOT_FOUND for an unknown slug', async () => {
    const api = clientFor();
    await expect(api.getProject('does-not-exist')).rejects.toThrow('NOT_FOUND');
    try {
      await api.getProject('does-not-exist');
    } catch (error) {
      expect(error).toBeInstanceOf(GuildApiError);
      expect((error as GuildApiError).status).toBe(404);
    }
  });

  test('createProject posts {name, description} and unwraps the created row', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const api = clientFor();
    await api.authenticate(identity);
    const project = await api.createProject({ name: 'A New Project', description: 'desc' });
    expect(project.id).toBe(4);
    expect(project.slug).toBe('a-new-project');
    expect(seen.lastBody).toEqual({ name: 'A New Project', description: 'desc' });
  });

  test('createProject omits description when not given', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const api = clientFor();
    await api.authenticate(identity);
    await api.createProject({ name: 'No Description Project' });
    expect(seen.lastBody).toEqual({ name: 'No Description Project' });
  });

  test('createProject requires auth (AUTH_REQUIRED, same envelope as createTask)', async () => {
    const api = clientFor();
    await expect(api.createProject({ name: 'Nope' })).rejects.toThrow('AUTH_REQUIRED');
  });

  test('updateProject PATCHes the slug with only the fields given, and unwraps the updated row', async () => {
    // MUTATIONS, each verified red: send it as 'POST' (falls through to the
    // server's 404); always send both keys
    // (`{ name: input.name ?? null, description: input.description ?? null }`)
    // → the body gains `name: null`.
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const api = clientFor();
    await api.authenticate(identity);
    const project = await api.updateProject('my-project', { description: 'Corrected' });
    expect(seen.lastBody).toEqual({ description: 'Corrected' });
    expect(project.description).toBe('Corrected');
    expect(project.name).toBe('My Project');
    expect(project.slug).toBe('my-project');
  });

  test('updateProject surfaces a non-commissioner session as GuildApiError FORBIDDEN (403)', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const api = clientFor();
    await api.authenticate(identity);
    const err = await api.updateProject('p1-guild-infra', { name: 'Not Mine' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuildApiError);
    expect((err as GuildApiError).code).toBe('FORBIDDEN');
    expect((err as GuildApiError).status).toBe(403);
  });

  test('updateProject surfaces an unknown slug as GuildApiError NOT_FOUND (404)', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const api = clientFor();
    await api.authenticate(identity);
    const err = await api.updateProject('does-not-exist', { name: 'Nope' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuildApiError);
    expect((err as GuildApiError).code).toBe('NOT_FOUND');
    expect((err as GuildApiError).status).toBe(404);
  });

  test('updateProject requires auth (AUTH_REQUIRED, same envelope as createProject)', async () => {
    const api = clientFor();
    await expect(api.updateProject('my-project', { name: 'Nope' })).rejects.toThrow('AUTH_REQUIRED');
  });

  // 429 handling itself is generic (rawRequestAuthed backs off on ANY authed
  // request — see rate-limit-backoff.test.ts, proven against getTask) and
  // listProjects/getProject/createProject/updateProject all funnel through the SAME
  // request()/rawRequestAuthed plumbing as every other method on this client
  // (no bespoke fetch path), so it is not re-tested per-endpoint here.

  test('createSubmission sends the cookie and content', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const api = clientFor();
    await api.authenticate(identity);
    const submission = await api.createSubmission(5, 'work result');
    expect(submission.taskId).toBe(5);
    expect(seen.lastBody).toEqual({ content: 'work result' });
  });

  test('error envelope surfaces as GuildApiError with the server code', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const api = clientFor();
    await api.authenticate(identity);
    expect(api.createSubmission(5, 'trigger-no-badge')).rejects.toThrow('NO_BADGE');
    try {
      await api.createSubmission(5, 'trigger-no-badge');
    } catch (error) {
      expect(error).toBeInstanceOf(GuildApiError);
      expect((error as GuildApiError).code).toBe('NO_BADGE');
      expect((error as GuildApiError).status).toBe(403);
    }
  });

  test('listSubmissions unwraps the submissions array', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const api = clientFor();
    await api.authenticate(identity);
    const subs = await api.listSubmissions(5);
    expect(subs).toHaveLength(1);
    expect(subs[0].id).toBe(9);
    expect(subs[0].taskId).toBe(5);
  });

  test('reviewSubmission PATCHes {status, reviewer_notes} for the creator', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const api = clientFor();
    await api.authenticate(identity);
    const updated = await api.reviewSubmission(9, 'approved', 'looks good');
    expect(updated.status).toBe('approved');
    expect(seen.lastBody).toEqual({ status: 'approved', reviewer_notes: 'looks good' });
  });

  test('reviewSubmission omits reviewer_notes when not provided', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const api = clientFor();
    await api.authenticate(identity);
    await api.reviewSubmission(9, 'approved');
    expect(seen.lastBody).toEqual({ status: 'approved' });
  });

  test('confirmEscrow posts {intentHash, kind} exactly', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const api = clientFor();
    await api.authenticate(identity);
    const task = await api.confirmEscrow(5, 'submit', `txid_rdx1${'q'.repeat(20)}`);
    expect(task.status).toBe('submitted');
    expect(seen.lastBody).toEqual({ intentHash: `txid_rdx1${'q'.repeat(20)}`, kind: 'submit' });
  });

  test('unauthenticated write fails with AUTH_REQUIRED', async () => {
    const api = clientFor();
    expect(api.createSubmission(5, 'nope')).rejects.toThrow('AUTH_REQUIRED');
  });
});

// ── 401 session self-heal ───────────────────────────────────────────────────
// Isolated Bun.serve with its OWN state so the shared server above (constant
// SESSION_TOKEN, no expiry) is untouched. This server rotates its accepted
// session so a test can simulate a mid-run JWT expiry: expire() staleifies the
// client's cookie WITHOUT telling the client, so the next authed call 401s.
describe('GuildApiClient 401 self-heal', () => {
  let hs: ReturnType<typeof Bun.serve>;
  let hBase: string;
  const h = {
    accept: null as string | null, // the cookie value the server currently accepts
    verifyCount: 0, // number of /auth/verify round-trips that succeeded
    submissionsCreated: 0, // POST side-effect counter (write-retry safety)
    challenges: new Set<string>(),
    failReauth: false, // when true, /auth/verify 401s (deauthorized identity)
  };

  beforeAll(() => {
    hs = Bun.serve({
      port: 0,
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const path = url.pathname;
        const cookie = req.headers.get('cookie');

        if (req.method === 'GET' && path === '/api/v1/auth/challenge') {
          const c = generateThrowawayPrivateKeyHex();
          h.challenges.add(c);
          return Response.json({ ok: true, data: { challenge: c, expires_at: Date.now() + 60_000 } });
        }
        if (req.method === 'POST' && path === '/api/v1/auth/verify') {
          if (h.failReauth) {
            return Response.json(
              { ok: false, error: { code: 'AUTH_FAILED', message: 'deauthorized' } },
              { status: 401 }
            );
          }
          const body = (await req.json()) as { signed_challenge?: SignedChallenge };
          const signed = body.signed_challenge;
          if (!signed || !h.challenges.delete(signed.challenge)) {
            return Response.json(
              { ok: false, error: { code: 'AUTH_FAILED', message: 'challenge' } },
              { status: 401 }
            );
          }
          const result = await rola.verifySignedChallenge(signed);
          if (result.isErr()) {
            return Response.json(
              { ok: false, error: { code: 'AUTH_FAILED', message: 'rola' } },
              { status: 401 }
            );
          }
          h.verifyCount += 1;
          h.accept = `sess-${h.verifyCount}`;
          return new Response(JSON.stringify({ ok: true, data: { user: { id: signed.address } } }), {
            headers: {
              'content-type': 'application/json',
              'set-cookie': `guild_session=${h.accept}; Path=/; HttpOnly; SameSite=lax`,
            },
          });
        }

        const authed = h.accept !== null && cookie?.includes(`guild_session=${h.accept}`) === true;

        if (req.method === 'GET' && path === '/api/v1/tasks') {
          if (!authed) {
            return Response.json(
              { ok: false, error: { code: 'AUTH_REQUIRED', message: 'expired' } },
              { status: 401 }
            );
          }
          return Response.json({ ok: true, data: [], cursor: null, hasMore: false });
        }
        if (req.method === 'POST' && path === '/api/v1/tasks/5/submissions') {
          if (!authed) {
            return Response.json(
              { ok: false, error: { code: 'AUTH_REQUIRED', message: 'expired' } },
              { status: 401 }
            );
          }
          const body = (await req.json()) as { content?: string };
          if (body.content === 'trigger-no-badge') {
            return Response.json(
              { ok: false, error: { code: 'NO_BADGE', message: 'badge required' } },
              { status: 403 }
            );
          }
          h.submissionsCreated += 1; // the ONLY place a submission side-effect happens
          return Response.json(
            {
              ok: true,
              data: {
                id: h.submissionsCreated,
                taskId: 5,
                submitterId: 'account_rdx1_w',
                content: body.content,
                status: 'pending',
                createdAt: '2026-06-10T00:00:00.000Z',
              },
            },
            { status: 201 }
          );
        }
        return Response.json({ ok: false, error: { code: 'NOT_FOUND', message: path } }, { status: 404 });
      },
    });
    hBase = `http://localhost:${hs.port}`;
  });

  afterAll(() => {
    hs.stop(true);
  });

  function reset(): void {
    h.accept = null;
    h.verifyCount = 0;
    h.submissionsCreated = 0;
    h.challenges.clear();
    h.failReauth = false;
  }
  function newClient(): GuildApiClient {
    return new GuildApiClient({ apiBaseUrl: hBase });
  }
  async function newIdentity(): Promise<AgentIdentity> {
    return AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
  }
  /** Simulate a JWT expiry: staleify the client's cookie without re-issuing one. */
  function expire(): void {
    h.accept = `rotated-${h.verifyCount}`;
  }

  test('a GET that 401s re-authenticates once and transparently retries', async () => {
    reset();
    const api = newClient();
    await api.authenticate(await newIdentity());
    expect(h.verifyCount).toBe(1);
    expire();
    const page = await api.listTasks({ status: 'open' }); // stale cookie -> 401 -> heal -> 200
    expect(page.data).toEqual([]);
    expect(h.verifyCount).toBe(2); // exactly one re-auth
  });

  test('a POST that 401s retries with EXACTLY ONE side effect (write-retry safety)', async () => {
    reset();
    const api = newClient();
    await api.authenticate(await newIdentity());
    expire();
    const sub = await api.createSubmission(5, 'the work'); // 401 before handler -> no create -> heal -> create
    expect(sub.id).toBe(1);
    expect(h.submissionsCreated).toBe(1); // the rejected first attempt created NOTHING
    expect(h.verifyCount).toBe(2);
  });

  test('a 403 NO_BADGE never triggers re-auth (only 401 heals)', async () => {
    reset();
    const api = newClient();
    await api.authenticate(await newIdentity());
    await expect(api.createSubmission(5, 'trigger-no-badge')).rejects.toThrow('NO_BADGE');
    expect(h.verifyCount).toBe(1); // no re-auth fired on a 403
  });

  test('a never-authenticated client does NOT self-heal a 401', async () => {
    reset();
    const api = newClient(); // identity === null
    await expect(api.listTasks()).rejects.toThrow('AUTH_REQUIRED');
    expect(h.verifyCount).toBe(0); // never tried to re-auth
  });

  test('a re-auth that keeps failing retries once then propagates (no infinite loop)', async () => {
    reset();
    const api = newClient();
    await api.authenticate(await newIdentity());
    expire();
    h.failReauth = true; // the identity is now rejected at /verify
    await expect(api.listTasks()).rejects.toThrow(); // 401 -> re-auth throws -> propagate, original not retried
    expect(h.verifyCount).toBe(1); // the failed verify never incremented
  });

  test('concurrent 401s collapse to a single re-auth (single-flight)', async () => {
    reset();
    const api = newClient();
    await api.authenticate(await newIdentity());
    expect(h.verifyCount).toBe(1);
    expire();
    const [a, b] = await Promise.all([api.listTasks({ status: 'open' }), api.listTasks({ status: 'assigned' })]);
    expect(a.data).toEqual([]);
    expect(b.data).toEqual([]);
    expect(h.verifyCount).toBe(2); // 1 initial + 1 SHARED re-auth, not 3
  });
});
