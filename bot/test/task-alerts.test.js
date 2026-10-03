'use strict';
// #119 — opt-in Telegram DMs when a task is funded on-chain.
//
// Run: node --test bot/test/task-alerts.test.js
//
// Two layers:
//   1. db.js storage (throwaway db file, same harness as moderation-db.test.js);
//   2. escrow-watcher.js firing the broadcast from a bare TaskCreatedEvent
//      (Gateway stubbed via global.fetch, fake bot api — no network, no TG).
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const TMP = path.join(os.tmpdir(), 'guild-task-alerts-test-' + process.pid + '.db');
process.env.BOT_DB_PATH = TMP;
const db = require('../db');
const { pollEscrowEvents, _resetForTest } = require('../services/escrow-watcher');

// ── 1. Storage ─────────────────────────────────────────────────────────

describe('task alert opt-in (db)', () => {
  before(() => { db.init(); });
  after(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(TMP + suffix); } catch (_) {}
    }
  });

  it('defaults OFF for a new user and for an unknown tg_id', () => {
    db.registerUser(3001, 'account_rdx1aaa', 'a');
    assert.equal(db.isTaskAlertOptIn(3001), false);
    assert.equal(db.isTaskAlertOptIn(3999), false);
  });

  it('set / is round-trip', () => {
    db.setTaskAlertOptIn(3001, true);
    assert.equal(db.isTaskAlertOptIn(3001), true);
    db.setTaskAlertOptIn(3001, false);
    assert.equal(db.isTaskAlertOptIn(3001), false);
  });

  it('setTaskAlertOptIn does not create a row for an unregistered tg_id', () => {
    db.setTaskAlertOptIn(3998, true);
    assert.equal(db.getUser(3998), undefined);
    assert.equal(db.isTaskAlertOptIn(3998), false);
  });

  it('getTaskAlertOptInTgIds lists only opted-in, non-banned users', () => {
    db.registerUser(3101, 'account_rdx1bbb', 'b'); // opted in
    db.registerUser(3102, 'account_rdx1ccc', 'c'); // never opted in
    db.registerUser(3103, 'account_rdx1ddd', 'd'); // opted in, then banned
    db.setTaskAlertOptIn(3101, true);
    db.setTaskAlertOptIn(3103, true);
    db.banUser(3103, 'spam');
    const ids = db.getTaskAlertOptInTgIds();
    assert.ok(ids.includes(3101));
    assert.ok(!ids.includes(3102));
    assert.ok(!ids.includes(3103));
    db.unbanUser(3103);
    assert.ok(db.getTaskAlertOptInTgIds().includes(3103));
  });

  it('re-running /register keeps the opt-in and registered_at (no INSERT OR REPLACE reset)', () => {
    db.registerUser(3201, 'account_rdx1eee', 'e');
    db._raw().prepare('UPDATE users SET registered_at = 12345 WHERE tg_id = ?').run(3201);
    db.setTaskAlertOptIn(3201, true);
    db.registerUser(3201, 'account_rdx1fff', 'e2');
    const u = db.getUser(3201);
    assert.equal(u.radix_address, 'account_rdx1fff');
    assert.equal(u.username, 'e2');
    assert.equal(u.registered_at, 12345);
    assert.equal(db.isTaskAlertOptIn(3201), true);
  });
});

// ── 2. escrow-watcher fan-out ──────────────────────────────────────────

// Mirrors escrow-watcher.js's own fallback (see escrow-watcher-replay-guard.test.js).
const ESCROW_COMPONENT =
  process.env.ESCROW_COMPONENT || 'component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly';
const XRD = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';

