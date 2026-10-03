import { sql } from "drizzle-orm"
import {
  pgTable,
  text,
  timestamp,
  integer,
  numeric,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core"
import { users } from "./users"
import { tasks } from "./tasks"

export const escrowTransactions = pgTable(
  "escrow_transactions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    taskId: integer("task_id")
      .references(() => tasks.id)
      .notNull(),
    fromUserId: text("from_user_id")
      .references(() => users.id)
      .notNull(),
    toUserId: text("to_user_id").references(() => users.id),
    // Scale 18 matches the chain, and that is the whole point: Radix `Decimal` is
    // 18dp, so anything narrower makes Postgres SILENTLY round a settlement amount
    // on insert — no error, no warning. That matters most for the `settle`/`withdraw`
    // rows, which the drift watcher compares against the chain to decide whether a
    // payee is still owed money; a rounded row and an exact chain value disagree by
    // construction. The previous numeric(18,8) also capped the column at
    // ~9,999,999,999 XRD, BELOW XRD's ~10.4bn total supply.
    amountXrd: numeric("amount_xrd", { precision: 38, scale: 18 }).notNull(),
    // Mirrors tasks.reward_resource — same flip-prep column, same rule. NULL =
    // XRD (every row today). ⚠️ `amount_xrd`'S NAME IS A LIE once this is
    // non-NULL — never format/display/sum `amount_xrd` without reading this
    // column first.
    rewardResource: text("reward_resource"),
    // ⚠️ The `enum:` here is a TYPESCRIPT type only — Postgres sees plain `text`,
    // so adding a member needs no column migration. It does NOT mean this column
    // is unconstrained: `escrow_legacy_task_tx_type_unique` below is a real DB
    // index over it. The previous wording ("TYPE-ONLY (no DB constraint /
    // migration)") sat a few lines above that index and was read as "no
    // constraint at all" by two independent analyses of the pull migration, which
    // then disagreed about the idempotency key in opposite directions. Both were
    // reading this comment, not the indexes.
    //
    // `dispute` is a 0-amount marker row whose txHash carries the
    // DisputeRaisedEvent — the finalize (auto-resolve) flow re-reads `raised_by`
    // from that tx.
    //
    // `settle` / `withdraw` are the PULL rows (redesign §5c) and behave
    // differently from the four legacy types: they are keyed per (tx, party,
    // lane), not one-per-task. See the two indexes below.
    txType: text("tx_type", {
      enum: ["fund", "release", "refund", "dispute", "settle", "withdraw"],
    }).notNull(),
    // ── PULL entitlement columns. NULL on every legacy row, set on settle/withdraw.
    //
    // `lane` is NOT redundant with a resource address, and that is exactly why the
    // blueprint carries it: in production the reward token IS XRD, so both lanes
    // report the same resource and one `withdraw_poster` can emit two
    // WithdrawalEvents identical in (task_id, party, resource), differing only in
    // amount. De-duplicating on those three would silently drop a leg.
    party: text("party", { enum: ["worker", "poster"] }),
    lane: text("lane", { enum: ["reward", "bond"] }),
    // The payee pin from WithdrawalEvent — the account the funds were deposited
    // into, fixed at create_task/claim_task and never chosen by the caller. Stored
    // so payee correctness is auditable from the ledger without a chain read.
    destination: text("destination"),
    status: text("status", {
      enum: ["pending", "confirmed", "failed"],
    })
      .default("pending")
      .notNull(),
    txHash: text("tx_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // ── The LEGACY ledger invariant, preserved VERBATIM for the original four
    // types: a task has at most ONE row per tx type (one fund, one dispute, one
    // settlement leg of each kind). The writer's check-then-insert alone can't
    // survive concurrent confirms of the same intentHash (the resolve kind is a
    // public route) — this is the real guard against double-counted
    // release/refund rows.
    //
    // It is also what keeps the XP award exactly-once: the award is gated on the
    // FIRST physical insert of the (task_id, 'release') row, so weakening this
    // index would silently let a replayed confirm pay reputation twice. Now
    // PARTIAL rather than dropped, so settle/withdraw rows — which are legitimately
    // many-per-task — fall outside it without touching that guarantee.
    uniqueIndex("escrow_legacy_task_tx_type_unique")
      .on(table.taskId, table.txType)
      .where(sql`${table.txType} in ('fund', 'release', 'refund', 'dispute')`),
    // ── The PULL entitlement key. Getting this wrong fails in BOTH directions,
    // and two independent analyses picked one error each:
    //
    //   (task_id, tx_hash)              — REJECTS A REAL ROW. deposit_both_lanes
    //     calls take_lane twice in ONE transaction, so a single withdraw tx emits
    //     up to two WithdrawalEvents sharing a tx_hash and differing only by lane.
    //     The second lane would be swallowed as a duplicate.
    //
    //   (task_id, tx_type, party, lane) — REJECTS A LEGITIMATE REPEAT. A task can
    //     credit the same (task, poster, bond) twice over its life:
    //     claim → expire → re-claim → expire. The second forfeit would be dropped.
    //
    //   (tx_hash, task_id, party, lane)  — REJECTS A REAL ROW, a third way. This
    //     is the key the redesign §11b names, and it is right for withdrawal rows
    //     ALONE — which is all that row contemplated. Once settle rows share the
    //     table it drops a leg again: `cancel_task` + `withdraw_poster` are both
    //     poster-authorized, so "cancel and refund myself" is ONE ordinary
    //     manifest, emitting SettlementCredited(poster, reward) AND
    //     Withdrawal(poster, reward) under a single tx_hash. Without tx_type in
    //     the key the withdrawal is swallowed as a duplicate of the credit — and
    //     the ledger then says the poster is still owed money they already hold.
    //     Caught by tests/integration/escrow-entitlement-ledger.pg.test.ts.
    //
    // Correct: the TX makes an occurrence distinct, tx_type separates crediting
    // from collecting within it, and (party, lane) separates the legs.
    uniqueIndex("escrow_entitlement_unique")
      .on(table.txHash, table.taskId, table.txType, table.party, table.lane)
      .where(sql`${table.txType} in ('settle', 'withdraw')`),
    // The index above is only as strong as its columns being non-NULL: Postgres
    // treats NULLs as DISTINCT in a unique index, so a single NULL tx_hash,
    // party or lane would make an entitlement row unconstrained and silently
    // duplicable — the guard would still be "there" and would enforce nothing.
    // This closes that by construction rather than by trusting every writer.
    check(
      "escrow_entitlement_fields_present",
      sql`${table.txType} not in ('settle', 'withdraw')
          or (${table.txHash} is not null
              and ${table.party} is not null
              and ${table.lane} is not null)`,
    ),
    // And the converse, so the columns cannot be quietly repurposed by a legacy
    // writer: only entitlement rows may carry them.
    check(
      "escrow_legacy_rows_have_no_entitlement_fields",
      sql`${table.txType} in ('settle', 'withdraw')
          or (${table.party} is null
              and ${table.lane} is null
              and ${table.destination} is null)`,
    ),
    index("escrow_task_idx").on(table.taskId),
    index("escrow_from_user_idx").on(table.fromUserId),
    index("escrow_to_user_idx").on(table.toUserId),
    index("escrow_status_idx").on(table.status),
    index("escrow_tx_hash_idx").on(table.txHash),
  ]
)
