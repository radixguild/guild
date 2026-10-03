import { describe, it, expect, vi } from "vitest"

vi.mock("@/db/queries/agents", () => ({}))
vi.mock("@/lib/agent-funding", () => ({}))

import { RecheckCooldown } from "@/lib/agent-lifecycle"

describe("RecheckCooldown — at most one chain read per row per window, bounded", () => {
  it("grants a row once per ttl; a different row is independent", () => {
    const c = new RecheckCooldown(1000, 10)
    expect(c.claim(1, 0)).toBe(true)
    expect(c.claim(1, 999)).toBe(false)
    expect(c.claim(2, 999)).toBe(true)
    expect(c.claim(1, 1000)).toBe(true)
  })

  it("settle forgets a row, so a final answer is never held back", () => {
    const c = new RecheckCooldown(1000, 10)
    c.claim(1, 0)
    c.settle(1)
    expect(c.claim(1, 1)).toBe(true)
  })

  it("🔴 stays within its bound and evicts the OLDEST claim first (a re-claim counts as newest)", () => {
    const c = new RecheckCooldown(1_000_000, 3)
    c.claim(1, 0)
    c.claim(2, 1)
    c.claim(3, 2)
    c.claim(1, 2_000_000) // re-claimed: now the newest
    c.claim(4, 2_000_001) // over the bound: row 2 (oldest) goes
    expect(c.size).toBe(3)
    expect(c.has(2)).toBe(false)
    expect(c.has(1)).toBe(true)
    expect(c.has(3)).toBe(true)
    expect(c.has(4)).toBe(true)
  })
})
