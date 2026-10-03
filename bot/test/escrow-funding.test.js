// Tests for the verify-fund hardening (C3 + C5).
//
// Run: node --test bot/test/escrow-funding.test.js
//
// These tests exercise validateAndLinkFunding() against an in-memory SQLite
// database, with a stub gateway fetcher so we can assert behaviour without
// hitting mainnet.

const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const {
  validateAndLinkFunding,
  amountsMatch,
} = require("../services/escrow-funding");

const {
  parseTaskCreatedEvent,
  ESCROW_V1_COMPONENT,
  ESCROW_V3_COMPONENT,
  ESCROW_PULL_COMPONENT,
  XRD_RESOURCE,
} = require("../services/gateway");

// ── Fixtures ──────────────────────────────────────────────────────────────

const CREATOR_A = "account_rdx128lggtaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CREATOR_B = "account_rdx128lggtbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function freshDb() {
  const raw = new Database(":memory:");
  raw.exec(`
    CREATE TABLE bounties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      reward_xrd REAL NOT NULL,
      creator_tg_id INTEGER,
      creator_address TEXT,
      onchain_task_id INTEGER,
      escrow_component TEXT,
      escrow_verified INTEGER DEFAULT 0,
      escrow_version INTEGER,
      funded INTEGER DEFAULT 0,
      resource TEXT
    );
    CREATE TABLE bounty_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bounty_id INTEGER,
      tx_type TEXT,
      amount_xrd REAL,
      tx_hash TEXT,
      description TEXT,
      actor_tg_id INTEGER,
      verified_onchain INTEGER DEFAULT 0,
      onchain_task_id INTEGER,
      escrow_component TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE UNIQUE INDEX idx_bounty_tx_hash_unique ON bounty_transactions(tx_hash) WHERE tx_hash IS NOT NULL;
  `);

  return {
    _raw: () => raw,
    getBounty: (id) => raw.prepare("SELECT * FROM bounties WHERE id = ?").get(id),
  };
}

function insertBounty(db, partial = {}) {
  const raw = db._raw();
  const cols = {
    title: "Test bounty",
    reward_xrd: 100,
    creator_tg_id: 1,
    creator_address: CREATOR_A,
    escrow_version: 3,
    funded: 0,
    ...partial,
  };
  return raw
    .prepare(
      "INSERT INTO bounties (title, reward_xrd, creator_tg_id, creator_address, escrow_version, funded, onchain_task_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      cols.title,
      cols.reward_xrd,
      cols.creator_tg_id,
      cols.creator_address,
      cols.escrow_version,
      cols.funded,
      cols.onchain_task_id || null
    ).lastInsertRowid;
}

// PULL-shaped TaskCreatedEvent fields — programmatic JSON with field_name keys,
// in struct order (guild-saas escrow lib.rs TaskCreatedEvent).
function pullEventFields(overrides = {}) {
  return [
    { field_name: "task_id", value: String(overrides.task_id ?? 42) },
    { field_name: "poster", value: overrides.creator ?? CREATOR_A },
    { field_name: "reward_token", value: overrides.resource ?? XRD_RESOURCE },
    { field_name: "reward_amount", value: overrides.amount ?? "100" },
    { field_name: "insurance_amount", value: "10" },
    { field_name: "arbiter_fee_pct", value: "5" },
    { field_name: "work_brief_hash", value: "deadbeef".repeat(8) },
  ];
}

// Stub gateway response. Pass overrides for any of: amount, resource, creator,
// task_id, escrow_version, status. By default: V3, 100 XRD, CREATOR_A.
function stubFetcher(overrides = {}) {
  return async () => {
    const version = overrides.escrow_version ?? 3;
    const component =
      version === 4 ? ESCROW_PULL_COMPONENT :
      version === 3 ? ESCROW_V3_COMPONENT : ESCROW_V1_COMPONENT;
    const fields = version === 4
      ? pullEventFields(overrides)
      : version === 3
      ? [
          { value: String(overrides.task_id ?? 42) },
          { value: overrides.amount ?? "100" },
          { value: overrides.resource ?? XRD_RESOURCE },
          { value: overrides.creator ?? CREATOR_A },
        ]
      : [
          { value: String(overrides.task_id ?? 42) },
          { value: overrides.amount ?? "100" },
          { value: overrides.creator ?? CREATOR_A },
        ];
    const tx = overrides.txOverride || {
      transaction_status: overrides.status || "CommittedSuccess",
      affected_global_entities: [component],
      receipt: {
        events: [
          {
            name: "TaskCreatedEvent",
            emitter: { entity: { entity_address: component } },
            data: { fields },
          },
        ],
      },
    };
    return {
      ok: true,
      json: async () => ({ transaction: tx }),
    };
  };
}

