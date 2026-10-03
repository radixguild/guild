import { and, desc, eq, gt, sql } from "drizzle-orm"
import { db } from "@/db"
import { gameState, users } from "@/db/schema"
import { bonusFor, isJackpot, rollDice } from "@/lib/game/dice"

// Per-UTC-day roll budget granted to each player. The standalone API has no
// natural per-action gate like the bot, so it hands out a small fixed budget
// each day (audit Class 5). Configurable; defaults small so the dark feature
// can't mint unbounded score.
export const DAILY_ROLLS: number = (() => {
  const n = Number(process.env.GAME_DAILY_ROLLS)
  return Number.isInteger(n) && n > 0 ? n : 3
})()

// The UTC calendar day, server-clock-independent. Matches the bot's
// `new Date().toISOString().slice(0,10)` so streak math ports exactly
// (audit Class 5 parity).
const UTC_TODAY = sql`(now() AT TIME ZONE 'UTC')::date`

export interface RollResult {
  roll: number
  bonus: number
  jackpot: boolean
  state: typeof gameState.$inferSelect
}

// ── query builders ──────────────────────────────────────────────────────────
// Split out from the executors below so game-core.test.ts can assert the
// generated SQL via `.toSQL()` without a database (the atomic-guard / idempotency
// properties are in the SQL itself, not in JS).

/**
 * Top up the player's budget to DAILY_ROLLS once per UTC day. The conditional
 * `setWhere` makes a same-day re-run a no-op, so a player's remaining rolls are
 * never silently refilled mid-day. A brand-new player is inserted with a full
 * budget. Unused rolls do NOT carry over — each new day resets to DAILY_ROLLS,
 * so the budget can't be hoarded into a score dump.
 */
export function buildGrantDailyRolls(userId: string) {
  return db
    .insert(gameState)
    .values({ userId, availableRolls: DAILY_ROLLS, lastGrantDate: UTC_TODAY })
    .onConflictDoUpdate({
      target: gameState.userId,
      set: {
        availableRolls: DAILY_ROLLS,
        lastGrantDate: UTC_TODAY,
        updatedAt: sql`now()`,
      },
      setWhere: sql`${gameState.lastGrantDate} is distinct from ${UTC_TODAY}`,
    })
}

/**
 * The atomic decrement-and-record (audit HIGH-001): in ONE statement it drops
 * the budget by one, bumps the score/streak, and RETURNs the new row — gated on
 * `available_rolls > 0`. Concurrent rolls serialize on the row lock, so the
 * budget can never go negative; when it hits zero the UPDATE matches no row and
 * the caller sees `undefined` (→ 429). The dice are passed in already rolled
 * (server-side, CSPRNG) — this builder never derives them.
 */
export function buildRollUpdate(
  userId: string,
  dice: { roll: number; bonus: number; jackpotInc: number },
) {
  return db
    .update(gameState)
    .set({
      availableRolls: sql`${gameState.availableRolls} - 1`,
      totalRolls: sql`${gameState.totalRolls} + 1`,
      totalBonusXp: sql`${gameState.totalBonusXp} + ${dice.bonus}`,
      lastRollValue: dice.roll,
      jackpots: sql`${gameState.jackpots} + ${dice.jackpotInc}`,
      // Streak: +1 on a consecutive UTC day, unchanged on a same-day reroll,
      // reset to 1 after a gap or first roll. Mirrors recordRoll() in bot/db.js.
      streakDays: sql`CASE
        WHEN ${gameState.lastRollDate} = ${UTC_TODAY} THEN ${gameState.streakDays}
        WHEN ${gameState.lastRollDate} = ${UTC_TODAY} - 1 THEN ${gameState.streakDays} + 1
        ELSE 1 END`,
      lastRollDate: UTC_TODAY,
      updatedAt: sql`now()`,
    })
    .where(and(eq(gameState.userId, userId), gt(gameState.availableRolls, 0)))
    .returning()
}

// ── executors ───────────────────────────────────────────────────────────────

export async function grantDailyRolls(userId: string): Promise<void> {
  await buildGrantDailyRolls(userId)
}

/**
 * Roll once for `userId`. The face and bonus are computed server-side (CSPRNG,
 * audit CRITICAL-004) before the atomic update applies them. Returns null when
 * no rolls remain today.
 */
export async function rollOnce(userId: string): Promise<RollResult | null> {
  await grantDailyRolls(userId)

  const roll = rollDice()
  const bonus = bonusFor(roll)
  const jackpotInc = isJackpot(roll) ? 1 : 0

  const [row] = await buildRollUpdate(userId, { roll, bonus, jackpotInc })
  if (!row) return null
  return { roll, bonus, jackpot: jackpotInc === 1, state: row }
}

/** Read-only — never writes (GET must be idempotent; the roll endpoint grants). */
export async function getGameState(userId: string) {
  return (
    (await db.query.gameState.findFirst({
      where: eq(gameState.userId, userId),
    })) ?? null
  )
}

export interface GameLeaderboardRow {
  userId: string
  displayName: string | null
  totalBonusXp: number
  totalRolls: number
  jackpots: number
  streakDays: number
}

/** Public board, ranked by lifetime bonus XP. Players with no score are omitted. */
export async function gameLeaderboard(limit = 50): Promise<GameLeaderboardRow[]> {
  return db
    .select({
      userId: gameState.userId,
      displayName: users.displayName,
      totalBonusXp: gameState.totalBonusXp,
      totalRolls: gameState.totalRolls,
      jackpots: gameState.jackpots,
      streakDays: gameState.streakDays,
    })
    .from(gameState)
    .leftJoin(users, eq(users.id, gameState.userId))
    .where(gt(gameState.totalBonusXp, 0))
    .orderBy(desc(gameState.totalBonusXp))
    .limit(limit)
}
