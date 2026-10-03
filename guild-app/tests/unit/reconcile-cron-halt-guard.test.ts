/**
 * Behavioral tests for reconcile-cron.sh's P2 network-halt guard
 * (docs/design/security-hardening.md §2), added alongside
 * scripts/lib/network-halt-guard.mjs's evaluateHalt/checkNetworkHalt (the JS
 * equivalent keeper.mjs and escrow-drift-watch.mjs call).
 *
 * Same shape as tests/unit/reconcile-cron-mute.test.ts: runs the REAL script
 * via execFileSync, not an extracted fragment, so it exercises the actual
 * top-of-script ordering — this guard runs BEFORE the lock, cursor read, and
 * alert() are ever reached. A fake `curl` shadows the real one on PATH (this
 * test must never place a real network call) and distinguishes the two calls
 * this script can make through curl: the Gateway status probe (this guard)
 * and a Telegram alert (`alert()`, further down the script) — two separate
 * marker files let a test assert "the probe ran but no page went out" and
 * "neither ran at all", not just "curl was called".
 */
import { describe, it, expect, vi, beforeAll } from "vitest"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateInputs } from "../support/private-input"

// Each test spawns a real bash subprocess (execFileSync, itself bounded at
// 10s below, same as reconcile-cron-mute.test.ts / reconcile-cron-lock.test.ts).
// Vitest's own default per-test timeout is 5s, which is BELOW that child bound
// — under load (this suite has 8 such subprocess-spawning tests, run in
// parallel with the rest of the file suite) a slow-but-not-hung child can trip
// vitest's timeout before its own. Widened here so the child's bound is the
// one that actually governs.
vi.setConfig({ testTimeout: 15_000 })

// guild-app/scripts/reconcile-cron.sh stays private at the open-source flip
// (operational cron wrapper — publish/MANIFEST.md).
const PRIV = privateInputs("guild-app/scripts/reconcile-cron.sh")
const SCRIPT_PATH = join(process.cwd(), "scripts/reconcile-cron.sh")

interface FakeCurlOpts {
  /** ISO tip timestamp the fake Gateway probe returns, or null to simulate an
   *  unreadable/empty response (curl "succeeded" but the body has nothing
   *  usable — the guard's fall-through path, same as a real curl failure). */
  tipIso: string | null
  /** When true, the fake curl exits non-zero on every call (a real transport
   *  failure — connection refused, DNS, timeout) instead of returning 200
   *  with an empty body. Exercises the exact same fall-through path a
   *  different way. */
  exitNonZero?: boolean
}

/**
 * A fake curl that:
 *  - touches `gatewayMarker` on EVERY invocation (proves whether curl was
 *    reached at all — the lever-engaged case must never touch this)
 *  - touches `alertMarker` and returns a fake Telegram "ok" ONLY when called
 *    with a api.telegram.org URL (proves the halt guard never pages)
 *  - otherwise returns a canned Gateway `gateway-status` body built from
 *    `tipIso`, or fails, per FakeCurlOpts
 *
 * Also shadows `flock` with an always-succeeds stub, same as
 * reconcile-cron-mute.test.ts and reconcile-cron-lock.test.ts — util-linux's
 * flock isn't installed on macOS, and these tests don't exercise lock
 * CONTENTION, only what happens before it.
 *
 * Both stubs are minted ONCE per file and take their per-test behaviour from
 * the environment (FAKE_CURL_*) — the fix workflow-runners.test.ts documents
 * for its `gh` stub, applied here for the same measured reason. A freshly
 * written EXECUTABLE pays a one-off first-exec scan on macOS: measured
 * 2026-09-30 on this Mac, ~310ms on first exec against ~7ms re-running the
 * same file (`bash <fresh file>` never pays it — the file is read, not
 * exec'd). And that scan is SERIALISED machine-wide: 33 fresh stubs took
 * 11.8s of wall clock whether exec'd 1, 4 or 11 at a time (per-exec median
 * 0.3s → 1.3s → 4.0s), so a per-test stub queues behind every other one in
 * every vitest worker — and in every other session's suite on the same box.
 * The old per-call pair was 16 scans per file: three full-suite runs on main
 * put single tests here at up to 7.7s, and a fourth, under peer sessions'
 * concurrent suites with `--maxWorkers=4` capping this process, failed 2 on
 * the child's own 10s bound below (empty output) — the queue, not the
 * script. Now it is 2 scans per file, paid in beforeAll under the 60s
 * hookTimeout (vitest.config.ts) rather than inside the first test's budget.
 */
