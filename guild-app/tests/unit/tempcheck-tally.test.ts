/**
 * Database-less assertions for the /lights-on tempcheck query layer: tally
 * shaping and the upsert's generated SQL. SQL is rendered via Drizzle
 * `.toSQL()`, which never opens a connection — same pattern as
 * db/queries/game.ts's own test (game-core.test.ts).
 */
import { describe, it, expect } from "vitest"

process.env.DATABASE_URL ??= "postgres://dummy:dummy@127.0.0.1:5432/dummy"

import { buildUpsertVote, countSigned, tallyVotes } from "@/db/queries/tempcheck"

describe("tallyVotes — pure tally shaping", () => {
  it("counts votes per option, in the option-key order given", () => {
    const rows = [
      { optionKey: "yes" },
      { optionKey: "no" },
      { optionKey: "yes" },
      { optionKey: "yes" },
    ]
    expect(tallyVotes(rows, ["yes", "no", "maybe"])).toEqual([
      { key: "yes", count: 3 },
      { key: "no", count: 1 },
      { key: "maybe", count: 0 },
    ])
  })

  it("reports zero for an option nobody has picked yet, rather than omitting it", () => {
    expect(tallyVotes([], ["a", "b"])).toEqual([
      { key: "a", count: 0 },
      { key: "b", count: 0 },
    ])
  })

  it("ignores a row whose option_key is not one of the check's real options", () => {
    // Should be unreachable in practice — the POST route validates option
    // against the same list before writing — but a corrupt or pre-migration
    // row must not inflate a real option's count or silently invent a new one.
    const rows = [{ optionKey: "yes" }, { optionKey: "not-a-real-option" }]
    expect(tallyVotes(rows, ["yes", "no"])).toEqual([
      { key: "yes", count: 1 },
      { key: "no", count: 0 },
    ])
  })

  it("never mutates the optionKeys array it was given", () => {
    const keys = ["a", "b"]
    const frozen = [...keys]
    tallyVotes([{ optionKey: "a" }], keys)
    expect(keys).toEqual(frozen)
  })
})

describe("countSigned — pure signed-in count", () => {
  it("counts only rows cast while signed in", () => {
    const rows = [{ signed: true }, { signed: false }, { signed: true }, { signed: false }]
    expect(countSigned(rows)).toBe(2)
  })

  it("is 0 for no rows and 0 for all-anonymous rows", () => {
    expect(countSigned([])).toBe(0)
    expect(countSigned([{ signed: false }, { signed: false }])).toBe(0)
  })
})

describe("buildUpsertVote — the re-vote-replaces guarantee, in the SQL itself", () => {
  it("is an INSERT ... ON CONFLICT DO UPDATE targeting (check_id, voter_key)", () => {
    const sql = buildUpsertVote({
      checkId: "q1",
      optionKey: "all_three",
      voterKey: "11111111-1111-1111-1111-111111111111",
      userId: null,
      signed: false,
    }).toSQL()

    expect(sql.sql).toMatch(/insert into "tempcheck_votes"/i)
    expect(sql.sql).toMatch(/on conflict/i)
    // The two identity columns must be the conflict target — anything looser
    // (e.g. conflicting on id, or on check_id alone) would either insert a
    // second row per re-vote or collide across different checks.
    expect(sql.sql).toMatch(/"tempcheck_votes_check_voter_unique"|"check_id".*"voter_key"/i)
    expect(sql.sql).toMatch(/do update set/i)
    // option_key must be one of the columns actually re-assigned on conflict —
    // otherwise a re-vote would upsert a no-op and silently keep the old choice.
    expect(sql.sql).toMatch(/"option_key"\s*=/i)
  })

  it("carries the caller's checkId, optionKey, voterKey, userId and signed as bound params", () => {
    const sql = buildUpsertVote({
      checkId: "q2",
      optionKey: "guild",
      voterKey: "22222222-2222-2222-2222-222222222222",
      userId: "account_rdx1test",
      signed: true,
    }).toSQL()

    expect(sql.params).toEqual(
      expect.arrayContaining(["q2", "guild", "22222222-2222-2222-2222-222222222222", "account_rdx1test", true]),
    )
  })
})
