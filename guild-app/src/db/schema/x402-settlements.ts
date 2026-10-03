import { sql } from "drizzle-orm"
import { pgTable, text, timestamp, integer, index, check } from "drizzle-orm/pg-core"

/**
 * x402 settlement ledger — the durable replacement for facilitator.ts's former
 * in-memory Sets, and the enforcement point for ONE PAYMENT, ONE SETTLEMENT.
 *
 * THE PRIMARY KEY IS THE INTENT HASH. RULED 2026-09-02 (operator).
 *
 * It was briefly the (intent, requirements, resourceUrl) triple, faithfully
 * carried over from the in-memory version. That was a real hole, not a style
 * choice: the triple is the LOOSER key, so the same committed payment presented
 * against a different `resourceUrl` produced a different row, passed the replay
 * check and settled again — and `resourceUrl` is `req.nextUrl.toString()`, which
 * includes the query string, so the distinguishing axis was attacker-chosen
 * (`?x=1`, `?x=2`, …). One payment bought unlimited service.
 *
 * The comment that justified the triple had the argument exactly backwards — it
 * said intent-only "would let one payment unlock a DIFFERENT paid route", when
 * intent-only is the rule that PREVENTS that. Recorded because the code was
 * correct-looking and the reasoning was inverted; a reader checking the comment
 * against the behaviour would have agreed with both.
 *
 * A LOST RESPONSE MUST NOT BURN THE PAYMENT. RULED 2026-09-02 (operator).
 * `already_settled` was a flat refusal, so a response lost in transit left the
 * payer having paid for nothing. A settled row now REPLAYS its recorded
 * response — bounded twice over, by `maxTimeoutSeconds` from `settled_at` and
 * by `replay_count`. Bounded rather than open because an unbounded replay turns
 * a one-off payment into a permanent licence to re-fetch that resource, and the
 * handler runs again on each replay, so what is being served is fresh data, not
 * a cached body.
 *
 * WHY THE OTHER TWO COLUMNS SURVIVE THE NARROWING. They are no longer identity;
 * they are BOUND CONTEXT. A repeat carrying the same intent but a different
 * resource is not a duplicate request, it is an attempt to spend one payment on
 * something else — refused with its own reason so it is greppable in logs
 * rather than lost among ordinary replays.
 */
export const x402Settlements = pgTable(
  "x402_settlements",
  {
    /**
     * The intent hash DERIVED from the submitted bytes by the toolkit, never
     * read off the payload (`payload.payload.transactionId` is client-supplied
     * and unbound to `compiledHex`). Globally unique, cryptographically bound
     * to the transaction that moved the money — which is exactly the property
     * an idempotency key needs, so it is the key.
     */
    intentHash: text("intent_hash").primaryKey(),

    /** `network|asset|amount|payTo` this payment was accepted against. Context, not identity. */
    requirements: text("requirements").notNull(),

    /** The resource this payment bought. Context, not identity — see the note above. */
    resourceUrl: text("resource_url").notNull(),

    /**
     * `in_flight` = reserved before submit, `settled` = a committed success.
     *
     * ⚠️ A reservation is durable, which introduces a failure mode the in-memory
     * version did not have: a process that dies mid-settle leaves an `in_flight`
     * row nobody releases, and without a way out that payment is bricked
     * FOREVER — strictly worse than a Set that cleared on restart. The reclaim
     * is time-based and lives in `reserveSettlement` (`staleAfterSeconds`),
     * bounded by the caller's own `maxTimeoutSeconds`, because a settle cannot
     * legitimately outlive its own timeout.
     */
    status: text("status").notNull(),

    /**
     * The account that paid, read off the committed receipt. Stored so a replay
     * can reproduce the ORIGINAL SettlementResponse without re-submitting an
     * already-committed transaction — the response is the thing being replayed,
     * not the settlement.
     */
    payer: text("payer"),

    /**
     * How many times the recorded success has been replayed after a lost
     * response. Bounded (see REPLAY_MAX in facilitator.ts) because a time
     * window alone is a rate-limit hole: an attacker who can replay freely for
     * the length of the window gets that window's worth of an expensive
     * endpoint for one payment. Two independent bounds, clock and count.
     */
    replayCount: integer("replay_count").default(0).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => [
    // Reclaim scans `in_flight` by age; without this the sweep is a seq scan on
    // a table that only ever grows.
    index("x402_settlements_status_created_idx").on(t.status, t.createdAt),
    check("x402_settlements_status_check", sql`${t.status} IN ('in_flight', 'settled')`),
    // A settled row MUST carry its timestamp and an in-flight row must not —
    // enforced here rather than trusted, because `settled_at` is what any
    // future reconciliation or refund window would read.
    check(
      "x402_settlements_settled_at_check",
      sql`(${t.status} = 'settled' AND ${t.settledAt} IS NOT NULL) OR (${t.status} = 'in_flight' AND ${t.settledAt} IS NULL)`,
    ),
  ],
)
