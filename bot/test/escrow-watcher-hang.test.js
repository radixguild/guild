'use strict';
// Tests for the escrow-watcher silent hang (diagnosed 2026-09-18).
//
// Run: node --test bot/test/escrow-watcher-hang.test.js
//
// The failure: the Gateway sent response HEADERS, then stalled the BODY. The
// abort timer had already been cleared, so `await resp.json()` never settled,
// pollEscrowEvents() never returned, the `running` lock was never released,
// and every later tick was a no-op. A hang is not a failed read, so nothing
// was logged and the alert policy was never told.
//
// These stub the Gateway via global.fetch with a body that only ever settles
// by honouring the AbortSignal — exactly what a real stalled body does.

// Must be set before the modules read them.
process.env.GATEWAY_TIMEOUT_MS = '40';
process.env.ESCROW_WATCHER_STREAM_TIMEOUT_MS = '40';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const alerts = require('../services/alerts');
const watcher = require('../services/escrow-watcher');
const { pollEscrowEvents, runPollTick, fetchLedgerTip, _resetForTest } = watcher;

// The watcher calls `alerts.observe(...)` through the module object, so
// recording here sees exactly what the alert policy would be told.
let originalFetch;
let originalObserve;
let observed;
beforeEach(() => {
  originalFetch = global.fetch;
  originalObserve = alerts.observe;
  observed = [];
  alerts.observe = async (input) => { observed.push(input); return 'none'; };
});
afterEach(() => {
  global.fetch = originalFetch;
  alerts.observe = originalObserve;
});

function freshDb() {
  const raw = new Database(':memory:');
  raw.exec('CREATE TABLE watcher_state (key TEXT PRIMARY KEY, value TEXT)');
  return raw;
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

// Headers arrive (the fetch promise resolves), the body never does — it only
// settles when the request's AbortSignal fires.
function stalledBodyResponse(signal) {
  const stalled = () => new Promise((_, reject) => {
    if (!signal) return; // no signal → hangs forever, which is the bug
    signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
  });
  return { ok: true, status: 200, json: stalled, text: stalled };
}

function withTimeout(promise, ms, label) {
  let t;
  const guard = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(label + ' hung')), ms); });
  return Promise.race([promise, guard]).finally(() => clearTimeout(t));
}

test('a stalled /stream/transactions body aborts instead of hanging, and is reported', async () => {
  _resetForTest({ dbInstance: freshDb(), botInstance: null, lastVersion: 100, lastTip: 90 });
  global.fetch = async (url, opts) => {
    if (url.endsWith('/status/gateway-status')) return jsonResponse({ ledger_state: { state_version: 105 } });
    return stalledBodyResponse(opts.signal);
  };

  await withTimeout(pollEscrowEvents(), 2000, 'pollEscrowEvents');

  const failures = observed.filter((o) => o.condition === true);
  assert.equal(failures.length, 1);
  assert.match(failures[0].detail, /fetch error/);
});

test('a stalled gateway-status body aborts instead of hanging', async () => {
  global.fetch = async (url, opts) => stalledBodyResponse(opts.signal);
  await assert.rejects(withTimeout(fetchLedgerTip(), 2000, 'fetchLedgerTip'));
});

test('a failed tip check is reported to the alert policy, not just logged', async () => {
  _resetForTest({ dbInstance: freshDb(), botInstance: null, lastVersion: 100, lastTip: 90 });
  global.fetch = async () => ({ ok: false, status: 502, json: async () => ({}), text: async () => 'bad gateway' });

  await pollEscrowEvents();

  const failures = observed.filter((o) => o.condition === true);
  assert.equal(failures.length, 1);
  assert.match(failures[0].detail, /tip check failed/);
});

test('runPollTick releases the lock at its deadline even if the poll never settles', async () => {
  _resetForTest({ dbInstance: freshDb(), botInstance: null, lastVersion: 100, lastTip: 90 });
  // Ignores the AbortSignal entirely: the worst case, a read nothing can bound.
  let calls = 0;
  global.fetch = () => { calls++; return new Promise(() => {}); };

  const first = await withTimeout(runPollTick({ deadlineMs: 30 }), 2000, 'runPollTick');
  assert.equal(first, 'deadline');
  assert.ok(observed.some((o) => o.condition === true && /did not finish/.test(o.detail)));

  // The lock is free again: the next tick actually polls rather than no-opping.
  const second = await withTimeout(runPollTick({ deadlineMs: 30 }), 2000, 'runPollTick');
  assert.equal(second, 'deadline');
  assert.equal(calls, 2);
});

