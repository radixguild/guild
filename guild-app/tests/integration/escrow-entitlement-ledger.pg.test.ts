/**
 * PULL entitlement ledger — the REAL writer against a REAL Postgres (pglite).
 *
 * The unit tests for escrow-entitlements.ts prove the DECODE. Nothing there
 * touches SQL, and the whole difficulty of this migration is in the SQL: the
 * idempotency key is wrong in two different ways that each look right, and both
 * failures are silent (a dropped leg, or a rejected legitimate repeat).
 *
 * So this drives `recordEntitlementLedgerRow` through the actual indexes and
 * CHECK constraints, and asserts the four cases the redesign calls out by name.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { eq } from "drizzle-orm"
import * as schema from "@/db/schema"

const A = vi.hoisted(() => ({ db: null as ReturnType<typeof drizzle> | null }))

vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get(_t, prop) {
        const target = A.db as unknown as Record<string | symbol, unknown>
        const v = target?.[prop]
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(A.db) : v
      },
    },
  ),
}))

import {
  recordEntitlementLedgerRow,
  recordConfirmedEscrowTx,
  findEntitlementRowsByTask,
} from "@/db/queries/escrow"
import { netEntitlements } from "@/lib/escrow-entitlements"
import { tasks, escrowTransactions, users } from "@/db/schema"

const POSTER = "account_rdx12ynlx369poster000000000000000000000000000000000000000000"
const WORKER = "account_rdx12890803worker000000000000000000000000000000000000000000"

// Mirrors src/db/schema — see tests/unit/schema-ddl-drift.test.ts, which fails
// if this block falls behind the drizzle definition.
const DDL = `
CREATE TABLE users (
  id text PRIMARY KEY,
  display_name text,
  badge_id text,
  badge_tier text DEFAULT 'member',
  xp integer NOT NULL DEFAULT 0,
  reputation integer NOT NULL DEFAULT 0,
  is_agent boolean NOT NULL DEFAULT false,
  suspended_at timestamptz,
  suspended_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
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
CREATE UNIQUE INDEX tasks_onchain_component_unique
  ON tasks (on_chain_task_id, escrow_component) WHERE on_chain_task_id IS NOT NULL;
CREATE TABLE escrow_transactions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id integer NOT NULL REFERENCES tasks(id),
  from_user_id text NOT NULL REFERENCES users(id),
  to_user_id text REFERENCES users(id),
  amount_xrd numeric(38,18) NOT NULL,
  reward_resource text,
  tx_type text NOT NULL,
  party text,
  lane text,
  destination text,
  status text NOT NULL DEFAULT 'pending',
  tx_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT escrow_entitlement_fields_present CHECK (
    tx_type NOT IN ('settle', 'withdraw')
    OR (tx_hash IS NOT NULL AND party IS NOT NULL AND lane IS NOT NULL)),
  CONSTRAINT escrow_legacy_rows_have_no_entitlement_fields CHECK (
    tx_type IN ('settle', 'withdraw')
    OR (party IS NULL AND lane IS NULL AND destination IS NULL))
);
CREATE UNIQUE INDEX escrow_legacy_task_tx_type_unique ON escrow_transactions (task_id, tx_type)
  WHERE tx_type IN ('fund', 'release', 'refund', 'dispute');
CREATE UNIQUE INDEX escrow_entitlement_unique ON escrow_transactions (tx_hash, task_id, tx_type, party, lane)
  WHERE tx_type IN ('settle', 'withdraw');`

let taskId: number

beforeAll(async () => {
  const client = new PGlite()
  A.db = drizzle(client, { schema })
  await client.exec(DDL)
})

beforeEach(async () => {
  const db = A.db!
  await db.delete(escrowTransactions)
  await db.delete(tasks)
  await db.delete(users)
  await db.insert(users).values([
    { id: POSTER, displayName: "poster" },
    { id: WORKER, displayName: "worker" },
  ])
  const [t] = await db
    .insert(tasks)
    .values({
      title: "t",
      description: "d",
      rewardXrd: "100",
      status: "paid",
      creatorId: POSTER,
      assigneeId: WORKER,
    })
    .returning()
  taskId = t.id
})

const leg = (over: Partial<Parameters<typeof recordEntitlementLedgerRow>[0]> = {}) => ({
  taskId,
  txType: "withdraw" as const,
  party: "worker" as const,
  lane: "reward" as const,
  fromUserId: POSTER,
  toUserId: WORKER,
  amountXrd: "100",
  txHash: "txid_rdx1withdraw_a",
  ...over,
})

// drizzle-orm >=0.44 wraps every driver error in DrizzleQueryError, whose own
// `.message` is just "Failed query: ...\nparams: ..." — the Postgres error
// text (and the constraint name these tests key on) now lives one level down,
// on the wrapped original error at `.cause`. Match against that so these
// assertions keep proving WHICH constraint fired, not just that something did.
async function expectConstraintViolation(promise: Promise<unknown>, constraint: RegExp) {
  let caught: unknown
  try {
    await promise
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(Error)
  const cause = (caught as { cause?: unknown }).cause
  const message = cause instanceof Error ? cause.message : (caught as Error).message
  expect(message).toMatch(constraint)
}

/**
 * COLUMN PRECISION — the ledger must be able to hold what the chain says.
 *
 * Radix `Decimal` is 18dp. This column was `numeric(18,8)`, so Postgres rounded
 * anything finer ON INSERT: no error, no warning, no way to notice from the
 * application side. That is the worst shape a money bug can take here, because
 * the drift watcher's money-parity pass compares this ledger against the chain
 * to decide whether a payee is still owed — a rounded row and an exact chain
 * value disagree by construction, so the rounding manufactures phantom drift on
 * one side and hides real drift on the other.
 *
 * `escrow-entitlements.ts` does its arithmetic in BigInt at exactly 18dp and
 * calls the results exact. These tests are what make that claim true end to end
 * rather than true only until the first INSERT.
 *
 * Both go red against `numeric(18,8)` — verified by reverting the DDL.
 */
