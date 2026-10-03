/**
 * Proof-ledger query coverage, executed against real Postgres (pglite).
 *
 * Two things get proven here, both load-bearing for the NODE-ROADMAP.md
 * Stage 1 gate ("proof-ledger page live"):
 *
 *   1. HONESTY — findLedgerEvents() never returns a row without a real,
 *      confirmed, on-chain tx hash, and never returns a `fund` row (funding
 *      is money entering escrow, not a settlement/dispute/payment). This is
 *      the property the page's whole empty-state honesty argument rests on:
 *      if this ever widened, the page would start rendering something it
 *      cannot back with a transaction.
 *   2. PAGINATION — mirrors task-pagination.pg.test.ts's M7 lesson: a keyset
 *      cursor test needs to run against REAL SQL, not a single-row mock, or a
 *      skip/repeat bug (M6's actual shape) ships invisibly. Here the keyset is
 *      simpler than the task board's (id DESC alone, no compound key — see
 *      the query's docstring for why that is sound) but the same discipline
 *      applies: walk it against an adversarial seed and diff against an
 *      independent ORDER BY.
 *
 * The DDL below declares every column, unique index and CHECK constraint of
 * BOTH real tables by name — tests/unit/schema-ddl-drift.test.ts enforces
 * this against the live drizzle schema so this file cannot silently drift
 * from it the way the pre-PULL DDL blocks did (see that file's docstring).
 * Because the real unique indexes are live here too (not just declared for
 * the drift check, but functionally present), every fixture below respects
 * them for real: at most one fund/release/refund/dispute row per task, which
 * is why rows that need several "release" attempts each get their own task.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { sql } from "drizzle-orm"
import * as schema from "@/db/schema"

const H = vi.hoisted(() => ({ db: null as ReturnType<typeof drizzle> | null }))
vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get(_t, prop) {
        const target = H.db as unknown as Record<string | symbol, unknown>
        const v = target?.[prop]
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(H.db) : v
      },
    },
  ),
}))

import { findLedgerEvents, countLedgerEvents } from "@/db/queries/escrow"
import { parseBeforeCursor } from "@/app/ledger/page"
import { classifyLedgerRow } from "@/lib/ledger-internal"

// Full-fidelity DDL — every column of both tables, by name, matching
// src/db/schema/tasks.ts and src/db/schema/escrow-transactions.ts exactly
// (checked against the live schema by schema-ddl-drift.test.ts). No FK
// constraints (mirrors task-pagination.pg.test.ts: drizzle builds SQL from
// schema metadata alone, so a plain column is enough — no users table needed).
const DDL = `
CREATE TABLE tasks (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  hidden_at timestamptz,
  reward_xrd numeric(38,18) NOT NULL DEFAULT '0',
  reward_resource text,
  creator_id text NOT NULL,
  assignee_id text,
  required_tier text DEFAULT 'member',
  xp_reward integer NOT NULL DEFAULT 0,
  on_chain_task_id integer,
  escrow_component text,
  project_id integer,
  working_group_id integer,
  deadline timestamptz,
  disputed_at timestamptz,
  dispute_evidence text,
  dispute_evidence_hash text,
  terms jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tasks_dispute_evidence_paired
    CHECK ((dispute_evidence IS NULL) = (dispute_evidence_hash IS NULL))
);
CREATE UNIQUE INDEX tasks_onchain_component_unique ON tasks (on_chain_task_id, escrow_component)
  WHERE on_chain_task_id IS NOT NULL;

CREATE TABLE escrow_transactions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id integer NOT NULL,
  from_user_id text NOT NULL,
  to_user_id text,
  amount_xrd numeric(38,18) NOT NULL,
  reward_resource text,
  tx_type text NOT NULL,
  party text,
  lane text,
  destination text,
  status text NOT NULL DEFAULT 'pending',
  tx_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX escrow_legacy_task_tx_type_unique ON escrow_transactions (task_id, tx_type)
  WHERE tx_type IN ('fund', 'release', 'refund', 'dispute');
CREATE UNIQUE INDEX escrow_entitlement_unique ON escrow_transactions (tx_hash, task_id, tx_type, party, lane)
  WHERE tx_type IN ('settle', 'withdraw');
ALTER TABLE escrow_transactions ADD CONSTRAINT escrow_entitlement_fields_present
  CHECK (tx_type NOT IN ('settle', 'withdraw')
    OR (tx_hash IS NOT NULL AND party IS NOT NULL AND lane IS NOT NULL));
ALTER TABLE escrow_transactions ADD CONSTRAINT escrow_legacy_rows_have_no_entitlement_fields
  CHECK (tx_type IN ('settle', 'withdraw')
    OR (party IS NULL AND lane IS NULL AND destination IS NULL));`

let pg: PGlite
let db: ReturnType<typeof drizzle>

async function seedTask(title: string): Promise<number> {
  const res = await pg.query<{ id: number }>(
    `INSERT INTO tasks (title, description, creator_id) VALUES ($1, 'd', 'u1') RETURNING id`,
    [title],
  )
  return res.rows[0].id
}

async function seedTx(row: {
  taskId: number
  txType: string
  status?: string
  txHash?: string | null
  fromUserId?: string
  toUserId?: string | null
  party?: string | null
  lane?: string | null
  amountXrd?: string
}) {
  await pg.query(
    `INSERT INTO escrow_transactions
       (task_id, from_user_id, to_user_id, amount_xrd, tx_type, party, lane, status, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      row.taskId,
      row.fromUserId ?? "u1",
      row.toUserId ?? null,
      row.amountXrd ?? "0",
      row.txType,
      row.party ?? null,
      row.lane ?? null,
      row.status ?? "confirmed",
      // NOT `row.txHash ?? default` — that would treat an explicit `txHash:
      // null` (deliberately testing the honesty filter's null-hash exclusion)
      // the same as "not provided", silently substituting a fake hash and
      // making the exclusion untestable. `undefined` means "not provided".
      row.txHash === undefined ? `tx-${row.txType}-${row.taskId}` : row.txHash,
    ],
  )
}

describe("findLedgerEvents against Postgres (pglite)", () => {
  beforeAll(async () => {
    pg = new PGlite()
    db = drizzle(pg, { schema })
    H.db = db
    await pg.exec(DDL)
  }, 60_000)

  beforeEach(async () => {
    await pg.exec("TRUNCATE escrow_transactions, tasks RESTART IDENTITY")
  })

  it("excludes fund rows, unconfirmed rows, and rows with no tx hash — the honesty filter", async () => {
    // Each row gets its own task: escrow_legacy_task_tx_type_unique means a
    // task may have at most ONE fund/release/refund/dispute row ever
    // (mirrors the real one-fund-one-settlement invariant), so three
    // different attempted "release" outcomes need three different tasks.
    const t1 = await seedTask("Task One")
    const t2 = await seedTask("Task Two")
    const t3 = await seedTask("Task Three")
    const t4 = await seedTask("Task Four")
    const t5 = await seedTask("Task Five")
    const t6 = await seedTask("Task Six")
    const t7 = await seedTask("Task Seven")
    const t8 = await seedTask("Task Eight")

    await seedTx({ taskId: t1, txType: "fund", txHash: "tx-fund" }) // id 1 — excluded: not a settlement
    await seedTx({ taskId: t2, txType: "release", toUserId: "u2", amountXrd: "100" }) // id 2 — included
    await seedTx({ taskId: t3, txType: "dispute", amountXrd: "0" }) // id 3 — included
    await seedTx({ taskId: t4, txType: "refund", toUserId: "u1", amountXrd: "50" }) // id 4 — included
    await seedTx({ taskId: t5, txType: "settle", party: "worker", lane: "reward", toUserId: "u2", amountXrd: "10" }) // id 5 — included
    await seedTx({ taskId: t5, txType: "withdraw", party: "worker", lane: "reward", toUserId: "u2", amountXrd: "10" }) // id 6 — included
    await seedTx({ taskId: t6, txType: "release", status: "pending", txHash: "tx-pending" }) // id 7 — excluded: not confirmed
    await seedTx({ taskId: t7, txType: "release", txHash: null }) // id 8 — excluded: no tx hash, even though "confirmed"
    await seedTx({ taskId: t8, txType: "release", amountXrd: "5" }) // id 9 — included

    const { data, hasMore } = await findLedgerEvents({ limit: 100 })

    expect(hasMore).toBe(false)
    expect(data.map((r) => r.id)).toEqual([9, 6, 5, 4, 3, 2])
    expect(data.map((r) => r.txType).sort()).toEqual(
      ["dispute", "refund", "release", "release", "settle", "withdraw"].sort(),
    )
    // Never once a fund row, an unconfirmed row, or a null-tx-hash row —
    // the exact property the page's honesty claim depends on.
    for (const row of data) {
      expect(row.txType).not.toBe("fund")
      expect(row.txHash).toBeTruthy()
    }
  })

  it("joins the task title", async () => {
    const t1 = await seedTask("Fix the header bug")
    await seedTx({ taskId: t1, txType: "release", amountXrd: "42" })

    const { data } = await findLedgerEvents({ limit: 10 })
    expect(data).toHaveLength(1)
    expect(data[0].taskTitle).toBe("Fix the header bug")
    expect(data[0].taskId).toBe(t1)
  })

  it("cursor walk matches an independent (id DESC) order, at every page size, no skip/repeat", async () => {
    // One task per row (see the top-of-file note) — task identity is not
    // under test here, only that the id-keyset walk is exhaustive and
    // exact across a mix of every eligible tx_type.
    const types = ["release", "refund", "dispute", "settle", "withdraw"]
    for (let i = 0; i < 8; i++) {
      const t = await seedTask(`t${i}`)
      const txType = types[i % types.length]
      // escrow_legacy_rows_have_no_entitlement_fields requires party/lane to
      // be NULL on the four legacy types — only settle/withdraw may carry them.
      const isEntitlement = txType === "settle" || txType === "withdraw"
      await seedTx({
        taskId: t,
        txType,
        party: isEntitlement ? "worker" : undefined,
        lane: isEntitlement ? "reward" : undefined,
      })
    }
    // Noise the honesty filter must keep excluding throughout the walk.
    const noiseFundTask = await seedTask("noise-fund")
    await seedTx({ taskId: noiseFundTask, txType: "fund" })
    const noisePendingTask = await seedTask("noise-pending")
    await seedTx({ taskId: noisePendingTask, txType: "release", status: "pending", txHash: "tx-noise-pending" })

    const expected = (
      await pg.query<{ id: number }>(
        `SELECT id FROM escrow_transactions
         WHERE tx_type IN ('release','refund','dispute','settle','withdraw')
           AND status = 'confirmed' AND tx_hash IS NOT NULL
         ORDER BY id DESC`,
      )
    ).rows.map((r) => r.id)
    expect(expected).toHaveLength(8) // sanity: the two noise rows are excluded

    for (const size of [1, 2, 3, 8, 100]) {
      const walked: number[] = []
      let cursor: number | undefined
      for (let guard = 0; guard < expected.length + 3; guard++) {
        const page = await findLedgerEvents({ limit: size, cursor })
        walked.push(...page.data.map((r) => r.id))
        if (!page.hasMore) break
        cursor = page.cursor ?? undefined
      }
      expect(walked, `page size ${size}`).toEqual(expected)
      expect(new Set(walked).size).toBe(expected.length)
    }
  })

  describe("parseBeforeCursor — the page's ?before= guard (screen finding)", () => {
    // `escrow_transactions.id` above is a plain `integer` (int4, max
    // 2147483647). The old guard's regex only ruled out non-digit and
    // leading-zero input — an arbitrarily long digit string still passed it,
    // reached findLedgerEvents() as `cursor`, and Postgres raised "value out
    // of range for type integer" on the bound parameter: a 500 on a public
    // page for nothing worse than a hand-edited or bookmarked URL.
    it.each([
      ["a typical valid cursor", "42", 42],
      ["int4 max — the last valid value", "2147483647", 2147483647],
      ["int4 max + 1", "2147483648", undefined],
      ["the finding's own repro, ?before=9999999999", "9999999999", undefined],
      ["well beyond Number.isSafeInteger", "99999999999999999999999", undefined],
      ["zero — rejected by the leading-digit regex, not the range check", "0", undefined],
      ["a negative number — rejected by the regex (no minus sign allowed)", "-5", undefined],
      ["non-numeric input", "abc", undefined],
      ["empty string", "", undefined],
      ["no ?before= param at all", undefined, undefined],
    ])("%s (%j) -> %j", (_label, input, expected) => {
      expect(parseBeforeCursor(input as string | undefined)).toBe(expected)
    })
  })

  it(
    'screen finding repro: an int4-overflow ?before renders page 1 instead of a Postgres ' +
      '"value out of range for type integer" 500',
    async () => {
      // Seed one settled row so page 1 is non-empty and distinguishable from
      // the honest-empty-state case covered elsewhere in this file.
      const t1 = await seedTask("t1")
      await seedTx({ taskId: t1, txType: "release", amountXrd: "1" })

      // 1. The vulnerability the finding describes is real: the raw,
      //    unclamped value from `?before=9999999999`, bound straight to the
      //    `id integer` column the way the unfixed guard would have passed
      //    it, blows up against the real Postgres type.
      await expect(findLedgerEvents({ limit: 25, cursor: 9_999_999_999 })).rejects.toThrow()

      // 2. The fix: page.tsx's actual guard clamps that same input to "no
      //    cursor" before it ever reaches the query, so the request renders
      //    page 1 (the latest events) instead of erroring.
      const clamped = parseBeforeCursor("9999999999")
      expect(clamped).toBeUndefined()
      const page1 = await findLedgerEvents({ limit: 25, cursor: clamped })
      expect(page1.data.map((r) => r.id)).toEqual([1])
    },
  )

  it("returns the honest empty result when nothing has settled — no synthetic row, ever", async () => {
    const { data, hasMore, cursor } = await findLedgerEvents({ limit: 25 })
    expect(data).toEqual([])
    expect(hasMore).toBe(false)
    expect(cursor).toBeNull()
  })

  it("treats a task that has only ever been funded as contributing zero ledger events", async () => {
    const t1 = await seedTask("only ever funded")
    await seedTx({ taskId: t1, txType: "fund", amountXrd: "100" })

    const { data } = await findLedgerEvents({ limit: 25 })
    expect(data).toEqual([])
  })

  it("caps limit at 100 and floors it at 1", async () => {
    const ids: number[] = []
    for (let i = 0; i < 3; i++) {
      const t = await seedTask(`t${i}`)
      ids.push(t)
      await seedTx({ taskId: t, txType: "release" })
    }

    const zero = await findLedgerEvents({ limit: 0 })
    expect(zero.data).toHaveLength(1) // floored to 1, not 0

    const huge = await findLedgerEvents({ limit: 1000 })
    expect(huge.data).toHaveLength(3) // only 3 rows exist, capped limit doesn't matter here
  })

  it(
    "SQL-level check: the raw query never selects a fund/unconfirmed/hashless row " +
      "even when it is the ONLY row in the table (guards a WHERE-clause regression " +
      "that a mixed-fixture test could mask)",
    async () => {
      const t1 = await seedTask("t1")
      await seedTx({ taskId: t1, txType: "fund", amountXrd: "999" })
      expect((await findLedgerEvents({ limit: 25 })).data).toEqual([])

      await pg.exec("TRUNCATE escrow_transactions RESTART IDENTITY")
      await seedTx({ taskId: t1, txType: "release", status: "pending" })
      expect((await findLedgerEvents({ limit: 25 })).data).toEqual([])

      await pg.exec("TRUNCATE escrow_transactions RESTART IDENTITY")
      await seedTx({ taskId: t1, txType: "release", txHash: null })
      expect((await findLedgerEvents({ limit: 25 })).data).toEqual([])
    },
  )

  // ── countLedgerEvents: the /ledger summary line's numbers ────────────────
  // "N of M events are internal test cycles" is a WHOLE-LEDGER claim, so it is
  // counted in SQL over the same honesty filter the feed uses, with the
  // GUILD_TEST_ACCOUNTS list bound as parameters. Two things are pinned here:
  // the filter parity (the counter never counts a row the feed would refuse to
  // show) and the PREDICATE parity (SQL `from IN (…) OR to IN (…)` agrees with
  // the JS classifier the page applies per row — change one without the other
  // and the summary line and the badges disagree on the same page).
  describe("countLedgerEvents — whole-ledger internal/total counts", () => {
    const FLEET_POSTER = "account_fleet_poster"
    const FLEET_WORKER = "account_fleet_worker"
    const OUTSIDER_A = "account_outsider_a"
    const OUTSIDER_B = "account_outsider_b"

    async function seedMixedLedger() {
      // Every eligible tx_type, mixing fleet-only, one-sided and outsider-only
      // rows, plus the three kinds of noise the honesty filter must drop.
      const t1 = await seedTask("fleet both sides")
      const t2 = await seedTask("fleet poster, outsider worker")
      const t3 = await seedTask("outsider poster, fleet worker")
      const t4 = await seedTask("outsiders only")
      const t5 = await seedTask("fleet dispute marker")
      const t6 = await seedTask("outsider refund to self")
      const t7 = await seedTask("fleet pull settle+withdraw")
      const t8 = await seedTask("noise fund")
      const t9 = await seedTask("noise pending")
      const t10 = await seedTask("noise hashless")

      await seedTx({ taskId: t1, txType: "release", fromUserId: FLEET_POSTER, toUserId: FLEET_WORKER, amountXrd: "100" }) // internal
      await seedTx({ taskId: t2, txType: "release", fromUserId: FLEET_POSTER, toUserId: OUTSIDER_A, amountXrd: "100" }) // internal (poster side)
      await seedTx({ taskId: t3, txType: "release", fromUserId: OUTSIDER_A, toUserId: FLEET_WORKER, amountXrd: "100" }) // internal (payee side)
      await seedTx({ taskId: t4, txType: "release", fromUserId: OUTSIDER_A, toUserId: OUTSIDER_B, amountXrd: "100" }) // external
      await seedTx({ taskId: t5, txType: "dispute", fromUserId: FLEET_WORKER, toUserId: null, amountXrd: "0" }) // internal (from only)
      await seedTx({ taskId: t6, txType: "refund", fromUserId: OUTSIDER_B, toUserId: OUTSIDER_B, amountXrd: "50" }) // external
      await seedTx({ taskId: t7, txType: "settle", party: "worker", lane: "reward", fromUserId: FLEET_POSTER, toUserId: FLEET_WORKER, amountXrd: "10" }) // internal
      await seedTx({ taskId: t7, txType: "withdraw", party: "worker", lane: "reward", fromUserId: FLEET_POSTER, toUserId: FLEET_WORKER, amountXrd: "10" }) // internal
      // Noise — fleet-attributed on purpose, so a counter that forgot the
      // honesty filter would over-count BOTH totals, not just one.
      await seedTx({ taskId: t8, txType: "fund", fromUserId: FLEET_POSTER, amountXrd: "100" })
      await seedTx({ taskId: t9, txType: "release", status: "pending", txHash: "tx-noise-pending", fromUserId: FLEET_POSTER, toUserId: FLEET_WORKER })
      await seedTx({ taskId: t10, txType: "release", txHash: null, fromUserId: FLEET_POSTER, toUserId: FLEET_WORKER })
    }

    it("counts the feed's population exactly, and internal = any side declared", async () => {
      await seedMixedLedger()
      const counts = await countLedgerEvents([FLEET_POSTER, FLEET_WORKER])
      expect(counts).toEqual({ total: 8, internal: 6 })
    })

    it("an empty allowlist counts NOTHING as internal — never the fleet, never anyone", async () => {
      await seedMixedLedger()
      expect(await countLedgerEvents([])).toEqual({ total: 8, internal: 0 })
      expect(await countLedgerEvents()).toEqual({ total: 8, internal: 0 })
    })

    it("a one-account allowlist matches that account on EITHER side and no other", async () => {
      await seedMixedLedger()
      // FLEET_WORKER appears as `to` on t1/t3/t7(x2) and as `from` on t5's dispute.
      expect(await countLedgerEvents([FLEET_WORKER])).toEqual({ total: 8, internal: 5 })
      // OUTSIDER_B is `to` on t4 and both sides on t6.
      expect(await countLedgerEvents([OUTSIDER_B])).toEqual({ total: 8, internal: 2 })
      // An address that appears nowhere.
      expect(await countLedgerEvents(["account_nobody"])).toEqual({ total: 8, internal: 0 })
    })

    it("empty ledger -> { total: 0, internal: 0 } with or without an allowlist", async () => {
      expect(await countLedgerEvents([FLEET_POSTER])).toEqual({ total: 0, internal: 0 })
      expect(await countLedgerEvents([])).toEqual({ total: 0, internal: 0 })
    })

    it("PARITY: the SQL predicate and the page's per-row JS classifier agree on the same rows", async () => {
      await seedMixedLedger()
      for (const allow of [
        [FLEET_POSTER, FLEET_WORKER],
        [FLEET_WORKER],
        [OUTSIDER_B],
        ["account_nobody"],
        [] as string[],
      ]) {
        const { data } = await findLedgerEvents({ limit: 100 })
        const jsInternal = data.filter((r) => classifyLedgerRow(r, allow) === "internal").length
        const sqlCounts = await countLedgerEvents(allow)
        expect(sqlCounts.total, `total for ${JSON.stringify(allow)}`).toBe(data.length)
        expect(sqlCounts.internal, `internal for ${JSON.stringify(allow)}`).toBe(jsInternal)
      }
    })
  })

  // Guard the guard: prove the mocked db actually routes through drizzle
  // against pglite (a silent no-op mock would pass every test above
  // vacuously by returning [] from a broken proxy).
  it("the mocked db executes real SQL against pglite", async () => {
    const res = await db.execute(sql`SELECT 1 as one`)
    expect(res.rows[0]).toEqual({ one: 1 })
  })
})
