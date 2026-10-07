#!/usr/bin/env node
// render-nft-icons.mjs — render public/nft/<slug>.svg to public/nft/<slug>.png
// (512 x 512) with Playwright's Chromium, the browser the e2e suite already
// installs. The PNGs are what the Guild's NFT resources name in `icon_url`
// (the metadata ceremony sheet lives in the private operations repository);
// the SVGs are what you edit. Run from guild-app/:
//
//   node scripts/render-nft-icons.mjs
//
// Rendering is a browser screenshot, so a font difference between machines
// changes the label pixels. Commit the PNGs you checked by eye.

import { readdirSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "@playwright/test"

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "nft")
const SIZE = 512

const svgs = readdirSync(DIR).filter((f) => f.endsWith(".svg")).sort()
if (svgs.length === 0) {
  console.error(`render-nft-icons: no .svg files in ${DIR}`)
  process.exit(1)
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 })
  for (const file of svgs) {
    const svg = readFileSync(join(DIR, file), "utf8")
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`)
    const out = join(DIR, file.replace(/\.svg$/, ".png"))
    await page.locator("svg").first().screenshot({ path: out, omitBackground: true })
    console.log(`rendered ${file} -> ${out}`)
  }
} finally {
  await browser.close()
}
