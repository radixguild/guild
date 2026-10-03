'use strict';
// Tests for the escrow-watcher replay guard (added 2026-09-05).
//
// Run: node --test bot/test/escrow-watcher-replay-guard.test.js
//
// Covers the failure this closes: a restart with a stale poll cursor (long
// outage, or a chain halt that froze the ledger tip) replaying the entire
// backlog and mass-DMing every user in it. These tests stub the Gateway via
// global.fetch and use a real in-memory better-sqlite3 db (no network, no
// real Telegram bot).

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const watcher = require('../services/escrow-watcher');
const { shouldGuardReplay, countBacklogEvents, fetchLedgerTip, pollEscrowEvents, _resetForTest } = watcher;

// Mirrors escrow-watcher.js's own fallback so fixtures built here match what
// the module resolves internally when ESCROW_COMPONENT is unset (Wave B
// cutover 2026-09-13; the prior default, …akd82f, is retired).
const ESCROW_COMPONENT =
  process.env.ESCROW_COMPONENT || 'component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly';

let originalFetch;
beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

function freshDb() {
  const raw = new Database(':memory:');
  raw.exec('CREATE TABLE watcher_state (key TEXT PRIMARY KEY, value TEXT)');
  return raw;
}

function fakeBot() {
  const calls = [];
  return {
    _calls: calls,
    api: {
      sendMessage: async (id, text) => {
        calls.push({ id, text });
      },
    },
  };
}

function jsonResponse(body, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) };
}

// ── shouldGuardReplay (pure decision logic) ────────────────────────────

test('shouldGuardReplay: no lag → never guards', () => {
  const d = shouldGuardReplay({ tip: 100, lastVersion: 100, lastTip: 0, maxReplay: 100000 });
  assert.equal(d.guard, false);
  assert.equal(d.lag, 0);
});

test('shouldGuardReplay: small lag under threshold, tip has moved → no guard', () => {
  const d = shouldGuardReplay({ tip: 105, lastVersion: 100, lastTip: 90, maxReplay: 100000 });
  assert.equal(d.guard, false);
  assert.equal(d.lag, 5);
  assert.equal(d.halted, false);
});

test('shouldGuardReplay: lag exceeds maxReplay → guard trips', () => {
  const d = shouldGuardReplay({ tip: 200000, lastVersion: 1, lastTip: 0, maxReplay: 100000 });
  assert.equal(d.guard, true);
  assert.equal(d.lag, 199999);
  assert.equal(d.halted, false);
});

test('shouldGuardReplay: tip unchanged since last check (halt) → guard trips even with tiny lag', () => {
  const d = shouldGuardReplay({ tip: 105, lastVersion: 100, lastTip: 105, maxReplay: 100000 });
  assert.equal(d.guard, true);
  assert.equal(d.halted, true);
  assert.equal(d.lag, 5);
});

test('shouldGuardReplay: invalid/zero tip → no guard (caller should skip the poll instead)', () => {
  assert.equal(shouldGuardReplay({ tip: 0, lastVersion: 5, lastTip: 0, maxReplay: 100000 }).guard, false);
  assert.equal(shouldGuardReplay({ tip: NaN, lastVersion: 5, lastTip: 0, maxReplay: 100000 }).guard, false);
});

// ── fetchLedgerTip ──────────────────────────────────────────────────────

test('fetchLedgerTip: returns the numeric state_version', async () => {
  global.fetch = async () => jsonResponse({ ledger_state: { state_version: 557840622 } });
  const tip = await fetchLedgerTip();
  assert.equal(tip, 557840622);
});

test('fetchLedgerTip: throws on non-ok HTTP status', async () => {
  global.fetch = async () => jsonResponse({}, false);
  await assert.rejects(() => fetchLedgerTip());
});

test('fetchLedgerTip: throws when state_version is missing', async () => {
  global.fetch = async () => jsonResponse({ ledger_state: {} });
  await assert.rejects(() => fetchLedgerTip());
});

// ── countBacklogEvents ──────────────────────────────────────────────────

test('countBacklogEvents: counts only watched-component events inside the range', async () => {
  global.fetch = async () =>
    jsonResponse({
      items: [
        {
          transaction_status: 'CommittedSuccess',
          state_version: 11,
          receipt: { events: [{ name: 'TaskCreatedEvent', emitter: { entity: { entity_address: ESCROW_COMPONENT } } }] },
        },
        {
          // Wrong emitter — must not count.
          transaction_status: 'CommittedSuccess',
          state_version: 12,
          receipt: { events: [{ name: 'TaskCreatedEvent', emitter: { entity: { entity_address: 'component_unrelated' } } }] },
        },
        {
          // Failed tx — must not count.
          transaction_status: 'CommittedFailure',
          state_version: 13,
          receipt: { events: [{ name: 'TaskClaimedEvent', emitter: { entity: { entity_address: ESCROW_COMPONENT } } }] },
        },
      ],
    });

  const { count, truncated } = await countBacklogEvents(10, 20);
  assert.equal(count, 1);
  assert.equal(truncated, false);
});

test('countBacklogEvents: an unbounded backlog is reported as truncated, never counted forever', async () => {
  let page = 0;
  global.fetch = async () => {
    const base = page * 50;
    page++;
    const items = Array.from({ length: 50 }, (_, i) => ({
      transaction_status: 'CommittedSuccess',
      state_version: base + i + 1,
      receipt: { events: [{ name: 'TaskCreatedEvent', emitter: { entity: { entity_address: ESCROW_COMPONENT } } }] },
    }));
    return jsonResponse({ items });
  };

  const { count, truncated } = await countBacklogEvents(0, Number.MAX_SAFE_INTEGER);
  assert.equal(truncated, true, 'an infinite backlog must trip the page cap, not run forever');
  assert.ok(count > 0);
});

