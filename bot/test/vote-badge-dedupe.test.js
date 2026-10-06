'use strict';
// A vote is deduped on the badge NFT too (2026-10-06). The badge is transferable
// (withdrawer AllowAll), and votes deduped on the wallet and the Telegram account only, so
// one badge moved from wallet to wallet voted from each. The vote now records the badge's
// local id (getBadgeResult's data.id) in votes.badge_id and refuses a second vote on the
// same proposal from the same badge: badge_already_voted. Rows from before the column have
// badge_id NULL and are never compared.
//
// Also here: the vote button's XP side effect can no longer turn a recorded vote into an
// "Error processing vote" answer (source scrape: index.js starts the bot when required).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');

const BOT_DIR = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'guild-vote-badge-test-' + process.pid + '.db');
process.env.BOT_DB_PATH = TMP;
const db = require('../db');

const W1 = 'account_rdx1' + 'e'.repeat(54);
const W2 = 'account_rdx1' + 'f'.repeat(54);
const W3 = 'account_rdx1' + 'g'.repeat(54);
const BADGE = '<guild_member_7>';

describe('recordVote: a badge votes once per proposal, whichever wallet holds it', () => {
  let pid;
  before(() => {
    // A database from before the column: votes without badge_id, holding one old vote.
    const old = new Database(TMP);
    old.exec(`
      CREATE TABLE users (tg_id INTEGER PRIMARY KEY, radix_address TEXT NOT NULL, username TEXT, registered_at INTEGER);
      CREATE TABLE proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, type TEXT DEFAULT 'yesno', options TEXT,
        creator_tg_id INTEGER NOT NULL, status TEXT DEFAULT 'active', parent_id INTEGER, round INTEGER DEFAULT 1,
        created_at INTEGER DEFAULT (strftime('%s','now')), ends_at INTEGER NOT NULL, min_votes INTEGER DEFAULT 3,
        tg_message_id INTEGER, tg_chat_id INTEGER);
      CREATE TABLE votes (proposal_id INTEGER NOT NULL, tg_id INTEGER NOT NULL, radix_address TEXT NOT NULL, vote TEXT NOT NULL,
        voted_at INTEGER DEFAULT (strftime('%s','now')), PRIMARY KEY (proposal_id, tg_id));
      INSERT INTO users (tg_id, radix_address, username) VALUES (1, '${W3}', 'creator');
      INSERT INTO proposals (title, creator_tg_id, ends_at) VALUES ('Old proposal', 1, 9999999999);
      INSERT INTO votes (proposal_id, tg_id, radix_address, vote) VALUES (1, 900, '${W3}', 'for');
    `);
    old.close();
    db.init();
    db.init(); // the migration is idempotent
    pid = db.createProposal('Weekly call?', 1, { type: 'yesno' });
  });
  after(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(TMP + suffix); } catch (_) {}
    }
  });

  it('the migration adds votes.badge_id and leaves old rows NULL', () => {
    const cols = db._raw().prepare('PRAGMA table_info(votes)').all().map((c) => c.name);
    assert.ok(cols.includes('badge_id'));
    const oldRow = db._raw().prepare('SELECT badge_id FROM votes WHERE proposal_id = 1 AND tg_id = 900').get();
    assert.equal(oldRow.badge_id, null);
  });

  it('the first vote with a badge counts, and records the badge', () => {
    assert.deepEqual(db.recordVote(pid, 101, W1, 'for', BADGE), { ok: true });
    assert.equal(db._raw().prepare('SELECT badge_id FROM votes WHERE proposal_id = ? AND tg_id = 101').get(pid).badge_id, BADGE);
  });

  it('REGRESSION: the same badge, moved to another wallet and another account, is refused', () => {
    assert.deepEqual(db.recordVote(pid, 102, W2, 'against', BADGE), { ok: false, error: 'badge_already_voted' });
    assert.deepEqual({ ...db.getVoteCounts(pid) }, { for: 1 });
  });

  it('the same account voting twice is still already_voted', () => {
    assert.deepEqual(db.recordVote(pid, 101, W1, 'against', BADGE), { ok: false, error: 'already_voted' });
  });

  it('a different badge from another wallet votes', () => {
    assert.deepEqual(db.recordVote(pid, 102, W2, 'against', '<guild_member_8>'), { ok: true });
    assert.deepEqual({ ...db.getVoteCounts(pid) }, { for: 1, against: 1 });
  });

  it('the same badge may vote on a different proposal', () => {
    const pid2 = db.createProposal('Another', 1, { type: 'yesno' });
    assert.deepEqual(db.recordVote(pid2, 102, W2, 'for', BADGE), { ok: true });
  });

  it('old rows (badge_id NULL) and votes recorded without a badge id are never compared on the badge', () => {
    assert.deepEqual(db.recordVote(1, 103, W1, 'against', BADGE), { ok: true }); // proposal 1 holds the NULL-badge row
    assert.deepEqual(db.recordVote(pid, 104, W3, 'for'), { ok: true });
    assert.deepEqual(db.recordVote(pid, 105, 'account_rdx1' + 'k'.repeat(54), 'for', null), { ok: true });
  });

  it('the database itself refuses a second row for the same (proposal, badge)', () => {
    assert.throws(
      () => db._raw().prepare('INSERT INTO votes (proposal_id, tg_id, radix_address, vote, badge_id) VALUES (?, ?, ?, ?, ?)').run(pid, 199, W3, 'for', BADGE),
      /UNIQUE constraint failed: votes\.proposal_id, votes\.badge_id/
    );
  });
});

