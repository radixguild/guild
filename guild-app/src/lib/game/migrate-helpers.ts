/**
 * migrate-helpers.ts — pure helpers for the bot→PG game migration
 * (scripts/migrate-game-data.ts). Kept dependency-free (only node:crypto) so the
 * unit tests don't have to load better-sqlite3 or the db client.
 */
import { createHash } from "node:crypto"

export interface BotGameRow {
  radix_address: string
  total_rolls: number
  total_bonus_xp: number
  streak_days: number
  last_roll_date: string | null
  last_roll_value: number
  jackpots: number
}

/**
 * Deterministic SHA256 over the salient columns, address-sorted so row order in
 * SQLite never changes the hash. This is the proof-of-input the operator logs
 * before the migration writes anything (audit CRITICAL-002).
 */
export function snapshotHash(rows: BotGameRow[]): string {
  const canonical = [...rows]
    .sort((a, b) => a.radix_address.localeCompare(b.radix_address))
    .map((r) => [
      r.radix_address,
      r.total_rolls,
      r.total_bonus_xp,
      r.streak_days,
      r.last_roll_date,
      r.last_roll_value,
      r.jackpots,
    ])
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}

/** Bot stores last_roll_date as ISO 'YYYY-MM-DD' text; reject anything else. */
export function normalizeDate(d: string | null): string | null {
  if (!d) return null
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null
}

/**
 * Map a bot row to a PG insert. Migrated players start with no roll budget —
 * their first API roll grants the daily allowance.
 */
export function toPgRow(r: BotGameRow) {
  return {
    userId: r.radix_address,
    totalRolls: r.total_rolls,
    totalBonusXp: r.total_bonus_xp,
    streakDays: r.streak_days,
    lastRollDate: normalizeDate(r.last_roll_date),
    lastRollValue: r.last_roll_value,
    jackpots: r.jackpots,
    availableRolls: 0,
    lastGrantDate: null,
  }
}
