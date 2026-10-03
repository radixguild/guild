import { and, desc, eq, sql } from "drizzle-orm"
import { db } from "@/db"
import { fundingPools, taskContributions } from "@/db/schema"
import {
  applyPledge,
  claimRefund as fsmClaimRefund,
  evaluateDeadline,
  finalize as fsmFinalize,
  publishPool,
  recordContribution,
  FundingStateError,
  type ContributionEntry,
  type FundingErrorCode,
  type FundingExpiryReason,
  type FundingPoolState,
  type FundingPoolStatus,
} from "@/lib/funding-state-machine"
import { FUNDING_GRACE_WINDOW_SECS, FUNDING_MIN_CONTRIBUTION_XRD_DEFAULT } from "@/lib/funding-config"
import { charterReadiness, type PoolCharter } from "@/lib/pool-charter"

// Query layer for community-funded tasks (docs/design/funding-pool-blueprint.md,
// ruled 2026-08-14). This module owns ALL reads/writes to funding_pools and
// task_contributions; every state transition goes through
// src/lib/funding-state-machine.ts's pure functions rather than being
// re-decided here — this file's job is the DB plumbing (row locking, the
// state<->row mapping, CAS/conflict handling), same split as
// src/lib/escrow-confirm.ts vs src/lib/reconcile-claim.ts.
//
// ⚠️ NOTHING HERE TALKS TO THE CHAIN. `finalizeFundingPool` below flips a DB
// status and nothing else — see its own doc comment and the state machine's
// top-of-file note. It is deliberately NOT exposed through an API route yet
// (see src/app/api/v1/funding-pools/README or the PR description): exposing
// "finalize" today would let a pool read as `finalized` with no real task
// ever created, which is exactly the false capability claim the repo's
// honest-copy rule exists to prevent. It is kept here, tested, so the wiring
// is a small diff once the FundingPool blueprint exists and a real
// escrow-confirm-style route can call it after verifying create_task.

type FundingPoolRow = typeof fundingPools.$inferSelect
type ContributionRow = typeof taskContributions.$inferSelect

function toPoolState(row: FundingPoolRow): FundingPoolState {
  return {
    status: row.status as FundingPoolStatus,
    targetXrd: row.targetXrd,
    pooledXrd: row.pooledXrd,
    deadline: row.deadline,
    publishedAt: row.publishedAt,
    graceWindowSecs: row.graceWindowSecs ?? FUNDING_GRACE_WINDOW_SECS,
    fundedAt: row.fundedAt,
    finalizedAt: row.finalizedAt,
    expiredAt: row.expiredAt,
    expiredReason: row.expiredReason as FundingExpiryReason | null,
  }
}

function toEntry(row: ContributionRow): ContributionEntry {
  return {
    contributorId: row.contributorId,
    amountXrd: row.amountXrd,
    refundedAt: row.refundedAt,
    refundedXrd: row.refundedXrd,
  }
}

/**
 * Read-time-only status derivation (evaluateDeadline, not persisted). A
 * listing page must show an accurate status even for a pool nobody has
 * touched since its deadline passed — but writing on every read would turn a
 * GET into a write storm. `getFundingPoolById` below DOES persist (a single
 * self-healing write, the first time anyone loads that one pool after it
 * lapses); this helper is for read-only surfaces like the list.
 */
function withLiveStatus(row: FundingPoolRow, now: Date): FundingPoolRow {
  const derived = evaluateDeadline(toPoolState(row), now)
  if (derived.status === row.status) return row
  return {
    ...row,
    status: derived.status,
    expiredAt: derived.expiredAt,
    expiredReason: derived.expiredReason,
  }
}

export interface CreateFundingPoolInput {
  posterId: string
  title: string
  description: string
  /** Exact decimal XRD string — what the worker will receive. */
  targetXrd: string
  /** The pledging window LENGTH. The wall-clock deadline is derived from it
   *  at publish, not here — a draft has no clock (see publishPool). */
  deadlineSecs: number
  /** Exact decimal XRD string — computed by the caller as
   *  `targetXrd * FUNDING_INSURANCE_FRACTION`, not accepted from an
   *  untrusted client body (see the API route). */
  insuranceXrd: string
  /** NULL = use the app default (FUNDING_GRACE_WINDOW_SECS) at read time. */
  graceWindowSecs?: number
  /** PoolCharterSchema-shaped, partial while the pool is a draft. Publishing
   *  requires charterReadiness().ready — see publishFundingPool. */
  charter?: unknown
}

