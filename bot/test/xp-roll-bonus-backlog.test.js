'use strict';
// A pending roll_bonus backlog is voided when xp.js starts (2026-10-06): getXpQueue sums every
// pending row and markXpApplied flips them all, so without this a batch signer run would write
// the closed dice game's bonus XP on-chain. Production held 9 such rows (240 XP) that day.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-xp-backlog-'));
process.env.BOT_DB_PATH = path.join(dir, 'guild.db');
const A = 'account_rdx1' + 'b'.repeat(54);
{
  const conn = new Database(process.env.BOT_DB_PATH);
  conn.exec("CREATE TABLE xp_rewards (id INTEGER PRIMARY KEY AUTOINCREMENT, radix_address TEXT NOT NULL, action TEXT NOT NULL, xp_amount INTEGER NOT NULL, status TEXT DEFAULT 'pending', created_at INTEGER DEFAULT (strftime('%s','now')), applied_at INTEGER)");
  const ins = conn.prepare('INSERT INTO xp_rewards (radix_address, action, xp_amount, status) VALUES (?, ?, ?, ?)');
  ins.run(A, 'vote', 10, 'pending');
  ins.run(A, 'roll_bonus', 100, 'pending');
  ins.run(A, 'roll_bonus', 25, 'pending');
  ins.run(A, 'roll_bonus', 5, 'applied'); // already applied: history, left alone
  conn.close();
}
const xp = require('../services/xp');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const statuses = () => {
  const conn = new Database(process.env.BOT_DB_PATH, { readonly: true });
  try { return conn.prepare('SELECT action, xp_amount, status FROM xp_rewards ORDER BY id').all(); } finally { conn.close(); }
};

test('pending roll_bonus rows are voided on start; real XP and applied history are untouched', () => {
  assert.deepEqual(statuses(), [
    { action: 'vote', xp_amount: 10, status: 'pending' },
    { action: 'roll_bonus', xp_amount: 100, status: 'void' },
    { action: 'roll_bonus', xp_amount: 25, status: 'void' },
    { action: 'roll_bonus', xp_amount: 5, status: 'applied' },
  ]);
});

test('the signer queue and markXpApplied see only the real XP', () => {
  assert.deepEqual(xp.getXpQueue().map((r) => [r.address, r.pendingXp]), [[A, 10]]);
  xp.markXpApplied(A);
  assert.deepEqual(statuses().filter((r) => r.status === 'void').length, 2);
});

test('getXpStats leaves voided rows out of the total', () => {
  assert.equal(xp.getXpStats().totalXpAwarded, 10 + 5);
});
