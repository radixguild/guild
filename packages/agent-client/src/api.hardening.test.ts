// Adversarial hardening for GuildApiClient — the 401 self-heal loop and the
// error-mapping seams that turn a mid-deploy proxy 5xx (HTML body) into a clean
// GuildApiError instead of an opaque SyntaxError.
//
// Unlike the sibling api.test.ts (a real Bun.serve running the REAL rola
// verifier), this file drives the client through an INJECTED fetchFn
// (new GuildApiClient(config, { fetchFn })). That gives per-call control over
// status/body/headers — the only way to force the pathological responses these
// tests exercise (a 502 HTML body, a session that 401s forever, a re-auth that
// keeps failing) which a well-behaved server never emits. ROLA signing still runs
// for real client-side (createSignedChallenge over a real AgentIdentity); the
// fetchFn simply never checks the signature, so authenticate() completes.

import { describe, test, expect } from 'bun:test';
import { GuildApiClient, GuildApiError } from './api.js';
import { AgentIdentity } from './identity.js';
import { generateThrowawayPrivateKeyHex } from './throwaway-key.js';

const BASE = 'https://guild.test';

async function newIdentity(): Promise<AgentIdentity> {
  return AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
}

function jsonResponse(status: number, obj: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

function cookieResponse(cookieVal: string, obj: unknown): Response {
  return jsonResponse(200, obj, {
    'set-cookie': `guild_session=${cookieVal}; Path=/; HttpOnly; SameSite=lax`,
  });
}

function htmlResponse(status: number): Response {
  return new Response('<html>502</html>', {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

interface Call {
  method: string;
  path: string;
  url: string;
  cookie: string | null;
}

interface FakeState {
  calls: Call[];
  challengeCount: number;
  verifyCount: number;
  /** The cookie value the fake currently accepts as a live session. */
  accept: string | null;
  /** When true, /auth/verify 401s (the identity has been deauthorized). */
  failVerify: boolean;
  /** When true, /auth/verify answers with a non-JSON (HTML 502) body. */
  verifyNonJson: boolean;
  issued: Set<string>;
}

function freshState(): FakeState {
  return {
    calls: [],
    challengeCount: 0,
    verifyCount: 0,
    accept: null,
    failVerify: false,
    verifyNonJson: false,
    issued: new Set(),
  };
}

/**
 * Build an injectable fetchFn that handles the ROLA challenge/verify handshake
 * (so authenticate() works) and delegates every other request to `onAuthed`.
 * `onAuthed` decides the authed-endpoint behavior per test (always-401,
 * heal-then-200, success, etc.).
 */
function buildFetch(
  state: FakeState,
  onAuthed: (ctx: { method: string; path: string; cookie: string | null; state: FakeState }) => Response
): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const url = new URL(rawUrl);
    const path = url.pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const cookie = headers.cookie ?? null;
    state.calls.push({ method, path, url: url.toString(), cookie });

    if (method === 'GET' && path === '/api/v1/auth/challenge') {
      state.challengeCount += 1;
      const challenge = generateThrowawayPrivateKeyHex(); // 32-byte hex
      state.issued.add(challenge);
      return jsonResponse(200, { ok: true, data: { challenge, expires_at: Date.now() + 60_000 } });
    }

    if (method === 'POST' && path === '/api/v1/auth/verify') {
      if (state.verifyNonJson) return htmlResponse(502);
      if (state.failVerify) {
        return jsonResponse(401, { ok: false, error: { code: 'AUTH_FAILED', message: 'deauthorized' } });
      }
      state.verifyCount += 1;
      state.accept = `sess-${state.verifyCount}`;
      return cookieResponse(state.accept, { ok: true, data: { user: { id: 'account_rdx1_agent' } } });
    }

    return onAuthed({ method, path, cookie, state });
  };
  return fn as unknown as typeof fetch;
}

function clientWith(fetchFn: typeof fetch): GuildApiClient {
  return new GuildApiClient({ apiBaseUrl: BASE }, { fetchFn });
}

/** A funded task envelope body the authed success paths return. */
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

/** True when the presented cookie matches the fake's currently-accepted session. */
function authedCookie(state: FakeState, cookie: string | null): boolean {
  return state.accept !== null && cookie?.includes(`guild_session=${state.accept}`) === true;
}

// ── Non-JSON body → GuildApiError, never a raw SyntaxError ────────────────────
// A proxy 5xx during a deploy answers with an HTML page, not the JSON envelope.
// response.json() then throws a SyntaxError; the client must .catch it and map to
// a GuildApiError so the worker loop sees a typed, actionable error.
describe('non-JSON error body maps to GuildApiError (not SyntaxError)', () => {
  test('listTasks: a 502 HTML body rejects as GuildApiError, not SyntaxError', async () => {
    const state = freshState();
    // Never reaches challenge/verify — listTasks is called unauthenticated and
    // the very first response is the HTML 502.
    const api = clientWith(buildFetch(state, () => htmlResponse(502)));

    let caught: unknown;
    try {
      await api.listTasks();
      throw new Error('expected listTasks to reject');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GuildApiError);
    expect(caught).not.toBeInstanceOf(SyntaxError);
    expect((caught as GuildApiError).name).toBe('GuildApiError');
    expect((caught as GuildApiError).status).toBe(502);
    expect((caught as GuildApiError).code).toBe('REQUEST_FAILED');
  });

  test('authenticate: a /verify non-JSON body rejects as GuildApiError, not SyntaxError', async () => {
    const state = freshState();
    state.verifyNonJson = true; // challenge succeeds, verify returns HTML 502
    const api = clientWith(buildFetch(state, () => htmlResponse(404)));
    const identity = await newIdentity();

    let caught: unknown;
    try {
      await api.authenticate(identity);
      throw new Error('expected authenticate to reject');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GuildApiError);
    expect(caught).not.toBeInstanceOf(SyntaxError);
    expect((caught as GuildApiError).status).toBe(502);
    expect((caught as GuildApiError).code).toBe('AUTH_FAILED');
    expect(api.isAuthenticated).toBe(false); // no cookie captured on a failed verify
  });
});

// ── 401 self-heal: bounded, single-flight, write-safe ─────────────────────────
describe('401 self-heal loop is bounded and correct', () => {
  test('persistent 401: re-auths ONCE, retries ONCE, then terminates as GuildApiError(401)', async () => {
    const state = freshState();
    // Every authed request 401s — even after a fresh, valid re-auth. This is the
    // infinite-loop trap: a naive `while (status === 401) reauth()` never exits.
    const api = clientWith(buildFetch(state, () => jsonResponse(401, {
      ok: false,
      error: { code: 'AUTH_REQUIRED', message: 'expired' },
    })));
    await api.authenticate(await newIdentity());
    expect(state.verifyCount).toBe(1);

    let caught: unknown;
    try {
      await api.getTask(5);
      throw new Error('expected getTask to reject');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GuildApiError);
    expect((caught as GuildApiError).status).toBe(401);

    // The money path: exactly one re-auth (verifyCount 1→2) and exactly TWO hits
    // on the task endpoint (initial + one retry) — never an unbounded loop.
    expect(state.verifyCount).toBe(2);
    const taskCalls = state.calls.filter((c) => c.path === '/api/v1/tasks/5');
    expect(taskCalls).toHaveLength(2);
  });

  test('re-auth verify THROWS: error propagates and the original call is NOT retried', async () => {
    const state = freshState();
    const api = clientWith(buildFetch(state, () => jsonResponse(401, {
      ok: false,
      error: { code: 'AUTH_REQUIRED', message: 'expired' },
    })));
    await api.authenticate(await newIdentity());
    expect(state.verifyCount).toBe(1);
    state.failVerify = true; // the re-auth /verify now 401s (identity deauthorized)

    await expect(api.getTask(5)).rejects.toBeInstanceOf(GuildApiError);

    // The failing verify never incremented verifyCount, and the original getTask
    // fired exactly ONCE (no retry after a re-auth that threw).
    expect(state.verifyCount).toBe(1);
    const taskCalls = state.calls.filter((c) => c.path === '/api/v1/tasks/5');
    expect(taskCalls).toHaveLength(1);
  });

  test('concurrent 401s collapse to a SINGLE re-auth (single-flight challenge hit once)', async () => {
    const state = freshState();
    // Heal-then-serve: a request 401s while its cookie is stale, 200s once the
    // fresh session cookie is presented.
    const api = clientWith(buildFetch(state, ({ cookie, state: s }) => {
      if (!authedCookie(s, cookie)) {
        return jsonResponse(401, { ok: false, error: { code: 'AUTH_REQUIRED', message: 'expired' } });
      }
      return jsonResponse(200, { ok: true, data: [], cursor: null, hasMore: false });
    }));
    await api.authenticate(await newIdentity());
    expect(state.verifyCount).toBe(1);

    // Expire the session: the client still holds sess-1, but the fake now accepts
    // only a not-yet-issued value → the next calls 401 until a re-auth runs.
    state.accept = 'expired';
    state.challengeCount = 0; // count ONLY the re-auth challenges from here

    const N = 4;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        api.listTasks({ status: i % 2 === 0 ? 'open' : 'assigned' })
      )
    );
    for (const page of results) expect(page.data).toEqual([]);

    // N simultaneous 401s share ONE re-auth: the challenge endpoint is hit once,
    // not N times, and verifyCount advances by exactly one (1 → 2).
    expect(state.challengeCount).toBe(1);
    expect(state.verifyCount).toBe(2);
  });
});

