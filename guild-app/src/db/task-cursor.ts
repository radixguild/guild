/**
 * Task-board keyset pagination (M6 fix).
 *
 * THE BUG this replaces: the board could sort by reward or deadline, but the
 * cursor always keyed off `tasks.id` (`WHERE id < cursorId`) while the ORDER BY
 * keyed off a *different* column. Past page 1 with `sort=reward`, a high-reward
 * row whose id happens to be > the cursor id was unreachable, and lower-reward
 * rows with a smaller id reappeared — a real data-integrity bug reachable via the
 * public `?sort=` param (single-row test mocks hid it; see M7).
 *
 * THE FIX: a compound `(sortKey, id)` keyset. `id` (unique, never null) is the
 * tiebreaker appended to BOTH the ORDER BY and the cursor comparison, in the SAME
 * direction as the primary sort — so `(sortKey, id)` is a strict total order and
 * the keyset can neither skip nor repeat a row. The cursor carries the primary
 * value AND the id, so the WHERE compares on the same axis the rows are ordered
 * by. Deadline (nullable, ASC → NULLS LAST) needs the extra NULL-tail handling
 * below.
 */
import { and, or, eq, gt, lt, asc, desc, isNull, type SQL } from "drizzle-orm"
import { tasks } from "./schema"

export type TaskSort = "newest" | "reward" | "deadline"

export interface DecodedTaskCursor {
  /**
   * Serialized primary sort-key value. `null` ONLY for the deadline sort's
   * NULL-tail (a task with no deadline) — for reward/newest the column is
   * NOT NULL so `k` is always a string.
   */
  k: string | null
  /** Unique row-id tiebreaker (the second key of the compound cursor). */
  id: number
}

/** The row shape the cursor needs — a superset of what `db.select()` returns. */
interface CursorableRow {
  id: number
  rewardXrd: string
  deadline: Date | null
  createdAt: Date
}

// Opaque, URL-safe cursor: base64url(JSON) so a compound value survives a bare
// `?cursor=` query param without the caller having to escape it. Clients treat
// it as an opaque token they echo back (the board doesn't parse it).
function encode(payload: DecodedTaskCursor): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
}

/**
 * Serialize the last row of a page into the next cursor. The primary value is
 * read from the SAME column the sort ordered by, so the next page's keyset WHERE
 * compares like-for-like.
 */
export function encodeTaskCursor(row: CursorableRow, sort: TaskSort): string {
  let k: string | null
  if (sort === "reward") k = row.rewardXrd
  else if (sort === "deadline") k = row.deadline ? row.deadline.toISOString() : null
  else k = row.createdAt.toISOString() // newest (default)
  return encode({ k, id: row.id })
}

/**
 * Decode a cursor. Returns null (→ caller ignores it, serving page 1) for any
 * malformed or legacy (bare-integer) cursor rather than throwing — a stale
 * cursor must degrade to a repeated first page, never a 500.
 */
export function decodeTaskCursor(raw: string): DecodedTaskCursor | null {
  try {
    const o = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    if (!o || typeof o.id !== "number" || !Number.isFinite(o.id)) return null
    const k = o.k === null || typeof o.k === "string" ? o.k : null
    return { k, id: o.id }
  } catch {
    return null
  }
}

/**
 * ORDER BY columns for a sort mode — always `(primary, id)` in the same
 * direction, so ties on the primary key resolve deterministically by id.
 */
export function taskOrderBy(sort: TaskSort): SQL[] {
  if (sort === "reward") return [desc(tasks.rewardXrd), desc(tasks.id)]
  if (sort === "deadline") return [asc(tasks.deadline), asc(tasks.id)] // ASC → NULLS LAST (pg default)
  return [desc(tasks.createdAt), desc(tasks.id)] // newest
}

/**
 * The keyset WHERE for "rows strictly after this cursor" under `sort`. Mirrors
 * `taskOrderBy` exactly: for a DESC primary the next page is `primary < c OR
 * (primary = c AND id < cid)`; for ASC it's the `>` mirror. Returns undefined
 * when the cursor can't constrain (shouldn't happen for the non-null columns).
 */
export function taskKeysetWhere(sort: TaskSort, cur: DecodedTaskCursor): SQL | undefined {
  if (sort === "reward") {
    if (cur.k === null) return undefined // reward_xrd is NOT NULL
    return or(lt(tasks.rewardXrd, cur.k), and(eq(tasks.rewardXrd, cur.k), lt(tasks.id, cur.id)))
  }
  if (sort === "deadline") {
    // ASC with NULLS LAST: non-null deadlines first (ascending), then the NULL
    // tail (ordered by id asc). Which branch depends on where the cursor sits.
    if (cur.k === null) {
      // Already in the NULL tail — only later NULL-deadline rows remain.
      return and(isNull(tasks.deadline), gt(tasks.id, cur.id))
    }
    const d = new Date(cur.k)
    // Still among non-null deadlines: later deadlines, ties by id, THEN the whole
    // NULL tail (every NULL-deadline row sorts after any dated one).
    return or(gt(tasks.deadline, d), and(eq(tasks.deadline, d), gt(tasks.id, cur.id)), isNull(tasks.deadline))
  }
  // newest: DESC createdAt, DESC id
  if (cur.k === null) return undefined
  const c = new Date(cur.k)
  return or(lt(tasks.createdAt, c), and(eq(tasks.createdAt, c), lt(tasks.id, cur.id)))
}