// The web path (POST /api/proposals/:id/vote) records the badge too. The fake Gateway
// answers the same badge, <member_1>, for every address — exactly a badge that moved.
describe('POST /api/proposals/:id/vote dedupes on the badge', () => {
  const SERVER_SCRIPT = [
    'global.fetch = async (url) => {',
    '  const BADGE = "resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl";',
    '  if (String(url).endsWith("/state/entity/details")) {',
    '    const body = { items: [{ non_fungible_resources: { items: [{ resource_address: BADGE, vaults: { items: [{ items: ["<member_1>"] }] } }] } }] };',
    '    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };',
    '  }',
    '  if (String(url).endsWith("/state/non-fungible/data")) {',
    '    const fields = ["member_1", "guild_member", "", "member", "active", "", "0", "1"].map((value) => ({ value }));',
    '    const body = { non_fungible_ids: [{ data: { programmatic_json: { fields } } }] };',
    '    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };',
    '  }',
    '  throw new Error("unexpected Gateway call: " + url);',
    '};',
    'const db = require(' + JSON.stringify(path.join(BOT_DIR, 'db.js')) + ');',
    'db.init();',
    'db.registerUser(1, ' + JSON.stringify(W3) + ', "creator");',
    // Two members with their own accounts (an unknown address gets a -<unix seconds> tg_id,
    // so two unknown voters in the same second would collide on the account instead).
    'db.registerUser(11, ' + JSON.stringify(W1) + ', "first_holder");',
    'db.registerUser(12, ' + JSON.stringify(W2) + ', "second_holder");',
    'db.createProposal("Adopt the logo?", 1, { type: "yesno" });',
    'const { startApi } = require(' + JSON.stringify(path.join(BOT_DIR, 'services', 'api.js')) + ');',
    'const server = startApi();',
    'server.on("listening", () => process.stdout.write("PORT " + server.address().port + "\\n"));',
  ].join('\n');

  let child;
  let dir;
  let port;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-vote-badge-web-'));
    child = spawn(process.execPath, ['-e', SERVER_SCRIPT], {
      env: { PATH: process.env.PATH, BOT_DB_PATH: path.join(dir, 'guild.db'), API_HOST: '127.0.0.1', API_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    port = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (d) => { out += d; const m = out.match(/^PORT (\d+)$/m); if (m) resolve(Number(m[1])); });
      child.on('exit', (code) => reject(new Error('server exited (' + code + '): ' + stderr)));
    });
  });
  after(() => {
    if (child) child.kill();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const vote = async (address, choice) => {
    const res = await fetch('http://127.0.0.1:' + port + '/api/proposals/1/vote', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, vote: choice }),
    });
    return { status: res.status, json: await res.json() };
  };

  it('the first wallet holding the badge votes', async () => {
    const r = await vote(W1, 'for');
    assert.equal(r.status, 200, JSON.stringify(r.json));
  });

  it('REGRESSION: a second wallet presenting the same badge is refused 409 badge_already_voted', async () => {
    const r = await vote(W2, 'against');
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.deepEqual(r.json, { ok: false, error: 'badge_already_voted' });
  });
});

describe('index.js vote button', () => {
  const src = fs.readFileSync(path.join(BOT_DIR, 'index.js'), 'utf8');
  const start = src.search(/if \(!data\.startsWith\("vote_"\)\) return await next\(\);/);
  const body = src.slice(start, start + src.slice(start).search(/\n}\);\n/));

  it('passes the badge id it read to recordVote and answers badge_already_voted with its own copy', () => {
    assert.match(body, /badgeId = \(badge\.data && badge\.data\.id\) \|\| null;/);
    assert.match(body, /db\.recordVote\(proposalId, ctx\.from\.id, who\.address, voteChoice, badgeId\)/);
    assert.match(body, /result\.error === "badge_already_voted"[\s\S]{0,120}copy\.badgeAlreadyVoted\(\)/);
  });

  it('REGRESSION: a failing XP side effect is caught on its own, before the success answer', () => {
    const xp = body.indexOf('queueXpReward(who.address, "vote")');
    const answer = body.indexOf('ctx.answerCallbackQuery({ text: copy.voteRecorded(voteChoice) })');
    assert.ok(xp >= 0 && answer > xp);
    const between = body.slice(body.lastIndexOf('try {', xp), answer);
    assert.match(between, /^try \{\s*queueXpReward\(who\.address, "vote"\);\s*\} catch \(e\) \{\s*console\.error\(/);
  });
});
