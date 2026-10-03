/**
 * scripts/kit-carry-forward.sh — previously served versioned kit twins keep
 * serving across deploys (agent-pr-review on #803 round 3: the candidate is
 * rebuilt from scratch and swapped in whole, so a pinned <name>-<version>.tgz
 * 404'd the moment a later deploy bumped the version).
 *
 * Driven against real temp directories. The named defect is the carried case:
 * an old twin present live but absent from the candidate must be in the
 * candidate afterwards, byte-identical, with its .sha256. A twin whose bytes do
 * not match its own record must NOT be carried.
 */
import { describe, it, expect, afterEach } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync, chmodSync, symlinkSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateInputs } from "../support/private-input"

const ROOT = join(process.cwd(), "..")
const SCRIPT = join(ROOT, "scripts", "kit-carry-forward.sh")
// scripts/deploy.sh stays EXCLUDE at the open-source flip (publish/MANIFEST.md);
// only the describe block below that pins its text skips when it is absent.
const PRIV = privateInputs("scripts/deploy.sh")
const DEPLOY = PRIV.skip ? "" : readFileSync(join(ROOT, "scripts", "deploy.sh"), "utf8")
const sha = (s: string) => createHash("sha256").update(s).digest("hex")

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})
function dir() {
  const d = mkdtempSync(join(tmpdir(), "kit-carry-"))
  tmp.push(d)
  return d
}
function twin(d: string, file: string, bytes: string, recordedSha = sha(bytes)) {
  writeFileSync(join(d, file), bytes)
  writeFileSync(join(d, `${file}.sha256`), `${recordedSha}  ${file}\n`)
}
const run = (live: string, cand: string, kits = ["agent", "mcp"]) => spawnSync("bash", [SCRIPT, live, cand, ...kits], { encoding: "utf8" })