// ── parseTaskCreatedEvent unit tests ─────────────────────────────────────

test("parseTaskCreatedEvent: V3 layout = [task_id, amount, resource, creator]", () => {
  const parsed = parseTaskCreatedEvent(
    [
      { value: "7" },
      { value: "250" },
      { value: XRD_RESOURCE },
      { value: CREATOR_A },
    ],
    3
  );
  assert.deepEqual(parsed, {
    task_id: 7,
    amount: "250",
    resource: XRD_RESOURCE,
    creator: CREATOR_A,
  });
});

test("parseTaskCreatedEvent: V1 layout = [task_id, amount, creator] (resource defaults to XRD)", () => {
  const parsed = parseTaskCreatedEvent(
    [
      { value: "12" },
      { value: "50" },
      { value: CREATOR_B },
    ],
    1
  );
  assert.deepEqual(parsed, {
    task_id: 12,
    amount: "50",
    resource: XRD_RESOURCE,
    creator: CREATOR_B,
  });
});

test("parseTaskCreatedEvent: empty fields → null", () => {
  assert.equal(parseTaskCreatedEvent([], 3), null);
  assert.equal(parseTaskCreatedEvent([], 1), null);
});

test("parseTaskCreatedEvent: V3 with too few fields → null", () => {
  assert.equal(parseTaskCreatedEvent([{ value: "1" }, { value: "2" }, { value: "3" }], 3), null);
});

test("parseTaskCreatedEvent: PULL (v4) parses by field name in struct order", () => {
  const parsed = parseTaskCreatedEvent(
    pullEventFields({ task_id: 9, amount: "1500", creator: CREATOR_B }),
    4
  );
  assert.deepEqual(parsed, {
    task_id: 9,
    amount: "1500",
    resource: XRD_RESOURCE,
    creator: CREATOR_B,
  });
});

test("parseTaskCreatedEvent: PULL (v4) is order-independent — scrambled fields parse identically", () => {
  const scrambled = pullEventFields({ task_id: 9, amount: "1500", creator: CREATOR_B }).reverse();
  const parsed = parseTaskCreatedEvent(scrambled, 4);
  assert.deepEqual(parsed, {
    task_id: 9,
    amount: "1500",
    resource: XRD_RESOURCE,
    creator: CREATOR_B,
  });
});

test("parseTaskCreatedEvent: PULL (v4) with positional (unnamed) fields → null, never a positional guess", () => {
  const positional = pullEventFields().map(({ value }) => ({ value }));
  assert.equal(parseTaskCreatedEvent(positional, 4), null);
});

test("parseTaskCreatedEvent: PULL (v4) missing reward_amount → null", () => {
  const fields = pullEventFields().filter((f) => f.field_name !== "reward_amount");
  assert.equal(parseTaskCreatedEvent(fields, 4), null);
});

// ── amountsMatch unit tests ──────────────────────────────────────────────

test("amountsMatch: exact integer", () => {
  assert.equal(amountsMatch("100", 100), true);
});

test("amountsMatch: within sub-epsilon precision drift", () => {
  assert.equal(amountsMatch("100.0000001", 100), true);
});

test("amountsMatch: above epsilon → false", () => {
  assert.equal(amountsMatch("100.01", 100), false);
});

test("amountsMatch: 1 XRD vs 1000 XRD → false (the C3 attack)", () => {
  assert.equal(amountsMatch("1", 1000), false);
});

test("amountsMatch: NaN/garbage → false", () => {
  assert.equal(amountsMatch("hello", 100), false);
  assert.equal(amountsMatch(undefined, 100), false);
});

// ── validateAndLinkFunding integration tests ────────────────────────────

