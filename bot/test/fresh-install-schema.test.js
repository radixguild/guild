'use strict';
// bot/db.js — a fresh-install schema-ordering regression.
//
// Two ALTER TABLE ... ADD COLUMN calls previously ran BEFORE their own
// table's CREATE TABLE IF NOT EXISTS (wg_reports.status/period_type and
// feedback.radix_address). On a genuinely fresh database the ALTER threw
// "no such table" (silently swallowed by the bare `catch(e) {}`), then the
// CREATE TABLE IF NOT EXISTS that ran right after created the table WITHOUT
// that column — the table only got it on the bot's *next* restart, once it
// already existed for the ALTER to attach to.
//
// feedback.radix_address is live-reachable: bot/index.js's /feedback
// command calls db.createFeedback() with no local try/catch, so on a fresh
// install the very first /feedback submission threw "table feedback has no
// column named radix_address", was swallowed by the bot's global
// bot.catch(), and the user's ticket was silently lost (only a generic
// "Something went wrong" reply, one console line for the operator).
//
// This test builds a genuinely fresh DB via the real db.init() path (same
// harness as moderation-db.test.js / task-alerts.test.js) and proves both
// columns exist and the handler's query (db.createFeedback) works.
//
// Run: node --test bot/test/fresh-install-schema.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const TMP = path.join(os.tmpdir(), 'guild-fresh-schema-test-' + process.pid + '.db');
process.env.BOT_DB_PATH = TMP;
const db = require('../db');

function columns(table) {
  // A second, read-only connection to the same file db.init() just built —
  // WAL mode (set by init()) allows this concurrently.
  const raw = new Database(TMP, { readonly: true });
  try {
    return raw.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
  } finally {
    raw.close();
  }
}

describe('fresh install: schema column ordering (db.js)', () => {
  before(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(TMP + suffix); } catch (_) {}
    }
    db.init();
  });
  after(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(TMP + suffix); } catch (_) {}
    }
  });

  it('feedback table has radix_address on a genuinely fresh DB', () => {
    const cols = columns('feedback');
    assert.ok(cols.includes('radix_address'), `feedback columns: ${cols.join(', ')}`);
  });

  it('wg_reports table has status and period_type on a genuinely fresh DB', () => {
    const cols = columns('wg_reports');
    assert.ok(cols.includes('status'), `wg_reports columns: ${cols.join(', ')}`);
    assert.ok(cols.includes('period_type'), `wg_reports columns: ${cols.join(', ')}`);
  });

  it('db.createFeedback (the live /feedback handler query) succeeds on a fresh DB', () => {
    // Mirrors bot/index.js's /feedback command: db.createFeedback(ctx.from.id, username, message)
    // — called with no local try/catch, so on the broken ordering this threw
    // "table feedback has no column named radix_address" straight into the
    // bot's global bot.catch(), silently losing the user's first ticket.
    const id = db.createFeedback(999, 'tester', 'it broke', 'general', null);
    assert.equal(typeof id, 'number');
    const rows = db.getFeedbackByUser(999);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].message, 'it broke');
  });
});
