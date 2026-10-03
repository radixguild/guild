/**
 * ops/backup/pull-backups.sh must not report an unreachable box as an empty one.
 *
 * 2026-09-30 06:01 the Mac's 04:45 launchd pull fired on wake before the network was up.
 * Every `ssh guild-vps "ls -t …"` failed ("Network is unreachable", exit 255), the
 * listing came back empty, and the run reported "postgres: NOTHING ON BOX" for all three
 * sources. That sends you to the box looking for missing backups, when the box was never
 * asked. Now any non-zero ssh exit reads "BOX UNREACHABLE (ssh exit N)". The launchd
 * wrapper's notification for it is tested in pull-backups-launchd-classify.test.ts, on the
 * real script's output. (This file used to check only the order of the wrapper's grep
 * branches in its source, which passed while the footer made the branch unreachable.)
 *
 * Runs the REAL script with a fake `ssh` first on PATH (this test never opens a
 * connection), the same shape as reconcile-cron-halt-guard.test.ts.
 */
import { describe, it, expect, vi } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateInputs, REPO_ROOT } from "../support/private-input"

vi.setConfig({ testTimeout: 15_000 })

// ops/** stays private at the open-source flip (publish/MANIFEST.md).
const PRIV = privateInputs("ops/backup/pull-backups.sh")
const SCRIPT = join(REPO_ROOT, "ops/backup/pull-backups.sh")

/** Run pull-backups.sh with a fake ssh that exits `code` and prints nothing on stdout. */
function runWithFakeSsh(code: number) {
  const dir = mkdtempSync(join(tmpdir(), "pull-backups-"))
  const bin = join(dir, "bin")
  const dest = join(dir, "dest")
  spawnSync("mkdir", ["-p", bin, dest])
  writeFileSync(
    join(bin, "ssh"),
    `#!/bin/sh\n[ ${code} -ne 0 ] && echo "ssh: connect to host guild-vps port 22: Network is unreachable" >&2\nexit ${code}\n`,
  )
  chmodSync(join(bin, "ssh"), 0o755)
  const r = spawnSync("bash", [SCRIPT, "--dest", dest], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GUILD_VPS_SSH: "guild-vps" },
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

describe.skipIf(PRIV.skip)("pull-backups.sh: an unreachable box is not an empty box", () => {
  it("ssh exit 255 reads BOX UNREACHABLE for every source, never NOTHING ON BOX", () => {
    const { status, out } = runWithFakeSsh(255)
    expect(status).toBe(1)
    for (const label of ["postgres", "bot-sqlite", "meme-grid-sqlite"]) {
      expect(out).toContain(`${label}: BOX UNREACHABLE (ssh exit 255)`)
    }
    expect(out).not.toContain("NOTHING ON BOX")
    expect(out).not.toContain("NOTHING FOUND")
  })

  it("a reachable box with no files still reads NOTHING ON BOX (the old signal keeps its meaning)", () => {
    const { status, out } = runWithFakeSsh(0)
    expect(status).toBe(1)
    for (const label of ["postgres", "bot-sqlite", "meme-grid-sqlite"]) {
      expect(out).toContain(`${label}: NOTHING ON BOX`)
    }
    expect(out).not.toContain("UNREACHABLE")
  })
})
