/**
 * ops/backup/pull-backups-launchd.sh picks a failed pull's notification from what the run
 * FOUND, never from pull-backups.sh's footer.
 *
 * Every non-zero run of pull-backups.sh ends "RESULT: attention needed (see UNVERIFIED/FAILED
 * above)." and "… An UNVERIFIED pull is a file you have …". The wrapper's first branch grepped
 * the whole output for UNVERIFIED|FAILED|…, so it matched every failure, and its BOX
 * UNREACHABLE (#870) and stale-drill branches could never run: pull.log 2026-09-08 05:51 and
 * 2026-09-14 16:18, two runs whose only problem was a stale restore drill, were notified "Guild
 * backup pull FAILED: RESULT: attention needed (see UNVERIFIED/FAILED above).".
 * pull-backups-unreachable.test.ts checked only the ORDER of the branches in the wrapper's
 * source, which is how that went unseen.
 *
 * So this runs the REAL pull-backups.sh against a fixture box, and hands its real output and
 * exit code to the wrapper's REAL classifier: `--classify` calls the same function the launchd
 * run calls just before notify(). The fixture box is pull-backups-coverage.test.ts's: a fake
 * `ssh` first on PATH runs the script's remote commands locally with /opt/ mapped into a temp
 * dir, a fake `scp` copies from there, and fake `sqlite3` and `pg_restore` verify. The stubs are
 * minted once per file (a freshly written executable pays a serialised first-exec scan on
 * macOS) and take their per-test behaviour from the environment. No connection is ever opened,
 * and GUILD_VPS_SSH names a host that cannot resolve, so even a missing stub could not reach
 * the box.
 *
 * `--classify` returns before notify(), so osascript never runs. notify() appends to pull.log
 * before anything else, so every verdict below also checks that GUILD_BACKUP_DEST (a temp dir,
 * never ~/guild-backups) has no pull.log.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, utimesSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateInputs, REPO_ROOT } from "../support/private-input"

vi.setConfig({ testTimeout: 15_000 })

// ops/** stays private at the open-source flip (publish/MANIFEST.md).
const PRIV = privateInputs("ops/backup/pull-backups.sh", "ops/backup/pull-backups-launchd.sh")
const SCRIPT = join(REPO_ROOT, "ops/backup/pull-backups.sh")
const WRAPPER = join(REPO_ROOT, "ops/backup/pull-backups-launchd.sh")

/** A reserved name (RFC 2606) that never resolves, so a real ssh could not reach the box with it. */
const HOST = "fixture-box.invalid"

/** The footer that won the old classification. Its presence is the bug's precondition. */
const FOOTER = "RESULT: attention needed (see UNVERIFIED/FAILED above)."

/** label → the box dir and the snapshot name for one day, as the script's sources define them. */
const LEGS = {
  postgres: { dir: "/opt/guild-saas/backups", name: (d: string) => `guild_db_${d}.dump` },
  "bot-sqlite": { dir: "/opt/guild-saas/backups/bot", name: (d: string) => `guild_bot_${d}.db` },
  "meme-grid-sqlite": { dir: "/opt/fixture/meme-grid", name: (d: string) => `meme-grid-${d}.db` },
} as const
type Leg = keyof typeof LEGS
const LABELS = Object.keys(LEGS) as Leg[]
const DAYS = ["20260930", "20261001", "20261002"]
const NEWEST = DAYS[DAYS.length - 1]

/**
 * A postgres snapshot is a pg_dump header claiming archive version 1.99. pull-backups.sh tries
 * every pg_restore it can find, not just the fake, and every real one refuses this header with
 * the fake's own words, "unsupported version (1.99) in file header" (measured 2026-10-02 with
 * Homebrew's libpq 18.4 and postgresql@14 14.17). So the UNVERIFIED case reads the same on a Mac
 * with Homebrew as on CI. Every other case is verified by the fake before a real one is tried.
 */
