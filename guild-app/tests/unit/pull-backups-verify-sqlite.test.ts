/**
 * ops/backup/pull-backups.sh's verify_sqlite() treats a pulled SQLite file as HOSTILE input, and
 * opens it the way the box makes it: a WAL-mode `.backup` snapshot with no -wal/-shm beside it.
 *
 * The file came from the box, so a crafted backup can try to make the verifier write, ATTACH a
 * second database, or run a shell dot-command, and its table NAMES (read from sqlite_master) could
 * carry a payload that an unchecked splice would execute. The old verifier did
 * `sqlite3 "$f" "SELECT count(*) FROM \"$t\";"` over names joined by group_concat: a table named
 * `x";VACUUM INTO '…';--` turned into two statements and VACUUM INTO wrote a brand-new file.
 *
 * The fix opens every read `-readonly -safe` on `file:<path>?immutable=1`: -safe refuses ATTACH and
 * so VACUUM INTO (-readonly alone does not), and immutable=1 is what lets this Mac's sqlite3 open a
 * WAL-mode snapshot read-only at all. Plain `-readonly` on the box's snapshots fails with "unable to
 * open database file" on macOS's sqlite3 3.51, which is why these fixtures are WAL-mode `.backup`
 * output like the box's: a rollback-journal fixture opens either way and could not tell. The path is
 * percent-encoded where a URI would misread it, names must be plain identifiers and add up to the
 * table count, counts must be digits before shell arithmetic, and text read out of the file reaches
 * pull.log printable.
 *
 * This runs the REAL pull-backups.sh against a fixture box (fake `ssh`/`scp` over a temp dir, a fake
 * `pg_restore`) whose SQLite legs are verified by the REAL sqlite3. Where a case needs sqlite3 to
 * answer one query falsely, a wrapper that passes everything else to the real one goes first on
 * PATH. It SKIPS where sqlite3 is absent or lacks -safe (before 3.37.0), and in the public export
 * where ops/** is not shipped.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
const PRIV = privateInputs("ops/backup/pull-backups.sh", "ops/backup/pull-backups-launchd.sh")
const SCRIPT = join(REPO_ROOT, "ops/backup/pull-backups.sh")
const WRAPPER = join(REPO_ROOT, "ops/backup/pull-backups-launchd.sh")

/** A reserved name (RFC 2606/6761) that never resolves, so even a missing stub could not reach a box. */
const HOST = "fixture-box.invalid"

/** The sqlite3 the script runs: it takes the caller's PATH. */
const SQLITE = (() => {
  const r = spawnSync("sh", ["-c", "command -v sqlite3"], { encoding: "utf8" })
  return r.status === 0 ? r.stdout.trim() : ""
})()
/** verify_sqlite refuses to open a file without -readonly -safe (3.37.0+), so this suite needs it. */
const HAVE_SQLITE =
  SQLITE !== "" && spawnSync(SQLITE, ["-readonly", "-safe", ":memory:", "SELECT 1;"], { encoding: "utf8" }).status === 0

const LEGS = {
  postgres: { dir: "/opt/guild-saas/backups", name: "guild_db_20261002.dump" },
  "bot-sqlite": { dir: "/opt/guild-saas/backups/bot", name: "guild_bot_20261002.db" },
  "meme-grid-sqlite": { dir: "/opt/fixture/meme-grid", name: "meme-grid-20261002.db" },
} as const

// Fakes: ssh/scp serve the fixture box locally, sha256sum borrows shasum, pg_restore verifies.
// sqlite3 is NOT faked here: the real one verifies the SQLite legs.
const STUBS: Record<string, string> = {
  ssh: [
    "#!/usr/bin/env bash",
    "set -o pipefail",
    '[ "$1" = "-n" ] && shift',
    "shift",
    'bash -c "$(printf %s "$1" | sed "s#/opt/#$FAKE_BOX/opt/#g")" | sed "s#$FAKE_BOX##g"',
  ].join("\n"),
  scp: ["#!/bin/sh", '[ "$1" = "-q" ] && shift', 'cp "$FAKE_BOX${1#*:}" "$2"'].join("\n"),
  sha256sum: "#!/bin/sh\nexec shasum -a 256 \"$@\"",
  pg_restore: [
    "#!/bin/sh",
    'case "$1" in',
    '  --version) echo "pg_restore (PostgreSQL) 17.6" ;;',
    '  --list) echo "1; 0 0 TABLE DATA public snapshot fixture" ;;',
    "esac",
  ].join("\n"),
}

