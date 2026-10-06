'use strict';
// HTTP-level tests for the agent bridge — /api/agent/*, the bot's only internet-reachable
// HTTP surface (Caddy forwards nothing else to it). There were none until 2026-10-06;
// this file covers the auth (401 / 403 / 429) and the fixes of that day:
//   - claim answered 200 "assigned" when assignBounty wrote nothing           → 409
//   - submit's ownership check skipped tasks a person had claimed            → 403
//   - submit took any string as the PR URL                                    → 400
//   - every read returned raw rows: *_tg_id next to wallets, applicants' pitches
//   - POST /proposals/temp-check always answered 500
//   - claim/submit/breakdown write only the legacy SQLite board, which no shipped client
//     calls: they now answer 503 unless FEATURE_LEGACY_BOUNTY=true (off in production)
//   - temp-check, once it worked, let any proposals:create key post to the groups: it
//     answers 503 unless FEATURE_AGENT_PROPOSALS=true (off in production)
//   - a JSON body of `null` answered 500
//
// Like api-badge-gate-outage.test.js: the real server runs in a child process on a
// throwaway database, listening on port 0 (api.js installs module-scope intervals). The
// child seeds the rows and the keys, prints them, then prints its port. fetch is replaced
// with one that throws, so nothing leaves the machine.
//
// Run: node --test bot/test/agent-api.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('node:child_process');

const BOT_DIR = path.join(__dirname, '..');
const req = (f) => JSON.stringify(path.join(BOT_DIR, f));

const POSTER = 'account_rdx1' + 'p'.repeat(54);
const HUMAN = 'account_rdx1' + 'h'.repeat(54);
const PITCH = 'PITCH-MARKER-only-the-creator-reads-this';

const SERVER_SCRIPT = [
  'global.fetch = async (url) => { throw new Error("no network in this test: " + url); };',
  'const db = require(' + req('db.js') + ');',
  'db.init();',
  'const agentBridge = require(' + req('services/agent-bridge.js') + ');',
  'agentBridge.init(db);',
  'const projectService = require(' + req('services/project.js') + ');',
  'projectService.init(db);',
  'const raw = db._raw();',
  'const POSTER = ' + JSON.stringify(POSTER) + ', HUMAN = ' + JSON.stringify(HUMAN) + ';',
  'db.registerUser(111, POSTER, "poster");',
  'db.registerUser(222, HUMAN, "human_worker");',
  'const key = (name, scopes, rate) => { const r = agentBridge.createAgentKey(name, scopes, 111, rate || 60); if (r.error) throw new Error(r.error); return r; };',
  'const reader = key("reader", ["tasks:read", "proposals:read", "projects:read"]);',
  'const worker = key("worker", ["tasks:read", "tasks:claim", "tasks:submit"]);',
  'const proposer = key("proposer", ["proposals:create", "proposals:read"]);',
  'const limited = key("limited", ["tasks:read"], 2);',
  'const admin = key("admin-agent", ["admin"]);',
  'const creatorAgent = key("creator-agent", ["tasks:read"]);',
  'const breaker = key("breaker", ["projects:read", "projects:breakdown"]);',
  'const fund = (id) => raw.prepare("UPDATE bounties SET funded = 1 WHERE id = ?").run(id);',
  // An open, funded task with a human application on it.
  'const open = db.createBounty("Write the FAQ", 50, 111, { creatorAddress: POSTER }); fund(open);',
  'db.createApplication(open, 222, HUMAN, ' + JSON.stringify(PITCH) + ', 5);',
  // Above the 100 XRD application threshold: assignBounty refuses without an accepted application.
  'const big = db.createBounty("Audit the escrow", 500, 111, { creatorAddress: POSTER }); fund(big);',
  // A task a PERSON claimed.
  'const humanTask = db.createBounty("Translate the guide", 40, 111, { creatorAddress: POSTER }); fund(humanTask);',
  'db.assignBounty(humanTask, 222, HUMAN);',
  // A task created by an agent (its sentinel tg id), with an application: only that agent reads the pitch.
  'const creatorTgId = -(creatorAgent.keyId + 900000);',
  'raw.prepare("INSERT INTO users (tg_id, radix_address, username) VALUES (?, ?, ?)").run(creatorTgId, "agent:creator-agent", "agent:creator-agent");',
  'const agentsTask = db.createBounty("Label the dataset", 30, creatorTgId, {}); fund(agentsTask);',
  'db.createApplication(agentsTask, 222, HUMAN, ' + JSON.stringify(PITCH) + ', 3);',
  // A project with a lead and a contributor.
  'const groupId = raw.prepare("INSERT INTO working_groups (name, lead_tg_id, lead_address) VALUES (?, ?, ?)").run("Docs WG", 111, POSTER).lastInsertRowid;',
  'const projTask = db.createBounty("Draft the README", 20, 111, { creatorAddress: POSTER }); fund(projTask);',
  'raw.prepare("UPDATE bounties SET group_id = ? WHERE id = ?").run(groupId, projTask);',
  'db.assignBounty(projTask, 222, HUMAN);',
  // An active proposal by a person, posted to a Telegram chat.
  'const pid = db.createProposal("Weekly call?", 111, { type: "yesno" });',
  'db.updateProposalMessage(pid, 77, -100123);',
  'process.stdout.write("SEED " + JSON.stringify({',
  '  keys: { reader: reader.rawKey, worker: worker.rawKey, proposer: proposer.rawKey, limited: limited.rawKey, admin: admin.rawKey, creatorAgent: creatorAgent.rawKey, breaker: breaker.rawKey },',
  '  ids: { open, big, humanTask, agentsTask, groupId },',
  '}) + "\\n");',
  'const { startApi } = require(' + req('services/api.js') + ');',
  'const server = startApi();',
  'server.on("listening", () => process.stdout.write("PORT " + server.address().port + "\\n"));',
].join('\n');

