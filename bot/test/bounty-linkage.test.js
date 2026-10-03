// Tests for component-scoped bounty ↔ on-chain task resolution.
//
// Run: node --test bot/test/bounty-linkage.test.js
//
// Regression class: on-chain task ids restart from 1 on every escrow component
// generation. On 2026-08-29 a history replay on the live PULL component
// resolved its task #1 via a bare `WHERE onchain_task_id = ?`, hit legacy V3
// bounty #37, and marked a 50 XRD bounty paid off a 1500 XRD release event.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const {
  isLegacyEscrowComponent,
  getBountyByOnchainTask,
  findConflictingLink,
  countUnstampedLinks,
} = require("../services/bounty-linkage");

// The two retired pre-guild-saas generations (literals in bounty-linkage.js).
const LEGACY_V1 = "component_rdx1cp8mwwe2pkrrtm05p7txgygf9y9uuwx6p87djkda8stk8nuwpyg56r";
const LEGACY_V3 = "component_rdx1czcjn322rhzvu4gwkculx6qvguv2erqu38mschwqkjyqtdpvpcex9s";
// The live guild-saas PULL escrow — must NEVER match a NULL-component row.
const LIVE_PULL = "component_rdx1cz468eqyr0fklyrlcsznadrwfnqnesw37vlm9j0xmq2s7427akd82f";

function freshDb() {
  const raw = new Database(":memory:");
  raw.exec(`
    CREATE TABLE bounties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      reward_xrd REAL,
      onchain_task_id INTEGER,
      escrow_component TEXT
    );
  `);
  return raw;
}

function insert(raw, { id, taskId, component = null, title = "b" }) {
  raw.prepare(
    "INSERT INTO bounties (id, title, reward_xrd, onchain_task_id, escrow_component) VALUES (?, ?, 1, ?, ?)"
  ).run(id, title, taskId, component);
}

test("legacy set: both retired generations in, live PULL out", () => {
  assert.equal(isLegacyEscrowComponent(LEGACY_V1), true);
  assert.equal(isLegacyEscrowComponent(LEGACY_V3), true);
  assert.equal(isLegacyEscrowComponent(LIVE_PULL), false);
});

test("the #37 regression: NULL-component legacy row never matches the live component", () => {
  const raw = freshDb();
  insert(raw, { id: 37, taskId: 1, component: null }); // legacy link, pre-column
  assert.equal(getBountyByOnchainTask(raw, 1, LIVE_PULL), undefined);
});

test("NULL-component legacy row still matches a legacy-generation lookup", () => {
  const raw = freshDb();
  insert(raw, { id: 37, taskId: 1, component: null });
  const hit = getBountyByOnchainTask(raw, 1, LEGACY_V3);
  assert.equal(hit?.id, 37);
});

test("exact component match wins over the legacy fallback", () => {
  const raw = freshDb();
  insert(raw, { id: 37, taskId: 1, component: null });
  insert(raw, { id: 90, taskId: 1, component: LEGACY_V3 });
  assert.equal(getBountyByOnchainTask(raw, 1, LEGACY_V3)?.id, 90);
});

test("same task id resolves independently per generation", () => {
  const raw = freshDb();
  insert(raw, { id: 90, taskId: 1, component: LEGACY_V3 });
  insert(raw, { id: 91, taskId: 1, component: LIVE_PULL });
  assert.equal(getBountyByOnchainTask(raw, 1, LEGACY_V3)?.id, 90);
  assert.equal(getBountyByOnchainTask(raw, 1, LIVE_PULL)?.id, 91);
});

test("no row at all → undefined", () => {
  const raw = freshDb();
  assert.equal(getBountyByOnchainTask(raw, 5, LIVE_PULL), undefined);
  assert.equal(getBountyByOnchainTask(raw, 5, LEGACY_V1), undefined);
});

test("findConflictingLink: live deposit not blocked by a colliding legacy NULL row", () => {
  const raw = freshDb();
  insert(raw, { id: 37, taskId: 1, component: null });
  assert.equal(findConflictingLink(raw, 1, LIVE_PULL, 99), undefined);
});

test("findConflictingLink: blocked by an existing link on the SAME component", () => {
  const raw = freshDb();
  insert(raw, { id: 91, taskId: 1, component: LIVE_PULL });
  assert.equal(findConflictingLink(raw, 1, LIVE_PULL, 99)?.id, 91);
});

test("findConflictingLink: legacy deposit still blocked by a NULL-component row", () => {
  const raw = freshDb();
  insert(raw, { id: 37, taskId: 1, component: null });
  assert.equal(findConflictingLink(raw, 1, LEGACY_V3, 99)?.id, 37);
});

test("findConflictingLink: the bounty being funded is excluded", () => {
  const raw = freshDb();
  insert(raw, { id: 91, taskId: 1, component: LIVE_PULL });
  assert.equal(findConflictingLink(raw, 1, LIVE_PULL, 91), undefined);
});

test("countUnstampedLinks: counts linked-but-NULL-component rows only", () => {
  const raw = freshDb();
  insert(raw, { id: 1, taskId: null, component: null });      // unlinked — not counted
  insert(raw, { id: 2, taskId: 5, component: LIVE_PULL });    // stamped — not counted
  insert(raw, { id: 3, taskId: 6, component: null });         // linked, unstamped — counted
  assert.equal(countUnstampedLinks(raw), 1);
});
