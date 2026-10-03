import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BANNED, PULL_BANNED, violation, visibleText } from "../../scripts/honest-copy.mjs";

/**
 * public/og-image.png is the OpenGraph / Twitter card — the ONE image a stranger
 * sees before they ever load the site (src/app/layout.tsx, src/app/guide/page.tsx
 * both point at it). For months it was a blank 1200×630 gradient: the SVG source
 * carried emoji glyphs, sharp's bundled librsvg/Pango aborted text layout on
 * them, and the empty output was committed as if it were the render. Nothing
 * looked at the artefact, and honest-copy cannot — a PNG has no text to scan.
 *
 * So the gate sits one step upstream, on the things that CAN be checked:
 *   1. the committed PNG is the declared size and is not blank;
 *   2. the SVG source has no emoji, so scripts/render-og-image.mjs keeps working;
 *   3. the SVG's copy passes the honest-copy rule table — INCLUDING the dormant
 *      PULL rules, because this artefact will never be re-scanned at cutover
 *      (the deploy gate reads prerendered HTML, not images), so its wording has
 *      to be true in both worlds today.
 */

const PUBLIC_DIR = join(__dirname, "../../public");
const PNG = join(PUBLIC_DIR, "og-image.png");
const SVG = join(PUBLIC_DIR, "og-image.svg");

/** Width/height straight from the PNG IHDR chunk (bytes 16–23, big-endian). */
const pngSize = (buf: Buffer) => ({
  width: buf.readUInt32BE(16),
  height: buf.readUInt32BE(20),
});

describe("public/og-image.png (the OpenGraph card)", () => {
  it("is exactly 1200×630, as declared in layout.tsx metadata", () => {
    const buf = readFileSync(PNG);
    expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(pngSize(buf)).toEqual({ width: 1200, height: 630 });
  });

  it("is not the blank gradient (text and logo actually rendered)", () => {
    // The blank render that shipped was 13,377 bytes. Text plus the shield push
    // any real render far past this — a floor, not a fingerprint.
    expect(statSync(PNG).size).toBeGreaterThan(30_000);
  });
});

describe("public/og-image.svg (its source)", () => {
  const svg = readFileSync(SVG, "utf8");

  it("has no emoji — the glyphs that made sharp render nothing", () => {
    // Astral-plane code points and the BMP misc-symbols block cover every emoji
    // the old file carried (🗳️ 💰 🛡️) and their variation selectors.
    expect(svg.match(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/u)).toBeNull();
  });

  it("copy passes every honest-copy rule, dormant PULL rules included", () => {
    const text = visibleText(svg);
    expect(text.length).toBeGreaterThan(50); // self-check: the extraction saw the copy
    const hits = [...BANNED, ...PULL_BANNED]
      .map((rule) => ({ label: rule.label, hit: violation(text, rule) }))
      .filter((r) => r.hit);
    expect(hits).toEqual([]);
  });

  it("makes no governance / voting / sybil / soulbound claim", () => {
    // Not in the shared rule table (governance copy is legal on pages that
    // describe the Telegram bot), but the OG card is the marketplace's headline
    // and these are exactly the governance-era words the 2026-08-16 refresh
    // removed. Pin them so they do not creep back with the next redesign.
    expect(visibleText(svg)).not.toMatch(/govern|\bvot(e|es|ing)\b|sybil|soulbound|non-?transferable/i);
  });
});
