/**
 * The reward the column cannot hold gets a 400, not a 500 — proven against a
 * REAL Postgres (pglite) through the REAL route handlers.
 *
 * THE DEFECT (surfaced 2026-09-18 by an adversarial review of PR #705,
 * reproduced end-to-end before the fix): `REWARD_SHAPE_RE` bounded only the
 * decimal half of a reward. `tasks.reward_xrd` is numeric(38,18) — 20 integer
 * digits. So a 21-digit reward cleared the create form, cleared
 * `rewardAmountSchema` on POST *and* PATCH, reached the INSERT, and Postgres
 * raised `22003 numeric field overflow`. Nothing maps that: `fromError` only
 * translates `AppError`, so `withAuth`'s catch returned
 *   500 {"code":"INTERNAL_ERROR","message":"Internal server error"}
 * where the API's contract is a 400 VALIDATION_ERROR — and, for a poster, a
 * wizard that cleared every step and then broke at Post Task with no reason
 * given. Measured before the fix: POST 20 digits -> 201, POST 21 -> 500,
 * PATCH 21 onto an open task -> 500.
 *
 * WHY THIS FILE AND NOT ONLY A UNIT TEST: create-task-reward-parity.test.ts
 * pins the regex and the schemas agree with each other by construction, since
 * they share one definition — which is exactly why a unit test could not have
 * caught this. Both sides were wrong TOGETHER, and in perfect agreement. Only
 * the third party to the contract, the COLUMN, disagreed. This file is the one
 * place that party gets a vote.
 *
 * MUTATION-PROVEN 2026-09-18 against the named defect: restore the unbounded
 * integer part in marketplace.ts (`^\d+(\.\d{1,8})?$`, exactly what shipped
 * before the fix) and both "is refused with 400" tests go red with the real
 * 500 — not with a mocked one. Widening `tasks.reward_xrd` past numeric(38,18)
 * without moving XRD_MAX_INT_DIGITS is caught by
 * tests/unit/xrd-int-digits-column-parity.test.ts instead.
 *
 * WHAT IT DOES NOT PROVE: anything about the live database's actual column
 * width (pglite runs this file's DDL, which mirrors src/db/schema/tasks.ts —
 * the unit gate above is what ties the constant to that schema), and nothing
 * about the browser. It also says nothing about whether a 20-digit reward is
 * SENSIBLE — only that it is storable; the escrow floor is the other end.
 */
import { describe, it, expect, beforeAll, vi } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import * as schema from "@/db/schema"
import { XRD_MAX_INT_DIGITS } from "@/lib/marketplace"

// Every query function reads `db` from "@/db" — point it at the pglite-backed
// drizzle instance. Same proxy as task-pagination.pg.test.ts; it binds methods
// to the real instance so drizzle's `this` is preserved.
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

// @/lib/auth stays ENTIRELY real — withAuth, getSessionUser, isSuspended AND
// the `catch (err) { return fromError(err) }` that produced the 500. That catch
// is the thing under test, so mocking any of it would be mocking the defect.
// Only next/headers' cookies() is stubbed, handing back a genuinely signed
// session JWT.
process.env.JWT_SECRET = "reward-column-overflow-test-secret"
const CK = vi.hoisted(() => ({ token: "" }))
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (n === "guild_session" ? { value: CK.token } : undefined),
  }),
}))

// The halt gate reads the chain over the network. Not what this file is about.
vi.mock("@/lib/chain-halt-gate", () => ({ chainWriteGate: async () => null }))

import { createSession } from "@/lib/auth"
import { POST as tasksPOST } from "@/app/api/v1/tasks/route"
import { PATCH as taskPATCH } from "@/app/api/v1/tasks/[id]/route"

