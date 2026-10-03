/**
 * scripts/deploy.sh serves the agent kit (docs/design/bring-your-agent.md §2.4):
 * it packs packages/agent-client through scripts/pack-kit.sh into a CANDIDATE
 * directory, bakes that tarball's sha256 into the app build, and swaps the kit
 * and the app build into place through scripts/deploy-swap.sh — ONE remote
 * command that restarts pm2 and undoes itself on failure.
 *
 * Two kinds of pin, in the shape of launch-check-dist-dir.test.ts:
 *   - source-text pins on deploy.sh (pack before build, the swap goes through
 *     the swap script, the served kit is hashed in the live verify), and on
 *     deploy-swap.sh's ORDER — kit, then .next, then pm2 — which its own header
 *     calls load-bearing (agent-pr-review on #801: the first cut pinned the three
 *     substrings on one line but not their order);
 *   - a behavioural run of deploy-swap.sh against temp directories with a stub
 *     pm2: the happy path, a first deploy with no previous kit or build, and a
 *     pm2 that fails — after which the kit and the build must BOTH be back where
 *     they were, and the script must exit non-zero (the finding this exists for:
 *     a mid-swap failure used to abort deploy.sh before any rollback ran).
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest"
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateInputs } from "../support/private-input"

// 2026-09-30 audit finding (MEDIUM, flaky-under-load, confirmed not a
// regression): the "deploy-swap.sh against real directories" suite below runs
// the REAL script as a real bash subprocess per test, against a stub pm2 and,
// in five tests, a `mv`-shadowing stub on PATH — real fork/exec, not an
// in-process fake. Isolated, every test finishes in well
// under a second (`npx vitest run tests/unit/deploy-kit-atomic.test.ts`: 23/23
// passed in 8.79s). Under the FULL unit suite (`npx vitest run tests/unit
// tests/agent`), vitest's pool runs many other subprocess-heavy files (the
// reconcile-cron-*.test.ts suite alone forks bash + curl per test) in parallel
// across the same CPU, and fork/exec latency is exactly what that contention
// stretches — one run here hit vitest's 5000ms default and failed with
// nothing wrong in the script or the test, only a slow fork on a loaded
// machine (re-run alone: clean). Trimming subprocess count would mean testing
// less of the REAL script, so the fix is the explicit margin below rather
// than the default — sized well above the ~1s these tests take even
// individually, so a genuine hang still reddens this file, just later.
// Most of that cost turned out to be the stubs, not the fork: each was a
// freshly written executable minted per test, and those pay a serialised
// first-exec scan on macOS. They are now minted once per file (the stub
// comment in that describe block has the measurement); this margin stays
// as the backstop for plain CPU contention.
vi.setConfig({ testTimeout: 20_000 })

const ROOT = join(process.cwd(), "..")
// scripts/deploy.sh stays EXCLUDE at the open-source flip (publish/MANIFEST.md);
// only the describe/it blocks below that pin its text skip when it is absent.
const PRIV = privateInputs("scripts/deploy.sh")
const DEPLOY = PRIV.skip ? "" : readFileSync(join(ROOT, "scripts", "deploy.sh"), "utf8")
const SWAP = join(ROOT, "scripts", "deploy-swap.sh")
const SWAP_SRC = readFileSync(SWAP, "utf8")

/** Executable lines only — the header prose may say anything. */
const execLines = (src: string) =>
  src
    .split("\n")
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => line.trim() !== "" && !line.trim().startsWith("#"))
const exec = execLines(DEPLOY)
const swapExec = execLines(SWAP_SRC)

