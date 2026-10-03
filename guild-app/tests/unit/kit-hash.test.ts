/**
 * Unit tests for scripts/lib/kit-hash.mjs — the pure half of
 * scripts/kit-hash-watch.mjs (docs/design/bring-your-agent.md §2.4,
 * "Integrity — owed before S1": the watcher that re-hashes the SERVED
 * /kit/agent.tgz against the .sha256 the deploy wrote and pages on any difference).
 *
 * The named defect every case here is built around: a swapped tarball that the
 * watcher reads as fine. So each branch of compareKit is driven with a real
 * sha256 of real bytes, and the tamper cases assert on the exact hashes named
 * in the finding — a watcher that "alerts" without saying which two hashes
 * disagree is one an operator cannot act on.
 */
import { describe, it, expect, vi } from "vitest"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  parseCliArgs,
  UsageError,
  DEFAULT_KIT_DIR,
  DEFAULT_KITS,
  PAGE_KITS,
  parseSha256File,
  readExpected,
  sha256Hex,
  fetchServed,
  compareKit,
  kitTarballUrl,
  versionedKits,
  kitSurface,
  alertTexts,
  VERSION_SUFFIX,
} from "../../scripts/lib/kit-hash.mjs"

const enc = new TextEncoder()
const GOOD = enc.encode("the real tarball bytes")
const GOOD_SHA = createHash("sha256").update(GOOD).digest("hex")
const EVIL = enc.encode("someone else's tarball")
const EVIL_SHA = createHash("sha256").update(EVIL).digest("hex")

const ok = (bytes: Uint8Array) => ({ ok: true, status: 200, bytes, error: null })
const http = (status: number) => ({ ok: false, status, bytes: new Uint8Array(0), error: null })
const down = () => ({ ok: false, status: 0, bytes: new Uint8Array(0), error: "fetch failed" })
const line = (sha: string, file = "agent.tgz") => enc.encode(`${sha}  ${file}\n`)
const expected = { sha256: GOOD_SHA, file: "agent.tgz" }
const pageWith = (sha: string) => ok(enc.encode(`<html>… sha256 <code>${sha}</code> …</html>`))

// ── parseCliArgs ─────────────────────────────────────────────────────────────

describe("parseCliArgs", () => {
  it("defaults to the box kit dir, both deployed kits, not dry-run", () => {
    expect(parseCliArgs([], {})).toEqual({ kitDir: DEFAULT_KIT_DIR, kits: [...DEFAULT_KITS], dryRun: false })
    // One per `pack-kit.sh --name` in scripts/deploy.sh — deploy-kit-atomic.test.ts pins that side.
    expect(DEFAULT_KITS).toEqual(["agent", "mcp"])
    // Only the agent kit's hash is printed on /agents (its one-liner makes a key).
    expect(PAGE_KITS).toEqual(["agent"])
  })

  it("reads the kit dir from GUILD_KIT_DIR and lets --kit-dir override it", () => {
    expect(parseCliArgs([], { GUILD_KIT_DIR: "/tmp/k" }).kitDir).toBe("/tmp/k")
    expect(parseCliArgs(["--kit-dir", "/x"], { GUILD_KIT_DIR: "/tmp/k" }).kitDir).toBe("/x")
  })

  it("--kit is repeatable and replaces the default list", () => {
    expect(parseCliArgs(["--kit", "agent", "--kit", "mcp", "--dry-run"], {})).toEqual({
      kitDir: DEFAULT_KIT_DIR,
      kits: ["agent", "mcp"],
      dryRun: true,
    })
  })

  it("rejects a kit name that is not a URL-safe segment, a bare --kit-dir, and unknown flags", () => {
    expect(() => parseCliArgs(["--kit", "../etc"], {})).toThrow(UsageError)
    expect(() => parseCliArgs(["--kit"], {})).toThrow(UsageError)
    expect(() => parseCliArgs(["--kit-dir"], {})).toThrow(UsageError)
    expect(() => parseCliArgs(["--window-hours", "1"], {})).toThrow(UsageError)
  })
})

// ── kitTarballUrl ────────────────────────────────────────────────────────────

