/**
 * P3-24 (task 91, 2026-09-15): the party half of "Serve the unscrubbed brief
 * to a task's parties". Every existing publicTaskView/scrub test either
 * mocks `listTasks`/`findTaskById` entirely (tasks-route-public-text.test.ts,
 * tasks-id-route-public-text.test.ts) or exercises the pure predicate
 * directly (public-task-text.test.ts) — nothing runs the REAL route handlers
 * end-to-end against a real (pglite) database with a CLAIMED (non-cancelled)
 * task whose text the public scrub actually touches. That gap is exactly
 * what let the bug ship: `isTaskTextOwner` (creator-only) and
 * `isCancelledTaskVisibleTo` (creator-or-assignee) were tested separately and
 * both looked correct, but no test ever asserted what an ASSIGNEE sees for
 * an ordinary `assigned`/`open` task's title/description — which is the
 * exact path `packages/agent-client`'s `listMine` (worker.ts) reads before
 * building `submit_task`'s brief_hash.
 *
 * Same PGlite pattern as task-visibility-routes.pg.test.ts: imports the REAL
 * route handlers (GET from tasks/route.ts and tasks/[id]/route.ts), mocks
 * ONLY `getSessionUser`, and runs `listTasks`/`findTaskById`/etc. for real
 * against pglite — so a route that forgets to widen its party check (the
 * #580-shaped regression, here for text instead of existence) fails a test
 * here even though a mocked-`listTasks` test would stay green.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import * as schema from "@/db/schema"
import { tasks } from "@/db/schema"
import { canonicalWorkBrief } from "@/lib/escrow-utils"

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

const { mockGetSessionUser } = vi.hoisted(() => ({ mockGetSessionUser: vi.fn() }))
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>()
  return { ...actual, getSessionUser: mockGetSessionUser }
})

// Import the REAL route handlers AFTER the mocks above are registered.
import { GET as tasksGET } from "@/app/api/v1/tasks/route"
import { GET as taskIdGET } from "@/app/api/v1/tasks/[id]/route"

// Same standalone `tasks` DDL as task-visibility-routes.pg.test.ts, plus the
// same empty side tables the [id] route's unmocked queries need
// (submissions/escrow_transactions/projects) — this task has no project, no
// submission, and no escrow transaction, so all three stay empty fixtures.
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

const CREATOR = "account_rdx1poster_90"
const ASSIGNEE = "account_rdx1assignee_90"
const STRANGER = "account_rdx1stranger_90"

// Task 90's production shape: ordinary copy plus one ops-internal line the
// scrub token-redacts mid-sentence. Status 'assigned' — the exact lifecycle
// point where the assignee's local canonicalWorkBrief hash has to match what
// the poster funded, or submit_task reverts.
const RAW_DESCRIPTION = [
  "Write the runbook for provisioning a fresh box.",
  "Verified it manually (via ssh guild-vps read-only).",
  "Budget: 30 XRD.",
].join("\n")

const SEED = [
  {
    title: "Provisioning runbook",
    description: RAW_DESCRIPTION,
    creatorId: CREATOR,
    assigneeId: ASSIGNEE,
    status: "assigned" as const,
    rewardXrd: "30",
  },
]

let idOf: Record<string, number> = {}

function tasksReq(query: string) {
  return { url: `http://localhost/api/v1/tasks${query}` } as never
}
function idCtx(id: number | string) {
  return { params: Promise.resolve({ id: String(id) }) } as never
}

describe("P3-24: parties see the stored brief through the real route handlers (2026-09-15)", () => {
  beforeAll(async () => {
    pg = new PGlite()
    db = drizzle(pg, { schema })
    H.db = db
    await pg.exec(DDL)
  }, 60_000)

  beforeEach(async () => {
    vi.clearAllMocks()
    await pg.exec("TRUNCATE tasks RESTART IDENTITY")
    const rows = await db.insert(tasks).values(SEED).returning({ id: tasks.id, title: tasks.title })
    idOf = Object.fromEntries(rows.map((r) => [r.title, r.id]))
  })

  // Sanity: prove the fixture actually exercises the scrub, so a passing
  // "assignee sees it raw" test below isn't vacuous.
  it("fixture sanity: the raw description DOES contain ops-internal detail the scrub would touch", () => {
    expect(RAW_DESCRIPTION).toContain("ssh guild-vps")
  })

  describe("GET /api/v1/tasks/[id]", () => {
    it("the creator gets the EXACT stored description", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: CREATOR })
      const res = await taskIdGET({} as never, idCtx(idOf["Provisioning runbook"]))
      const body = await res.json()
      expect(body.data.description).toBe(RAW_DESCRIPTION)
    })

    it("the ASSIGNEE — not the poster — gets the EXACT stored description, byte-for-byte", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: ASSIGNEE })
      const res = await taskIdGET({} as never, idCtx(idOf["Provisioning runbook"]))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data.description).toBe(RAW_DESCRIPTION)
      expect(body.data.description).toContain("ssh guild-vps")
    })

    it("a stranger gets the scrubbed description, with the ops line dropped", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: STRANGER })
      const res = await taskIdGET({} as never, idCtx(idOf["Provisioning runbook"]))
      const body = await res.json()
      expect(body.data.description).not.toContain("ssh guild-vps")
      expect(body.data.description).not.toBe(RAW_DESCRIPTION)
    })

    it("an anonymous (no session) viewer also gets the scrubbed description", async () => {
      mockGetSessionUser.mockResolvedValue(null)
      const res = await taskIdGET({} as never, idCtx(idOf["Provisioning runbook"]))
      const body = await res.json()
      expect(body.data.description).not.toContain("ssh guild-vps")
    })
  })

  describe("GET /api/v1/tasks?assignee=<address> — the assignee-scoped list agent-client's worker.ts reads before submit", () => {
    it("the assignee's own session sees the EXACT stored description in the list row", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: ASSIGNEE })
      const res = await tasksGET(tasksReq(`?assignee=${ASSIGNEE}&status=assigned`))
      const body = await res.json()
      expect(body.data).toHaveLength(1)
      expect(body.data[0].description).toBe(RAW_DESCRIPTION)
    })

    it("a stranger's session on the SAME ?assignee= query gets the row scrubbed (querying someone else's assignee filter proves nothing)", async () => {
      mockGetSessionUser.mockResolvedValue({ userId: STRANGER })
      const res = await tasksGET(tasksReq(`?assignee=${ASSIGNEE}&status=assigned`))
      const body = await res.json()
      expect(body.data).toHaveLength(1)
      expect(body.data[0].description).not.toContain("ssh guild-vps")
    })
  })

  // The keystone-check parity this fix exists for, run through the REAL
  // route (not just the pure predicate — see public-task-text.test.ts for
  // that unit-level pin): canonicalWorkBrief(what the assignee's own
  // GET/list calls return) must hash identically to canonicalWorkBrief(the
  // row actually stored), which is what the poster funded on-chain.
  it("canonicalWorkBrief(the assignee's served text, via the real detail route) equals canonicalWorkBrief(the stored row)", async () => {
    const committedBrief = canonicalWorkBrief(SEED[0].title, RAW_DESCRIPTION)

    mockGetSessionUser.mockResolvedValue({ userId: ASSIGNEE })
    const res = await taskIdGET({} as never, idCtx(idOf["Provisioning runbook"]))
    const body = await res.json()
    const assigneeBrief = canonicalWorkBrief(body.data.title, body.data.description)
    expect(assigneeBrief).toBe(committedBrief)

    // And the stranger's view must NOT hash to the committed brief — proving
    // this fixture's scrub isn't a no-op that would make the assertion above
    // vacuously true.
    mockGetSessionUser.mockResolvedValue({ userId: STRANGER })
    const strangerRes = await taskIdGET({} as never, idCtx(idOf["Provisioning runbook"]))
    const strangerBody = await strangerRes.json()
    const strangerBrief = canonicalWorkBrief(strangerBody.data.title, strangerBody.data.description)
    expect(strangerBrief).not.toBe(committedBrief)
  })
})
