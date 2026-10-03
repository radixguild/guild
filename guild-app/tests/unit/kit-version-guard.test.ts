/**
 * scripts/kit-version-guard.mjs — the deploy refuses to serve a CHANGED kit
 * tarball under an UNCHANGED package version (agent-pr-review on #803: npx
 * caches an install by the URL, so the versioned twin <name>-<version>.tgz is the
 * only URL a long-lived config can pin — and it must always mean one set of bytes).
 *
 * Driven against real temp directories holding the <name>.json records
 * scripts/pack-kit.sh writes. The named defect is the BLOCK case.
 */
import { describe, it, expect, afterEach, vi } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateInputs } from "../support/private-input"

// Every test runs the REAL guard as a `node` child process — a cold V8 start
// per call, and the thing under test is the CLI a deploy runs, so an in-process
// import would test less. No fresh executable is written, so none of the macOS
// first-exec scan that the reconcile-cron-*.test.ts stubs pay (see
// reconcile-cron-halt-guard.test.ts): the cost here is plain CPU contention.
// Measured 2026-09-30, full unit suite on this Mac: single tests at up to
// 2.43s over three runs, and 4.66s — 0.34s under vitest's 5000ms default —
// in a fourth under peer sessions' concurrent suites (load average ~400).
// Isolated, the file runs clean. Same margin and reasoning as
// reconcile-cron-lock.test.ts; a hung guard still reddens this file, later.
vi.setConfig({ testTimeout: 15_000 })

const ROOT = join(process.cwd(), "..")
const GUARD = join(ROOT, "scripts", "kit-version-guard.mjs")
// scripts/deploy.sh stays EXCLUDE at the open-source flip (publish/MANIFEST.md);
// only the describe block below that pins its text skips when it is absent.
const PRIV = privateInputs("scripts/deploy.sh")
const DEPLOY = PRIV.skip ? "" : readFileSync(join(ROOT, "scripts", "deploy.sh"), "utf8")

const A = "a".repeat(64)
const B = "b".repeat(64)
const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})

function dir(records: Record<string, { version: string; sha256: string } | string>) {
  const d = mkdtempSync(join(tmpdir(), "kit-guard-"))
  tmp.push(d)
  for (const [name, rec] of Object.entries(records)) {
    writeFileSync(join(d, `${name}.json`), typeof rec === "string" ? rec : JSON.stringify({ name, package: `@radix-guild/${name}`, ...rec }))
  }
  return d
}
const run = (candidate: string, live: string, kits = ["agent", "mcp"]) =>
  spawnSync("node", [GUARD, "--candidate", candidate, "--live", live, ...kits.flatMap((k) => ["--kit", k])], { encoding: "utf8" })

