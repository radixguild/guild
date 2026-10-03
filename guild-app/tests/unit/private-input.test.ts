import { describe, it, expect } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PRIVATE_TREE, privateInputs } from "../support/private-input"

/**
 * The skip-when-absent helper (ruled 2026-09-30). Its one dangerous failure mode
 * is skipping in the PRIVATE tree, so both directions are pinned — the private
 * one against this real tree, the public one in a throwaway tree built to look
 * like an export (no publish/extract-snapshot.mjs).
 */

const HELPER = join(process.cwd(), "tests", "support", "private-input.ts")

// Each case sets the switches it needs and inherits none: the ops repo runs this file
// under GUILD_REQUIRE_PRIVATE_INPUTS=1, and the skip cases below must still skip there.
const SWITCHES = new Set(["GUILD_REQUIRE_PRIVATE_INPUTS", "GUILD_SIMULATE_PUBLIC_EXPORT"])
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SWITCHES.has(k)))

function inTree(tree: { exporter: boolean; files: string[] }, code: string, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "priv-input-"))
  try {
    const app = join(root, "guild-app")
    mkdirSync(app, { recursive: true })
    if (tree.exporter) {
      mkdirSync(join(root, "publish"), { recursive: true })
      writeFileSync(join(root, "publish", "extract-snapshot.mjs"), "")
    }
    for (const f of tree.files) {
      mkdirSync(join(root, f, ".."), { recursive: true })
      writeFileSync(join(root, f), "")
    }
    const script = `import { privateInputs, PRIVATE_TREE } from ${JSON.stringify(HELPER)}\n${code}`
    return spawnSync("bun", ["-e", script], { cwd: app, encoding: "utf8", env: { ...BASE_ENV, ...env } })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("privateInputs", () => {
  // This file ships and runs in the public export too, so nothing here may assume which
  // tree it is in: the private-tree cases run in a throwaway tree that HAS the exporter.
  it.skipIf(!PRIVATE_TREE)("the private checkout knows it is the private tree", () => {
    expect(PRIVATE_TREE).toBe(true)
  })

  it("does not skip when the inputs are present (in either tree)", () => {
    expect(privateInputs("guild-app/package.json")).toEqual({ skip: false, missing: [] })
  })

  it("THROWS in the private tree when an input is missing — never a silent skip", () => {
    const r = inTree({ exporter: true, files: [] }, `privateInputs("scripts/deploy.sh")`)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/missing from the PRIVATE tree: scripts\/deploy\.sh/)
  })

  it("skips, naming the input, in a tree without the exporter (the public export)", () => {
    const r = inTree({ exporter: false, files: [] }, `console.log(JSON.stringify([PRIVATE_TREE, privateInputs("scripts/deploy.sh")]))`)
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual([false, { skip: true, missing: ["scripts/deploy.sh"] }])
  })

  it("runs normally in the public export when the input does ship", () => {
    const r = inTree({ exporter: false, files: ["scripts/pack-kit.sh"] }, `console.log(JSON.stringify(privateInputs("scripts/pack-kit.sh")))`)
    expect(JSON.parse(r.stdout)).toEqual({ skip: false, missing: [] })
  })

  it("GUILD_SIMULATE_PUBLIC_EXPORT=1 treats the private tree as the export", () => {
    const r = inTree(
      { exporter: true, files: ["scripts/deploy.sh"] },
      `console.log(JSON.stringify([PRIVATE_TREE, privateInputs("scripts/deploy.sh")]))`,
      { GUILD_SIMULATE_PUBLIC_EXPORT: "1" },
    )
    expect(JSON.parse(r.stdout)).toEqual([false, { skip: true, missing: ["scripts/deploy.sh"] }])
  })
})

// The strict switch (F16). The composed tree has no exporter, exactly like the
// export, so the case that matters is the export-shaped tree.
describe("privateInputs under GUILD_REQUIRE_PRIVATE_INPUTS=1", () => {
  const STRICT = { GUILD_REQUIRE_PRIVATE_INPUTS: "1" }

  it("THROWS in a tree without the exporter (the composed tree) — the case the switch exists for", () => {
    const r = inTree({ exporter: false, files: [] }, `privateInputs("scripts/deploy.sh")`, STRICT)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/missing under GUILD_REQUIRE_PRIVATE_INPUTS=1: scripts\/deploy\.sh/)
  })

  it("still THROWS in the private tree", () => {
    const r = inTree({ exporter: true, files: [] }, `privateInputs("scripts/deploy.sh")`, STRICT)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/missing from the PRIVATE tree: scripts\/deploy\.sh/)
  })

  it("does not get in the way when every input is present", () => {
    const r = inTree(
      { exporter: false, files: ["scripts/deploy.sh"] },
      `console.log(JSON.stringify(privateInputs("scripts/deploy.sh")))`,
      STRICT,
    )
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ skip: false, missing: [] })
  })

  it("with GUILD_SIMULATE_PUBLIC_EXPORT=1 too, every declared input counts as missing and throws", () => {
    const r = inTree(
      { exporter: true, files: ["scripts/deploy.sh"] },
      `privateInputs("scripts/deploy.sh")`,
      { ...STRICT, GUILD_SIMULATE_PUBLIC_EXPORT: "1" },
    )
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/missing under GUILD_REQUIRE_PRIVATE_INPUTS=1: scripts\/deploy\.sh/)
  })

  it('"0" and "" leave it off: the export-shaped tree skips', () => {
    for (const off of ["0", ""]) {
      const r = inTree(
        { exporter: false, files: [] },
        `console.log(JSON.stringify(privateInputs("scripts/deploy.sh")))`,
        { GUILD_REQUIRE_PRIVATE_INPUTS: off },
      )
      expect(r.status, r.stderr).toBe(0)
      expect(JSON.parse(r.stdout)).toEqual({ skip: true, missing: ["scripts/deploy.sh"] })
    }
  })

  it("refuses any other value at import, so a typo cannot leave it off", () => {
    const r = inTree(
      { exporter: false, files: ["scripts/deploy.sh"] },
      `console.log(JSON.stringify(privateInputs("scripts/deploy.sh")))`,
      { GUILD_REQUIRE_PRIVATE_INPUTS: "true" },
    )
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/GUILD_REQUIRE_PRIVATE_INPUTS must be "1" \(strict\) or unset\/"0" \(off\), not "true"/)
  })
})