// ── Write-retry safety: money-path writes replay exactly once after re-auth ────
describe('write-path 401 self-heal returns the success value', () => {
  // createTask (POST) and confirmEscrow (POST) each 401 once (stale cookie) then
  // succeed after the transparent re-auth. A 401 is returned by auth middleware
  // BEFORE the handler runs, so the rejected first attempt had no side effect and
  // the retry cannot double-apply — same guarantee the sibling proves for
  // createSubmission.
  test('createTask: 401-once then 201 returns the created task', async () => {
    const state = freshState();
    const api = clientWith(buildFetch(state, ({ method, path, cookie, state: s }) => {
      if (method === 'POST' && path === '/api/v1/tasks') {
        if (!authedCookie(s, cookie)) {
          return jsonResponse(401, { ok: false, error: { code: 'AUTH_REQUIRED', message: 'expired' } });
        }
        return jsonResponse(201, { ok: true, data: { ...TASK, id: 6, status: 'open' } });
      }
      return jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: path } });
    }));
    await api.authenticate(await newIdentity());
    state.accept = 'expired'; // force the first POST to 401

    const task = await api.createTask({ title: 'Pilot', description: 'One real task', reward_amount: '1' });
    expect(task.id).toBe(6);
    expect(task.status).toBe('open');
    expect(state.verifyCount).toBe(2); // one initial + one heal
    const posts = state.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/tasks');
    expect(posts).toHaveLength(2); // rejected attempt + successful replay
  });

  test('confirmEscrow: 401-once then 200 returns the updated task', async () => {
    const state = freshState();
    const api = clientWith(buildFetch(state, ({ method, path, cookie, state: s }) => {
      if (method === 'POST' && path === '/api/v1/tasks/5/escrow') {
        if (!authedCookie(s, cookie)) {
          return jsonResponse(401, { ok: false, error: { code: 'AUTH_REQUIRED', message: 'expired' } });
        }
        return jsonResponse(200, { ok: true, data: { ...TASK, status: 'submitted' } });
      }
      return jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: path } });
    }));
    await api.authenticate(await newIdentity());
    state.accept = 'expired';

    const task = await api.confirmEscrow(5, 'submit', `txid_rdx1${'q'.repeat(20)}`);
    expect(task.status).toBe('submitted');
    expect(state.verifyCount).toBe(2);
    const posts = state.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/tasks/5/escrow');
    expect(posts).toHaveLength(2);
  });
});

