'use strict';
// HTTP-level tests for the gate on GET /api/signer/status and GET /api/signer/audit
// (2026-09-29). Both were unauthenticated. Production's proxy never forwarded them,
// but a fork running the API unproxied served the signer's audit rows (params,
// error_message) to anyone. They now sit behind signerAuthorized(), the same
// XP_SIGNER_KEY Bearer check and fail-closed rule as the XP routes
// (xp-queue-auth.test.js asserts that function directly; this file asserts the
// routes actually call it).
//
// api.js reads XP_SIGNER_KEY once, at require time, and installs module-scope
// intervals, so each key configuration runs the real server in its own child
// process on a throwaway database, listening on port 0. The child seeds one audit
// row carrying a marker string; a 401 body must never contain it.
//
// Run: node --test bot/test/signer-routes-auth.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('node:child_process');

const BOT_DIR = path.join(__dirname, '..');
const KEY = 's3cret-key';
const MARKER = 'SIGNER-AUDIT-MARKER-7f3a';

// Seeds three audit rows (one carrying MARKER), wires the signer to the database,
// starts the API on an ephemeral port and prints that port as its only stdout line.
const SERVER_SCRIPT = [
  'const db = require(' + JSON.stringify(path.join(BOT_DIR, 'db.js')) + ');',
  'db.init();',
  'const txSigner = require(' + JSON.stringify(path.join(BOT_DIR, 'services', 'tx-signer.js')) + ');',
  'txSigner.init(db);',
  'const ins = db._raw().prepare("INSERT INTO signer_audit (action, params, status, error_message) VALUES (?, ?, ?, ?)");',
  'ins.run("RELEASE_TASK", "{}", "failed", ' + JSON.stringify(MARKER) + ');',
  'ins.run("RELEASE_TASK", "{}", "failed", "second");',
  'ins.run("RELEASE_TASK", "{}", "failed", "third");',
  'const { startApi } = require(' + JSON.stringify(path.join(BOT_DIR, 'services', 'api.js')) + ');',
  'const server = startApi();',
  'server.on("listening", () => process.stdout.write("PORT " + server.address().port + "\\n"));',
].join('\n');

// Starts the server with XP_SIGNER_KEY set to `key` (undefined = absent). The env is
// built from scratch so nothing on the developer's machine (a real key, a signing
// account, CORS settings) leaks into the run.
function startServer(key) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-signer-auth-'));
  const env = {
    PATH: process.env.PATH,
    BOT_DB_PATH: path.join(dir, 'guild.db'),
    API_HOST: '127.0.0.1',
    API_PORT: '0',
  };
  if (key !== undefined) env.XP_SIGNER_KEY = key;
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

async function get(port, pathname, authorization) {
  const headers = authorization === undefined ? {} : { authorization };
  const res = await fetch('http://127.0.0.1:' + port + pathname, { headers });
  return { status: res.status, text: await res.text() };
}

const ROUTES = ['/api/signer/status', '/api/signer/audit'];

describe('signer routes with no XP_SIGNER_KEY configured', () => {
  let server;
  let port;
  before(async () => { server = startServer(undefined); port = await server.port; });
  after(() => server.stop());

  for (const route of ROUTES) {
    it(route + ' fails closed: 401 even for a well-formed Bearer', async () => {
      const r = await get(port, route, 'Bearer anything');
      assert.equal(r.status, 401);
      assert.deepEqual(JSON.parse(r.text), { ok: false, error: 'unauthorized' });
    });

    it(route + ' fails closed: 401 without a header', async () => {
      assert.equal((await get(port, route)).status, 401);
    });
  }
});

describe('signer routes with XP_SIGNER_KEY configured', () => {
  let server;
  let port;
  before(async () => { server = startServer(KEY); port = await server.port; });
  after(() => server.stop());

  for (const route of ROUTES) {
    it(route + ': 401 without an Authorization header', async () => {
      const r = await get(port, route);
      assert.equal(r.status, 401);
      assert.ok(!r.text.includes(MARKER));
    });

    it(route + ': 401 with the wrong key', async () => {
      const r = await get(port, route, 'Bearer wrong-key');
      assert.equal(r.status, 401);
      assert.ok(!r.text.includes(MARKER));
    });

    it(route + ': 401 with the right key under the wrong scheme', async () => {
      assert.equal((await get(port, route, 'Basic ' + KEY)).status, 401);
    });
  }

  it('an unknown /api/signer/ path is 401 too, not a 404 that confirms the prefix', async () => {
    assert.equal((await get(port, '/api/signer/nope')).status, 401);
  });

  it('/api/signer/status: 200 with the right key', async () => {
    const r = await get(port, '/api/signer/status', 'Bearer ' + KEY);
    assert.equal(r.status, 200);
    const body = JSON.parse(r.text);
    assert.equal(body.ok, true);
    assert.equal(body.data.account, 'not set');
    assert.equal(body.data.total_tx, 0);
  });

  it('/api/signer/audit: 200 with the right key, rows included', async () => {
    const r = await get(port, '/api/signer/audit', 'Bearer ' + KEY);
    assert.equal(r.status, 200);
    const body = JSON.parse(r.text);
    assert.equal(body.ok, true);
    assert.equal(body.data.length, 3);
    assert.ok(r.text.includes(MARKER));
  });

  it('/api/signer/audit clamps a negative limit (SQLite reads LIMIT -1 as unlimited)', async () => {
    const r = await get(port, '/api/signer/audit?limit=-1', 'Bearer ' + KEY);
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).data.length, 1);
  });

  it('/api/signer/audit honours a limit inside 1..100', async () => {
    const r = await get(port, '/api/signer/audit?limit=2', 'Bearer ' + KEY);
    assert.equal(JSON.parse(r.text).data.length, 2);
  });

  // CV3 was removed 2026-09-29 (watcher, routes, schema); its routes must stay gone.
  it('the removed /api/cv3/* routes answer 404', async () => {
    for (const route of ['/api/cv3/status', '/api/cv3/stats', '/api/cv3/proposals', '/api/cv3/proposals/1']) {
      assert.equal((await get(port, route)).status, 404, route);
    }
  });

  // /api/stats is the unauthenticated, database-only route the cutover and
  // deploy-bot liveness probes move to now that /api/signer/status needs a key
  // (PR #814). Gating it would silently break those probes, so pin it open.
  it('/api/stats stays unauthenticated (the liveness probe route)', async () => {
    const r = await get(port, '/api/stats');
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).ok, true);
  });
});
