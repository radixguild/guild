'use strict';
// rollDice draws from crypto, not Math.random (2026-10-06): it fed roll_bonus XP rows queued
// for on-chain update_xp until services/xp.js stopped rolling. The weights must stay 30/25/20/13/8/4.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.BOT_DB_PATH = path.join(os.tmpdir(), 'guild-dice-test-' + process.pid + '.db');
const db = require('../db');

test('rollDice uses crypto.randomInt, never Math.random', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  const body = src.slice(src.indexOf('function rollDice()'), src.indexOf('function recordRoll('));
  assert.match(body, /crypto\.randomInt\(0, 100\)/);
  assert.doesNotMatch(body, /Math\.random/);
});

test('rollDice maps 0-99 onto the 30/25/20/13/8/4 weights', () => {
  const crypto = require('node:crypto');
  const real = crypto.randomInt;
  const seen = new Map();
  try {
    for (let r = 0; r < 100; r++) {
      crypto.randomInt = () => r;
      const v = db.rollDice();
      seen.set(v, (seen.get(v) || 0) + 1);
    }
  } finally {
    crypto.randomInt = real;
  }
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((v) => seen.get(v)), [30, 25, 20, 13, 8, 4]);
});
