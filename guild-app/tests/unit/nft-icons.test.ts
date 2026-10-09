/**
 * The Guild's NFT icon set (public/nft/). Each PNG is what one or more of the
 * Guild's NFT resources will name in `icon_url` once the operator signs the
 * metadata ceremony (bigdev, 2026-10-07: "can we put images to all our NFTs
 * from the Guild"); the SVG beside it is the source, rendered by
 * scripts/render-nft-icons.mjs.
 *
 * A wallet shows whatever the URL serves, so the set is pinned: every icon the
 * ceremony names exists, is a real 512 x 512 PNG with its SVG source beside
 * it, and stays small. Renaming or dropping one is a ceremony change too.
 */
import { describe, it, expect } from "vitest"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const DIR = join(process.cwd(), "public", "nft")

/** The slugs the metadata ceremony points icon_url at: https://radixguild.com/nft/<slug>.png */
const CEREMONY_SLUGS = [
  "member-badge",
  "agent-badge",
  "arbiter-badge",
  "role-badge",
  "task-receipt",
  "claim-receipt",
  "listing-receipt",
]

function pngSize(file: string): { width: number; height: number } | null {
  const b = readFileSync(file)
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (b.length < 24 || !sig.every((v, i) => b[i] === v) || b.toString("ascii", 12, 16) !== "IHDR") return null
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

describe("public/nft — the Guild NFT icon set", () => {
  it("holds exactly the ceremony's icons, each as a PNG with its SVG source", () => {
    const files = readdirSync(DIR).sort()
    const expected = CEREMONY_SLUGS.flatMap((s) => [`${s}.png`, `${s}.svg`]).sort()
    expect(files).toEqual(expected)
  })

  it.each(CEREMONY_SLUGS)("%s.png is a 512 x 512 PNG under 256 KB", (slug) => {
    const file = join(DIR, `${slug}.png`)
    expect(existsSync(file)).toBe(true)
    expect(pngSize(file)).toEqual({ width: 512, height: 512 })
    expect(statSync(file).size).toBeLessThan(256 * 1024)
  })

  it.each(CEREMONY_SLUGS)("%s.svg is a self-contained 512 x 512 SVG (no external references)", (slug) => {
    const svg = readFileSync(join(DIR, `${slug}.svg`), "utf8")
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512"/)
    expect(svg).not.toMatch(/(?:href|src)\s*=\s*["'](?:https?:)?\/\//)
    expect(svg).not.toMatch(/<script/i)
  })
})