describe("entitlement ledger — column precision", () => {
  it("round-trips a full 18dp amount without rounding it", async () => {
    // 18 decimal places, every one significant, and the tail is what a narrower
    // scale destroys. Chosen so an 8dp column returns a visibly different number
    // rather than an equal-looking one.
    const exact = "33.333333333333333333"

    const { inserted } = await recordEntitlementLedgerRow(leg({ amountXrd: exact }))
    expect(inserted).toBe(true)

    const [row] = await findEntitlementRowsByTask(taskId)
    // String comparison, deliberately: Number("33.333333333333333333") is
    // 33.333333333333336 — a float round-trip would pass a tolerance check while
    // having already lost (and invented) digits.
    expect(row.amountXrd).toBe(exact)
  })

  it("holds an amount above XRD's total supply", async () => {
    // numeric(18,8) is 10 integer digits, i.e. it tops out at 9,999,999,999.99999999
    // — BELOW XRD's ~10.4bn total supply. An out-of-range numeric does not round,
    // it throws, so the old column could refuse a legitimate write outright.
    const { inserted } = await recordEntitlementLedgerRow(
      leg({ amountXrd: "12000000000.5", txHash: "txid_rdx1big" }),
    )
    expect(inserted).toBe(true)

    const [row] = await findEntitlementRowsByTask(taskId)
    // Postgres pads a numeric to its DECLARED scale on the way out, so this reads
    // back padded to 18dp rather than as the "12000000000.5" that went in. The
    // column always did this — it padded to 8dp before — but the width changed
    // with the migration, so it is pinned here rather than left to be rediscovered.
    expect(row.amountXrd).toBe("12000000000.500000000000000000")
    expect(Number(row.amountXrd)).toBe(12000000000.5)
  })

  /**
   * The padding above is only harmless because every consumer normalises. This
   * is the one that has to: `netEntitlements` is what the drift watcher and the
   * withdraw UI both ask "is this payee still owed anything", and a padded string
   * reaching it unnormalised would be a money answer.
   */
  it("the wider padding does not disturb the exact-decimal arithmetic", async () => {
    await recordEntitlementLedgerRow(
      leg({ txType: "settle", amountXrd: "100.5", txHash: "txid_rdx1settle_pad" }),
    )
    await recordEntitlementLedgerRow(
      leg({ txType: "withdraw", amountXrd: "0.25", txHash: "txid_rdx1wd_pad" }),
    )

    const rows = await findEntitlementRowsByTask(taskId)
    // Both rows arrive padded to 18dp out of Postgres...
    expect(rows.every((r) => r.amountXrd.split(".")[1]?.length === 18)).toBe(true)
    // ...and the net is still exact and trimmed, not "100.250000000000000000".
    expect(netEntitlements(rows).worker).toMatchObject({
      credited: "100.5",
      collected: "0.25",
      outstanding: "100.25",
    })
  })
})

