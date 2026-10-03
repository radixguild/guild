/**
 * G-508 — test/operator accounts excluded from the PUBLIC leaderboard, proven
 * against a real Postgres (pglite).
 *
 * leaderboard-sql.test.ts pins the generated SQL shape (`.toSQL()`), but only an
 * executed query proves the `NOT IN` actually drops the rows AND leaves the real
 * users on the board. This seeds the 2026-07-22 Gate-1 smoke fleet (a distinct
 * poster + worker address — the exact two-account self-test a creatorId==assigneeId
 * guard can't catch) alongside real members, runs the REAL getLeaderboard through
 * the GUILD_TEST_ACCOUNTS env wiring, and asserts the fleet is gone while the real
 * members remain. The empty-env case asserts the safe default: no filtering.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import * as schema from "@/db/schema"

// getLeaderboard reads `db` from @/db — point it at the pglite-backed drizzle.
// The Proxy binds methods so drizzle's `this` is preserved (same shape as
// task-pagination.pg.test.ts).
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

import { getLeaderboard } from "@/db/queries/users"
import { getTaskStats } from "@/db/queries/tasks"
import { users, tasks } from "@/db/schema"

// leaderboardQuery's projection subqueries reference tasks / escrow_transactions /
// submissions, so those tables must exist even though this test seeds only users
// (the subquery counts resolve to 0 / NULL, which the leaderboard tolerates). The
// users columns mirror src/db/schema/users.ts.
const DDL = `
CREATE TABLE users (
  id text PRIMARY KEY,
  display_name text,
  badge_id text,
  badge_tier text DEFAULT 'member',
  xp integer NOT NULL DEFAULT 0,
  reputation integer NOT NULL DEFAULT 0,
  is_agent boolean NOT NULL DEFAULT false,
  suspended_at timestamptz,
  suspended_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
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
CREATE TABLE escrow_transactions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id integer,
  from_user_id text,
  to_user_id text,
  amount_xrd numeric(38,18),
  reward_resource text,
  tx_type text NOT NULL,
  party text,
  lane text,
  destination text,
  status text NOT NULL DEFAULT 'pending',
  tx_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT escrow_entitlement_fields_present CHECK (
    tx_type NOT IN ('settle', 'withdraw')
    OR (tx_hash IS NOT NULL AND party IS NOT NULL AND lane IS NOT NULL)),
  CONSTRAINT escrow_legacy_rows_have_no_entitlement_fields CHECK (
    tx_type IN ('settle', 'withdraw')
    OR (party IS NULL AND lane IS NULL AND destination IS NULL))
);
CREATE UNIQUE INDEX escrow_legacy_task_tx_type_unique ON escrow_transactions (task_id, tx_type)
  WHERE tx_type IN ('fund', 'release', 'refund', 'dispute');
CREATE UNIQUE INDEX escrow_entitlement_unique ON escrow_transactions (tx_hash, task_id, tx_type, party, lane)
  WHERE tx_type IN ('settle', 'withdraw');
CREATE TABLE submissions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id integer,
  submitter_id text,
  status text,
  created_at timestamptz NOT NULL DEFAULT now()
);`

// The 07-22 Gate-1 smoke fleet: a distinct poster + worker, both credited XP by
// their smoke payouts — the two-account self-test shape the SoT calls out.
const FLEET_POSTER = "account_rdx12ynlx369poster000000000000000000000000000000000000000000"
const FLEET_WORKER = "account_rdx12890803worker000000000000000000000000000000000000000000"
const REAL_ALICE = "account_rdx12realalice00000000000000000000000000000000000000000000"
const REAL_BOB = "account_rdx12realbob0000000000000000000000000000000000000000000000"

const SEED = [
  { id: FLEET_POSTER, displayName: "smoke-poster", xp: 10, reputation: 5 },
  { id: FLEET_WORKER, displayName: "smoke-worker", xp: 10, reputation: 5 },
  { id: REAL_ALICE, displayName: "alice", xp: 300, reputation: 40 },
  { id: REAL_BOB, displayName: "bob", xp: 120, reputation: 12 },
]

let pg: PGlite
const prevEnv = process.env.GUILD_TEST_ACCOUNTS

// 60s: concurrent WASM-Postgres init under a full-suite run exceeds the 10s
// default hook timeout (see task-pagination.pg.test.ts). File-level so both
// describes below share the one pglite instance.
beforeAll(async () => {
  pg = new PGlite()
  H.db = drizzle(pg, { schema })
  await pg.exec(DDL)
}, 60_000)

afterEach(() => {
  if (prevEnv === undefined) delete process.env.GUILD_TEST_ACCOUNTS
  else process.env.GUILD_TEST_ACCOUNTS = prevEnv
})

describe("G-508: getLeaderboard excludes test/operator accounts (pglite)", () => {
  beforeEach(async () => {
    await pg.exec("TRUNCATE users RESTART IDENTITY CASCADE")
    await H.db!.insert(users).values(SEED)
  })

  it("with the fleet listed in GUILD_TEST_ACCOUNTS, they no longer appear; real members remain", async () => {
    process.env.GUILD_TEST_ACCOUNTS = `${FLEET_POSTER},${FLEET_WORKER}`
    const rows = await getLeaderboard()
    const ids = rows.map((r) => r.id)

    expect(ids).not.toContain(FLEET_POSTER)
    expect(ids).not.toContain(FLEET_WORKER)
    expect(ids).toEqual([REAL_ALICE, REAL_BOB]) // rep DESC → alice(40) then bob(12)
  })

  it("empty/unset env = no filtering (safe default): the fleet still shows", async () => {
    delete process.env.GUILD_TEST_ACCOUNTS
    const ids = (await getLeaderboard()).map((r) => r.id)
    expect(ids).toEqual(expect.arrayContaining([FLEET_POSTER, FLEET_WORKER, REAL_ALICE, REAL_BOB]))
    expect(ids).toHaveLength(SEED.length)
  })
})

// The other public reporting surface (GET /api/v1/tasks/stats): the smoke's paid
// task must not inflate the marketplace pulse's paid count / totalPaidXrd.
describe("G-508: getTaskStats excludes test/operator tasks (pglite)", () => {
  beforeEach(async () => {
    await pg.exec("TRUNCATE tasks RESTART IDENTITY")
    await H.db!.insert(tasks).values([
      // Smoke task: fleet poster funded, paid to fleet worker.
      { title: "smoke", description: "smoke", status: "paid", rewardXrd: "10", creatorId: FLEET_POSTER, assigneeId: FLEET_WORKER },
      // Real paid task between real members.
      { title: "real-paid", description: "real", status: "paid", rewardXrd: "250", creatorId: REAL_ALICE, assigneeId: REAL_BOB },
      // Real open task, unclaimed (assignee_id NULL) — must survive the NOT IN guard.
      { title: "real-open", description: "real", status: "open", rewardXrd: "40", creatorId: REAL_BOB, assigneeId: null },
    ])
  })

  it("drops the fleet's paid task from paid count + totalPaidXrd when listed", async () => {
    process.env.GUILD_TEST_ACCOUNTS = `${FLEET_POSTER},${FLEET_WORKER}`
    const stats = await getTaskStats()
    expect(stats.counts.paid).toBe(1) // only the real paid task
    expect(Number(stats.totalPaidXrd)).toBe(250)
    expect(stats.counts.open).toBe(1) // the NULL-assignee open task survives
  })

  it("empty env = no filtering: the smoke task still counts", async () => {
    delete process.env.GUILD_TEST_ACCOUNTS
    const stats = await getTaskStats()
    expect(stats.counts.paid).toBe(2)
    expect(Number(stats.totalPaidXrd)).toBe(260)
    expect(stats.counts.open).toBe(1)
  })
})
