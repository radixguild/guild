/**
 * launch-check CHECK 6 — the e2e auth bypass is not armed in a deploy.
 *
 * src/lib/rola.ts skips the ROLA signature check on the sign-in route only when
 * GUILD_E2E_BUILD === "1" (inlined at `next build` via next.config.ts `env`)
 * AND GUILD_E2E_AUTH_BYPASS === "1" (read at runtime). CHECK 6 is the deploy-time
 * interlock: it must FAIL when either variable is set in a dotenv file, the
 * deploying shell or pm2's saved env, and when the build itself was compiled
 * with anything but GUILD_E2E_BUILD="" (read from required-server-files.json).
 *
 * Run end to end, the way keeper-fuse.test.ts runs CHECK 10 — but from a COPY
 * of the gate in a scratch app directory. The gate cd's to its own app dir and
 * scans the dotenv files there, and a test must never write a dotenv file into
 * the real guild-app/ (it could clobber a developer's .env.local). `pm2` is a
 * stub on PATH that prints a fixture process list, so the real pm2 of whatever
 * machine runs this is never consulted. Other checks fail on the scratch dir by
 * design; only CHECK 6's block is judged.
 */
import { describe, it, expect, afterEach } from "vitest"
import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { privateInputs } from "../support/private-input"

// guild-app/scripts/launch-check.sh stays EXCLUDE at the open-source flip
// (publish/MANIFEST.md), so this whole file skips when it is absent.
const PRIV = privateInputs("guild-app/scripts/launch-check.sh")
const APP = process.cwd()

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** `nested`: put the variables only in pm2_env.env (pm2 also keeps the process env there), not at pm2_env's top level. */
type Pm2 = "none" | { app?: string; env: Record<string, string>; nested?: boolean }

interface Scenario {
  /** dotenv files to write into the scratch app dir, by name */
  dotenv?: Record<string, string>
  /** extra variables exported into the gate's own shell */
  shell?: Record<string, string>
  /** what the stub pm2 reports; "none" = no pm2 on PATH at all */
  pm2?: Pm2
  /** config.env as the build recorded it; "missing" = no required-server-files.json */
  builtEnv?: Record<string, string> | "missing"
}

function runCheck6({ dotenv = {}, shell = {}, pm2 = { env: {} }, builtEnv = { GUILD_E2E_BUILD: "" } }: Scenario): string {
  const app = mkdtempSync(join(tmpdir(), "lc-e2e-bypass-"))
  tmp.push(app)
  mkdirSync(join(app, "scripts"))
  copyFileSync(join(APP, "scripts/launch-check.sh"), join(app, "scripts/launch-check.sh"))

  const dist = ".next-e2e-bypass-test"
  mkdirSync(join(app, dist))
  if (builtEnv !== "missing") {
    writeFileSync(join(app, dist, "required-server-files.json"), JSON.stringify({ version: 1, config: { env: builtEnv } }))
  }
  for (const [name, text] of Object.entries(dotenv)) writeFileSync(join(app, name), text)

  const bin = join(app, "bin")
  mkdirSync(bin)
  if (pm2 !== "none") {
    const pm2Env = pm2.nested ? { status: "online", env: pm2.env } : { status: "online", ...pm2.env }
    const list = [{ name: pm2.app ?? "guild-saas-app", pm2_env: pm2Env }]
    writeFileSync(join(app, "jlist.json"), JSON.stringify(list))
    writeFileSync(join(bin, "pm2"), `#!/bin/sh\n[ "$1" = "jlist" ] && cat "${join(app, "jlist.json")}"\n`)
    chmodSync(join(bin, "pm2"), 0o755)
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    // node's own dir + the system dirs: finds bash/grep/node, and a pm2 only if stubbed.
    PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    LAUNCH_CHECK_DIST_DIR: dist,
    LAUNCH_CHECK_SKIP_CHAIN: "1",
    GUILD_ALLOW_LIVE_DISPUTE: "",
    KEEPER_PRIVATE_KEY: "",
    ...shell,
  }
  for (const k of ["GUILD_E2E_BUILD", "GUILD_E2E_AUTH_BYPASS", "PM2_APP_NAME"]) {
    if (!(k in shell)) delete env[k]
  }

  const r = spawnSync("bash", [join(app, "scripts/launch-check.sh")], { cwd: app, encoding: "utf8", env })
  const all = r.stdout + r.stderr
  const from = all.indexOf("CHECK 6")
  expect(from, "CHECK 6 ran").toBeGreaterThan(-1)
  const to = all.indexOf("CHECK 7", from)
  return all.slice(from, to === -1 ? undefined : to)
}

