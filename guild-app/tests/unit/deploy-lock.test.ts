/**
 * scripts/deploy.sh had no mutual exclusion against a second concurrent
 * `--apply` run (2026-09-30 audit finding, HIGH): two overlapping deploys
 * would both `npm ci`, both build into `.next-candidate`, and both eventually
 * call scripts/deploy-swap.sh against the same `.next`/`.next-previous` pair —
 * whose own undo logic (deploy-swap.sh, tested in deploy-kit-atomic.test.ts)
 * assumes it is the sole writer.
 *
 * scripts/deploy-lock.sh is the fix: an mkdir-atomic lock directory, acquired
 * by deploy.sh BEFORE `git pull --ff-only` (git's index.lock only serializes two
 * pulls, not a second deploy's pull landing under a first deploy's build), by
 * piping this checkout's copy of the script to the box (`bash -s`, so it works
 * before the box has the script), and released via `trap ... EXIT` on every exit
 * path. Two kinds of pin, in the shape of deploy-kit-atomic.test.ts:
 *   - source-text pins on deploy.sh: the acquire call exists, runs BEFORE the
 *     pull (and so before npm ci), a release trap is registered, and a HELD lock
 *     (exit 3) refuses the deploy rather than racing it;
 *   - a behavioral run of deploy-lock.sh itself against real temp directories,
 *     including THE NAMED DEFECT proven directly: two acquisitions racing the
 *     SAME lock dir at the same instant — exactly what "no lock against
 *     concurrent deploys" means — and only one may ever win.
 */
import { describe, it, expect, afterEach } from "vitest"
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, utimesSync } from "node:fs"
import { spawnSync, spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateInputs } from "../support/private-input"

const ROOT = join(process.cwd(), "..")
// scripts/deploy.sh and scripts/deploy-lock.sh both stay EXCLUDE at the
// open-source flip (publish/MANIFEST.md, scripts/** default-deny —
// deploy-lock.sh is not one of the four named carve-outs); every test in this
// file reads one or the other, so the whole file skips when either is absent.
const PRIV = privateInputs("scripts/deploy.sh", "scripts/deploy-lock.sh")
const DEPLOY = PRIV.skip ? "" : readFileSync(join(ROOT, "scripts", "deploy.sh"), "utf8")
const LOCK_SCRIPT = join(ROOT, "scripts", "deploy-lock.sh")

/** Executable lines only — the header prose may say anything. */
const execLines = (src: string) =>
  src
    .split("\n")
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => line.trim() !== "" && !line.trim().startsWith("#"))
const exec = execLines(DEPLOY)

