'use strict';
// One wallet, one vote (2026-10-06). The votes key is (proposal_id, tg_id), so before this
// fix one badge voted once per Telegram account that had /register-ed its wallet. And the
// badge gates must resolve the wallet through memberAddress, never through the raw
// /register row (source scrape: index.js starts the bot, so it is not imported here).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = path.join(os.tmpdir(), 'guild-vote-wallet-test-' + process.pid + '.db');
process.env.BOT_DB_PATH = TMP;
const db = require('../db');

const BADGE = 'account_rdx1' + 'c'.repeat(54);
const OTHER = 'account_rdx1' + 'd'.repeat(54);

describe('recordVote: one wallet, one vote', () => {
  let pid;
  before(() => {
    db.init();
    db.registerUser(1, OTHER, 'creator'); // proposals.creator_tg_id is a users FK
    pid = db.createProposal('Weekly call?', 1, { type: 'yesno' });
  });
  after(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(TMP + suffix); } catch (_) {}
    }
  });

  it('the first vote from a wallet counts', () => {
    assert.deepEqual(db.recordVote(pid, 101, BADGE, 'for'), { ok: true });
  });

  it('REGRESSION: a second Telegram account voting with the same wallet is refused', () => {
    assert.deepEqual(db.recordVote(pid, 102, BADGE, 'against'), { ok: false, error: 'wallet_already_voted' });
  });

  it('the same Telegram account voting twice is still already_voted', () => {
    assert.deepEqual(db.recordVote(pid, 101, BADGE, 'against'), { ok: false, error: 'already_voted' });
  });

  it('a different wallet still votes, and the count is one per wallet', () => {
    assert.deepEqual(db.recordVote(pid, 103, OTHER, 'against'), { ok: true });
    assert.deepEqual({ ...db.getVoteCounts(pid) }, { for: 1, against: 1 });
  });

  it('the same wallet may vote on a different proposal', () => {
    const pid2 = db.createProposal('Another', 1, { type: 'yesno' });
    assert.deepEqual(db.recordVote(pid2, 102, BADGE, 'for'), { ok: true });
  });
});

describe('index.js badge gates resolve the wallet through memberAddress', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const fnBody = (startRe, endRe) => {
    const start = src.search(startRe);
    assert.ok(start >= 0, 'not found: ' + startRe);
    const rest = src.slice(start);
    return rest.slice(0, rest.search(endRe));
  };

  it('requireBadge checks the badge on the memberAddress wallet, not a db.getUser row', () => {
    const body = fnBody(/async function requireBadge\(ctx\)/, /\n}\n/);
    assert.match(body, /memberAddress\(ctx\.from\.id\)/);
    assert.match(body, /copy\.linkRequired\(\)/);
    assert.doesNotMatch(body, /const user = db\.getUser\(ctx\.from\.id\);\s*\n\s*if \(!user\)/);
  });

  it('the vote buttons check and record the memberAddress wallet', () => {
    const body = fnBody(/if \(!data\.startsWith\("vote_"\)\) return await next\(\);/, /\n}\);\n/);
    assert.match(body, /memberAddress\(ctx\.from\.id\)/);
    assert.match(body, /hasBadge\(who\.address\)/);
    assert.match(body, /db\.recordVote\(proposalId, ctx\.from\.id, who\.address, voteChoice\)/);
    assert.match(body, /wallet_already_voted/);
    assert.doesNotMatch(body, /\buser\.radix_address\b/);
  });
});