function snapshot(label: Leg, name: string): Buffer {
  const header = label === "postgres" ? Buffer.from("PGDMP\x01\x63\x00\x04\x08\x01", "latin1") : Buffer.alloc(0)
  return Buffer.concat([header, Buffer.from(`snapshot ${name}\n`)])
}

const STUBS: Record<string, string> = {
  // ssh -n HOST CMD. FAKE_SSH_DROP (an ERE) fails the matching commands the way a dropped
  // network does; everything else runs under bash, as on the box, and keeps its exit status.
  ssh: [
    "#!/usr/bin/env bash",
    "set -o pipefail",
    '[ "$1" = "-n" ] && shift',
    "shift",
    'if [ -n "${FAKE_SSH_DROP:-}" ] && printf %s "$1" | grep -qE "$FAKE_SSH_DROP"; then',
    '  echo "ssh_dispatch_run_fatal: Connection to fixture-box.invalid port 22: Operation timed out" >&2',
    "  exit 255",
    "fi",
    'bash -c "$(printf %s "$1" | sed "s#/opt/#$FAKE_BOX/opt/#g")" | sed "s#$FAKE_BOX##g"',
  ].join("\n"),
  // scp -q HOST:PATH LOCAL. FAKE_SCP_DROP (an ERE on PATH) fails that copy with FAKE_SCP_EXIT:
  // by default 255, what scp exits when the connection goes (pull.log 2026-09-27 08:02).
  scp: [
    "#!/bin/sh",
    '[ "$1" = "-q" ] && shift',
    'if [ -n "${FAKE_SCP_DROP:-}" ] && printf %s "${1#*:}" | grep -qE "$FAKE_SCP_DROP"; then',
    '  if [ "${FAKE_SCP_EXIT:-255}" = 255 ]; then echo "scp: Connection closed" >&2',
    '  else echo "scp: ${1#*:}: No such file or directory" >&2; fi',
    '  exit "${FAKE_SCP_EXIT:-255}"',
    "fi",
    'cp "$FAKE_BOX${1#*:}" "$2"',
  ].join("\n"),
  // The box's sha256sum, for a Mac without one; same "hash  path" output.
  sha256sum: '#!/bin/sh\nexec shasum -a 256 "$@"',
  // pull-backups.sh verifies SQLite as: sqlite3 -readonly -safe file:FILE?immutable=1 SQL. The stub
  // reads the SQL (the LAST arg, past the flags and the URI) so it is immune to both, and answers:
  // integrity_check=ok; ONE table (the table count is 1, the listing is "snapshot", which passes
  // verify_sqlite's identifier allow-pattern); and every row count 1.
  sqlite3: [
    "#!/bin/sh",
    'for a in "$@"; do sql=$a; done',
    'case "$sql" in',
    "  *integrity_check*) echo ok ;;",
    "  *'count(*) FROM sqlite_master'*) echo 1 ;;",
    "  *sqlite_master*) echo snapshot ;;",
    "  *) echo 1 ;;",
    "esac",
  ].join("\n"),
  // FAKE_PG_REFUSE=1 refuses every dump the way a pg_restore older than the box's pg_dump does.
  pg_restore: [
    "#!/bin/sh",
    'case "$1" in',
    '  --version) echo "pg_restore (PostgreSQL) 17.6" ;;',
    "  --list)",
    '    if [ "${FAKE_PG_REFUSE:-}" = 1 ]; then',
    '      echo "pg_restore: error: unsupported version (1.99) in file header" >&2; exit 1',
    "    fi",
    '    echo "1; 0 0 TABLE DATA public snapshot fixture" ;;',
    "esac",
  ].join("\n"),
  // Fake osascript for the notify() path (5a). The wrapper calls
  // "${OSASCRIPT:-/usr/bin/osascript}"; a test points OSASCRIPT here. It records its argv
  // to $OSA_LOG and runs NOTHING — so even a reverted (interpolating) notify() cannot
  // execute AppleScript during the test, and the recording proves the program text is
  // constant and the hostile text is a bare operand.
  osascript: [
    "#!/bin/sh",
    'printf "CALL\\n" >> "$OSA_LOG"',
    'for a in "$@"; do printf "ARG:%s\\n" "$a" >> "$OSA_LOG"; done',
    "exit 0",
  ].join("\n"),
}