const BIN_DIR = mkdtempSync(join(tmpdir(), "reconcile-cron-halt-bin-"))
writeFileSync(
  join(BIN_DIR, "curl"),
  `#!/usr/bin/env bash
touch "$FAKE_CURL_GATEWAY_MARKER"
[ -n "\${FAKE_CURL_EXIT-}" ] && exit "$FAKE_CURL_EXIT"
for arg in "$@"; do
  case "$arg" in
    *api.telegram.org*)
      touch "$FAKE_CURL_ALERT_MARKER"
      printf '{"ok":true,"result":{}}\\n200\\n'
      exit 0
      ;;
  esac
done
printf '%s' "\${FAKE_CURL_TIP_BODY-}"
`,
)
chmodSync(join(BIN_DIR, "curl"), 0o755)
writeFileSync(join(BIN_DIR, "flock"), `#!/usr/bin/env bash\nexit 0\n`)
chmodSync(join(BIN_DIR, "flock"), 0o755)

beforeAll(() => {
  const warm = join(BIN_DIR, "warm-up")
  execFileSync(join(BIN_DIR, "curl"), [], {
    env: { ...process.env, FAKE_CURL_GATEWAY_MARKER: warm, FAKE_CURL_ALERT_MARKER: warm },
  })
  execFileSync(join(BIN_DIR, "flock"), [])
})

interface RunResult {
  output: string
  exitCode: number
}

