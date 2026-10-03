/**
 * ops/backup/guild-bot-db-backup.sh, the Guild box's nightly backup of the bot's SQLite (root
 * cron, 03:20 UTC), verifies its snapshot READ-ONLY and SAFE.
 *
 * Until 2026-10-02 its row count spliced every table name read out of the snapshot into
 * `sqlite3 "$out" "SELECT count(*) FROM \"$t\";"` on a READ-WRITE connection. A table named
 * `members";VACUUM INTO '<path>';--` made root's sqlite3 write a full copy of the database to any
 * path, and the run still logged OK (the class pull-backups.sh's verify_sqlite had on the Mac).
 * Now every read is `-readonly -safe` on `file:<snapshot>?immutable=1`, every name must be a plain
 * identifier before SQL is built from any of them, every count must be digits before shell
 * arithmetic sees it, and text read out of the file reaches the log with non-printables replaced.
 * A database with none of that in it must back up exactly as before: same line, same exit, same
 * files.
 *
 * This runs the REAL script against temp-dir fixtures, every path through an override: the
 * script's test seams (GUILD_BOT_BACKUP_DIR, _LOCAL_COPY_DIR, _CONF, _BIN_PREFIX) and its own
 * BOT_DB_SRC and ALERT_ENV (a file that does not exist, so no alert is attempted). curl, rsync and
 * pm2 are tripwires that record any call, and no call is expected: nothing here can reach a network
 * or a path outside its temp dir. The fixture is a WAL-mode database, as the live bot's is, so
 * `.backup` makes a WAL-mode snapshot as it does on the box: the shape on which a plain `-readonly`
 * open leaves -wal/-shm files behind (stock sqlite3) or cannot open at all (macOS's 3.51).
 *
 * Where it runs: with the real sqlite3 on the script's pinned PATH, so it SKIPS where there is none,
 * or only one older than 3.37.0 (no -safe); and it skips in the public export, which does not ship
 * ops/**. On macOS the script's one GNU-only call, `stat -c%s`, is answered by a fake over BSD stat;
 * on Linux (CI: ubuntu-24.04, sqlite3 3.45.1, the box's version family) every tool is real.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateInputs, REPO_ROOT } from "../support/private-input"

vi.setConfig({ testTimeout: 30_000 })

// ops/** stays private at the open-source flip (publish/MANIFEST.md).
const PRIV = privateInputs("ops/backup/guild-bot-db-backup.sh")
const SCRIPT = join(REPO_ROOT, "ops/backup/guild-bot-db-backup.sh")

/** The PATH the script pins behind its seam prefix: the tools it really runs resolve from here. */
const SCRIPT_PATH = "/usr/local/bin:/usr/bin:/bin"

function resolveTool(cmd: string): string {
  const r = spawnSync("sh", ["-c", 'command -v "$1"', "sh", cmd], { env: { PATH: SCRIPT_PATH }, encoding: "utf8" })
  return r.status === 0 ? r.stdout.trim() : ""
}
const SQLITE = resolveTool("sqlite3")
/** The script refuses to verify without -readonly -safe (sqlite3 3.37.0+), so this suite needs it too. */
const HAVE_SQLITE =
  SQLITE !== "" &&
  spawnSync(SQLITE, ["-readonly", "-safe", ":memory:", "SELECT 1;"], { encoding: "utf8" }).status === 0

const TS = String.raw`\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}`
const SNAPSHOT_NAME = /^guild_bot_\d{4}-\d{2}-\d{2}_\d{6}\.db$/
const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
/** Any C0 control character but the newline, or DEL: none may reach the log. */
const hasControl = (s: string) =>
  [...s].some((c) => {
    const n = c.charCodeAt(0)
    return (n < 0x20 && n !== 0x0a) || n === 0x7f
  })

