'use strict';
// Retention of the agent audit trail (2026-10-08). Before this, nothing ever deleted an
// agent_activity row, and a spent key wrote one `rate_limited` row per refused request —
// a client hammering a spent key could grow the bot's SQLite by up to the per-IP limit
// (200 rows/min) for as long as it liked. Now the refusal is recorded once per key per
// hour window, and pruneAgentActivity (boot + daily from index.js) keeps `rate_limited`
// rows one day and everything else ninety, both floors on the env values.
//
// In-process on a throwaway database (agent-bridge's own cleanup timer is unref'd, so the
// runner exits). Run: node --test bot/test/agent-activity-retention.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = path.join(os.tmpdir(), 'guild-agent-retention-test-' + process.pid + '.db');
process.env.BOT_DB_PATH = TMP;
const db = require('../db');
const agentBridge = require('../services/agent-bridge');

const DAY = 86400;
const rowsFor = (raw, keyId, action) => raw.prepare(
  'SELECT id, created_at FROM agent_activity WHERE agent_key_id = ? AND action = ? ORDER BY id'
).all(keyId, action);
const backdate = (raw, id, seconds) => raw.prepare(
  'UPDATE agent_activity SET created_at = created_at - ? WHERE id = ?'
).run(seconds, id);
const fakeReq = (rawKey) => ({ headers: { authorization: 'Bearer ' + rawKey }, socket: { remoteAddress: '127.0.0.1' } });

describe('agent_activity retention', () => {
  let raw;
  let spent; // rate limit 1/hour
  let busy;  // rate limit 60/hour

  before(() => {
    db.init();
    agentBridge.init(db);
    raw = db._raw();
    db.registerUser(111, 'account_rdx1' + 'p'.repeat(54), 'poster');
    spent = agentBridge.createAgentKey('spent', ['tasks:read'], 111, 1);
    busy = agentBridge.createAgentKey('busy', ['tasks:read'], 111, 60);
    assert.ok(!spent.error && !busy.error);
  });

  after(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(TMP + suffix); } catch (_) {}
    }
  });

  it('REGRESSION: a spent key writes ONE rate_limited row per window, however many requests it makes', () => {
    const first = agentBridge.authenticateRequest(fakeReq(spent.rawKey));
    assert.ok(first.agent, 'the first request within the limit authenticates');
    const refused = [];
    for (let i = 0; i < 25; i++) refused.push(agentBridge.authenticateRequest(fakeReq(spent.rawKey)));
    assert.ok(refused.every((r) => r.status === 429 && r.error === 'rate_limited'), 'every later request is refused');
    const rows = rowsFor(raw, spent.keyId, 'rate_limited');
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(raw.prepare('SELECT result FROM agent_activity WHERE id = ?').get(rows[0].id).result).limit_per_hour, 1);
  });

  it('a key under its limit writes no rate_limited row', () => {
    for (let i = 0; i < 5; i++) assert.ok(agentBridge.authenticateRequest(fakeReq(busy.rawKey)).agent);
    assert.equal(rowsFor(raw, busy.keyId, 'rate_limited').length, 0);
  });

  it('rateLimitedFirstInWindow is true once per window and resets with the window', () => {
    // A key that has never been seen by the limiter counts as "first".
    assert.equal(agentBridge.rateLimitedFirstInWindow(999999), true);
    // The spent key's window is already flagged by the test above.
    assert.equal(agentBridge.rateLimitedFirstInWindow(spent.keyId), false);
    // Roll its window: the bucket's reset is in the past once the clock passes it.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 3600001 + 1000;
      assert.equal(agentBridge.checkAgentRateLimit(spent.keyId, 1), true, 'the new window admits one request');
      assert.equal(agentBridge.checkAgentRateLimit(spent.keyId, 1), false);
      assert.equal(agentBridge.rateLimitedFirstInWindow(spent.keyId), true, 'the flag reset with the window');
      assert.equal(agentBridge.rateLimitedFirstInWindow(spent.keyId), false);
    } finally {
      Date.now = realNow;
    }
  });

  it('pruneAgentActivity keeps rate_limited rows one day and other rows ninety, by default', () => {
    agentBridge.logActivity(busy.keyId, 'match_tasks', { q: 'old' }, {});
    agentBridge.logActivity(busy.keyId, 'match_tasks', { q: 'fresh' }, {});
    agentBridge.logActivity(busy.keyId, 'rate_limited', {}, { error: 'rate_limit_exceeded' });
    agentBridge.logActivity(busy.keyId, 'rate_limited', {}, { error: 'rate_limit_exceeded' });
    const matches = rowsFor(raw, busy.keyId, 'match_tasks');
    const limited = rowsFor(raw, busy.keyId, 'rate_limited');
    backdate(raw, matches[0].id, 91 * DAY);  // past the 90-day window
    backdate(raw, matches[1].id, 89 * DAY);  // inside it
    backdate(raw, limited[0].id, 2 * DAY);   // past the 1-day window
    backdate(raw, limited[1].id, 0.5 * DAY); // inside it

    const r = agentBridge.pruneAgentActivity();
    assert.equal(r.rateLimited, 1);
    assert.equal(r.other, 1);
    assert.deepEqual(rowsFor(raw, busy.keyId, 'match_tasks').map((x) => x.id), [matches[1].id]);
    assert.deepEqual(rowsFor(raw, busy.keyId, 'rate_limited').map((x) => x.id), [limited[1].id]);
  });

  it('the daily-budget window is never cut: AGENT_ACTIVITY_RETENTION_DAYS below 2 is ignored', () => {
    agentBridge.logActivity(busy.keyId, 'claim_task', { reward_xrd: 50 }, {});
    const claim = rowsFor(raw, busy.keyId, 'claim_task')[0];
    backdate(raw, claim.id, 1.5 * DAY);
    process.env.AGENT_ACTIVITY_RETENTION_DAYS = '0';
    try {
      const r = agentBridge.pruneAgentActivity();
      assert.equal(r.other, 0, 'a 0-day setting fell back to the default instead of deleting');
    } finally {
      delete process.env.AGENT_ACTIVITY_RETENTION_DAYS;
    }
    assert.equal(rowsFor(raw, busy.keyId, 'claim_task').length, 1);
    // An explicit, valid shorter window applies.
    process.env.AGENT_ACTIVITY_RETENTION_DAYS = '2';
    try {
      backdate(raw, claim.id, 1 * DAY); // now 2.5 days old
      // Two rows fall outside a 2-day window: this claim and the 89-day match_tasks row
      // the default-window case above kept.
      assert.equal(agentBridge.pruneAgentActivity().other, 2);
      assert.equal(rowsFor(raw, busy.keyId, 'claim_task').length, 0);
    } finally {
      delete process.env.AGENT_ACTIVITY_RETENTION_DAYS;
    }
  });

  it('a prune with an unusable clock deletes nothing and does not throw', () => {
    const before = raw.prepare('SELECT COUNT(*) AS n FROM agent_activity').get().n;
    const r = agentBridge.pruneAgentActivity({ now: NaN });
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM agent_activity').get().n, before);
    assert.equal(typeof r.rateLimited, 'number');
    assert.equal(typeof r.other, 'number');
  });
});