test('runPollTick skips while a poll is still inside its deadline', async () => {
  _resetForTest({ dbInstance: freshDb(), botInstance: null, lastVersion: 100, lastTip: 90 });
  global.fetch = () => new Promise(() => {});

  const inFlight = runPollTick({ deadlineMs: 80 });
  assert.equal(await runPollTick({ deadlineMs: 80 }), 'skipped');
  assert.equal(await inFlight, 'deadline');
});

test('a poll abandoned at the deadline processes nothing further when it wakes up', async () => {
  const db = freshDb();
  _resetForTest({ dbInstance: db, botInstance: null, lastVersion: 100, lastTip: 90 });
  let releasePage;
  global.fetch = async (url) => {
    if (url.endsWith('/status/gateway-status')) return jsonResponse({ ledger_state: { state_version: 105 } });
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: () => new Promise((resolve) => {
        releasePage = () => resolve({ items: [{ transaction_status: 'CommittedSuccess', state_version: 103, receipt: { events: [] } }] });
      }),
    };
  };

  assert.equal(await runPollTick({ deadlineMs: 30 }), 'deadline');
  releasePage();
  await new Promise((r) => setTimeout(r, 20));

  const row = db.prepare("SELECT value FROM watcher_state WHERE key = 'escrow_last_version'").get();
  assert.equal(row, undefined, 'the abandoned poll must not advance the cursor');
});

// ── The actual root cause (found 2026-09-19, after the fix above deployed) ──
//
// The watcher sent `from_state_version`, which is not a Gateway field. The
// Gateway ignored it and returned the component's history from the start.
// Once that history passed 50 transactions every poll got the same full page
// of already-seen transactions and asked for it again, forever.

test('the page request sends from_ledger_state (inclusive, cursor + 1), never from_state_version', async () => {
  _resetForTest({ dbInstance: freshDb(), botInstance: null, lastVersion: 100, lastTip: 90 });
  const bodies = [];
  global.fetch = async (url, opts) => {
    if (url.endsWith('/status/gateway-status')) return jsonResponse({ ledger_state: { state_version: 105 } });
    bodies.push(JSON.parse(opts.body));
    return jsonResponse({ items: [] });
  };

  await pollEscrowEvents();

  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].from_ledger_state, { state_version: 101 });
  assert.equal('from_state_version' in bodies[0], false);
});

test('a Gateway that ignores the cursor cannot spin the poll forever', async () => {
  _resetForTest({ dbInstance: freshDb(), botInstance: null, lastVersion: 1000, lastTip: 990 });
  // Always the same full page of OLD history, whatever was asked for.
  const oldPage = Array.from({ length: 50 }, (_, i) => ({
    transaction_status: 'CommittedSuccess', state_version: 10 + i, receipt: { events: [] },
  }));
  let pageCalls = 0;
  global.fetch = async (url) => {
    if (url.endsWith('/status/gateway-status')) return jsonResponse({ ledger_state: { state_version: 1005 } });
    pageCalls++;
    return jsonResponse({ items: oldPage });
  };

  await withTimeout(pollEscrowEvents(), 2000, 'pollEscrowEvents');

  assert.equal(pageCalls, 1);
  assert.ok(observed.some((o) => o.condition === true && /did not advance/.test(o.detail)));
});

test('full pages that DO advance are followed to the end', async () => {
  const db = freshDb();
  _resetForTest({ dbInstance: db, botInstance: null, lastVersion: 100, lastTip: 90 });
  const page = (from, n) => Array.from({ length: n }, (_, i) => ({
    transaction_status: 'CommittedSuccess', state_version: from + i, receipt: { events: [] },
  }));
  const asked = [];
  global.fetch = async (url, opts) => {
    if (url.endsWith('/status/gateway-status')) return jsonResponse({ ledger_state: { state_version: 500 } });
    const from = JSON.parse(opts.body).from_ledger_state.state_version;
    asked.push(from);
    return jsonResponse({ items: from === 101 ? page(101, 50) : page(151, 7) });
  };

  await pollEscrowEvents();

  assert.deepEqual(asked, [101, 151]);
  const row = db.prepare("SELECT value FROM watcher_state WHERE key = 'escrow_last_version'").get();
  assert.equal(row.value, '157');
});

test('verifyEscrowTx: a stalled response body fails closed instead of hanging', async () => {
  const { verifyEscrowTx } = require('../services/gateway');
  const fetcher = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) });
  const res = await withTimeout(verifyEscrowTx('txid_stalled', { fetcher }), 2000, 'verifyEscrowTx');
  assert.equal(res.verified, false);
  assert.equal(res.reason, 'error');
});