describe.skipIf(PRIV.skip)("deploy.sh packs the kit through the one pack script", () => {
  it("packs with scripts/pack-kit.sh into the kit candidate, never a hand-rolled npm pack", () => {
    expect(exec.some(({ line }) => /pack-kit\.sh --pkg packages\/agent-client --name agent --out \$KIT_CANDIDATE/.test(line))).toBe(true)
    expect(exec.filter(({ line }) => /\bnpm pack\b/.test(line))).toEqual([])
  })

  it("packs the MCP kit too (P1), after the agent kit whose build it bundles, and both before the app build", () => {
    const agentAt = exec.findIndex(({ line }) => line.includes("pack-kit.sh --pkg packages/agent-client --name agent"))
    const mcpAt = exec.findIndex(({ line }) => line.includes("pack-kit.sh --pkg packages/agent-mcp --name mcp --out $KIT_CANDIDATE"))
    const buildAt = exec.findIndex(({ line }) => line.includes("npm run build"))
    expect(agentAt).toBeGreaterThan(-1)
    expect(mcpAt).toBeGreaterThan(agentAt)
    expect(buildAt).toBeGreaterThan(mcpAt)
    // The watcher's default kit list must name exactly what the deploy packs.
    const names = exec
      .map(({ line }) => /pack-kit\.sh --pkg \S+ --name ([a-z0-9-]+)/.exec(line)?.[1])
      .filter((n): n is string => Boolean(n))
    expect(names).toEqual(["agent", "mcp"])
    // …and the version guard judges the same two (kit-version-guard.test.ts pins its position).
    expect(exec.some(({ line }) => /kit-version-guard\.mjs .* --kit agent --kit mcp/.test(line))).toBe(true)
  })

  it("packs BEFORE the app build, and the build gets the candidate's hash as NEXT_PUBLIC_KIT_SHA256", () => {
    const packAt = exec.findIndex(({ line }) => line.includes("pack-kit.sh --pkg packages/agent-client"))
    const buildAt = exec.findIndex(({ line }) => line.includes("npm run build"))
    expect(packAt).toBeGreaterThan(-1)
    expect(buildAt).toBeGreaterThan(packAt)
    const build = exec[buildAt].line
    expect(build).toMatch(/NEXT_PUBLIC_KIT_SHA256=/)
    expect(build).toMatch(/\$KIT_CANDIDATE\/agent\.tgz\.sha256/)
  })
})

describe("the swap is one remote command — scripts/deploy-swap.sh — and its order is pinned", () => {
  it.skipIf(PRIV.skip)("deploy.sh's swap step runs deploy-swap.sh with the kit and build paths, and no inline mv chain remains", () => {
    const swapStep = exec.filter(({ line }) => line.includes("bash $REPO_DIR/scripts/deploy-swap.sh"))
    expect(swapStep).toHaveLength(1)
    expect(swapStep[0].line).toMatch(/\$KIT_CANDIDATE \$KIT_DIR \$KIT_PREVIOUS \$PM2_APP/)
    // The old one-line chain must not come back beside it.
    expect(exec.some(({ line }) => /mv \$KIT_CANDIDATE \$KIT_DIR/.test(line))).toBe(false)
  })

  it("deploy-swap.sh moves the kit, THEN the build, THEN restarts pm2 — in that order", () => {
    const at = (re: RegExp) => swapExec.findIndex(({ line }) => re.test(line))
    const kitOut = at(/mv "\$KIT_DIR" "\$KIT_PREVIOUS"/)
    const kitIn = at(/^mv "\$KIT_CANDIDATE" "\$KIT_DIR"$/)
    const nextOut = at(/mv \.next "\$PREVIOUS"/)
    const nextIn = at(/^mv "\$CANDIDATE" \.next$/)
    const restart = at(/^"\$PM2" restart "\$PM2_APP" --update-env$/)
    for (const [name, i] of Object.entries({ kitOut, kitIn, nextOut, nextIn, restart })) {
      expect(i, `${name} is present as a top-level statement`).toBeGreaterThan(-1)
    }
    expect(kitOut).toBeLessThan(kitIn)
    expect(kitIn).toBeLessThan(nextOut)
    expect(nextOut).toBeLessThan(nextIn)
    expect(nextIn).toBeLessThan(restart)
  })

  it("the ERR trap undoes in reverse and exits with the failing status", () => {
    expect(SWAP_SRC).toContain("trap undo ERR")
    expect(SWAP_SRC).toMatch(/set -euo pipefail/)
    expect(SWAP_SRC).toMatch(/exit "\$rc"/)
  })
})