function startServer(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-agent-api-'));
  const env = {
    PATH: process.env.PATH,
    BOT_DB_PATH: path.join(dir, 'guild.db'),
    API_HOST: '127.0.0.1',
    API_PORT: '0',
    ...extraEnv,
  };
  const child = spawn(process.execPath, ['-e', SERVER_SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const ready = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const seed = out.match(/^SEED (.+)$/m);
      const port = out.match(/^PORT (\d+)$/m);
      if (seed && port) resolve({ ...JSON.parse(seed[1]), port: Number(port[1]) });
    });
    child.on('exit', (code) => reject(new Error('server exited (' + code + ') before listening: ' + stderr)));
  });
  return {
    ready,
    stop() {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// api.js also limits per client IP (one bucket per minute: 20 when the request is a write,
// 200 otherwise), read from the last X-Forwarded-For hop. Each call here comes from its own
// address so that limiter never answers for the per-key one under test.
let callNo = 0;

async function call(port, method, pathname, { key, body, auth } = {}) {
  callNo++;
  const headers = { 'x-forwarded-for': '10.9.' + Math.floor(callNo / 250) + '.' + (callNo % 250) };
  if (auth !== undefined) headers.authorization = auth;
  else if (key) headers.authorization = 'Bearer ' + key;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch('http://127.0.0.1:' + port + pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}

/** Every key, at any depth, that names a Telegram id. */
function tgIdKeys(value, at = '$', found = []) {
  if (Array.isArray(value)) value.forEach((v, i) => tgIdKeys(v, at + '[' + i + ']', found));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/(^|_)tg_id$|TgId$|tg_(chat|message)_id$/i.test(k)) found.push(at + '.' + k);
      tgIdKeys(v, at + '.' + k, found);
    }
  }
  return found;
}

