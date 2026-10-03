import {
  pgTable,
  text,
  integer,
  numeric,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { users } from "./users"
import { tasks } from "./tasks"

// Community-funded tasks — the app-layer half of the threshold-crowdfund
// design (docs/design/funding-pool-blueprint.md, ruled at the ▶ 2026-08-14
// decision sitting: "community funding = threshold crowdfund on our OWN
// FundingPool blueprint", PROJECT-STATE.md). The FundingPool Scrypto
// blueprint itself is a SEPARATE, audit-gated build and does not exist yet —
// these two tables are the rail-agnostic app core the blueprint doc's §13
// calls out as startable now, ahead of it.
//
// ⚠️ NOTHING HERE IS ON-CHAIN. `fundingPools.finalizedTaskId` links to a REAL
// `tasks` row only once the FundingPool blueprint is designed, audited and
// deployed and an on-chain confirm has actually run (mirroring how
// `tasks.onChainTaskId` stays NULL until escrow-confirm.ts sees a real
// TaskCreatedEvent). Until then this is a pledging ledger the app enforces
// off-chain — see src/lib/funding-state-machine.ts's module doc for exactly
// what a "pledge" here does and does not promise a contributor: no XRD moves
// on a `task_contributions` insert.
//
// Naming follows the framing correction that is "legally load-bearing"
// (docs/audits/vps-mvp-drafts-review.md §4b): a contribution is not a
// donation. `task_contributions` / `contributor_id` — never
// `donations`/`donor_id`. Two tables, same shape as escrow's own split: a
// pool row (mirrors `tasks`) and a per-contributor ledger (mirrors
// `escrow_transactions`, but keyed by account like the blueprint's own
// `KeyValueStore<(pool_id, account), Decimal>` — one row per (pool,
// contributor), not one row per pledge event; see funding-state-machine.ts's
// `recordContribution` for why a second pledge accumulates rather than
// inserting a second row).

export const fundingPools = pgTable(
  "funding_pools",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    posterId: text("poster_id")
      .references(() => users.id)
      .notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    // 18dp to match the chain's future `Decimal` and this repo's other money
    // columns (see the note on escrow_transactions.amount_xrd) — a target the
    // pool can express but a future on-chain pool cannot record is a
    // reconciliation failure waiting to happen, same reasoning as
    // tasks.rewardXrd.
    targetXrd: numeric("target_xrd", { precision: 38, scale: 18 }).notNull(),
    // Running total. The ONLY writer is the query layer's pledge function,
    // via src/lib/funding-state-machine.ts's applyPledge — treated as
    // authoritative for reads, but its invariant is `pooledXrd ===
    // sum(task_contributions.amountXrd) for this pool`, always. The CHECK
    // constraint below enforces the D1 half of that (never over target); the
    // sum equality is a query-layer discipline, matching the same
    // denormalized-total pattern working_groups.memberCount uses for reads.
    pooledXrd: numeric("pooled_xrd", { precision: 38, scale: 18 })
      .default("0")
      .notNull(),
    // Poster-prepaid, per the ruling (§4b "Insurance": poster pre-pays so
    // `target` stays exactly what the worker receives). Recorded at open,
    // not derived from the live INSURANCE_RATE constant at read time, so a
    // later change to that constant cannot retroactively change what an
    // OPEN pool already committed to.
    insuranceXrd: numeric("insurance_xrd", { precision: 38, scale: 18 }).notNull(),
    // ── The charter: what this pool agreed BEFORE anyone pledged ──
    //
    // Shape is PoolCharterSchema (src/lib/pool-charter.ts), whose `terms` key
    // is TaskTermsSchema VERBATIM — the same object the task wizard writes and
    // canonicalTermsBlock hashes into the on-chain brief. Stored as one jsonb
    // column rather than a dozen scalars for the same reason tasks.terms is:
    // the shape is a versioned document read as a whole, never filtered or
    // joined on, and spreading it across columns would make every future
    // charter field a migration.
    //
    // NULL only for rows that predate the charter (pools opened when a pool
    // was four fields). A draft opened after it always carries at least a
    // partial charter, and publishing requires charterReadiness().ready.
    charter: jsonb("charter"),
    // The pledging window LENGTH, chosen at draft time. The wall-clock
    // `deadline` is computed from it at publish — see publishPool() for why
    // the clock must not start while a charter is still being written.
    deadlineSecs: integer("deadline_secs").notNull(),
    // NULL while the pool is a draft: a draft has no deadline because its
    // clock has not started. Set at publish, and immutable after (D3: "never
    // extendable" — there is no set_deadline, here or in the blueprint).
    deadline: timestamp("deadline", { withTimezone: true }),
    // draft -> pledging. Also the answer to "how long was this open for
    // comment before money went in", which is the question anyone auditing a
    // community-funded project asks first.
    publishedAt: timestamp("published_at", { withTimezone: true }),
    // D5's liveness escape (blueprint §5/§7): a funded-but-unfinalized pool
    // fails at deadline + grace, not at deadline. NULL = the row predates
    // this column or the poster took the app default at open time — readers
    // fall back to FUNDING_GRACE_WINDOW_SECS (funding-config.ts). Stored
    // per-row (not just read from the shared constant) so a later change to
    // the default cannot move the goalposts under a pool someone already
    // pledged into.
    graceWindowSecs: integer("grace_window_secs"),
    // TYPE-ONLY text enum (no DB constraint on the values themselves beyond
    // being text) — house convention, see tasks.status. Matches
    // FundingPoolStatus in src/lib/funding-state-machine.ts exactly; keep
    // the two in sync by hand, the same relationship NOTIFICATION_LEVELS has
    // with working-groups.ts.
    // A pool is born a DRAFT, not a fundraiser — see publishPool() in
    // src/lib/funding-state-machine.ts for the reasoning. Keep in sync by
    // hand with FundingPoolStatus there, same relationship tasks.status has.
    status: text("status", {
      enum: ["draft", "pledging", "funded", "finalized", "expired", "refunding"],
    })
      .default("draft")
      .notNull(),
    // Set once, by the state machine, on the pledging -> funded transition.
    // Not derived on read: pooledXrd >= targetXrd also tells you "funded has
    // happened," but not WHEN — and D5's grace window is measured from
    // `deadline`, not from this column, so the two serve different purposes.
    fundedAt: timestamp("funded_at", { withTimezone: true }),
    // Set on funded -> finalized.
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    // Links to the real task once one exists — NULL until the FundingPool
    // blueprint deploys and finalize() actually calls create_task, exactly
    // like the escrow's own `task_id: Option<u64>` (blueprint §3 PoolInfo).
    // A pool with status "finalized" and finalizedTaskId still NULL means
    // "this app marked itself finalized before the blueprint existed" — see
    // the state machine's top-of-file doc; callers must not read
    // status="finalized" alone as proof any XRD moved.
    finalizedTaskId: integer("finalized_task_id").references(() => tasks.id),
    // Set on the transition INTO expired — from either pledging (reason
    // NotFunded) or funded (reason GraceExpired). See expiredReason.
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    expiredReason: text("expired_reason", { enum: ["NotFunded", "GraceExpired"] }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("funding_pools_status_idx").on(table.status),
    index("funding_pools_poster_idx").on(table.posterId),
    index("funding_pools_deadline_idx").on(table.deadline),
    uniqueIndex("funding_pools_finalized_task_unique").on(table.finalizedTaskId),
    // Conservation invariant at the DB level, belt-and-suspenders behind the
    // state machine: a pool row can never be recorded as holding more than
    // its own target — mirrors D1 (the future CHAIN refuses over-funding);
    // this refuses an over-funded ROW even if an app bug ever let one
    // through the state machine.
    check("funding_pools_pooled_not_over_target", sql`${table.pooledXrd} <= ${table.targetXrd}`),
  ],
)

export const taskContributions = pgTable(
  "task_contributions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    poolId: integer("pool_id")
      .references(() => fundingPools.id)
      .notNull(),
    contributorId: text("contributor_id")
      .references(() => users.id)
      .notNull(),
    // Cumulative amount from this contributor into this pool — ONE row per
    // (pool, contributor), matching the blueprint's account-keyed ledger
    // (funding-pool-blueprint.md §4b: "badge-gated contribute, keyed by
    // account" — "No new NFT resource"). A second pledge from the same
    // account ADDS to this row rather than inserting a second one; see
    // recordContribution() in src/lib/funding-state-machine.ts. This is also
    // why there is no separate "pledge events" table — the ledger IS the
    // state, same reasoning as working_groups' single join-row-carries-a-
    // level shape.
    amountXrd: numeric("amount_xrd", { precision: 38, scale: 18 }).notNull(),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    // Exact amount actually refunded — MUST equal amountXrd when set. A
    // separate column (rather than trusting amountXrd at refund time) so a
    // future partial-refund bug can never silently pass a reconciliation
    // that only checks "was this refunded", matching the blueprint's own
    // refund-exactness invariant (§9): claim_refund pays the exact recorded
    // Decimal, never a computed share.
    refundedXrd: numeric("refunded_xrd", { precision: 38, scale: 18 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // The account-keyed-ledger invariant itself: a contributor can pledge
    // into the same pool any number of times, but always accumulates into
    // ONE row. Without this, "double-pledge from one account" silently
    // becomes two rows and every sum/leaderboard/refund query has to
    // GROUP BY contributor to recover the invariant this index gives for
    // free.
    uniqueIndex("task_contributions_pool_contributor_unique").on(
      table.poolId,
      table.contributorId,
    ),
    index("task_contributions_pool_idx").on(table.poolId),
    index("task_contributions_contributor_idx").on(table.contributorId),
    check(
      "task_contributions_refund_exactness",
      sql`${table.refundedAt} is null or ${table.refundedXrd} = ${table.amountXrd}`,
    ),
  ],
)