// ── pollEscrowEvents: end-to-end guard behaviour ────────────────────────

test('pollEscrowEvents: small ordinary lag does NOT guard — no operator alert, no forced cursor jump', async () => {
  const db = freshDb();
  const bot = fakeBot();
  let alerted = 0;

  global.fetch = async (url) => {
    if (String(url).includes('/status/gateway-status')) {
      return jsonResponse({ ledger_state: { state_version: 105 } });
    }
    // /stream/transactions — nothing new for the watched component.
    return jsonResponse({ items: [] });
  };

  _resetForTest({
    dbInstance: db,
    botInstance: bot,
    lastVersion: 100,
    lastTip: 90,
    adminNotifier: async () => { alerted++; },
  });

  await pollEscrowEvents();

  assert.equal(alerted, 0, 'ordinary catch-up must not alert the operator');
  assert.equal(bot._calls.length, 0);
  const cursorRow = db.prepare("SELECT value FROM watcher_state WHERE key = 'escrow_last_version'").get();
  // No matching tx were found in range, so the cursor is untouched by the
  // (non-guarded) poll loop itself — it was never fast-forwarded past 100.
  assert.equal(cursorRow, undefined);
});

test('pollEscrowEvents: large lag trips the guard — skips DMs, alerts operator once, fast-forwards cursor', async () => {
  const db = freshDb();
  const bot = fakeBot();
  const alerts = [];
  let streamCalls = 0;

  global.fetch = async (url) => {
    if (String(url).includes('/status/gateway-status')) {
      return jsonResponse({ ledger_state: { state_version: 200000 } });
    }
    // Backlog-count fetch: one matching event on the first page, then a
    // short (< 50 item) page so pagination stops.
    streamCalls++;
    if (streamCalls > 1) return jsonResponse({ items: [] });
    return jsonResponse({
      items: [
        {
          transaction_status: 'CommittedSuccess',
          state_version: 150000,
          receipt: { events: [{ name: 'TaskReleasedEvent', emitter: { entity: { entity_address: ESCROW_COMPONENT } } }] },
        },
      ],
    });
  };

  _resetForTest({
    dbInstance: db,
    botInstance: bot,
    lastVersion: 1,
    lastTip: 0,
    adminNotifier: async (msg) => { alerts.push(msg); },
  });

  await pollEscrowEvents();

  assert.equal(alerts.length, 1, 'exactly one operator alert per guard trip');
  assert.match(alerts[0], /skipped 1 /i);
  assert.equal(bot._calls.length, 0, 'no per-user DMs during a guarded replay');

  const cursorRow = db.prepare("SELECT value FROM watcher_state WHERE key = 'escrow_last_version'").get();
  assert.equal(Number(cursorRow.value), 200000, 'cursor must fast-forward straight to the tip');
});

test('pollEscrowEvents: halted chain (tip unchanged since last poll) trips the guard even with a small lag', async () => {
  const db = freshDb();
  const bot = fakeBot();
  const alerts = [];

  global.fetch = async (url) => {
    if (String(url).includes('/status/gateway-status')) {
      // Same tip we last recorded — the chain has not advanced (halt).
      return jsonResponse({ ledger_state: { state_version: 557840622 } });
    }
    return jsonResponse({ items: [] });
  };

  _resetForTest({
    dbInstance: db,
    botInstance: bot,
    lastVersion: 557840600, // small, ordinary-looking lag
    lastTip: 557840622, // but we already saw this exact tip before
    adminNotifier: async (msg) => { alerts.push(msg); },
  });

  await pollEscrowEvents();

  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /halt/i);
  assert.equal(bot._calls.length, 0);

  const cursorRow = db.prepare("SELECT value FROM watcher_state WHERE key = 'escrow_last_version'").get();
  assert.equal(Number(cursorRow.value), 557840622);
});

test('pollEscrowEvents: guard trip is silent (never throws) when the operator notifier itself fails', async () => {
  const db = freshDb();
  const bot = fakeBot();

  global.fetch = async (url) => {
    if (String(url).includes('/status/gateway-status')) {
      return jsonResponse({ ledger_state: { state_version: 999999 } });
    }
    return jsonResponse({ items: [] });
  };

  _resetForTest({
    dbInstance: db,
    botInstance: bot,
    lastVersion: 1,
    lastTip: 0,
    adminNotifier: async () => { throw new Error('TG down'); },
  });

  await assert.doesNotReject(() => pollEscrowEvents());
});

test('pollEscrowEvents: no notifier configured at all → guard still applies, just logs (never throws)', async () => {
  const db = freshDb();
  const bot = fakeBot();

  global.fetch = async (url) => {
    if (String(url).includes('/status/gateway-status')) {
      return jsonResponse({ ledger_state: { state_version: 999999 } });
    }
    return jsonResponse({ items: [] });
  };

  _resetForTest({ dbInstance: db, botInstance: bot, lastVersion: 1, lastTip: 0, adminNotifier: null });

  await assert.doesNotReject(() => pollEscrowEvents());
  const cursorRow = db.prepare("SELECT value FROM watcher_state WHERE key = 'escrow_last_version'").get();
  assert.equal(Number(cursorRow.value), 999999);
});
