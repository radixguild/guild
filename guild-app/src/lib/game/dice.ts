/**
 * dice.ts — server-side weighted dice for the grid game.
 *
 * CSPRNG only: the roll face and its XP bonus are ALWAYS derived here and never
 * accepted from a client (audit CRITICAL-004). This replaces the bot's
 * `Math.random()` (bot/db.js:552) with `node:crypto` `randomInt` (audit
 * HIGH-002 — a predictable PRNG is worse server-side, where a compromised host
 * could pin outcomes).
 *
 * Weights and bonuses are byte-for-byte the bot's, for migration parity
 * (audit Class 5):
 *
 *   face    1     2     3     4     5     6
 *   weight  30%   25%   20%   13%   8%    4%     (sum = 100)
 *   bonus   0     5     10    25    50    100    (XP; face 6 = jackpot)
 */
import { randomInt } from "node:crypto"

export const ROLL_WEIGHTS = [30, 25, 20, 13, 8, 4] as const // must sum to 100
export const ROLL_BONUSES = [0, 5, 10, 25, 50, 100] as const // XP bonus per face
export const JACKPOT_FACE = 6

// Cumulative thresholds: [30, 55, 75, 88, 96, 100]. A uniform integer in
// [0, 100) lands in face i when r < CUMULATIVE[i] — exactly ROLL_WEIGHTS[i]
// integers map to each face, so the distribution matches the weights exactly.
const CUMULATIVE: number[] = ROLL_WEIGHTS.reduce<number[]>((acc, w) => {
  acc.push((acc[acc.length - 1] ?? 0) + w)
  return acc
}, [])

/** Default entropy source: CSPRNG, uniform integer in [0, 100). */
function csprng(): number {
  return randomInt(100)
}

/**
 * Roll a weighted face in 1–6. `rng` is injectable for deterministic tests
 * ONLY and must return an integer in [0, 100); production always uses the
 * CSPRNG default.
 */
export function rollDice(rng: () => number = csprng): number {
  const r = rng()
  for (let i = 0; i < CUMULATIVE.length; i++) {
    if (r < CUMULATIVE[i]) return i + 1
  }
  // Unreachable for r in [0, 100) since the last threshold is 100.
  return ROLL_WEIGHTS.length
}

/** XP bonus awarded for a face (0 for an out-of-range value). */
export function bonusFor(roll: number): number {
  return ROLL_BONUSES[roll - 1] ?? 0
}

export function isJackpot(roll: number): boolean {
  return roll === JACKPOT_FACE
}
