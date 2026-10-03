'use strict';
// Tests for dispute.getOtherPartyTgId() — the lookup that backs the
// /dispute evidence honest-notification fix (2026-09-05). Previously
// bot/index.js replied "Other party notified." unconditionally while
// nothing in services/dispute.js ever sent that DM; the fix makes the
// reply true when a DM is actually attempted+sent, and honest otherwise.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const disputeService = require('../services/dispute');

function freshDb() {
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE bounties (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE disputes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bounty_id INTEGER NOT NULL,
      raised_by_tg_id INTEGER NOT NULL,
      raised_against_tg_id INTEGER NOT NULL,
      arbiter_tg_id INTEGER,
      status TEXT DEFAULT 'open'
    );
  `);
  return { _raw: () => raw };
}

function insertDispute(db, partial = {}) {
  const raw = db._raw();
  const cols = { bounty_id: 1, raised_by_tg_id: 100, raised_against_tg_id: 200, arbiter_tg_id: 300, ...partial };
  return raw
    .prepare(
      'INSERT INTO disputes (bounty_id, raised_by_tg_id, raised_against_tg_id, arbiter_tg_id) VALUES (?, ?, ?, ?)'
    )
    .run(cols.bounty_id, cols.raised_by_tg_id, cols.raised_against_tg_id, cols.arbiter_tg_id).lastInsertRowid;
}

test('getOtherPartyTgId: raiser looks up → gets the respondent', () => {
  const db = freshDb();
  disputeService.init(db);
  const id = insertDispute(db, { raised_by_tg_id: 100, raised_against_tg_id: 200 });
  assert.equal(disputeService.getOtherPartyTgId(id, 100), 200);
});

test('getOtherPartyTgId: respondent looks up → gets the raiser', () => {
  const db = freshDb();
  disputeService.init(db);
  const id = insertDispute(db, { raised_by_tg_id: 100, raised_against_tg_id: 200 });
  assert.equal(disputeService.getOtherPartyTgId(id, 200), 100);
});

test('getOtherPartyTgId: the arbiter is not a "party" — returns null, never guesses a recipient', () => {
  const db = freshDb();
  disputeService.init(db);
  const id = insertDispute(db, { raised_by_tg_id: 100, raised_against_tg_id: 200, arbiter_tg_id: 300 });
  assert.equal(disputeService.getOtherPartyTgId(id, 300), null);
});

test('getOtherPartyTgId: unknown dispute id → null', () => {
  const db = freshDb();
  disputeService.init(db);
  assert.equal(disputeService.getOtherPartyTgId(9999, 100), null);
});

test('getOtherPartyTgId: caller id that is neither party → null (never falls back to either party)', () => {
  const db = freshDb();
  disputeService.init(db);
  const id = insertDispute(db, { raised_by_tg_id: 100, raised_against_tg_id: 200 });
  assert.equal(disputeService.getOtherPartyTgId(id, 999), null);
});
