/**
 * launch-check CHECK 11 (S1-b): what /agents SAYS about the kit must agree with
 * what /kit/ SERVES, in both directions — run end to end against synthetic
 * artifacts, the way keeper-fuse.test.ts runs CHECK 10.
 *
 * The named defects, each its own case:
 *   - a page printing a hash while no kit is packed (the page advertises a
 *     tarball the deploy does not serve) → FAIL;
 *   - a packed kit whose .sha256 does not describe its agent.tgz → FAIL;
 *   - a page printing hash H while the packed kit is H' → FAIL;
 *   - a packed kit behind a page that says "this build serves no kit" → FAIL;
 *   - no hash on the page and no kit anywhere → WARN, never FAIL (the honest
 *     pre-S1 state; the first cut hard-failed every deploy here — review on #802).
 *
 * The gate runs every check even after failures, so an otherwise-empty
 * candidate dir (checks 1–5 fail, 7–9 skip the chain) still reaches CHECK 11;
 * only CHECK 11's own block is judged, sliced out of the output.
 */
import { describe, it, expect, afterEach } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateInputs } from "../support/private-input"

const APP = process.cwd()
// guild-app/scripts/launch-check.sh stays EXCLUDE at the open-source flip
// (publish/MANIFEST.md) — the whole file skips when it is absent, since every
// test below either reads its text or runs it as a subprocess.
const PRIV = privateInputs("guild-app/scripts/launch-check.sh")
const GATE = PRIV.skip ? "" : readFileSync(join(APP, "scripts/launch-check.sh"), "utf8")
const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})

const sha = (s: string) => createHash("sha256").update(s).digest("hex")
const KIT_BYTES = "the packed kit"
const KIT_SHA = sha(KIT_BYTES)
const OTHER_SHA = sha("some other kit")

/** The prerendered /agents fragment, in the exact shape React emits for the card. */
const pageWith = (hash: string | null) =>
  hash
    ? `<html><body><p>sha256 <code data-testid="kit-sha256" class="font-mono text-xs break-all">${hash}</code> (also at …)</p></body></html>`
    : `<html><body><p class="text-muted-foreground" data-testid="kit-sha256-missing">This build serves no kit</p></body></html>`

let runs = 0
function scenario({ page, kit }: { page: string | null | "absent"; kit: null | { bytes: string; shaLine: string } }) {
  const dist = `.next-kit-check-test-${process.pid}-${++runs}`
  mkdirSync(join(APP, dist, "server", "app"), { recursive: true })
  tmp.push(join(APP, dist))
  if (page !== "absent") writeFileSync(join(APP, dist, "server", "app", "agents.html"), pageWith(page))
  const kitDir = mkdtempSync(join(tmpdir(), "kit-check-"))
  tmp.push(kitDir)
  if (kit) {
    writeFileSync(join(kitDir, "agent.tgz"), kit.bytes)
    writeFileSync(join(kitDir, "agent.tgz.sha256"), kit.shaLine)
  }
  const r = spawnSync("bash", ["scripts/launch-check.sh"], {
    cwd: APP,
    encoding: "utf8",
    env: {
      ...process.env,
      LAUNCH_CHECK_DIST_DIR: dist,
      LAUNCH_CHECK_KIT_DIR: kitDir,
      LAUNCH_CHECK_SKIP_CHAIN: "1",
      GUILD_ALLOW_LIVE_DISPUTE: "",
      KEEPER_PRIVATE_KEY: "",
    },
  })
  const all = r.stdout + r.stderr
  const from = all.indexOf("CHECK 11")
  expect(from, "CHECK 11 ran").toBeGreaterThan(-1)
  return all.slice(from, all.indexOf("LAUNCH CHECK", from))
}

describe.skipIf(PRIV.skip)("the pattern CHECK 11 reads the page with", () => {
  it("is anchored on the card's data-testid, not on any 64-hex string on the page", () => {
    expect(GATE).toContain(`grep -oE 'data-testid="kit-sha256"[^>]*>[0-9a-f]{64}<'`)
  })
})

describe.skipIf(PRIV.skip)("launch-check CHECK 11, end to end", () => {
  it("PASS — the page prints the hash of the packed kit", () => {
    const out = scenario({ page: KIT_SHA, kit: { bytes: KIT_BYTES, shaLine: `${KIT_SHA}  agent.tgz\n` } })
    expect(out).toMatch(new RegExp(`PASS\\S*\\s+/agents prints ${KIT_SHA}`))
    expect(out).not.toMatch(/FAIL/)
  }, 60_000)

  it("FAIL — the page prints a hash but no kit is packed (a tarball advertised, none served)", () => {
    const out = scenario({ page: KIT_SHA, kit: null })
    expect(out).toMatch(/FAIL\S*\s+\/agents prints [0-9a-f]{64} but .* has no agent\.tgz/)
    expect(out).not.toMatch(/PASS/)
  }, 60_000)

  it("FAIL — the packed kit's .sha256 does not describe its agent.tgz", () => {
    const out = scenario({ page: OTHER_SHA, kit: { bytes: KIT_BYTES, shaLine: `${OTHER_SHA}  agent.tgz\n` } })
    expect(out).toMatch(/FAIL\S*\s+.*altered after packing/)
    expect(out).not.toMatch(/PASS/)
  }, 60_000)

  it("FAIL — the page prints another kit's hash than the one packed", () => {
    const out = scenario({ page: OTHER_SHA, kit: { bytes: KIT_BYTES, shaLine: `${KIT_SHA}  agent.tgz\n` } })
    expect(out).toMatch(new RegExp(`FAIL\\S*\\s+/agents prints ${OTHER_SHA} but the packed kit is ${KIT_SHA}`))
    expect(out).not.toMatch(/PASS/)
  }, 60_000)

  it("FAIL — a kit is packed behind a page that says this build serves no kit", () => {
    const out = scenario({ page: null, kit: { bytes: KIT_BYTES, shaLine: `${KIT_SHA}  agent.tgz\n` } })
    expect(out).toMatch(/FAIL\S*\s+\/agents says this build serves no kit, but .*agent\.tgz is packed/)
    expect(out).not.toMatch(/PASS/)
  }, 60_000)

  it("WARN, never FAIL — no hash on the page and no kit anywhere (the honest pre-S1 state)", () => {
    const out = scenario({ page: null, kit: null })
    expect(out).toMatch(/WARN\S*\s+\/agents prints no kit hash and no kit is packed/)
    expect(out).not.toMatch(/FAIL/)
  }, 60_000)

  it("FAIL — /agents not prerendered at all", () => {
    const out = scenario({ page: "absent", kit: null })
    expect(out).toMatch(/FAIL\S*\s+\/agents is not prerendered/)
  }, 60_000)
})