describe('agent API with both flags on (FEATURE_LEGACY_BOUNTY, FEATURE_AGENT_PROPOSALS)', () => {
  let server;
  let s; // { port, keys, ids }
  before(async () => {
    server = startServer({ FEATURE_LEGACY_BOUNTY: 'true', FEATURE_AGENT_PROPOSALS: 'true' });
    s = await server.ready;
  });
  after(() => server && server.stop());

  // ── auth ──
  it('no Authorization header → 401 missing_auth', async () => {
    const r = await call(s.port, 'GET', '/api/agent/whoami');
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'missing_auth');
  });

  it('an unknown key → 401 invalid_key', async () => {
    const r = await call(s.port, 'GET', '/api/agent/whoami', { auth: 'Bearer agk_' + '0'.repeat(48) });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'invalid_key');
  });

  it('a key without the scope → 403 insufficient_scope (claim, temp-check, keys)', async () => {
    const claim = await call(s.port, 'POST', '/api/agent/tasks/' + s.ids.open + '/claim', { key: s.keys.reader, body: {} });
    assert.equal(claim.status, 403);
    assert.equal(claim.json.error, 'insufficient_scope');
    const temp = await call(s.port, 'POST', '/api/agent/proposals/temp-check', { key: s.keys.reader, body: { title: 'Is this allowed?' } });
    assert.equal(temp.status, 403);
    const keys = await call(s.port, 'GET', '/api/agent/keys', { key: s.keys.reader });
    assert.equal(keys.status, 403);
  });

  it('the per-key hourly limit answers 429 once spent', async () => {
    const a = await call(s.port, 'GET', '/api/agent/whoami', { key: s.keys.limited });
    const b = await call(s.port, 'GET', '/api/agent/whoami', { key: s.keys.limited });
    const c = await call(s.port, 'GET', '/api/agent/whoami', { key: s.keys.limited });
    assert.deepEqual([a.status, b.status, c.status], [200, 200, 429]);
    assert.equal(c.json.error, 'rate_limited');
  });

  // ── BOT-05: the reads are projections ──
  it('GET /tasks/match carries no Telegram id', async () => {
    const r = await call(s.port, 'GET', '/api/agent/tasks/match', { key: s.keys.reader });
    assert.equal(r.status, 200);
    assert.ok(r.json.data.length >= 2, 'expected the open tasks');
    assert.ok(r.json.data.some((t) => t.id === s.ids.open && t.title === 'Write the FAQ' && t.reward_xrd === 50));
    assert.deepEqual(tgIdKeys(r.json), []);
  });

  it('GET /tasks/:id: no Telegram ids, and applicants\' pitches and addresses stay hidden', async () => {
    const r = await call(s.port, 'GET', '/api/agent/tasks/' + s.ids.open, { key: s.keys.reader });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.id, s.ids.open);
    assert.equal(r.json.data.status, 'open');
    assert.deepEqual(tgIdKeys(r.json), []);
    assert.equal(r.json.data.applications.length, 1, 'the application is still counted');
    assert.ok(!r.text.includes(PITCH), 'pitch leaked');
    assert.ok(!r.text.includes(HUMAN), 'applicant address leaked');
  });

  it('GET /tasks/:id: the agent that created the task reads its applications, still without Telegram ids', async () => {
    const r = await call(s.port, 'GET', '/api/agent/tasks/' + s.ids.agentsTask, { key: s.keys.creatorAgent });
    assert.equal(r.status, 200);
    const [app] = r.json.data.applications;
    assert.equal(app.pitch, PITCH);
    assert.equal(app.applicant_address, HUMAN);
    assert.deepEqual(tgIdKeys(r.json), []);
    // …and another agent reading the same task does not.
    const other = await call(s.port, 'GET', '/api/agent/tasks/' + s.ids.agentsTask, { key: s.keys.reader });
    assert.ok(!other.text.includes(PITCH));
  });

  it('GET /proposals carries no creator or chat ids', async () => {
    const r = await call(s.port, 'GET', '/api/agent/proposals', { key: s.keys.reader });
    assert.equal(r.status, 200);
    assert.ok(r.json.data.some((p) => p.title === 'Weekly call?'));
    assert.deepEqual(tgIdKeys(r.json), []);
  });

  it('GET /projects/:id carries no lead, contributor or assignee ids', async () => {
    const r = await call(s.port, 'GET', '/api/agent/projects/' + s.ids.groupId, { key: s.keys.reader });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.group.name, 'Docs WG');
    assert.equal(r.json.data.contributors.length, 1);
    assert.equal(r.json.data.contributors[0].tasks, 1);
    assert.equal(r.json.data.activeTasks.length, 1);
    assert.deepEqual(tgIdKeys(r.json), []);
    assert.ok(r.json.data.tasks.every((t) => !('assignee_tg_id' in t) && !('creator_tg_id' in t)));
  });

  it('GET /keys (admin) carries no owner Telegram id and no key hash', async () => {
    const r = await call(s.port, 'GET', '/api/agent/keys', { key: s.keys.admin });
    assert.equal(r.status, 200);
    assert.ok(r.json.data.length >= 6);
    assert.deepEqual(tgIdKeys(r.json), []);
    assert.ok(!r.text.includes('api_key_hash'));
  });

  // ── BOT-02: a claim that wrote nothing is not "assigned" ──
  it('REGRESSION: claiming a task above the application threshold answers 409 and assigns nothing', async () => {
    const r = await call(s.port, 'POST', '/api/agent/tasks/' + s.ids.big + '/claim', { key: s.keys.worker, body: {} });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'application_required');
    const after = await call(s.port, 'GET', '/api/agent/tasks/' + s.ids.big, { key: s.keys.reader });
    assert.equal(after.json.data.status, 'open');
    assert.equal(after.json.data.claimed_by_agent, 0, 'flagged as agent-claimed although nothing was assigned');
  });

  it('a claim that the database writes answers 200 assigned', async () => {
    const r = await call(s.port, 'POST', '/api/agent/tasks/' + s.ids.open + '/claim', { key: s.keys.worker, body: {} });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { ok: true, data: { taskId: s.ids.open, status: 'assigned', agent: 'worker' } });
    const after = await call(s.port, 'GET', '/api/agent/tasks/' + s.ids.open, { key: s.keys.reader });
    assert.equal(after.json.data.status, 'assigned');
    assert.equal(after.json.data.assignee_address, 'agent:worker');
    assert.equal(after.json.data.claimed_by_agent, 1);
  });

  // ── BOT-03: submit ──
  it('REGRESSION: an agent cannot submit on a task a person claimed (403 not_your_task)', async () => {
    const r = await call(s.port, 'POST', '/api/agent/tasks/' + s.ids.humanTask + '/submit', {
      key: s.keys.worker, body: { github_pr: 'https://github.com/radixguild/guild/pull/1' },
    });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.error, 'not_your_task');
    const after = await call(s.port, 'GET', '/api/agent/tasks/' + s.ids.humanTask, { key: s.keys.reader });
    assert.equal(after.json.data.status, 'assigned');
    assert.equal(after.json.data.github_pr, null);
  });

  it('REGRESSION: a submission that is not a GitHub pull request URL is refused (400 invalid_pr_url)', async () => {
    for (const url of ['https://evil.example/github.com/a/b/pull/1', 'https://gitlab.com/a/b/-/merge_requests/1', 'not a url']) {
      const r = await call(s.port, 'POST', '/api/agent/tasks/' + s.ids.open + '/submit', { key: s.keys.worker, body: { github_pr: url } });
      assert.equal(r.status, 400, url + ' → ' + r.text);
      assert.equal(r.json.error, 'invalid_pr_url');
    }
    const after = await call(s.port, 'GET', '/api/agent/tasks/' + s.ids.open, { key: s.keys.reader });
    assert.equal(after.json.data.status, 'assigned', 'a refused submission must not move the task');
  });

  it('the agent that claimed a task submits a GitHub PR URL (200 submitted)', async () => {
    const pr = 'https://github.com/radixguild/guild/pull/42';
    const r = await call(s.port, 'POST', '/api/agent/tasks/' + s.ids.open + '/submit', { key: s.keys.worker, body: { github_pr: pr } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.status, 'submitted');
    const after = await call(s.port, 'GET', '/api/agent/tasks/' + s.ids.open, { key: s.keys.reader });
    assert.equal(after.json.data.status, 'submitted');
    assert.equal(after.json.data.github_pr, pr);
  });

  // ── BOT-06: temp-check ──
  it('REGRESSION: POST /proposals/temp-check creates the proposal (it always answered 500)', async () => {
    const r = await call(s.port, 'POST', '/api/agent/proposals/temp-check', {
      key: s.keys.proposer, body: { title: 'Should the guild add a glossary?', category: 'docs' },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.equal(typeof r.json.data.proposalId, 'number');
    assert.equal(r.json.data.stage, 'temp_check');
    const list = await call(s.port, 'GET', '/api/agent/proposals', { key: s.keys.proposer });
    const p = list.json.data.find((x) => x.id === r.json.data.proposalId);
    assert.ok(p, 'the new proposal is not listed');
    assert.equal(p.title, 'Should the guild add a glossary?');
    assert.equal(p.stage, 'temp_check');
    assert.equal(p.category, 'docs');
    assert.deepEqual(tgIdKeys(list.json), []);
  });

  it('temp-check: a second proposal from the same agent works too, and a short title is refused', async () => {
    const r = await call(s.port, 'POST', '/api/agent/proposals/temp-check', { key: s.keys.proposer, body: { title: 'And a style guide?' } });
    assert.equal(r.status, 200, r.text);
    const short = await call(s.port, 'POST', '/api/agent/proposals/temp-check', { key: s.keys.proposer, body: { title: 'Hm' } });
    assert.equal(short.json.error, 'title_required');
  });

  it('REGRESSION: a JSON body of null reads as an empty body, not a 500', async () => {
    const res = await fetch('http://127.0.0.1:' + s.port + '/api/agent/proposals/temp-check', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + s.keys.proposer, 'content-type': 'application/json', 'x-forwarded-for': '10.8.0.1' },
      body: 'null',
    });
    const json = await res.json();
    assert.notEqual(res.status, 500, JSON.stringify(json));
    assert.equal(json.error, 'title_required');
  });
});