/** 30 small tables and a padding blob: over every floor (25 tables, 50 rows, 100,000 bytes). */
const TABLES = Array.from({ length: 30 }, (_, i) => `t${String(i).padStart(2, "0")}`)
const rowsOf = (i: number) => (i % 4) + 1
const BASE_SQL = [
  "PRAGMA journal_mode=WAL;",
  ...TABLES.map(
    (t, i) =>
      `CREATE TABLE ${t}(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO ${t}(v) VALUES ` +
      `${Array.from({ length: rowsOf(i) }, (_, j) => `('r${j}')`).join(",")};`,
  ),
  "CREATE TABLE pad(b BLOB); INSERT INTO pad VALUES (zeroblob(150000));",
].join("\n")
const BASE_TABLES = TABLES.length + 1 // 31
const BASE_ROWS = TABLES.reduce((sum, _, i) => sum + rowsOf(i), 0) + 1 // 74

// Minted once per file: a freshly written executable pays a first-exec scan on macOS
// (measured in reconcile-cron-halt-guard.test.ts). Per-case behaviour comes from the env.
let BIN = "" // the tripwires, plus a GNU-shaped stat on macOS
let FAKE_SQLITE_BIN = "" // a sqlite3 that can answer one query falsely; only the cases that fake one put it first
const TMP_DIRS: string[] = []

const tripwire = (name: string) => `#!/bin/sh\necho "${name} $*" >> "$TRIPWIRE_LOG"\nexit 97\n`
const GNU_STAT_ON_BSD = [
  "#!/bin/sh",
  "# The script's only GNU-only call, `stat -c%s FILE`, answered by BSD stat (macOS).",
  'if [ "$1" = "-c%s" ] && [ $# -eq 2 ]; then exec /usr/bin/stat -f%z "$2"; fi',
  'echo "fake stat: unexpected arguments: $*" >&2',
  "exit 2",
].join("\n")
const fakeSqlite = (real: string) =>
  [
    "#!/bin/sh",
    "# Every call goes to the real sqlite3, except: FAKE_SQLITE_OLD=1 answers like one older than",
    "# 3.37.0 (no -safe), and when the LAST argument is exactly FAKE_SQLITE_MATCH, the answer is the",
    "# bytes of FAKE_SQLITE_OUTPUT_FILE.",
    'if [ "${FAKE_SQLITE_OLD:-}" = 1 ]; then',
    '  for a in "$@"; do',
    '    case "$a" in',
    '      -safe) echo "sqlite3: Error: unknown option: -safe" >&2; echo "Use -help for a list of options." >&2; exit 1 ;;',
    '      -version) echo "3.31.1 2020-01-27 19:55:54 3bfa9cc97da10598521b342961df8f5f68c7388fa117345eeb516eaa837balt1"; exit 0 ;;',
    "    esac",
    "  done",
    "fi",
    'if [ -n "${FAKE_SQLITE_MATCH:-}" ]; then',
    '  for last in "$@"; do :; done',
    '  if [ "$last" = "$FAKE_SQLITE_MATCH" ]; then cat "$FAKE_SQLITE_OUTPUT_FILE"; exit 0; fi',
    "fi",
    `exec '${real}' "$@"`,
  ].join("\n")

function sqlite(db: string, sql: string, home: string) {
  const r = spawnSync(SQLITE, [db, sql], { encoding: "utf8", env: { PATH: SCRIPT_PATH, HOME: home } })
  if (r.status !== 0) throw new Error(`sqlite3 fixture build failed: ${r.stderr || r.stdout}`)
}

