'use strict';
// DB-level moderation tests on a throwaway database: ban round-trip and
// broadcast recipient exclusion.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = path.join(os.tmpdir(), 'guild-moderation-test-' + process.pid + '.db');
process.env.BOT_DB_PATH = TMP;
const db = require('../db');

describe('moderation db', () => {
  before(() => { db.init(); });
  after(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(TMP + suffix); } catch (_) {}
    }
  });

  it('ban / isBanned / unban round-trip', () => {
    db.banUser(1001, 'spam');
    assert.equal(db.isBanned(1001), true);
    assert.equal(db.isBanned(1002), false);
    db.unbanUser(1001);
    assert.equal(db.isBanned(1001), false);
  });

  it('banUser upserts (re-ban updates reason, no duplicate row)', () => {
    db.banUser(1003, null);
    db.banUser(1003, 'updated');
    const rows = db.listBanned().filter((r) => r.tg_id === 1003);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, 'updated');
    db.unbanUser(1003);
  });

  it('listUserTgIds excludes banned users (broadcast must not DM them)', () => {
    db.registerUser(2001, 'account_rdx1aaa', 'a');
    db.registerUser(2002, 'account_rdx1bbb', 'b');
    db.banUser(2002, 'abuse');
    const ids = db.listUserTgIds();
    assert.ok(ids.includes(2001));
    assert.ok(!ids.includes(2002), 'banned id must be excluded');
    db.unbanUser(2002);
  });
});