export async function createFundingPool(input: CreateFundingPoolInput): Promise<FundingPoolRow> {
  const [row] = await db
    .insert(fundingPools)
    .values({
      posterId: input.posterId,
      title: input.title,
      description: input.description,
      targetXrd: input.targetXrd,
      insuranceXrd: input.insuranceXrd,
      deadlineSecs: input.deadlineSecs,
      charter: input.charter ?? null,
      graceWindowSecs: input.graceWindowSecs ?? null,
    })
    .returning()
  return row
}

/**
 * Fetch one pool, self-healing its status if the deadline has lapsed since
 * the last write (a real CAS UPDATE, not just a display overlay — this is
 * the one place a plain read is allowed to persist the clock-derived
 * transition, matching the blueprint's own "first call flips explicit state"
 * pattern for `Failed`). Returns null if the pool does not exist.
 */
export async function getFundingPoolById(
  id: number,
  now: Date = new Date(),
): Promise<FundingPoolRow | null> {
  const [row] = await db.select().from(fundingPools).where(eq(fundingPools.id, id)).limit(1)
  if (!row) return null

  const derived = evaluateDeadline(toPoolState(row), now)
  if (derived.status === row.status) return row

  const [updated] = await db
    .update(fundingPools)
    .set({
      status: derived.status,
      expiredAt: derived.expiredAt,
      expiredReason: derived.expiredReason,
      updatedAt: now,
    })
    // CAS on the status we read: if a concurrent pledge/finalize/refund
    // already moved this row, THEIR write wins and we simply return the
    // fresher row instead of clobbering it with a stale derivation.
    .where(and(eq(fundingPools.id, id), eq(fundingPools.status, row.status)))
    .returning()
  return updated ?? (await getFundingPoolById(id, now))
}

export interface ListFundingPoolsOptions {
  status?: FundingPoolStatus
  posterId?: string
  limit?: number
  cursor?: number // opaque: the last-seen id, descending
}

export async function listFundingPools(
  opts: ListFundingPoolsOptions = {},
  now: Date = new Date(),
): Promise<{ data: FundingPoolRow[]; hasMore: boolean; cursor: number | null }> {
  const limit = Math.min(opts.limit ?? 20, 100)
  const conditions = []
  if (opts.status) conditions.push(eq(fundingPools.status, opts.status))
  if (opts.posterId) conditions.push(eq(fundingPools.posterId, opts.posterId))
  if (opts.cursor !== undefined) conditions.push(sql`${fundingPools.id} < ${opts.cursor}`)

  const rows = await db
    .select()
    .from(fundingPools)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(fundingPools.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const data = page.map((r) => withLiveStatus(r, now))
  return { data, hasMore, cursor: hasMore ? page[page.length - 1].id : null }
}

export async function getContribution(
  poolId: number,
  contributorId: string,
): Promise<ContributionRow | null> {
  const [row] = await db
    .select()
    .from(taskContributions)
    .where(and(eq(taskContributions.poolId, poolId), eq(taskContributions.contributorId, contributorId)))
    .limit(1)
  return row ?? null
}

export async function listPoolContributions(poolId: number): Promise<ContributionRow[]> {
  return db
    .select()
    .from(taskContributions)
    .where(eq(taskContributions.poolId, poolId))
    .orderBy(desc(taskContributions.amountXrd))
}

// ── Actions — the money-adjacent (but NOT money-moving) writes ──────────────
// All three mirror escrow-confirm.ts's result shape: expected rejections come
// back as `{ ok: false, code, httpStatus, message }`, never a thrown
// FundingStateError — only a genuinely unexpected failure (DB/network) throws.

export type FundingActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: FundingErrorCode | "NOT_FOUND" | "CONFLICT"; httpStatus: number; message: string }

const HTTP_STATUS_FOR: Record<FundingErrorCode, number> = {
  NOT_ACCEPTING_PLEDGES: 409,
  PAST_DEADLINE: 409,
  AMOUNT_NOT_POSITIVE: 400,
  BELOW_MINIMUM: 400,
  OVER_TARGET: 400,
  GAP_TOO_SMALL: 400,
  NOT_FUNDED: 409,
  FINALIZE_WINDOW_CLOSED: 409,
  NOT_EXPIRED: 409,
  NOTHING_TO_REFUND: 404,
  NOT_A_DRAFT: 409,
  CHARTER_INCOMPLETE: 422,
  ALREADY_REFUNDED: 409,
}

function fail<T>(
  code: FundingErrorCode | "NOT_FOUND" | "CONFLICT",
  httpStatus: number,
  message: string,
): FundingActionResult<T> {
  return { ok: false, code, httpStatus, message }
}

