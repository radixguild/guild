/**
 * Unit tests for the unfunded-create TTL prune decision
 * (src/lib/prune-unfunded.ts) — the WHAT/whether the .mjs sweep delegates.
 * Pinned here because the money-safety invariant (never prune a funded row) and
 * the reward>0 / TTL gates must not regress, and the .mjs is not unit-tested.
 */
import { describe, it, expect } from "vitest"
import { isPrunableUnfunded, unfundedCutoff, UNFUNDED_TTL_MS } from "@/lib/prune-unfunded"

const NOW = new Date("2026-07-08T12:00:00.000Z")
// Comfortably older than the 24h TTL.
const OLD = new Date(NOW.getTime() - 48 * 60 * 60 * 1000)
const FRESH = new Date(NOW.getTime() - 1 * 60 * 60 * 1000)

// A prunable candidate: open, never funded, real reward, aged out.
const base = {
  status: "open",
  onChainTaskId: null as number | null,
  rewardXrd: "50",
  createdAt: OLD,
}

describe("isPrunableUnfunded", () => {
  it("prunes an abandoned, never-funded, aged create with a real reward", () => {
    expect(isPrunableUnfunded(base, NOW)).toBe(true)
  })

  it("never selects a linked/funded row (onChainTaskId set), even when open + aged", () => {
    // A linked row is a real, claimable, funded task — it must never be swept
    // (hiding it would make a claimable task invisible on the board).
    expect(isPrunableUnfunded({ ...base, onChainTaskId: 42 }, NOW)).toBe(false)
  })

  it("does not prune a row younger than the TTL", () => {
    expect(isPrunableUnfunded({ ...base, createdAt: FRESH }, NOW)).toBe(false)
  })

  it("does not prune a non-open row", () => {
    for (const status of ["assigned", "submitted", "paid", "cancelled", "disputed", "refunded"]) {
      expect(isPrunableUnfunded({ ...base, status }, NOW)).toBe(false)
    }
  })

  it("does not prune a 0-reward (off-chain / XP) task", () => {
    expect(isPrunableUnfunded({ ...base, rewardXrd: "0" }, NOW)).toBe(false)
    expect(isPrunableUnfunded({ ...base, rewardXrd: "0.00000000" }, NOW)).toBe(false)
  })

  it("uses a STRICT age boundary matching the SQL gate (age === ttl does NOT prune; one ms over does)", () => {
    // Aligned with findPrunableUnfundedTasks' `created_at < now-ttl` (strict), so
    // the pure belt-check never diverges from the candidate query at the boundary.
    const exactly = new Date(NOW.getTime() - UNFUNDED_TTL_MS)
    const justOver = new Date(NOW.getTime() - UNFUNDED_TTL_MS - 1)
    expect(isPrunableUnfunded({ ...base, createdAt: exactly }, NOW)).toBe(false)
    expect(isPrunableUnfunded({ ...base, createdAt: justOver }, NOW)).toBe(true)
  })

  it("honours a custom (shorter) ttl", () => {
    const oneHour = 60 * 60 * 1000
    // FRESH is 1h old: not prunable at the 24h default, prunable at a 30-min ttl.
    expect(isPrunableUnfunded({ ...base, createdAt: FRESH }, NOW)).toBe(false)
    expect(isPrunableUnfunded({ ...base, createdAt: FRESH }, NOW, oneHour / 2)).toBe(true)
  })
})

describe("unfundedCutoff", () => {
  it("returns now minus the ttl", () => {
    expect(unfundedCutoff(NOW).getTime()).toBe(NOW.getTime() - UNFUNDED_TTL_MS)
    expect(unfundedCutoff(NOW, 1000).getTime()).toBe(NOW.getTime() - 1000)
  })
})

describe("constants", () => {
  it("defaults the TTL to 24h", () => {
    expect(UNFUNDED_TTL_MS).toBe(24 * 60 * 60 * 1000)
  })
})
