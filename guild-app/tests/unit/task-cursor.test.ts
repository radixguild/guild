/**
 * M6 keyset pagination — the coverage that was missing (M7).
 *
 * The reward/deadline pagination bug survived because every sort test used a
 * SINGLE-ROW mock, so the id-vs-sort-column keyset mismatch never showed. These
 * tests exercise MULTI-ROW paging:
 *   - encode/decode round-trips the compound (sortKey, id) cursor;
 *   - taskOrderBy / taskKeysetWhere build the right drizzle shape (transcription);
 *   - a full keyset WALK over an adversarial dataset (reward ties, a high-reward
 *     row with a HIGH id, a NULL-deadline tail) proves the pages neither skip nor
 *     repeat a row — the exact property the old id-only cursor violated.
 *
 * The walk uses the REAL encodeTaskCursor/decodeTaskCursor; refSort/refAfter are
 * a deliberately-separate reference model of the intended order, and the
 * structural tests below pin taskKeysetWhere to that same logic — so a drizzle
 * builder that diverges from the model is caught. (Full SQL-execution coverage
 * against Postgres — pglite — is the recommended M7 follow-up; the repo has no
 * DB-backed test harness yet.)
 */
import { describe, it, expect } from "vitest"

// String-schema mock (same convention as db-queries.test.ts) so the drizzle
// builders in task-cursor.ts render columns as comparable identifiers.
vi.mock("@/db/schema", () => ({
  tasks: {
    id: "tasks.id",
    rewardXrd: "tasks.reward_xrd",
    deadline: "tasks.deadline",
    createdAt: "tasks.created_at",
  },
}))

import { and, or, eq, gt, lt, asc, desc, isNull } from "drizzle-orm"
import {
  type TaskSort,
  encodeTaskCursor,
  decodeTaskCursor,
  taskOrderBy,
  taskKeysetWhere,
} from "@/db/task-cursor"

type Row = { id: number; rewardXrd: string; deadline: Date | null; createdAt: Date }

const row = (o: Partial<Row> & { id: number }): Row => ({
  rewardXrd: "0",
  deadline: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...o,
})

// ── Reference model of the intended order (mirrors taskOrderBy semantics) ──────
function refSort(sort: TaskSort, rows: Row[]): Row[] {
  const r = [...rows]
  if (sort === "reward") return r.sort((a, b) => Number(b.rewardXrd) - Number(a.rewardXrd) || b.id - a.id)
  if (sort === "deadline") {
    return r.sort((a, b) => {
      const av = a.deadline ? a.deadline.getTime() : Infinity // NULLS LAST
      const bv = b.deadline ? b.deadline.getTime() : Infinity
      return av - bv || a.id - b.id
    })
  }
  return r.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id)
}

// Does `row` fall strictly AFTER the cursor in refSort order? (mirrors taskKeysetWhere)
function refAfter(sort: TaskSort, cur: { k: string | null; id: number }, x: Row): boolean {
  if (sort === "reward") {
    const rv = Number(x.rewardXrd), c = Number(cur.k)
    return rv < c || (rv === c && x.id < cur.id)
  }
  if (sort === "deadline") {
    if (cur.k === null) return x.deadline === null && x.id > cur.id
    const d = new Date(cur.k).getTime()
    if (x.deadline === null) return true // NULL tail is after any dated row
    const rv = x.deadline.getTime()
    return rv > d || (rv === d && x.id > cur.id)
  }
  const c = new Date(cur.k as string).getTime(), rv = x.createdAt.getTime()
  return rv < c || (rv === c && x.id < cur.id)
}

/** Page through the whole set via the REAL cursor codec + the reference keyset. */
function walk(sort: TaskSort, rows: Row[], pageSize: number): number[] {
  const seen: number[] = []
  let cur: { k: string | null; id: number } | null = null
  // Bounded to avoid an infinite loop if the keyset ever fails to advance.
  for (let guard = 0; guard <= rows.length + 2; guard++) {
    const pool = cur ? rows.filter((r) => refAfter(sort, cur!, r)) : [...rows]
    const page = refSort(sort, pool).slice(0, pageSize)
    if (page.length === 0) break
    seen.push(...page.map((r) => r.id))
    const decoded = decodeTaskCursor(encodeTaskCursor(page[page.length - 1], sort))
    if (!decoded) throw new Error("cursor failed to round-trip mid-walk")
    cur = decoded
    if (page.length < pageSize) break
  }
  return seen
}

describe("task-cursor: compound (sortKey, id) codec", () => {
  it("round-trips the reward cursor (primary value + id)", () => {
    const r = row({ id: 7, rewardXrd: "125.5" })
    expect(decodeTaskCursor(encodeTaskCursor(r, "reward"))).toEqual({ k: "125.5", id: 7 })
  })

  it("round-trips the newest cursor (createdAt ISO + id)", () => {
    const r = row({ id: 3, createdAt: new Date("2026-07-02T10:00:00Z") })
    expect(decodeTaskCursor(encodeTaskCursor(r, "newest"))).toEqual({
      k: "2026-07-02T10:00:00.000Z",
      id: 3,
    })
  })

  it("round-trips a dated AND a null-deadline cursor", () => {
    const dated = row({ id: 4, deadline: new Date("2026-07-05T00:00:00Z") })
    expect(decodeTaskCursor(encodeTaskCursor(dated, "deadline"))).toEqual({
      k: "2026-07-05T00:00:00.000Z",
      id: 4,
    })
    const undated = row({ id: 5, deadline: null })
    expect(decodeTaskCursor(encodeTaskCursor(undated, "deadline"))).toEqual({ k: null, id: 5 })
  })

  it("decodes a malformed / legacy bare-integer cursor to null (degrade to page 1)", () => {
    expect(decodeTaskCursor("10")).toBeNull() // pre-M6 format
    expect(decodeTaskCursor("not-base64!!")).toBeNull()
    expect(decodeTaskCursor("")).toBeNull()
    // Well-formed base64 of the wrong shape (no numeric id) also → null.
    expect(decodeTaskCursor(Buffer.from(JSON.stringify({ k: "x" }), "utf8").toString("base64url"))).toBeNull()
  })
})

