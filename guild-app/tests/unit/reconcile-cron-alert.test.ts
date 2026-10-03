/**
 * Behavioral tests for reconcile-cron.sh's alert() function (C2-R2 audit
 * defect 1 — "Telegram alert delivery failure is unobservable"; and the
 * 2026-09-30 audit's finding on the SAME function — a missing .env.local
 * (e.g. a fresh checkout, or any of this file's own throwaway temp cwds)
 * made every one of the two `grep ... .env.local` calls print
 * "grep: .env.local: No such file or directory" to stderr, even though the
 * fallback behaviour — no creds -> no-op — was already correct. Covered by
 * "is silent AND still a no-op when .env.local does not exist at all" below,
 * which is the one case every OTHER test in this file avoids: they always
 * write a .env.local first (even an empty one), so none of them exercised
 * the actually-missing-file path this fix targets.
 *
 * The old implementation was `curl -s -m 10 ... > /dev/null || true`: without
 * `-f`, curl exits 0 on HTTP 401 (revoked token) / 400 (wrong chat id) / 403
 * (bot blocked) alike, and the response body — where Telegram's `"ok":false`
 * lives — went straight to /dev/null. `|| true` discarded even a hard
 * connection failure. So a page could vanish with literally nothing in the
 * log to grep for. This matters specifically because it is the escape hatch
 * for the reconciler's `[unreconcilable]` events: the ONE place a human is
 * notified could fail silently at the exact moment it mattered.
 *
 * This test does NOT hand-copy the fix into a stand-in — it extracts the
 * REAL alert() function body out of the current script file and executes it
 * in a real bash subshell with a fake `curl` on PATH (so the exact current
 * implementation is what's under test, not a paraphrase that could drift).
 * No network call is ever made; the fake curl fully controls what "Telegram"
 * returns.
 */
import { describe, it, expect, vi, beforeAll } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateInputs } from "../support/private-input"

// Every test here forks a real bash subprocess (the extracted alert()
// function, plus a fake curl on PATH) — same class as
// deploy-kit-atomic.test.ts and reconcile-cron-lock.test.ts, both of which
// carry this same margin for the same reason (see the latter's comment).
// Observed directly while working on this file: under the full unit suite
// (many subprocess-heavy files forking in parallel), several of the tests
// below hit vitest's 5000ms default and failed on nothing but a slow fork —
// clean individually and in smaller batches. Pre-existing, not introduced by
// the .env.local-guard change in this PR; margin sized to match the
// established precedent.
vi.setConfig({ testTimeout: 15_000 })

// guild-app/scripts/reconcile-cron.sh stays private at the open-source flip
// (operational cron wrapper — publish/MANIFEST.md).
const PRIV = privateInputs("guild-app/scripts/reconcile-cron.sh")
const SCRIPT_PATH = join(process.cwd(), "scripts/reconcile-cron.sh")
const SRC = PRIV.skip ? "" : readFileSync(SCRIPT_PATH, "utf8")

function extractAlertFn(): string {
  const lines = SRC.split("\n")
  const start = lines.findIndex((l) => l.trim() === "alert() {")
  if (start === -1) {
    throw new Error("alert() function not found in reconcile-cron.sh — did it get renamed/removed?")
  }
  const end = lines.findIndex((l, i) => i > start && l.trim() === "}")
  if (end === -1) {
    throw new Error("alert() function's closing brace not found — extraction is out of sync with the file")
  }
  return lines.slice(start, end + 1).join("\n")
}

/**
 * The fake curl is minted ONCE per file: it runs the calling test's response
 * script — named by FAKE_CURL_SCRIPT, a plain file handed to `bash`, so read
 * rather than exec'd — with curl's argv. Minted per test (as it was), each
 * fake curl was a freshly written EXECUTABLE, and each paid macOS's one-off
 * first-exec scan, which is serialised machine-wide: 8 scans per file,
 * queued behind every fresh stub any other vitest worker or session was
 * exec'ing (measurement in deploy-kit-atomic.test.ts's stub comment).
 * The one scan left is paid in beforeAll, under the 60s hookTimeout
 * (vitest.config.ts), not inside the first test's budget.
 */
const CURL_BIN = mkdtempSync(join(tmpdir(), "reconcile-cron-alert-bin-"))
writeFileSync(join(CURL_BIN, "curl"), `#!/usr/bin/env bash\nexec bash "\${FAKE_CURL_SCRIPT:?}" "$@"\n`)
chmodSync(join(CURL_BIN, "curl"), 0o755)

beforeAll(() => {
  const warm = join(CURL_BIN, "warm-up.sh")
  writeFileSync(warm, "exit 0\n")
  execFileSync(join(CURL_BIN, "curl"), [], { env: { ...process.env, FAKE_CURL_SCRIPT: warm } })
})

interface RunResult {
  output: string
  exitCode: number
}

/**
 * Run the REAL alert() function (extracted above) in a throwaway bash
 * subshell: a temp CWD holding `.env.local`, a fake `curl` first on PATH,
 * and nothing else from the real script (no cursor logic, no flock, no bun
 * invocation) — this isolates exactly the function under test.
 */
/**
 * envLocal is the file's content, OR the literal string "ABSENT" to skip
 * writing .env.local entirely — the one case every other caller avoids
 * (they always write the file, even empty), and the case the 2026-09-30
 * stderr-noise fix targets.
 */