/** Every call goes to the real sqlite3, except the one query a case fakes, or a pre-3.37.0 sqlite3. */
const fakeSqlite = (real: string) =>
  [
    "#!/bin/sh",
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

// The exact SQL verify_sqlite sends, for the faked answers.
const TABLE_COUNT = "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"
const LISTING = "SELECT replace(name, char(10), '<LF>') FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"
const ROW_COUNT_GOOD = 'SELECT count(*) FROM "good";'

let BIN = ""
let FAKE_SQLITE_BIN = ""
const TMP_DIRS: string[] = []

function sqlite(db: string, sql: string, home: string) {
  const r = spawnSync(SQLITE, [db, sql], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home } })
  if (r.status !== 0) throw new Error(`sqlite3 fixture build failed: ${r.stderr || r.stdout}`)
}

/**
 * A snapshot the way the box makes one: a WAL-mode database, copied with `.backup`. The copy keeps
 * the WAL header and has no -wal/-shm beside it; the source (and any side files it keeps) stays in
 * its own directory, away from the box.
 */
function walSnapshot(dir: string, dest: string, sql: string) {
  const src = mkdtempSync(join(dir, "src-"))
  sqlite(join(src, "live.db"), `PRAGMA journal_mode=WAL;\n${sql}`, dir)
  sqlite(join(src, "live.db"), `.backup '${dest}'`, dir)
  const header = readFileSync(dest).subarray(18, 20)
  expect([...header], "the fixture is not a WAL-mode file (header bytes 18-19)").toEqual([2, 2])
  for (const side of ["-wal", "-shm", "-journal"]) expect(existsSync(dest + side), `${dest}${side}`).toBe(false)
}

type RunOpts = {
  /** SQL for the bot snapshot's schema; gets the run's temp dir. Default: one table, three rows. */
  botSql?: (dir: string) => string
  /** The bot snapshot's file name on the box, and its raw bytes when it is not a database at all. */
  botName?: string
  botBytes?: string
  /** Files already in the Mac's dest before the run. */
  seedDest?: (dest: string, dir: string) => void
  env?: Record<string, string>
  /** Puts the fake sqlite3 first on PATH; its answer gets the run's temp dir. */
  fake?: { env: Record<string, string>; output?: (dir: string) => string }
}

function run(opts: RunOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pull-backups-vsql-"))
  TMP_DIRS.push(dir)
  const box = join(dir, "box")
  const dest = join(dir, "dest")
  mkdirSync(dest)
  const now = Math.floor(Date.now() / 1000)
  for (const leg of Object.values(LEGS)) mkdirSync(join(box, leg.dir), { recursive: true })

  // postgres: opaque bytes; the fake pg_restore does not read them.
  const pg = join(box, LEGS.postgres.dir, LEGS.postgres.name)
  writeFileSync(pg, "PGDMP fixture\n")
  utimesSync(pg, now - 60, now - 60)

  const bot = join(box, LEGS["bot-sqlite"].dir, opts.botName ?? LEGS["bot-sqlite"].name)
  if (opts.botBytes !== undefined) writeFileSync(bot, opts.botBytes)
  else walSnapshot(dir, bot, opts.botSql?.(dir) ?? "CREATE TABLE good(a); INSERT INTO good VALUES(1),(2),(3);")
  utimesSync(bot, now - 60, now - 60)

  // meme-grid: a clean snapshot, to show a good SQLite leg still verifies beside a bad one.
  const mg = join(box, LEGS["meme-grid-sqlite"].dir, LEGS["meme-grid-sqlite"].name)
  walSnapshot(dir, mg, "CREATE TABLE rolls(a); INSERT INTO rolls VALUES(1),(2);")
  utimesSync(mg, now - 60, now - 60)

  opts.seedDest?.(dest, dir)

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: dir, // no ~/.sqliterc
    PATH: `${opts.fake ? `${FAKE_SQLITE_BIN}:` : ""}${BIN}:${process.env.PATH}`,
    GUILD_VPS_SSH: HOST,
    FAKE_BOX: box,
    PG_RESTORE: join(BIN, "pg_restore"),
    MEMEGRID_BACKUP_DIR: LEGS["meme-grid-sqlite"].dir,
    MEMEGRID_PULL_COUNT: "7",
    ...opts.env,
    ...opts.fake?.env,
  }
  if (opts.fake?.output) {
    writeFileSync(join(dir, "fake-output"), opts.fake.output(dir))
    env.FAKE_SQLITE_OUTPUT_FILE = join(dir, "fake-output")
  }
  const r = spawnSync("bash", [SCRIPT, "--dest", dest], { encoding: "utf8", timeout: 25_000, env })
  return { status: r.status, out: `${r.stdout}${r.stderr}`, dir, box, dest }
}

