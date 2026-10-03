/**
 * listProjectsWithProgress — "the rollup query" (its own docblock's words) that
 * backs both the /projects list cards and the funnel/locked/paid header on
 * /projects/[slug]. The value here is entirely in the aggregation predicates
 * (TASK-TERMS-DESIGN §5: "n of m tasks released, total XRD locked/paid"), which
 * a mock of db.select() cannot exercise — it would only prove the shape of the
 * call, not that "locked" and "paid" mean what the comment says they mean. So
 * this runs the REAL query against pglite, same approach as
 * tests/integration/working-groups.pg.test.ts.
 *
 * Each test pins one predicate from the PROGRESS_COLUMNS comment in
 * src/db/queries/projects.ts:
 *   - paid    = status = 'paid', regardless of on-chain state
 *   - locked  = on_chain_task_id IS NOT NULL AND status NOT IN (paid, cancelled, refunded)
 *   - a task that never went on-chain (on_chain_task_id NULL) must count toward
 *     taskCount but NEVER toward lockedXrd — the honest-escrow-language
 *     distinction the comment calls out explicitly.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { eq } from "drizzle-orm"

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

import { listProjectsWithProgress, createProject } from "@/db/queries/projects"
import { projects, tasks } from "@/db/schema"

// `projects` mirrors src/db/schema/projects.ts exactly (including the new
// updated_at from migration 0025). `tasks` mirrors the SAME DDL block used by
// tests/integration/working-groups.pg.test.ts — drizzle's `.returning()`
// requests every column the real `tasks` schema object declares (not `*`), so
// a trimmed-down tasks DDL fails at INSERT time with "column ... does not
// exist" the moment a test round-trips through seedTask(). Kept in the two
// suites independently (rather than a shared DDL module) on purpose — see
// this repo's own "single query, two hand-kept copies drift" lesson in
// src/lib/agent-lane.ts; a DDL string is not a query, but the failure mode
// (someone edits schema/tasks.ts and only one copy gets updated) is the same
// shape, so keeping both suites' tables plainly visible next to their own
// assertions is the safer trade at this size.
const DDL = `
CREATE TABLE users (
  id text PRIMARY KEY
);
CREATE TABLE projects (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  commissioner_id text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX projects_slug_idx ON projects (slug);
CREATE INDEX projects_commissioner_idx ON projects (commissioner_id);
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
  project_id integer REFERENCES projects(id),
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
// PROGRESS_COLUMNS casts a real sum(numeric(38,18)) to text, which Postgres
// renders at full column scale ("150.000000000000000000"), NOT the trimmed
// "150" a literal COALESCE fallback produces when there is nothing to sum
// (see the "reports zero counts" case below, which genuinely expects "0").
// This only formats the non-empty-sum expectation so each assertion still
// reads as the plain number it means.
const xrd = (n: number) => n.toFixed(18)

describe("listProjectsWithProgress — money/funnel rollup against Postgres (pglite)", () => {
  beforeAll(async () => {
    pg = new PGlite()
    await pg.exec(DDL)
    db = drizzle(pg)
    H.db = db
  }, 60_000)

  beforeEach(async () => {
    await pg.exec("DELETE FROM tasks; DELETE FROM projects; DELETE FROM users;")
    await pg.exec("INSERT INTO users (id) VALUES ('bob'), ('alice');")
  })

  async function seedProject(over: Partial<typeof projects.$inferInsert> = {}) {
    const [p] = await db
      .insert(projects)
      .values({
        name: over.name ?? "P",
        slug: over.slug ?? "p",
        commissionerId: over.commissionerId ?? "bob",
        createdAt: over.createdAt,
        ...over,
      })
      .returning()
    return p
  }

  async function seedTask(over: Partial<typeof tasks.$inferInsert> = {}) {
    const [t] = await db
      .insert(tasks)
      .values({
        title: over.title ?? "t",
        description: "d",
        creatorId: "bob",
        rewardXrd: "10",
        ...over,
      })
      .returning()
    return t
  }

  it("reports zero counts for a project with no tasks", async () => {
    await seedProject({ name: "Empty", slug: "empty" })
    const [row] = await listProjectsWithProgress()
    expect(row.taskCount).toBe(0)
    expect(row.paidCount).toBe(0)
    expect(row.paidXrd).toBe("0")
    expect(row.lockedXrd).toBe("0")
    expect(row.openCount).toBe(0)
    expect(row.inProgressCount).toBe(0)
    expect(row.reviewCount).toBe(0)
  })

  // The /tasks projects-first board's funnel row (task 89): open / in
  // progress / review / paid, computed at read time like paidXrd/lockedXrd
  // above — never a cached column. Mirrors the /projects/[slug] kanban's own
  // COLUMNS mapping (open, claimed=assigned, submitted=submitted+disputed,
  // paid) so the two surfaces never disagree about what "in progress" means.
  it("maps each task status into exactly the funnel column the /projects/[slug] kanban uses", async () => {
    const p = await seedProject({ name: "Funnel", slug: "funnel" })
    await seedTask({ projectId: p.id, status: "open" })
    await seedTask({ projectId: p.id, status: "assigned" })
    await seedTask({ projectId: p.id, status: "submitted" })
    // Disputed sits in the SAME "review" bucket as submitted — still awaiting
    // resolution at that stage, not a fifth column.
    await seedTask({ projectId: p.id, status: "disputed" })
    await seedTask({ projectId: p.id, status: "paid" })
    // Closed statuses count toward taskCount but no funnel column at all.
    await seedTask({ projectId: p.id, status: "cancelled" })
    await seedTask({ projectId: p.id, status: "refunded" })

    const [row] = await listProjectsWithProgress()
    expect(row.taskCount).toBe(7)
    expect(row.openCount).toBe(1)
    expect(row.inProgressCount).toBe(1)
    expect(row.reviewCount).toBe(2)
    expect(row.paidCount).toBe(1)
  })

  it("scopes funnel counts PER PROJECT, same as the money columns", async () => {
    const a = await seedProject({ name: "A", slug: "a" })
    const b = await seedProject({ name: "B", slug: "b" })
    await seedTask({ projectId: a.id, status: "open" })
    await seedTask({ projectId: a.id, status: "open" })
    await seedTask({ projectId: b.id, status: "assigned" })
    const rows = await listProjectsWithProgress()
    expect(rows.find((r) => r.slug === "a")!.openCount).toBe(2)
    expect(rows.find((r) => r.slug === "a")!.inProgressCount).toBe(0)
    expect(rows.find((r) => r.slug === "b")!.openCount).toBe(0)
    expect(rows.find((r) => r.slug === "b")!.inProgressCount).toBe(1)
  })

  it("counts PAID tasks and sums their reward regardless of on-chain state", async () => {
    const p = await seedProject({ name: "Wallet", slug: "wallet" })
    await seedTask({ projectId: p.id, status: "paid", rewardXrd: "100" })
    await seedTask({ projectId: p.id, status: "paid", rewardXrd: "50", onChainTaskId: null })
    const [row] = await listProjectsWithProgress()
    expect(row.taskCount).toBe(2)
    expect(row.paidCount).toBe(2)
    expect(row.paidXrd).toBe(xrd(150))
  })

  it("counts a task toward locked XRD only once it went on-chain AND is still live", async () => {
    const p = await seedProject({ name: "Escrow", slug: "escrow" })
    // On-chain and live → locked.
    await seedTask({ projectId: p.id, status: "assigned", rewardXrd: "40", onChainTaskId: 1 })
    // Never went on-chain → NOT locked, even though it is still open. This is
    // the exact distinction the "honest escrow language" comment exists for:
    // a task that never funded on-chain has nothing actually locked.
    await seedTask({ projectId: p.id, status: "open", rewardXrd: "999", onChainTaskId: null })
    // On-chain but PAID → settled, no longer locked.
    await seedTask({ projectId: p.id, status: "paid", rewardXrd: "60", onChainTaskId: 2 })
    // On-chain but CANCELLED → released, no longer locked.
    await seedTask({ projectId: p.id, status: "cancelled", rewardXrd: "70", onChainTaskId: 3 })
    // On-chain but REFUNDED → released, no longer locked.
    await seedTask({ projectId: p.id, status: "refunded", rewardXrd: "80", onChainTaskId: 4 })

    const [row] = await listProjectsWithProgress()
    expect(row.taskCount).toBe(5)
    expect(row.lockedXrd).toBe(xrd(40))
    expect(row.paidCount).toBe(1)
    expect(row.paidXrd).toBe(xrd(60))
  })

  it("scopes the rollup PER PROJECT — a shared-total bug would flatten these", async () => {
    const a = await seedProject({ name: "A", slug: "a" })
    const b = await seedProject({ name: "B", slug: "b" })
    await seedTask({ projectId: a.id, status: "paid", rewardXrd: "100" })
    await seedTask({ projectId: b.id, status: "paid", rewardXrd: "5" })
    const rows = await listProjectsWithProgress()
    expect(rows.find((r) => r.slug === "a")!.paidXrd).toBe(xrd(100))
    expect(rows.find((r) => r.slug === "b")!.paidXrd).toBe(xrd(5))
  })

  it("a task with no project (project_id null) never leaks into any project's rollup", async () => {
    const p = await seedProject({ name: "Solo", slug: "solo" })
    await seedTask({ projectId: null, status: "paid", rewardXrd: "1000" })
    const [row] = await listProjectsWithProgress()
    expect(row.slug).toBe("solo")
    expect(row.taskCount).toBe(0)
    expect(row.paidXrd).toBe("0")
  })

  it("orders newest project first", async () => {
    await seedProject({ name: "Old", slug: "old", createdAt: D("2026-01-01T00:00:00Z") })
    await seedProject({ name: "New", slug: "new", createdAt: D("2026-06-01T00:00:00Z") })
    const rows = await listProjectsWithProgress()
    expect(rows.map((r) => r.slug)).toEqual(["new", "old"])
  })

  it("createProject's insert relies on the schema default for updatedAt (no explicit write path exists yet)", async () => {
    const p = await createProject({ name: "Fresh Project", commissionerId: "alice" })
    const [row] = await db.select().from(projects).where(eq(projects.id, p.id))
    expect(row.updatedAt).toBeInstanceOf(Date)
  })
})