// ── taskId URL safety (validation-gap documentation) ──────────────────────────
// getTask interpolates taskId RAW into the path with no numeric validation. These
// tests document the built URL for non-integer inputs so a future validation
// change is a deliberate, test-visible decision — not a silent behavior drift.
describe('getTask taskId is interpolated without validation (documented gap)', () => {
  const cases: { label: string; taskId: number; expectedPath: string }[] = [
    { label: 'NaN', taskId: NaN, expectedPath: '/api/v1/tasks/NaN' },
    { label: 'non-integer 1.5', taskId: 1.5, expectedPath: '/api/v1/tasks/1.5' },
  ];
  for (const { label, taskId, expectedPath } of cases) {
    test(`getTask(${label}) builds ${label} into the path (no client-side guard)`, async () => {
      const state = freshState();
      // Return a valid task so getTask resolves — the point is the URL shape, not the result.
      const api = clientWith(buildFetch(state, () => jsonResponse(200, { ok: true, data: TASK })));
      await api.getTask(taskId);
      const last = state.calls.at(-1)!;
      expect(last.method).toBe('GET');
      expect(last.path).toBe(expectedPath);
      // Explicit gap marker: NaN and 1.5 both reach the wire verbatim. If a guard
      // is ever added client-side, THIS assertion is the one that must change.
      expect(new URL(last.url).pathname).toBe(expectedPath);
    });
  }
});

// ── fetch network throw propagates (never hangs) ──────────────────────────────
describe('a fetch-layer network throw surfaces to the caller', () => {
  test('fetchFn rejecting with TypeError("fetch failed") propagates, not hangs', async () => {
    const netErr = new TypeError('fetch failed');
    const fetchFn = (async () => {
      throw netErr;
    }) as unknown as typeof fetch;
    const api = clientWith(fetchFn);

    // No response object ever exists → nothing to 401 on → the raw network error
    // must escape as-is. (The test completing at all proves it does not hang.)
    await expect(api.listTasks()).rejects.toThrow('fetch failed');
    await expect(api.getTask(5)).rejects.toBeInstanceOf(TypeError);
  });
});
