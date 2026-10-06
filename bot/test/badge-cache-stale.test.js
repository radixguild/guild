'use strict';
// getBadgeResult serves a cached read in place of a failed one only while that read is
// younger than BADGE_CACHE_STALE_MAX_MS (default 10 × the 30 s TTL = 300 000 ms). Until
// 2026-10-06 it served one of any age, so a Gateway that stayed down kept passing a badge
// that had long since moved or been burned.
//
// The Gateway is faked at global.fetch (the uncached read's only way out) and the clock at
// Date.now. Every case uses its own address: the cache is module-level.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const GATEWAY_PATH = path.join(__dirname, '..', 'services', 'gateway.js');
for (const k of ['BADGE_CACHE_TTL_MS', 'BADGE_CACHE_STALE_MAX_MS', 'BADGE_NFT', 'RADIX_GATEWAY']) delete process.env[k];
const gateway = require(GATEWAY_PATH);

// The fake, as source, so the child-process cases below run the very same one.
const FAKE_SRC = `
const BADGE_NFT = "resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl";
function fakeGateway(gw) {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  return async (url) => {
    gw.calls++;
    if (gw.mode === "down") throw new Error("connect ECONNREFUSED");
    if (url.endsWith("/state/entity/details")) {
      return ok({ items: [{ non_fungible_resources: { items: gw.mode === "none" ? [] :
        [{ resource_address: BADGE_NFT, vaults: { items: [{ items: ["<member_1>"] }] } }] } }] });
    }
    if (url.endsWith("/state/non-fungible/data")) {
      const fields = ["member_1", "guild_member", "", "member", "active", "", "0", "1"].map((value) => ({ value }));
      return ok({ non_fungible_ids: [{ data: { programmatic_json: { fields } } }] });
    }
    throw new Error("unexpected Gateway call: " + url);
  };
}`;
// eslint-disable-next-line no-new-func
const fakeGateway = new Function(FAKE_SRC + '\nreturn fakeGateway;')();

const T0 = 1_800_000_000_000;
let now = T0;
const gw = { mode: 'badge', calls: 0 };
const realNow = Date.now;
const realFetch = global.fetch;
beforeEach(() => {
  now = T0;
  gw.mode = 'badge';
  gw.calls = 0;
  Date.now = () => now;
  global.fetch = fakeGateway(gw);
});
afterEach(() => {
  Date.now = realNow;
  global.fetch = realFetch;
});

const addr = (tag) => 'account_rdx1' + tag.padEnd(54, 'q');

test('a stale read younger than the cap stands in for a failed one', async () => {
  const a = addr('young');
  const first = await gateway.getBadgeResult(a);
  assert.equal(first.data.status, 'active');

  gw.mode = 'down';
  for (const age of [30_001, 120_000, 299_999]) {
    now = T0 + age;
    const calls = gw.calls;
    assert.deepEqual(await gateway.getBadgeResult(a), first, 'age ' + age);
    assert.ok(gw.calls > calls, 'past the TTL the Gateway is asked first (age ' + age + ')');
  }
});

test('a read at or past the cap is an error, not a badge', async () => {
  const a = addr('old');
  assert.equal((await gateway.getBadgeResult(a)).data.status, 'active');

  gw.mode = 'down';
  for (const age of [300_000, 300_001, 6 * 3_600_000]) {
    now = T0 + age;
    assert.deepEqual(await gateway.getBadgeResult(a), { error: true }, 'age ' + age);
  }
});

test('a cached "no badge" is capped the same way', async () => {
  const a = addr('none');
  gw.mode = 'none';
  assert.deepEqual(await gateway.getBadgeResult(a), { data: null });
  gw.mode = 'down';
  now = T0 + 60_000;
  assert.deepEqual(await gateway.getBadgeResult(a), { data: null });
  now = T0 + 300_000;
  assert.deepEqual(await gateway.getBadgeResult(a), { error: true });
});

test('once the Gateway answers again the entry is fresh, so the cap counts from then', async () => {
  const a = addr('back');
  await gateway.getBadgeResult(a);
  gw.mode = 'down';
  now = T0 + 400_000;
  assert.deepEqual(await gateway.getBadgeResult(a), { error: true });

  gw.mode = 'badge';
  assert.equal((await gateway.getBadgeResult(a)).data.status, 'active');
  gw.mode = 'down';
  now = T0 + 400_000 + 200_000;
  assert.equal((await gateway.getBadgeResult(a)).data.status, 'active');
});

test('a Gateway error with nothing cached is an error', async () => {
  gw.mode = 'down';
  assert.deepEqual(await gateway.getBadgeResult(addr('never')), { error: true });
});

// BADGE_CACHE_STALE_MAX_MS is read once, at require time, so each setting gets its own process.
function staleVerdictsWith(env, ages) {
  const script = FAKE_SRC + `
const gw = { mode: "badge", calls: 0 };
global.fetch = fakeGateway(gw);
let now = ${T0};
Date.now = () => now;
const g = require(${JSON.stringify(GATEWAY_PATH)});
(async () => {
  const out = [];
  for (const [i, age] of ${JSON.stringify(ages)}.entries()) {
    const a = "account_rdx1" + String(i).padEnd(54, "q");
    gw.mode = "badge"; now = ${T0};
    await g.getBadgeResult(a);
    gw.mode = "down"; now = ${T0} + age;
    const r = await g.getBadgeResult(a);
    out.push(r.error ? "error" : "stale");
  }
  process.stdout.write(JSON.stringify(out));
})();`;
  const childEnv = { PATH: process.env.PATH, ...env };
  const out = execFileSync(process.execPath, ['-e', script], { env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out.trim().split('\n').pop());
}

test('BADGE_CACHE_STALE_MAX_MS sets the cap; 0 turns stale serving off', () => {
  assert.deepEqual(staleVerdictsWith({ BADGE_CACHE_STALE_MAX_MS: '60000' }, [31_000, 59_999, 60_000]), ['stale', 'stale', 'error']);
  assert.deepEqual(staleVerdictsWith({ BADGE_CACHE_STALE_MAX_MS: '0' }, [30_001]), ['error']);
  // The default follows the TTL: 10 × a 5 s TTL is 50 s.
  assert.deepEqual(staleVerdictsWith({ BADGE_CACHE_TTL_MS: '5000' }, [49_999, 50_000]), ['stale', 'error']);
});
