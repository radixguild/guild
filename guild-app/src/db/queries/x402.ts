import "server-only"
import { and, eq, lt, sql } from "drizzle-orm"
import { db } from "@/db"
import { x402Settlements } from "@/db/schema"

/**
 * Durable settlement reservations for the x402 facilitator.
 *
 * ONE PAYMENT, ONE SETTLEMENT. The intent hash is the identity (ruled
 * 2026-09-02 — see the schema file for why the triple it replaced was a hole).
 * `requirements` and `resourceUrl` are carried as BOUND CONTEXT so a repeat
 * against a different resource is refused distinctly instead of silently
 * settling a second time.
 *
 * THE INSERT IS THE GATE. The decision ("may I settle this payment?") and the
 * record of that decision are the same atomic statement. A `SELECT` then
 * `INSERT` reintroduces exactly the check-then-act race the in-memory guard
 * existed to close, now spread across processes where JavaScript cannot close
 * it — mutation-proven: that degradation raises a duplicate-key violation in
 * tests/integration/x402-settlement-dedup.pg.test.ts.
 *
 * FAILS CLOSED. Every caller treats a thrown DB error as "refuse to settle".
 * There is no in-memory fallback: falling back to a Set on a DB outage would
 * silently restore the multi-instance replay hole precisely when the system is
 * already degraded, and invisibly. Refusing a payment is recoverable; settling
 * one twice is not.
 */

export type ReserveOutcome =
  | { outcome: "reserved" }
  | { outcome: "already_settled" }
  | { outcome: "in_progress" }
  /** Same payment, different resource or requirements. An attack signal, not a duplicate. */
  | { outcome: "bound_elsewhere"; boundTo: { requirements: string; resourceUrl: string } }

export async function reserveSettlement(row: {
  intentHash: string
  requirements: string
  resourceUrl: string
  staleAfterSeconds: number
}): Promise<ReserveOutcome> {
  const inserted = await db
    .insert(x402Settlements)
    .values({
      intentHash: row.intentHash,
      requirements: row.requirements,
      resourceUrl: row.resourceUrl,
      status: "in_flight",
    })
    .onConflictDoNothing()
    .returning({ intentHash: x402Settlements.intentHash })

  if (inserted.length > 0) return { outcome: "reserved" }

  const [existing] = await db
    .select({
      status: x402Settlements.status,
      requirements: x402Settlements.requirements,
      resourceUrl: x402Settlements.resourceUrl,
    })
    .from(x402Settlements)
    .where(eq(x402Settlements.intentHash, row.intentHash))
    .limit(1)

  // The row can legitimately vanish between the failed insert and this read (a
  // concurrent release). Treating "gone" as in_progress makes the caller retry
  // rather than settle on a guess — the safe direction.
  if (!existing) return { outcome: "in_progress" }

  // CONTEXT CHECK BEFORE ANYTHING ELSE. This payment is bound to what it first
  // bought. A mismatch is refused whatever the status — including while still
  // in flight, and including after expiry, because a stale reservation must
  // never become a licence to redirect the payment to a different resource.
  if (existing.requirements !== row.requirements || existing.resourceUrl !== row.resourceUrl) {
    return {
      outcome: "bound_elsewhere",
      boundTo: { requirements: existing.requirements, resourceUrl: existing.resourceUrl },
    }
  }

  if (existing.status === "settled") return { outcome: "already_settled" }

  // Take over ONLY an expired in-flight reservation, and only for the same
  // context. Done as a conditional UPDATE rather than a read-then-write: two
  // instances reclaiming the same corpse must not both win, and the WHERE
  // clause inside the UPDATE is what makes that impossible.
  const cutoff = new Date(Date.now() - row.staleAfterSeconds * 1000)
  const reclaimed = await db
    .update(x402Settlements)
    .set({ createdAt: new Date() })
    .where(
      and(
        eq(x402Settlements.intentHash, row.intentHash),
        eq(x402Settlements.status, "in_flight"),
        eq(x402Settlements.resourceUrl, row.resourceUrl),
        eq(x402Settlements.requirements, row.requirements),
        lt(x402Settlements.createdAt, cutoff),
      ),
    )
    .returning({ intentHash: x402Settlements.intentHash })

  return reclaimed.length > 0 ? { outcome: "reserved" } : { outcome: "in_progress" }
}

/** Promote our own reservation to settled. Only ever called after a committed success. */
export async function markSettled(intentHash: string, payer?: string): Promise<void> {
  await db
    .update(x402Settlements)
    .set({ status: "settled", settledAt: new Date(), payer: payer ?? null })
    .where(and(eq(x402Settlements.intentHash, intentHash), eq(x402Settlements.status, "in_flight")))
}

