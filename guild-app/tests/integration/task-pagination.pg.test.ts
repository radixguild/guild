/**
 * M7 — the REAL multi-row pagination coverage, executed against Postgres.
 *
 * task-cursor.test.ts proves the keyset ALGORITHM and pins the drizzle shape, but
 * it can't prove the generated SQL actually paginates correctly (numeric-vs-string
 * comparison, NULLS-LAST ordering, the compound keyset WHERE). This runs the REAL
 * `listTasks` against an in-memory Postgres (pglite) over an adversarial dataset,
 * then asserts a full cursor WALK reproduces the exact order of an INDEPENDENT
 * `ORDER BY` query — neither skipping nor repeating a row. This is the coverage
 * whose absence let M6 (reward/deadline keyset keyed on id) ship (single-row
 * mocks); a regression to an id-only cursor turns these red.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import * as schema from "@/db/schema"

// listTasks reads `db` from @/db — point it at the pglite-backed drizzle. The
// proxy binds methods to the real instance so drizzle's `this` is preserved.
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

import { listTasks } from "@/db/queries/tasks"
import { tasks } from "@/db/schema"

// Minimal standalone `tasks` DDL (FK-referenced tables omitted — drizzle builds
// SQL from the schema metadata, and PG only enforces FKs at insert, which we
// never exercise here). Columns mirror src/db/schema/tasks.ts exactly.
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

let pg: PGlite
let db: ReturnType<typeof drizzle>

const D = (iso: string) => new Date(iso)

// Adversarial dataset: reward ties with non-monotonic ids, deadline ties + a
// NULL-deadline tail, and created_at ties — every case the id-only cursor broke.
const SEED = [
  { title: "a", description: "a", creatorId: "u1", rewardXrd: "100", deadline: D("2026-07-10T00:00:00Z"), createdAt: D("2026-07-03T00:00:00Z") },
  { title: "b", description: "b", creatorId: "u1", rewardXrd: "50", deadline: null, createdAt: D("2026-07-03T00:00:00Z") },
  { title: "c", description: "c", creatorId: "u1", rewardXrd: "100", deadline: D("2026-07-01T00:00:00Z"), createdAt: D("2026-07-05T00:00:00Z") },
  { title: "d", description: "d", creatorId: "u1", rewardXrd: "50", deadline: D("2026-07-10T00:00:00Z"), createdAt: D("2026-07-01T00:00:00Z") },
  { title: "e", description: "e", creatorId: "u1", rewardXrd: "75", deadline: null, createdAt: D("2026-07-02T00:00:00Z") },
  { title: "f", description: "f", creatorId: "u1", rewardXrd: "100", deadline: D("2026-07-10T00:00:00Z"), createdAt: D("2026-07-02T00:00:00Z") },
  { title: "g", description: "g", creatorId: "u1", rewardXrd: "25.5", deadline: D("2026-07-04T00:00:00Z"), createdAt: D("2026-07-06T00:00:00Z") },
  { title: "h", description: "h", creatorId: "u1", rewardXrd: "75", deadline: D("2026-07-01T00:00:00Z"), createdAt: D("2026-07-04T00:00:00Z") },
]

/** Page through every task via the REAL listTasks cursor; return the id order. */
async function walk(sort: "newest" | "reward" | "deadline", pageSize: number): Promise<number[]> {
  const ids: number[] = []
  let cursor: string | undefined
  // Guard against a non-advancing keyset (the failure mode under test).
  for (let guard = 0; guard < SEED.length + 3; guard++) {
    const page = await listTasks({ sort, cursor, limit: pageSize })
    ids.push(...page.data.map((t) => t.id))
    if (!page.hasMore) break
    cursor = page.cursor ?? undefined
  }
  return ids
}

/** Independent ground-truth order via a raw ORDER BY (not listTasks's builder). */
async function expectedOrder(orderBy: string): Promise<number[]> {
  const res = await pg.query<{ id: number }>(`SELECT id FROM tasks ORDER BY ${orderBy}`)
  return res.rows.map((r) => r.id)
}

describe("M7: listTasks keyset pagination executed against Postgres (pglite)", () => {
  // 60s: see escrow-confirm-parity.pg.test.ts — concurrent WASM-Postgres init
  // under a full-suite run exceeds the 10s default hook timeout.
  beforeAll(async () => {
    pg = new PGlite()
    db = drizzle(pg, { schema })
    H.db = db
    await pg.exec(DDL)
  }, 60_000)

  beforeEach(async () => {
    await pg.exec("TRUNCATE tasks RESTART IDENTITY")
    await db.insert(tasks).values(SEED)
  })

  it("sort=reward: the cursor walk matches a raw (reward_xrd DESC, id DESC) order, no skip/repeat", async () => {
    const expected = await expectedOrder("reward_xrd DESC, id DESC")
    for (const size of [1, 2, 3, SEED.length]) {
      const walked = await walk("reward", size)
      expect(walked, `page size ${size}`).toEqual(expected)
      expect(new Set(walked).size).toBe(SEED.length)
    }
  })

  it("sort=deadline: matches a raw (deadline ASC NULLS LAST, id ASC) order across the NULL tail", async () => {
    const expected = await expectedOrder("deadline ASC NULLS LAST, id ASC")
    for (const size of [1, 2, 3]) {
      const walked = await walk("deadline", size)
      expect(walked, `page size ${size}`).toEqual(expected)
      expect(new Set(walked).size).toBe(SEED.length)
    }
  })

  it("sort=newest: matches a raw (created_at DESC, id DESC) order with created_at ties", async () => {
    const expected = await expectedOrder("created_at DESC, id DESC")
    for (const size of [1, 2, 3]) {
      const walked = await walk("newest", size)
      expect(walked, `page size ${size}`).toEqual(expected)
      expect(new Set(walked).size).toBe(SEED.length)
    }
  })

  it("reward paging reaches the high-reward/high-id rows the old id-only cursor dropped", async () => {
    // Rows c (id 3) and f (id 6) both have reward 100 but ids past page-1's
    // boundary — unreachable under the old `WHERE id < cursor`. Here they appear.
    const walked = await walk("reward", 2)
    expect(walked.slice(0, 3).sort((a, b) => a - b)).toEqual([1, 3, 6]) // the three 100s, first
    expect(walked).toContain(3)
    expect(walked).toContain(6)
  })

  it("a compound cursor from page 1 decodes to a value the next page actually uses", async () => {
    const page1 = await listTasks({ sort: "reward", limit: 3 })
    expect(page1.hasMore).toBe(true)
    const page2 = await listTasks({ sort: "reward", limit: 3, cursor: page1.cursor! })
    // No overlap between the pages — the keyset advanced past page 1's last row.
    const overlap = page1.data.map((t) => t.id).filter((id) => page2.data.some((t) => t.id === id))
    expect(overlap).toEqual([])
  })
})
