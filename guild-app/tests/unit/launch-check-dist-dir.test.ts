/**
 * The launch gate must inspect the build that is about to be served — and only
 * that one.
 *
 * scripts/deploy.sh builds into a CANDIDATE directory so the artifact the live
 * server is reading is never written to, then runs scripts/launch-check.sh
 * against the candidate via LAUNCH_CHECK_DIST_DIR. That only works while every
 * check honours the variable. A single check that keeps a hardcoded ".next"
 * would read the OLD, already-serving, already-approved build and report green
 * on an artifact nobody is about to serve — a gate that passes on the wrong
 * thing, which is a worse failure than the incident the candidate directory was
 * introduced to fix (2026-09-08: a red gate left 2 of 14 homepage chunks
 * serving 500, because the build had already replaced .next under the running
 * process).
 *
 * ── Why a source-text test and not just a behavioural one ───────────────────
 * Both are here, and they catch different things. The behavioural test proves
 * the CURRENT checks honour the variable. The source-text test is what survives
 * contact with the future: launch-check.sh accreted seven independent hardcoded
 * ".next" paths as CHECKs were added one at a time over months, and nothing
 * stopped that. The structural rule — one definition, no other bare literal —
 * makes CHECK 10 fail this test the day someone writes it the old way, rather
 * than silently gating the wrong directory. It is the guard that makes the
 * parameterisation load-bearing instead of a convention.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { privateInputs } from "../support/private-input"

const APP = process.cwd()
const GATE = join(APP, "scripts/launch-check.sh")
// guild-app/scripts/launch-check.sh stays EXCLUDE at the open-source flip
// (publish/MANIFEST.md); only the source-text describe block below needs it.
const PRIV = privateInputs("guild-app/scripts/launch-check.sh")
const src = PRIV.skip ? "" : readFileSync(GATE, "utf8")

/** Executable lines only: shell `#` comments and JS `//` comments inside the
 *  node -e blocks may say ".next" freely — they are prose, and several explain
 *  the history that made this rule necessary. */
function executableLines(text: string): { n: number; line: string }[] {
  return text
    .split("\n")
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => {
      const t = line.trim()
      return t !== "" && !t.startsWith("#") && !t.startsWith("//") && !t.startsWith("*")
    })
}

describe.skipIf(PRIV.skip)("the gate reads one configurable build directory", () => {
  it("defines it exactly once, defaulting to .next", () => {
    const defaults = executableLines(src).filter(({ line }) =>
      /^DEFAULT_DIST="\.next"$/.test(line.trim()),
    )
    const defs = executableLines(src).filter(({ line }) =>
      /^DIST="\$\{LAUNCH_CHECK_DIST_DIR:-\$DEFAULT_DIST\}"$/.test(line.trim()),
    )
    expect(defaults, "the literal default belongs on exactly one line").toHaveLength(1)
    expect(defs).toHaveLength(1)
  })

  it("exports it, so node -e blocks and honest-copy.mjs resolve the same directory", () => {
    // CHECK 4 imports honest-copy.mjs in a child node process and CHECK 7 runs
    // its own node -e. Neither inherits a plain shell variable.
    expect(src).toContain('export LAUNCH_CHECK_DIST_DIR="$DIST"')
  })

  it("has no other bare .next literal anywhere in executable code", () => {
    const offenders = executableLines(src)
      .filter(({ line }) => /(^|[^\w-])\.next(\/|["'\s]|$)/.test(line))
      .filter(({ line }) => !/^DEFAULT_DIST="\.next"$/.test(line.trim()))
      // The node -e block reads the same variable with the same default; that IS
      // the parameterised form, not a hardcode.
      .filter(({ line }) => !line.includes('process.env.LAUNCH_CHECK_DIST_DIR || ".next"'))
      .map(({ n, line }) => `${n}: ${line.trim()}`)

    expect(
      offenders,
      "a hardcoded .next here would make the gate inspect the live build instead of the " +
        "candidate — read this file's header before 'fixing' the test",
    ).toEqual([])
  })
})

describe("honest-copy.mjs resolves the same directory", () => {
  it("derives fileFor() from LAUNCH_CHECK_DIST_DIR, not a literal", async () => {
    const hc = await import("../../scripts/honest-copy.mjs")
    // Unset in this process, so it must fall back to the historical default —
    // dev, CI and a plain `bash scripts/launch-check.sh` all rely on that.
    expect(hc.fileFor("/")).toBe(".next/server/app/index.html")
    expect(hc.fileFor("/tasks/create")).toBe(".next/server/app/tasks/create.html")
  })

  it("follows the variable when the gate sets it", () => {
    // Re-imported in a child process because the module reads the env at import
    // time; vitest's module cache would otherwise hand back the first instance.
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { fileFor } from ${JSON.stringify(join(APP, "scripts/honest-copy.mjs"))};` +
          `process.stdout.write(fileFor("/"));`,
      ],
      { env: { ...process.env, LAUNCH_CHECK_DIST_DIR: ".next-candidate" }, encoding: "utf8" },
    )
    expect(out).toBe(".next-candidate/server/app/index.html")
  })
})
