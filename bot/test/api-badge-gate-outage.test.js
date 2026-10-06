'use strict';
// HTTP-level tests for the badge gate on api.js's unproven-address routes (2026-10-06).
// They called hasBadge(body.address), which reads a Gateway outage as "no badge", so an
// outage answered 403 badge_required. They now ask getBadgeResult through badgeRefusal:
// an outage is 503 badge_check_unavailable, a real "no badge" is still 403. The two
// GET /api/badge/:address reads answer an outage with their gateway_error instead of
// "no badge" too.
//
// Like signer-routes-auth.test.js: the real server runs in a child process on a throwaway
// database, listening on port 0 (api.js installs module-scope intervals). The child fakes
// the Gateway at global.fetch — FAKE_GATEWAY=down|none — so nothing leaves the machine.
// POST /api/bounties/:id/milestones is not exercised: the GET handler above it matches
// the same path with no method check, so a POST there never reaches the create route.
//
// Run: node --test bot/test/api-badge-gate-outage.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('node:child_process');

const BOT_DIR = path.join(__dirname, '..');

const SERVER_SCRIPT = [
  'global.fetch = async (url) => {',
  '  if (process.env.FAKE_GATEWAY === "down") throw new Error("connect ECONNREFUSED");',
  '  const BADGE = "resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl";',
  '  if (String(url).endsWith("/state/entity/details")) {',
  '    const items = process.env.FAKE_GATEWAY === "badge" ? [{ resource_address: BADGE, vaults: { items: [{ items: ["<member_1>"] }] } }] : [];',
  '    const body = { items: [{ non_fungible_resources: { items } }] };',
  '    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };',
  '  }',
  '  if (String(url).endsWith("/state/non-fungible/data")) {',
  '    const fields = ["member_1", "guild_member", "", "member", "active", "", "0", "1"].map((value) => ({ value }));',
  '    const body = { non_fungible_ids: [{ data: { programmatic_json: { fields } } }] };',
  '    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };',
  '  }',
  '  throw new Error("unexpected Gateway call: " + url);',
  '};',
  'const db = require(' + JSON.stringify(path.join(BOT_DIR, 'db.js')) + ');',
  'db.init();',
  'const { startApi } = require(' + JSON.stringify(path.join(BOT_DIR, 'services', 'api.js')) + ');',
  'const server = startApi();',
  'server.on("listening", () => process.stdout.write("PORT " + server.address().port + "\\n"));',
].join('\n');

function startServer(fakeGateway) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-badge-gate-'));
  const env = {
    PATH: process.env.PATH,
    BOT_DB_PATH: path.join(dir, 'guild.db'),
    API_HOST: '127.0.0.1',
    API_PORT: '0',
    FEATURE_ESCROW: 'true', // the bounty and dispute routes answer 503 service_unavailable without it
    FAKE_GATEWAY: fakeGateway,
  };
  const child = spawn(process.execPath, ['-e', SERVER_SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const port = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/^PORT (\d+)$/m);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', (code) => reject(new Error('server exited (' + code + ') before listening: ' + stderr)));
  });
  return {
    port,
    stop() {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function call(port, method, pathname, body) {
  const res = await fetch('http://127.0.0.1:' + port + pathname, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

const ADDR = 'account_rdx1' + 'q'.repeat(54);
const GATED = [
  ['POST /api/proposals', 'POST', '/api/proposals', { title: 'Adopt the logo', address: ADDR }],
  ['POST /api/bounties', 'POST', '/api/bounties', { title: 'Write the FAQ', reward_xrd: 50, address: ADDR }],
  ['POST /api/proposals/:id/vote', 'POST', '/api/proposals/1/vote', { address: ADDR, vote: 'for' }],
  ['POST /api/disputes/:id/evidence', 'POST', '/api/disputes/1/evidence', { address: ADDR, content: 'a link' }],
];

describe('Gateway down', () => {
  let server;
  let port;
  before(async () => { server = startServer('down'); port = await server.port; });
  after(() => server && server.stop());

  for (const [name, method, pathname, body] of GATED) {
    it(name + ' answers 503 badge_check_unavailable, not 403 badge_required', async () => {
      const r = await call(port, method, pathname, body);
      assert.equal(r.status, 503, JSON.stringify(r.json));
      assert.deepEqual(r.json, { ok: false, error: 'badge_check_unavailable' });
    });
  }

  it('GET /api/badge/:address answers gateway_error, not 404 no_badge', async () => {
    const r = await call(port, 'GET', '/api/badge/' + ADDR);
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, { ok: false, error: 'gateway_error' });
  });

  it('GET /api/badge/:address/verify answers gateway_error, not hasBadge: false', async () => {
    const r = await call(port, 'GET', '/api/badge/' + ADDR + '/verify');
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, { ok: false, error: 'gateway_error' });
  });
});

describe('Gateway up, the address holds an active badge (control)', () => {
  let server;
  let port;
  before(async () => { server = startServer('badge'); port = await server.port; });
  after(() => server && server.stop());

  for (const [name, method, pathname, body] of GATED) {
    it(name + ' passes the badge gate', async () => {
      const r = await call(port, method, pathname, body);
      assert.notEqual(r.status, 503, JSON.stringify(r.json));
      assert.ok(!['badge_required', 'badge_check_unavailable'].includes(r.json && r.json.error), JSON.stringify(r.json));
    });
  }
});

describe('Gateway up, the address holds no badge (control)', () => {
  let server;
  let port;
  before(async () => { server = startServer('none'); port = await server.port; });
  after(() => server && server.stop());

  for (const [name, method, pathname, body] of GATED) {
    it(name + ' still answers 403 badge_required', async () => {
      const r = await call(port, method, pathname, body);
      assert.equal(r.status, 403, JSON.stringify(r.json));
      assert.deepEqual(r.json, { ok: false, error: 'badge_required' });
    });
  }

  it('GET /api/badge/:address still answers 404 no_badge, and /verify hasBadge: false', async () => {
    const r = await call(port, 'GET', '/api/badge/' + ADDR);
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'no_badge');
    const v = await call(port, 'GET', '/api/badge/' + ADDR + '/verify');
    assert.equal(v.status, 200);
    assert.deepEqual(v.json, { ok: true, hasBadge: false, address: ADDR });
  });
});

describe('api.js source', () => {
  const src = fs.readFileSync(path.join(BOT_DIR, 'services', 'api.js'), 'utf8');
  it('no route calls hasBadge or getBadgeData', () => {
    assert.doesNotMatch(src, /\bhasBadge\(|\bgetBadgeData\(/);
  });
  it('the milestone create route uses the same gate', () => {
    const i = src.indexOf('// POST /api/bounties/:id/milestones');
    assert.ok(i >= 0);
    assert.match(src.slice(i, i + 900), /await badgeRefusal\(body\.address\)/);
  });
  it('the route group says its addresses are unproven and must stay off the edge', () => {
    assert.match(src, /UNPROVEN-ADDRESS ROUTES[\s\S]{0,600}must stay off the edge/);
  });
});
