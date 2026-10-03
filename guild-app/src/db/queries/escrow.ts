import { eq, and, or, inArray, isNotNull, lt, desc, sql } from "drizzle-orm"
import { db, type DbTransaction } from "@/db"
import { escrowTransactions, tasks } from "@/db/schema"

export async function findEscrowByTask(taskId: number) {
  return db
    .select()
    .from(escrowTransactions)
    .where(eq(escrowTransactions.taskId, taskId))
}

/**
 * Record a verified on-chain escrow event into the ledger. This is the SINGLE
 * writer of escrow_transactions — called only by the escrow-confirm route AFTER
 * the matching event is verified against the chain, with the real `txHash` and
 * the on-chain amount. (The legacy off-chain releaseEscrow/refundEscrow
 * fabricators were removed 2026-06-10: money moves on-chain or not at all.)
 * Idempotent on (taskId, txType): a task has exactly one fund, one dispute and
 * one settlement (release or refund), so a replayed confirm returns the
 * existing row instead of duplicating it. The check-then-insert is only a fast
 * path — the `escrow_legacy_task_tx_type_unique` index is the real guard, and a
 * concurrent loser falls through ON CONFLICT DO NOTHING to return the winner's
 * row.
 *
 * Returns `{ row, inserted }`: `inserted` is true only for the call that
 * physically wrote the row (found-existing and lost-race callers get false).
 * That flag is the idempotency key for once-only side effects hung off a
 * ledger write — the confirm core awards XP/reputation on the FIRST insert of
 * the (taskId, 'release') row and never on replays.
 *
 * Pass `tx` to run on an enclosing transaction so the ledger write commits
 * atomically with the caller's task-status update; without it the write opens
 * its own transaction.
 */
export async function recordConfirmedEscrowTx(
  data: {
    taskId: number
    txType: "fund" | "release" | "refund" | "dispute"
    fromUserId: string
    toUserId?: string | null
    amountXrd: string
    txHash: string
  },
  tx?: DbTransaction,
) {
  const run = async (handle: DbTransaction) => {
    const [existing] = await handle
      .select()
      .from(escrowTransactions)
      .where(
        and(
          eq(escrowTransactions.taskId, data.taskId),
          eq(escrowTransactions.txType, data.txType),
        ),
      )
    if (existing) return { row: existing, inserted: false }

    const [row] = await handle
      .insert(escrowTransactions)
      .values({
        taskId: data.taskId,
        fromUserId: data.fromUserId,
        toUserId: data.toUserId ?? null,
        amountXrd: data.amountXrd,
        txType: data.txType,
        status: "confirmed",
        txHash: data.txHash,
      })
      .onConflictDoNothing()
      .returning()
    if (row) return { row, inserted: true }

    // Lost a concurrent race on the unique (task_id, tx_type) index: the other
    // writer's row is committed by the time the insert resolves — return it.
    const [winner] = await handle
      .select()
      .from(escrowTransactions)
      .where(
        and(
          eq(escrowTransactions.taskId, data.taskId),
          eq(escrowTransactions.txType, data.txType),
        ),
      )
    return { row: winner, inserted: false }
  }

  return tx ? run(tx) : db.transaction(run)
}

/**
 * Record ONE settle/withdraw leg (redesign §5c). Sibling of
 * recordConfirmedEscrowTx, and deliberately NOT the same function: that one is
 * idempotent on (taskId, txType), which for entitlement rows is the wrong key in
 * both directions —
 *
 *   • ONE withdraw tx emits up to TWO WithdrawalEvents (reward + bond lanes), so
 *     keying on txType would swallow the second leg as a duplicate; and
 *   • a task can credit the same (task, poster, bond) twice over its life
 *     (claim → expire → re-claim → expire), so keying on (txType, party, lane)
 *     would reject a legitimate repeat.
 *
 * The correct key — the tx makes an occurrence distinct, (party, lane) makes the
 * legs within it distinct — is enforced by `escrow_entitlement_unique`. This
 * writer does not check-then-insert at all: it lets that index arbitrate via
 * ON CONFLICT, so concurrent scanners (per-task resync and the cron reconciler
 * both replay the same chain events) cannot double-count.
 *
 * ⚠️ That last sentence was ASPIRATIONAL until 2026-08-02: the cron reconciler
 * had no entitlement handling whatsoever, so this writer's only caller in
 * production was the human-triggered per-task resync. A withdrawal made by an
 * agent, the CLI or a wallet went unrecorded unless somebody happened to click
 * "Resync from chain" on that exact task. Both scanners now really do call it,
 * through the one shared `ingestEntitlements`.
 *
 * `txHash` is REQUIRED, not optional. A NULL there would make the unique index
 * inert for that row — Postgres treats NULLs as distinct — so the row would be
 * silently duplicable; `escrow_entitlement_fields_present` rejects it at the DB
 * too, and the non-optional type is what stops a caller reaching that error.
 */
