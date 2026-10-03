import { and, eq, sql } from "drizzle-orm"
import { db } from "@/db"
import { tempcheckVotes } from "@/db/schema"

// ── query builders ──────────────────────────────────────────────────────────
// Split out from the executors below so tests can assert the generated SQL
// via `.toSQL()` without a database — same pattern as db/queries/game.ts.

export interface UpsertVoteInput {
  checkId: string
  optionKey: string
  voterKey: string
  userId: string | null
  signed: boolean
}

/**
 * Upsert one vote for (checkId, voterKey). A re-vote from the same browser on
 * the same check REPLACES the option rather than adding a second row — the
 * unique index on (check_id, voter_key) is what makes this an upsert rather
 * than a plain insert, and `onConflictDoUpdate` is what makes the replace
 * atomic against a concurrent double-click.
 */
export function buildUpsertVote(input: UpsertVoteInput) {
  return db
    .insert(tempcheckVotes)
    .values({
      checkId: input.checkId,
      optionKey: input.optionKey,
      voterKey: input.voterKey,
      userId: input.userId,
      signed: input.signed,
    })
    .onConflictDoUpdate({
      target: [tempcheckVotes.checkId, tempcheckVotes.voterKey],
      set: {
        optionKey: input.optionKey,
        userId: input.userId,
        signed: input.signed,
        updatedAt: sql`now()`,
      },
    })
}

// ── executors ───────────────────────────────────────────────────────────────

export async function upsertVote(input: UpsertVoteInput): Promise<void> {
  await buildUpsertVote(input)
}

export interface VoteRow {
  optionKey: string
  signed: boolean
}

/** All votes for one check. Read-only — never writes. */
export async function getVotesForCheck(checkId: string): Promise<VoteRow[]> {
  return db
    .select({ optionKey: tempcheckVotes.optionKey, signed: tempcheckVotes.signed })
    .from(tempcheckVotes)
    .where(eq(tempcheckVotes.checkId, checkId))
}

/** This browser's current choice on a check, or null if it has not voted. */
export async function getVoterChoice(checkId: string, voterKey: string): Promise<string | null> {
  const row = await db.query.tempcheckVotes.findFirst({
    where: and(eq(tempcheckVotes.checkId, checkId), eq(tempcheckVotes.voterKey, voterKey)),
    columns: { optionKey: true },
  })
  return row?.optionKey ?? null
}

// ── pure functions (no DB) ───────────────────────────────────────────────────
// Kept free of the db import above so tally shaping is testable without a
// database — the "tally/upsert logic" a pure-function test can pin exactly.

export interface OptionTally {
  key: string
  count: number
}

/**
 * Shape raw vote rows into a per-option tally. `optionKeys` comes from the
 * content module (src/content/lights-on.ts), not from the rows themselves,
 * so an option with zero votes still appears at count 0 rather than being
 * silently absent — and an unrecognised option_key in the data (there
 * should never be one; the POST route validates against the same list)
 * cannot inflate a real option's count.
 */
export function tallyVotes(rows: { optionKey: string }[], optionKeys: string[]): OptionTally[] {
  const counts = new Map<string, number>(optionKeys.map((k) => [k, 0]))
  for (const row of rows) {
    if (counts.has(row.optionKey)) {
      counts.set(row.optionKey, (counts.get(row.optionKey) ?? 0) + 1)
    }
  }
  return optionKeys.map((key) => ({ key, count: counts.get(key) ?? 0 }))
}

/** Count of rows cast while signed in — the "signed-in votes are counted
 *  separately" figure the widget copy promises. */
export function countSigned(rows: { signed: boolean }[]): number {
  return rows.filter((row) => row.signed).length
}
