/**
 * launch-check CHECK 10 — the escrow keeper stays watch-only.
 *
 * The keeper would sign auto_resolve_dispute on the live escrow given three
 * persisted settings: `--apply` on its cron line, GUILD_ALLOW_LIVE_DISPUTE, and
 * a KEEPER_PRIVATE_KEY (bun loads guild-app/'s dotenv files into every run).
 * Found by the 2026-09-26 sweep: CHECK 6 guarded the auth-bypass flag this way,
 * and nothing guarded these.
 *
 * Three layers: the pure rules (scripts/lib/keeper-fuse.mjs), the CLI that
 * gathers real inputs, and the gate itself run end to end against an empty
 * candidate directory, so a mis-wired FAIL → warn in the bash is caught too.
 */
import { describe, it, expect, afterEach } from "vitest"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { privateInputs } from "../support/private-input"

// scripts/lib/keeper-fuse.mjs, scripts/keeper-fuse-check.mjs and
// scripts/launch-check.sh all stay EXCLUDE at the open-source flip, so this
// whole file skips in the public export and still runs (throwing if an
// input vanishes for any other reason) in the private tree.
const PRIV = privateInputs("guild-app/scripts/lib/keeper-fuse.mjs", "guild-app/scripts/keeper-fuse-check.mjs", "guild-app/scripts/launch-check.sh")
// A variable specifier (not a string literal) keeps Vite's import analyzer
// from resolving this at transform time in the public export, where the
// file doesn't exist — a literal `import("../../scripts/lib/keeper-fuse.mjs")`
// fails to build even inside the PRIV.skip branch.
const KEEPER_FUSE_SPEC = "../../scripts/lib/keeper-fuse.mjs"
const keeperFuseMod = PRIV.skip ? null : await import(/* @vite-ignore */ KEEPER_FUSE_SPEC)
const armingVarsInDotenv: any = (keeperFuseMod as any)?.armingVarsInDotenv
const scanCron: any = (keeperFuseMod as any)?.scanCron
const keeperFuseVerdict: any = (keeperFuseMod as any)?.keeperFuseVerdict

const SECRET = "SENTINEL_KEY_VALUE_9f3a"
const BOX_LINE =
  "*/30 * * * * cd /opt/guild-saas/guild-app && /root/.bun/bin/bun scripts/keeper.mjs >> /var/log/guild-keeper.log 2>&1"
const RECONCILE_LINE = "15,45 * * * * cd /opt/guild-saas/guild-app && bash scripts/reconcile-cron.sh --apply >> /var/log/guild-reconcile.log 2>&1"

describe.skipIf(PRIV.skip)("armingVarsInDotenv", () => {
  it("finds a non-empty assignment in any dotenv shape", () => {
    expect(armingVarsInDotenv("GUILD_ALLOW_LIVE_DISPUTE=1")).toEqual(["GUILD_ALLOW_LIVE_DISPUTE"])
    expect(armingVarsInDotenv(`export KEEPER_PRIVATE_KEY="${SECRET}"`)).toEqual(["KEEPER_PRIVATE_KEY"])
    expect(armingVarsInDotenv("  GUILD_ALLOW_LIVE_DISPUTE = 'true'  # temp")).toEqual(["GUILD_ALLOW_LIVE_DISPUTE"])
    // "0" is still set: nothing legitimate persists it on a box that serves users
    expect(armingVarsInDotenv("GUILD_ALLOW_LIVE_DISPUTE=0")).toEqual(["GUILD_ALLOW_LIVE_DISPUTE"])
  })

  it("🔴 a CRLF file (edited on Windows, or by a tool that keeps CRLF) hides nothing", () => {
    expect(armingVarsInDotenv(`KEEPER_PRIVATE_KEY=${SECRET}\r\nOTHER=1\r\n`)).toEqual(["KEEPER_PRIVATE_KEY"])
    expect(scanCron(`GUILD_ALLOW_LIVE_DISPUTE=1\r\n${BOX_LINE.replace("keeper.mjs", "keeper.mjs --apply")}\r\n`)).toEqual({
      keeperLines: 1,
      apply: 1,
      vars: ["GUILD_ALLOW_LIVE_DISPUTE"],
    })
  })

  it("ignores empty values, comments and every other variable", () => {
    expect(armingVarsInDotenv('KEEPER_PRIVATE_KEY=\nGUILD_ALLOW_LIVE_DISPUTE=""\nKEEPER_PRIVATE_KEY= # later')).toEqual([])
    expect(armingVarsInDotenv("# GUILD_ALLOW_LIVE_DISPUTE=1")).toEqual([])
    expect(armingVarsInDotenv("KEEPER_ALERT_TG_TOKEN=abc\nKEEPER_ACCOUNT_ADDRESS=account_rdx1x")).toEqual([])
  })
})

