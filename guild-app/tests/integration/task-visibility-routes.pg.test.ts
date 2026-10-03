/**
 * End-to-end cancelled-task visibility through the REAL route handlers
 * (2026-09-14 follow-up to #578/#580). Every existing cancelled-visibility
 * test either mocks `listTasks` entirely (tasks-route-public-text.test.ts,
 * projects-slug-route-public-text.test.ts, tasks-id-route-public-text.test.ts)
 * or calls `listTasks` directly against pglite
 * (task-list-cancelled-visibility.pg.test.ts) — nothing runs the actual GET
 * route handlers end-to-end against a real (pglite) database. That gap is
 * exactly what let #580's commit 2 (`projects/[slug]` calling `listTasks`
 * with NO `viewerId` at all, so its own `sql`false`` default silently
 * dropped every cancelled row for every caller, including a row's own
 * creator/assignee) pass the full suite: the mocked route tests hand back a
 * canned array regardless of what the route actually passed to `listTasks`,
 * and the pglite test calls `listTasks` directly, bypassing the route's own
 * wiring bug entirely.
 *
 * This file imports the REAL route handlers — GET from
 * src/app/api/v1/tasks/route.ts, GET from
 * src/app/api/v1/projects/[slug]/route.ts, and GET from
 * src/app/api/v1/tasks/[id]/route.ts — and runs them against the SAME
 * pglite-backed `@/db` proxy task-list-cancelled-visibility.pg.test.ts uses,
 * mocking ONLY `getSessionUser` (anonymous / creator / assignee / stranger)
 * and `findProjectBySlug` (the [slug] route's only project lookup; the
 * regular `findProjectById` the [id] route also calls stays REAL, hitting
 * the same pglite `projects` table). Every other query function
 * (`listTasks`, `findTaskById`, `getSubmissionCount`, `findProjectById`,
 * `getTrustStats`, `getPosterCancelStats`) runs unmocked, for real, so a
 * route that forgets to wire `viewerId` through — the exact #580 commit-2
 * shape — fails a test here even though every mocked-`listTasks` test above
 * stays green.
 *
 * Fixture rows are DUPLICATED (not shared-imported) from
 * task-list-cancelled-visibility.pg.test.ts: the two files' DDL needs differ
 * (this file also needs empty `submissions` / `escrow_transactions` /
 * `projects` tables so the [id] route's unmocked side-queries — none of
 * which this file mocks — don't 42P01 against a missing relation), so a
 * clean shared-helper extraction would need its own module for a two-file
 * reuse. Kept name-for-name identical (CREATOR / OTHER_POSTER / ASSIGNEE /
 * STRANGER / PROJECT_ID / SEED) so both files describe the same reality.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import * as schema from "@/db/schema"
import { tasks } from "@/db/schema"

// listTasks / findTaskById / getSubmissionCount / findProjectById /
// getTrustStats / getPosterCancelStats all read `db` from "@/db" — point it
// at the pglite-backed drizzle instance, same proxy trick as
// task-list-cancelled-visibility.pg.test.ts. The proxy binds methods to the
// real instance so drizzle's `this` is preserved.
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

// Mock ONLY getSessionUser — withAuth (used at module scope by the tasks and
// tasks/[id] routes' POST/PATCH/DELETE exports, never invoked by these GET
// tests) stays the REAL implementation via importOriginal, so this is a
// true single-function mock, not a stand-in auth module.
const { mockGetSessionUser } = vi.hoisted(() => ({ mockGetSessionUser: vi.fn() }))
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>()
  return { ...actual, getSessionUser: mockGetSessionUser }
})

// Mock ONLY findProjectBySlug — findProjectById (called for real by the
// tasks/[id] route below) stays the REAL implementation via importOriginal,
// hitting the same pglite `projects` table as everything else here.
const { mockFindProjectBySlug } = vi.hoisted(() => ({ mockFindProjectBySlug: vi.fn() }))
vi.mock("@/db/queries/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/queries/projects")>()
  return { ...actual, findProjectBySlug: mockFindProjectBySlug }
})

// Import the REAL route handlers AFTER the mocks above are registered.
import { GET as tasksGET } from "@/app/api/v1/tasks/route"
import { GET as projectSlugGET } from "@/app/api/v1/projects/[slug]/route"
import { GET as taskIdGET } from "@/app/api/v1/tasks/[id]/route"

// Same standalone `tasks` DDL as task-list-cancelled-visibility.pg.test.ts /
// task-pagination.pg.test.ts (FK-referenced tables omitted — drizzle builds
// SQL from schema metadata, and PG only enforces FKs at insert, which we
// never exercise for those references). Columns mirror
// src/db/schema/tasks.ts exactly.
//
// PLUS three tables that file didn't need: `findTaskById` /
// `getSubmissionCount` / `findProjectById` / `getTrustStats` /
// `getPosterCancelStats` all run for REAL here (none of them are mocked),
// and each reaches a table beyond `tasks` — `submissions`
// (getSubmissionCount, getTrustStats), `escrow_transactions`
// (getTrustStats), `projects` (findProjectById). None of these tables are
// ever written to below; they exist purely so the unmocked queries find a
// real (empty) relation instead of erroring "relation does not exist" —
// empty is the correct fixture, since no task here has a submission or an
// escrow transaction. Columns mirror their respective src/db/schema/*.ts
// files.
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
  WHERE on_chain_task_id IS NOT NULL;

CREATE TABLE submissions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id integer,
  submitter_id text,
  content text,
  status text DEFAULT 'pending',
  reviewer_id text,
  review_note text,
  decline_reason text,
  declined_at timestamptz,
  approved_at timestamptz,
  pr_verification jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE escrow_transactions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id integer,
  from_user_id text,
  to_user_id text,
  amount_xrd numeric(38,18),
  reward_resource text,
  tx_type text,
  party text,
  lane text,
  destination text,
  status text DEFAULT 'pending',
  tx_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Both named constraints below are unused by getTrustStats (the only reader
  -- of this table here — an empty table, never written to) but are declared
  -- anyway so this DDL keeps tracking src/db/schema/escrow-transactions.ts —
  -- see tests/unit/schema-ddl-drift.test.ts, which fails any pg test file
  -- that hand-writes this table without every index/check the real schema has.
  CONSTRAINT escrow_entitlement_fields_present
    CHECK (tx_type NOT IN ('settle', 'withdraw')
      OR (tx_hash IS NOT NULL AND party IS NOT NULL AND lane IS NOT NULL)),
  CONSTRAINT escrow_legacy_rows_have_no_entitlement_fields
    CHECK (tx_type IN ('settle', 'withdraw')
      OR (party IS NULL AND lane IS NULL AND destination IS NULL))
);
CREATE UNIQUE INDEX escrow_legacy_task_tx_type_unique ON escrow_transactions (task_id, tx_type)
  WHERE tx_type IN ('fund', 'release', 'refund', 'dispute');
CREATE UNIQUE INDEX escrow_entitlement_unique ON escrow_transactions (tx_hash, task_id, tx_type, party, lane)
  WHERE tx_type IN ('settle', 'withdraw');

CREATE TABLE projects (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text,
  slug text,
  description text DEFAULT '',
  commissioner_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);`

let pg: PGlite
let db: ReturnType<typeof drizzle>

// Real-row-shaped fixtures, duplicated from
// task-list-cancelled-visibility.pg.test.ts (see file-level comment): a
// poster's own cancelled task, a DIFFERENT poster's task that was claimed
// and then cancelled (so the assignee — not the creator — is the party who
// must still see it), a third cancelled row neither test viewer has any
// relationship to, and one ordinary open row to prove `?status=open` (and
// the default list) are untouched. All four share one project so the
// `?project=<id>` / embedded-slug scenarios reuse the exact same set.
const CREATOR = "account_rdx1creator_of_36"
const OTHER_POSTER = "account_rdx1other_poster"
const ASSIGNEE = "account_rdx1assignee_of_38"
const STRANGER = "account_rdx1stranger"
const PROJECT_ID = 1

const SEED = [
  { title: "cancelled-mine", description: "posted then cancelled", creatorId: CREATOR, status: "cancelled" as const, projectId: PROJECT_ID },
  { title: "cancelled-assigned-to-me", description: "claimed then cancelled", creatorId: OTHER_POSTER, assigneeId: ASSIGNEE, status: "cancelled" as const, projectId: PROJECT_ID },
  { title: "cancelled-not-mine", description: "someone else's, cancelled", creatorId: OTHER_POSTER, status: "cancelled" as const, projectId: PROJECT_ID },
  { title: "still-open", description: "an ordinary open task", creatorId: CREATOR, status: "open" as const, projectId: PROJECT_ID },
]

// Populated fresh in beforeEach from the real, drizzle-assigned ids — never
// assumed from insertion order, so a future reordering of SEED can't
// silently desync the ids these tests request by.
let idOf: Record<string, number> = {}

const NONEXISTENT_ID = 999_999

const project = {
  id: PROJECT_ID,
  name: "Visibility Test Project",
  slug: "visibility-test-project",
  description: "",
  commissionerId: CREATOR,
  createdAt: new Date(),
  updatedAt: new Date(),
}

function tasksReq(query: string) {
  return { url: `http://localhost/api/v1/tasks${query}` } as never
}
function idCtx(id: number | string) {
  return { params: Promise.resolve({ id: String(id) }) } as never
}
function slugCtx(slug: string) {
  return { params: Promise.resolve({ slug }) } as never
}

describe("end-to-end cancelled-task visibility through the real route handlers (2026-09-14)", () => {
  // 60s: see escrow-confirm-parity.pg.test.ts / task-pagination.pg.test.ts —
  // concurrent WASM-Postgres init under a full-suite run exceeds the 10s
  // default.
  beforeAll(async () => {
    pg = new PGlite()
    db = drizzle(pg, { schema })
    H.db = db
    await pg.exec(DDL)
  }, 60_000)

  beforeEach(async () => {
    vi.clearAllMocks()
    mockFindProjectBySlug.mockResolvedValue(project)
    await pg.exec("TRUNCATE tasks RESTART IDENTITY")
    const rows = await db.insert(tasks).values(SEED).returning({ id: tasks.id, title: tasks.title })
    idOf = Object.fromEntries(rows.map((r) => [r.title, r.id]))
  })

  // ── (a) GET /api/v1/tasks?status=cancelled — non-project view ──────────
  describe("(a) ?status=cancelled", () => {
    it("anonymous: empty data, hasMore false, cursor null", async () => {
      mockGetSessionUser.mockResolvedValue(null)
      const res = await tasksGET(tasksReq("?status=cancelled"))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.data).toEqual([])
      expect(body.hasMore).toBe(false)
      expect(body.cursor).toBeNull()
    })

    it("creator sees their own cancelled task, nothing else", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: CREATOR })
      const res = await tasksGET(tasksReq("?status=cancelled"))
      const body = await res.json()
      expect(body.data.map((t: { title: string }) => t.title)).toEqual(["cancelled-mine"])
      expect(body.hasMore).toBe(false)
    })

    it("assignee sees the cancelled task they were assigned to, even though someone else posted it", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: ASSIGNEE })
      const res = await tasksGET(tasksReq("?status=cancelled"))
      const body = await res.json()
      expect(body.data.map((t: { title: string }) => t.title)).toEqual(["cancelled-assigned-to-me"])
    })

    it("a stranger (neither creator nor assignee of any cancelled row) sees none", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: STRANGER })
      const res = await tasksGET(tasksReq("?status=cancelled"))
      const body = await res.json()
      expect(body.data).toEqual([])
      expect(body.hasMore).toBe(false)
      expect(body.cursor).toBeNull()
    })
  })

  // ── (b) GET /api/v1/tasks?project=<id> — project-scoped view ───────────
  describe("(b) ?project=<id>", () => {
    it("anonymous sees the open row only", async () => {
      mockGetSessionUser.mockResolvedValue(null)
      const res = await tasksGET(tasksReq(`?project=${PROJECT_ID}`))
      const body = await res.json()
      expect(body.data.map((t: { title: string }) => t.title)).toEqual(["still-open"])
    })

    it("the creator sees their cancelled row plus the open row", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: CREATOR })
      const res = await tasksGET(tasksReq(`?project=${PROJECT_ID}`))
      const body = await res.json()
      expect(body.data.map((t: { title: string }) => t.title).sort()).toEqual(
        ["cancelled-mine", "still-open"].sort(),
      )
    })

    it("the assignee sees their cancelled row plus the open row", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: ASSIGNEE })
      const res = await tasksGET(tasksReq(`?project=${PROJECT_ID}`))
      const body = await res.json()
      expect(body.data.map((t: { title: string }) => t.title).sort()).toEqual(
        ["cancelled-assigned-to-me", "still-open"].sort(),
      )
    })

    it("a stranger sees the open row only", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: STRANGER })
      const res = await tasksGET(tasksReq(`?project=${PROJECT_ID}`))
      const body = await res.json()
      expect(body.data.map((t: { title: string }) => t.title)).toEqual(["still-open"])
    })
  })

  // ── (c) GET /api/v1/projects/[slug] — embedded task list ───────────────
  describe("(c) projects/[slug] embed", () => {
    it("anonymous sees the open task only", async () => {
      mockGetSessionUser.mockResolvedValue(null)
      const res = await projectSlugGET({} as never, slugCtx(project.slug))
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.data.tasks.map((t: { title: string }) => t.title)).toEqual(["still-open"])
    })

    it("the creator sees their cancelled task embedded alongside the open one", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: CREATOR })
      const res = await projectSlugGET({} as never, slugCtx(project.slug))
      const body = await res.json()
      expect(body.data.tasks.map((t: { title: string }) => t.title).sort()).toEqual(
        ["cancelled-mine", "still-open"].sort(),
      )
    })

    it("the assignee sees their cancelled task embedded alongside the open one", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: ASSIGNEE })
      const res = await projectSlugGET({} as never, slugCtx(project.slug))
      const body = await res.json()
      expect(body.data.tasks.map((t: { title: string }) => t.title).sort()).toEqual(
        ["cancelled-assigned-to-me", "still-open"].sort(),
      )
    })

    it("a stranger sees the open task only", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: STRANGER })
      const res = await projectSlugGET({} as never, slugCtx(project.slug))
      const body = await res.json()
      expect(body.data.tasks.map((t: { title: string }) => t.title)).toEqual(["still-open"])
    })

    // Regression pin for #580 commit 2: that commit had the route call
    // `listTasks({ projectId, limit: 100 })` with NO `viewerId` key at all —
    // which hits listTasks' own fail-closed `sql`false`` default and drops
    // EVERY cancelled row for EVERY caller, including the row's own
    // creator. This test exercises the REAL route end-to-end (not
    // `listTasks` directly, the way task-list-cancelled-visibility.pg.test.ts
    // does), so it would fail exactly the way #580 commit 2 shipped: if the
    // route ever again calls `listTasks` without threading `viewerId`
    // through, the creator's own cancelled row silently disappears from
    // this assertion.
    it("regression pin (#580 commit 2): the creator's own cancelled row survives the real handler, proving viewerId is actually wired through", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: CREATOR })
      const res = await projectSlugGET({} as never, slugCtx(project.slug))
      const body = await res.json()
      const titles = body.data.tasks.map((t: { title: string }) => t.title)
      expect(titles).toContain("cancelled-mine")
    })
  })

  // ── (d) GET /api/v1/tasks/[id] — single-task existence gate ────────────
  describe("(d) tasks/[id]", () => {
    // 2026-09-14, second pass: an anonymous caller no longer gets the
    // identical 404 a missing id returns — it gets ARCHIVED_SIGN_IN_REQUIRED
    // instead, because that population might be this task's own party with
    // a lapsed session cookie. The "identical to a missing id" invariant
    // still holds, just for a SIGNED-IN non-party (the next test) — see
    // cancelledTaskLookupCode's docblock (src/lib/public-task-text.ts).
    it("anonymous gets ARCHIVED_SIGN_IN_REQUIRED, distinct from a nonexistent id's plain 404", async () => {
      mockGetSessionUser.mockResolvedValue(null)
      const res = await taskIdGET({} as never, idCtx(idOf["cancelled-not-mine"]))
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error.code).toBe("ARCHIVED_SIGN_IN_REQUIRED")

      const missingRes = await taskIdGET({} as never, idCtx(NONEXISTENT_ID))
      const missingBody = await missingRes.json()
      expect(missingRes.status).toBe(404)
      expect(missingBody.error.code).toBe("NOT_FOUND")
      expect(missingBody).not.toEqual(body)
    })

    it("a stranger also gets the SAME 404 body a nonexistent id would", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: STRANGER })
      const res = await taskIdGET({} as never, idCtx(idOf["cancelled-not-mine"]))
      expect(res.status).toBe(404)
      const body = await res.json()

      const missingRes = await taskIdGET({} as never, idCtx(NONEXISTENT_ID))
      const missingBody = await missingRes.json()
      expect(missingRes.status).toBe(res.status)
      expect(missingBody).toEqual(body)
    })

    it("the creator gets 200 for their own cancelled task", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: CREATOR })
      const res = await taskIdGET({} as never, idCtx(idOf["cancelled-mine"]))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.data.status).toBe("cancelled")
      expect(body.data.title).toBe("cancelled-mine")
    })

    it("the assignee gets 200 for the cancelled task they were assigned to", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: ASSIGNEE })
      const res = await taskIdGET({} as never, idCtx(idOf["cancelled-assigned-to-me"]))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.data.status).toBe("cancelled")
      expect(body.data.title).toBe("cancelled-assigned-to-me")
    })
  })

  // ── (e) ?status=open unaffected; default list hides cancelled ──────────
  describe("(e) non-cancelled statuses are untouched", () => {
    it("?status=open returns the open row for anonymous and signed-in callers alike", async () => {
      mockGetSessionUser.mockResolvedValue(null)
      const anon = await tasksGET(tasksReq("?status=open"))
      const anonBody = await anon.json()
      expect(anonBody.data.map((t: { title: string }) => t.title)).toEqual(["still-open"])

      mockGetSessionUser.mockResolvedValue({ userId: STRANGER })
      const signedIn = await tasksGET(tasksReq("?status=open"))
      const signedInBody = await signedIn.json()
      expect(signedInBody.data.map((t: { title: string }) => t.title)).toEqual(["still-open"])
    })

    it("the default (no status filter) list hides all cancelled rows and keeps the open one, for anonymous", async () => {
      mockGetSessionUser.mockResolvedValue(null)
      const res = await tasksGET(tasksReq(""))
      const body = await res.json()
      expect(body.data.map((t: { title: string }) => t.title)).toEqual(["still-open"])
    })

    it("the default (no status filter) list hides all cancelled rows even for their own creator — R6 default-hide is not the cancelled-visibility gate", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: CREATOR })
      const res = await tasksGET(tasksReq(""))
      const body = await res.json()
      expect(body.data.map((t: { title: string }) => t.title)).toEqual(["still-open"])
    })
  })

  // ── (f) ?creator= / ?assignee= — the profile page's own-tasks reads, and
  //    the `ownerView` flag that says which view was served (2026-09-14) ───
  describe("(f) creator/assignee-scoped reads report ownerView, end-to-end", () => {
    const titles = (body: { data: { title: string }[] }) => body.data.map((t) => t.title).sort()

    it("the creator's own session: ownerView:true and their cancelled row is back in the list", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: CREATOR })
      const res = await tasksGET(tasksReq(`?creator=${CREATOR}`))
      const body = await res.json()
      expect(body.ownerView).toBe(true)
      expect(titles(body)).toEqual(["cancelled-mine", "still-open"])
    })

    it("anonymous ?creator=<creator> (a lapsed cookie looks exactly like this): ownerView:false and ONLY the open row — the state the profile page must not read as 'no archive'", async () => {
      mockGetSessionUser.mockResolvedValue(null)
      const res = await tasksGET(tasksReq(`?creator=${CREATOR}`))
      const body = await res.json()
      expect(body.ownerView).toBe(false)
      expect(titles(body)).toEqual(["still-open"])
    })

    it("the assignee's own session on ?assignee=: ownerView:true and the cancelled-after-claim row is reachable", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: ASSIGNEE })
      const res = await tasksGET(tasksReq(`?assignee=${ASSIGNEE}`))
      const body = await res.json()
      expect(body.ownerView).toBe(true)
      expect(titles(body)).toEqual(["cancelled-assigned-to-me"])
    })

    it("a stranger's session on ?assignee=<assignee>: ownerView:false and an empty list — the flag never leaks the row it hides", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: STRANGER })
      const res = await tasksGET(tasksReq(`?assignee=${ASSIGNEE}`))
      const body = await res.json()
      expect(body.ownerView).toBe(false)
      expect(titles(body)).toEqual([])
    })

    it("a session read that throws degrades to ownerView:false at HTTP 200, never a 500", async () => {
      mockGetSessionUser.mockRejectedValue(new Error("cookie store unavailable"))
      const res = await tasksGET(tasksReq(`?creator=${CREATOR}`))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ownerView).toBe(false)
      expect(titles(body)).toEqual(["still-open"])
    })
  })
})
