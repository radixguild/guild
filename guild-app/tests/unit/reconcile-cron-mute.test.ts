/**
 * Behavioral tests for reconcile-cron.sh's mute switch (added 2026-09-05).
 *
 * Before this, the ONLY way to silence the cron was via .env.local — the
 * alert() function greps KEEPER_ALERT_TG_TOKEN/CHAT straight off disk, so
 * unsetting an env var (the normal "turn this off" move) does nothing: the
 * script still runs the full scan, still holds the lock, still advances the
 * cursor. This adds a mute switch that needs no secret handling at all:
 * RECONCILE_CRON_DISABLED=1 in the environment, OR a
 * scripts/reconcile-cron.paused file, makes the script exit 0 before it
 * touches the lock, the cursor file, or (critically) ever reaches alert()'s
 * .env.local grep.
 *
 * This runs the REAL script (not an extracted fragment), the same way
 * tests/unit/reconcile-cron-lock.test.ts does, so it exercises the actual
 * top-of-script ordering rather than a paraphrase. A fake `curl` shadows the
 * real one on PATH as defense-in-depth (this test must never place a real
 * network call regardless of which branch it takes or what the real
 * guild-app checkout's .env.local holds) and doubles as a witness: if the
 * muted path ever regressed into calling alert(), the marker file it writes
 * would appear.
 */
import { describe, it, expect, vi, beforeAll } from "vitest"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateInputs } from "../support/private-input"

// The un-muted paths below now also run the P2 network-halt guard (added
// 2026-09-07, docs/design/security-hardening.md §2), which is a real curl +
// date subprocess call before the cursor check these tests exercise. Two
// extra subprocess spawns is normally noise, but this suite already runs the
// REAL script via execFileSync (itself bounded at 10s below) under vitest's
// default 5s per-test timeout — a margin the halt guard's own test file
// (reconcile-cron-halt-guard.test.ts) had to widen for the same reason.
// Widened here too so a loaded CI runner doesn't trip vitest's clock before
// the child process's own bound does.
vi.setConfig({ testTimeout: 15_000 })

// guild-app/scripts/reconcile-cron.sh stays private at the open-source flip
// (operational cron wrapper — publish/MANIFEST.md).
const PRIV = privateInputs("guild-app/scripts/reconcile-cron.sh")
const SCRIPT_PATH = join(process.cwd(), "scripts/reconcile-cron.sh")

/**
 * A fake curl that both fakes a successful Telegram response AND records
 * that it was ever invoked, so tests can assert "alert() was never reached"
 * rather than merely "no real network call happened".
 *
 * Also shadows `flock` with an always-succeeds stub — util-linux's flock
 * isn't installed on macOS at all (reconcile-cron-lock.test.ts's own
 * HAS_FLOCK probe documents this and skips its lock-specific assertions
 * here, relying on CI's ubuntu-latest for real coverage). These tests don't
 * exercise lock CONTENTION — only what happens before/after an uncontended
 * lock acquisition — so a stub that always "succeeds" is faithful to that
 * and, unlike skipIf, keeps this suite exercised on every platform.
 *
 * Minted ONCE per file, with the marker path passed per call as
 * FAKE_CURL_MARKER, and warmed in beforeAll: a freshly-written executable
 * pays macOS's serialised first-exec scan, which is what put this file's
 * negative control at 8.6s under the full suite. The measurement is in
 * reconcile-cron-halt-guard.test.ts's stub comment.
 */
const BIN_DIR = mkdtempSync(join(tmpdir(), "reconcile-cron-mute-bin-"))
writeFileSync(
  join(BIN_DIR, "curl"),
  `#!/usr/bin/env bash\ntouch "$FAKE_CURL_MARKER"\nprintf '{"ok":true,"result":{}}\\n200\\n'\n`
)
chmodSync(join(BIN_DIR, "curl"), 0o755)
writeFileSync(join(BIN_DIR, "flock"), `#!/usr/bin/env bash\nexit 0\n`)
chmodSync(join(BIN_DIR, "flock"), 0o755)

beforeAll(() => {
  execFileSync(join(BIN_DIR, "curl"), [], {
    env: { ...process.env, FAKE_CURL_MARKER: join(BIN_DIR, "warm-up") },
  })
  execFileSync(join(BIN_DIR, "flock"), [])
})

interface RunResult {
  output: string
  exitCode: number
}

