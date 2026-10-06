import { describe, it, expect } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * lefthook.yml's pre-commit `identity` hook runs `node scripts/pii-scan.mjs
 * --check-ident`. lefthook.yml ships in the public repo; pii-scan.mjs does not
 * (it stays with the maintainers). So a contributor who installed lefthook got a
 * failing hook on every commit (publish/REHEARSAL-2026-10-01.md, finding 4).
 * The hook now SKIPS when the scanner is absent (post-flip-topology §10, F15).
 *
 * The guard must not swallow a real failure: wherever the scanner exists, its exit
 * code decides. Both directions run here, in throwaway trees, so this file passes
 * the same way in the private repo and in the public export.
 *
 * The block is read from lefthook.yml and run with `sh -c` from the tree's root,
 * the way lefthook runs a command (no `root:` is set).
 */

const LEFTHOOK = join(process.cwd(), "..", "lefthook.yml")

/** The `run: |` block of pre-commit → commands → identity, dedented. */
function identityRunBlock(yaml: string): string {
  const lines = yaml.split("\n")
  const at = lines.findIndex((l) => /^\s+identity:\s*$/.test(l))
  if (at === -1) throw new Error("lefthook.yml has no `identity:` command")
  const runAt = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l))
  if (runAt === -1) throw new Error("the identity command has no `run: |` block")
  const runIndent = lines[runAt].search(/\S/)
  const body: string[] = []
  for (const l of lines.slice(runAt + 1)) {
    if (l.trim() !== "" && l.search(/\S/) <= runIndent) break
    body.push(l)
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)))
  return body.map((l) => l.slice(indent)).join("\n").trim()
}

const RUN = identityRunBlock(readFileSync(LEFTHOOK, "utf8"))

/**
 * Run the hook from the root of a throwaway tree; `scanner` = the stand-in
 * scripts/pii-scan.mjs. `outside` = a stand-in scanner OUTSIDE the tree, which
 * GUILD_PII_SCAN is pointed at; `guildPiiScan` sets GUILD_PII_SCAN verbatim
 * instead. GUILD_PII_SCAN is always cleared from the inherited env first, so a
 * maintainer who exports it does not change what these tests see.
 */
function runHook(
  scanner?: string,
  opts: { outside?: string; guildPiiScan?: string; path?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "lefthook-identity-"))
  const away = mkdtempSync(join(tmpdir(), "lefthook-identity-overlay-"))
  try {
    if (scanner !== undefined) {
      mkdirSync(join(root, "scripts"))
      writeFileSync(join(root, "scripts", "pii-scan.mjs"), scanner)
    }
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.GUILD_PII_SCAN
    if (opts.outside !== undefined) {
      writeFileSync(join(away, "pii-scan.mjs"), opts.outside)
      env.GUILD_PII_SCAN = join(away, "pii-scan.mjs")
    }
    if (opts.guildPiiScan !== undefined) env.GUILD_PII_SCAN = opts.guildPiiScan
    if (opts.path !== undefined) env.PATH = opts.path
    return spawnSync("/bin/sh", ["-c", RUN], { cwd: root, encoding: "utf8", env })
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(away, { recursive: true, force: true })
  }
}

describe("lefthook identity hook", () => {
  it("still runs the identity check (the block is the one the hook executes)", () => {
    expect(RUN).toMatch(/^node scripts\/pii-scan\.mjs --check-ident$/m)
  })

  it("SKIPS, saying why, when scripts/pii-scan.mjs is absent (a public clone)", () => {
    const r = runHook()
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/identity check skipped: scripts\/pii-scan\.mjs is not in this clone/)
  })

  it("lets the scanner's failure through when it exists — the guard swallows nothing", () => {
    const r = runHook(`process.exit(7)\n`)
    expect(r.status).toBe(7)
    expect(r.stdout).not.toMatch(/skipped/)
  })

  it("passes --check-ident to the scanner, and its success is the hook's", () => {
    const r = runHook(`console.log("argv=" + process.argv.slice(2).join(" "))\n`)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe("argv=--check-ident")
  })

  // ── GUILD_PII_SCAN: the maintainer's scanner, kept outside the public tree ──
  // Before this, a maintainer's clone of the public repo skipped the identity
  // check on every commit (the scanner is not in the tree), so the first identity
  // check ran after the commit was already public.

  it("GUILD_PII_SCAN: runs the scanner it names when scripts/pii-scan.mjs is absent, and its failure blocks", () => {
    const r = runHook(undefined, { outside: `process.exit(1)\n` })
    expect(r.status).toBe(1)
    expect(r.stdout).not.toMatch(/skipped/)
  })

  it("GUILD_PII_SCAN: passes --check-ident, and the scanner's success is the hook's", () => {
    const r = runHook(undefined, { outside: `console.log("argv=" + process.argv.slice(2).join(" "))\n` })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe("argv=--check-ident")
  })

  it("GUILD_PII_SCAN: wins over an in-tree scanner (the explicit setting decides)", () => {
    const r = runHook(`process.exit(0)\n`, { outside: `process.exit(3)\n` })
    expect(r.status).toBe(3)
  })

  it("GUILD_PII_SCAN set but naming no file FAILS, loudly — it never skips", () => {
    const r = runHook(undefined, { guildPiiScan: join(tmpdir(), "no-such-dir-lefthook", "pii-scan.mjs") })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/identity check FAILED: GUILD_PII_SCAN is set but names no file/)
    expect(r.stdout).not.toMatch(/skipped/)
  })

  it("GUILD_PII_SCAN set but node missing FAILS — the node SKIP is for contributors only", () => {
    // PATH holds only a dir with no node in it; /bin/sh is spawned by its absolute
    // path, so the hook block runs with every command it needs a builtin.
    const empty = mkdtempSync(join(tmpdir(), "lefthook-identity-nopath-"))
    try {
      const r = runHook(undefined, { outside: `process.exit(0)\n`, path: empty })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toMatch(/identity check FAILED: GUILD_PII_SCAN is set but node is not on PATH/)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it("unset GUILD_PII_SCAN with no in-tree scanner still SKIPS and names the knob", () => {
    const r = runHook(undefined, { guildPiiScan: "" })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/identity check skipped: .*GUILD_PII_SCAN is unset/)
  })
})
