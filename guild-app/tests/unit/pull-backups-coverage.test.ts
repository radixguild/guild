/**
 * ops/backup/pull-backups.sh's coverage line counts the box's snapshot NAMES that are here.
 *
 * pull.log, 2026-09-30 to 10-02: "coverage: 24 of 9 on-box snapshots are here". The line
 * compared two raw counts, and this Mac keeps every snapshot it ever pulled while the box
 * rotates, so the local count outgrew the box's and the line stopped answering its own
 * question: how much history is on the box that is NOT here? It now reads
 * "coverage: 9 of 9 on-box snapshots are here (24 kept locally)", names any on-box snapshot
 * missing here (a note, not a failure), and reads BOX UNREACHABLE when its listing's ssh
 * fails, as #870 made the rest of the script do.
 *
 * Runs the REAL script against a fixture box: a fake `ssh` first on PATH runs the script's
 * remote commands locally with /opt/ mapped into a temp dir, and a fake `scp` copies from
 * there (this test never opens a connection). Fake `sqlite3` and `pg_restore` verify every
 * copy, so the exit status reflects coverage alone. The stubs are minted once per file and
 * take their per-test behaviour from the environment: a freshly written executable pays a
 * serialised first-exec scan on macOS (measured in reconcile-cron-halt-guard.test.ts).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, utimesSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateInputs, REPO_ROOT } from "../support/private-input"

vi.setConfig({ testTimeout: 15_000 })

// ops/** stays private at the open-source flip (publish/MANIFEST.md).
const PRIV = privateInputs("ops/backup/pull-backups.sh", "ops/backup/pull-backups-launchd.sh")
const SCRIPT = join(REPO_ROOT, "ops/backup/pull-backups.sh")
const WRAPPER = join(REPO_ROOT, "ops/backup/pull-backups-launchd.sh")

/**
 * A reserved name (RFC 2606/6761) that never resolves, matching pull-backups-launchd-classify.test.ts.
 * The fake `ssh`/`scp` never open a connection, but naming the real alias `guild-vps` here meant a
 * stub that failed to land on PATH would send a local run at the real box. A .invalid host cannot.
 */
const HOST = "fixture-box.invalid"

/**
 * label → the box dir and the snapshot name for one day, as the script's sources define them.
 * meme-grid's dir is a fixture path, set through MEMEGRID_BACKUP_DIR (the script's own override).
 */
const LEGS = {
  postgres: { dir: "/opt/guild-saas/backups", name: (d: string) => `guild_db_${d}.dump` },
  "bot-sqlite": { dir: "/opt/guild-saas/backups/bot", name: (d: string) => `guild_bot_${d}.db` },
  "meme-grid-sqlite": { dir: "/opt/fixture/meme-grid", name: (d: string) => `meme-grid-${d}.db` },
} as const
type Leg = keyof typeof LEGS
const LABELS = Object.keys(LEGS) as Leg[]

const STUBS: Record<string, string> = {
  // ssh -n HOST CMD. FAKE_SSH_DROP (an ERE) fails the matching commands the way a dropped
  // network does; everything else runs under bash, as on the box, and keeps its exit status.
  ssh: [
    "#!/usr/bin/env bash",
    "set -o pipefail",
    '[ "$1" = "-n" ] && shift',
    "shift",
    'if [ -n "${FAKE_SSH_DROP:-}" ] && printf %s "$1" | grep -qE "$FAKE_SSH_DROP"; then',
    '  echo "ssh: connect to host fixture-box.invalid port 22: Network is unreachable" >&2',
    "  exit 255",
    "fi",
    'bash -c "$(printf %s "$1" | sed "s#/opt/#$FAKE_BOX/opt/#g")" | sed "s#$FAKE_BOX##g"',
  ].join("\n"),
  // scp -q HOST:PATH LOCAL
  scp: ['#!/bin/sh', '[ "$1" = "-q" ] && shift', 'cp "$FAKE_BOX${1#*:}" "$2"'].join("\n"),
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
  pg_restore: [
    "#!/bin/sh",
    'case "$1" in',
    '  --version) echo "pg_restore (PostgreSQL) 17.6" ;;',
    '  --list) echo "1; 0 0 TABLE DATA public snapshot fixture" ;;',
    "esac",
  ].join("\n"),
}