function runScript(env: Record<string, string>, markerFile: string): RunResult {
  try {
    const output = execFileSync("bash", [SCRIPT_PATH], {
      env: {
        ...process.env,
        ...env,
        FAKE_CURL_MARKER: markerFile,
        PATH: `${BIN_DIR}:${process.env.PATH}`,
      },
      encoding: "utf8",
      timeout: 10_000,
    })
    return { output, exitCode: 0 }
  } catch (e: any) {
    return { output: (e.stdout ?? "") + (e.stderr ?? ""), exitCode: e.status ?? 1 }
  }
}

describe.skipIf(PRIV.skip)("reconcile-cron.sh — mute switch", () => {
  it("RECONCILE_CRON_DISABLED=1 exits 0 before touching the cursor, the lock, or curl", () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-cron-mute-"))
    const cursorFile = join(dir, "does-not-exist.cursor")
    const lockFile = join(dir, "guild-reconcile.lock")
    const marker = join(dir, "curl-was-called")

    const { output, exitCode } = runScript(
      {
        RECONCILE_CRON_DISABLED: "1",
        RECONCILE_CURSOR_FILE: cursorFile,
        RECONCILE_LOCK_FILE: lockFile,
        RECONCILE_PAUSE_FILE: join(dir, "unused.paused"),
      },
      marker
    )

    expect(exitCode).toBe(0)
    expect(output).toContain("muted")
    // Mutually exclusive with the normal cursor-missing failure path — proves
    // the mute check runs FIRST, not that it happens to also short-circuit later.
    expect(output).not.toContain("cursor file")
    expect(output).not.toContain("another run still holds the lock")
    expect(existsSync(cursorFile)).toBe(false)
    expect(existsSync(marker)).toBe(false) // alert()/curl never reached
  })

  it("a reconcile-cron.paused file beside the script mutes just like the env var", () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-cron-mute-file-"))
    const cursorFile = join(dir, "does-not-exist.cursor")
    const pauseFile = join(dir, "reconcile-cron.paused")
    writeFileSync(pauseFile, "")
    const marker = join(dir, "curl-was-called")

    const { output, exitCode } = runScript(
      {
        RECONCILE_CURSOR_FILE: cursorFile,
        RECONCILE_PAUSE_FILE: pauseFile,
      },
      marker
    )

    expect(exitCode).toBe(0)
    expect(output).toContain("muted")
    expect(existsSync(marker)).toBe(false)
  })

  it("negative control: with neither switch set, the script is NOT muted and reaches the real cursor-missing failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-cron-mute-negctl-"))
    const cursorFile = join(dir, "does-not-exist.cursor")
    const lockFile = join(dir, "guild-reconcile.lock")
    const pauseFile = join(dir, "reconcile-cron.paused") // deliberately never created
    const marker = join(dir, "curl-was-called")

    const { output, exitCode } = runScript(
      {
        RECONCILE_CURSOR_FILE: cursorFile,
        RECONCILE_LOCK_FILE: lockFile,
        RECONCILE_PAUSE_FILE: pauseFile,
      },
      marker
    )

    expect(output).not.toContain("muted")
    expect(output).toContain("cursor file")
    expect(output).toContain("missing")
    expect(exitCode).toBe(1)
    // The witness is live: un-muted, the halt guard's Gateway probe reaches
    // the fake curl and writes the marker. Without this, a broken
    // FAKE_CURL_MARKER hand-off would leave every muted test's
    // `toBe(false)` passing for the wrong reason.
    expect(existsSync(marker)).toBe(true)
  })

  it("RECONCILE_CRON_DISABLED must be exactly \"1\" — \"0\" does not mute (proves an exact match, not truthiness)", () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-cron-mute-zero-"))
    const cursorFile = join(dir, "does-not-exist.cursor")
    const lockFile = join(dir, "guild-reconcile.lock")
    const marker = join(dir, "curl-was-called")

    const { output, exitCode } = runScript(
      {
        RECONCILE_CRON_DISABLED: "0",
        RECONCILE_CURSOR_FILE: cursorFile,
        RECONCILE_LOCK_FILE: lockFile,
        RECONCILE_PAUSE_FILE: join(dir, "reconcile-cron.paused"),
      },
      marker
    )

    expect(output).not.toContain("muted")
    expect(output).toContain("cursor file")
    expect(exitCode).toBe(1)
  })
})
