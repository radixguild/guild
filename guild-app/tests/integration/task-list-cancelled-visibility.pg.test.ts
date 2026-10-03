/**
 * 2026-09-14 hardening — the query-layer half of the cancelled-task
 * visibility gate. `isCancelledTaskVisibleTo` (src/lib/public-task-text.ts)
 * already governs GET /api/v1/tasks/[id] and the project-embedded task list
 * (same-day hardening): a cancelled row is a 404 / dropped from the embed
 * for anyone but its creator or assignee. Measured live on deploy 50c2528,
 * GET /api/v1/tasks — the paginated public board — did NOT apply that rule:
 * the R6 default-hide (`notCancelledByDefault` in db/queries/tasks.ts)
 * deliberately steps aside for an explicit status filter (an owner must
 * still be able to reach their own cancelled tasks via a bare
 * `?status=cancelled`), and nothing filled the gap that left — so an
 * anonymous `?status=cancelled` returned all 41 cancelled rows, ids and
 * timestamps intact (text still scrubbed by the separate public-text gate).
 *
 * This runs against a REAL Postgres (pglite), the same harness as
 * task-pagination.pg.test.ts, rather than the mocked `where`-shape
 * assertions in db-queries.test.ts's "cancelled-hide default (R6)" block —
 * the bug here is in which ROWS the query returns, not in the shape of the
 * WHERE clause, and a mock that always hands back its canned array
 * regardless of the WHERE it was given cannot catch that.
 *
 * SECOND PASS (2026-09-14, PR #580 review finding): the fix above only
 * covers the non-project view. `isProjectScopedView` skips BOTH the
 * default hide AND this gate, on purpose, so a project's kanban funnel can
 * show every status at once — but skipping "hide cancelled by default" and
 * skipping "gate cancelled visibility per row" are two different things,
 * and one `if` was doing both. `GET /api/v1/tasks?project=<id>`, with or
 * without `&status=cancelled`, handed an anonymous or non-party caller
 * every cancelled task's existence in that project. The describe block at
 * the bottom of this file pins the real-row fix: the SAME per-row
 * creator-or-assignee check, now applied to a project-scoped query too,
 * while leaving every non-cancelled row in the project fully visible.
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

// Same standalone `tasks` DDL as task-pagination.pg.test.ts (FK-referenced
// tables omitted — drizzle builds SQL from schema metadata, and PG only
// enforces FKs at insert, which we never exercise here). Columns mirror
// src/db/schema/tasks.ts exactly.
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

// Real-row-shaped fixtures (36/38 style): a poster's own cancelled task, a
// DIFFERENT poster's task that was claimed and then cancelled (so the
// assignee — not the creator — is the party who must still see it), a third
// cancelled row neither test viewer has any relationship to, and one
// ordinary open row to prove `?status=open` is untouched by any of this.
const CREATOR = "account_rdx1creator_of_36"
const OTHER_POSTER = "account_rdx1other_poster"
const ASSIGNEE = "account_rdx1assignee_of_38"
const STRANGER = "account_rdx1stranger"

// All four rows also live in the SAME project (PROJECT_ID) so the
// project-scoped describe block at the bottom can reuse this exact fixture
// set rather than a second copy that could drift from it — every
// non-project assertion above is unaffected since none of those queries
// filter by projectId.
const PROJECT_ID = 1

const SEED = [
  { title: "cancelled-mine", description: "posted then cancelled", creatorId: CREATOR, status: "cancelled" as const, projectId: PROJECT_ID },
  { title: "cancelled-assigned-to-me", description: "claimed then cancelled", creatorId: OTHER_POSTER, assigneeId: ASSIGNEE, status: "cancelled" as const, projectId: PROJECT_ID },
  { title: "cancelled-not-mine", description: "someone else's, cancelled", creatorId: OTHER_POSTER, status: "cancelled" as const, projectId: PROJECT_ID },
  { title: "still-open", description: "an ordinary open task", creatorId: CREATOR, status: "open" as const, projectId: PROJECT_ID },
]

describe("2026-09-14: GET /api/v1/tasks?status=cancelled applies the cancelled-visibility gate at the query layer", () => {
  // 60s: see escrow-confirm-parity.pg.test.ts / task-pagination.pg.test.ts —
  // concurrent WASM-Postgres init under a full-suite run exceeds the 10s default.
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

  it("anonymous ?status=cancelled returns none of the 3 cancelled rows", async () => {
    const result = await listTasks({ status: "cancelled" })
    expect(result.data).toEqual([])
    expect(result.hasMore).toBe(false)
    expect(result.cursor).toBeNull()
  })

  it("a signed-in viewer who is neither creator nor assignee of any cancelled row also sees none", async () => {
    const result = await listTasks({ status: "cancelled", viewerId: STRANGER })
    expect(result.data).toEqual([])
    expect(result.hasMore).toBe(false)
    expect(result.cursor).toBeNull()
  })

  it("the creator sees their own cancelled task via a bare ?status=cancelled — no &creator= of their own needed", async () => {
    const result = await listTasks({ status: "cancelled", viewerId: CREATOR })
    expect(result.data.map((t) => t.title)).toEqual(["cancelled-mine"])
  })

  it("the assignee sees the cancelled task they were assigned to, even though someone else posted it", async () => {
    const result = await listTasks({ status: "cancelled", viewerId: ASSIGNEE })
    expect(result.data.map((t) => t.title)).toEqual(["cancelled-assigned-to-me"])
  })

  it("a poster of multiple cancelled tasks sees all of their own, not just one", async () => {
    const result = await listTasks({ status: "cancelled", viewerId: OTHER_POSTER })
    expect(result.data.map((t) => t.title).sort()).toEqual(
      ["cancelled-assigned-to-me", "cancelled-not-mine"].sort(),
    )
  })

  it("?status=open is unaffected — the open row returns for anonymous and signed-in callers alike", async () => {
    const anon = await listTasks({ status: "open" })
    const signedIn = await listTasks({ status: "open", viewerId: STRANGER })
    expect(anon.data.map((t) => t.title)).toEqual(["still-open"])
    expect(signedIn.data.map((t) => t.title)).toEqual(["still-open"])
  })
})

describe("2026-09-14, second pass: GET /api/v1/tasks?project=<id> applies the same gate", () => {
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

  it("anonymous sees the project's open task but none of its cancelled ones", async () => {
    const result = await listTasks({ projectId: PROJECT_ID })
    expect(result.data.map((t) => t.title)).toEqual(["still-open"])
  })

  it("a signed-in viewer who is neither creator nor assignee of any cancelled row in the project also sees none of them", async () => {
    const result = await listTasks({ projectId: PROJECT_ID, viewerId: STRANGER })
    expect(result.data.map((t) => t.title)).toEqual(["still-open"])
  })

  it("the creator sees their own cancelled task in the project view, alongside the open one — the kanban's other columns are untouched", async () => {
    const result = await listTasks({ projectId: PROJECT_ID, viewerId: CREATOR })
    expect(result.data.map((t) => t.title).sort()).toEqual(
      ["cancelled-mine", "still-open"].sort(),
    )
  })

  it("the assignee sees the cancelled task they were assigned to, in the project view, even though someone else posted it", async () => {
    const result = await listTasks({ projectId: PROJECT_ID, viewerId: ASSIGNEE })
    expect(result.data.map((t) => t.title).sort()).toEqual(
      ["cancelled-assigned-to-me", "still-open"].sort(),
    )
  })

  it("?project=<id>&status=cancelled anonymous returns none of the project's cancelled rows — empty, hasMore false, cursor null", async () => {
    const result = await listTasks({ projectId: PROJECT_ID, status: "cancelled" })
    expect(result.data).toEqual([])
    expect(result.hasMore).toBe(false)
    expect(result.cursor).toBeNull()
  })

  it("?project=<id>&status=cancelled still reaches the caller's own cancelled row when they are the creator", async () => {
    const result = await listTasks({ projectId: PROJECT_ID, status: "cancelled", viewerId: CREATOR })
    expect(result.data.map((t) => t.title)).toEqual(["cancelled-mine"])
  })

  // THIRD PASS (2026-09-14, PR #580 review finding): the second-pass fix
  // above is only exercised with an explicit viewerId or none at all — it
  // never pinned the EXACT call shape GET /api/v1/projects/[slug] actually
  // uses, `listTasks({ projectId, limit: 100 })` with no `viewerId` key at
  // all (the route called listTasks BEFORE reading the session, so viewerId
  // was never wired through). That shape is what shipped the over-hiding
  // regression: `filters.viewerId` undefined hits the SAME `sql`false``
  // branch as an explicit `null`, so every cancelled row — including the
  // caller's own — silently dropped out, for every caller, all the time.
  // These three cases pin the route's literal call shape directly against
  // listTasks, independent of the route's own session-wiring (covered in
  // projects-slug-route-public-text.test.ts).
  it("route call shape, no viewerId key at all: open rows only, zero cancelled — the fail-closed default", async () => {
    const result = await listTasks({ projectId: PROJECT_ID, limit: 100 })
    expect(result.data.map((t) => t.title)).toEqual(["still-open"])
  })

  it("route call shape with viewerId = CREATOR: the creator's own cancelled row is present alongside the open one", async () => {
    const result = await listTasks({ projectId: PROJECT_ID, limit: 100, viewerId: CREATOR })
    expect(result.data.map((t) => t.title).sort()).toEqual(
      ["cancelled-mine", "still-open"].sort(),
    )
  })

  it("route call shape with viewerId = ASSIGNEE: the assignee's cancelled row is present alongside the open one", async () => {
    const result = await listTasks({ projectId: PROJECT_ID, limit: 100, viewerId: ASSIGNEE })
    expect(result.data.map((t) => t.title).sort()).toEqual(
      ["cancelled-assigned-to-me", "still-open"].sort(),
    )
  })
})
