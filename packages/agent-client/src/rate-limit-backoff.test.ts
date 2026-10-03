// Coverage for the 429 backoff.
//
// Why it exists: task creation is limited to 5 per 60s per user
// (guild-app/src/app/api/v1/tasks/route.ts). The internal wave of 2026-07-24
// tripped it mid-batch at task 6 and only got through because the operator
// resumed `--only 6..10` into a fresh window. The 8s inter-task pace added
// afterwards does NOT actually satisfy the limit — 8s spacing is 7.5 requests
// per 60s window against a cap of 5 — so at campaign volume a fixed sleep keeps
// losing. Backing off on the server's own Retry-After is self-tuning.
//
// The safety argument this rests on: every limiter in the API runs as the FIRST
// statement of its handler, before the body is parsed, so a 429 means the
// request had no side effect and re-sending it cannot double-apply.

import { describe, test, expect } from 'bun:test';
import { GuildApiClient, GuildApiError, rateLimitWaitMs } from './api.js';

const envelope = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const tooMany = (retryAfter?: string) =>
  new Response(JSON.stringify({ ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      ...(retryAfter === undefined ? {} : { 'retry-after': retryAfter }),
    },
  });

/** A client whose fetch replays a fixed script, recording every sleep instead of taking it. */
function clientWith(responses: Response[], options: { maxRateLimitRetries?: number } = {}) {
  const slept: number[] = [];
  let calls = 0;
  const api = new GuildApiClient(
    {},
    {
      ...options,
      fetchFn: (async () => {
        const next = responses[calls++];
        if (!next) throw new Error(`unscripted fetch #${calls}`);
        return next;
      }) as unknown as typeof fetch,
      sleepFn: async (ms: number) => {
        slept.push(ms);
      },
    }
  );
  return { api, slept, calls: () => calls };
}

describe('rateLimitWaitMs', () => {
  test("prefers the server's Retry-After (seconds -> ms)", () => {
    expect(rateLimitWaitMs(tooMany('12'), 1)).toBe(12_000);
    expect(rateLimitWaitMs(tooMany('45'), 3)).toBe(45_000);
  });

  test('falls back to exponential backoff when the header is absent', () => {
    expect(rateLimitWaitMs(tooMany(), 1)).toBe(2000);
    expect(rateLimitWaitMs(tooMany(), 2)).toBe(4000);
    expect(rateLimitWaitMs(tooMany(), 3)).toBe(8000);
  });

  test('falls back when the header is unparseable rather than waiting NaN', () => {
    expect(rateLimitWaitMs(tooMany('soon'), 1)).toBe(2000);
    expect(rateLimitWaitMs(tooMany(''), 2)).toBe(4000);
  });

  // A bogus or hostile Retry-After must not park an unattended worker for an
  // hour, and a 0 must not spin it into a hot retry loop.
  test('clamps absurd waits at both ends', () => {
    expect(rateLimitWaitMs(tooMany('86400'), 1)).toBe(90_000);
    expect(rateLimitWaitMs(tooMany('0'), 1)).toBe(1000);
    expect(rateLimitWaitMs(tooMany('-5'), 1)).toBe(2000); // negative -> not a valid wait
  });
});

describe('429 backoff', () => {
  test('waits out a rate limit and returns the eventual success', async () => {
    const { api, slept, calls } = clientWith([tooMany('7'), envelope({ id: 42 })]);
    expect(await api.getTask(42)).toEqual({ id: 42 } as never);
    expect(slept).toEqual([7000]);
    expect(calls()).toBe(2);
  });

  test('rides out several consecutive limits, honouring each Retry-After', async () => {
    const { api, slept } = clientWith([
      tooMany('3'),
      tooMany('5'),
      tooMany('2'),
      envelope({ id: 7 }),
    ]);
    expect(await api.getTask(7)).toEqual({ id: 7 } as never);
    expect(slept).toEqual([3000, 5000, 2000]);
  });

  // Terminates rather than looping forever against a wedged limiter: 4 retries
  // by default = 5 attempts total, then the 429 surfaces as a real error.
  test('gives up after maxRateLimitRetries and surfaces the 429', async () => {
    const { api, slept, calls } = clientWith(Array.from({ length: 6 }, () => tooMany('1')));
    const err = await api.getTask(1).then(
      () => null,
      (e: unknown) => e as GuildApiError
    );
    expect(err).toBeInstanceOf(GuildApiError);
    expect(err?.status).toBe(429);
    expect(err?.code).toBe('RATE_LIMITED');
    // 4 retries = 5 attempts, 4 sleeps — and it stops, rather than looping on a
    // limiter that never clears.
    expect(slept.length).toBe(4);
    expect(calls()).toBe(5);
  });

  test('maxRateLimitRetries: 0 disables the backoff entirely', async () => {
    const { api, slept, calls } = clientWith([tooMany('1'), envelope({ id: 1 })], {
      maxRateLimitRetries: 0,
    });
    expect(api.getTask(1)).rejects.toThrow(GuildApiError);
    expect(slept).toEqual([]);
    expect(calls()).toBe(1);
  });

  test('does not retry, or sleep, on a non-429 error', async () => {
    const { api, slept, calls } = clientWith([
      new Response(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'nope' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    expect(api.getTask(999)).rejects.toThrow('NOT_FOUND');
    expect(slept).toEqual([]);
    expect(calls()).toBe(1);
  });

  test('a clean response never sleeps', async () => {
    const { api, slept, calls } = clientWith([envelope({ id: 5 })]);
    await api.getTask(5);
    expect(slept).toEqual([]);
    expect(calls()).toBe(1);
  });
});