describe("deploy-swap.sh against real directories", () => {
  const tmp: string[] = []
  afterEach(() => {
    for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  /** A box: app dir with .next (old) and .next-candidate (new); kit dirs beside it. */
  function box({ oldKit = true, oldBuild = true } = {}) {
    const root = mkdtempSync(join(tmpdir(), "deploy-swap-"))
    tmp.push(root)
    const app = join(root, "guild-app")
    mkdirSync(app)
    mkdirSync(join(app, ".next-candidate"))
    writeFileSync(join(app, ".next-candidate", "BUILD_ID"), "new")
    if (oldBuild) {
      mkdirSync(join(app, ".next"))
      writeFileSync(join(app, ".next", "BUILD_ID"), "old")
    }
    mkdirSync(join(root, "kit-candidate"))
    writeFileSync(join(root, "kit-candidate", "agent.tgz"), "new-kit")
    if (oldKit) {
      mkdirSync(join(root, "kit"))
      writeFileSync(join(root, "kit", "agent.tgz"), "old-kit")
    }
    return { root, app }
  }

  /*
   * The two stubs — pm2 and a PATH-shadowing mv — are minted ONCE per file and
   * take their per-test behaviour from the environment: the fix
   * workflow-runners.test.ts made for its `gh` stub, for the reason it
   * documents. A freshly written EXECUTABLE pays a one-off first-exec scan on
   * macOS — re-measured 2026-09-30 on this Mac: ~310ms on first exec against
   * ~7ms re-running the same file, while `bash <fresh file>` never pays it (the
   * file is read, not exec'd). And the scan is SERIALISED machine-wide: 33 fresh
   * stubs took 11.8s of wall clock whether exec'd 1, 4 or 11 at a time (per-exec
   * median 0.3s → 1.3s → 4.0s), so each per-test stub queued behind every fresh
   * stub any other vitest worker — or any other session's suite — was exec'ing.
   * Minted per test, this file wrote 15 pm2 stubs and 5 mv stubs: under the
   * full unit suite it failed 3, 2 and 0 tests on the 5000ms default across
   * three runs, and 6 in a fourth under peer sessions' load, with single tests
   * at 18.8s. Now it is 2 scans, paid in beforeAll under the 60s hookTimeout
   * (vitest.config.ts). Per-test mv behaviour is a plain file the stub hands
   * to `bash`, so it never pays a scan.
   */
  const STUBS = mkdtempSync(join(tmpdir(), "deploy-swap-stubs-"))
  /**
   * The pm2 stub logs its argv to $PM2_STUB_DIR/pm2.log and fails the first
   * $PM2_STUB_FAIL_CALLS invocations (0 = never fails). `set -u`: a missing
   * hand-off fails the stub loudly instead of logging nowhere.
   */
  const PM2_STUB = join(STUBS, "pm2-stub")
  writeFileSync(
    PM2_STUB,
    `#!/bin/bash\nset -u\nn=$(cat "$PM2_STUB_DIR/pm2.count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$PM2_STUB_DIR/pm2.count"\necho "$@" >> "$PM2_STUB_DIR/pm2.log"\n[ "$n" -le "$PM2_STUB_FAIL_CALLS" ] && exit 1\nexit 0\n`,
  )
  chmodSync(PM2_STUB, 0o755)
  /** First on PATH only in the tests that pass mvEnv(); runs the test's $MV_STUB_SCRIPT with mv's argv. */
  const MV_BIN = join(STUBS, "bin")
  mkdirSync(MV_BIN)
  writeFileSync(join(MV_BIN, "mv"), `#!/bin/bash\nexec bash "\${MV_STUB_SCRIPT:?}" "$@"\n`)
  chmodSync(join(MV_BIN, "mv"), 0o755)

  beforeAll(() => {
    const warm = join(STUBS, "warm-up")
    mkdirSync(warm)
    spawnSync(PM2_STUB, [], { env: { ...process.env, PM2_STUB_DIR: warm, PM2_STUB_FAIL_CALLS: "0" } })
    writeFileSync(join(warm, "a"), "")
    writeFileSync(join(warm, "mv-behaviour"), `exec /bin/mv "$@"\n`)
    spawnSync(join(MV_BIN, "mv"), [join(warm, "a"), join(warm, "b")], {
      env: { ...process.env, MV_STUB_SCRIPT: join(warm, "mv-behaviour") },
    })
  })
  afterAll(() => rmSync(STUBS, { recursive: true, force: true }))

  /** Env for the pm2 stub: log into `root`, fail the first `failCalls` calls. */
  const pm2Env = (root: string, failCalls: number) => ({
    PM2_BIN: PM2_STUB,
    PM2_STUB_DIR: root,
    PM2_STUB_FAIL_CALLS: String(failCalls),
  })

  /** Env that shadows mv with `behaviour` — bash run with mv's argv, written into `root`. */
  function mvEnv(root: string, behaviour: string) {
    const script = join(root, "mv-behaviour")
    writeFileSync(script, behaviour)
    return { MV_STUB_SCRIPT: script, PATH: `${MV_BIN}:${process.env.PATH}` }
  }

  /**
   * Positive control for a `pm2.log` absence assertion: the same env the swap
   * got DOES reach the stub's log in `root`. Without it, a broken PM2_STUB_DIR
   * hand-off would pass every "pm2 never called" assertion for the wrong reason.
   */
  function expectPm2StubLive(root: string, env: NodeJS.ProcessEnv) {
    spawnSync(PM2_STUB, ["positive-control"], { env: { ...process.env, ...env } })
    expect(readFileSync(join(root, "pm2.log"), "utf8")).toBe("positive-control\n")
  }

  const run = (root: string, app: string, env: NodeJS.ProcessEnv) =>
    spawnSync("bash", [SWAP, app, ".next-candidate", ".next-previous", join(root, "kit-candidate"), join(root, "kit"), join(root, "kit-previous"), "guild-saas-app"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    })

  const read = (p: string) => readFileSync(p, "utf8")

  it("happy path: kit and build swapped, previous kept, pm2 restarted once, exit 0", () => {
    const { root, app } = box()
    const r = run(root, app, pm2Env(root, 0))
    expect(r.status, r.stderr).toBe(0)
    expect(read(join(root, "kit", "agent.tgz"))).toBe("new-kit")
    expect(read(join(root, "kit-previous", "agent.tgz"))).toBe("old-kit")
    expect(existsSync(join(root, "kit-candidate"))).toBe(false)
    expect(read(join(app, ".next", "BUILD_ID"))).toBe("new")
    expect(read(join(app, ".next-previous", "BUILD_ID"))).toBe("old")
    expect(existsSync(join(app, ".next-candidate"))).toBe(false)
    expect(read(join(root, "pm2.log"))).toBe("restart guild-saas-app --update-env\n")
  })

  it("first deploy: no previous kit and no previous build is not an error", () => {
    const { root, app } = box({ oldKit: false, oldBuild: false })
    const r = run(root, app, pm2Env(root, 0))
    expect(r.status, r.stderr).toBe(0)
    expect(read(join(root, "kit", "agent.tgz"))).toBe("new-kit")
    expect(existsSync(join(root, "kit-previous"))).toBe(false)
    expect(read(join(app, ".next", "BUILD_ID"))).toBe("new")
    expect(existsSync(join(app, ".next-previous"))).toBe(false)
  })

  it("THE NAMED DEFECT — pm2 fails after both swaps: kit AND build are put back together, exit non-zero", () => {
    const { root, app } = box()
    const r = run(root, app, pm2Env(root, 1))
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/FAILED at stage 5/)
    expect(r.stderr).toMatch(/undo complete — on disk now: the PREVIOUS build in \.next; the PREVIOUS kit in /)
    expect(r.stderr).toMatch(/candidates left in place to inspect \(\.next-candidate, .*kit-candidate\)/)
    expect(r.stderr).not.toMatch(/NOT FULLY RESTORED/)
    // Back to before: old kit served, candidate kit back where deploy.sh left it.
    expect(read(join(root, "kit", "agent.tgz"))).toBe("old-kit")
    expect(read(join(root, "kit-candidate", "agent.tgz"))).toBe("new-kit")
    expect(existsSync(join(root, "kit-previous"))).toBe(false)
    // Old build serving, candidate back to inspect.
    expect(read(join(app, ".next", "BUILD_ID"))).toBe("old")
    expect(read(join(app, ".next-candidate", "BUILD_ID"))).toBe("new")
    expect(existsSync(join(app, ".next-previous"))).toBe(false)
    // pm2 was asked twice: the failed restart, then the restart onto the restored build.
    expect(read(join(root, "pm2.log")).trim().split("\n")).toHaveLength(2)
  })

  it("pm2 fails BOTH times: files restored, and the line says the restart failed — never 'undo complete'", () => {
    const { root, app } = box()
    const r = run(root, app, pm2Env(root, 99))
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/files restored — on disk now: the PREVIOUS build in \.next; the PREVIOUS kit in .* but the pm2 restart FAILED TWICE/)
    expect(r.stderr).toMatch(/consistent, but unverified/)
    expect(r.stderr).not.toMatch(/undo complete/)
    expect(r.stderr).not.toMatch(/NOT FULLY RESTORED/)
    expect(read(join(app, ".next", "BUILD_ID"))).toBe("old")
    expect(read(join(root, "kit", "agent.tgz"))).toBe("old-kit")
  })

  it("from-scratch box + pm2 fails after the swap: the candidates STAY (nothing to go back to), restart retried, exit non-zero, and it says so", () => {
    const { root, app } = box({ oldKit: false, oldBuild: false })
    const r = run(root, app, pm2Env(root, 1))
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/no previous build existed on this box — the candidate build and kit STAY in place/)
    expect(r.stderr).toMatch(/on disk now: the CANDIDATE build in \.next \(kept — no previous build existed\); the CANDIDATE kit in /)
    expect(r.stderr).toMatch(/the candidate directories are gone — their contents are what is serving/)
    expect(r.stderr).not.toMatch(/left in place/)
    expect(r.stderr).not.toMatch(/PREVIOUS/)
    // A box with no .next serves nothing; the candidate (gate-passed) is the only build there is.
    expect(read(join(app, ".next", "BUILD_ID"))).toBe("new")
    expect(existsSync(join(app, ".next-candidate"))).toBe(false)
    expect(read(join(root, "kit", "agent.tgz"))).toBe("new-kit")
    expect(existsSync(join(root, "kit-candidate"))).toBe(false)
    expect(read(join(root, "pm2.log")).trim().split("\n")).toHaveLength(2)
  })

  it("a restore that itself fails is reported as NOT restored with the layout — never as 'undo complete'", () => {
    // The round-2 review's case: the undo's own `mv .next-previous .next` fails. A
    // PATH-shadowing mv fails exactly that move and delegates everything else.
    const { root, app } = box()
    const r = run(root, app, {
      ...pm2Env(root, 1),
      ...mvEnv(root, `if [ "$1" = ".next-previous" ]; then echo "mv: simulated failure restoring $1" >&2; exit 1; fi\nexec /bin/mv "$@"\n`),
    })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/could not restore \.next-previous → \.next/)
    expect(r.stderr).toMatch(/STATE NOT FULLY RESTORED — 1 restore step\(s\) failed/)
    expect(r.stderr).toMatch(/MISSING {2}\.next$/m)
    expect(r.stderr).toMatch(/present {2}\.next-previous/)
    expect(r.stderr).toMatch(/present {2}\.next-candidate/)
    expect(r.stderr).not.toMatch(/undo complete/)
    // What the layout line says is what is on disk: no .next, previous and candidate both present, kit restored.
    expect(existsSync(join(app, ".next"))).toBe(false)
    expect(read(join(app, ".next-previous", "BUILD_ID"))).toBe("old")
    expect(read(join(app, ".next-candidate", "BUILD_ID"))).toBe("new")
    expect(read(join(root, "kit", "agent.tgz"))).toBe("old-kit")
  })

  it("THE ROUND-7 DEFECT — the KIT restore fails: a recorded restore failure, never 'internal inconsistency … this script has a bug'", () => {
    // pm2 fails once at stage 5; the undo's `mv kit → kit-candidate` fails (PATH-shadowed),
    // so kit stays put and the next restore (kit-previous → kit) is refused as "already
    // exists": 2 recorded failures. The candidate dirs now differ (.next-candidate is back,
    // kit-candidate is not) — which the ungated check read as a bug in this script.
    const { root, app } = box()
    const r = run(root, app, {
      ...pm2Env(root, 1),
      ...mvEnv(
        root,
        `if [ "$1" = "${join(root, "kit")}" ] && [ "$2" = "${join(root, "kit-candidate")}" ]; then echo "mv: simulated failure restoring $1" >&2; exit 1; fi\nexec /bin/mv "$@"\n`,
      ),
    })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/could not restore .*\/kit → .*\/kit-candidate/)
    expect(r.stderr).toMatch(/cannot restore .*\/kit-previous → .*\/kit: .* already exists/)
    expect(r.stderr).toMatch(/STATE NOT FULLY RESTORED — 2 restore step\(s\) failed/)
    // The mixed candidate state here IS the recorded failure — not a bug in the script.
    expect(r.stderr).not.toMatch(/internal inconsistency/)
    expect(r.stderr).not.toMatch(/this script has a bug/)
    expect(r.stderr).not.toMatch(/undo complete|files restored/)
    expect(r.stderr).toMatch(/present {2}\.next$/m)
    expect(r.stderr).toMatch(/present {2}\.next-candidate/)
    expect(r.stderr).toMatch(/MISSING {2}.*\/kit-candidate/)
    expect(r.stderr).toMatch(/present {2}.*\/kit-previous/)
    // On disk: build restored; the NEW kit still sits in kit/, the old one in kit-previous/.
    expect(read(join(app, ".next", "BUILD_ID"))).toBe("old")
    expect(read(join(root, "kit", "agent.tgz"))).toBe("new-kit")
    expect(read(join(root, "kit-previous", "agent.tgz"))).toBe("old-kit")
    expect(existsSync(join(root, "kit-candidate"))).toBe(false)
  })

  it("a restore into a path that already exists is refused rather than nested", () => {
    // Force the nesting case: make the forward `.next-candidate → .next` succeed, pm2
    // fail, and have `.next-candidate` re-appear before the undo moves .next back.
    // The PATH mv recreates the candidate dir after the forward move.
    const { root, app } = box()
    const r = run(root, app, {
      ...pm2Env(root, 1),
      ...mvEnv(root, `/bin/mv "$@" || exit $?\nif [ "$1" = ".next-candidate" ] && [ "$2" = ".next" ]; then mkdir .next-candidate; fi\n`),
    })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/cannot restore \.next → \.next-candidate: \.next-candidate already exists \(a plain mv would nest it\)/)
    expect(r.stderr).toMatch(/STATE NOT FULLY RESTORED/)
    // Not nested: the new build is still at .next (top level), not inside .next-candidate.
    expect(read(join(app, ".next", "BUILD_ID"))).toBe("new")
    expect(existsSync(join(app, ".next-candidate", ".next"))).toBe(false)
  })

  it("THE ROUND-3 DEFECT — existing build, FIRST kit deploy, pm2 fails once: the line says NO kit, never 'the previous kit'", () => {
    // The real box on its first kit deploy: a live .next, no /opt/guild-saas/kit yet.
    const { root, app } = box({ oldKit: false, oldBuild: true })
    const r = run(root, app, pm2Env(root, 1))
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/undo complete — on disk now: the PREVIOUS build in \.next; NO kit \(.*none existed before this deploy; \/kit\/\* answers 404 as it did\)/)
    expect(r.stderr).not.toMatch(/PREVIOUS kit/)
    expect(existsSync(join(root, "kit"))).toBe(false)
    expect(read(join(root, "kit-candidate", "agent.tgz"))).toBe("new-kit")
    expect(read(join(app, ".next", "BUILD_ID"))).toBe("old")
  })

  it("from-scratch box, the forward .next move itself fails (stage 3): nothing is claimed — NO build, NO kit, candidates back in place", () => {
    const { root, app } = box({ oldKit: false, oldBuild: false })
    const env = {
      ...pm2Env(root, 0),
      ...mvEnv(root, `if [ "$1" = ".next-candidate" ] && [ "$2" = ".next" ]; then echo "mv: simulated failure swapping in the build" >&2; exit 1; fi\nexec /bin/mv "$@"\n`),
    }
    const r = run(root, app, env)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/FAILED at stage 3/)
    expect(r.stderr).toMatch(/undo complete — on disk now: NO build \(\.next is absent: none existed before this deploy.*; NO kit \(/)
    expect(r.stderr).not.toMatch(/PREVIOUS/)
    expect(existsSync(join(app, ".next"))).toBe(false)
    expect(read(join(app, ".next-candidate", "BUILD_ID"))).toBe("new")
    expect(existsSync(join(root, "kit"))).toBe(false)
    expect(read(join(root, "kit-candidate", "agent.tgz"))).toBe("new-kit")
    expect(existsSync(join(root, "pm2.log"))).toBe(false)
    expectPm2StubLive(root, env)
  })

  it("existing build + kit, the forward KIT move fails (stage 1): previous kit restored, build never touched, pm2 never called", () => {
    const { root, app } = box()
    const env = {
      ...pm2Env(root, 0),
      ...mvEnv(root, `if [ "$1" = "${join(root, "kit-candidate")}" ] && [ "$2" = "${join(root, "kit")}" ]; then echo "mv: simulated failure swapping in the kit" >&2; exit 1; fi\nexec /bin/mv "$@"\n`),
    }
    const r = run(root, app, env)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/FAILED at stage 1/)
    expect(r.stderr).toMatch(/undo complete — on disk now: the PREVIOUS build in \.next; the PREVIOUS kit in /)
    expect(read(join(root, "kit", "agent.tgz"))).toBe("old-kit")
    expect(read(join(root, "kit-candidate", "agent.tgz"))).toBe("new-kit")
    expect(existsSync(join(root, "kit-previous"))).toBe(false)
    expect(read(join(app, ".next", "BUILD_ID"))).toBe("old")
    expect(existsSync(join(root, "pm2.log"))).toBe(false)
    expectPm2StubLive(root, env)
  })

  it("a stray FILE at .next (outside this script's control) is named as such — never 'absent'", () => {
    const { root, app } = box({ oldKit: false, oldBuild: false })
    writeFileSync(join(app, ".next"), "not a directory")
    const r = run(root, app, pm2Env(root, 0))
    expect(r.status).not.toBe(0)
    // had_prev_build reads 0 (not a dir), the forward move onto a file fails at stage 3.
    expect(r.stderr).toMatch(/FAILED at stage 3/)
    expect(r.stderr).toMatch(/something that is NOT a directory sits at \.next/)
    expect(r.stderr).not.toMatch(/\.next is absent/)
    expect(read(join(app, ".next"))).toBe("not a directory")
    expect(read(join(app, ".next-candidate", "BUILD_ID"))).toBe("new")
  })

  it("previous KIT but no previous build (not producible by this pipeline, still handled) + pm2 hiccup: candidates kept, and the line says a previous kit remains", () => {
    const { root, app } = box({ oldKit: true, oldBuild: false })
    const r = run(root, app, pm2Env(root, 1))
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/the CANDIDATE kit in .*kit \(kept with the candidate build\); a previous kit remains in .*kit-previous/)
    expect(r.stderr).toMatch(/the candidate directories are gone/)
    expect(read(join(root, "kit", "agent.tgz"))).toBe("new-kit")
    expect(read(join(root, "kit-previous", "agent.tgz"))).toBe("old-kit")
    expect(read(join(app, ".next", "BUILD_ID"))).toBe("new")
  })

  it("from-scratch box + pm2 fails BOTH times: 'files kept in place', never 'files restored'", () => {
    const { root, app } = box({ oldKit: false, oldBuild: false })
    const r = run(root, app, pm2Env(root, 99))
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/files kept in place \(nothing to restore to\) — on disk now: the CANDIDATE build in \.next/)
    expect(r.stderr).not.toMatch(/files restored/)
    expect(r.stderr).toMatch(/NOTHING may be serving until a restart succeeds/)
    expect(read(join(app, ".next", "BUILD_ID"))).toBe("new")
  })

  it("a missing build candidate stops before anything moves", () => {
    const { root, app } = box()
    rmSync(join(app, ".next-candidate"), { recursive: true })
    const env = pm2Env(root, 0)
    const r = run(root, app, env)
    expect(r.status).toBe(1)
    expect(read(join(root, "kit", "agent.tgz"))).toBe("old-kit")
    expect(existsSync(join(root, "kit-candidate"))).toBe(true)
    expect(existsSync(join(root, "pm2.log"))).toBe(false)
    expectPm2StubLive(root, env)
  })
})

