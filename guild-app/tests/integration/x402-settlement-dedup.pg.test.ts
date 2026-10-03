/**
 * x402 settlement reservations — the REAL queries against a REAL Postgres.
 *
 * The unit suite proves the facilitator's CONTROL FLOW against a doubled store.
 * Nothing there touches SQL, and the entire durability claim rests on SQL: that
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING` decides and records in one
 * statement, that a release cannot erase a settled row, and that a dead
 * reservation is reclaimable only after it expires.
 *
 * ⚠️ WHAT THIS FILE DOES NOT PROVE — read before citing it as concurrency proof.
 * PGlite is Postgres compiled to WASM behind ONE connection, and it serialises
 * statements by construction. So the `Promise.all` case below does NOT exercise
 * two parallel backends racing the same key; it exercises the second attempt
 * meeting a row the first already committed. That is still the property the
 * in-memory Set could never have (it is enforced by the PRIMARY KEY, which is
 * process-independent) — but a test that claimed "proven under true concurrency"
 * from this fixture would be measuring the fixture, which is the failure this
 * repo keeps paying for. Real multi-backend contention needs a server Postgres
 * with N connections; that is not what runs here.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { eq } from "drizzle-orm"

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
  reserveSettlement,
  markSettled,
  releaseSettlement,
  isSettled,
  settlementFor,
  claimReplay,
  isReplayable,
} from "@/db/queries/x402"
import { x402Settlements } from "@/db/schema"

const INTENT = "txid_rdx1aaa"

const row = (over: Partial<Parameters<typeof reserveSettlement>[0]> = {}) => ({
  intentHash: INTENT,
  requirements: "radix:1|resource_xrd|50",
  resourceUrl: "https://radixguild.com/api/v1/x402/funded-tasks",
  staleAfterSeconds: 180,
  ...over,
})

let client: PGlite

beforeAll(async () => {
  client = new PGlite()
  A.db = drizzle(client)
  // drizzle/0020's DDL, not a hand-rolled approximation — a fixture that drifts
  // from the migration proves something about a table production does not have.
  // Written UNQUOTED, two-space indented, `timestamptz` not `timestamp with
  // time zone` — that is not cosmetic. tests/unit/schema-ddl-drift.test.ts
  // parses this block to prove it has not drifted from the drizzle schema, and
  // its parser matches exactly this shape. Quoted identifiers made it read zero
  // columns, which does not fail loudly — it makes "no missing columns" true
  // vacuously. The suite caught it here because a separate assertion requires
  // every pg test to declare a guarded table; without that, this fixture would
  // have been silently unguarded.
  await client.exec(`
CREATE TABLE x402_settlements (
  intent_hash text PRIMARY KEY NOT NULL,
  requirements text NOT NULL,
  resource_url text NOT NULL,
  status text NOT NULL,
  payer text,
  replay_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT x402_settlements_status_check CHECK (status IN ('in_flight', 'settled')),
  CONSTRAINT x402_settlements_settled_at_check CHECK (
    (status = 'settled' AND settled_at IS NOT NULL) OR
    (status = 'in_flight' AND settled_at IS NULL)
  )
);
CREATE INDEX x402_settlements_status_created_idx ON x402_settlements (status, created_at);
  `)
})

beforeEach(async () => {
  await client.exec(`DELETE FROM x402_settlements;`)
})

describe("reservation — the INSERT is the gate", () => {
  it("first caller reserves; a second caller is told it is in progress, not granted", async () => {
    expect(await reserveSettlement(row())).toEqual({ outcome: "reserved" })
    expect(await reserveSettlement(row())).toEqual({ outcome: "in_progress" })
  })

  it("exactly one of N simultaneous attempts reserves", async () => {
    // See the file header: PGlite serialises, so this is the second-meets-a-
    // committed-row path, not two parallel backends. The assertion is still the
    // one that matters — the count, not the ordering — and it fails immediately
    // if the guard degrades to check-then-act.
    const results = await Promise.all([
      reserveSettlement(row()),
      reserveSettlement(row()),
      reserveSettlement(row()),
      reserveSettlement(row()),
    ])
    expect(results.filter((r) => r.outcome === "reserved")).toHaveLength(1)
    expect(results.filter((r) => r.outcome === "in_progress")).toHaveLength(3)

    // And the store agrees — one row, not four. This is the assertion a
    // check-then-act implementation cannot satisfy no matter how the scheduler
    // interleaves, because the PRIMARY KEY is doing the work.
    const all = await A.db!.select().from(x402Settlements)
    expect(all).toHaveLength(1)
  })

  it("THE RULING: one payment cannot buy a SECOND resource", async () => {
    // This is the hole the intent-only key closes, and the reason the ruling
    // exists. Under the old (intent, requirements, resource) triple this second
    // reservation SUCCEEDED: a different resourceUrl made a different key, so
    // the same committed payment settled again. And resourceUrl is
    // req.nextUrl.toString(), which includes the query string — so `?page=2`
    // below is not a contrived fixture, it is the cheapest possible bypass.
    expect(await reserveSettlement(row())).toEqual({ outcome: "reserved" })
    await markSettled(INTENT)

    const second = await reserveSettlement(
      row({ resourceUrl: "https://radixguild.com/api/v1/x402/funded-tasks?page=2" }),
    )
    expect(second.outcome).toBe("bound_elsewhere")
    // Refused with its OWN reason, not folded into a generic replay: one payment
    // pointed at a second resource is an attack signal, and a log that cannot
    // distinguish it from an honest retry cannot alert on it.
    expect(second).toMatchObject({
      boundTo: { resourceUrl: "https://radixguild.com/api/v1/x402/funded-tasks" },
    })

    // One row, still bound to what it actually bought.
    const bound = await settlementFor(INTENT)
    expect(bound).toMatchObject({
      status: "settled",
      resourceUrl: "https://radixguild.com/api/v1/x402/funded-tasks",
    })
  })

  it("a mismatched resource is refused while the first attempt is still IN FLIGHT", async () => {
    // The context check runs before the status check for this reason: an
    // in-flight row must not be a window in which the payment can be redirected.
    expect(await reserveSettlement(row())).toEqual({ outcome: "reserved" })
    const second = await reserveSettlement(row({ resourceUrl: "https://radixguild.com/x/other" }))
    expect(second.outcome).toBe("bound_elsewhere")
  })

  it("a mismatched resource is refused even after the reservation EXPIRES", async () => {
    // Reclaim must not become a redirect. An expired reservation is reusable by
    // the SAME resource only; a different one is still bound_elsewhere.
    await reserveSettlement(row())
    await client.exec(
      `UPDATE x402_settlements SET created_at = now() - interval '10 minutes' WHERE intent_hash = '${INTENT}';`,
    )
    const other = await reserveSettlement(
      row({ resourceUrl: "https://radixguild.com/x/other", staleAfterSeconds: 180 }),
    )
    expect(other.outcome).toBe("bound_elsewhere")
    // ...while the original resource DOES reclaim it.
    expect(await reserveSettlement(row({ staleAfterSeconds: 180 }))).toEqual({ outcome: "reserved" })
  })
})

describe("settled rows are terminal", () => {
  it("a settled key is refused, and reports WHY it was refused", async () => {
    await reserveSettlement(row())
    await markSettled(INTENT)
    expect(await isSettled(INTENT)).toBe(true)
    expect(await reserveSettlement(row())).toEqual({ outcome: "already_settled" })
  })

  it("release CANNOT delete a settled row — the error path must not reopen a payment", async () => {
    await reserveSettlement(row())
    await markSettled(INTENT)

    await releaseSettlement(INTENT) // a late failure path firing after success

    expect(await isSettled(INTENT)).toBe(true)
    expect(await reserveSettlement(row())).toEqual({ outcome: "already_settled" })
  })

  it("markSettled stamps settled_at — the CHECK constraint makes the alternative unrepresentable", async () => {
    await reserveSettlement(row())
    await markSettled(INTENT)
    const [r] = await A.db!.select().from(x402Settlements).where(eq(x402Settlements.intentHash, INTENT))
    expect(r.status).toBe("settled")
    expect(r.settledAt).not.toBeNull()

    // The DB refuses the inconsistent shape outright, so no code path can
    // record a settlement that reconciliation would later fail to date.
    await expect(
      client.exec(
        `UPDATE "x402_settlements" SET "settled_at" = NULL WHERE intent_hash = '${INTENT}';`,
      ),
    ).rejects.toThrow()
  })
})

describe("a failed settlement does not burn the payment", () => {
  it("release returns the key to unreserved, so the payer can retry", async () => {
    expect(await reserveSettlement(row())).toEqual({ outcome: "reserved" })
    await releaseSettlement(INTENT)
    expect(await reserveSettlement(row())).toEqual({ outcome: "reserved" })
    expect(await isSettled(INTENT)).toBe(false)
  })
})

describe("stale reservations — the failure mode durability introduces", () => {
  it("a LIVE reservation is not stealable", async () => {
    await reserveSettlement(row())
    expect(await reserveSettlement(row({ staleAfterSeconds: 180 }))).toEqual({
      outcome: "in_progress",
    })
  })

  it("an EXPIRED reservation is reclaimed, so a dead process cannot brick a payment forever", async () => {
    await reserveSettlement(row())
    // Age the row past the window rather than sleeping through it.
    await client.exec(
      `UPDATE "x402_settlements" SET "created_at" = now() - interval '10 minutes' WHERE intent_hash = '${INTENT}';`,
    )
    expect(await reserveSettlement(row({ staleAfterSeconds: 180 }))).toEqual({ outcome: "reserved" })

    // Reclaiming resets the clock, so the reclaimer now owns it outright.
    expect(await reserveSettlement(row({ staleAfterSeconds: 180 }))).toEqual({
      outcome: "in_progress",
    })
  })

  it("an expired SETTLED row is never reclaimed — age does not undo a settlement", async () => {
    await reserveSettlement(row())
    await markSettled(INTENT)
    await client.exec(
      `UPDATE "x402_settlements" SET "created_at" = now() - interval '10 years' WHERE intent_hash = '${INTENT}';`,
    )
    expect(await reserveSettlement(row({ staleAfterSeconds: 180 }))).toEqual({
      outcome: "already_settled",
    })
  })
})

describe("lost-response replay — a dropped response must not burn the payment", () => {
  const replayArgs = (over: Record<string, unknown> = {}) => ({
    intentHash: INTENT,
    requirements: "radix:1|resource_xrd|50",
    resourceUrl: "https://radixguild.com/api/v1/x402/funded-tasks",
    windowSeconds: 120,
    maxReplays: 3,
    ...over,
  })

  const settle = async (payer = "account_rdx1payer") => {
    await reserveSettlement(row())
    await markSettled(INTENT, payer)
  }

  it("replays the recorded response, payer and all", async () => {
    await settle()
    const replay = await claimReplay(replayArgs())
    expect(replay).toEqual({ payer: "account_rdx1payer" })
  })

  it("is bounded by COUNT — the 4th replay is refused", async () => {
    await settle()
    expect(await claimReplay(replayArgs())).not.toBeNull()
    expect(await claimReplay(replayArgs())).not.toBeNull()
    expect(await claimReplay(replayArgs())).not.toBeNull()
    // A window with no cap is a rate-limit hole; this is the assertion that
    // says so. Without `replay_count < maxReplays` in the UPDATE, an attacker
    // gets the whole window's worth of an expensive endpoint for one payment.
    expect(await claimReplay(replayArgs())).toBeNull()
  })

  it("is bounded by the CLOCK — a replay outside the window is refused", async () => {
    await settle()
    await client.exec(
      `UPDATE x402_settlements SET settled_at = now() - interval '10 minutes' WHERE intent_hash = '${INTENT}';`,
    )
    expect(await claimReplay(replayArgs())).toBeNull()
    // ...and the count was NOT spent by the refusal.
    const [r] = await A.db!.select().from(x402Settlements).where(eq(x402Settlements.intentHash, INTENT))
    expect(r.replayCount).toBe(0)
  })

  it("will NOT replay against a different resource, inside the window or not", async () => {
    await settle()
    expect(
      await claimReplay(replayArgs({ resourceUrl: "https://radixguild.com/x/other" })),
    ).toBeNull()
    expect(await claimReplay(replayArgs({ requirements: "radix:1|resource_xrd|999" }))).toBeNull()
  })

  it("will NOT replay a row that never settled", async () => {
    await reserveSettlement(row()) // in_flight, never marked
    expect(await claimReplay(replayArgs())).toBeNull()
  })

  it("the increment IS the permission — N concurrent replays cannot exceed the cap", async () => {
    await settle()
    // Six at once against a cap of three. A SELECT-then-UPDATE would let every
    // caller read the same remaining count and all proceed; a single UPDATE
    // whose WHERE carries the bound cannot.
    const results = await Promise.all(Array.from({ length: 6 }, () => claimReplay(replayArgs())))
    expect(results.filter(Boolean)).toHaveLength(3)

    const [r] = await A.db!.select().from(x402Settlements).where(eq(x402Settlements.intentHash, INTENT))
    expect(r.replayCount).toBe(3)
  })

  it("isReplayable consumes nothing — verify() must not spend a replay", async () => {
    await settle()
    expect(await isReplayable(replayArgs())).toBe(true)
    expect(await isReplayable(replayArgs())).toBe(true)
    const [r] = await A.db!.select().from(x402Settlements).where(eq(x402Settlements.intentHash, INTENT))
    expect(r.replayCount).toBe(0)
  })
})
