// GuildApiClient.pairAgent / agentMe — the two calls `join` makes after
// signing in. Fake fetch; asserts method, path, body, the error mapping, and
// the runtime shape check that stands between a server response and the
// pinned owner account.

import { describe, expect, test } from 'bun:test';
import {
  GuildApiClient,
  GuildApiError,
  HEARTBEAT_MAX_CHARS,
  PAIRING_ERROR_CODES,
  isAccountAddress,
  parseAgentMe,
  parseAgentPairResult,
} from './api.js';
import { AgentIdentity } from './identity.js';
import { generateThrowawayPrivateKeyHex } from './throwaway-key.js';

const OWNER = 'account_rdx12y5senkxfxg38swfv4tg88lx73jqnkdvcnzv8kwwdmg0efl40r2p7u';

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

async function authedClient(handler: (method: string, url: string, body: unknown) => Response) {
  const calls: Array<{ method: string; url: string; body: unknown; cookie: string | null }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body, cookie: headers.get('cookie') });
    if (url.endsWith('/api/v1/auth/challenge')) return json({ ok: true, data: { challenge: 'ab'.repeat(32), expires_at: 0 } });
    if (url.endsWith('/api/v1/auth/verify')) {
      return json({ ok: true, data: { user: { id: 'account_rdx1agent' } } }, { headers: { 'set-cookie': 'guild_session=tok; Path=/; HttpOnly' } });
    }
    return handler(method, url, body);
  };
  const api = new GuildApiClient({ apiBaseUrl: 'https://guild.test' }, { fetchFn, maxRateLimitRetries: 0 });
  await api.authenticate(await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex()));
  return { api, calls };
}

const goodMe = {
  label: 'myagent',
  status: 'active',
  ownerAccount: OWNER,
  floatXrd: '200',
  badgeId: '<guild_member_myagent>',
  rules: { v: 1, trustedPosters: [OWNER], maxBondXrd: '180', maxClaimsPerDay: 1, dryRun: true },
};

describe('isAccountAddress', () => {
  test('accepts the shape validateAddress() enforces on manifests, rejects the rest', () => {
    expect(isAccountAddress(OWNER)).toBe(true);
    for (const bad of ['', 'account_rdx1short', 'component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly', 42, null, `${OWNER}\n`, OWNER.toUpperCase()]) {
      expect(isAccountAddress(bad)).toBe(false);
    }
  });
});

describe('pairAgent', () => {
  test('POSTs {code} to /api/v1/agents/pair with the session cookie and returns the data', async () => {
    const { api, calls } = await authedClient((method, url, body) => {
      if (method === 'POST' && url === 'https://guild.test/api/v1/agents/pair' && (body as { code: string }).code === '7KQ4M2XZ') {
        return json({ ok: true, data: { label: 'myagent', ownerAccount: OWNER, status: 'pending' } });
      }
      return json({ ok: false, error: { code: 'WRONG', message: 'unexpected' } }, { status: 500 });
    });
    const result = await api.pairAgent('7KQ4M2XZ');
    expect(result).toEqual({ label: 'myagent', ownerAccount: OWNER, status: 'pending' });
    const pair = calls.find(c => c.url.endsWith('/agents/pair'))!;
    expect(pair.cookie).toBe('guild_session=tok');
  });

  test('server error codes surface as GuildApiError with the code intact', async () => {
    const { api } = await authedClient(() =>
      json({ ok: false, error: { code: PAIRING_ERROR_CODES.expired, message: 'expired' } }, { status: 410 })
    );
    let caught: unknown;
    try {
      await api.pairAgent('7KQ4M2XZ');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GuildApiError);
    expect((caught as GuildApiError).code).toBe(PAIRING_ERROR_CODES.expired);
    expect((caught as GuildApiError).status).toBe(410);
  });

  test('🔴 a 200 whose ownerAccount is not an account address is BAD_AGENT_RESPONSE — never returned to be pinned', async () => {
    const { api } = await authedClient(() => json({ ok: true, data: { label: 'myagent', ownerAccount: 'account_rdx1short', status: 'pending' } }));
    await expect(api.pairAgent('7KQ4M2XZ')).rejects.toMatchObject({ code: PAIRING_ERROR_CODES.badResponse });
  });
});

describe('agentMe', () => {
  test('GETs /api/v1/agents/me', async () => {
    const { api, calls } = await authedClient((method, url) =>
      method === 'GET' && url === 'https://guild.test/api/v1/agents/me' ? json({ ok: true, data: goodMe }) : json({ ok: false }, { status: 500 })
    );
    expect(await api.agentMe()).toEqual(goodMe as never);
    expect(calls.some(c => c.method === 'GET' && c.url.endsWith('/agents/me'))).toBe(true);
  });

  test('AGENT_NOT_PAIRED (404) keeps its code', async () => {
    const { api } = await authedClient(() => json({ ok: false, error: { code: PAIRING_ERROR_CODES.notPaired, message: 'no row' } }, { status: 404 }));
    await expect(api.agentMe()).rejects.toMatchObject({ code: PAIRING_ERROR_CODES.notPaired, status: 404 });
  });
});