describe.skipIf(PRIV.skip)("launch-check CHECK 6 — the e2e auth bypass, end to end", () => {
  it("PASSes a clean box: build compiled \"\", no dotenv/shell/pm2 hit", () => {
    const out = runCheck6({ dotenv: { ".env.local": "DATABASE_URL=postgres://x\nGUILD_E2E_BUILD=\nGUILD_E2E_AUTH_BYPASS=\"\"\n# GUILD_E2E_BUILD=1\n" } })
    expect(out).toMatch(/PASS\S*\s+\S+ compiled GUILD_E2E_BUILD as ""/)
    expect(out).not.toMatch(/FAIL/)
  }, 60_000)

  it("FAILs on GUILD_E2E_BUILD in a dotenv file — next build loads it despite deploy.sh's env -u", () => {
    const out = runCheck6({ dotenv: { ".env.local": "GUILD_E2E_BUILD=1\n" } })
    expect(out).toMatch(/FAIL\S*\s+the e2e auth bypass is armed: GUILD_E2E_BUILD@\.env\.local/)
    expect(out).not.toMatch(/PASS/)
  }, 60_000)

  it("FAILs on every dotenv shape that assigns a value, in every file Next loads", () => {
    for (const [file, text] of [
      [".env", 'export GUILD_E2E_BUILD="1"\n'],
      [".env.production", "  GUILD_E2E_AUTH_BYPASS = 'true'  # temp\n"],
      [".env.production.local", "GUILD_E2E_BUILD=0\r\nOTHER=1\r\n"],
      [".env.local", "GUILD_E2E_AUTH_BYPASS=1\n"],
    ]) {
      const out = runCheck6({ dotenv: { [file]: text } })
      expect(out, `${file}: ${JSON.stringify(text)}`).toMatch(/FAIL\S*\s+the e2e auth bypass is armed:/)
      expect(out, file).toContain(`@${file}`)
    }
  }, 120_000)

  it("FAILs on either variable exported in the deploying shell", () => {
    for (const v of ["GUILD_E2E_BUILD", "GUILD_E2E_AUTH_BYPASS"]) {
      const out = runCheck6({ shell: { [v]: "1" } })
      expect(out, v).toMatch(new RegExp(`FAIL\\S*\\s+the e2e auth bypass is armed: ${v}@<exported-in-this-shell>`))
    }
  }, 60_000)

  it("FAILs on either variable in pm2's saved env for the app, naming the process", () => {
    for (const v of ["GUILD_E2E_BUILD", "GUILD_E2E_AUTH_BYPASS"]) {
      const out = runCheck6({ pm2: { env: { [v]: "1" } } })
      expect(out, v).toMatch(new RegExp(`FAIL\\S*\\s+the e2e auth bypass is armed: ${v}@<pm2-env-of-guild-saas-app>`))
    }
  }, 60_000)

  it("FAILs when pm2 holds the variable only in the nested pm2_env.env object", () => {
    for (const v of ["GUILD_E2E_BUILD", "GUILD_E2E_AUTH_BYPASS"]) {
      const out = runCheck6({ pm2: { env: { [v]: "1" }, nested: true } })
      expect(out, v).toMatch(new RegExp(`FAIL\\S*\\s+the e2e auth bypass is armed: ${v}@<pm2-env-of-guild-saas-app>`))
    }
    // and a nested env that carries neither variable is still a clean pass
    const clean = runCheck6({ pm2: { env: { NODE_ENV: "production" }, nested: true } })
    expect(clean).toMatch(/PASS/)
    expect(clean).not.toMatch(/FAIL/)
  }, 60_000)

  it("FAILs on a build COMPILED with GUILD_E2E_BUILD set, even when every runtime source is clean", () => {
    const out = runCheck6({ builtEnv: { GUILD_E2E_BUILD: "1" } })
    expect(out).toMatch(/FAIL\S*\s+the e2e auth bypass is armed: GUILD_E2E_BUILD@<compiled-into-\.next-e2e-bypass-test>/)
    expect(out).not.toMatch(/PASS/)
  }, 60_000)

  it("FAILs when the build does not declare the flag at all (interlock 1 missing) or cannot be read", () => {
    const unwired = runCheck6({ builtEnv: {} })
    expect(unwired).toMatch(/FAIL\S*\s+\S+ was built without GUILD_E2E_BUILD in next\.config\.ts's env/)
    expect(unwired).not.toMatch(/PASS/)

    const missing = runCheck6({ builtEnv: "missing" })
    expect(missing).toMatch(/FAIL\S*\s+cannot read \S+required-server-files\.json/)
    expect(missing).not.toMatch(/PASS/)
  }, 60_000)

  it("WARNs, never PASSes, when pm2 is absent or does not run the app — three of four sources is not 'checked'", () => {
    for (const pm2 of ["none", { app: "some-other-app", env: {} }] as Pm2[]) {
      const out = runCheck6({ pm2 })
      expect(out).toMatch(/WARN\S*\s+.*the pm2 runtime env was NOT checked \((unavailable|absent)\)/)
      expect(out).not.toMatch(/PASS|FAIL/)
    }
  }, 60_000)
})