// Columns mirror src/db/schema/*.ts exactly — reward_xrd's numeric(38,18) is
// the whole point of the file, so it is NOT simplified. FK-referenced tables
// beyond `users` are omitted; PG only enforces FKs at insert, and nothing here
// inserts a project or working group.
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
CREATE TABLE users (
  id text PRIMARY KEY,
  display_name text,
  badge_id text,
  badge_tier text,
  xp integer NOT NULL DEFAULT 0,
  reputation integer NOT NULL DEFAULT 0,
  is_agent boolean NOT NULL DEFAULT false,
  suspended_at timestamptz,
  suspended_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
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
);`

const AT_LIMIT = "9".repeat(XRD_MAX_INT_DIGITS) // 20 digits — the widest the column holds
const OVER_LIMIT = "9".repeat(XRD_MAX_INT_DIGITS + 1) // 21 — one too many

let pg: PGlite

type ApiBody = { ok: boolean; data?: { id: number }; error?: { code: string; message: string } }

/**
 * A FRESH POSTER PER TEST — the route's create limiter is 5/min keyed on
 * `user.userId` (rate-limit.ts), and its `hits` Map is created once at module
 * scope in tasks/route.ts. The route handlers are bound by the static imports
 * above, so that Map is shared by every test in this file for the whole run.
 *
 * ⚠️ This was a `beforeEach(() => vi.resetModules())` commented as giving each
 * test "a fresh module state". It did not, and could not: `resetModules()`
 * only affects a LATER dynamic `import()`, never an already-bound static one,
 * so the limiter was shared regardless and the file passed only because it
 * happens to make 4 POSTs against a budget of 5 — one call of margin. MEASURED:
 * restore the single shared poster and add two more POSTs and the last test
 * fails on a 429, for a reason having nothing to do with rewards. That is the
 * same vacuous-pass shape this PR flags elsewhere; caught in adversarial review
 * of #710. A distinct userId per test gives each one its own bucket for real,
 * which is what the old comment only claimed.
 */
let posterSeq = 0
async function freshPoster(): Promise<string> {
  const id = `account_rdx_test_poster_${++posterSeq}`
  await pg.query(`INSERT INTO users (id) VALUES ($1)`, [id])
  CK.token = await createSession(id)
  return id
}

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(DDL)
  H.db = drizzle(pg, { schema })
}, 60_000)

function postTask(reward: string) {
  return tasksPOST(
    new Request("http://localhost/api/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Write the integration docs",
        description: "Write the API integration documentation for external agents.",
        reward_amount: reward,
      }),
    }) as never,
    { params: Promise.resolve({}) } as never,
  )
}

function patchReward(id: number, reward: string) {
  return taskPATCH(
    new Request(`http://localhost/api/v1/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reward_amount: reward }),
    }) as never,
    { params: Promise.resolve({ id: String(id) }) } as never,
  )
}

describe("POST /api/v1/tasks — a reward wider than the reward column", () => {
  it("takes the widest reward the column can actually hold", async () => {
    await freshPoster()
    const res = await postTask(AT_LIMIT)
    const body = (await res.json()) as ApiBody
    expect({ status: res.status, ok: body.ok }).toEqual({ status: 201, ok: true })
    // Round-tripped through numeric(38,18), so the value really was stored.
    const row = await pg.query<{ reward_xrd: string }>(
      `SELECT reward_xrd FROM tasks WHERE id = $1`,
      [body.data!.id],
    )
    expect(row.rows[0].reward_xrd).toBe(`${AT_LIMIT}.${"0".repeat(18)}`)
  })

  it("is refused with 400 VALIDATION_ERROR — not the 500 it used to raise", async () => {
    await freshPoster()
    const before = await pg.query<{ n: string }>(`SELECT count(*) AS n FROM tasks`)
    const res = await postTask(OVER_LIMIT)
    const body = (await res.json()) as ApiBody

    expect(res.status).toBe(400)
    expect(body.error?.code).toBe("VALIDATION_ERROR")
    // The exact shape of the old bug, asserted so a regression cannot pass by
    // merely being "an error".
    expect(res.status).not.toBe(500)
    expect(body.error?.message).not.toBe("Internal server error")

    // Refused BEFORE the INSERT: no orphan row, which is the other half of
    // what a validation refusal means here.
    const after = await pg.query<{ n: string }>(`SELECT count(*) AS n FROM tasks`)
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })
})

describe("PATCH /api/v1/tasks/[id] — the path with no form in front of it", () => {
  it("is refused with 400, leaving the stored reward untouched", async () => {
    await freshPoster()
    const created = await postTask("500")
    const createdBody = (await created.json()) as ApiBody
    expect(created.status).toBe(201)
    const id = createdBody.data!.id

    const res = await patchReward(id, OVER_LIMIT)
    const body = (await res.json()) as ApiBody

    expect(res.status).toBe(400)
    expect(body.error?.code).toBe("VALIDATION_ERROR")
    expect(body.error?.message).not.toBe("Internal server error")

    const row = await pg.query<{ reward_xrd: string }>(
      `SELECT reward_xrd FROM tasks WHERE id = $1`,
      [id],
    )
    expect(row.rows[0].reward_xrd).toBe(`500.${"0".repeat(18)}`)
  })

  it("still takes a reward at the column's limit, so the cap is not blanket-refusing", async () => {
    // Vacuous-pass guard for the two refusals above: a PATCH schema that
    // refused every reward would pass them and fail this.
    await freshPoster()
    const created = await postTask("500")
    const id = ((await created.json()) as ApiBody).data!.id
    const res = await patchReward(id, AT_LIMIT)
    expect(res.status).toBe(200)
  })
})
