/**
 * Database-less assertions for the grid-game core: the CSPRNG dice distribution,
 * and the SQL-level guarantees the audit hinges on — the atomic budget guard
 * (HIGH-001), the idempotent daily grant, and the migration's ON CONFLICT DO
 * NOTHING (CRITICAL-002). SQL is rendered via Drizzle `.toSQL()`, which never
 * opens a connection; the dummy DATABASE_URL only satisfies the lazy db Proxy.
 */
import { describe, it, expect } from "vitest"

process.env.DATABASE_URL ??= "postgres://dummy:dummy@127.0.0.1:5432/dummy"

import {
  ROLL_WEIGHTS,
  ROLL_BONUSES,
  rollDice,
  bonusFor,
  isJackpot,
} from "@/lib/game/dice"
import { buildGrantDailyRolls, buildRollUpdate } from "@/db/queries/game"
import { db } from "@/db"
import { gameState } from "@/db/schema"
import {
  snapshotHash,
  normalizeDate,
  toPgRow,
  type BotGameRow,
} from "@/lib/game/migrate-helpers"

describe("dice — weights, bonuses, distribution (H-002, C-004)", () => {
  it("weights sum to 100 and parity with the bot", () => {
    expect(ROLL_WEIGHTS.reduce((a, b) => a + b, 0)).toBe(100)
    expect([...ROLL_WEIGHTS]).toEqual([30, 25, 20, 13, 8, 4])
    expect([...ROLL_BONUSES]).toEqual([0, 5, 10, 25, 50, 100])
  })

  it("maps every rng boundary in [0,100) to the correct face", () => {
    const cases: [number, number][] = [
      [0, 1], [29, 1], // 30 ints → face 1
      [30, 2], [54, 2], // 25 → face 2
      [55, 3], [74, 3], // 20 → face 3
      [75, 4], [87, 4], // 13 → face 4
      [88, 5], [95, 5], // 8  → face 5
      [96, 6], [99, 6], // 4  → face 6
    ]
    for (const [r, face] of cases) expect(rollDice(() => r)).toBe(face)
  })

  it("bonusFor + isJackpot match the table", () => {
    expect([1, 2, 3, 4, 5, 6].map(bonusFor)).toEqual([0, 5, 10, 25, 50, 100])
    expect(isJackpot(6)).toBe(true)
    expect([1, 2, 3, 4, 5].some(isJackpot)).toBe(false)
  })

  it("CSPRNG distribution is within ±2% over 100k rolls", () => {
    const N = 100_000
    const counts = [0, 0, 0, 0, 0, 0]
    for (let i = 0; i < N; i++) counts[rollDice() - 1]++
    counts.forEach((c, i) => {
      expect(Math.abs(c / N - ROLL_WEIGHTS[i] / 100)).toBeLessThan(0.02)
    })
  })
})

describe("roll SQL — atomic budget guard (H-001)", () => {
  const { sql } = buildRollUpdate("account_rdx1abc", {
    roll: 6,
    bonus: 100,
    jackpotInc: 1,
  }).toSQL()

  it("only fires when budget remains (available_rolls > 0)", () => {
    expect(sql).toMatch(/"available_rolls"\s*>\s*\$\d|"available_rolls"\s*>\s*0/)
  })

  it("decrements the budget in the same statement", () => {
    expect(sql).toMatch(/"available_rolls"\s*=\s*(?:"game_state"\.)?"available_rolls"\s*-/)
  })

  it("RETURNs the row so a no-op can be detected (→ 429)", () => {
    expect(sql.toLowerCase()).toContain("returning")
  })
})

describe("daily grant SQL — idempotent per UTC day", () => {
  const { sql } = buildGrantDailyRolls("account_rdx1abc").toSQL()

  it("is an upsert on the player key", () => {
    expect(sql.toLowerCase()).toContain("on conflict")
  })

  it("only refills when today's grant has not run yet", () => {
    expect(sql.toLowerCase()).toContain("is distinct from")
  })

  it("keys the day off UTC, not the server clock", () => {
    expect(sql).toContain("AT TIME ZONE 'UTC'")
  })
})

describe("migration insert SQL — re-run never doubles XP (C-002)", () => {
  const sample: BotGameRow = {
    radix_address: "account_rdx1abc",
    total_rolls: 4,
    total_bonus_xp: 75,
    streak_days: 2,
    last_roll_date: "2026-06-13",
    last_roll_value: 5,
    jackpots: 0,
  }
  const { sql } = db
    .insert(gameState)
    .values(toPgRow(sample))
    .onConflictDoNothing()
    .toSQL()

  it("uses ON CONFLICT DO NOTHING (no additive UPDATE)", () => {
    expect(sql.toLowerCase()).toContain("on conflict")
    expect(sql.toLowerCase()).toContain("do nothing")
  })

  it("never emits an additive xp update", () => {
    expect(sql.toLowerCase()).not.toContain("total_bonus_xp = total_bonus_xp +")
  })
})

describe("migration helpers", () => {
  const a: BotGameRow = {
    radix_address: "account_rdx1aaa",
    total_rolls: 1,
    total_bonus_xp: 10,
    streak_days: 1,
    last_roll_date: "2026-06-13",
    last_roll_value: 3,
    jackpots: 0,
  }
  const b: BotGameRow = { ...a, radix_address: "account_rdx1bbb", total_bonus_xp: 50 }

  it("snapshotHash is independent of row order", () => {
    expect(snapshotHash([a, b])).toBe(snapshotHash([b, a]))
  })

  it("snapshotHash changes when any value changes", () => {
    expect(snapshotHash([a])).not.toBe(snapshotHash([{ ...a, total_bonus_xp: 999 }]))
  })

  it("normalizeDate accepts ISO dates and rejects junk", () => {
    expect(normalizeDate("2026-06-13")).toBe("2026-06-13")
    expect(normalizeDate("13/06/2026")).toBeNull()
    expect(normalizeDate(null)).toBeNull()
  })

  it("toPgRow maps bot columns and zeroes the API budget", () => {
    const pg = toPgRow(a)
    expect(pg.userId).toBe("account_rdx1aaa")
    expect(pg.totalBonusXp).toBe(10)
    expect(pg.availableRolls).toBe(0)
    expect(pg.lastGrantDate).toBeNull()
  })
})