describe('agent API with the legacy board off (production default)', () => {
  let server;
  let s;
  before(async () => {
    server = startServer({});
    s = await server.ready;
  });
  after(() => server && server.stop());

  it('REGRESSION: claim answers 503 and writes nothing', async () => {
    const r = await call(s.port, 'POST', '/api/agent/tasks/' + s.ids.open + '/claim', { key: s.keys.worker, body: {} });
    assert.equal(r.status, 503, r.text);
    assert.equal(r.json.error, 'service_unavailable');
    const after = await call(s.port, 'GET', '/api/agent/tasks/' + s.ids.open, { key: s.keys.reader });
    assert.equal(after.json.data.status, 'open');
  });

  it('REGRESSION: submit answers 503 and writes nothing', async () => {
    const r = await call(s.port, 'POST', '/api/agent/tasks/' + s.ids.humanTask + '/submit', {
      key: s.keys.worker, body: { github_pr: 'https://github.com/radixguild/guild/pull/1' },
    });
    assert.equal(r.status, 503, r.text);
    const after = await call(s.port, 'GET', '/api/agent/tasks/' + s.ids.humanTask, { key: s.keys.reader });
    assert.equal(after.json.data.status, 'assigned');
  });

  it('the scope check still comes first (403, not 503, for a key without tasks:claim)', async () => {
    const r = await call(s.port, 'POST', '/api/agent/tasks/' + s.ids.open + '/claim', { key: s.keys.reader, body: {} });
    assert.equal(r.status, 403);
  });

  it('REGRESSION: project breakdown answers 503 and writes no task', async () => {
    const before = await call(s.port, 'GET', '/api/agent/projects/' + s.ids.groupId, { key: s.keys.breaker });
    const r = await call(s.port, 'POST', '/api/agent/projects/' + s.ids.groupId + '/breakdown', {
      key: s.keys.breaker, body: { tasks: [{ title: 'Injected task', reward_xrd: 1e12 }] },
    });
    assert.equal(r.status, 503, r.text);
    assert.equal(r.json.error, 'service_unavailable');
    const after = await call(s.port, 'GET', '/api/agent/projects/' + s.ids.groupId, { key: s.keys.breaker });
    assert.equal(after.json.data.tasks.length, before.json.data.tasks.length);
  });

  it('REGRESSION: temp-check answers 503 and creates no proposal (FEATURE_AGENT_PROPOSALS off)', async () => {
    const proposals = async () => (await call(s.port, 'GET', '/api/agent/proposals', { key: s.keys.proposer })).json.data.length;
    const before = await proposals();
    const r = await call(s.port, 'POST', '/api/agent/proposals/temp-check', { key: s.keys.proposer, body: { title: 'Open a docs channel?' } });
    assert.equal(r.status, 503, r.text);
    assert.equal(r.json.error, 'service_unavailable');
    assert.equal(await proposals(), before);
  });

  it('the scope checks still come first for breakdown and temp-check (403, not 503)', async () => {
    const b = await call(s.port, 'POST', '/api/agent/projects/' + s.ids.groupId + '/breakdown', { key: s.keys.reader, body: { tasks: [{ title: 'x' }] } });
    assert.equal(b.status, 403);
    const t = await call(s.port, 'POST', '/api/agent/proposals/temp-check', { key: s.keys.reader, body: { title: 'Open a docs channel?' } });
    assert.equal(t.status, 403);
  });

  it('the reads do not depend on the flags', async () => {
    const read = await call(s.port, 'GET', '/api/agent/tasks/' + s.ids.open, { key: s.keys.reader });
    assert.equal(read.status, 200);
  });
});
