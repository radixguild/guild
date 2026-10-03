/**
 * Behavioral test for reconcile-cron.sh's flock -n overlap guard (C2-R2 audit
 * defect 2's cron-side half — "no cron overlap lock").
 *
 * Cron is `15,45 * * * *`. Before this fix, a run stuck past 30 minutes (a
 * hang anywhere in the process — Gateway, DB, disk) would let the NEXT cron
 * tick start a SECOND invocation on top of the still-running first one, both
 * reading/writing the same $CURSOR_FILE with last-writer-wins, and the cursor
 * could regress past healed work.
 *
 * This runs the REAL script (not an extracted fragment) with an externally
 * held lock, so it exercises the actual flock/exec ordering in
 * reconcile-cron.sh rather than a paraphrase. `RECONCILE_CURSOR_FILE` points
 * at a path that doesn't exist, so if the lock check is ever skipped or
 * ordered AFTER the cursor read, this test would see the cursor-missing
 * failure path instead of the lock-skip path — that divergence is exactly
 * what makes the assertions below falsifiable.
 */
import { describe, it, expect, vi } from "vitest"
import { execFileSync, execSync, spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateInputs } from "../support/private-input"

// The negative-control case below now also runs the P2 network-halt guard
// (added 2026-09-07, docs/design/security-hardening.md §2) before it reaches
// the cursor check — a real curl + date subprocess call on top of the real
// script's own execFileSync (bounded at 10s below), under vitest's default 5s
// per-test timeout. See reconcile-cron-mute.test.ts for the identical note.
vi.setConfig({ testTimeout: 15_000 })

const SCRIPT_PATH = join(process.cwd(), "scripts/reconcile-cron.sh")
// guild-app/scripts/reconcile-cron.sh is private-only (publish/MANIFEST.md): skip in the public
// tree instead of running bash against a missing file (found by the 2026-10-03 P review).
const PRIV = privateInputs("guild-app/scripts/reconcile-cron.sh")

// `flock` is a util-linux tool: present on every Ubuntu box this ever runs on
// (the deploy target VPS, and CI's ubuntu-latest runner — see
// .github/workflows/test.yml), but macOS ships no such command at all. Skip
// with a clear reason locally rather than red-failing on a Mac for a reason
// that has nothing to do with the script's correctness; CI is where this
// actually exercises the real behavior.
const HAS_FLOCK = (() => {
  try {
    execSync("command -v flock", { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

/**
 * The negative-control case below deliberately reaches past the lock check
 * into the cursor-missing branch, which calls alert() — and alert() reads
 * `.env.local` from the REAL guild-app cwd (the script `cd`s there before
 * the lock check), which may hold real KEEPER_ALERT_TG_TOKEN/CHAT creds in a
 * local dev checkout. Every invocation here gets a fake `curl` shadowing the
 * real one on PATH so this test can NEVER place a real network call to
 * Telegram, regardless of which branch it takes or what `.env.local` holds.
 */
function fakeCurlBinDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-cron-lock-bin-"))
  const curlPath = join(dir, "curl")
  writeFileSync(curlPath, `#!/usr/bin/env bash\nprintf '{"ok":true,"result":{}}\\n200\\n'\n`)
  chmodSync(curlPath, 0o755)
  return dir
}

function runScript(lockFile: string, cursorFile: string): { output: string; exitCode: number } {
  try {
    const output = execFileSync("bash", [SCRIPT_PATH], {
      env: {
        ...process.env,
        RECONCILE_LOCK_FILE: lockFile,
        RECONCILE_CURSOR_FILE: cursorFile,
        PATH: `${fakeCurlBinDir()}:${process.env.PATH}`,
      },
      encoding: "utf8",
      timeout: 10_000,
    })
    return { output, exitCode: 0 }
  } catch (e: any) {
    return { output: (e.stdout ?? "") + (e.stderr ?? ""), exitCode: e.status ?? 1 }
  }
}

/**
 * A skipped suite is a check that cannot fail, and this one skips on every Mac
 * — so the ONLY machine where the flock guard is ever actually exercised is CI
 * (ubuntu-latest, per .github/workflows/test.yml). If `flock` ever went missing
 * there, or the `command -v flock` probe above broke, the suite below would
 * turn into a permanent silent skip and this file would keep reporting success
 * while proving nothing.
 *
 * This test makes that outcome LOUD in the one place it matters. Locally it is
 * a no-op; in CI it reddens. Falsifying input: unset flock on the CI image (or
 * break HAS_FLOCK's probe) and this goes red instead of quietly skipping.
 */
describe.skipIf(PRIV.skip)("flock coverage is real where it counts", () => {
  it("has flock available in CI, so the guard suite below is not silently skipped", () => {
    if (!process.env.CI) return
    expect(HAS_FLOCK).toBe(true)
  })
})

describe.skipIf(!HAS_FLOCK)("reconcile-cron.sh — flock -n overlap guard", () => {
  it("skips immediately (exit 0) when another run already holds the lock, before ever touching the cursor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-cron-lock-"))
    const lockFile = join(dir, "guild-reconcile.lock")
    const missingCursor = join(dir, "does-not-exist.cursor")

    // Hold the lock externally for long enough to run the assertion inside
    // the window — mirrors what a genuinely hung reconcile-escrow.mjs
    // invocation would do to this same file.
    const holder: ChildProcess = spawn("flock", [lockFile, "sleep", "5"], { stdio: "ignore" })
    try {
      // Give the holder a moment to actually acquire the lock before racing it.
      await new Promise((r) => setTimeout(r, 300))

      const { output, exitCode } = runScript(lockFile, missingCursor)

      expect(exitCode).toBe(0)
      expect(output).toContain("another run still holds the lock")
      expect(output).toContain("skipping this invocation")
      // The discriminator: if the lock check were missing/broken, this run
      // would instead reach the cursor-file branch and print ITS message
      // (and alert + exit 1) — the two are mutually exclusive.
      expect(output).not.toContain("cursor file")
      expect(output).not.toContain("scan from state version")
    } finally {
      holder.kill()
    }
  })

  it("proceeds past the lock when nothing holds it (negative control — proves the skip above is conditional, not unconditional)", () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-cron-lock-negctl-"))
    const lockFile = join(dir, "guild-reconcile.lock")
    const missingCursor = join(dir, "does-not-exist.cursor")

    const { output, exitCode } = runScript(lockFile, missingCursor)

    // No lock contention here, so it must reach the cursor check and fail
    // THERE instead (the cursor file genuinely doesn't exist) — never the
    // lock-skip message.
    expect(output).not.toContain("another run still holds the lock")
    expect(output).toContain("cursor file")
    expect(output).toContain("missing")
    expect(exitCode).toBe(1)
  })
})