describe("kit-carry-forward.sh", () => {
  it("first deploy: no live dir is a no-op, exit 0", () => {
    const cand = dir()
    const r = run(join(cand, "does-not-exist"), cand)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/first deploy, nothing to carry/)
  })

  it("THE NAMED DEFECT — an older versioned twin live but not in the candidate is carried, bytes and record intact", () => {
    const live = dir()
    const cand = dir()
    twin(live, "mcp.tgz", "v2 stable")
    twin(live, "mcp-0.2.0.tgz", "v2 bytes")
    twin(cand, "mcp.tgz", "v3 stable")
    twin(cand, "mcp-0.3.0.tgz", "v3 bytes")
    const r = run(live, cand)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/CARRY {2}mcp-0\.2\.0\.tgz/)
    expect(r.stdout).toMatch(/carried 1, already current 0, refused 0/)
    expect(readFileSync(join(cand, "mcp-0.2.0.tgz"), "utf8")).toBe("v2 bytes")
    expect(readFileSync(join(cand, "mcp-0.2.0.tgz.sha256"), "utf8")).toBe(`${sha("v2 bytes")}  mcp-0.2.0.tgz\n`)
    // The stable file is never touched: it is the CURRENT one by definition.
    expect(readFileSync(join(cand, "mcp.tgz"), "utf8")).toBe("v3 stable")
    expect(readdirSync(cand).sort()).toEqual(["mcp-0.2.0.tgz", "mcp-0.2.0.tgz.sha256", "mcp-0.3.0.tgz", "mcp-0.3.0.tgz.sha256", "mcp.tgz", "mcp.tgz.sha256"])
  })

  it("the candidate's own twin wins — a same-name live twin is never copied over it, and a stale live .refused note for that version is NOT carried (round 8 of the review)", () => {
    const live = dir()
    const cand = dir()
    twin(live, "agent-0.6.0.tgz", "old bytes under the same version")
    // An earlier deploy refused 0.6.0 and left its note; this deploy re-serves 0.6.0 (the guard
    // has already proven the bytes). The note must not travel: it would describe bytes that are back.
    writeFileSync(join(live, "agent-0.6.0.tgz.refused"), "refused 2026-09-28T00:00:00Z by kit-carry-forward: live bytes … did not match the record …\n")
    twin(cand, "agent-0.6.0.tgz", "candidate bytes")
    // …and an operator's .retired note for the same version: the re-serve wins, and the script SAYS so.
    writeFileSync(join(live, "agent-0.6.0.tgz.retired"), "retired 2026-09-29T00:00:00Z — superseded\n")
    const r = run(live, cand)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/carried 0, already current 1, refused 0, retired 0/)
    expect(r.stdout).toMatch(/KEEP {3}agent-0\.6\.0\.tgz — the candidate re-serves this version; the live \.retired note \(retired 2026-09-29T00:00:00Z — superseded\) is superseded and not carried/)
    expect(readFileSync(join(cand, "agent-0.6.0.tgz"), "utf8")).toBe("candidate bytes")
    expect(existsSync(join(cand, "agent-0.6.0.tgz.refused"))).toBe(false)
    expect(existsSync(join(cand, "agent-0.6.0.tgz.retired"))).toBe(false)
    expect(r.stderr).toBe("")
  })

  it("a note with no record beside it (an orphan) is named on stderr and left behind — never carried, never silent (round 11 of the review)", () => {
    const live = dir()
    const cand = dir()
    writeFileSync(join(live, "agent-0.1.0.tgz.retired"), "retired 2026-09-01T00:00:00Z — its record was deleted by hand later\n")
    writeFileSync(join(live, "mcp-0.1.0.tgz.refused"), "refused 2026-09-02T00:00:00Z by kit-carry-forward: …\n")
    twin(live, "agent-0.2.0.tgz", "a healthy older twin")
    const r = run(live, cand)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/carried 1, already current 0, refused 0, retired 0/)
    expect(r.stderr).toMatch(/ORPHAN agent-0\.1\.0\.tgz\.retired — no agent-0\.1\.0\.tgz\.sha256 beside it; NOT carried/)
    expect(r.stderr).toMatch(/ORPHAN mcp-0\.1\.0\.tgz\.refused — no mcp-0\.1\.0\.tgz\.sha256 beside it; NOT carried/)
    expect(r.stderr).toMatch(/2 note\(s\) without a record were left behind/)
    expect(readdirSync(cand).sort()).toEqual(["agent-0.2.0.tgz", "agent-0.2.0.tgz.sha256"])
  })

  it("a live twin whose bytes do not match its own record is REFUSED, loudly, and the deploy is not blocked — its RECORD is carried, its bytes are not", () => {
    const live = dir()
    const cand = dir()
    twin(live, "agent-0.5.0.tgz", "tampered bytes", sha("what it was when packed"))
    twin(live, "agent-0.4.0.tgz", "good old bytes")
    const r = run(live, cand)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/REFUSE agent-0\.5\.0\.tgz — live bytes .* do not match its own \.sha256 .*record carried with a \.refused note, bytes not/)
    expect(r.stderr).toMatch(/a refused twin 404s after this deploy/)
    expect(r.stderr).toMatch(/keeps paging that URL .* until that version is re-served with its original bytes or you RETIRE it/)
    expect(existsSync(join(cand, "agent-0.5.0.tgz"))).toBe(false)
    // THE ROUND-5 DEFECT: the record stays, so the watcher keeps listing (and paging) the URL.
    expect(readFileSync(join(cand, "agent-0.5.0.tgz.sha256"), "utf8")).toBe(`${sha("what it was when packed")}  agent-0.5.0.tgz\n`)
    // THE ROUND-7 DEFECT: when THIS script drops the bytes it says so on disk, so the watcher can
    // tell "the deploy refused it" from "someone removed the tarball" (INCIDENTS 4.8 step 1).
    const note = readFileSync(join(cand, "agent-0.5.0.tgz.refused"), "utf8")
    expect(note).toMatch(/^refused \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z by kit-carry-forward: live bytes [0-9a-f]{16}… did not match the record [0-9a-f]{16}…\n$/)
    expect(note).toContain(sha("tampered bytes").slice(0, 16))
    expect(note).toContain(sha("what it was when packed").slice(0, 16))
    expect(readFileSync(join(cand, "agent-0.4.0.tgz"), "utf8")).toBe("good old bytes")
    expect(existsSync(join(cand, "agent-0.4.0.tgz.refused"))).toBe(false)
  })

  it("a record without bytes (a twin refused by an EARLIER deploy, or removed by hand) is carried as a record again — the 404 stays watched across deploys, never re-invented; a .refused note travels with it, none is invented", () => {
    const live = dir()
    const cand = dir()
    writeFileSync(join(live, "mcp-0.1.0.tgz.sha256"), `${sha("bytes long gone")}  mcp-0.1.0.tgz\n`)
    writeFileSync(join(live, "mcp-0.1.0.tgz.refused"), "refused 2026-09-28T00:00:00Z by kit-carry-forward: live bytes 0123456789abcdef… did not match the record fedcba9876543210…\n")
    writeFileSync(join(live, "agent-0.3.0.tgz.sha256"), `${sha("removed by an operator")}  agent-0.3.0.tgz\n`) // no note: removed by hand
    // A twin an operator RETIRED (round 9 of the review: records are never deleted; the note
    // stops the watcher paging and travels with the record so the guard keeps its memory).
    writeFileSync(join(live, "agent-0.2.0.tgz.sha256"), `${sha("retired bytes")}  agent-0.2.0.tgz\n`)
    writeFileSync(join(live, "agent-0.2.0.tgz.retired"), "retired 2026-09-29T00:00:00Z — superseded, nobody pins it\n")
    const r = run(live, cand)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/REFUSE mcp-0\.1\.0\.tgz — \.sha256 present but the tarball is missing .*record carried, bytes not/)
    expect(r.stdout).toMatch(/RETIRE agent-0\.2\.0\.tgz — retired by an operator \(retired 2026-09-29T00:00:00Z — superseded, nobody pins it\); record and note carried, bytes not — the URL 404s from this deploy on/)
    expect(r.stdout).toMatch(/carried 0, already current 0, refused 2, retired 1/)
    const expected = ["agent-0.2.0.tgz.retired", "agent-0.2.0.tgz.sha256", "agent-0.3.0.tgz.sha256", "mcp-0.1.0.tgz.refused", "mcp-0.1.0.tgz.sha256"]
    expect(readdirSync(cand).sort()).toEqual(expected)
    expect(readFileSync(join(cand, "mcp-0.1.0.tgz.refused"), "utf8")).toMatch(/^refused 2026-09-28T00:00:00Z by kit-carry-forward/)
    expect(readFileSync(join(cand, "agent-0.2.0.tgz.retired"), "utf8")).toMatch(/^retired 2026-09-29T00:00:00Z — superseded/)
    // And again: idempotent in this state too.
    expect(run(live, cand).stdout).toMatch(/refused 2, retired 1/)
    expect(readdirSync(cand).sort()).toEqual(expected)
    // The stderr trailer never says to delete a record; it says how to retire.
    expect(r.stderr).toMatch(/RETIRE it: printf 'retired %s — <why>\\n'/)
    expect(r.stderr).toMatch(/Never delete a \.tgz\.sha256/)
    expect(r.stderr).not.toMatch(/remove <name>|by hand/)
  })

  it("THE ROUND-10 DEFECT — a twin an operator RETIRED while its bytes were still intact: the record and note are carried, the BYTES are not; the retirement is durable", () => {
    const live = dir()
    const cand = dir()
    twin(live, "agent-0.5.0.tgz", "still-good bytes nobody pins any more")
    writeFileSync(join(live, "agent-0.5.0.tgz.retired"), "retired 2026-09-30T10:00:00Z — superseded by 0.6.0\n")
    twin(live, "agent-0.4.0.tgz", "an ordinary older twin")
    twin(cand, "agent-0.6.0.tgz", "current")
    const r = run(live, cand, ["agent"])
    expect(r.status).toBe(0)
    // The plain CARRY branch used to copy the bytes and drop the note — a retirement reversed itself on the next deploy.
    expect(r.stdout).toMatch(/RETIRE agent-0\.5\.0\.tgz — retired by an operator \(retired 2026-09-30T10:00:00Z — superseded by 0\.6\.0\); record and note carried, bytes not/)
    expect(r.stdout).toMatch(/CARRY {2}agent-0\.4\.0\.tgz/)
    expect(r.stdout).toMatch(/carried 1, already current 0, refused 0, retired 1/)
    expect(readdirSync(cand).sort()).toEqual(["agent-0.4.0.tgz", "agent-0.4.0.tgz.sha256", "agent-0.5.0.tgz.retired", "agent-0.5.0.tgz.sha256", "agent-0.6.0.tgz", "agent-0.6.0.tgz.sha256"])
    expect(readFileSync(join(cand, "agent-0.5.0.tgz.sha256"), "utf8")).toBe(`${sha("still-good bytes nobody pins any more")}  agent-0.5.0.tgz\n`)
    // No .refused note is invented for a retirement, and nothing on stderr: this is intended.
    expect(existsSync(join(cand, "agent-0.5.0.tgz.refused"))).toBe(false)
    expect(r.stderr).toBe("")
    // Idempotent: the record-only retired twin is retired again next run, still no bytes.
    expect(run(live, cand, ["agent"]).stdout).toMatch(/already current 1, refused 0, retired 1/)
    // An EMPTY note (a human skipped the documented printf): the line says so instead of "()" (round 12).
    const live2 = dir()
    const cand2 = dir()
    twin(live2, "agent-0.3.0.tgz", "bytes")
    writeFileSync(join(live2, "agent-0.3.0.tgz.retired"), "")
    const r2 = run(live2, cand2, ["agent"])
    expect(r2.stdout).toMatch(/RETIRE agent-0\.3\.0\.tgz — retired by an operator \(no reason given\); record and note carried, bytes not/)
    expect(r2.stdout).not.toMatch(/\(\)/)
    // A whitespace-only first line is just as blank (round 13 of the review).
    const live3 = dir()
    const cand3 = dir()
    twin(live3, "agent-0.3.1.tgz", "bytes")
    writeFileSync(join(live3, "agent-0.3.1.tgz.retired"), "   \t \nsecond line has words\n")
    expect(run(live3, cand3, ["agent"]).stdout).toMatch(/RETIRE agent-0\.3\.1\.tgz — retired by an operator \(no reason given\)/)
  })

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "an unreadable note, record or tarball is SAID and skipped — exit 0 always, never an abort under set -e (round 13 of the review)",
    () => {
      const live = dir()
      const cand = dir()
      // (1) an unreadable .retired note: the record is carried, the note is not, the line says so, RETIRE still prints.
      twin(live, "agent-0.5.0.tgz", "retired bytes")
      writeFileSync(join(live, "agent-0.5.0.tgz.retired"), "retired 2026-09-30T00:00:00Z — locked down by mistake\n")
      chmodSync(join(live, "agent-0.5.0.tgz.retired"), 0o000)
      // (2) an unreadable record: nothing of that twin is carried, said on stderr.
      twin(live, "agent-0.4.0.tgz", "record locked")
      chmodSync(join(live, "agent-0.4.0.tgz.sha256"), 0o000)
      // (3) an unreadable tarball: refused like a mismatch, record carried.
      twin(live, "agent-0.3.0.tgz", "tarball locked")
      chmodSync(join(live, "agent-0.3.0.tgz"), 0o000)
      twin(live, "agent-0.2.0.tgz", "a healthy one")
      const r = run(live, cand, ["agent"])
      for (const f of ["agent-0.5.0.tgz.retired", "agent-0.4.0.tgz.sha256", "agent-0.3.0.tgz"]) chmodSync(join(live, f), 0o644)
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/RETIRE agent-0\.5\.0\.tgz — retired by an operator \(no reason given\); record and note carried, bytes not/)
      expect(r.stderr).toMatch(/WARN {3}agent-0\.5\.0\.tgz — cannot read agent-0\.5\.0\.tgz\.retired \(permissions\?\); the note is NOT carried/)
      expect(r.stderr).toMatch(/SKIP {3}agent-0\.4\.0\.tgz — its record agent-0\.4\.0\.tgz\.sha256 is unreadable \(permissions\?\); nothing of it is carried/)
      expect(r.stdout).toMatch(/REFUSE agent-0\.3\.0\.tgz — the live tarball is unreadable \(permissions\?\); record carried, bytes not/)
      expect(r.stdout).toMatch(/CARRY {2}agent-0\.2\.0\.tgz/)
      expect(r.stdout).toMatch(/carried 1, already current 0, refused 1, retired 1/)
      expect(r.stderr).toMatch(/3 file\(s\) could not be read .* this step never blocks a deploy/)
      expect(readdirSync(cand).sort()).toEqual(["agent-0.2.0.tgz", "agent-0.2.0.tgz.sha256", "agent-0.3.0.tgz.sha256", "agent-0.5.0.tgz.sha256"])
      // (4) a dangling symlink where a record should be: the reason says so, not "permissions".
      const live2 = dir()
      const cand2 = dir()
      symlinkSync(join(live2, "does-not-exist"), join(live2, "agent-0.9.0.tgz.sha256"))
      const r2 = run(live2, cand2, ["agent"])
      expect(r2.status).toBe(0)
      expect(r2.stderr).toMatch(/SKIP {3}agent-0\.9\.0\.tgz — its record agent-0\.9\.0\.tgz\.sha256 is a dangling symlink; nothing of it is carried/)
      expect(r2.stderr).not.toMatch(/agent-0\.9\.0[^\n]*permissions/)
    },
  )

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "a candidate this script cannot WRITE to is fatal by design — the one failure class that stops the step (round 14 of the review)",
    () => {
      const live = dir()
      const cand = dir()
      twin(live, "agent-0.5.0.tgz", "retired bytes")
      writeFileSync(join(live, "agent-0.5.0.tgz.retired"), "retired 2026-09-30T00:00:00Z — fine\n")
      // A read-only stale note already sitting in the candidate: the write fails, and the step must stop.
      writeFileSync(join(cand, "agent-0.5.0.tgz.retired"), "stale\n")
      chmodSync(join(cand, "agent-0.5.0.tgz.retired"), 0o444)
      const r = run(live, cand, ["agent"])
      chmodSync(join(cand, "agent-0.5.0.tgz.retired"), 0o644)
      expect(r.status).not.toBe(0)
      // Never blamed on the source: the readable note was read; the destination refused the write.
      expect(r.stderr).not.toMatch(/cannot read/)
      expect(r.stdout).not.toMatch(/RETIRE agent-0\.5\.0/)
    },
  )

  it("is idempotent — a second run carries nothing more", () => {
    const live = dir()
    const cand = dir()
    twin(live, "mcp-0.1.0.tgz", "one")
    expect(run(live, cand).stdout).toMatch(/carried 1/)
    expect(run(live, cand).stdout).toMatch(/carried 0, already current 1/)
  })

  it("only the NAMED kits' version-shaped twins are considered — a dashed kit name is never another kit's twin, a retired kit is not carried", () => {
    const live = dir()
    const cand = dir()
    twin(live, "agent-lite.tgz", "a whole other kit's stable file")   // not a twin of `agent`
    twin(live, "agent-0.6.0.tgz", "agent twin")
    twin(live, "agent-0.7.0-rc.1+build.5.tgz", "prerelease twin")      // semver pre + build: a twin
    twin(live, "mcp-0.1.0.tgz", "retired kit's twin")                  // mcp not named below
    twin(live, "agent-notaversion.tgz", "dash but no version")          // not a twin
    const r = run(live, cand, ["agent"])
    expect(r.status).toBe(0)
    expect(readdirSync(cand).sort()).toEqual(["agent-0.6.0.tgz", "agent-0.6.0.tgz.sha256", "agent-0.7.0-rc.1+build.5.tgz", "agent-0.7.0-rc.1+build.5.tgz.sha256"])
    expect(r.stdout).toMatch(/carried 2, already current 0, refused 0/)
  })

  it("bad arguments exit 2 — no kit names, a bad name, a missing candidate", () => {
    expect(spawnSync("bash", [SCRIPT, "/x"], { encoding: "utf8" }).status).toBe(2)
    expect(spawnSync("bash", [SCRIPT, "/x", "/y"], { encoding: "utf8" }).status).toBe(2)
    expect(spawnSync("bash", [SCRIPT, "/x", "/does/not/exist", "agent"], { encoding: "utf8" }).status).toBe(2)
    expect(spawnSync("bash", [SCRIPT, "/x", dir(), "../etc"], { encoding: "utf8" }).status).toBe(2)
  })
})

describe.skipIf(PRIV.skip)("deploy.sh carries forward after both packs and before the guard", () => {
  const exec = DEPLOY.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"))
  it("runs kit-carry-forward.sh live → candidate between the mcp pack and the version guard", () => {
    const carryAt = exec.findIndex((l) => /kit-carry-forward\.sh \$KIT_DIR \$KIT_CANDIDATE agent mcp/.test(l))
    const mcpPackAt = exec.findIndex((l) => l.includes("pack-kit.sh --pkg packages/agent-mcp"))
    const guardAt = exec.findIndex((l) => l.includes("kit-version-guard.mjs --candidate"))
    expect(carryAt).toBeGreaterThan(mcpPackAt)
    expect(guardAt).toBeGreaterThan(carryAt)
  })
})