describe("kitTarballUrl", () => {
  it("the agent kit IS the configured URL; other kits are siblings in the same directory", () => {
    expect(kitTarballUrl("agent", "https://radixguild.com/kit/agent.tgz")).toBe("https://radixguild.com/kit/agent.tgz")
    expect(kitTarballUrl("mcp", "https://radixguild.com/kit/agent.tgz")).toBe("https://radixguild.com/kit/mcp.tgz")
  })

  it("follows a moved KIT_TARBALL_URL (the NEXT_PUBLIC_KIT_TARBALL_URL override) instead of a retyped path", () => {
    expect(kitTarballUrl("agent", "https://cdn.example/releases/agent.tgz")).toBe("https://cdn.example/releases/agent.tgz")
    expect(kitTarballUrl("mcp", "https://cdn.example/releases/agent.tgz")).toBe("https://cdn.example/releases/mcp.tgz")
    expect(() => kitTarballUrl("mcp", "no-path")).toThrow()
  })
})

// ── parseSha256File / readExpected ───────────────────────────────────────────

describe("parseSha256File", () => {
  it("reads the `sha256sum -c` line scripts/pack-kit.sh writes, case-insensitively", () => {
    expect(parseSha256File(`${GOOD_SHA}  agent.tgz\n`)).toEqual(expected)
    expect(parseSha256File(`${GOOD_SHA.toUpperCase()} *agent.tgz`)).toEqual(expected)
  })

  it("returns null for a truncated hash, a bare hash, an empty file — never a guess", () => {
    expect(parseSha256File(`${GOOD_SHA.slice(0, 63)}  agent.tgz`)).toBeNull()
    expect(parseSha256File(GOOD_SHA)).toBeNull()
    expect(parseSha256File("")).toBeNull()
    expect(parseSha256File(undefined)).toBeNull()
  })

  it("readExpected maps a missing file to null instead of throwing", () => {
    const read = vi.fn((p: string) => {
      if (p === "/kit/agent.tgz.sha256") return `${GOOD_SHA}  agent.tgz\n`
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    })
    expect(readExpected("/kit", "agent", read)).toEqual(expected)
    expect(readExpected("/kit", "mcp", read)).toBeNull()
  })
})

// ── fetchServed ──────────────────────────────────────────────────────────────

