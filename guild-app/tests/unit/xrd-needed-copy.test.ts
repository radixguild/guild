import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BANNED, PULL_BANNED, violation } from "../../scripts/honest-copy.mjs"
import { ESCROW_CLAIM_BOND_XRD } from "@/lib/config"
import { FEE_HEADROOM_XRD } from "@/lib/marketplace"
import {
  XRD_FLOOR_BINDS_UP_TO_REWARD,
  XRD_NEEDED_LINE,
  XRD_SUGGESTED_HOLD,
  XRD_TO_CLAIM,
} from "@/lib/xrd-needed"

/**
 * "What you need" (lib/xrd-needed.ts). /guide said "No XRD is needed to install
 * or connect" while /mint hard-blocks a zero balance and a claim locks a bond.
 * The line now says what is free and what is not, and /guide and /mint render
 * the SAME string, derived from the bond-floor and fee-headroom constants.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8")

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe("the numbers are derived from the existing constants, not typed a second time", () => {
  it("today's figures: about 80 covers a claim, the floor binds up to about 765, we suggest about 100", () => {
    expect(ESCROW_CLAIM_BOND_XRD).toBe(76.45)
    expect(FEE_HEADROOM_XRD).toBe(1)
    expect(XRD_TO_CLAIM).toBe(80)
    expect(XRD_FLOOR_BINDS_UP_TO_REWARD).toBe(765)
    expect(XRD_SUGGESTED_HOLD).toBe(100)
  })

  it("covers at least the floor plus the fee cushion, and the suggestion never reads below it", () => {
    expect(XRD_TO_CLAIM).toBeGreaterThanOrEqual(ESCROW_CLAIM_BOND_XRD + FEE_HEADROOM_XRD)
    expect(XRD_SUGGESTED_HOLD).toBeGreaterThanOrEqual(XRD_TO_CLAIM)
  })

  it("moves with the floor: a different NEXT_PUBLIC_ESCROW_CLAIM_BOND_XRD changes every figure in the line", async () => {
    vi.stubEnv("NEXT_PUBLIC_ESCROW_CLAIM_BOND_XRD", "150")
    vi.resetModules()
    const m = await import("@/lib/xrd-needed")
    expect(m.XRD_TO_CLAIM).toBe(160)
    expect(m.XRD_FLOOR_BINDS_UP_TO_REWARD).toBe(1500)
    // The ruled 100 would now sit BELOW what a claim needs — it must follow the floor up.
    expect(m.XRD_SUGGESTED_HOLD).toBe(160)
    expect(m.XRD_NEEDED_LINE).toContain("about 160 XRD")
    expect(m.XRD_NEEDED_LINE).toContain("at least 150 XRD today")
    expect(m.XRD_NEEDED_LINE).toContain("up to about 1500 XRD")
  })
})

describe("the line says both halves: what is free, and what is not", () => {
  it("names the free steps and the paid ones", () => {
    expect(XRD_NEEDED_LINE).toMatch(/no XRD to install the wallet, connect it or browse the board/)
    expect(XRD_NEEDED_LINE).toMatch(/network fee to mint a badge/)
    expect(XRD_NEEDED_LINE).toMatch(/claim bond \(10% of the reward, at least 76\.45 XRD today, held until the task settles\)/)
    expect(XRD_NEEDED_LINE).toMatch(/about 80 XRD/)
    expect(XRD_NEEDED_LINE).toMatch(/up to about 765 XRD/)
  })

  it("the suggested float is the person's OWN — nothing here funds anyone", () => {
    expect(XRD_NEEDED_LINE).toMatch(/holding about 100 XRD of your own/)
    expect(XRD_NEEDED_LINE).not.toMatch(/\b(we|the guild|bigdev)\b[^.]{0,30}\b(fund|send|give|cover|top up)\b/i)
  })

  it("makes no 'free to claim' / 'no XRD needed' blanket claim", () => {
    expect(XRD_NEEDED_LINE).not.toMatch(/no xrd (is )?(needed|required)\b/i)
    expect(XRD_NEEDED_LINE).not.toMatch(/\bfree to claim\b/i)
  })

  it("clears the real honest-copy rule table (the one CHECK 4 runs on the built /guide and /mint)", () => {
    const hits: string[] = []
    for (const rule of [...BANNED, ...PULL_BANNED]) {
      const v = violation(XRD_NEEDED_LINE, rule)
      if (v) hits.push(`${rule.label} :: ${v}`)
    }
    expect(hits).toEqual([])
  })
})

describe("the pages render the shared line and nothing else says 'no XRD is needed'", () => {
  const guide = read("src/app/guide/page.tsx")
  const mint = read("src/app/mint/page.tsx")

  it("/guide renders XRD_NEEDED_LINE and the old blanket sentence is gone", () => {
    expect(guide).toContain('import { XRD_NEEDED_LINE } from "@/lib/xrd-needed"')
    expect(guide).toContain("{XRD_NEEDED_LINE}")
    expect(guide).not.toMatch(/No XRD is needed to install or connect/)
  })

  it("/mint renders XRD_NEEDED_LINE before the wallet is connected and beside the mint button", () => {
    expect(mint).toContain('import { XRD_NEEDED_LINE } from "@/lib/xrd-needed"')
    expect([...mint.matchAll(/\{XRD_NEEDED_LINE\}/g)]).toHaveLength(2)
  })

  it("neither page retypes the figures", () => {
    for (const src of [guide, mint]) {
      expect(src).not.toMatch(/about 80 XRD|about 100 XRD|about 765 XRD/)
    }
  })
})