function section(out: string, label: string): string {
  const start = out.indexOf(`=== ${label} ===`)
  expect(start, `no "=== ${label} ===" block in:\n${out}`).toBeGreaterThan(-1)
  return out.slice(start, out.indexOf("\n===", start + 1))
}
const summaryOf = (out: string) => out.slice(out.indexOf("=== summary ==="))
const sha256 = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex")
/** Side files beside anything in dest: -wal, -shm, -journal. */
const sideFiles = (dest: string) => readdirSync(dest).filter((f) => /-(wal|shm|journal)$/.test(f))
/** Any C0 control character but newline and tab, or DEL. */
const hasControl = (s: string) =>
  [...s].some((c) => {
    const n = c.charCodeAt(0)
    return (n < 0x20 && n !== 0x0a && n !== 0x09) || n === 0x7f
  })
const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const OUTSIDE = "FAILED: table name outside [A-Za-z_][A-Za-z0-9_]* — refusing to run SQL on a suspect backup: "

/** The bot leg FAILED (and so the run), nothing control-coded reached the output, no side file appeared. */
function expectBotFailed(r: ReturnType<typeof run>, says: RegExp) {
  const block = section(r.out, "bot-sqlite")
  expect(block, r.out).toMatch(says)
  expect(block).not.toContain("verified (integrity ok")
  expect(summaryOf(r.out)).toContain(`${LEGS["bot-sqlite"].name} — FAILED`)
  expect(r.status).toBe(1)
  expect(hasControl(r.out), JSON.stringify(r.out)).toBe(false)
  expect(sideFiles(r.dest)).toEqual([])
}

