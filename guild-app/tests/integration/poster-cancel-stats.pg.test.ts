/**
 * getPosterCancelStats (PROJECT-STATE.md's 2026-09-01 §20 design packet,
 * unnumbered "Also in §20" bullet — NOT §20.4, an unrelated open bug),
 * proven against a real Postgres (pglite) — the same rig as
 * leaderboard-exclusion.pg.test.ts and
 * task-pagination.pg.test.ts.
 *
 * The whole query rests on one fact about the existing confirm core
 * (src/lib/escrow-confirm.ts): `cancel_task` and
 * `cancel_task_by_poster_after_claim` both write the SAME
 * `tasks.status = 'cancelled'`, and that write never touches assignee_id —
 * only the claim confirm sets it and only expire_claim clears it. So a
 * cancelled row that still carries a non-null assignee_id can only have left
 * the Claimed state. This suite seeds exactly that ambiguity (two posters
 * with cancelled rows, told apart only by assignee_id) and proves the SQL
 * reads it correctly, plus three fixture posters at 0 / 1 / 3
 * cancels-after-claim as the task calls for.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import * as schema from "@/db/schema"

// getPosterCancelStats reads `db` from @/db — point it at the pglite-backed
// drizzle. Same Proxy-binding shape as leaderboard-exclusion.pg.test.ts /
// task-pagination.pg.test.ts, so drizzle's `this` survives the indirection.
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

import { getPosterCancelStats } from "@/db/queries/poster-cancel-stats"
import { tasks } from "@/db/schema"

// The FULL tasks table, byte-for-byte the same declaration as
// leaderboard-exclusion.pg.test.ts's — not trimmed to only the columns this
// query touches. tests/unit/schema-ddl-drift.test.ts requires every
// *.pg.test.ts that declares a guarded table to name every real column,
// unique index and CHECK constraint, so a schema change can't silently drift
// out from under a hand-written DDL. See that file's header for why.
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
  WHERE on_chain_task_id IS NOT NULL;`

const POSTER_ZERO = "account_rdx12poster0cancels0000000000000000000000000000000000000000"
const POSTER_ONE = "account_rdx12poster1cancel00000000000000000000000000000000000000000"
const POSTER_THREE = "account_rdx12poster3cancels0000000000000000000000000000000000000000"
const POSTER_UNPOSTED = "account_rdx12posterneverposted0000000000000000000000000000000000000"
const WORKER_1 = "account_rdx12worker100000000000000000000000000000000000000000000000"
const WORKER_2 = "account_rdx12worker200000000000000000000000000000000000000000000000"
const WORKER_3 = "account_rdx12worker300000000000000000000000000000000000000000000000"

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  H.db = drizzle(pg, { schema })
  await pg.exec(DDL)
}, 60_000)

beforeEach(async () => {
  await pg.exec("TRUNCATE tasks RESTART IDENTITY")
})

describe("getPosterCancelStats (pglite)", () => {
  it("fixture: a poster with 0 cancels-after-claim", async () => {
    await H.db!.insert(tasks).values([
      { title: "paid", description: "d", status: "paid", creatorId: POSTER_ZERO, assigneeId: WORKER_1 },
      // Cancelled but NEVER claimed (assignee_id null) — must NOT count.
      { title: "cancelled-open", description: "d", status: "cancelled", creatorId: POSTER_ZERO, assigneeId: null },
      { title: "still-open", description: "d", status: "open", creatorId: POSTER_ZERO, assigneeId: null },
    ])

    expect(await getPosterCancelStats(POSTER_ZERO)).toEqual({
      totalPosted: 3,
      cancelledAfterClaim: 0,
    })
  })

  it("fixture: a poster with 1 cancel-after-claim", async () => {
    await H.db!.insert(tasks).values([
      // Cancelled WITH a claimant still attached — the after-claim case.
      { title: "cancelled-claimed", description: "d", status: "cancelled", creatorId: POSTER_ONE, assigneeId: WORKER_1 },
      { title: "paid", description: "d", status: "paid", creatorId: POSTER_ONE, assigneeId: WORKER_2 },
      { title: "cancelled-open", description: "d", status: "cancelled", creatorId: POSTER_ONE, assigneeId: null },
      { title: "assigned", description: "d", status: "assigned", creatorId: POSTER_ONE, assigneeId: WORKER_3 },
    ])

    expect(await getPosterCancelStats(POSTER_ONE)).toEqual({
      totalPosted: 4,
      cancelledAfterClaim: 1,
    })
  })

  it("fixture: a poster with 3 cancels-after-claim", async () => {
    await H.db!.insert(tasks).values([
      { title: "cancelled-claimed-1", description: "d", status: "cancelled", creatorId: POSTER_THREE, assigneeId: WORKER_1 },
      { title: "cancelled-claimed-2", description: "d", status: "cancelled", creatorId: POSTER_THREE, assigneeId: WORKER_2 },
      { title: "cancelled-claimed-3", description: "d", status: "cancelled", creatorId: POSTER_THREE, assigneeId: WORKER_3 },
      { title: "still-open", description: "d", status: "open", creatorId: POSTER_THREE, assigneeId: null },
    ])

    expect(await getPosterCancelStats(POSTER_THREE)).toEqual({
      totalPosted: 4,
      cancelledAfterClaim: 3,
    })
  })

  it("a poster who has never posted anything gets the zero row, not a crash", async () => {
    await H.db!.insert(tasks).values([
      { title: "someone else's task", description: "d", status: "open", creatorId: POSTER_ZERO, assigneeId: null },
    ])

    expect(await getPosterCancelStats(POSTER_UNPOSTED)).toEqual({
      totalPosted: 0,
      cancelledAfterClaim: 0,
    })
  })

  it("does not attribute another poster's cancel-after-claim to this one (scoped by creator_id)", async () => {
    await H.db!.insert(tasks).values([
      { title: "poster-one's cancel", description: "d", status: "cancelled", creatorId: POSTER_ONE, assigneeId: WORKER_1 },
      { title: "poster-zero's open task", description: "d", status: "open", creatorId: POSTER_ZERO, assigneeId: null },
    ])

    expect(await getPosterCancelStats(POSTER_ZERO)).toEqual({
      totalPosted: 1,
      cancelledAfterClaim: 0,
    })
  })
})