describe.skipIf(PRIV.skip)("scanCron", () => {
  it("the line installed on the box today is one watch-only keeper line", () => {
    expect(scanCron(`# guild escrow keeper\n${BOX_LINE}\n${RECONCILE_LINE}`)).toEqual({ keeperLines: 1, apply: 0, vars: [] })
  })

  it("--apply counts only on the keeper's own command, not a neighbour's", () => {
    expect(scanCron(BOX_LINE.replace("keeper.mjs", "keeper.mjs --apply")).apply).toBe(1)
    // 🔴 the shell strips the quotes, so keeper.mjs still sees --apply
    expect(scanCron(BOX_LINE.replace("keeper.mjs", 'keeper.mjs "--apply"')).apply).toBe(1)
    expect(scanCron(BOX_LINE.replace("keeper.mjs", "keeper.mjs '--apply'")).apply).toBe(1)
    expect(scanCron(`${BOX_LINE.replace(" >>", " && bun scripts/reconcile-escrow.mjs --apply >>")}`).apply).toBe(0)
    expect(scanCron(`# ${BOX_LINE.replace("keeper.mjs", "keeper.mjs --apply")}`)).toEqual({ keeperLines: 0, apply: 0, vars: [] })
  })

  it("finds an arming var as a cron env line or inline on any command; empty is unset", () => {
    expect(scanCron(`GUILD_ALLOW_LIVE_DISPUTE=1\n${BOX_LINE}`).vars).toEqual(["GUILD_ALLOW_LIVE_DISPUTE"])
    expect(scanCron(BOX_LINE.replace("&& /root", `&& KEEPER_PRIVATE_KEY=${SECRET} /root`)).vars).toEqual(["KEEPER_PRIVATE_KEY"])
    expect(scanCron(`KEEPER_PRIVATE_KEY=""\n${BOX_LINE}`).vars).toEqual([])
  })
})

describe.skipIf(PRIV.skip)("keeperFuseVerdict", () => {
  const clean = { dotenvs: [{ file: ".env.local", text: "KEEPER_ALERT_TG_CHAT=1" }], crons: [{ source: "crontab", text: BOX_LINE }], shell: {} }

  it("PASS only when every source was read and none arms the keeper", () => {
    const v = keeperFuseVerdict(clean)
    expect(v.map((l: { level: string }) => l.level)).toEqual(["PASS"])
  })

  it("FAILs on each of the three, naming where — and never printing a value", () => {
    const v = keeperFuseVerdict({
      dotenvs: [{ file: ".env.local", text: `KEEPER_PRIVATE_KEY=${SECRET}` }],
      crons: [{ source: "crontab", text: BOX_LINE.replace("keeper.mjs", "keeper.mjs --apply") }],
      shell: { GUILD_ALLOW_LIVE_DISPUTE: SECRET },
    })
    expect(v.every((l: { level: string }) => l.level === "FAIL")).toBe(true)
    const text = v.map((l: { message: string }) => l.message).join("\n")
    expect(text).toMatch(/KEEPER_PRIVATE_KEY is set in guild-app\/\.env\.local/)
    expect(text).toMatch(/--apply/)
    expect(text).toMatch(/GUILD_ALLOW_LIVE_DISPUTE is exported in this shell/)
    expect(text).not.toContain(SECRET)
  })

  it("WARNs — never PASSes — when the cron could not be read or has no keeper line", () => {
    expect(keeperFuseVerdict({ ...clean, crons: null })[0].level).toBe("WARN")
    expect(keeperFuseVerdict({ ...clean, crons: [{ source: "crontab", text: RECONCILE_LINE }] })[0].level).toBe("WARN")
  })
})