function runAlert(fakeCurlScript: string, envLocal: string | "ABSENT" = 'KEEPER_ALERT_TG_TOKEN="test-token"\nKEEPER_ALERT_TG_CHAT="12345"\n'): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-cron-alert-"))
  const curlScript = join(dir, "curl-response.sh")
  writeFileSync(curlScript, fakeCurlScript)

  if (envLocal !== "ABSENT") {
    writeFileSync(join(dir, ".env.local"), envLocal)
  }

  const harnessPath = join(dir, "harness.sh")
  writeFileSync(
    harnessPath,
    // `2>&1` on the alert call folds its stderr into the same captured stream
    // as its stdout — needed so a test can assert on the ABSENCE of stderr
    // noise (the grep-on-missing-file case below), not just on the stdout
    // lines the pre-existing tests already check.
    `set -u\ncd "${dir}"\n${extractAlertFn()}\nalert "reconciler self-test message" 2>&1\necho "HARNESS_EXIT:$?"\n`,
  )
  chmodSync(harnessPath, 0o755)

  try {
    const output = execFileSync("bash", [harnessPath], {
      env: { ...process.env, FAKE_CURL_SCRIPT: curlScript, PATH: `${CURL_BIN}:${process.env.PATH}` },
      encoding: "utf8",
    })
    return { output, exitCode: 0 }
  } catch (e: any) {
    return { output: (e.stdout ?? "") + (e.stderr ?? ""), exitCode: e.status ?? 1 }
  }
}

describe.skipIf(PRIV.skip)("reconcile-cron.sh alert() — delivery is checked, not assumed", () => {
  it("stays silent on a genuine Telegram success (ok:true)", () => {
    const { output } = runAlert(`#!/usr/bin/env bash\nprintf '{"ok":true,"result":{"message_id":1}}\\n200\\n'\n`)
    expect(output).not.toContain("ALERT DELIVERY FAILED")
  })

  // THE input that the old `> /dev/null || true` implementation could not
  // distinguish from success: curl exits 0, HTTP 401, body carries ok:false.
  // Against the OLD code this assertion FAILS (nothing is ever logged).
  it("logs a distinctive line on HTTP 401 (revoked token) — curl itself exits 0 here", () => {
    const { output } = runAlert(
      `#!/usr/bin/env bash\nprintf '{"ok":false,"error_code":401,"description":"Unauthorized"}\\n401\\n'\n`,
    )
    expect(output).toContain("ALERT DELIVERY FAILED")
    expect(output).toContain("401")
    expect(output).toContain("Unauthorized")
  })

  it("logs on HTTP 400 (wrong chat_id)", () => {
    const { output } = runAlert(
      `#!/usr/bin/env bash\nprintf '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}\\n400\\n'\n`,
    )
    expect(output).toContain("ALERT DELIVERY FAILED")
    expect(output).toContain("400")
  })

  it("logs on HTTP 403 (bot blocked by the user)", () => {
    const { output } = runAlert(
      `#!/usr/bin/env bash\nprintf '{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}\\n403\\n'\n`,
    )
    expect(output).toContain("ALERT DELIVERY FAILED")
    expect(output).toContain("403")
  })

  // The OTHER half of the old bug: `|| true` swallowed even a hard
  // connection failure with NOTHING printed. Mirrors real curl's observed
  // shape on a refused connection (verified locally: stderr text, then an
  // empty body line, then "000", exit 7).
  it("logs on a hard connection failure (no HTTP response at all)", () => {
    const { output } = runAlert(
      `#!/usr/bin/env bash\necho "curl: (7) Failed to connect to api.telegram.org port 443: Connection refused" 1>&2\nprintf '\\n000\\n'\nexit 7\n`,
    )
    expect(output).toContain("ALERT DELIVERY FAILED")
    expect(output).toContain("000")
  })

  // Ground rule: a lost page must never also lose the reconciler's run. This
  // is asserted for the WORST case (delivery genuinely failed) — the harness
  // itself would report a non-zero HARNESS_EXIT if `alert` propagated a
  // failure that aborted the calling shell.
  it("never aborts the caller even when delivery fails — the run must continue", () => {
    const { output, exitCode } = runAlert(
      `#!/usr/bin/env bash\nprintf '{"ok":false,"error_code":401,"description":"Unauthorized"}\\n401\\n'\n`,
    )
    expect(exitCode).toBe(0)
    expect(output).toContain("HARNESS_EXIT:0")
  })

  // Unchanged pre-existing contract: no creds configured → no-op, curl must
  // not even be invoked. If this regressed (e.g. curl called with empty
  // token/chat), the fake curl below would exit 1 and the harness would fail.
  it("is a no-op when KEEPER_ALERT_TG_TOKEN/CHAT are unset — curl is never invoked", () => {
    const { output, exitCode } = runAlert(
      `#!/usr/bin/env bash\necho "curl should never run when creds are unset" 1>&2\nexit 1\n`,
      "", // empty .env.local — no token/chat lines
    )
    expect(exitCode).toBe(0)
    expect(output).not.toContain("ALERT DELIVERY FAILED")
    expect(output).toContain("HARNESS_EXIT:0")
  })

  // 2026-09-30 audit finding: a genuinely MISSING .env.local (not merely
  // empty — the case above always writes the file) made both `grep` calls
  // print "grep: .env.local: No such file or directory" to stderr, on every
  // invocation, even though the outcome (no creds -> no-op) was already
  // correct. Against the pre-fix implementation this assertion FAILS: the
  // "No such file" text shows up in the captured (stdout+stderr) output.
  it("is silent AND still a no-op when .env.local does not exist at all", () => {
    const { output, exitCode } = runAlert(
      `#!/usr/bin/env bash\necho "curl should never run when creds are unset" 1>&2\nexit 1\n`,
      "ABSENT",
    )
    expect(exitCode).toBe(0)
    expect(output).not.toContain("No such file or directory")
    expect(output).not.toContain("ALERT DELIVERY FAILED")
    expect(output).toContain("HARNESS_EXIT:0")
  })
})