describe("task-cursor: drizzle order/keyset shape (transcription)", () => {
  it("orders each sort by (primary, id) in one direction", () => {
    expect(taskOrderBy("reward")).toEqual([desc("tasks.reward_xrd"), desc("tasks.id")])
    expect(taskOrderBy("newest")).toEqual([desc("tasks.created_at"), desc("tasks.id")])
    expect(taskOrderBy("deadline")).toEqual([asc("tasks.deadline"), asc("tasks.id")])
  })

  it("reward keyset keys off reward_xrd + id (DESC), never a bare id", () => {
    const w = taskKeysetWhere("reward", { k: "100", id: 5 })
    expect(w).toEqual(or(lt("tasks.reward_xrd", "100"), and(eq("tasks.reward_xrd", "100"), lt("tasks.id", 5))))
  })

  it("newest keyset keys off created_at + id (DESC)", () => {
    const w = taskKeysetWhere("newest", { k: "2026-07-02T00:00:00.000Z", id: 8 })
    const c = new Date("2026-07-02T00:00:00.000Z")
    expect(w).toEqual(or(lt("tasks.created_at", c), and(eq("tasks.created_at", c), lt("tasks.id", 8))))
  })

  it("deadline keyset (dated cursor) includes the NULL tail after later deadlines", () => {
    const w = taskKeysetWhere("deadline", { k: "2026-07-05T00:00:00.000Z", id: 4 })
    const d = new Date("2026-07-05T00:00:00.000Z")
    expect(w).toEqual(
      or(gt("tasks.deadline", d), and(eq("tasks.deadline", d), gt("tasks.id", 4)), isNull("tasks.deadline")),
    )
  })

  it("deadline keyset (null cursor) stays within the NULL tail, by id", () => {
    const w = taskKeysetWhere("deadline", { k: null, id: 9 })
    expect(w).toEqual(and(isNull("tasks.deadline"), gt("tasks.id", 9)))
  })
})

describe("task-cursor: full keyset walk never skips or repeats a row (M6/M7)", () => {
  // Adversarial: reward ties AND a top-reward row (id 3) whose id exceeds the
  // first page's boundary id — the exact case the old `WHERE id < cursorId`
  // keyset dropped.
  const rewardRows: Row[] = [
    row({ id: 1, rewardXrd: "100" }),
    row({ id: 2, rewardXrd: "50" }),
    row({ id: 3, rewardXrd: "100" }),
    row({ id: 4, rewardXrd: "50" }),
    row({ id: 5, rewardXrd: "75" }),
  ]

  const deadlineRows: Row[] = [
    row({ id: 1, deadline: new Date("2026-07-10T00:00:00Z") }),
    row({ id: 2, deadline: null }), // no deadline → NULL tail
    row({ id: 3, deadline: new Date("2026-07-01T00:00:00Z") }),
    row({ id: 4, deadline: new Date("2026-07-10T00:00:00Z") }), // ties id 1 on deadline
    row({ id: 5, deadline: null }), // NULL tail, ordered by id after id 2
  ]

  const newestRows: Row[] = [
    row({ id: 1, createdAt: new Date("2026-07-03T00:00:00Z") }),
    row({ id: 2, createdAt: new Date("2026-07-03T00:00:00Z") }), // tie with id 1
    row({ id: 3, createdAt: new Date("2026-07-05T00:00:00Z") }),
    row({ id: 4, createdAt: new Date("2026-07-01T00:00:00Z") }),
  ]

  it.each([1, 2, 3, 5])("reward: page size %i covers every row exactly once, in order", (size) => {
    const expected = refSort("reward", rewardRows).map((r) => r.id) // [3,1,5,4,2]
    const walked = walk("reward", rewardRows, size)
    expect(walked).toEqual(expected)
    expect(new Set(walked).size).toBe(rewardRows.length) // no repeats
  })

  it.each([1, 2, 3])("deadline (incl. NULL tail): page size %i covers every row once, in order", (size) => {
    const expected = refSort("deadline", deadlineRows).map((r) => r.id)
    const walked = walk("deadline", deadlineRows, size)
    expect(walked).toEqual(expected)
    expect(new Set(walked).size).toBe(deadlineRows.length)
  })

  it.each([1, 2, 4])("newest (with ties): page size %i covers every row once, in order", (size) => {
    const expected = refSort("newest", newestRows).map((r) => r.id)
    const walked = walk("newest", newestRows, size)
    expect(walked).toEqual(expected)
    expect(new Set(walked).size).toBe(newestRows.length)
  })

  it("reward walk specifically reaches the high-reward/high-id row the old keyset dropped", () => {
    // id 3 (reward 100) sorts FIRST but has a higher id than page-1's boundary
    // under any small page — the old `id < cursor` filter made it unreachable.
    const walked = walk("reward", rewardRows, 2)
    expect(walked[0]).toBe(3) // reachable, and first
    expect(walked).toContain(3)
  })
})