let BIN = ""
/** Every temp dir this file mints, removed in afterAll (the stubs dir and one per run). */
const TMP_DIRS: string[] = []

/** `n` consecutive days ending 2026-10-02, oldest first, as YYYYMMDD. */
function days(n: number): string[] {
  const end = Date.UTC(2026, 9, 2)
  return Array.from({ length: n }, (_, i) =>
    new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10).replaceAll("-", ""),
  )
}

const content = (name: string) => `snapshot ${name}\n`

/**
 * Run the script with every leg holding `boxDays` on the box (mtimes ascending, so `ls -t`
 * reads the last as newest) and `macDays` already in the Mac's dest, byte-identical.
 */
function run(opts: { boxDays: string[]; macDays: string[]; env?: Record<string, string> }) {
  const dir = mkdtempSync(join(tmpdir(), "pull-backups-cov-"))
  TMP_DIRS.push(dir)
  const box = join(dir, "box")
  const dest = join(dir, "dest")
  mkdirSync(dest)
  const t0 = Math.floor(Date.now() / 1000) - 86_400
  for (const { dir: rdir, name } of Object.values(LEGS)) {
    mkdirSync(join(box, rdir), { recursive: true })
    opts.boxDays.forEach((d, i) => {
      const p = join(box, rdir, name(d))
      writeFileSync(p, content(name(d)))
      utimesSync(p, t0 + i * 60, t0 + i * 60)
    })
    for (const d of opts.macDays) writeFileSync(join(dest, name(d)), content(name(d)))
  }
  const r = spawnSync("bash", [SCRIPT, "--dest", dest], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH}`,
      GUILD_VPS_SSH: HOST,
      FAKE_BOX: box,
      FAKE_SSH_DROP: "",
      PG_RESTORE: join(BIN, "pg_restore"),
      MEMEGRID_BACKUP_DIR: LEGS["meme-grid-sqlite"].dir,
      MEMEGRID_PULL_COUNT: "7",
      ...opts.env,
    },
  })
  const out = `${r.stdout}${r.stderr}`
  return { status: r.status, out, dest }
}

/** One leg's block of the run's output, from its === header to the next one. */
function section(out: string, label: string): string {
  const start = out.indexOf(`=== ${label} ===`)
  expect(start, `no "=== ${label} ===" block in:\n${out}`).toBeGreaterThan(-1)
  return out.slice(start, out.indexOf("\n===", start + 1))
}

const summaryOf = (out: string) => out.slice(out.indexOf("=== summary ==="))

/** The ERE the launchd wrapper reads as "Guild backup pull FAILED", taken from the wrapper itself. */
function wrapperFailurePattern(): RegExp {
  const m = readFileSync(WRAPPER, "utf8").match(/grep -qE '([^']+)'/)
  expect(m, "the wrapper's failure classifier (grep -qE '…') was not found").not.toBeNull()
  return new RegExp(m![1])
}

describe.skipIf(PRIV.skip)("pull-backups.sh: coverage counts on-box snapshot names that are here", () => {
  beforeAll(() => {
    BIN = mkdtempSync(join(tmpdir(), "pull-backups-cov-bin-"))
    TMP_DIRS.push(BIN)
    for (const [name, body] of Object.entries(STUBS)) {
      writeFileSync(join(BIN, name), `${body}\n`)
      chmodSync(join(BIN, name), 0o755)
    }
  })

  afterAll(() => {
    for (const d of TMP_DIRS) rmSync(d, { recursive: true, force: true })
  })

  it("the Mac holding more than the box reads 9 of 9 (24 kept locally), not 24 of 9", () => {
    // The pull.log shape: the box keeps 9 days, the Mac every day since 09-09. Tonight's
    // newest is not here yet, so it is pulled first and counted.
    const box = days(9)
    const { status, out } = run({ boxDays: box, macDays: days(24).slice(0, -1) })

    for (const label of LABELS) {
      const block = section(out, label)
      expect(block).toContain("coverage: 9 of 9 on-box snapshots are here (24 kept locally)")
      expect(block).not.toContain("NOT here")
      expect(summaryOf(out)).toContain(`${label} coverage: 9 of 9 on-box snapshots are here (24 kept locally)`)
    }
    expect(section(out, "postgres")).toContain(`pulling ${LEGS.postgres.name(box[8])}`)
    expect(out).not.toContain("24 of 9")
    expect(status).toBe(0)
    expect(out).toContain("RESULT: all sources pulled and verified.")
  })

  it("an on-box snapshot missing here is named, in the leg and the summary, without failing the run", () => {
    // The Mac missed 09-25: older than anything this run pulls (postgres and bot-sqlite copy
    // only the newest, meme-grid the newest 7 = 09-26..10-02), so it stays missing.
    const box = days(9)
    const missed = box[1]
    const { status, out } = run({ boxDays: box, macDays: days(24).filter((d) => d !== missed) })
    const failure = wrapperFailurePattern()

    for (const label of LABELS) {
      const block = section(out, label)
      expect(block).toContain("coverage: 8 of 9 on-box snapshots are here (23 kept locally)")
      const note = block.split("\n").find((l) => l.includes("NOT here"))
      expect(note, `${label}: no NOT-here note`).toBeDefined()
      expect(note).toContain(`1 NOT here`)
      expect(note).toContain(LEGS[label].name(missed))
      expect(note).not.toMatch(failure)
      expect(note).not.toMatch(/BOX UNREACHABLE|restore drill/)
      expect(summaryOf(out)).toContain(
        `${label} coverage: 8 of 9 on-box snapshots are here (23 kept locally) — 1 NOT here`,
      )
    }
    expect(status).toBe(0)
    expect(out).toContain("RESULT: all sources pulled and verified.")
  })

  it("a meme-grid night inside the newest MEMEGRID_PULL_COUNT is pulled, so it is not a shortfall", () => {
    const box = days(9)
    const { out, dest } = run({ boxDays: box, macDays: days(24).filter((d) => d !== box[4]) })
    const mg = LEGS["meme-grid-sqlite"].name(box[4])

    expect(section(out, "meme-grid-sqlite")).toContain(`pulling ${mg}`)
    expect(readFileSync(join(dest, mg), "utf8")).toBe(content(mg))
    expect(section(out, "meme-grid-sqlite")).toContain("coverage: 9 of 9 on-box snapshots are here (24 kept locally)")
    // postgres copies only the newest, so the same night stays missing there.
    expect(section(out, "postgres")).toContain("coverage: 8 of 9 on-box snapshots are here (23 kept locally)")
  })

  it("an ssh failure on the coverage listing reads BOX UNREACHABLE, never a count", () => {
    // The box answers the pull (ls -t, sha256sum) and drops only the coverage listing (a bare `ls /…`).
    const box = days(9)
    const { status, out } = run({
      boxDays: box,
      macDays: days(24).slice(0, -1),
      env: { FAKE_SSH_DROP: "^ls /" },
    })

    for (const label of LABELS) {
      const block = section(out, label)
      expect(block).toContain(`coverage: UNREACHABLE: ssh ${HOST} exited 255, so ${LEGS[label].dir} was NOT listed`)
      expect(summaryOf(out)).toContain(`${label} coverage: BOX UNREACHABLE (ssh exit 255)`)
    }
    expect(out).not.toContain("on-box snapshots are here")
    expect(out).not.toContain("NOTHING")
    expect(summaryOf(out)).toContain(`postgres: ${LEGS.postgres.name(box[8])} — verified`)
    expect(status).toBe(1)
    // The coverage lines carry nothing the launchd wrapper reads as a failed pull. (Only these
    // lines: the RESULT footer of any non-zero run matches that pattern on its own.)
    const failure = wrapperFailurePattern()
    for (const l of out.split("\n").filter((l) => l.includes("coverage"))) expect(l).not.toMatch(failure)
  })
})