test("happy path: V3 bounty, matching amount/creator/resource → funded=1", async () => {
  const db = freshDb();
  const id = insertBounty(db, { reward_xrd: 100, creator_address: CREATOR_A, escrow_version: 3 });

  const result = await validateAndLinkFunding(db, id, "tx_hash_aaaa_1111111111", {
    actorTgId: 5,
    fetcher: stubFetcher({ amount: "100", creator: CREATOR_A, task_id: 42 }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.taskId, 42);
  assert.equal(result.escrowVersion, 3);

  const row = db.getBounty(id);
  assert.equal(row.funded, 1);
  assert.equal(row.escrow_verified, 1);
  assert.equal(row.onchain_task_id, 42);
  assert.equal(row.escrow_component, ESCROW_V3_COMPONENT);

  const txRow = db._raw().prepare("SELECT * FROM bounty_transactions WHERE bounty_id = ?").get(id);
  assert.equal(txRow.tx_hash, "tx_hash_aaaa_1111111111");
  assert.equal(txRow.actor_tg_id, 5);
  assert.equal(txRow.verified_onchain, 1);
  assert.equal(txRow.escrow_component, ESCROW_V3_COMPONENT);
});

test("C3: amount mismatch (1 XRD on-chain, 1000 XRD bounty) → reject", async () => {
  const db = freshDb();
  const id = insertBounty(db, { reward_xrd: 1000 });

  const result = await validateAndLinkFunding(db, id, "tx_hash_amount_mismatch_1", {
    fetcher: stubFetcher({ amount: "1" }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "amount_mismatch");
  assert.equal(db.getBounty(id).funded, 0);
});

test("C3: creator mismatch → reject", async () => {
  const db = freshDb();
  const id = insertBounty(db, { creator_address: CREATOR_A });

  const result = await validateAndLinkFunding(db, id, "tx_hash_creator_mismatch_1", {
    fetcher: stubFetcher({ creator: CREATOR_B }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "creator_mismatch");
});

test("C3: V3 bounty funded with V1 deposit → reject (version mismatch)", async () => {
  const db = freshDb();
  const id = insertBounty(db, { escrow_version: 3 });

  const result = await validateAndLinkFunding(db, id, "tx_hash_version_mismatch_1", {
    fetcher: stubFetcher({ escrow_version: 1 }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "escrow_version_mismatch");
});

test("C3: V3 deposit of non-XRD resource for XRD bounty → reject", async () => {
  const db = freshDb();
  const id = insertBounty(db, { escrow_version: 3 });
  const someUsdc = "resource_rdx1tknxxxxxxxxxxusdcxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

  const result = await validateAndLinkFunding(db, id, "tx_hash_resource_mismatch_1", {
    fetcher: stubFetcher({ resource: someUsdc }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "resource_mismatch");
});

test("replay: same tx_hash funding two different bounties → second rejected", async () => {
  const db = freshDb();
  const idA = insertBounty(db, { reward_xrd: 100 });
  const idB = insertBounty(db, { reward_xrd: 100 });

  const r1 = await validateAndLinkFunding(db, idA, "tx_hash_replay_aaaa_1111", {
    fetcher: stubFetcher({ task_id: 100 }),
  });
  assert.equal(r1.ok, true);

  const r2 = await validateAndLinkFunding(db, idB, "tx_hash_replay_aaaa_1111", {
    fetcher: stubFetcher({ task_id: 101 }),
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, "tx_hash_already_used");
});

test("replay: same on-chain task_id linked to two bounties → second rejected", async () => {
  const db = freshDb();
  const idA = insertBounty(db, { reward_xrd: 100 });
  const idB = insertBounty(db, { reward_xrd: 100 });

  const r1 = await validateAndLinkFunding(db, idA, "tx_hash_taskid_aaaa_1111", {
    fetcher: stubFetcher({ task_id: 999 }),
  });
  assert.equal(r1.ok, true);

  const r2 = await validateAndLinkFunding(db, idB, "tx_hash_taskid_bbbb_2222", {
    fetcher: stubFetcher({ task_id: 999 }),
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, "onchain_task_already_linked");
});

test("generations: same task_id on V1 and V3 components are DIFFERENT tasks — both fund", async () => {
  const db = freshDb();
  const idA = insertBounty(db, { reward_xrd: 100, escrow_version: 3 });
  const idB = insertBounty(db, { reward_xrd: 100, escrow_version: null });

  const r1 = await validateAndLinkFunding(db, idA, "tx_hash_gen_v3_aaaa_1111", {
    fetcher: stubFetcher({ task_id: 7, escrow_version: 3 }),
  });
  assert.equal(r1.ok, true);

  const r2 = await validateAndLinkFunding(db, idB, "tx_hash_gen_v1_bbbb_2222", {
    fetcher: stubFetcher({ task_id: 7, escrow_version: 1 }),
  });
  assert.equal(r2.ok, true, "colliding task id on a different generation must not block: " + JSON.stringify(r2));
  assert.equal(db.getBounty(idA).escrow_component, ESCROW_V3_COMPONENT);
  assert.equal(db.getBounty(idB).escrow_component, ESCROW_V1_COMPONENT);
});

test("generations: a pre-column legacy row (escrow_component NULL) still blocks a legacy-generation deposit with the same task_id", async () => {
  const db = freshDb();
  // Legacy V3 link written before the column existed.
  insertBounty(db, { reward_xrd: 50, escrow_version: 3, onchain_task_id: 13 });
  const idB = insertBounty(db, { reward_xrd: 100, escrow_version: 3 });

  const r = await validateAndLinkFunding(db, idB, "tx_hash_gen_null_cccc_33", {
    fetcher: stubFetcher({ task_id: 13, escrow_version: 3 }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "onchain_task_already_linked");
});

test("PULL happy path: v4 bounty + PULL deposit → funded, escrow_component stamped", async () => {
  const db = freshDb();
  const id = insertBounty(db, { reward_xrd: 1500, creator_address: CREATOR_A, escrow_version: 4 });

  const result = await validateAndLinkFunding(db, id, "tx_hash_pull_happy_1111", {
    actorTgId: 5,
    fetcher: stubFetcher({ escrow_version: 4, amount: "1500", creator: CREATOR_A, task_id: 1 }),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.taskId, 1);
  assert.equal(result.escrowVersion, 4);

  const row = db.getBounty(id);
  assert.equal(row.funded, 1);
  assert.equal(row.escrow_verified, 1);
  assert.equal(row.onchain_task_id, 1);
  assert.equal(row.escrow_component, ESCROW_PULL_COMPONENT);

  const txRow = db._raw().prepare("SELECT * FROM bounty_transactions WHERE bounty_id = ?").get(id);
  assert.equal(txRow.escrow_component, ESCROW_PULL_COMPONENT);
  assert.equal(txRow.onchain_task_id, 1);
});

test("PULL: stale v3 bounty + PULL deposit → escrow_version_mismatch (fails closed)", async () => {
  const db = freshDb();
  const id = insertBounty(db, { escrow_version: 3 });

  const result = await validateAndLinkFunding(db, id, "tx_hash_pull_stale_v3_1", {
    fetcher: stubFetcher({ escrow_version: 4 }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "escrow_version_mismatch");
  assert.equal(db.getBounty(id).funded, 0);
});

test("PULL generations: legacy NULL-component row with the same task_id does NOT block a PULL deposit", async () => {
  const db = freshDb();
  // Pre-column legacy link (escrow_component NULL) holding on-chain task 1.
  insertBounty(db, { reward_xrd: 50, escrow_version: 3, onchain_task_id: 1 });
  const idB = insertBounty(db, { reward_xrd: 1500, escrow_version: 4 });

  const r = await validateAndLinkFunding(db, idB, "tx_hash_pull_gen_aaaa_1", {
    fetcher: stubFetcher({ escrow_version: 4, amount: "1500", task_id: 1 }),
  });
  assert.equal(r.ok, true, "PULL task ids restart from 1 — legacy NULL rows must not claim them: " + JSON.stringify(r));
  assert.equal(db.getBounty(idB).escrow_component, ESCROW_PULL_COMPONENT);
});

test("idempotency: re-funding an already-funded bounty → reject", async () => {
  const db = freshDb();
  const id = insertBounty(db, { reward_xrd: 100, funded: 1 });

  const result = await validateAndLinkFunding(db, id, "tx_hash_already_funded_1", {
    fetcher: stubFetcher(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "already_funded");
});

test("not found: bounty id that doesn't exist → reject", async () => {
  const db = freshDb();
  const result = await validateAndLinkFunding(db, 9999, "tx_hash_no_bounty_1234", {
    fetcher: stubFetcher(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_found");
});

test("verification fail: gateway says CommittedFailure → reject + no DB change", async () => {
  const db = freshDb();
  const id = insertBounty(db, { reward_xrd: 100 });

  const result = await validateAndLinkFunding(db, id, "tx_hash_failed_1234567890", {
    fetcher: stubFetcher({ status: "CommittedFailure" }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "verification_failed");
  assert.equal(result.detail, "tx_failed");
  assert.equal(db.getBounty(id).funded, 0);
});

test("legacy bounty (creator_address NULL) is grandfathered through with warning", async () => {
  const db = freshDb();
  const id = insertBounty(db, { creator_address: null });

  const result = await validateAndLinkFunding(db, id, "tx_hash_legacy_aaa_111", {
    fetcher: stubFetcher({ creator: CREATOR_B }),
  });

  assert.equal(result.ok, true);
  assert.ok(result.creatorWarning, "expected creatorWarning for legacy row");
  assert.equal(db.getBounty(id).funded, 1);
});

test("V1 bounty (escrow_version NULL = legacy) accepts V1 deposit", async () => {
  const db = freshDb();
  const id = insertBounty(db, { escrow_version: null });

  const result = await validateAndLinkFunding(db, id, "tx_hash_v1_legacy_1234", {
    fetcher: stubFetcher({ escrow_version: 1 }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.escrowVersion, 1);
});

test("missing tx_hash → reject", async () => {
  const db = freshDb();
  const id = insertBounty(db);
  const result = await validateAndLinkFunding(db, id, "", { fetcher: stubFetcher() });
  assert.equal(result.ok, false);
  assert.equal(result.error, "tx_hash_required");
});
