'use strict';
// queueXpReward queues the action's own XP row and nothing else (2026-10-06). Until then
// every vote, proposal or poll also rolled the closed dice game and, on any roll above 1,
// queued a roll_bonus row of 5-100 XP into the same pending queue the XP batch signer
// reads — bonus XP that /game and /leaderboard now say "does not count anywhere".
//
// crypto.randomInt is pinned to 99 (a 6, the 100 XP "jackpot") so code that still rolled
// would queue a bonus on every call rather than on about 70% of them.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-xp-roll-'));
process.env.BOT_DB_PATH = path.join(dir, 'guild.db');
const db = require('../db');
db.init();
const xp = require('../services/xp');

const realRandomInt = crypto.randomInt;
crypto.randomInt = () => 99;
after(() => {
  crypto.randomInt = realRandomInt;
  fs.rmSync(dir, { recursive: true, force: true });
});

const rows = (address) => {
  const conn = new Database(process.env.BOT_DB_PATH, { readonly: true });
  try {
    return conn.prepare('SELECT action, xp_amount, status FROM xp_rewards WHERE radix_address = ? ORDER BY id').all(address);
  } finally {
    conn.close();
  }
};

test('a vote queues its 10 XP row and no roll_bonus row', () => {
  const a = 'account_rdx1' + 'v'.repeat(54);
  const out = xp.queueXpReward(a, 'vote');
  assert.deepEqual(out, { queued: true, xp: 10 });
  assert.deepEqual(rows(a), [{ action: 'vote', xp_amount: 10, status: 'pending' }]);
});

test('no queued action adds a roll_bonus row, however many times it runs', () => {
  const a = 'account_rdx1' + 'p'.repeat(54);
  const actions = ['vote', 'propose', 'poll', 'temp', 'amend', 'bounty_create', 'bounty_complete'];
  for (let i = 0; i < 3; i++) for (const action of actions) xp.queueXpReward(a, action);
  const queued = rows(a);
  assert.equal(queued.length, actions.length * 3);
  assert.deepEqual(queued.filter((r) => r.action === 'roll_bonus'), []);
  const pending = xp.getXpQueue().find((q) => q.address === a);
  const base = actions.reduce((sum, action) => sum + xp.XP_REWARDS[action], 0) * 3;
  assert.equal(pending.pendingXp, base, 'the queue holds the base XP only');
});

test('an unknown action still queues nothing', () => {
  const a = 'account_rdx1' + 'u'.repeat(54);
  assert.deepEqual(xp.queueXpReward(a, 'roll_bonus'), { queued: false });
  assert.deepEqual(rows(a), []);
});

test('rollDice stays: the grid board still uses it', () => {
  assert.equal(typeof db.rollDice, 'function');
  assert.equal(db.rollDice(), 6);
});