let BIN = ""
/** Every temp dir this file mints, removed in afterAll (the stubs dir and one per run). */
const TMP_DIRS: string[] = []

type Run = { status: number | null; out: string; dest: string }

/**
 * Run pull-backups.sh as the wrapper does (stderr into the same stream) against a box holding
 * DAYS on every leg (mtimes ascending, so `ls -t` reads the last as newest). `drill` sets the
 * age of LAST_DRILL_OK: yesterday, or 40 days, past the script's 30-day limit. `macHas` legs
 * are already in the Mac's dest, byte-identical.
 */
function run(opts: { drill: "fresh" | "stale"; macHas?: Leg[]; env?: Record<string, string> }): Run {
  const dir = mkdtempSync(join(tmpdir(), "pull-backups-classify-"))
  TMP_DIRS.push(dir)
  const box = join(dir, "box")
  const dest = join(dir, "dest")
  mkdirSync(dest)
  const now = Math.floor(Date.now() / 1000)
  for (const label of LABELS) {
    const { dir: rdir, name } = LEGS[label]
    mkdirSync(join(box, rdir), { recursive: true })
    DAYS.forEach((d, i) => {
      const p = join(box, rdir, name(d))
      writeFileSync(p, snapshot(label, name(d)))
      utimesSync(p, now - 86_400 + i * 60, now - 86_400 + i * 60)
      if (opts.macHas?.includes(label)) writeFileSync(join(dest, name(d)), snapshot(label, name(d)))
    })
  }
  const stamp = join(dest, "LAST_DRILL_OK")
  const age = opts.drill === "stale" ? 40 : 1
  writeFileSync(stamp, opts.drill === "stale" ? "2026-08-23 09:00:00\n" : "2026-10-01 09:00:00\n")
  utimesSync(stamp, now - age * 86_400, now - age * 86_400)

  const r = spawnSync("bash", ["-c", 'bash "$0" --dest "$1" 2>&1', SCRIPT, dest], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH}`,
      GUILD_VPS_SSH: HOST,
      GUILD_BACKUP_DEST: dest,
      FAKE_BOX: box,
      FAKE_SSH_DROP: "",
      FAKE_SCP_DROP: "",
      FAKE_SCP_EXIT: "",
      FAKE_PG_REFUSE: "",
      PG_RESTORE: join(BIN, "pg_restore"),
      MEMEGRID_BACKUP_DIR: LEGS["meme-grid-sqlite"].dir,
      MEMEGRID_PULL_COUNT: "7",
      ...opts.env,
    },
  })
  return { status: r.status, out: r.stdout, dest }
}

/** The wrapper's verdict on a run, from its real classifier. */
function classify(run: Run): { title: string; detail: string } {
  const r = spawnSync("bash", [WRAPPER, "--classify", String(run.status)], {
    input: run.out,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, GUILD_BACKUP_DEST: run.dest },
  })
  expect(r.status, r.stderr).toBe(0)
  expect(existsSync(join(run.dest, "pull.log")), "--classify reached notify()").toBe(false)
  const [title, detail] = r.stdout.split("\n")
  return { title, detail }
}

/** The constant AppleScript program notify() must always run. The title/body are argv, never spliced. */
const OSA_PROGRAM = [
  "on run argv",
  "display notification (item 1 of argv) with title (item 2 of argv)",
  "end run",
]

/**
 * Drive the FULL wrapper (its main path, NOT --classify) end to end against the fixture box, with a
 * fake osascript recording argv (5a). The postgres leg's snapshot carries an AppleScript injection
 * in its FILE NAME and its scp is dropped mid-pull, so that hostile name — data that came from the
 * box — reaches the "box unreachable" detail and thence notify(). bot-sqlite and meme-grid verify
 * normally, so the run's one failure is the postgres drop and the verdict is "box unreachable".
 * GUILD_PULL_BIN_PREFIX puts the fakes ahead of the wrapper's pinned PATH; OSASCRIPT points at the
 * recorder. Returns the recorded argv (one entry per osascript operand) and the call count.
 */
function runWrapperHostileName(hostilePgName: string): {
  status: number | null
  calls: number
  osaArgs: string[]
  dest: string
  out: string
} {
  const dir = mkdtempSync(join(tmpdir(), "pull-backups-notify-"))
  TMP_DIRS.push(dir)
  const box = join(dir, "box")
  const dest = join(dir, "dest")
  mkdirSync(dest)
  const osaLog = join(dir, "osascript.argv")
  const now = Math.floor(Date.now() / 1000)
  for (const label of LABELS) {
    const { dir: rdir, name } = LEGS[label]
    mkdirSync(join(box, rdir), { recursive: true })
    if (label === "postgres") {
      // One postgres snapshot, named with the injection. Its scp is dropped below, so its bytes are
      // never copied — only its NAME travels, into the detail and then osascript.
      const p = join(box, rdir, hostilePgName)
      writeFileSync(p, snapshot(label, hostilePgName))
      utimesSync(p, now - 60, now - 60)
    } else {
      DAYS.forEach((d, i) => {
        const p = join(box, rdir, name(d))
        writeFileSync(p, snapshot(label, name(d)))
        utimesSync(p, now - 86_400 + i * 60, now - 86_400 + i * 60)
      })
    }
  }
  const stamp = join(dest, "LAST_DRILL_OK")
  writeFileSync(stamp, "2026-10-01 09:00:00\n")
  utimesSync(stamp, now - 86_400, now - 86_400)

  const r = spawnSync("bash", [WRAPPER], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH}`,
      GUILD_PULL_BIN_PREFIX: BIN, // the wrapper pins PATH; this puts the fakes in front for the test
      OSASCRIPT: join(BIN, "osascript"),
      OSA_LOG: osaLog,
      GUILD_VPS_SSH: HOST,
      GUILD_BACKUP_DEST: dest,
      FAKE_BOX: box,
      FAKE_SSH_DROP: "",
      FAKE_SCP_DROP: "guild_db_", // drop ONLY the postgres copy, mid-pull → a "box unreachable" detail
      FAKE_SCP_EXIT: "255",
      FAKE_PG_REFUSE: "",
      PG_RESTORE: join(BIN, "pg_restore"),
      MEMEGRID_BACKUP_DIR: LEGS["meme-grid-sqlite"].dir,
      MEMEGRID_PULL_COUNT: "7",
    },
  })
  const raw = existsSync(osaLog) ? readFileSync(osaLog, "utf8") : ""
  const calls = (raw.match(/^CALL$/gm) || []).length
  const osaArgs = raw
    .split("\n")
    .filter((l) => l.startsWith("ARG:"))
    .map((l) => l.slice(4))
  return { status: r.status, calls, osaArgs, dest, out: r.stdout }
}