describe.skipIf(PRIV.skip)("live verify covers the served kit", () => {
  it("fetches each served kit over the public domain and compares its sha256 to the candidate's", () => {
    expect(exec.some(({ line }) => /for kit in agent agent-v mcp mcp-v; do/.test(line))).toBe(true)
    expect(exec.some(({ line }) => /\$\{SITE\}\/kit\/\$kit\.tgz"/.test(line))).toBe(true)
    expect(exec.some(({ line }) => /shasum -a 256|sha256sum/.test(line))).toBe(true)
    expect(exec.some(({ line }) => line.includes("EXPECTED_KIT_SHA"))).toBe(true)
    expect(exec.some(({ line }) => line.includes("EXPECTED_MCP_SHA"))).toBe(true)
  })

  it("its failure lines name the surface hit per kit — only the agent kit is on /agents (agent-pr-review #803 round 5)", () => {
    const surfaces = Object.fromEntries(
      exec.flatMap(({ line }) => {
        const m = /^\s*(agent|agent-v|mcp|mcp-v)\) .*surface="([^"]+)"/.exec(line)
        return m ? [[m[1], m[2]]] : []
      }),
    )
    expect(surfaces).toEqual({
      agent: "the one-liner on /agents",
      "agent-v": "configs that pin /kit/$kit.tgz",
      mcp: "one-shot npx runs of /kit/mcp.tgz",
      "mcp-v": "configs that pin /kit/$kit.tgz",
    })
    const failureLines = exec.filter(({ line }) => /is not served|is not the candidate's/.test(line) && line.includes("$kit"))
    expect(failureLines.length).toBeGreaterThanOrEqual(2)
    for (const { line } of failureLines) {
      expect(line, line).toContain("$surface")
      expect(line, line).not.toMatch(/on \/agents/)
    }
  })
})