describe("kit-version-guard.mjs", () => {
  it("passes when no kit is live yet (the first deploy)", () => {
    const r = run(dir({ agent: { version: "0.6.0", sha256: A }, mcp: { version: "0.2.0", sha256: A } }), dir({}))
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toMatch(/OK\s+agent@0\.6\.0 .* no kit live yet/)
  })

  it("passes on an identical tarball (a no-op redeploy) and on a bumped version", () => {
    const same = run(dir({ agent: { version: "0.6.0", sha256: A } }), dir({ agent: { version: "0.6.0", sha256: A } }), ["agent"])
    expect(same.status).toBe(0)
    expect(same.stdout).toMatch(/identical to the live tarball/)
    const bumped = run(dir({ agent: { version: "0.6.1", sha256: B } }), dir({ agent: { version: "0.6.0", sha256: A } }), ["agent"])
    expect(bumped.status).toBe(0)
    expect(bumped.stdout).toMatch(/OK\s+agent 0\.6\.0 → 0\.6\.1/)
  })

  it("THE NAMED DEFECT — same version, different content: BLOCKED, exit 1, both hashes and the fix named", () => {
    const r = run(dir({ agent: { version: "0.6.0", sha256: B }, mcp: { version: "0.2.0", sha256: A } }), dir({ agent: { version: "0.6.0", sha256: A }, mcp: { version: "0.2.0", sha256: A } }))
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/BLOCK agent: content changed \(aaaaaaaaaaaaaaaa… → bbbbbbbbbbbbbbbb…\) but the version is still 0\.6\.0/)
    expect(r.stdout).toMatch(/agent-0\.6\.0\.tgz would then mean different bytes to different machines \(npx caches by URL\)/)
    expect(r.stdout).toMatch(/Bump "version"/)
    expect(r.stdout).toMatch(/OK\s+mcp@0\.2\.0 — identical/)
    expect(r.stdout).toMatch(/BLOCKED — 1 kit\(s\)/)
  })

  it("THE ROUND-5 GAP — a version this box EVER served (a carried twin record) with different bytes is BLOCKED too, even below the live version", () => {
    // Live: agent 0.7.0 current, and the carried record of 0.6.0 (bytes A). Candidate: a re-pack
    // of 0.6.0 with bytes B — the live <name>.json says 0.7.0, so the version differs and the first
    // cut passed it; the twin record says 0.6.0 meant A, so /kit/agent-0.6.0.tgz would flip bytes.
    const live = dir({ agent: { version: "0.7.0", sha256: B } })
    writeFileSync(join(live, "agent-0.6.0.tgz.sha256"), `${A}  agent-0.6.0.tgz\n`)
    const r = run(dir({ agent: { version: "0.6.0", sha256: "c".repeat(64) } }), live, ["agent"])
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/BLOCK agent: content changed \(aaaaaaaaaaaaaaaa… → cccccccccccccccc…\) but the version is still 0\.6\.0/)
    expect(r.stdout).toMatch(/agent-0\.6\.0\.tgz\.sha256 on the box records the earlier bytes/)
    // The same version with the SAME bytes (re-serving a refused twin's original bytes) passes.
    const same = run(dir({ agent: { version: "0.6.0", sha256: A } }), live, ["agent"])
    expect(same.status, same.stdout).toBe(0)
    expect(same.stdout).toMatch(/OK\s+agent 0\.7\.0 → 0\.6\.0/)
  })

  it("THE ROUND-7/8 DEFECT — a malformed twin record: the live tarball's own bytes are the proof; with the tarball gone too it is BLOCKED, and the remedy never says to delete the record", () => {
    const C = "c".repeat(64)
    // (1) record malformed, tarball gone: nothing can prove 0.6.0's bytes → BLOCK, fail closed.
    const live = dir({ agent: { version: "0.7.0", sha256: B } })
    writeFileSync(join(live, "agent-0.6.0.tgz.sha256"), "not a hash line at all\n")
    const reserve = run(dir({ agent: { version: "0.6.0", sha256: C } }), live, ["agent"])
    expect(reserve.status).toBe(1)
    expect(reserve.stdout).toMatch(/BLOCK agent: this box has served 0\.6\.0 before — its record .*agent-0\.6\.0\.tgz\.sha256 is not a "<hex> {2}file" line and its tarball is gone/)
    expect(reserve.stdout).toMatch(/Fails closed/)
    expect(reserve.stdout).toMatch(/Bump "version"/)
    // Round 8's remedy said "remove it by hand" — the one action that makes the guard forget (review round 8, HIGH).
    expect(reserve.stdout).toMatch(/Do NOT delete that record to get past this/)
    expect(reserve.stdout).not.toMatch(/remove it by hand|restore .* from a backup/i)
    expect(reserve.stdout).toMatch(/BLOCKED — 1 kit\(s\)/)
    // (2) record malformed but the live tarball is still there: its bytes decide. Different bytes → BLOCK.
    const liveWithTgz = dir({ agent: { version: "0.7.0", sha256: B } })
    writeFileSync(join(liveWithTgz, "agent-0.6.0.tgz.sha256"), "garbage\n")
    writeFileSync(join(liveWithTgz, "agent-0.6.0.tgz"), "the bytes 0.6.0 was served with")
    const servedSha = createHash("sha256").update("the bytes 0.6.0 was served with").digest("hex")
    const differ = run(dir({ agent: { version: "0.6.0", sha256: C } }), liveWithTgz, ["agent"])
    expect(differ.status).toBe(1)
    expect(differ.stdout).toMatch(new RegExp(`BLOCK agent: content changed \\(${servedSha.slice(0, 16)}… → cccccccccccccccc…\\) but the version is still 0\\.6\\.0`))
    expect(differ.stdout).toMatch(/the live agent-0\.6\.0\.tgz on the box hashes to the earlier bytes; its record is malformed and was not trusted/)
    // Same bytes → OK; no "rewrite the record in the live dir" hint (round 9 of the review: the swap
    // discards that dir, and the candidate already carries a fresh record for this version).
    const same = run(dir({ agent: { version: "0.6.0", sha256: servedSha } }), liveWithTgz, ["agent"])
    expect(same.status, same.stdout).toBe(0)
    expect(same.stdout).toMatch(/OK\s+agent@0\.6\.0 — identical to the live agent-0\.6\.0\.tgz \(its record is malformed; the bytes were hashed instead; the candidate's own record for this version replaces it on the swap\)/)
    expect(same.stdout).not.toMatch(/sha256sum|cd /)
    // (2b) intact record but a TAMPERED live tarball beside it: the record is the memory and wins
    // both ways, and the drift is SAID (round 9 of the review: the guard trusted the record blind).
    const liveDrift = dir({ agent: { version: "0.7.0", sha256: B } })
    writeFileSync(join(liveDrift, "agent-0.6.0.tgz.sha256"), `${A}  agent-0.6.0.tgz\n`)
    writeFileSync(join(liveDrift, "agent-0.6.0.tgz"), "not the bytes the record names")
    const original = run(dir({ agent: { version: "0.6.0", sha256: A } }), liveDrift, ["agent"])
    expect(original.status, original.stdout).toBe(0)
    expect(original.stdout).toMatch(/OK\s+agent@0\.6\.0 — identical to the bytes agent-0\.6\.0\.tgz\.sha256 records/)
    expect(original.stdout).toMatch(/WARN\s+the live agent-0\.6\.0\.tgz on the box does NOT match that record — the box's copy drifted; the candidate's own copy of this version replaces it on the swap\. Treat the drift as docs\/INCIDENTS\.md 4\.8\./)
    expect(original.stdout).not.toMatch(/carry-forward/)
    const tamperedSha = createHash("sha256").update("not the bytes the record names").digest("hex")
    const asTampered = run(dir({ agent: { version: "0.6.0", sha256: tamperedSha } }), liveDrift, ["agent"])
    expect(asTampered.status).toBe(1)
    expect(asTampered.stdout).toMatch(/BLOCK agent: content changed \(aaaaaaaaaaaaaaaa… → /)
    expect(asTampered.stdout).toMatch(/WARN\s+the live agent-0\.6\.0\.tgz on the box no longer matches that record either — the box's copy drifted; treat as docs\/INCIDENTS\.md 4\.8\./)
    expect(asTampered.stdout).not.toMatch(/carry-forward/)
    // (3) The same malformed record is irrelevant to any other version: a normal bump passes with no noise.
    const bump = run(dir({ agent: { version: "0.8.0", sha256: C } }), live, ["agent"])
    expect(bump.status, bump.stdout).toBe(0)
    expect(bump.stdout).toMatch(/OK\s+agent 0\.7\.0 → 0\.8\.0/)
    expect(bump.stdout).not.toMatch(/WARN|BLOCK/)
  })

  it("a missing live <name>.json with served files beside it is NOT called a first deploy (round 8 of the review: deleting files must not make the guard forget silently)", () => {
    const live = dir({})
    writeFileSync(join(live, "agent-0.6.0.tgz.sha256"), `${A}  agent-0.6.0.tgz\n`)
    // 0.6.0 itself is still proven by its record: different bytes → BLOCK even with no agent.json.
    const reserve = run(dir({ agent: { version: "0.6.0", sha256: B } }), live, ["agent"])
    expect(reserve.status).toBe(1)
    expect(reserve.stdout).toMatch(/BLOCK agent: content changed \(aaaaaaaaaaaaaaaa… → bbbbbbbbbbbbbbbb…\) but the version is still 0\.6\.0/)
    // A version with no proof of its own: passes, but says the box is not fresh.
    const other = run(dir({ agent: { version: "0.9.0", sha256: B } }), live, ["agent"])
    expect(other.status, other.stdout).toBe(0)
    expect(other.stdout).toMatch(/WARN\s+agent: no readable live agent\.json, but the box holds served files for agent — not a first deploy/)
    expect(other.stdout).toMatch(/OK\s+agent@0\.9\.0 .* — no live agent\.json to compare against/)
    expect(other.stdout).not.toMatch(/no kit live yet/)
    // A dashed SIBLING kit's stable record is not "served files for agent": still a first deploy for agent.
    const sibling = dir({})
    writeFileSync(join(sibling, "agent-lite.tgz.sha256"), `${A}  agent-lite.tgz\n`)
    const fresh = run(dir({ agent: { version: "0.1.0", sha256: B } }), sibling, ["agent"])
    expect(fresh.status, fresh.stdout).toBe(0)
    expect(fresh.stdout).toMatch(/no kit live yet/)
    expect(fresh.stdout).not.toMatch(/WARN/)
  })

  it("a candidate without its pack record is a broken pack: exit 2, nothing judged", () => {
    const r = run(dir({ agent: { version: "0.6.0", sha256: A } }), dir({}))
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/no mcp\.json in/)
  })

  it("a malformed LIVE record warns and compares as if nothing were live — it must not wedge future deploys", () => {
    const r = run(dir({ agent: { version: "0.6.0", sha256: B } }), dir({ agent: "{not json" }), ["agent"])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/WARN\s+agent: live record unreadable/)
  })

  it("bad arguments exit 2", () => {
    expect(spawnSync("node", [GUARD, "--candidate", "/x"], { encoding: "utf8" }).status).toBe(2)
    expect(spawnSync("node", [GUARD, "--candidate", "/x", "--live", "/y", "--kit", "../etc"], { encoding: "utf8" }).status).toBe(2)
  })
})

describe.skipIf(PRIV.skip)("deploy.sh runs the guard between the packs and the build", () => {
  const exec = DEPLOY.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"))
  it("guards both kits against the live kit dir, after the mcp pack and before npm run build", () => {
    const guardAt = exec.findIndex((l) => /kit-version-guard\.mjs --candidate \$KIT_CANDIDATE --live \$KIT_DIR --kit agent --kit mcp/.test(l))
    const mcpPackAt = exec.findIndex((l) => l.includes("pack-kit.sh --pkg packages/agent-mcp"))
    const buildAt = exec.findIndex((l) => l.includes("npm run build"))
    expect(guardAt).toBeGreaterThan(mcpPackAt)
    expect(buildAt).toBeGreaterThan(guardAt)
  })
})