/** One leg's block of the run's output, from its === header to the next one. */
function section(out: string, label: string): string {
  const start = out.indexOf(`=== ${label} ===`)
  expect(start, `no "=== ${label} ===" block in:\n${out}`).toBeGreaterThan(-1)
  return out.slice(start, out.indexOf("\n===", start + 1))
}

const summaryOf = (out: string) => out.slice(out.indexOf("=== summary ==="))

let fresh: Run | undefined
/** A clean run: every copy verifies and the drill passed yesterday. Shared, it is read-only. */
const freshRun = () => (fresh ??= run({ drill: "fresh" }))

describe.skipIf(PRIV.skip)("ops/backup: the launchd pull's verdicts, from the real script's output", () => {
  beforeAll(() => {
    BIN = mkdtempSync(join(tmpdir(), "pull-backups-classify-bin-"))
    TMP_DIRS.push(BIN)
    for (const [name, body] of Object.entries(STUBS)) {
      writeFileSync(join(BIN, name), `${body}\n`)
      chmodSync(join(BIN, name), 0o755)
    }
  })

  afterAll(() => {
    for (const d of TMP_DIRS) rmSync(d, { recursive: true, force: true })
  })

  describe("pull-backups-launchd.sh: a failed pull is notified by what it found", () => {
    it("an unreachable box reads 'box unreachable', not FAILED", () => {
      const r = run({ drill: "fresh", env: { FAKE_SSH_DROP: "." } })
      expect(r.status, r.out).toBe(1)
      for (const label of LABELS) expect(summaryOf(r.out)).toContain(`${label}: BOX UNREACHABLE (ssh exit 255)`)
      expect(r.out).toContain(FOOTER)

      expect(classify(r)).toEqual({
        title: "Guild backup pull: box unreachable",
        detail: "  postgres: BOX UNREACHABLE (ssh exit 255). Not checked; re-run: bash ops/backup/pull-backups-launchd.sh",
      })
    })

    it("an unreachable box AND a stale drill reads 'box unreachable' (unreachable outranks stale)", () => {
      // #874 left this rank untested: the box-unreachable branch sits above the stale-drill branch,
      // so when BOTH are true the verdict must be "box unreachable" — you cannot re-prove copies
      // against a box you never reached. (Why this way: a data problem > unreachable > stale drill.)
      const r = run({ drill: "stale", env: { FAKE_SSH_DROP: "." } })
      expect(r.status, r.out).toBe(1)
      for (const label of LABELS) expect(summaryOf(r.out)).toContain(`${label}: BOX UNREACHABLE (ssh exit 255)`)
      // Both conditions really are present in the output the classifier reads:
      expect(r.out).toContain("last restore drill was 40 days ago (2026-08-23 09:00:00).")
      expect(r.out).toContain("BOX UNREACHABLE")

      expect(classify(r)).toEqual({
        title: "Guild backup pull: box unreachable",
        detail: "  postgres: BOX UNREACHABLE (ssh exit 255). Not checked; re-run: bash ops/backup/pull-backups-launchd.sh",
      })
    })

    it("a stale restore drill, every copy verified, reads 'restore drill stale'", () => {
      // The control: the same box with yesterday's drill is a clean run, so the stamp alone
      // is what fails this one.
      expect(freshRun().status, freshRun().out).toBe(0)
      expect(freshRun().out).toContain("RESULT: all sources pulled and verified.")

      const r = run({ drill: "stale" })
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain("last restore drill was 40 days ago (2026-08-23 09:00:00).")
      for (const label of LABELS) {
        expect(summaryOf(r.out)).toContain(`${label}: ${LEGS[label].name(NEWEST)} — verified`)
      }
      expect(r.out).toContain(FOOTER)

      expect(classify(r)).toEqual({
        title: "Guild backup: restore drill stale",
        detail: "Copies are verified, not proven restorable. Run ops/backup/restore-drill.sh",
      })
    })

    it("the healthy drill line is not a stale drill", () => {
      // "restore drill: last passed …" matched the old bare 'restore drill' grep. A clean run's
      // own output, classified as though it had failed, has nothing to report but the exit code.
      expect(freshRun().out).toContain("restore drill: last passed 2026-10-01 09:00:00 (1d ago)")
      expect(classify({ ...freshRun(), status: 1 }).title).toBe("Guild backup pull errored (exit 1)")
    })

    it("a genuine UNVERIFIED pull reads FAILED, with the UNVERIFIED line as the detail", () => {
      const r = run({ drill: "fresh", env: { FAKE_PG_REFUSE: "1" } })
      expect(r.status, r.out).toBe(1)
      expect(summaryOf(r.out)).toContain(`postgres: ${LEGS.postgres.name(NEWEST)} — UNVERIFIED`)

      const { title, detail } = classify(r)
      expect(title).toBe("Guild backup pull FAILED")
      expect(detail).toBe(
        "  UNVERIFIED — no local pg_restore can read this dump (unsupported version (1.99) in file header). " +
          "Fix: brew install libpq (keg-only, will not shadow postgresql@14)",
      )
    })

    it("a copy you cannot use outranks a dropped leg and a stale drill", () => {
      const r = run({ drill: "stale", env: { FAKE_PG_REFUSE: "1", FAKE_SCP_DROP: "guild_bot_" } })
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain("BOX UNREACHABLE")
      expect(r.out).toContain("last restore drill was 40 days ago")

      const { title, detail } = classify(r)
      expect(title).toBe("Guild backup pull FAILED")
      expect(detail).toContain("UNVERIFIED — no local pg_restore can read this dump")
    })
  })

  describe("pull-backups.sh: a network drop mid-pull reads BOX UNREACHABLE, and the run goes on", () => {
    it("scp losing the connection mid-copy (pull.log 2026-09-27 08:02)", () => {
      const bot = LEGS["bot-sqlite"].name(NEWEST)
      const r = run({ drill: "fresh", env: { FAKE_SCP_DROP: "guild_bot_" } })
      expect(r.status, r.out).toBe(1)
      expect(section(r.out, "bot-sqlite")).toContain(
        `UNREACHABLE: scp exited 255 mid-pull, so ${bot} was NOT checked against the box`,
      )
      expect(summaryOf(r.out)).toContain(`bot-sqlite: BOX UNREACHABLE mid-pull (scp exit 255) — ${bot}`)
      expect(existsSync(join(r.dest, bot))).toBe(false)
      // The run went on past the drop: the next leg was pulled and verified, and the report is whole.
      expect(summaryOf(r.out)).toContain(`meme-grid-sqlite: ${LEGS["meme-grid-sqlite"].name(NEWEST)} — verified`)
      expect(r.out).toContain(FOOTER)

      expect(classify(r)).toEqual({
        title: "Guild backup pull: box unreachable",
        detail:
          `  bot-sqlite: BOX UNREACHABLE mid-pull (scp exit 255) — ${bot}. ` +
          "Not checked; re-run: bash ops/backup/pull-backups-launchd.sh",
      })
    })

    it("ssh timing out on the checksum of a copy already here (pull.log 2026-09-19 06:01)", () => {
      // That night the Mac already held the meme-grid snapshots, so the drop hit a checksum.
      const r = run({
        drill: "fresh",
        macHas: ["meme-grid-sqlite"],
        env: { FAKE_SSH_DROP: "^sha256sum '/opt/fixture/meme-grid/" },
      })
      expect(r.status, r.out).toBe(1)
      for (const d of DAYS) {
        const mg = LEGS["meme-grid-sqlite"].name(d)
        expect(summaryOf(r.out)).toContain(`meme-grid-sqlite: BOX UNREACHABLE mid-pull (ssh exit 255) — ${mg}`)
      }
      expect(summaryOf(r.out)).toContain(`postgres: ${LEGS.postgres.name(NEWEST)} — verified`)
      expect(r.out).toContain(FOOTER)

      const { title, detail } = classify(r)
      expect(title).toBe("Guild backup pull: box unreachable")
      expect(detail).toContain("meme-grid-sqlite: BOX UNREACHABLE mid-pull (ssh exit 255)")
    })

    it("a copy that fails for any other reason still stops the run, as `set -e` did", () => {
      const r = run({ drill: "fresh", env: { FAKE_SCP_DROP: "guild_bot_", FAKE_SCP_EXIT: "1" } })
      expect(r.status, r.out).toBe(1)
      expect(r.out).not.toContain("=== summary ===")
      expect(r.out).not.toContain("UNREACHABLE")

      const { title, detail } = classify(r)
      expect(title).toBe("Guild backup pull errored (exit 1)")
      expect(detail).toBe(
        `scp: ${LEGS["bot-sqlite"].dir}/${LEGS["bot-sqlite"].name(NEWEST)}: No such file or directory`,
      )
    })
  })

  describe("pull-backups-launchd.sh: notify() passes text to osascript as argv, never as program (5a)", () => {
    // The detail can carry a file NAME that came from the box. Before the fix notify() did
    // `osascript -e "display notification \"$2\" with title \"$1\""`, so a box that named a file
    // `x" & (do shell script "…") & "` would close the string and run its own AppleScript on the
    // Mac. The fix passes title and body as `argv` to a CONSTANT program. The fake osascript records
    // its argv and runs nothing, so this asserts the program text is constant and the hostile name
    // rode only as a trailing operand — i.e. no AppleScript beyond the one display call could run.
    const INJECT = `guild_db_2026-10-02" & (do shell script "echo owned") & ".dump`

    it("a hostile file name reaches notify only as an osascript operand; the -e program is constant", () => {
      const { status, calls, osaArgs } = runWrapperHostileName(INJECT)
      expect(status).toBe(1)

      // osascript was invoked exactly once (the single display call), with the argv shape:
      //   -e <prog1> -e <prog2> -e <prog3> -- <body> <title>
      expect(calls).toBe(1)
      expect(osaArgs.slice(0, 7)).toEqual(["-e", OSA_PROGRAM[0], "-e", OSA_PROGRAM[1], "-e", OSA_PROGRAM[2], "--"])
      expect(osaArgs).toHaveLength(9)

      const body = osaArgs[7]
      const title = osaArgs[8]
      expect(title).toBe("Guild backup pull: box unreachable")
      // The hostile file name (and its AppleScript payload) rode through as DATA in the body operand.
      expect(body).toContain(INJECT)
      expect(body).toContain('do shell script "echo owned"')
      expect(body).toBe(
        `  postgres: BOX UNREACHABLE mid-pull (scp exit 255) — ${INJECT}. ` +
          "Not checked; re-run: bash ops/backup/pull-backups-launchd.sh",
      )

      // The program text is CONSTANT: no -e operand carries any of the payload — not the quote it
      // would need to break out, not the `do shell script` it tried to smuggle in.
      for (const i of [1, 3, 5]) {
        expect(osaArgs[i]).toBe(OSA_PROGRAM[(i - 1) / 2])
        expect(osaArgs[i]).not.toContain("do shell script")
        expect(osaArgs[i]).not.toContain('"')
      }
    })
  })

  describe("pull-backups-launchd.sh: classify() does not lose a match on large input (5c)", () => {
    // `printf … | grep -q` under `set -o pipefail` returns non-zero once the input tops the ~64 KiB
    // pipe buffer: grep -q exits on the first hit, printf dies of SIGPIPE, and the branch is skipped
    // — a real FAILED would be misfiled as "errored". The fix reads from a here-string. A full run's
    // output can pass 64 KiB (many legs plus a long coverage-shortfall list), so this feeds classify
    // ~150 KiB with the only UNVERIFIED line up top and proves it is still classified FAILED.
    it("a >64 KiB run output is still classified by the line it contains, not by its size", () => {
      const dest = mkdtempSync(join(tmpdir(), "pull-backups-big-"))
      TMP_DIRS.push(dest)
      const unverified =
        "  UNVERIFIED — no local pg_restore can read this dump (unsupported version (1.99) in file header)"
      const filler = Array.from({ length: 2600 }, (_, i) => `  coverage filler line ${i} ${"y".repeat(40)}`).join("\n")
      const out = [
        "=== postgres ===",
        unverified, // the match is EARLY, so grep -q would exit while printf still had >64 KiB to write
        filler,
        "=== summary ===",
        `  postgres: ${LEGS.postgres.name(NEWEST)} — UNVERIFIED`,
        "dest: /tmp/whatever",
        FOOTER,
      ].join("\n")
      expect(out.length).toBeGreaterThan(128 * 1024)

      const r = spawnSync("bash", [WRAPPER, "--classify", "1"], {
        input: out,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, GUILD_BACKUP_DEST: dest },
      })
      expect(r.status, r.stderr).toBe(0)
      const [title, detail] = r.stdout.split("\n")
      expect(title).toBe("Guild backup pull FAILED")
      expect(detail).toBe(unverified)
    })
  })
})