export async function recordEntitlementLedgerRow(
  data: {
    taskId: number
    txType: "settle" | "withdraw"
    party: "worker" | "poster"
    lane: "reward" | "bond"
    fromUserId: string
    toUserId?: string | null
    amountXrd: string
    txHash: string
    destination?: string | null
  },
  tx?: DbTransaction,
) {
  const run = async (handle: DbTransaction) => {
    const [row] = await handle
      .insert(escrowTransactions)
      .values({
        taskId: data.taskId,
        fromUserId: data.fromUserId,
        toUserId: data.toUserId ?? null,
        amountXrd: data.amountXrd,
        txType: data.txType,
        party: data.party,
        lane: data.lane,
        destination: data.destination ?? null,
        status: "confirmed",
        txHash: data.txHash,
      })
      .onConflictDoNothing()
      .returning()
    if (row) return { row, inserted: true }

    // Already recorded (replayed event, or a concurrent scanner won the race).
    // Must match `escrow_entitlement_unique` COLUMN FOR COLUMN — txType included.
    // One tx can legitimately hold both a settle and a withdraw for the same
    // (party, lane) ("cancel and refund myself" is a single poster-signed
    // manifest), so omitting it here would hand back the credit row as if it
    // were the collection.
    const [existing] = await handle
      .select()
      .from(escrowTransactions)
      .where(
        and(
          eq(escrowTransactions.txHash, data.txHash),
          eq(escrowTransactions.taskId, data.taskId),
          eq(escrowTransactions.txType, data.txType),
          eq(escrowTransactions.party, data.party),
          eq(escrowTransactions.lane, data.lane),
        ),
      )
    return { row: existing, inserted: false }
  }

  return tx ? run(tx) : db.transaction(run)
}

/**
 * A task's settle/withdraw rows, for the settled-vs-withdrawn distinction.
 * Ordered oldest-first so a caller replaying them sees credits before collections.
 */
export async function findEntitlementRowsByTask(taskId: number) {
  return db
    .select()
    .from(escrowTransactions)
    .where(
      and(
        eq(escrowTransactions.taskId, taskId),
        inArray(escrowTransactions.txType, ["settle", "withdraw"]),
      ),
    )
    .orderBy(escrowTransactions.id)
}

/**
 * One task's full settlement history — every escrow_transactions row for it
 * (fund/release/refund/dispute/settle/withdraw alike), oldest first so a
 * reader sees "what happened" in the order it happened. Powers the
 * cancelled-task Archived panel on GET /api/v1/tasks/[id] (2026-09-14).
 *
 * `status = 'confirmed'` only, same HONESTY filter as `ledgerEventFilter`
 * below — this table's single writer (recordConfirmedEscrowTx /
 * recordEntitlementLedgerRow) never stages a 'pending' or 'failed' row
 * today, but a party-facing "what happened" panel should never be the place
 * that regresses if a future writer ever does.
 *
 * Unlike `findLedgerEvents` this is neither paginated nor cross-task: it is
 * a party-only view of one task's own rows, and a single task's transaction
 * count is small by construction (at most one of each legacy type, plus a
 * handful of settle/withdraw legs) — no cursor needed.
 */
export async function findSettlementHistoryForTask(taskId: number) {
  return db
    .select()
    .from(escrowTransactions)
    .where(
      and(eq(escrowTransactions.taskId, taskId), eq(escrowTransactions.status, "confirmed")),
    )
    .orderBy(escrowTransactions.id)
}

// ── Proof ledger (NODE-ROADMAP.md Stage 1: "every settled task, dispute and
// (later) node event linked to its transaction") ────────────────────────────
//
// The event kinds a settled/disputed/paid task actually produces, in the
// escrow_transactions vocabulary: `release`/`refund` are the task SETTLING
// (paid to the worker, or refunded to the poster — the legacy push events);
// `dispute` is a dispute being raised (0-amount marker row); `settle`/
// `withdraw` are the PULL-redesign entitlement legs (a party being credited,
// then collecting). Deliberately excludes `fund` — a task being funded is
// money entering escrow, not a settlement, dispute, or payment, and the
// roadmap gate is scoped to the latter three.
const LEDGER_TX_TYPES = ["release", "refund", "dispute", "settle", "withdraw"] as const

