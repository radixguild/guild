'use strict';
// Who answers for a wallet (2026-10-06). /link does not evict other accounts' /register
// rows that claim the wallet it proved, and the address → user lookup read `users` alone,
// so the escrow watcher's settlement DM for a worker's wallet could go to whoever had
// /register-ed it. The lookup now prefers the account that PROVED the wallet
// (wallet_links) and reads `users` only when nobody has. Nothing is deleted.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const TMP = path.join(os.tmpdir(), 'guild-wallet-owner-test-' + process.pid + '.db');
process.env.BOT_DB_PATH = TMP;
const db = require('../db');

const PROVEN = 'account_rdx1' + 'm'.repeat(54);
const CLAIMED = 'account_rdx1' + 'n'.repeat(54);

describe('getUserByAddress prefers the account that proved the wallet', () => {
  before(() => {
    db.init();
    db.registerUser(10, PROVEN, 'squatter'); // /register-ed someone else's wallet, first
    db.registerUser(20, PROVEN, 'owner');
    db.recordWalletLink(20, PROVEN, 'nonce-owner');
    db.registerUser(30, CLAIMED, 'claimer'); // nobody has proven CLAIMED
  });
  after(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(TMP + suffix); } catch (_) {}
    }
  });

  it('REGRESSION: a proven wallet answers with the account that proved it, not the earlier claim', () => {
    const u = db.getUserByAddress(PROVEN);
    assert.equal(u.tg_id, 20);
    assert.equal(u.username, 'owner');
    assert.equal(u.radix_address, PROVEN);
  });

  it('the squatter\'s row is left in place', () => {
    assert.equal(db.getUser(10).radix_address, PROVEN);
  });

  it('a wallet nobody proved still answers with its /register row', () => {
    assert.equal(db.getUserByAddress(CLAIMED).tg_id, 30);
  });

  it('a proven account with no users row still answers, with its tg_id', () => {
    const LONE = 'account_rdx1' + 'r'.repeat(54);
    db.recordWalletLink(40, LONE, 'nonce-lone');
    assert.deepEqual(db.getUserByAddress(LONE), { username: null, tg_id: 40, radix_address: LONE });
  });

  it('an unknown wallet answers undefined', () => {
    assert.equal(db.getUserByAddress('account_rdx1' + 's'.repeat(54)), undefined);
  });

  it('userForAddress works on a handle from before /link (no wallet_links table)', () => {
    const old = new Database(':memory:');
    old.exec('CREATE TABLE users (tg_id INTEGER PRIMARY KEY, radix_address TEXT NOT NULL, username TEXT)');
    old.prepare('INSERT INTO users VALUES (?, ?, ?)').run(5, CLAIMED, 'x');
    assert.equal(db.userForAddress(old, CLAIMED).tg_id, 5);
    old.close();
  });
});

describe('the escrow watcher DMs through the same lookup', () => {
  it('its getUserByAddress calls userForAddress, not a raw users query', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'escrow-watcher.js'), 'utf8');
    const start = src.indexOf('function getUserByAddress(address) {');
    assert.ok(start >= 0);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    assert.match(body, /userForAddress\(db, address\)/);
    assert.doesNotMatch(src, /FROM users WHERE radix_address/);
  });
});