function fromStateError<T>(e: FundingStateError): FundingActionResult<T> {
  return fail(e.code, HTTP_STATUS_FOR[e.code], e.message)
}

/**
 * Record one pledge. Row-locked (SELECT … FOR UPDATE, same idiom as
 * submissions.ts's reviewSubmission) so two concurrent pledges against the
 * same pool serialize rather than racing to read-then-write a stale total —
 * the second waits for the first's transaction to commit, then re-validates
 * against the now-current pooled amount (so its own over-target/gap-guard
 * checks are correct, not just its arithmetic).
 */
export async function pledgeToFundingPool(
  poolId: number,
  contributorId: string,
  amountXrd: string,
  now: Date = new Date(),
): Promise<FundingActionResult<{ pool: FundingPoolRow; contribution: ContributionRow }>> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(fundingPools).where(eq(fundingPools.id, poolId)).for("update")
    if (!row) return fail("NOT_FOUND", 404, "Funding pool not found")

    let nextPool: FundingPoolState
    try {
      nextPool = applyPledge(toPoolState(row), amountXrd, now, {
        minContributionXrd: FUNDING_MIN_CONTRIBUTION_XRD_DEFAULT,
      })
    } catch (e) {
      if (e instanceof FundingStateError) return fromStateError(e)
      throw e
    }

    const existingEntryRow = await tx
      .select()
      .from(taskContributions)
      .where(and(eq(taskContributions.poolId, poolId), eq(taskContributions.contributorId, contributorId)))
      .for("update")
      .then((rows) => rows[0])
    const nextEntry = recordContribution(
      existingEntryRow ? toEntry(existingEntryRow) : null,
      contributorId,
      amountXrd,
    )

    const [contribution] = await tx
      .insert(taskContributions)
      .values({ poolId, contributorId, amountXrd: nextEntry.amountXrd })
      .onConflictDoUpdate({
        target: [taskContributions.poolId, taskContributions.contributorId],
        set: { amountXrd: nextEntry.amountXrd, updatedAt: now },
      })
      .returning()

    const [pool] = await tx
      .update(fundingPools)
      .set({
        pooledXrd: nextPool.pooledXrd,
        status: nextPool.status,
        fundedAt: nextPool.fundedAt,
        updatedAt: now,
      })
      .where(eq(fundingPools.id, poolId))
      .returning()

    return { ok: true, data: { pool, contribution } }
  })
}

/**
 * Save a draft's charter. Poster-only, draft-only.
 *
 * Separate from `createFundingPool` because a charter is something you come
 * back to: the whole point of the draft state is that the scope, the
 * non-goals and the acceptance criteria get argued over BEFORE money is
 * involved, and that rarely happens in one sitting.
 *
 * Refuses once the pool is published. A charter is what people pledged
 * against, so it stops being editable the instant it can attract money —
 * the same immutability the on-chain brief hash gives a task, enforced here
 * at the only point in this design where it can be.
 */
export async function saveDraftCharter(
  poolId: number,
  posterId: string,
  charter: Partial<PoolCharter>,
  now: Date = new Date(),
): Promise<FundingActionResult<FundingPoolRow>> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(fundingPools).where(eq(fundingPools.id, poolId)).for("update")
    if (!row) return fail("NOT_FOUND", 404, "Funding pool not found")
    if (row.posterId !== posterId) {
      return fail("CONFLICT", 403, "Only the poster who opened this pool can edit its charter")
    }
    if (row.status !== "draft") {
      return fail("NOT_A_DRAFT", 409, "The charter is fixed once pledging opens")
    }
    const [pool] = await tx
      .update(fundingPools)
      .set({ charter, updatedAt: now })
      .where(eq(fundingPools.id, poolId))
      .returning()
    return { ok: true, data: pool }
  })
}

/**
 * `draft -> pledging`: publish the charter and start the pledging clock.
 *
 * The readiness gate is `charterReadiness()` — the SAME function the create
 * form renders as its checklist, so what the poster sees greyed out and what
 * the server refuses can never drift apart. Row-locked like every other
 * transition here.
 */
export async function publishFundingPool(
  poolId: number,
  posterId: string,
  now: Date = new Date(),
): Promise<FundingActionResult<FundingPoolRow>> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(fundingPools).where(eq(fundingPools.id, poolId)).for("update")
    if (!row) return fail("NOT_FOUND", 404, "Funding pool not found")
    if (row.posterId !== posterId) {
      return fail("CONFLICT", 403, "Only the poster who opened this pool can publish it")
    }

    const readiness = charterReadiness(row.charter as Partial<PoolCharter> | null)
    let next: FundingPoolState
    try {
      next = publishPool(toPoolState(row), now, {
        deadlineSecs: row.deadlineSecs,
        charterReady: readiness.ready,
      })
    } catch (e) {
      if (e instanceof FundingStateError) return fromStateError(e)
      throw e
    }

    const [pool] = await tx
      .update(fundingPools)
      .set({
        status: next.status,
        deadline: next.deadline,
        publishedAt: next.publishedAt,
        updatedAt: now,
      })
      .where(eq(fundingPools.id, poolId))
      .returning()
    return { ok: true, data: pool }
  })
}