describe("fetchServed", () => {
  it("returns the bytes and asks the origin, not a cache", async () => {
    const fetchImpl = vi.fn(async () => new Response(GOOD, { status: 200 }))
    const r = await fetchServed("https://x/kit/agent.tgz", { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r.ok).toBe(true)
    expect(sha256Hex(r.bytes)).toBe(GOOD_SHA)
    expect((fetchImpl.mock.calls[0] as unknown[])[1]).toMatchObject({ cache: "no-store" })
  })

  it("reports a 404 as status 404 and a network error as status 0 — never throws", async () => {
    const r404 = await fetchServed("https://x/kit/agent.tgz", {
      fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    })
    expect(r404).toMatchObject({ ok: false, status: 404 })
    const rDown = await fetchServed("https://x/kit/agent.tgz", {
      fetchImpl: (async () => {
        throw new TypeError("fetch failed")
      }) as unknown as typeof fetch,
    })
    expect(rDown).toMatchObject({ ok: false, status: 0, error: "fetch failed" })
  })
})

// ── compareKit — the decision ────────────────────────────────────────────────

describe("compareKit", () => {
  it("is silent when the served tarball, the served hash file and the page all agree with the box", () => {
    const r = compareKit({ name: "agent", expected, tarball: ok(GOOD), shaFile: ok(line(GOOD_SHA)), page: pageWith(GOOD_SHA) })
    expect(r).toEqual({ findings: [], tamper: false, servedSha256: GOOD_SHA, retired: null, servedWhileRetired: false })
  })

  it("THE NAMED DEFECT — a swapped tarball is a tamper finding that names both hashes", () => {
    const r = compareKit({ name: "agent", expected, tarball: ok(EVIL), shaFile: ok(line(GOOD_SHA)), page: pageWith(GOOD_SHA) })
    expect(r.tamper).toBe(true)
    expect(r.servedSha256).toBe(EVIL_SHA)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toContain(EVIL_SHA)
    expect(r.findings[0]).toContain(GOOD_SHA)
    expect(r.findings[0]).toMatch(/INCIDENTS\.md 4\.8/)
  })

  it("a swapped .sha256 file (tarball intact) is also a tamper — the check people run would be lying", () => {
    const r = compareKit({ name: "agent", expected, tarball: ok(GOOD), shaFile: ok(line(EVIL_SHA)), page: pageWith(GOOD_SHA) })
    expect(r.tamper).toBe(true)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toContain(EVIL_SHA)
  })

  it("a 404 tarball is a broken surface, not a tamper, and says where to look", () => {
    const r = compareKit({ name: "agent", expected, tarball: http(404), shaFile: http(404), page: pageWith(GOOD_SHA) })
    expect(r.tamper).toBe(false)
    expect(r.servedSha256).toBeNull()
    expect(r.findings).toHaveLength(2)
    expect(r.findings[0]).toMatch(/GET \/kit\/agent\.tgz → 404/)
    expect(r.findings[0]).toMatch(/Caddy/)
  })

  it("no response at all carries the error text and is not a tamper", () => {
    const r = compareKit({ name: "agent", expected, tarball: down(), shaFile: down() })
    expect(r.tamper).toBe(false)
    expect(r.findings.join("\n")).toContain("no response")
    expect(r.findings.join("\n")).toContain("fetch failed")
  })

  it("no expectation on the box is a finding, and a served tarball then cannot be judged a tamper", () => {
    const r = compareKit({ name: "agent", expected: null, tarball: ok(EVIL), shaFile: ok(line(EVIL_SHA)) })
    expect(r.tamper).toBe(false)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toMatch(/no agent\.tgz\.sha256 on the box/)
    expect(r.servedSha256).toBe(EVIL_SHA)
  })

  it("a page that prints a different hash than the deploy wrote is a finding (stale build)", () => {
    const r = compareKit({ name: "agent", expected, tarball: ok(GOOD), shaFile: ok(line(GOOD_SHA)), page: pageWith(EVIL_SHA) })
    expect(r.tamper).toBe(false)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toMatch(/\/agents does not print/)
    expect(r.findings[0]).toContain(GOOD_SHA)
  })

  it("the page check is skipped when no page was fetched, and reported when the page is down", () => {
    expect(compareKit({ name: "agent", expected, tarball: ok(GOOD), shaFile: ok(line(GOOD_SHA)) }).findings).toEqual([])
    const r = compareKit({ name: "agent", expected, tarball: ok(GOOD), shaFile: ok(line(GOOD_SHA)), page: http(502) })
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toMatch(/GET \/agents → 502/)
  })

  it("a served hash file that is not a hash line is a finding, not a silent pass", () => {
    const r = compareKit({ name: "agent", expected, tarball: ok(GOOD), shaFile: ok(enc.encode("<html>login</html>")) })
    expect(r.tamper).toBe(false)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toMatch(/not a "<hex>  file" line/)
  })
})

// ── versionedKits ────────────────────────────────────────────────────────────

describe("versionedKits", () => {
  it("lists the box's <name>-<version>.tgz.sha256 files as kit names, sorted, per kit only", () => {
    const list = () => ["agent.tgz", "agent.tgz.sha256", "agent-0.6.0.tgz", "agent-0.6.0.tgz.sha256", "agent-0.6.1.tgz.sha256", "agent-1.0.0-rc.1+b5.tgz.sha256", "agent-lite.tgz.sha256", "agent-notaversion.tgz.sha256", "mcp-0.2.0.tgz.sha256", "mcp.json", "notes.txt"]
    // version-shaped suffixes only: a dashed sibling kit (agent-lite) is not a twin of agent
    expect(versionedKits("/kit", "agent", list)).toEqual(["agent-0.6.0", "agent-0.6.1", "agent-1.0.0-rc.1+b5"])
    expect(versionedKits("/kit", "mcp", list)).toEqual(["mcp-0.2.0"])
    // a kit named with a prefix of another must not pick up the other's twins
    expect(versionedKits("/kit", "age", list)).toEqual([])
  })

  it("an unreadable kit dir yields no twins (the stable check reports the dir separately)", () => {
    expect(versionedKits("/nope", "agent", () => { throw new Error("ENOENT") })).toEqual([])
  })

  it("a twin's URL derives like the stable one — a sibling in the same directory", () => {
    expect(kitTarballUrl("mcp-0.2.0", "https://radixguild.com/kit/agent.tgz")).toBe("https://radixguild.com/kit/mcp-0.2.0.tgz")
  })

  it("THE ROUND-5 DEFECT — a twin whose RECORD is on the box without its bytes is still listed (a refused twin stays watched)", () => {
    // kit-carry-forward.sh carries a refused twin's .sha256 and drops the .tgz: the URL must stay checked.
    const list = () => ["agent.tgz", "agent.tgz.sha256", "agent-0.6.0.tgz.sha256"]
    expect(versionedKits("/kit", "agent", list)).toEqual(["agent-0.6.0"])
  })

  it("the version-shaped suffix is one regex, shared with scripts/kit-carry-forward.sh's VER_RE", () => {
    const js = new RegExp(`^${VERSION_SUFFIX}$`)
    for (const good of ["0.6.0", "1.0.0-rc.1", "1.0.0-rc.1+build.5", "10.20.30+sha.abc"]) expect(js.test(good), good).toBe(true)
    for (const bad of ["lite", "notaversion", "1.0", "v1.0.0", "1.0.0 ", "1.0.0-"]) expect(js.test(bad), bad).toBe(false)
    // The shell copy is the same grammar (ERE): compare after stripping the JS-only non-capturing markers.
    const sh = readFileSync(join(process.cwd(), "..", "scripts", "kit-carry-forward.sh"), "utf8").match(/^VER_RE='(.+)'$/m)?.[1]
    expect(sh).toBe(`^${VERSION_SUFFIX.replace(/\(\?:/g, "(").replace(/\\d/g, "[0-9]")}$`)
  })
})

// ── kitSurface + alertTexts — who is hit, named ──────────────────────────────

describe("kitSurface", () => {
  it("three kinds: the page's one-liner, a versioned twin a config pins, a one-shot stable file", () => {
    expect(kitSurface("agent", true)).toMatchObject({ kind: "page", what: "the one-liner on /agents" })
    expect(kitSurface("mcp-0.2.0")).toMatchObject({ kind: "pinned", what: "the versioned URL configs pin (/kit/mcp-0.2.0.tgz)" })
    expect(kitSurface("agent-0.7.0-rc.1+build.5")).toMatchObject({ kind: "pinned" })
    // THE ROUND-5 DEFECT: the mcp STABLE file is for one-shot runs — no config pins it.
    expect(kitSurface("mcp")).toMatchObject({ kind: "oneshot", what: "the one-shot URL (/kit/mcp.tgz; configs pin its versioned twin)" })
    expect(kitSurface("agent-lite")).toMatchObject({ kind: "oneshot" })
  })

  it("THE ROUND-6 DEFECT — a 404 is explained only as far as the box can tell: record without bytes (twin: refused; stable: removed by hand), bytes present (the route), or unknown", () => {
    const exp = (file: string) => ({ sha256: GOOD_SHA, file })
    // A twin whose record was carried without its bytes has two documented causes; the box says
    // which (THE ROUND-7 DEFECT: the first cut asserted "refused" for both). With the deploy's
    // .refused note: quoted. Without it: removed outside a deploy (INCIDENTS 4.8 step 1 is one way).
    const twinIn = { name: "agent-0.6.0", expected: exp("agent-0.6.0.tgz"), tarball: http(404), shaFile: ok(line(GOOD_SHA, "agent-0.6.0.tgz")), boxTarball: false }
    const note = "refused 2026-09-28T09:00:00Z by kit-carry-forward: live bytes 0123456789abcdef… did not match the record fedcba9876543210…\n"
    const refused = compareKit({ ...twinIn, boxRefused: note })
    expect(refused.findings).toEqual([
      expect.stringMatching(/the deploy refused to carry it: refused 2026-09-28T09:00:00Z by kit-carry-forward: live bytes 0123456789abcdef… did not match the record fedcba9876543210…; it stays paged until that version is re-served with its original bytes, or an operator retires it: printf 'retired %s — <why>\\n' "\$\(date -u \+%FT%TZ\)" > \/opt\/guild-saas\/kit\/agent-0\.6\.0\.tgz\.retired \(from the next deploy on the bytes are not carried and this 404 is the intended state; the record stays: the deploy guard still remembers this version's bytes — never delete a \.sha256\)/),
    ])
    const byHand = compareKit({ ...twinIn, boxRefused: null })
    expect(byHand.findings).toEqual([
      expect.stringMatching(/no agent-0\.6\.0\.tgz\.refused note — the deploy did not drop them, so the tarball was removed outside a deploy \(INCIDENTS 4\.8 step 1 is one way\); it stays paged until that version is re-served/),
    ])
    expect(byHand.findings[0]).not.toMatch(/deploy refused/)
    // THE ROUND-9 DEFECT: no remedy anywhere may say to remove a record — that is how the guard forgets a version.
    for (const f of [...refused.findings, ...byHand.findings]) expect(f).not.toMatch(/operator removes|\.sha256 \(and any|delete .* by hand/)
    // A RETIRED twin: its 404 is the intended state — no finding, `retired` carries the note; a served
    // record that differs from the box's is still a tamper; served BYTES are still checked in full.
    const retiredNote = "retired 2026-09-30T00:00:00Z — superseded by 0.7.0, nobody pins it\n"
    const retired = compareKit({ ...twinIn, boxRetired: retiredNote })
    expect(retired).toEqual({ findings: [], tamper: false, servedSha256: null, retired: retiredNote.trim(), servedWhileRetired: false })
    // A retired twin STILL served with its own bytes (note written, no deploy yet): no finding, but
    // the watcher must not say "404 expected" (round 10 of the review) — servedWhileRetired says so.
    const stillServed = compareKit({ ...twinIn, tarball: ok(GOOD), boxRetired: retiredNote })
    expect(stillServed).toEqual({ findings: [], tamper: false, servedSha256: GOOD_SHA, retired: retiredNote.trim(), servedWhileRetired: true })
    const retiredBadRecord = compareKit({ ...twinIn, shaFile: ok(line(EVIL_SHA, "agent-0.6.0.tgz")), boxRetired: retiredNote })
    expect(retiredBadRecord.tamper).toBe(true)
    expect(retiredBadRecord.findings).toEqual([expect.stringMatching(/^agent-0\.6\.0 \(retired\): the served agent-0\.6\.0\.tgz\.sha256 \(.*\) is not the one the deploy wrote/)])
    const retiredButServedEvil = compareKit({ ...twinIn, tarball: ok(EVIL), boxRetired: retiredNote })
    expect(retiredButServedEvil.tamper).toBe(true)
    expect(retiredButServedEvil.findings[0]).toMatch(/SERVED TARBALL DOES NOT MATCH THE DEPLOY/)
    // The stable file gone from the box beside its record: step 1 of the runbook, not a refused twin.
    const removed = compareKit({ name: "agent", expected, tarball: http(404), shaFile: ok(line(GOOD_SHA)), page: pageWith(GOOD_SHA), boxTarball: false })
    expect(removed.findings[0]).toMatch(/removed by hand \(INCIDENTS 4\.8 step 1\?\); \.\/scripts\/deploy\.sh --apply re-serves it/)
    expect(removed.findings[0]).not.toMatch(/refused/)
    // Bytes on the box but 404 from the site: the route, and nothing about refusal or removal.
    const route = compareKit({ name: "agent-0.6.0", expected: exp("agent-0.6.0.tgz"), tarball: http(404), shaFile: http(404), boxTarball: true })
    expect(route.findings[0]).toMatch(/the file is on the box, so this is the route: Caddy \/kit\/\* \(ops\/caddy\/Caddyfile\)/)
    expect(route.findings.join("\n")).not.toMatch(/refused|removed by hand/)
    // Caller cannot tell: both possibilities named, neither asserted.
    const unknown = compareKit({ name: "mcp", expected: exp("mcp.tgz"), tarball: http(404), shaFile: http(404) })
    expect(unknown.findings[0]).toMatch(/Caddy \/kit\/\* route, or \/opt\/guild-saas\/kit\/mcp\.tgz missing\?/)
  })

  it("compareKit's findings carry that wording per kit — never '/agents' or 'a config pins' for the mcp stable file", () => {
    const stable = compareKit({ name: "mcp", expected: { sha256: GOOD_SHA, file: "mcp.tgz" }, tarball: http(404), shaFile: http(404) })
    expect(stable.findings[0]).toMatch(/the one-shot URL \(\/kit\/mcp\.tgz; configs pin its versioned twin\) cannot install/)
    expect(stable.findings[1]).toMatch(/the -c check against the served \.sha256 has nothing to compare against/)
    expect(stable.findings.join("\n")).not.toMatch(/\/agents|a config pins/)
    const twin = compareKit({ name: "mcp-0.2.0", expected: { sha256: GOOD_SHA, file: "mcp-0.2.0.tgz" }, tarball: http(404), shaFile: ok(line(GOOD_SHA, "mcp-0.2.0.tgz")) })
    expect(twin.findings).toEqual([expect.stringMatching(/the versioned URL configs pin \(\/kit\/mcp-0\.2\.0\.tgz\) cannot install/)])
    const page = compareKit({ name: "agent", expected, tarball: http(404), shaFile: http(404), page: pageWith(GOOD_SHA) })
    expect(page.findings[0]).toMatch(/the one-liner on \/agents cannot install/)
    expect(page.findings[1]).toMatch(/the two-command check on \/agents has nothing/)
  })
})

describe("alertTexts", () => {
  const site = "https://radixguild.com"
  it("THE ROUND-5 DEFECT — an mcp-only tamper is titled after the mcp kit, and the detail names one-shot runs, not the /agents one-liner", () => {
    const t = alertTexts({ tamper: [{ name: "mcp", text: "mcp: SERVED TARBALL DOES NOT MATCH THE DEPLOY — …" }], broken: [], siteUrl: site })
    expect(t.tamperTitle).toBe("SERVED KIT DOES NOT MATCH THE DEPLOY — possible swap: mcp")
    expect(t.tamperTitle).not.toMatch(/AGENT KIT/)
    expect(t.tamperDetail).toMatch(/Every one-shot run of \/kit\/mcp\.tgz runs bytes the deploy did not write\./)
    expect(t.tamperDetail).not.toMatch(/\/agents/)
    expect(t.tamperDetail).toMatch(/rm \/opt\/guild-saas\/kit\/mcp\.tgz/)
    expect(t.tamperDetail).toMatch(/docs\/INCIDENTS\.md 4\.8/)
  })

  it("a broken twin is named by its pinned configs; a broken agent kit by the /agents one-liner — and the page never guesses WHY (the finding line carries that)", () => {
    const twin = alertTexts({ tamper: [], broken: [{ name: "agent-0.6.0", text: "agent-0.6.0: GET /kit/agent-0.6.0.tgz → 404 …" }], siteUrl: site })
    expect(twin.brokenTitle).toBe("Kit not served as deployed (404 / no hash file / stale page): agent-0.6.0")
    expect(twin.brokenDetail).toMatch(/Every config that pins \/kit\/agent-0\.6\.0\.tgz cannot install until this is fixed\./)
    expect(twin.brokenDetail).not.toMatch(/one-liner/)
    const agent = alertTexts({ tamper: [], broken: [{ name: "agent", text: "agent: GET /kit/agent.tgz → 404 …" }], siteUrl: site })
    expect(agent.brokenDetail).toMatch(new RegExp(`The one-liner on ${site}/agents cannot install until this is fixed\\.`))
    // THE ROUND-6 DEFECT: a Caddy /kit/* outage takes every kit down, twins included — the page
    // must not blame "a refused twin" for it. The cause lives in each finding line (compareKit,
    // which knows whether the box holds the bytes), never in the page's own summary.
    const outage = alertTexts({
      tamper: [],
      broken: [{ name: "agent", text: "a" }, { name: "mcp", text: "m" }, { name: "agent-0.6.0", text: "t" }],
      siteUrl: site,
    })
    expect(outage.brokenDetail).not.toMatch(/refused|stopped matching|by hand/)
    expect(outage.brokenDetail).toMatch(/Each line above says what the box knows about its own 404\./)
  })

  it("several kits at once: every affected kit is in the title once, each with its own consequence", () => {
    const t = alertTexts({
      tamper: [{ name: "agent", text: "a" }, { name: "agent", text: "b" }, { name: "mcp-0.2.0", text: "c" }],
      broken: [],
      siteUrl: site,
    })
    expect(t.tamperTitle).toBe("SERVED KIT DOES NOT MATCH THE DEPLOY — possible swap: agent, mcp-0.2.0")
    expect(t.tamperDetail).toMatch(/The one-liner on https:\/\/radixguild\.com\/agents runs bytes/)
    expect(t.tamperDetail).toMatch(/Every config that pins \/kit\/mcp-0\.2\.0\.tgz runs bytes/)
    expect(t.tamperDetail).toMatch(/rm \/opt\/guild-saas\/kit\/<name>\.tgz/)
  })
})