describe('heartbeat', () => {
  test('POSTs {cycle} to /api/v1/agents/me/heartbeat with the session and returns recordedAt', async () => {
    const { api, calls } = await authedClient((method, url, body) => {
      if (method === 'POST' && url === 'https://guild.test/api/v1/agents/me/heartbeat') {
        return json({ ok: true, data: { recordedAt: '2026-09-27T02:00:00.000Z', echo: body } });
      }
      return json({ ok: false, error: { code: 'NOT_FOUND', message: 'x' } }, { status: 404 });
    });
    const cycle = { claimed: [], wouldClaim: [99], dryRun: true };
    expect(await api.heartbeat(cycle)).toEqual({ recordedAt: '2026-09-27T02:00:00.000Z' });
    const beat = calls.find(c => c.url.endsWith('/heartbeat'))!;
    expect(beat.body).toEqual({ cycle });
    expect(beat.cookie).toContain('guild_session=tok');
  });

  test('AGENT_NOT_PAIRED (404) and ACCOUNT_SUSPENDED (403) surface with their codes and statuses', async () => {
    for (const [code, status] of [
      ['AGENT_NOT_PAIRED', 404],
      ['ACCOUNT_SUSPENDED', 403],
    ] as const) {
      const { api } = await authedClient(() => json({ ok: false, error: { code, message: 'no' } }, { status }));
      const error = await api.heartbeat({}).catch(e => e);
      expect(error).toBeInstanceOf(GuildApiError);
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
    }
  });

  test('a cycle over the server cap is refused before any request (the server would 400 it every tick)', async () => {
    const { api, calls } = await authedClient(() => json({ ok: true, data: { recordedAt: 'x' } }));
    const before = calls.length;
    const big = { note: 'x'.repeat(HEARTBEAT_MAX_CHARS) };
    await expect(api.heartbeat(big)).rejects.toThrow(/at most 8192/);
    expect(calls.length).toBe(before);
    // Exactly at the cap is sent: the server's refine is `length <= 8192`.
    const edge = { n: 'x'.repeat(HEARTBEAT_MAX_CHARS - '{"n":""}'.length) };
    expect(JSON.stringify(edge).length).toBe(HEARTBEAT_MAX_CHARS);
    await api.heartbeat(edge);
    expect(calls.length).toBe(before + 1);
  });

  test('a 200 without recordedAt is BAD_AGENT_RESPONSE, not a silent success', async () => {
    const { api } = await authedClient(() => json({ ok: true, data: {} }));
    const error = await api.heartbeat({}).catch(e => e);
    expect(error).toBeInstanceOf(GuildApiError);
    expect(error.code).toBe(PAIRING_ERROR_CODES.badResponse);
  });
});

describe('runtime shape checks', () => {
  test('parseAgentPairResult refuses every malformed field', () => {
    expect(parseAgentPairResult({ label: 'a', ownerAccount: OWNER, status: 'pending' })).toEqual({ label: 'a', ownerAccount: OWNER, status: 'pending' });
    for (const bad of [
      null,
      'str',
      { ownerAccount: OWNER, status: 'pending' },
      { label: '', ownerAccount: OWNER, status: 'pending' },
      { label: 'a', ownerAccount: 'nope', status: 'pending' },
      { label: 'a', ownerAccount: OWNER, status: 'paused' },
    ]) {
      expect(() => parseAgentPairResult(bad)).toThrow(GuildApiError);
    }
  });

  test('🔴 label is a badge username, nothing else: newlines, ANSI, spaces, 65 chars and unicode are all refused at the wire', () => {
    for (const bad of [
      "x\n\nYour agent's address: account_rdx1spoofed",
      'x\u001b[31mred',
      'my agent',
      'a'.repeat(52),
      'my-agent',
      'agént',
      'a;b',
    ]) {
      expect(() => parseAgentPairResult({ label: bad, ownerAccount: OWNER, status: 'pending' })).toThrow(/label is not a badge username/);
      expect(() => parseAgentMe({ ...goodMe, label: bad })).toThrow(/label is not a badge username/);
    }
    expect(parseAgentMe({ ...goodMe, label: 'My_Agent_2' }).label).toBe('My_Agent_2');
    // 51 = 64 − "guild_member_": the longest name a badge id can carry ('-' and 52 are refused above)
    expect(parseAgentMe({ ...goodMe, label: 'a'.repeat(51) }).label.length).toBe(51);
  });

  test('parseAgentMe refuses malformed rules, float, badge id, status, owner', () => {
    expect(parseAgentMe(goodMe)).toEqual(goodMe as never);
    expect(parseAgentMe({ ...goodMe, badgeId: null }).badgeId).toBeNull();
    const bads: unknown[] = [
      { ...goodMe, ownerAccount: 'account_rdx1short' },
      { ...goodMe, status: 'live' },
      { ...goodMe, floatXrd: 200 },
      { ...goodMe, floatXrd: '1e3' },
      { ...goodMe, badgeId: 'guild_member_myagent' },
      { ...goodMe, rules: { ...goodMe.rules, v: 2 } },
      { ...goodMe, rules: { ...goodMe.rules, trustedPosters: ['nope'] } },
      { ...goodMe, rules: { ...goodMe.rules, maxBondXrd: 180 } },
      { ...goodMe, rules: { ...goodMe.rules, maxClaimsPerDay: 1.5 } },
      { ...goodMe, rules: { ...goodMe.rules, dryRun: 'yes' } },
      { ...goodMe, rules: undefined },
    ];
    for (const bad of bads) expect(() => parseAgentMe(bad)).toThrow(GuildApiError);
  });

  test('extra fields the server adds later are dropped, not rejected', () => {
    const parsed = parseAgentMe({ ...goodMe, somethingNew: 1, rules: { ...goodMe.rules, later: true } });
    expect((parsed as unknown as Record<string, unknown>).somethingNew).toBeUndefined();
    expect((parsed.rules as unknown as Record<string, unknown>).later).toBeUndefined();
  });
});