/**
 * Claim one contributor's refund from a failed pool. Row-locks BOTH the pool
 * and the contribution entry for the same reason as pledgeToFundingPool.
 */
export async function claimFundingRefund(
  poolId: number,
  contributorId: string,
  now: Date = new Date(),
): Promise<FundingActionResult<{ pool: FundingPoolRow; contribution: ContributionRow }>> {
  return db.transaction(async (tx) => {
    const [poolRow] = await tx.select().from(fundingPools).where(eq(fundingPools.id, poolId)).for("update")
    if (!poolRow) return fail("NOT_FOUND", 404, "Funding pool not found")

    const [entryRow] = await tx
      .select()
      .from(taskContributions)
      .where(and(eq(taskContributions.poolId, poolId), eq(taskContributions.contributorId, contributorId)))
      .for("update")
    if (!entryRow) return fail("NOTHING_TO_REFUND", 404, "No contribution on record for this account")

    let result: { pool: FundingPoolState; entry: ContributionEntry }
    try {
      result = fsmClaimRefund(toPoolState(poolRow), toEntry(entryRow), now)
    } catch (e) {
      if (e instanceof FundingStateError) return fromStateError(e)
      throw e
    }

    const [pool] = await tx
      .update(fundingPools)
      .set({ status: result.pool.status, updatedAt: now })
      .where(eq(fundingPools.id, poolId))
      .returning()
    const [contribution] = await tx
      .update(taskContributions)
      .set({ refundedAt: result.entry.refundedAt, refundedXrd: result.entry.refundedXrd, updatedAt: now })
      .where(eq(taskContributions.id, entryRow.id))
      .returning()

    return { ok: true, data: { pool, contribution } }
  })
}

/**
 * DB-only finalize. See this module's top-of-file warning: this does NOT
 * create an escrow task, and no route calls it yet. It exists so the
 * transition — and its guard against finalizing a pool whose grace has
 * already lapsed — is a tested, reusable unit ahead of the real wiring.
 */
export async function finalizeFundingPool(
  poolId: number,
  now: Date = new Date(),
): Promise<FundingActionResult<{ pool: FundingPoolRow }>> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(fundingPools).where(eq(fundingPools.id, poolId)).for("update")
    if (!row) return fail("NOT_FOUND", 404, "Funding pool not found")

    let nextPool: FundingPoolState
    try {
      nextPool = fsmFinalize(toPoolState(row), now)
    } catch (e) {
      if (e instanceof FundingStateError) return fromStateError(e)
      throw e
    }

    const [pool] = await tx
      .update(fundingPools)
      .set({ status: nextPool.status, finalizedAt: nextPool.finalizedAt, updatedAt: now })
      .where(eq(fundingPools.id, poolId))
      .returning()

    return { ok: true, data: { pool } }
  })
}

/**
 * Patronage leaderboard: how many DISTINCT pools each account has pledged
 * into, ranked by count — deliberately NOT ranked by XRD amount. "Backers
 * get patronage not profit" (this feature's brief) is a statement about
 * status, not wealth; ranking by raw XRD would make the leaderboard a
 * richest-wallet list, which is exactly the plutocratic signal community
 * funding is supposed to avoid (cf. the blueprint's own "no per-XRD XP"
 * DO-NOT, §12). Counts EVERY pledge regardless of pool status — a pool that
 * later expires and refunds does not erase that someone tried to back it —
 * which also sidesteps the still-open patronage-XP ruling (funding-
 * config.ts): this leaderboard needs no decision about what counts as
 * "funded" to be honest about who has been showing up.
 */
export async function getPatronLeaderboard(
  limit = 20,
): Promise<{ contributorId: string; poolsBacked: number }[]> {
  const rows = await db
    .select({
      contributorId: taskContributions.contributorId,
      poolsBacked: sql<number>`count(distinct ${taskContributions.poolId})::int`,
    })
    .from(taskContributions)
    .groupBy(taskContributions.contributorId)
    .orderBy(desc(sql`count(distinct ${taskContributions.poolId})`))
    .limit(Math.min(limit, 100))
  return rows
}