function runScript(env: Record<string, string>, gatewayMarker: string, alertMarker: string, curlOpts: FakeCurlOpts): RunResult {
  try {
    const output = execFileSync("bash", [SCRIPT_PATH], {
      env: {
        ...process.env,
        ...env,
        FAKE_CURL_GATEWAY_MARKER: gatewayMarker,
        FAKE_CURL_ALERT_MARKER: alertMarker,
        FAKE_CURL_TIP_BODY: curlOpts.tipIso
          ? `{"ledger_state":{"state_version":557840622,"proposer_round_timestamp":"${curlOpts.tipIso}"}}`
          : "",
        FAKE_CURL_EXIT: curlOpts.exitNonZero ? "7" : "",
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

// Well outside GUILD_HALT_AFTER_SECONDS' default (600s) either way.
const FRESH_TIP_ISO = () => new Date().toISOString()
const STALE_TIP_ISO = "2026-08-31T21:19:06.000Z" // the real 2026-08-31 halt tip

describe.skipIf(PRIV.skip)("reconcile-cron.sh — network halt guard (P2)", () => {
  it("GUILD_HALT=1 exits 0 before the lock, the cursor, or curl at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-cron-halt-lever-"))
    const cursorFile = join(dir, "does-not-exist.cursor")
    const lockFile = join(dir, "guild-reconcile.lock")
    const gatewayMarker = join(dir, "curl-was-called")
    const alertMarker = join(dir, "alert-was-sent")

    const { output, exitCode } = runScript(
      {
        GUILD_HALT: "1",
        RECONCILE_CURSOR_FILE: cursorFile,
        RECONCILE_LOCK_FILE: lockFile,
        RECONCILE_PAUSE_FILE: join(dir, "unused.paused"),
      },
      gatewayMarker,
      alertMarker,
      { tipIso: FRESH_TIP_ISO() },
    )

    expect(exitCode).toBe(0)
    expect(output).toContain("HALT")
    expect(output).toContain("operator lever")
    expect(output).not.toContain("cursor file")
    expect(output).not.toContain("another run still holds the lock")
    expect(existsSync(cursorFile)).toBe(false)
    expect(existsSync(gatewayMarker)).toBe(false) // curl never reached — the lever needs no Gateway confirmation
    expect(existsSync(alertMarker)).toBe(false)
  })

  it('GUILD_HALT="true" halts the same as "1"', () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-cron-halt-lever-true-"))
    const { output, exitCode } = runScript(
      {
        GUILD_HALT: "true",
        RECONCILE_CURSOR_FILE: join(dir, "does-not-exist.cursor"),
        RECONCILE_LOCK_FILE: join(dir, "guild-reconcile.lock"),
        RECONCILE_PAUSE_FILE: join(dir, "unused.paused"),
      },
      join(dir, "curl-was-called"),
      join(dir, "alert-was-sent"),
      { tipIso: FRESH_TIP_ISO() },
    )
    expect(exitCode).toBe(0)
    expect(output).toContain("HALT")
  })

  it("a stale ledger tip (age past GUILD_HALT_AFTER_SECONDS) halts: probes the Gateway, pages nobody, touches no lock/cursor", () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-cron-halt-age-"))
    const cursorFile = join(dir, "does-not-exist.cursor")
    const gatewayMarker = join(dir, "curl-was-called")
    const alertMarker = join(dir, "alert-was-sent")

    const { output, exitCode } = runScript(
      {
        RECONCILE_CURSOR_FILE: cursorFile,
        RECONCILE_LOCK_FILE: join(dir, "guild-reconcile.lock"),
        RECONCILE_PAUSE_FILE: join(dir, "unused.paused"),
      },
      gatewayMarker,
      alertMarker,
      { tipIso: STALE_TIP_ISO },
    )

    expect(exitCode).toBe(0)
    expect(output).toContain("HALT")
    expect(output).toContain("network stopped")
    expect(output).not.toContain("cursor file")
    expect(existsSync(cursorFile)).toBe(false)
    expect(existsSync(gatewayMarker)).toBe(true) // the probe DID run
    expect(existsSync(alertMarker)).toBe(false) // but nothing paged
  })

  it("respects GUILD_HALT_AFTER_SECONDS override — a tip stale by the default (600s) but fresh under a widened window does not halt", () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-cron-halt-override-"))
    const tenMinutesAgo = new Date(Date.now() - 700_000).toISOString() // 700s old
    const { output, exitCode } = runScript(
      {
        GUILD_HALT_AFTER_SECONDS: "3600",
        RECONCILE_CURSOR_FILE: join(dir, "does-not-exist.cursor"),
        RECONCILE_LOCK_FILE: join(dir, "guild-reconcile.lock"),
        RECONCILE_PAUSE_FILE: join(dir, "unused.paused"),
      },
      join(dir, "curl-was-called"),
      join(dir, "alert-was-sent"),
      { tipIso: tenMinutesAgo },
    )
    expect(output).not.toContain("HALT")
    // Falls through to the real (non-halt) failure path — proves it did NOT halt.
    expect(output).toContain("cursor file")
    expect(exitCode).toBe(1)
  })

  it("negative control: a fresh tip and no lever falls through to the real cursor-missing failure, unmuted by the halt guard", () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-cron-halt-negctl-"))
    const gatewayMarker = join(dir, "curl-was-called")
    const alertMarker = join(dir, "alert-was-sent")

    const { output, exitCode } = runScript(
      {
        RECONCILE_CURSOR_FILE: join(dir, "does-not-exist.cursor"),
        RECONCILE_LOCK_FILE: join(dir, "guild-reconcile.lock"),
        RECONCILE_PAUSE_FILE: join(dir, "unused.paused"),
      },
      gatewayMarker,
      alertMarker,
      { tipIso: FRESH_TIP_ISO() },
    )

    expect(output).not.toContain("HALT")
    expect(output).toContain("cursor file")
    expect(output).toContain("missing")
    expect(exitCode).toBe(1)
    expect(existsSync(gatewayMarker)).toBe(true) // the probe ran and correctly found nothing wrong
    expect(existsSync(alertMarker)).toBe(false)
  })

  it("a curl transport failure (non-zero exit, e.g. connection refused) is NOT treated as a halt — falls through to existing behaviour", () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-cron-halt-curlfail-"))
    const { output, exitCode } = runScript(
      {
        RECONCILE_CURSOR_FILE: join(dir, "does-not-exist.cursor"),
        RECONCILE_LOCK_FILE: join(dir, "guild-reconcile.lock"),
        RECONCILE_PAUSE_FILE: join(dir, "unused.paused"),
      },
      join(dir, "curl-was-called"),
      join(dir, "alert-was-sent"),
      { tipIso: null, exitNonZero: true },
    )
    expect(output).not.toContain("HALT")
    expect(output).toContain("cursor file")
    expect(exitCode).toBe(1)
  })

  it("an empty/unparsable Gateway response (curl 'succeeds' with no usable body) is NOT treated as a halt — falls through", () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-cron-halt-emptybody-"))
    const { output, exitCode } = runScript(
      {
        RECONCILE_CURSOR_FILE: join(dir, "does-not-exist.cursor"),
        RECONCILE_LOCK_FILE: join(dir, "guild-reconcile.lock"),
        RECONCILE_PAUSE_FILE: join(dir, "unused.paused"),
      },
      join(dir, "curl-was-called"),
      join(dir, "alert-was-sent"),
      { tipIso: null },
    )
    expect(output).not.toContain("HALT")
    expect(output).toContain("cursor file")
    expect(exitCode).toBe(1)
  })

  it("the mute switch (RECONCILE_CRON_DISABLED) still wins even when the network is halted — proves ordering, mute stays first", () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-cron-halt-mute-order-"))
    const gatewayMarker = join(dir, "curl-was-called")
    const alertMarker = join(dir, "alert-was-sent")

    const { output, exitCode } = runScript(
      {
        RECONCILE_CRON_DISABLED: "1",
        GUILD_HALT: "1",
        RECONCILE_CURSOR_FILE: join(dir, "does-not-exist.cursor"),
        RECONCILE_LOCK_FILE: join(dir, "guild-reconcile.lock"),
        RECONCILE_PAUSE_FILE: join(dir, "unused.paused"),
      },
      gatewayMarker,
      alertMarker,
      { tipIso: FRESH_TIP_ISO() },
    )
    expect(exitCode).toBe(0)
    expect(output).toContain("muted")
    expect(output).not.toContain("HALT")
    expect(existsSync(gatewayMarker)).toBe(false)
  })
})