describe.skipIf(PRIV.skip)("scripts/keeper-fuse-check.mjs and launch-check CHECK 10, end to end", () => {
  const APP = process.cwd()
  const tmp: string[] = []
  afterEach(() => {
    for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const cronFile = (text: string) => {
    const d = mkdtempSync(join(tmpdir(), "keeper-fuse-"))
    tmp.push(d)
    writeFileSync(join(d, "crontab"), text)
    return join(d, "crontab")
  }

  it("the CLI reads the app's dotenv files and prints names only", () => {
    const app = mkdtempSync(join(tmpdir(), "keeper-fuse-app-"))
    tmp.push(app)
    writeFileSync(join(app, ".env.local"), `KEEPER_PRIVATE_KEY=${SECRET}\n`)
    const out = execFileSync("node", ["scripts/keeper-fuse-check.mjs", app], {
      encoding: "utf8",
      env: { ...process.env, KEEPER_FUSE_CRONTAB_FILE: cronFile(BOX_LINE), GUILD_ALLOW_LIVE_DISPUTE: "", KEEPER_PRIVATE_KEY: "" },
    })
    expect(out).toBe("FAIL\tKEEPER_PRIVATE_KEY is set in guild-app/.env.local — bun loads it into every keeper run\n")
    expect(out).not.toContain(SECRET)
  })

  // The gate runs every check even after failures, so an EMPTY candidate dir
  // (checks 1–5 fail on it, 7–9 skip the chain) still reaches CHECK 10.
  let runs = 0
  const runGate = (crontab: string) => {
    const dist = `.next-keeper-fuse-test-${process.pid}-${++runs}`
    mkdirSync(join(APP, dist))
    tmp.push(join(APP, dist))
    const r = spawnSync("bash", ["scripts/launch-check.sh"], {
      cwd: APP,
      encoding: "utf8",
      env: {
        ...process.env,
        LAUNCH_CHECK_DIST_DIR: dist,
        LAUNCH_CHECK_SKIP_CHAIN: "1",
        KEEPER_FUSE_CRONTAB_FILE: cronFile(crontab),
        GUILD_ALLOW_LIVE_DISPUTE: "",
        KEEPER_PRIVATE_KEY: "",
      },
    })
    const all = r.stdout + r.stderr
    // CHECK 10's own block only: CHECK 11 (the kit hash, S1) follows it and FAILS
    // on this empty candidate by design — there is no packed kit to compare.
    const from = all.indexOf("CHECK 10")
    const next = all.indexOf("CHECK 11", from)
    return all.slice(from, next === -1 ? all.indexOf("LAUNCH CHECK") : next)
  }

  it("an armed cron turns CHECK 10 red; the box's real line passes it", () => {
    const armed = runGate(BOX_LINE.replace("keeper.mjs", "keeper.mjs --apply"))
    expect(armed).toMatch(/FAIL\S*\s+the keeper cron runs with --apply/)
    expect(armed).not.toMatch(/PASS/)
    const clean = runGate(BOX_LINE)
    expect(clean).toMatch(/PASS\S*\s+keeper is watch-only: 1 cron line/)
    expect(clean).not.toMatch(/FAIL/)
  }, 60_000)
})