describe.skipIf(PRIV.skip || !HAVE_SQLITE)("pull-backups.sh verify_sqlite opens the box's snapshots read-only, safe and immutable", () => {
  beforeAll(() => {
    BIN = mkdtempSync(join(tmpdir(), "pull-backups-vsql-bin-"))
    FAKE_SQLITE_BIN = mkdtempSync(join(tmpdir(), "pull-backups-vsql-fake-"))
    TMP_DIRS.push(BIN, FAKE_SQLITE_BIN)
    for (const [name, body] of Object.entries(STUBS)) {
      writeFileSync(join(BIN, name), `${body}\n`)
      chmodSync(join(BIN, name), 0o755)
    }
    writeFileSync(join(FAKE_SQLITE_BIN, "sqlite3"), `${fakeSqlite(SQLITE)}\n`)
    chmodSync(join(FAKE_SQLITE_BIN, "sqlite3"), 0o755)
  })

  afterAll(() => {
    for (const d of TMP_DIRS) rmSync(d, { recursive: true, force: true })
  })

  it("a WAL-mode snapshot, as the box makes it, verifies, and no -wal/-shm appears beside it", () => {
    // Plain -readonly cannot open this shape on macOS's sqlite3 ("unable to open database file"),
    // and on a stock sqlite3 it leaves -wal and -shm behind; immutable=1 does neither.
    const r = run()
    expect(section(r.out, "bot-sqlite"), r.out).toContain("verified (integrity ok, 3 rows)")
    expect(section(r.out, "meme-grid-sqlite")).toContain("verified (integrity ok, 2 rows)")
    expect(summaryOf(r.out)).toContain(`${LEGS["bot-sqlite"].name} — verified`)
    expect(r.status).toBe(0)
    expect(sideFiles(r.dest)).toEqual([])
    // Verification wrote nothing: each pulled copy is still the box's bytes.
    for (const leg of [LEGS["bot-sqlite"], LEGS["meme-grid-sqlite"]]) {
      expect(sha256(join(r.dest, leg.name))).toBe(sha256(join(r.box, leg.dir, leg.name)))
    }
  })

  it("a snapshot already here with the -wal/-shm main's read-write verify left beside it verifies, and they stay as they were", () => {
    // ~/guild-backups after main's verify_sqlite: it opened each pulled snapshot read-write, and this
    // Mac's sqlite3 keeps the -wal/-shm that made. immutable=1 neither reads nor touches them.
    const before: Record<string, [string, number]> = {}
    const r = run({
      seedDest: (dest, dir) => {
        const local = join(dest, LEGS["bot-sqlite"].name)
        writeFileSync(local, readFileSync(join(dir, "box", LEGS["bot-sqlite"].dir, LEGS["bot-sqlite"].name)))
        sqlite(local, "PRAGMA integrity_check;", dir) // read-write, as main verified it
        for (const f of readdirSync(dest)) before[f] = [sha256(join(dest, f)), statSync(join(dest, f)).mtimeMs]
      },
    })
    const block = section(r.out, "bot-sqlite")
    expect(block, r.out).toContain(`already local, checksum matches: ${LEGS["bot-sqlite"].name}`)
    expect(block).toContain("verified (integrity ok, 3 rows)")
    expect(r.status).toBe(0)
    for (const [f, [hash, mtime]] of Object.entries(before)) {
      expect(sha256(join(r.dest, f)), f).toBe(hash)
      expect(statSync(join(r.dest, f)).mtimeMs, f).toBe(mtime)
    }
  })

  it("a database with no tables verifies with 0 rows: an empty listing is not an empty name", () => {
    const r = run({ botSql: () => "" })
    expect(section(r.out, "bot-sqlite"), r.out).toContain("verified (integrity ok, 0 rows)")
    expect(r.status).toBe(0)
  })

  it("the table filter is the box's own, `name NOT LIKE 'sqlite_%'`: a table named sqlitex is left out, as there", () => {
    // `_` is a LIKE wildcard, so the filter also drops sqlite<any char>…, not only sqlite_…; the box's
    // guild-bot-db-backup.sh and restore-drill.sh use it so, and the Mac must count the same tables.
    const r = run({ botSql: () => "CREATE TABLE good(a); INSERT INTO good VALUES(1),(2),(3);\nCREATE TABLE sqlitex(b); INSERT INTO sqlitex VALUES(1),(2);" })
    expect(section(r.out, "bot-sqlite"), r.out).toContain("verified (integrity ok, 3 rows)")
    expect(r.status).toBe(0)
  })

  it("a table name carrying a VACUUM INTO injection is a verification FAILURE, and nothing is written", () => {
    // The name begins with a REAL table ("members"), so the spliced `SELECT count(*) FROM "members"`
    // would succeed and sqlite3 go on to the injected `VACUUM INTO`: absent the fix this payload
    // WRITES the marker and still reports "verified". The fix refuses the name before any SQL runs,
    // and -safe would refuse VACUUM INTO even if it reached sqlite3.
    const r = run({
      botSql: (dir) =>
        `CREATE TABLE members(a); INSERT INTO members VALUES(1),(2);\n` +
        `CREATE TABLE "members"";VACUUM INTO '${join(dir, "INJECTED_MARKER.db")}';--"(c);`,
    })
    expectBotFailed(r, new RegExp(re(`${OUTSIDE}"members";VACUUM INTO '${join(r.dir, "INJECTED_MARKER.db")}';--"`)))
    expect(existsSync(join(r.dir, "INJECTED_MARKER.db")), "the payload wrote its file").toBe(false)
    // The dest holds only the pulled snapshots, never an ATTACH/VACUUM INTO artefact or a side file.
    const unexpected = readdirSync(r.dest).filter((f) => !/^(guild_db_|guild_bot_|meme-grid-)[^/]*\.(db|dump)$/.test(f))
    expect(unexpected, `unexpected files in dest: ${unexpected.join(", ")}`).toEqual([])
    expect(summaryOf(r.out)).toContain(`${LEGS["meme-grid-sqlite"].name} — verified`)
  })

  it("a line break that splits a name into two real tables FAILS (it read as both, counted twice)", () => {
    const r = run({
      botSql: () =>
        `CREATE TABLE members(a); INSERT INTO members VALUES(1),(2); CREATE TABLE votes(b); INSERT INTO votes VALUES(3);\n` +
        `CREATE TABLE "members\nvotes"(c);`,
    })
    expectBotFailed(r, new RegExp(re(`${OUTSIDE}"members<LF>votes"`)))
  })

  it("an empty table name FAILS (it used to be skipped as a blank line)", () => {
    // Listed before "good", so its line is a blank one in the middle of the listing.
    const r = run({ botSql: () => `CREATE TABLE ""(c);\nCREATE TABLE good(a); INSERT INTO good VALUES(1);` })
    expectBotFailed(r, new RegExp(re(`${OUTSIDE}""`)))
  })

  it("an empty table name listed LAST FAILS: $(…) drops its line, so the listing no longer adds up", () => {
    const r = run({ botSql: () => `CREATE TABLE good(a); INSERT INTO good VALUES(1);\nCREATE TABLE ""(c);` })
    expectBotFailed(
      r,
      /FAILED: 1 table names listed for 2 tables — refusing to count rows in a schema that does not add up/,
    )
  })

  it("terminal control sequences in a name reach pull.log printable, never raw", () => {
    const r = run({ botSql: () => `CREATE TABLE "x\u001b]0;owned\u0007\u001b[31mred"(c);` })
    // sqlite3 3.50+ prints control characters as ^X itself; older ones print them raw and the
    // script replaces each with ?.
    expectBotFailed(r, new RegExp(`${re(OUTSIDE)}"x(\\?|\\^\\[)\\]0;owned(\\?|\\^G)(\\?|\\^\\[)\\[31mred"`))
  })

  it("a non-ASCII letter FAILS under a UTF-8 locale too (bash 3.2 matches é in [A-Za-z] there)", () => {
    const utf8 = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8"
    const r = run({
      botSql: () => `CREATE TABLE "café"(c); INSERT INTO "café" VALUES(1);`,
      env: { LC_ALL: utf8, LANG: utf8 },
    })
    expectBotFailed(r, new RegExp(re(`${OUTSIDE}"caf`)))
  })

  describe("a file name a file: URI would misread is verified as ITSELF, never as the file it would name", () => {
    // A clean snapshot pulled yesterday sits in dest with the -wal/-shm the old read-write verify
    // left beside it. Tonight the box's newest is a NON-database whose name, put in a URI unencoded,
    // names yesterday's file: `#` ends the URI, `?` starts its query, `%31` decodes to `1`.
    const CLEAN = "guild_bot_20261001.db"
    const seed = (dest: string, dir: string) => {
      walSnapshot(dir, join(dest, CLEAN), "CREATE TABLE good(a); INSERT INTO good VALUES(1),(2),(3),(4),(5);")
      sqlite(join(dest, CLEAN), "PRAGMA integrity_check;", dir) // read-write, as main verified it
    }
    it.each([
      ["#", `${CLEAN}#.db`],
      ["?", `${CLEAN}?immutable=1&x=.db`],
      ["%", "guild_bot_2026100%31.db"],
    ])("a name with %s", (_ch, name) => {
      const r = run({ botName: name, botBytes: "not a database, just bytes from the box\n", seedDest: seed })
      const block = section(r.out, "bot-sqlite")
      expect(block, r.out).toContain(`pulling ${name}`)
      expect(block).toMatch(/FAILED integrity_check: .*not a database/)
      expect(block).not.toContain("verified (integrity ok")
      expect(r.status).toBe(1)
    })

    it("and yesterday's file, with its side files, is left exactly as it was", () => {
      const before: Record<string, [string, number]> = {}
      const r = run({
        botName: `${CLEAN}#.db`,
        botBytes: "not a database\n",
        seedDest: (dest, dir) => {
          seed(dest, dir)
          for (const f of readdirSync(dest)) before[f] = [sha256(join(dest, f)), statSync(join(dest, f)).mtimeMs]
        },
      })
      expect(Object.keys(before).length).toBeGreaterThan(0)
      for (const [f, [hash, mtime]] of Object.entries(before)) {
        expect(sha256(join(r.dest, f)), f).toBe(hash)
        expect(statSync(join(r.dest, f)).mtimeMs, f).toBe(mtime)
      }
    })
  })

  describe("a count must be digits before shell arithmetic sees it; text read out of the file is printable", () => {
    it("a row count that is an expression (1+1) FAILS, not evaluated", () => {
      const r = run({ fake: { env: { FAKE_SQLITE_MATCH: ROW_COUNT_GOOD }, output: () => "1+1\n" } })
      expectBotFailed(r, /FAILED: non-numeric row count for table good: 1\+1/)
    })

    it("a row count that would run a command inside $(( )) FAILS, and the command never runs", () => {
      const r = run({
        fake: { env: { FAKE_SQLITE_MATCH: ROW_COUNT_GOOD }, output: (dir) => `a[$(touch ${join(dir, "ARITH-INJECTED")})]\n` },
      })
      expectBotFailed(r, new RegExp(re(`FAILED: non-numeric row count for table good: a[$(touch ${join(r.dir, "ARITH-INJECTED")})]`)))
      expect(existsSync(join(r.dir, "ARITH-INJECTED")), "shell arithmetic ran the payload").toBe(false)
    })

    it("a count too long for 64-bit arithmetic FAILS, and the line is capped", () => {
      const r = run({ fake: { env: { FAKE_SQLITE_MATCH: ROW_COUNT_GOOD }, output: () => `${"9".repeat(5000)}\n` } })
      expectBotFailed(r, /FAILED: non-numeric row count for table good: 9{200}\.\.\.\(5000 chars\)\n/)
    })

    it("a table count that is not a number FAILS", () => {
      const r = run({ fake: { env: { FAKE_SQLITE_MATCH: TABLE_COUNT }, output: () => "1+0\n" } })
      expectBotFailed(r, /FAILED: the table count is not a number: 1\+0/)
    })

    it("a failing integrity_check line with control characters reaches pull.log printable", () => {
      const r = run({
        fake: { env: { FAKE_SQLITE_MATCH: "PRAGMA integrity_check;" }, output: () => "row 1 missing from index \u001b[31midx\u0007\n" },
      })
      expectBotFailed(r, /FAILED integrity_check: row 1 missing from index \?\[31midx\?/)
    })

    it("a name with RAW control characters (sqlite3 before 3.50 prints them so) reaches pull.log printable", () => {
      const r = run({ fake: { env: { FAKE_SQLITE_MATCH: LISTING }, output: () => "x\u001b]0;owned\u0007\u001b[31mred\n" } })
      expectBotFailed(r, new RegExp(re(`${OUTSIDE}"x?]0;owned??[31mred"`)))
    })
  })

  it("an sqlite3 without -safe (before 3.37.0) is UNVERIFIED, never opened read-write, and pages as FAILED", () => {
    const r = run({ fake: { env: { FAKE_SQLITE_OLD: "1" } } })
    const line = "UNVERIFIED (local sqlite3 3.31.1 refuses -readonly -safe, which needs 3.37.0+; the file was not opened)"
    expect(section(r.out, "bot-sqlite"), r.out).toContain(line)
    expect(section(r.out, "meme-grid-sqlite")).toContain(line)
    expect(r.status).toBe(1)
    expect(sideFiles(r.dest)).toEqual([])
    // The launchd wrapper's own classifier pages it like a failed verification, naming the cause.
    const c = spawnSync("bash", [WRAPPER, "--classify", "1"], {
      input: r.out,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, HOME: r.dir, GUILD_BACKUP_DEST: r.dest },
    })
    expect(c.status, c.stderr).toBe(0)
    const [title, detail] = c.stdout.split("\n")
    expect(title).toBe("Guild backup pull FAILED")
    expect(detail.trim()).toBe(line)
  })
})