describe("entitlement ledger — the idempotency key", () => {
  /**
   * `deposit_both_lanes` calls `take_lane` twice in ONE transaction, and in
   * production the reward token IS XRD, so both legs share a tx_hash AND a
   * resource. A key of (task_id, tx_hash) — the first analysis's answer —
   * swallows the second leg, and the worker is short-paid in the ledger while
   * the chain says they collected in full.
   */
  it("records BOTH lanes of one withdraw tx", async () => {
    const a = await recordEntitlementLedgerRow(leg({ lane: "reward", amountXrd: "100" }))
    const b = await recordEntitlementLedgerRow(leg({ lane: "bond", amountXrd: "5" }))
    expect(a.inserted).toBe(true)
    expect(b.inserted).toBe(true)

    const rows = await findEntitlementRowsByTask(taskId)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.lane).sort()).toEqual(["bond", "reward"])
  })

  /**
   * The other direction. A task can credit the same (task, poster, bond) twice
   * over its life — claim → expire → re-claim → expire — so a key of
   * (task_id, tx_type, party, lane) rejects the SECOND forfeit as a duplicate.
   * Only the tx distinguishes them.
   */
  it("records a legitimate repeat of the same (party, lane) from a different tx", async () => {
    const first = await recordEntitlementLedgerRow(
      leg({ txType: "settle", party: "poster", lane: "bond", txHash: "txid_rdx1expire_1" }),
    )
    const second = await recordEntitlementLedgerRow(
      leg({ txType: "settle", party: "poster", lane: "bond", txHash: "txid_rdx1expire_2" }),
    )
    expect(first.inserted).toBe(true)
    expect(second.inserted).toBe(true)
    expect(await findEntitlementRowsByTask(taskId)).toHaveLength(2)
  })

  /**
   * A THIRD way to get this key wrong, and the one §11b's stated key
   * — (tx_hash, task_id, party, lane) — actually hits. That key is right for
   * withdrawal rows ALONE, which is all it contemplated; once settle rows share
   * the table it drops a leg again.
   *
   * `cancel_task` and `withdraw_poster` are BOTH poster-authorized, so "cancel
   * and refund myself" is one ordinary manifest with one signer — emitting
   * SettlementCredited(poster, reward) and Withdrawal(poster, reward) under a
   * single tx_hash. Without tx_type in the key the withdrawal is swallowed as a
   * duplicate of the credit, and the ledger then reports the poster still owed
   * money they are already holding.
   */
  it("records a settle AND a withdraw for the same party+lane in ONE tx", async () => {
    const ONE_TX = "txid_rdx1cancel_and_collect"
    const credited = await recordEntitlementLedgerRow(
      leg({ txType: "settle", party: "poster", lane: "reward", txHash: ONE_TX }),
    )
    const collected = await recordEntitlementLedgerRow(
      leg({ txType: "withdraw", party: "poster", lane: "reward", txHash: ONE_TX }),
    )
    expect(credited.inserted).toBe(true)
    expect(collected.inserted).toBe(true)
    expect(collected.row.id).not.toBe(credited.row.id)

    const rows = await findEntitlementRowsByTask(taskId)
    expect(rows.map((r) => r.txType).sort()).toEqual(["settle", "withdraw"])
    // And the net is zero — credited then immediately collected.
    const net = netEntitlements(
      rows.map((r) => ({
        txType: r.txType as "settle" | "withdraw",
        party: r.party as "worker" | "poster",
        amountXrd: r.amountXrd,
      })),
    )
    expect(net.poster.outstanding).toBe("0")
  })

  it("is idempotent on a replayed event — same tx, same lane", async () => {
    const first = await recordEntitlementLedgerRow(leg())
    const replay = await recordEntitlementLedgerRow(leg())
    expect(first.inserted).toBe(true)
    // A resync re-run must not double-count money.
    expect(replay.inserted).toBe(false)
    expect(replay.row.id).toBe(first.row.id)
    expect(await findEntitlementRowsByTask(taskId)).toHaveLength(1)
  })
})

