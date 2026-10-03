import { describe, it, expect } from "vitest"

// Regression test for the /leaderboard 500 (Postgres 42883, `text = integer`).
//
// Unlike db-queries.test.ts, this file does NOT mock @/db or @/db/schema — it renders
// the *real* SQL via Drizzle's `.toSQL()` so it can catch a SQL-generation bug that a
// mocked db can never see. `.toSQL()` only builds the query string; it never opens a
// connection, so the dummy DATABASE_URL below just satisfies the lazy db Proxy's
// createDb() on first access.
process.env.DATABASE_URL ??= "postgres://dummy:dummy@127.0.0.1:5432/dummy"

import { leaderboardQuery } from "@/db/queries/users"

// Every text→text correlation the leaderboard's subqueries rely on. The bug was
// `${users.id}`: Drizzle renders an interpolated column unqualified as `"id"`,
// which inside `FROM tasks` / `FROM escrow_transactions` / `FROM submissions`
// binds to that table's own integer `id` column, so a text FK ends up compared to
// an integer (`assignee_id (text) = id (integer)` → 42883, the position-138 500).
// The fix references the outer row as the literal `users.id`. Each entry below is
// one FK the projection joins back to the outer users row; all must correlate to
// `users.id`, never to a bare `"id"`.
const CORRELATED_FKS = [
  "tasks.assignee_id", // tasksCompleted / tasksThisMonth
  "to_user_id", // xrdEarned / xrdEarnedThisMonth
  "from_user_id", // disputesAgainst (added with trust tiers, 88a17d0)
  "t.assignee_id", // disputesAgainst
  "t.creator_id", // disputesAgainst
  "s.submitter_id", // deadlineSubmits / onTimeSubmits
]

describe("leaderboardQuery SQL shape", () => {
  const { sql } = leaderboardQuery(50).toSQL()

  // Each FK must correlate to the outer users row as the literal text `users.id`
  // (either `= users.id` or `!= users.id` — from_user_id uses the negation).
  it.each(CORRELATED_FKS)("correlates %s to the outer users.id (text)", (fk) => {
    expect(sql).toMatch(new RegExp(`${fk.replace(".", "\\.")}\\s*!?=\\s*users\\.id`))
  })

  // Blanket guard over the WHOLE projection: no text FK may compare to a bare
  // quoted `"id"`. This is what a revert to `${users.id}` on ANY subquery would
  // render — including the trust-tier subqueries the two original assertions
  // never covered — so it catches the 42883 class, not just the two known sites.
  it("never compares a text FK to a bare quoted \"id\" column (the 42883 mismatch)", () => {
    expect(sql).not.toMatch(/_id\s*!?=\s*"id"/)
  })
})

// G-508: the excluded-account filter is added to the WHERE only when the list is
// non-empty, so an unset env leaves the leaderboard SQL byte-for-byte unchanged
// (the safe default) and the shape assertions above still hold.
describe("leaderboardQuery excluded-account filter (G-508)", () => {
  it("emits no NOT IN clause when the exclusion list is empty (default)", () => {
    const { sql } = leaderboardQuery(50, []).toSQL()
    expect(sql).not.toMatch(/not in/i)
  })

  it("filters users.id with a NOT IN when accounts are excluded", () => {
    const { sql, params } = leaderboardQuery(50, ["account_poster", "account_worker"]).toSQL()
    expect(sql).toMatch(/"users"\."id"\s+not in/i)
    expect(params).toEqual(expect.arrayContaining(["account_poster", "account_worker"]))
  })
})