describe.skipIf(PRIV.skip)("deploy.sh acquires the deploy lock before the pull, before anything that mutates the box", () => {
  it("calls deploy-lock.sh acquire exactly once, before `git pull` (and so before `npm ci`)", () => {
    // The APP checkout's pull, in either form: `git pull --ff-only` here, and after the flip
    // `git merge --ff-only --no-overwrite-ignore <target>` in guild-ops's deploy.sh (`git pull`
    // cannot take --no-overwrite-ignore; docs/design/post-flip-topology.md §5.1 step 4).
    // Anchored on `cd $REPO_DIR &&` so guild-ops's own `git -C $OPS_DIR pull` of the ops
    // checkout can never stand in for it.
    const pullAt = exec.findIndex(({ line }) => /cd \$REPO_DIR && git (pull|merge)( -q)? --ff-only/.test(line))
    const acquireAt = exec.findIndex(({ line }) => /bash -s -- acquire \$LOCK_DIR \$LOCK_TTL_SECONDS" < "\$LOCK_SCRIPT_LOCAL"/.test(line))
    const npmCiAt = exec.findIndex(({ line }) => /step "npm ci \(deps changed/.test(line))
    expect(pullAt, "the app checkout's pull (git pull/merge --ff-only) is present").toBeGreaterThan(-1)
    expect(acquireAt, "deploy-lock.sh acquire is present").toBeGreaterThan(-1)
    expect(npmCiAt, "the npm ci step is present").toBeGreaterThan(-1)
    expect(pullAt).toBeGreaterThan(acquireAt)
    expect(npmCiAt).toBeGreaterThan(pullAt)
    expect(exec.filter(({ line }) => /bash -s -- acquire/.test(line))).toHaveLength(1)
  })

  it("pipes this checkout's deploy-lock.sh to the box instead of running the box's copy", () => {
    // The box's copy only exists after the pull the lock must cover.
    expect(exec.some(({ line }) => /LOCK_SCRIPT_LOCAL=.*deploy-lock\.sh/.test(line))).toBe(true)
    expect(exec.some(({ line }) => /\$REPO_DIR\/scripts\/deploy-lock\.sh/.test(line))).toBe(false)
  })

  it("a HELD lock (exit 3) refuses the deploy — exits non-zero and never falls through to npm ci/the build", () => {
    const src = DEPLOY
    // The exit-3 branch of the case statement must itself `exit 1` (refuse),
    // not merely log — this is what makes it a real gate under `set -e`.
    const heldBranch = /3\)\s*\n(?:.*\n)*?\s*exit 1\s*\n\s*;;/.exec(src)
    expect(heldBranch, "the LOCK_RC=3 (HELD) branch exits 1").not.toBeNull()
    expect(src).toContain('REFUSED: another deploy is already running')
  })

  it("registers a release trap on EXIT once acquisition is attempted, so every exit path releases the lock", () => {
    expect(exec.some(({ line }) => line.includes("trap release_deploy_lock EXIT"))).toBe(true)
    // The release function itself must call `deploy-lock.sh release`, gated on
    // having actually acquired (never releasing a lock this run doesn't own).
    expect(src_contains(DEPLOY, "release_deploy_lock() {")).toBe(true)
    const fnBody = DEPLOY.slice(DEPLOY.indexOf("release_deploy_lock() {"))
    expect(fnBody).toMatch(/if \$DEPLOY_LOCK_ACQUIRED; then/)
    expect(fnBody).toMatch(/bash -s -- release \$LOCK_DIR" < "\$LOCK_SCRIPT_LOCAL"/)
  })

  it("every step refreshes a held lock first (heartbeat), so a slow live deploy is never reclaimed as stale", () => {
    // 2026-09-30 review of #830: the TTL measured from acquire alone let a long
    // npm ci + migrate + build outlive it and have its live lock reclaimed.
    const stepFn = DEPLOY.slice(DEPLOY.indexOf("step() {"), DEPLOY.indexOf("release_deploy_lock() {"))
    expect(stepFn).toMatch(/if \$DEPLOY_LOCK_ACQUIRED; then\s*\n\s*ssh "\$VPS" "touch -c \$LOCK_DIR 2>\/dev\/null; \$2"/)
    // …and only when this run holds it: a dry run or a pre-acquire step never touches the box's lock.
    expect(stepFn).toMatch(/else\s*\n\s*ssh "\$VPS" "\$2"/)
  })

  it("dry-run touches nothing — no ssh call for the lock unless --apply", () => {
    // The acquire ssh call must be inside an `if $APPLY; then` guard, matching
    // every other remote-mutating step in this script.
    const acquireIdx = exec.findIndex(({ line }) => /bash -s -- acquire \$LOCK_DIR \$LOCK_TTL_SECONDS" < "\$LOCK_SCRIPT_LOCAL"/.test(line))
    const guardIdx = exec.slice(0, acquireIdx).map(({ line }) => line).lastIndexOf("if $APPLY; then")
    expect(guardIdx).toBeGreaterThan(-1)
  })
})

function src_contains(src: string, needle: string) {
  return src.includes(needle)
}

describe.skipIf(PRIV.skip)("deploy-lock.sh against real directories", () => {
  const tmp: string[] = []
  afterEach(() => {
    for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function lockDir() {
    const root = mkdtempSync(join(tmpdir(), "deploy-lock-"))
    tmp.push(root)
    return join(root, ".deploy.lock")
  }

  const acquire = (dir: string, ttl = 1800) => spawnSync("bash", [LOCK_SCRIPT, "acquire", dir, String(ttl)], { encoding: "utf8" })
  const release = (dir: string) => spawnSync("bash", [LOCK_SCRIPT, "release", dir], { encoding: "utf8" })

  it("the step heartbeat (`touch -c`) resets the age this script measures: an old-but-touched lock is HELD, not reclaimed", () => {
    const dir = lockDir()
    expect(acquire(dir).status).toBe(0)
    const old = new Date(Date.now() - 3600_000)
    utimesSync(dir, old, old) // an hour old: past the 1800 s TTL
    expect(spawnSync("bash", ["-c", 'touch -c "$1"', "_", dir]).status).toBe(0)
    const r = acquire(dir)
    expect(r.status, "a heartbeat-refreshed lock must be HELD, not reclaimed").toBe(3)
    expect(r.stdout).toMatch(/^HELD \d+/)
  })

  it("`touch -c` on a released lock creates nothing (a heartbeat after release can never resurrect it)", () => {
    const dir = lockDir()
    expect(spawnSync("bash", ["-c", 'touch -c "$1"', "_", dir]).status).toBe(0)
    expect(existsSync(dir)).toBe(false)
  })

  it("a fresh acquire succeeds and leaves the lock directory with an acquired-at stamp", () => {
    const dir = lockDir()
    const r = acquire(dir)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe("ACQUIRED")
    expect(existsSync(dir)).toBe(true)
    expect(readdirSync(dir)).toContain("acquired-at")
  })

  it("THE NAMED DEFECT, proven directly — two acquisitions racing the SAME lock dir at the same instant: exactly one wins", async () => {
    // This is the actual concurrency the finding describes: two `--apply`
    // runs reaching the lock at once. mkdir is the primitive under test — if
    // it were ever replaced with a check-then-create (not atomic), both
    // processes could observe "absent" and both proceed, which is the exact
    // defect this lock exists to close.
    const dir = lockDir()
    const results = await Promise.all(
      [0, 1].map(
        (i) =>
          new Promise<{ code: number | null; out: string }>((resolve) => {
            const p = spawn("bash", [LOCK_SCRIPT, "acquire", dir, "1800"])
            let out = ""
            p.stdout.on("data", (d) => (out += d.toString()))
            p.on("close", (code) => resolve({ code, out: out.trim() })),
              void i
          }),
      ),
    )
    const acquired = results.filter((r) => r.code === 0 && r.out === "ACQUIRED")
    const held = results.filter((r) => r.code === 3 && r.out.startsWith("HELD"))
    expect(acquired, JSON.stringify(results)).toHaveLength(1)
    expect(held, JSON.stringify(results)).toHaveLength(1)
  })

  it("a second acquire while the lock is fresh is refused (exit 3, HELD) without touching the directory's contents", () => {
    const dir = lockDir()
    expect(acquire(dir).status).toBe(0)
    const before = readdirSync(dir).sort()
    const r2 = acquire(dir, 1800)
    expect(r2.status).toBe(3)
    expect(r2.stdout.trim()).toMatch(/^HELD \d+$/)
    expect(readdirSync(dir).sort()).toEqual(before)
  })

  it("a lock older than its TTL is cleared and re-acquired (self-healing — no operator action)", () => {
    // Deterministic rather than a real sleep: back-date the LOCK DIRECTORY'S
    // OWN mtime the way a genuinely abandoned lock (crashed deploy, dropped
    // SSH session) would read hours later, so this doesn't depend on
    // wall-clock granularity. Staleness is decided from the directory's mtime
    // (set atomically by the `mkdir` that created it), not from the
    // `acquired-at` file's content — that file is informational only (see
    // deploy-lock.sh's header, "2026-09-30 review finding"), and overwriting
    // just its content, as an earlier version of this test did, does NOT
    // change the parent directory's mtime, so it no longer moves the age this
    // script actually computes.
    const dir = lockDir()
    expect(acquire(dir, 1800).status).toBe(0)
    const staleTime = Math.floor(Date.now() / 1000) - 10_000
    utimesSync(dir, staleTime, staleTime)
    const r2 = acquire(dir, /* ttl */ 1800)
    expect(r2.status, r2.stderr).toBe(0)
    expect(r2.stdout.trim()).toMatch(/^ACQUIRED-AFTER-STALE \d+$/)
    const age = Number(r2.stdout.trim().split(" ")[1])
    expect(age).toBeGreaterThan(1800)
  })

  it("a lock well inside its TTL is NOT treated as stale — only age > ttl reclaims it", () => {
    const dir = lockDir()
    expect(acquire(dir, 1800).status).toBe(0)
    const freshTime = Math.floor(Date.now() / 1000) - 50
    utimesSync(dir, freshTime, freshTime)
    const r2 = acquire(dir, /* ttl */ 1800)
    expect(r2.status).toBe(3)
    expect(r2.stdout.trim()).toMatch(/^HELD \d+$/)
  })

  it("TOCTOU regression (2026-09-30 review finding) — age is read from the lock directory's own mtime, not a file written a moment after mkdir, so a second acquire landing in a widened window between them is still refused rather than stealing the lock", async () => {
    // Reproduces the finding directly rather than trusting the fix by
    // inspection: copy deploy-lock.sh into scratch with a deliberate 0.5s
    // sleep inserted between the winning `mkdir` and the (informational-only)
    // `echo > acquired-at` — the real gap is sub-millisecond, this widens it
    // to something a test can hit reliably without flaking. Against the
    // pre-fix script (age read from `acquired-at`'s *content*), the second
    // process's read during that window sees no such file yet, defaults
    // `held_at=0`, computes an enormous fake age, deems the just-created lock
    // stale, `rm -rf`s it out from under the first process, and reports its
    // own "ACQUIRED-AFTER-STALE" — both processes then exit 0, mutual
    // exclusion broken (reproduced by hand against the pre-fix script while
    // fixing this: exactly that outcome). The fix reads the directory's own
    // mtime instead, which `mkdir` sets atomically as part of directory
    // creation, so there is no window where it reads as "missing".
    const src = readFileSync(LOCK_SCRIPT, "utf8")
    const anchor =
      'if mkdir "$lock_dir" 2>/dev/null; then\n      echo "$now" > "$lock_dir/acquired-at" 2>/dev/null || true\n      echo "ACQUIRED"\n      exit 0\n    fi\n\n    held_at='
    expect(src, "the winning-mkdir branch's exact text moved — update this test's anchor to match deploy-lock.sh").toContain(anchor)
    const widened = src.replace(
      anchor,
      'if mkdir "$lock_dir" 2>/dev/null; then\n      sleep 0.5\n      echo "$now" > "$lock_dir/acquired-at" 2>/dev/null || true\n      echo "ACQUIRED"\n      exit 0\n    fi\n\n    held_at=',
    )

    const root = mkdtempSync(join(tmpdir(), "deploy-lock-toctou-"))
    tmp.push(root)
    const widenedScript = join(root, "deploy-lock-widened.sh")
    writeFileSync(widenedScript, widened)
    const dir = join(root, ".deploy.lock")

    const run = (delayMs: number) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        setTimeout(() => {
          const p = spawn("bash", [widenedScript, "acquire", dir, "100"])
          let out = ""
          p.stdout.on("data", (d) => (out += d.toString()))
          p.on("close", (code) => resolve({ code, out: out.trim() }))
        }, delayMs)
      })

    // 100ms apart: the first process is still asleep (wakes at 500ms) when
    // the second reaches its own acquire attempt — exactly the window the
    // finding describes.
    const [first, second] = await Promise.all([run(0), run(100)])
    const winners = [first, second].filter((r) => r.code === 0)
    const refused = [first, second].filter((r) => r.code === 3)
    expect(winners, JSON.stringify({ first, second })).toHaveLength(1)
    expect(refused, JSON.stringify({ first, second })).toHaveLength(1)
    expect(refused[0]?.out).toMatch(/^HELD \d+$/)
  }, 10_000)

  it("release removes the lock unconditionally, including when nothing is there (never fails the deploy it's cleaning up after)", () => {
    const dir = lockDir()
    acquire(dir)
    expect(release(dir).status).toBe(0)
    expect(existsSync(dir)).toBe(false)
    // Releasing again (already gone) must still succeed — mirrors a deploy
    // whose lock already self-healed away before this run's own release fires.
    const r2 = release(dir)
    expect(r2.status).toBe(0)
  })

  it("release unblocks a subsequent acquire", () => {
    const dir = lockDir()
    acquire(dir)
    release(dir)
    const r = acquire(dir)
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe("ACQUIRED")
  })

  it("bad usage exits 2, not 0 or 3 — never confused with a real HELD refusal", () => {
    const dir = lockDir()
    const r1 = spawnSync("bash", [LOCK_SCRIPT, "acquire", dir], { encoding: "utf8" })
    expect(r1.status).toBe(2)
    const r2 = spawnSync("bash", [LOCK_SCRIPT, "bogus", dir], { encoding: "utf8" })
    expect(r2.status).toBe(2)
  })
})