describe("entitlement ledger — the legacy invariant survives", () => {
  it("still allows exactly one release row per task", async () => {
    const first = await recordConfirmedEscrowTx({
      taskId,
      txType: "release",
      fromUserId: POSTER,
      toUserId: WORKER,
      amountXrd: "100",
      txHash: "txid_rdx1release",
    })
    const replay = await recordConfirmedEscrowTx({
      taskId,
      txType: "release",
      fromUserId: POSTER,
      toUserId: WORKER,
      amountXrd: "100",
      txHash: "txid_rdx1release_again",
    })
    expect(first.inserted).toBe(true)
    // THE exactly-once XP gate: reputation is awarded on this flag alone.
    expect(replay.inserted).toBe(false)
  })

  it("enforces one release row AT THE INDEX, not just in the writer", async () => {
    // The test above passes even with the index dropped entirely, because
    // recordConfirmedEscrowTx check-then-inserts first — so it proves the writer,
    // NOT the constraint. (Verified by mutation: removing UNIQUE left it green.)
    //
    // The index is what survives CONCURRENT confirms of the same intentHash,
    // which is the case the writer's read cannot cover, and this migration
    // REPLACES that index with a partial one — so a wrong WHERE clause would
    // silently weaken the XP-exactly-once guarantee with every existing test
    // still green. Insert directly to hit the constraint itself.
    await A.db!.insert(escrowTransactions).values({
      taskId,
      fromUserId: POSTER,
      toUserId: WORKER,
      amountXrd: "100",
      txType: "release",
      status: "confirmed",
      txHash: "txid_rdx1release",
    })
    await expectConstraintViolation(
      A.db!.insert(escrowTransactions).values({
        taskId,
        fromUserId: POSTER,
        toUserId: WORKER,
        amountXrd: "100",
        txType: "release",
        status: "confirmed",
        txHash: "txid_rdx1release_concurrent",
      }),
      /escrow_legacy_task_tx_type_unique/,
    )
  })

  it("keeps the legacy partial index covering ALL FOUR legacy types", async () => {
    // A WHERE clause that lost a type would leave that type unguarded — and
    // nothing else in the suite would notice.
    for (const txType of ["fund", "release", "refund", "dispute"] as const) {
      await A.db!.insert(escrowTransactions).values({
        taskId,
        fromUserId: POSTER,
        amountXrd: "1",
        txType,
        status: "confirmed",
        txHash: `txid_rdx1${txType}_1`,
      })
      await expectConstraintViolation(
        A.db!.insert(escrowTransactions).values({
          taskId,
          fromUserId: POSTER,
          amountXrd: "1",
          txType,
          status: "confirmed",
          txHash: `txid_rdx1${txType}_2`,
        }),
        /escrow_legacy_task_tx_type_unique/,
      )
    }
  })

  it("does not let entitlement rows disturb the legacy index", async () => {
    // Many settle/withdraw rows coexist with the one-per-type legacy rows.
    await recordConfirmedEscrowTx({
      taskId,
      txType: "release",
      fromUserId: POSTER,
      toUserId: WORKER,
      amountXrd: "100",
      txHash: "txid_rdx1release",
    })
    await recordEntitlementLedgerRow(
      leg({ txType: "settle", lane: "reward", txHash: "txid_rdx1settle" }),
    )
    await recordEntitlementLedgerRow(
      leg({ txType: "settle", lane: "bond", amountXrd: "5", txHash: "txid_rdx1settle" }),
    )
    await recordEntitlementLedgerRow(
      leg({ txType: "withdraw", lane: "reward", txHash: "txid_rdx1collect" }),
    )

    const all = await A.db!
      .select()
      .from(escrowTransactions)
      .where(eq(escrowTransactions.taskId, taskId))
    expect(all).toHaveLength(4)
  })
})