/** Reads the snapshot without writing a byte beside it (the same open the script uses). */
function query(db: string, sql: string, home: string): string {
  const r = spawnSync(SQLITE, ["-readonly", `file:${db}?immutable=1`, sql], {
    encoding: "utf8",
    env: { PATH: SCRIPT_PATH, HOME: home },
  })
  if (r.status !== 0) throw new Error(`sqlite3 query failed: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}

const DAY = 86_400
/** Older files in both directories, one each side of each retention window, and one outside the glob. */
const PLANTED = {
  backup: {
    "guild_bot_2026-09-01_032000.db": 20, // past RETENTION_DAYS=14: rotated
    "guild_bot_2026-09-25_032000.db": 7, // kept
    "guild_bot_2026-09-30_032000.db.tmp": 2, // a stale .tmp, over a day old: rotated
    "guild-2026-04-06.db": 60, // outside the guild_bot_* glob: kept
  },
  localCopy: {
    "guild_bot_2026-08-20_032000.db": 40, // past LOCAL_COPY_RETENTION_DAYS=30: rotated
    "guild_bot_2026-09-10_032000.db": 20, // kept
  },
}

type RunOpts = {
  /** Replaces the base schema entirely (the floor cases). */
  sql?: string
  /** Appended to the base schema; gets the run's temp dir, so a payload can aim inside it. */
  extraSql?: (dir: string) => string
  plantRotation?: boolean
  /** Env for the fake sqlite3; its presence puts the fake first on the script's PATH. */
  fake?: Record<string, string>
  /** What the fake answers FAKE_SQLITE_MATCH with; gets the run's temp dir. */
  fakeOutput?: (dir: string) => string
}

function run(opts: RunOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "guild-bot-db-backup-"))
  TMP_DIRS.push(dir)
  mkdirSync(join(dir, "live"))
  const live = join(dir, "live", "bot-fixture.db")
  sqlite(live, opts.sql ?? `${BASE_SQL}\n${opts.extraSql?.(dir) ?? ""}`, dir)

  const backupDir = join(dir, "backups", "bot")
  const localCopyDir = join(dir, "var-backups", "guild-bot-db")
  if (opts.plantRotation) {
    const now = Math.floor(Date.now() / 1000)
    for (const [d, files] of [
      [backupDir, PLANTED.backup],
      [localCopyDir, PLANTED.localCopy],
    ] as const) {
      mkdirSync(d, { recursive: true })
      for (const [name, ageDays] of Object.entries(files)) {
        writeFileSync(join(d, name), "an older night\n")
        utimesSync(join(d, name), now - ageDays * DAY, now - ageDays * DAY)
      }
    }
  }

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? SCRIPT_PATH, // finds `bash`; the script pins its own
    HOME: dir, // no ~/.sqliterc
    GUILD_BOT_BACKUP_BIN_PREFIX: opts.fake ? `${FAKE_SQLITE_BIN}:${BIN}` : BIN,
    GUILD_BOT_BACKUP_DIR: backupDir,
    GUILD_BOT_LOCAL_COPY_DIR: localCopyDir,
    GUILD_BOT_BACKUP_CONF: join(dir, "no-backup.env"),
    ALERT_ENV: join(dir, "no-alert.env"),
    BOT_DB_SRC: live,
    TRIPWIRE_LOG: join(dir, "tripwire.log"),
    ...opts.fake,
  }
  if (opts.fakeOutput) {
    writeFileSync(join(dir, "fake-output"), opts.fakeOutput(dir))
    env.FAKE_SQLITE_OUTPUT_FILE = join(dir, "fake-output")
  }
  const r = spawnSync("bash", [SCRIPT], { encoding: "utf8", timeout: 25_000, cwd: dir, env })

  const snapshots = existsSync(backupDir) ? readdirSync(backupDir).filter((f) => SNAPSHOT_NAME.test(f)) : []
  const fresh = snapshots.filter((f) => !(f in PLANTED.backup))
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    dir,
    backupDir,
    localCopyDir,
    tripwire: env.TRIPWIRE_LOG,
    /** Tonight's snapshot: exactly one is expected. */
    snapName: () => {
      expect(fresh, `snapshots in ${backupDir}: ${snapshots.join(", ")}\n${r.stderr}`).toHaveLength(1)
      return fresh[0]
    },
  }
}

const mode = (p: string) => statSync(p).mode & 0o777

/** Every path under the run's temp dir except the live fixture, so nothing unexpected can hide. */
function treeOf(dir: string, sub = ""): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(dir, sub)).sort()) {
    const rel = sub ? `${sub}/${name}` : name
    if (rel === "live") continue
    out.push(rel)
    if (statSync(join(dir, rel)).isDirectory()) out.push(...treeOf(dir, rel))
  }
  return out
}

/** A failed run: exit 1, nothing on stdout, ONE printable ERROR line, and only the unverified snapshot left. */
function expectRefused(r: ReturnType<typeof run>, says: RegExp) {
  expect(r.status, r.stderr).toBe(1)
  expect(r.stdout).toBe("")
  expect(r.stderr).toMatch(new RegExp(`^${TS} ERROR [^\\n]*\\n$`))
  expect(r.stderr).toMatch(says)
  expect(hasControl(r.stderr), JSON.stringify(r.stderr)).toBe(false)
  const snap = r.snapName()
  // No LAST_OK, no second copy, no -wal/-shm, no .tmp: the snapshot is left unverified, as on any failed night.
  expect(readdirSync(r.backupDir)).toEqual([snap])
  expect(mode(join(r.backupDir, snap))).toBe(0o600)
  expect(existsSync(r.localCopyDir)).toBe(false)
  expect(treeOf(r.dir)).toEqual(["backups", "backups/bot", `backups/bot/${snap}`, "fake-output"].filter(
    (p) => p !== "fake-output" || existsSync(join(r.dir, "fake-output")),
  ))
  expect(existsSync(r.tripwire), "curl, rsync or pm2 was called").toBe(false)
}

describe.skipIf(PRIV.skip || !HAVE_SQLITE)("guild-bot-db-backup.sh verifies its snapshot read-only and safe", () => {
  beforeAll(() => {
    BIN = mkdtempSync(join(tmpdir(), "guild-bot-db-backup-bin-"))
    FAKE_SQLITE_BIN = mkdtempSync(join(tmpdir(), "guild-bot-db-backup-fake-"))
    TMP_DIRS.push(BIN, FAKE_SQLITE_BIN)
    const stubs: [string, string, string][] = [
      [BIN, "curl", tripwire("curl")],
      [BIN, "rsync", tripwire("rsync")],
      [BIN, "pm2", tripwire("pm2")],
      [FAKE_SQLITE_BIN, "sqlite3", fakeSqlite(SQLITE)],
    ]
    if (process.platform === "darwin") stubs.push([BIN, "stat", GNU_STAT_ON_BSD])
    for (const [d, name, body] of stubs) {
      writeFileSync(join(d, name), `${body}\n`)
      chmodSync(join(d, name), 0o755)
    }
  })

  afterAll(() => {
    for (const d of TMP_DIRS) rmSync(d, { recursive: true, force: true })
  })

  it("a healthy database backs up exactly as before: one OK line, exit 0, the same files, rotation", () => {
    const r = run({ plantRotation: true })
    expect(r.stderr).toBe("")
    expect(r.status).toBe(0)
    const name = r.snapName()
    const snap = join(r.backupDir, name)
    const size = spawnSync("sh", ["-c", 'du -h "$1" | cut -f1', "sh", snap], {
      env: { PATH: SCRIPT_PATH },
      encoding: "utf8",
    }).stdout.trim()
    expect(r.stdout).toMatch(
      new RegExp(
        `^${TS} OK ${re(snap)} \\(${re(size)}, ${BASE_TABLES} tables, ${BASE_ROWS} rows\\) ` +
          `copy: ${re(r.localCopyDir)} offsite: skipped \\(BOT_OFFSITE_DEST not set\\)\\n$`,
      ),
    )

    // Exactly these files: tonight's snapshot, LAST_OK, what rotation keeps. No -wal/-shm beside the
    // snapshot (a plain -readonly open of a WAL-mode file leaves both behind), no .tmp.
    expect(readdirSync(r.backupDir).sort()).toEqual(
      ["LAST_OK", "guild-2026-04-06.db", "guild_bot_2026-09-25_032000.db", name].sort(),
    )
    expect(readdirSync(r.localCopyDir).sort()).toEqual(["guild_bot_2026-09-10_032000.db", name].sort())
    expect(readFileSync(join(r.backupDir, "LAST_OK"), "utf8")).toMatch(new RegExp(`^${TS}\\n$`))
    expect(mode(r.backupDir)).toBe(0o700)
    expect(mode(r.localCopyDir)).toBe(0o700)
    expect(mode(snap)).toBe(0o600)
    const copy = join(r.localCopyDir, name)
    expect(mode(copy)).toBe(0o600)
    expect(readFileSync(copy).equals(readFileSync(snap))).toBe(true)
    expect(Math.trunc(statSync(copy).mtimeMs / 1000)).toBe(Math.trunc(statSync(snap).mtimeMs / 1000)) // cp -a
    expect(existsSync(r.tripwire), "curl, rsync or pm2 was called").toBe(false)

    // And the snapshot is the database: it opens clean and holds every row.
    expect(query(snap, "PRAGMA integrity_check;", r.dir)).toBe("ok")
    const sum = [...TABLES, "pad"].map((t) => `(SELECT count(*) FROM ${t})`).join(" + ")
    expect(query(snap, `SELECT ${sum};`, r.dir)).toBe(String(BASE_ROWS))
  })

  describe("a table name outside [A-Za-z_][A-Za-z0-9_]* FAILS the run, and nothing is written or stamped", () => {
    const outside = (snap: string, shown: string) =>
      `table name outside \\[A-Za-z_\\]\\[A-Za-z0-9_\\]\\* in ${re(snap)}: "${shown}" — the bot creates no such name, ` +
      `so this backup is suspect; no SQL was run on it\\n$`

    it("a VACUUM INTO payload (it starts with a real table, so the old splice ran it and passed)", () => {
      const r = run({
        extraSql: (dir) =>
          `CREATE TABLE members(a); INSERT INTO members VALUES (1),(2);\n` +
          `CREATE TABLE "members"";VACUUM INTO '${join(dir, "INJECTED.db")}';--"(c);`,
      })
      const snap = join(r.backupDir, r.snapName())
      expectRefused(r, new RegExp(outside(snap, re(`members";VACUUM INTO '${join(r.dir, "INJECTED.db")}';--`))))
      expect(existsSync(join(r.dir, "INJECTED.db")), "the payload wrote its file").toBe(false)
    })

    it("a line break that splits into two real tables (the old split counted both twice and passed)", () => {
      const r = run({
        extraSql: () =>
          `CREATE TABLE members(a); INSERT INTO members VALUES (1),(2); CREATE TABLE votes(b); INSERT INTO votes VALUES (3);\n` +
          `CREATE TABLE "members\nvotes"(c);`,
      })
      expectRefused(r, new RegExp(outside(join(r.backupDir, r.snapName()), "members<LF>votes")))
    })

    it("terminal control sequences, which reach the log printable, never raw", () => {
      const r = run({ extraSql: () => `CREATE TABLE "x\u001b]0;owned\u0007\u001b[31mred"(c);` })
      // sqlite3 3.50+ prints control characters as ^X itself; older ones print them raw and the
      // script replaces each with ?. Either way nothing raw reaches the log.
      const shown = String.raw`x(\?|\^\[)\]0;owned(\?|\^G)(\?|\^\[)\[31mred`
      expectRefused(r, new RegExp(outside(join(r.backupDir, r.snapName()), shown)))
    })

    it("an empty name, listed last (its line is lost to $(…), so the listing no longer adds up)", () => {
      const r = run({ extraSql: () => `CREATE TABLE ""(c);` })
      const snap = join(r.backupDir, r.snapName())
      expectRefused(
        r,
        new RegExp(
          `${re(snap)} lists ${BASE_TABLES} table names for ${BASE_TABLES + 1} tables — ` +
            `refusing to count rows in a schema that does not add up\\n$`,
        ),
      )
    })
  })

  describe("a count must be digits before it is compared or added; text read out of the file is printable", () => {
    const ROW_COUNT_T05 = 'SELECT count(*) FROM "t05";'
    const TABLE_COUNT = "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"
    const LISTING =
      "SELECT replace(name, char(10), '<LF>') FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"

    it("a table name with RAW control characters (sqlite3 before 3.50 prints them so) reaches the log printable", () => {
      // The real-database case above cannot tell, on a sqlite3 that escapes them itself, whether the
      // script replaced them; this one hands the script the raw bytes on every platform.
      const r = run({ fake: { FAKE_SQLITE_MATCH: LISTING }, fakeOutput: () => "t00\nx\u001b]0;owned\u0007\u001b[31mred\n" })
      const snap = join(r.backupDir, r.snapName())
      expectRefused(
        r,
        new RegExp(`table name outside \\[A-Za-z_\\]\\[A-Za-z0-9_\\]\\* in ${re(snap)}: "x\\?\\]0;owned\\?\\?\\[31mred" — `),
      )
    })

    it("a row count that is an expression (1+1) is refused, not evaluated", () => {
      const r = run({ fake: { FAKE_SQLITE_MATCH: ROW_COUNT_T05 }, fakeOutput: () => "1+1\n" })
      const snap = join(r.backupDir, r.snapName())
      expectRefused(r, new RegExp(`the row count of table t05 in ${re(snap)} is not a number: 1\\+1\\n$`))
    })

    it("a row count that would run a command inside $(( )) is refused, and the command never runs", () => {
      const r = run({
        fake: { FAKE_SQLITE_MATCH: ROW_COUNT_T05 },
        fakeOutput: (dir) => `a[$(touch ${join(dir, "ARITH-INJECTED")})]\n`,
      })
      const snap = join(r.backupDir, r.snapName())
      expectRefused(
        r,
        new RegExp(
          `the row count of table t05 in ${re(snap)} is not a number: ${re(`a[$(touch ${join(r.dir, "ARITH-INJECTED")})]`)}\\n$`,
        ),
      )
      expect(existsSync(join(r.dir, "ARITH-INJECTED")), "shell arithmetic ran the payload").toBe(false)
    })

    it("a table count that is an expression (25+1) is refused", () => {
      const r = run({ fake: { FAKE_SQLITE_MATCH: TABLE_COUNT }, fakeOutput: () => "25+1\n" })
      const snap = join(r.backupDir, r.snapName())
      expectRefused(r, new RegExp(`the table count of ${re(snap)} is not a number: 25\\+1\\n$`))
    })

    it("a count too long for 64-bit arithmetic is refused, and the log line is capped", () => {
      const r = run({ fake: { FAKE_SQLITE_MATCH: ROW_COUNT_T05 }, fakeOutput: () => `${"9".repeat(5000)}\n` })
      const snap = join(r.backupDir, r.snapName())
      expectRefused(
        r,
        new RegExp(`the row count of table t05 in ${re(snap)} is not a number: 9{200}\\.\\.\\.\\(5000 chars\\)\\n$`),
      )
    })

    it("a failing integrity_check line with control characters reaches the log printable", () => {
      const r = run({
        fake: { FAKE_SQLITE_MATCH: "PRAGMA integrity_check;" },
        fakeOutput: () => "row 1 missing from index \u001b[31midx\u0007\n",
      })
      const snap = join(r.backupDir, r.snapName())
      expectRefused(r, new RegExp(`integrity_check on ${re(snap)} returned: row 1 missing from index \\?\\[31midx\\?\\n$`))
    })
  })

  it("an sqlite3 without -safe (older than 3.37.0) FAILS loudly instead of verifying read-write", () => {
    const r = run({ fake: { FAKE_SQLITE_OLD: "1" } })
    const snap = join(r.backupDir, r.snapName())
    expectRefused(
      r,
      new RegExp(
        `sqlite3 3\\.31\\.1 refuses -readonly -safe \\(needs 3\\.37\\.0\\+\\), so ${re(snap)} was written but NOT verified — upgrade sqlite3\\n$`,
      ),
    )
  })

  describe("the floors still bite, with the same lines as before", () => {
    it("too few tables", () => {
      const r = run({
        sql: TABLES.slice(0, 24)
          .map((t) => `CREATE TABLE ${t}(v); INSERT INTO ${t} VALUES (1),(2),(3);`)
          .join("\n"),
      })
      const snap = join(r.backupDir, r.snapName())
      expectRefused(r, new RegExp(`only 24 tables in ${re(snap)} \\(floor 25\\) — schema loss\\?\\n$`))
    })

    it("a wiped database: every table there, every row gone", () => {
      const r = run({ sql: ["PRAGMA journal_mode=WAL;", ...TABLES.map((t) => `CREATE TABLE ${t}(v);`)].join("\n") })
      const snap = join(r.backupDir, r.snapName())
      expectRefused(r, new RegExp(`only 0 total rows in ${re(snap)} \\(floor 50\\) — database wiped\\?\\n$`))
    })
  })
})