export interface LedgerEvent {
  id: number
  taskId: number
  taskTitle: string | null
  txType: (typeof LEDGER_TX_TYPES)[number]
  party: "worker" | "poster" | null
  lane: "reward" | "bond" | null
  amountXrd: string
  // Reward-resource flip prep. NULL = XRD (every row today) — see the column
  // comment on escrow_transactions. Never format amountXrd without this.
  rewardResource: string | null
  fromUserId: string
  toUserId: string | null
  txHash: string
  createdAt: Date
}

/**
 * Public proof-ledger feed: settled tasks, disputes and PULL payment events,
 * newest first, each row carrying the on-chain tx hash it was confirmed from.
 *
 * HONESTY — only rows a stranger can verify appear here: `status = 'confirmed'`
 * (the only status this table's single writer, above, ever inserts — the
 * default 'pending' and terminal 'failed' are unreachable today, and the
 * filter is kept anyway as a fail-closed guard against a future writer that
 * stages unconfirmed rows) AND `tx_hash IS NOT NULL`. No synthetic or
 * estimated rows are ever produced by this query.
 *
 * Keyset-paginated on `id DESC` alone (M6/M7's lesson: a cursor must key off
 * the same column the ORDER BY uses). One column suffices here — `id` is the
 * table's own identity primary key, already strictly ordered and unique, so
 * unlike the task board's (sortKey, id) compound cursor there is no tie to
 * break and no second column to keep in sync.
 */
// The ONE honesty filter, shared by the feed and the counter below so the
// summary line ("N of M events") counts exactly the population the table
// pages through — never a row the feed would refuse to show.
function ledgerEventFilter() {
  return [
    inArray(escrowTransactions.txType, [...LEDGER_TX_TYPES]),
    eq(escrowTransactions.status, "confirmed"),
    isNotNull(escrowTransactions.txHash),
  ]
}

export async function findLedgerEvents(
  opts: { limit?: number; cursor?: number } = {},
): Promise<{ data: LedgerEvent[]; cursor: number | null; hasMore: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100)
  const conditions = ledgerEventFilter()
  if (opts.cursor !== undefined) conditions.push(lt(escrowTransactions.id, opts.cursor))

  const rows = await db
    .select({
      id: escrowTransactions.id,
      taskId: escrowTransactions.taskId,
      taskTitle: tasks.title,
      txType: escrowTransactions.txType,
      party: escrowTransactions.party,
      lane: escrowTransactions.lane,
      amountXrd: escrowTransactions.amountXrd,
      rewardResource: escrowTransactions.rewardResource,
      fromUserId: escrowTransactions.fromUserId,
      toUserId: escrowTransactions.toUserId,
      txHash: escrowTransactions.txHash,
      createdAt: escrowTransactions.createdAt,
    })
    .from(escrowTransactions)
    .leftJoin(tasks, eq(escrowTransactions.taskId, tasks.id))
    .where(and(...conditions))
    .orderBy(desc(escrowTransactions.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const data = (hasMore ? rows.slice(0, limit) : rows) as LedgerEvent[]
  const cursor = hasMore && data.length > 0 ? data[data.length - 1].id : null
  return { data, cursor, hasMore }
}

/**
 * Whole-ledger counts for the /ledger summary line: how many events the feed
 * holds in total, and how many of them are INTERNAL test cycles — a declared
 * Guild-operated test account (GUILD_TEST_ACCOUNTS) on at least one side.
 * Whole-ledger, not per-page: "N of M settlements are internal" is a claim
 * about the ledger, and a page of 25 cannot back it.
 *
 * `internalAccounts` is bound as query parameters and never leaves the
 * server; the caller renders only the two integers. Empty list => internal is
 * 0 with no OR clause at all (mirrors leaderboardQuery's `excluded` guard —
 * an empty `inArray` is not something to hand to the driver).
 *
 * ⚠️ The predicate here — from_user_id IN (…) OR to_user_id IN (…) — MUST
 * agree with the JS classifier the page applies per row
 * (`classifyLedgerRow`, src/lib/ledger-internal.ts). The pglite ledger suite
 * asserts the two agree on the same seed; change both or neither.
 */
export async function countLedgerEvents(
  internalAccounts: readonly string[] = [],
): Promise<{ total: number; internal: number }> {
  const internalMatch =
    internalAccounts.length > 0
      ? or(
          inArray(escrowTransactions.fromUserId, [...internalAccounts]),
          inArray(escrowTransactions.toUserId, [...internalAccounts]),
        )
      : null

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      internal: internalMatch
        ? sql<number>`count(*) FILTER (WHERE ${internalMatch})::int`
        : sql<number>`0::int`,
    })
    .from(escrowTransactions)
    .where(and(...ledgerEventFilter()))

  return { total: row?.total ?? 0, internal: row?.internal ?? 0 }
}