describe("entitlement ledger — the DB refuses malformed rows", () => {
  it("rejects an entitlement row with a NULL lane", async () => {
    await expectConstraintViolation(
      A.db!.insert(escrowTransactions).values({
        taskId,
        fromUserId: POSTER,
        amountXrd: "1",
        txType: "withdraw",
        party: "worker",
        txHash: "txid_rdx1bad",
      }),
      /escrow_entitlement_fields_present/,
    )
  })

  it("rejects an entitlement row with a NULL tx_hash — which would void the unique index", async () => {
    // Postgres treats NULLs as DISTINCT, so without this CHECK such a row would
    // be silently duplicable and the guard would enforce nothing.
    await expectConstraintViolation(
      A.db!.insert(escrowTransactions).values({
        taskId,
        fromUserId: POSTER,
        amountXrd: "1",
        txType: "withdraw",
        party: "worker",
        lane: "reward",
      }),
      /escrow_entitlement_fields_present/,
    )
  })

  it("rejects a legacy row carrying entitlement columns", async () => {
    await expectConstraintViolation(
      A.db!.insert(escrowTransactions).values({
        taskId,
        fromUserId: POSTER,
        amountXrd: "1",
        txType: "fund",
        party: "worker",
        lane: "reward",
        txHash: "txid_rdx1fund",
      }),
      /escrow_legacy_rows_have_no_entitlement_fields/,
    )
  })
})

describe("settled ≠ withdrawn", () => {
  it("shows outstanding money on a task the DB calls 'paid'", async () => {
    // The §5c condition, end to end: released on chain, worker not actually paid.
    await recordEntitlementLedgerRow(
      leg({ txType: "settle", party: "worker", lane: "reward", amountXrd: "100" }),
    )
    await recordEntitlementLedgerRow(
      leg({ txType: "settle", party: "poster", lane: "reward", amountXrd: "5" }),
    )

    const [task] = await A.db!.select().from(tasks).where(eq(tasks.id, taskId))
    expect(task.status).toBe("paid")

    const rows = await findEntitlementRowsByTask(taskId)
    const net = netEntitlements(
      rows.map((r) => ({
        txType: r.txType as "settle" | "withdraw",
        party: r.party as "worker" | "poster",
        amountXrd: r.amountXrd,
      })),
    )
    // 'paid' and yet the worker holds nothing — the exact claim the old schema
    // could not express.
    expect(net.worker.outstanding).toBe("100")

    await recordEntitlementLedgerRow(
      leg({
        txType: "withdraw",
        party: "worker",
        lane: "reward",
        amountXrd: "100",
        txHash: "txid_rdx1collect",
      }),
    )
    const after = await findEntitlementRowsByTask(taskId)
    const netAfter = netEntitlements(
      after.map((r) => ({
        txType: r.txType as "settle" | "withdraw",
        party: r.party as "worker" | "poster",
        amountXrd: r.amountXrd,
      })),
    )
    expect(netAfter.worker.outstanding).toBe("0")
    expect(netAfter.poster.outstanding).toBe("5")
  })
})