function watcherDb() {
  // Real tables, and deliberately NO bounties row for the task below: tasks
  // posted on radixguild.com are never in this table (the production case).
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE watcher_state (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE bounties (id INTEGER PRIMARY KEY AUTOINCREMENT, creator_tg_id INTEGER,
      onchain_task_id INTEGER, escrow_component TEXT, funded INTEGER DEFAULT 0, escrow_verified INTEGER DEFAULT 0);
    CREATE TABLE bounty_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, bounty_id INTEGER, tx_type TEXT,
      amount_xrd REAL, tx_hash TEXT UNIQUE, description TEXT, verified_onchain INTEGER, onchain_task_id INTEGER, escrow_component TEXT);
  `);
  return raw;
}

function fakeApi() {
  const sent = [];
  return { sent, sendMessage: async (id, text) => { sent.push({ id, text }); } };
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

// One committed tx carrying one PULL TaskCreatedEvent for on-chain task #77.
function stubGateway() {
  global.fetch = async (url) => {
    if (url.endsWith('/status/gateway-status')) return jsonResponse({ ledger_state: { state_version: 105 } });
    if (url.endsWith('/stream/transactions')) {
      return jsonResponse({
        items: [{
          state_version: 101,
          transaction_status: 'CommittedSuccess',
          intent_hash: 'txid_rdx1taskalerts',
          receipt: {
            events: [{
              name: 'TaskCreatedEvent',
              emitter: { entity: { entity_address: ESCROW_COMPONENT } },
              data: { fields: [
                { field_name: 'task_id', value: '77' },
                { field_name: 'poster', value: 'account_rdx1' + 'p'.repeat(54) },
                { field_name: 'reward_token', value: XRD },
                { field_name: 'reward_amount', value: '250' },
                { field_name: 'insurance_amount', value: '0' },
                { field_name: 'arbiter_fee_pct', value: '5' },
                { field_name: 'work_brief_hash', value: 'ab'.repeat(32) },
              ] },
            }],
          },
        }],
      });
    }
    throw new Error('unexpected fetch ' + url);
  };
}

describe('task alert broadcast (escrow-watcher)', () => {
  let originalFetch;
  let originalFlag;
  beforeEach(() => {
    originalFetch = global.fetch;
    originalFlag = process.env.FEATURE_TASK_ALERTS;
    stubGateway();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalFlag === undefined) delete process.env.FEATURE_TASK_ALERTS;
    else process.env.FEATURE_TASK_ALERTS = originalFlag;
  });

  function setup(ids) {
    const api = fakeApi();
    const dbInstance = watcherDb();
    _resetForTest({
      dbInstance, botInstance: { api }, lastVersion: 100, lastTip: 90,
      dbMod: { getTaskAlertOptInTgIds: () => ids },
    });
    return { api, dbInstance };
  }

  it('flag off → no DM, even with subscribers', async () => {
    delete process.env.FEATURE_TASK_ALERTS;
    const { api } = setup([11, 12]);
    await pollEscrowEvents();
    assert.deepEqual(api.sent, []);
  });

  it('flag on + subscribers + NO linked bounties row → DMs every subscriber', async () => {
    process.env.FEATURE_TASK_ALERTS = 'true';
    const { api, dbInstance } = setup([11, 12]);
    await pollEscrowEvents();
    // The load-bearing precondition: nothing in bounties links to task #77.
    assert.equal(dbInstance.prepare('SELECT COUNT(*) c FROM bounties').get().c, 0);
    assert.deepEqual(api.sent.map((m) => m.id), [11, 12]);
    const text = api.sent[0].text;
    assert.match(text, /#77/);
    assert.match(text, /250 XRD/);
    assert.match(text, /https:\/\/radixguild\.com\/tasks(\s|$)/);
    assert.doesNotMatch(text, /\/tasks\/\S/, 'must never deep-link a task (on-chain id is not the web id)');
    assert.match(text, /\/taskalerts off/);
    // Cursor still advanced past the tx.
    const cur = dbInstance.prepare("SELECT value FROM watcher_state WHERE key = 'escrow_last_version'").get();
    assert.equal(cur.value, '101');
  });

  it('flag on + zero subscribers → sendMessage never called', async () => {
    process.env.FEATURE_TASK_ALERTS = 'true';
    const { api } = setup([]);
    await pollEscrowEvents();
    assert.deepEqual(api.sent, []);
  });

  it('a failing broadcast does not stop the cursor save', async () => {
    process.env.FEATURE_TASK_ALERTS = 'true';
    const dbInstance = watcherDb();
    _resetForTest({
      dbInstance, botInstance: { api: fakeApi() }, lastVersion: 100, lastTip: 90,
      dbMod: { getTaskAlertOptInTgIds: () => { throw new Error('db gone'); } },
    });
    await pollEscrowEvents();
    const cur = dbInstance.prepare("SELECT value FROM watcher_state WHERE key = 'escrow_last_version'").get();
    assert.equal(cur.value, '101');
  });
});