/**
 * Claim ONE replay of an already-recorded settlement — the lost-response path.
 * Ruled 2026-09-02: a response that never reached the payer must not burn the
 * payment.
 *
 * Returns the recorded settlement when a replay is permitted, else null. The
 * caller reproduces the original response from it and MUST NOT re-submit the
 * transaction: it is already committed, and re-submitting would spend a gateway
 * call to learn what this row already knows.
 *
 * THE INCREMENT IS THE PERMISSION, in one statement. Every bound lives in the
 * WHERE clause — settled, same bound context, inside the window, under the cap —
 * so N simultaneous replays cannot each read "2 of 3 used" and all proceed. A
 * SELECT-then-UPDATE here would reintroduce the same check-then-act race the
 * reservation path exists to close, on the one path whose whole purpose is
 * handling a client that is retrying.
 */
export async function claimReplay(args: {
  intentHash: string
  requirements: string
  resourceUrl: string
  windowSeconds: number
  maxReplays: number
}): Promise<{ payer: string | null } | null> {
  const cutoff = new Date(Date.now() - args.windowSeconds * 1000)
  const [row] = await db
    .update(x402Settlements)
    .set({ replayCount: sql`${x402Settlements.replayCount} + 1` })
    .where(
      and(
        eq(x402Settlements.intentHash, args.intentHash),
        eq(x402Settlements.status, "settled"),
        // Bound context, same rule as reserve: a replay may only serve the
        // resource the payment actually bought.
        eq(x402Settlements.requirements, args.requirements),
        eq(x402Settlements.resourceUrl, args.resourceUrl),
        // Clock bound, measured from settlement rather than from the row's
        // creation — the window is "since the payer should have had their
        // response", not "since they started trying".
        sql`${x402Settlements.settledAt} > ${cutoff}`,
        lt(x402Settlements.replayCount, args.maxReplays),
      ),
    )
    .returning({ payer: x402Settlements.payer })
  return row ?? null
}

/**
 * Release a reservation that did not settle, so the payer can retry.
 *
 * Guarded on `status = 'in_flight'` so a release can never delete a SETTLED
 * row. Without that guard a late failure path firing after a success would
 * erase the replay record and re-open the payment — the exact defect this table
 * exists to close, reintroduced through the error path. Mutation-proven.
 */
export async function releaseSettlement(intentHash: string): Promise<void> {
  await db
    .delete(x402Settlements)
    .where(and(eq(x402Settlements.intentHash, intentHash), eq(x402Settlements.status, "in_flight")))
}

/**
 * Read-only companion to claimReplay: is a replay CURRENTLY permitted?
 *
 * Consumes nothing. verify() uses it purely to choose the 402 reason it reports;
 * settle() remains the only authority, because only claimReplay's UPDATE makes
 * the decision and the act the same statement. Anything that treated THIS answer
 * as permission would be a check-then-act across two functions.
 */
export async function isReplayable(args: {
  intentHash: string
  requirements: string
  resourceUrl: string
  windowSeconds: number
  maxReplays: number
}): Promise<boolean> {
  const cutoff = new Date(Date.now() - args.windowSeconds * 1000)
  const [row] = await db
    .select({ intentHash: x402Settlements.intentHash })
    .from(x402Settlements)
    .where(
      and(
        eq(x402Settlements.intentHash, args.intentHash),
        eq(x402Settlements.status, "settled"),
        eq(x402Settlements.requirements, args.requirements),
        eq(x402Settlements.resourceUrl, args.resourceUrl),
        sql`${x402Settlements.settledAt} > ${cutoff}`,
        lt(x402Settlements.replayCount, args.maxReplays),
      ),
    )
    .limit(1)
  return !!row
}

/** Has this payment already settled — against ANY resource? */
export async function isSettled(intentHash: string): Promise<boolean> {
  const [row] = await db
    .select({ status: x402Settlements.status })
    .from(x402Settlements)
    .where(and(eq(x402Settlements.intentHash, intentHash), eq(x402Settlements.status, "settled")))
    .limit(1)
  return !!row
}

/** What this payment is bound to, if anything. Null when unseen. */
export async function settlementFor(intentHash: string) {
  const [row] = await db
    .select({
      status: x402Settlements.status,
      requirements: x402Settlements.requirements,
      resourceUrl: x402Settlements.resourceUrl,
      settledAt: x402Settlements.settledAt,
    })
    .from(x402Settlements)
    .where(eq(x402Settlements.intentHash, intentHash))
    .limit(1)
  return row ?? null
}
