// kit-hash.mjs — pure/testable helpers for scripts/kit-hash-watch.mjs.
//
// Kept side-effect-free at import (no top-level fs/env/network access, no
// top-level await) so it can be unit tested directly — same precedent as
// mint-volume.mjs, keeper-alert.mjs and network-halt-guard.mjs in this
// directory. The watcher script wires these to the real filesystem, fetch and
// the Telegram rail; nothing in here touches any of them unasked.

import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"

// ── CLI argument handling ────────────────────────────────────────────────────

export class UsageError extends Error {}

export const DEFAULT_KIT_DIR = "/opt/guild-saas/kit"
/** The kits the deploy writes and this watcher checks, by URL name — one per
 *  `pack-kit.sh --name` in scripts/deploy.sh: `agent` (S1) and `mcp` (P1). */
export const DEFAULT_KITS = ["agent", "mcp"]
/** The kits whose sha256 /agents is expected to print. Only the agent kit's: its
 *  one-liner makes a key, so the page carries its hash for people to check (the kit
 *  card, guild-app/src/components/agents/kit-card.tsx — PR #802; on a build without
 *  it the page check reports "does not print", which is the honest state). The MCP
 *  server is read-only with no secrets; its hash is served beside it
 *  (/kit/mcp.tgz.sha256), not printed on the page. */
export const PAGE_KITS = ["agent"]

export function usageText() {
  return [
    "Usage: bun scripts/kit-hash-watch.mjs [--kit-dir <dir>] [--kit <name>]... [--dry-run]",
    `  --kit-dir <dir>   where the deploy wrote <name>.tgz.sha256 (default ${DEFAULT_KIT_DIR}; env GUILD_KIT_DIR)`,
    `  --kit <name>      a kit to check; repeatable (default: ${DEFAULT_KITS.join(", ")})`,
    "  --dry-run         evaluate + print the decision; send nothing, persist nothing",
  ].join("\n")
}

/**
 * Parse argv (process.argv.slice(2)) + env into this run's settings.
 * Throws UsageError on anything unparsable — the caller prints usageText()
 * and exits 1, the contract mint-volume-watch.mjs uses.
 */
export function parseCliArgs(argv, env = process.env) {
  let kitDir = env.GUILD_KIT_DIR ?? DEFAULT_KIT_DIR
  const kits = []
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--dry-run") {
      dryRun = true
      continue
    }
    if (arg === "--kit-dir") {
      kitDir = argv[++i]
      if (!kitDir) throw new UsageError("--kit-dir needs a directory")
      continue
    }
    if (arg === "--kit") {
      const name = argv[++i]
      if (!name || !/^[a-z0-9-]+$/.test(name)) {
        throw new UsageError(`--kit must be a [a-z0-9-] kit name, got ${JSON.stringify(name)}`)
      }
      kits.push(name)
      continue
    }
    throw new UsageError(`unrecognized argument: ${arg}`)
  }
  return { kitDir, kits: kits.length > 0 ? kits : [...DEFAULT_KITS], dryRun }
}

// ── The expected hash: what the deploy wrote ─────────────────────────────────

const SHA256_LINE_RE = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i

/**
 * Parse a `<hex>  <file>` line (the `sha256sum -c` format scripts/pack-kit.sh
 * writes). Returns null for anything else — a truncated or hand-edited file
 * must read as "no expectation", never as a hash that happens to match nothing.
 */
export function parseSha256File(text) {
  const first = String(text ?? "").split("\n").find((l) => l.trim() !== "") ?? ""
  const m = SHA256_LINE_RE.exec(first.trim())
  if (!m) return null
  return { sha256: m[1].toLowerCase(), file: m[2] }
}

/** Read `<kitDir>/<name>.tgz.sha256`; null when missing or malformed. */
export function readExpected(kitDir, name, read = (p) => readFileSync(p, "utf8")) {
  try {
    return parseSha256File(read(`${kitDir}/${name}.tgz.sha256`))
  } catch {
    return null
  }
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Where kit `name` is served, derived from the ONE configured kit URL
 * (src/lib/config.ts KIT_TARBALL_URL — `${SITE_URL}/kit/agent.tgz` unless
 * NEXT_PUBLIC_KIT_TARBALL_URL moves it). The agent kit IS that URL; any other
 * kit is a sibling file in the same directory. Derived, not retyped, so that
 * if the page ever advertises a moved URL the watcher hashes the moved file —
 * a watcher on a stale path would read "404" while the page pointed elsewhere.
 */
/** A version-shaped suffix: semver core, optional -prerelease and +build (npm's grammar). */
export const VERSION_SUFFIX = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?"
const VERSIONED_NAME = new RegExp(`^[a-z0-9-]+-(${VERSION_SUFFIX})$`)

/**
 * The versioned twins the deploy wrote for kit `name`: every `<name>-<version>.tgz.sha256`
 * in the kit dir, as kit names (`mcp-0.2.0`) usable with readExpected/kitTarballUrl.
 * The watcher checks each one like the stable file, minus the page check: these are the
 * URLs long-lived configs pin (agent-pr-review on #803, round 3 — they were unwatched).
 */
export function versionedKits(kitDir, name, list = (d) => readdirSync(d)) {
  let files
  try {
    files = list(kitDir)
  } catch {
    return []
  }
  // Version-shaped suffix only (semver core, optional -pre and +build): a kit whose own
  // name carries a dash can never be read as another kit's twin. Listed by the RECORD
  // (.sha256), not the tarball: a twin the deploy refused to carry keeps its record on the
  // box without its bytes (scripts/kit-carry-forward.sh), so its URL stays checked — and
  // 404s — until that version is re-served or an operator RETIRES it with a <name>.tgz.retired
  // note; records are never deleted (agent-pr-review on #803, round 5:
  // a dropped twin was simply absent from this list, and nothing ever paged for it).
  const re = new RegExp(`^${name}-(${VERSION_SUFFIX})\\.tgz\\.sha256$`)
  return files
    .filter((f) => re.test(f))
    .map((f) => f.replace(/\.tgz\.sha256$/, ""))
    .sort()
}

/**
 * What a served kit file is FOR — the sentence every finding and alert hangs on, so an
 * operator paged about it knows which consumer is affected (agent-pr-review on #803,
 * round 5: one phrase covered three different things).
 *
 *   page     the agent kit's stable file: the one-liner printed on /agents makes a key
 *   pinned   a versioned twin <name>-<version>.tgz: what long-lived configs pin
 *   oneshot  any other stable file (mcp.tgz): one-shot `npx -p` runs; configs pin its twin
 */
export function kitSurface(name, onPage = false) {
  if (onPage) {
    return { kind: "page", what: "the one-liner on /agents", check: "the two-command check on /agents", fails: "the one-liner on /agents" }
  }
  if (VERSIONED_NAME.test(name)) {
    return {
      kind: "pinned",
      what: `the versioned URL configs pin (/kit/${name}.tgz)`,
      check: "the -c check against the served .sha256",
      fails: `every config that pins /kit/${name}.tgz`,
    }
  }
  return {
    kind: "oneshot",
    what: `the one-shot URL (/kit/${name}.tgz; configs pin its versioned twin)`,
    check: "the -c check against the served .sha256",
    fails: `every one-shot run of /kit/${name}.tgz`,
  }
}

/**
 * The page texts for the two alert keys, named after the kits actually affected — never
 * "Agent kit" when the mcp kit or a twin is what broke (agent-pr-review on #803, round 5).
 * `tamper` / `broken`: arrays of { name, text } as compareKit produced them.
 */
export function alertTexts({ tamper, broken, siteUrl, pageKits = PAGE_KITS }) {
  const names = (rows) => [...new Set(rows.map((r) => r.name))]
  const consequences = (rows, verb) =>
    names(rows)
      .map((n) => {
        const s = kitSurface(n, pageKits.includes(n))
        return s.kind === "page" ? `The one-liner on ${siteUrl}/agents ${verb}` : `${s.fails[0].toUpperCase()}${s.fails.slice(1)} ${verb}`
      })
      .join(" ")
  const tamperNames = names(tamper)
  const brokenNames = names(broken)
  return {
    tamperTitle: `SERVED KIT DOES NOT MATCH THE DEPLOY — possible swap: ${tamperNames.join(", ")}`,
    tamperDetail:
      `${tamper.map((r) => r.text).join("\n")}\n\n${consequences(tamper, "runs bytes the deploy did not write.")}\n\n` +
      `Runbook: docs/INCIDENTS.md 4.8. Stop serving it first (rm /opt/guild-saas/kit/${tamperNames.length === 1 ? `${tamperNames[0]}.tgz` : "<name>.tgz"}), then investigate.`,
    brokenTitle: `Kit not served as deployed (404 / no hash file / stale page): ${brokenNames.join(", ")}`,
    brokenDetail:
      `${broken.map((r) => r.text).join("\n")}\n\n${consequences(broken, "cannot install until this is fixed.")} ` +
      `Each line above says what the box knows about its own 404. Check the Caddy /kit/* route and /opt/guild-saas/kit, then ./scripts/deploy.sh --apply.`,
  }
}

export function kitTarballUrl(name, base) {
  if (name === "agent") return base
  const cut = base.lastIndexOf("/")
  if (cut === -1) throw new Error(`kit URL has no path: ${base}`)
  return `${base.slice(0, cut)}/${name}.tgz` // works for a twin too: name = "mcp-0.2.0"
}

// ── Fetching what is served ──────────────────────────────────────────────────

const DEFAULT_FETCH_TIMEOUT_MS = 30_000

/**
 * GET one URL with a timeout, never throwing: the watcher's job is to REPORT
 * an unreachable kit, so a network failure is a finding, not a crash. `bytes`
 * is a Uint8Array on 2xx; `status` is 0 when no response arrived at all.
 *
 * `cache: "no-store"` because the whole point is what the origin serves NOW —
 * a cached copy from a previous run would hide exactly the swap this looks for.
 */
export async function fetchServed(url, { fetchImpl = fetch, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  try {
    const res = await fetchImpl(url, {
      cache: "no-store",
      headers: { "user-agent": "guild-kit-hash-watch/1 (+https://radixguild.com/agents)" },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const bytes = new Uint8Array(await res.arrayBuffer())
    return { ok: res.ok, status: res.status, bytes, error: null }
  } catch (err) {
    return { ok: false, status: 0, bytes: new Uint8Array(0), error: err instanceof Error ? err.message : String(err) }
  }
}

// ── The comparison ───────────────────────────────────────────────────────────

/**
 * Compare what the deploy wrote against what the site serves, for one kit.
 * Pure over its inputs so every branch is unit-testable.
 *
 *   expected    parseSha256File(...) of the box's <name>.tgz.sha256, or null
 *   tarball     fetchServed(<site>/kit/<name>.tgz)
 *   shaFile     fetchServed(<site>/kit/<name>.tgz.sha256)
 *   page        fetchServed(<site>/agents) — the HTML that prints the hash; optional
 *   boxTarball  whether /opt/guild-saas/kit/<name>.tgz exists on the box (true/false), or
 *               undefined when the caller cannot tell — decides how a 404 is explained
 *   boxRefused  the text of /opt/guild-saas/kit/<name>.tgz.refused when the deploy's
 *               carry-forward wrote one (it dropped the bytes itself), else null/undefined
 *   boxRetired  the text of /opt/guild-saas/kit/<name>.tgz.retired when an operator retired
 *               this twin (a 404 is then the intended state and is not a finding; a SERVED
 *               file that does not match its record is still a tamper), else null/undefined
 *
 * Returns { findings, tamper, servedSha256, retired, servedWhileRetired }. `tamper` is the one finding class
 * that must page immediately (the served bytes are not the deploy's bytes);
 * everything else is a broken or stale surface and may be debounced one run.
 *
 * Every mismatch names both hashes in full: an operator reading the page must
 * be able to check it against the box and the site without re-running anything.
 */
export function compareKit({ name, expected, tarball, shaFile, page = null, boxTarball = undefined, boxRefused = undefined, boxRetired = undefined }) {
  const findings = []
  let tamper = false
  let servedSha256 = null
  const retired = typeof boxRetired === "string" && boxRetired.trim() !== "" ? boxRetired.trim() : null

  // A retired twin: its record stays on the box (the deploy guard's memory) and is still
  // served as <name>.tgz.sha256; its tarball is expected to 404. So a 404 is not a finding —
  // but a SERVED record that differs from the box's is still a tamper, and a tarball that IS
  // served falls through to the full check below (retired does not mean "ignore bytes").
  if (retired && !tarball.ok) {
    if (shaFile.ok && expected) {
      const served = parseSha256File(new TextDecoder().decode(shaFile.bytes))
      if (served && served.sha256 !== expected.sha256) {
        tamper = true
        findings.push(`${name} (retired): the served ${name}.tgz.sha256 (${served.sha256}) is not the one the deploy wrote (${expected.sha256})`)
      }
    }
    return { findings, tamper, servedSha256, retired, servedWhileRetired: false }
  }

  if (!expected) {
    findings.push(
      `${name}: no ${name}.tgz.sha256 on the box (or not a "<hex>  file" line) — the deploy has not written this kit, ` +
        `or the file was edited; nothing to compare the served tarball against`,
    )
  }

  // Wording follows what the file is for (kitSurface): the agent kit's stable file is the
  // one-liner on /agents; a versioned twin is what configs pin; any other stable file
  // (mcp.tgz) is for one-shot runs and configs pin ITS twin.
  const onPage = page !== null
  const { kind, what, check } = kitSurface(name, onPage)
  if (!tarball.ok) {
    // Why the 404, as far as the box can tell (boxTarball: does /opt/guild-saas/kit/<name>.tgz
    // exist beside its record?). A cause is stated only when it is known — round 6 of the
    // review: one alert blamed "a refused twin" for every 404 that involved a version-shaped
    // name, including a plain Caddy outage.
    // A twin's record without its bytes has two documented causes and the box says which:
    // the deploy's carry-forward writes <name>.tgz.refused beside the record when IT dropped
    // the bytes; without that note the tarball was removed outside a deploy (INCIDENTS 4.8
    // step 1 is one way) — records are only ever written beside bytes (pack-kit), so there is
    // no third cause. Round 7 of the review: the first cut asserted "refused" for both.
    const refusedNote = typeof boxRefused === "string" && boxRefused.trim() !== "" ? boxRefused.trim() : null
    // Records are never deleted — they are the deploy guard's memory of which bytes a version
    // meant (round 9 of the review: "remove the record by hand" was the one sanctioned action
    // that made the guard forget). A twin nobody will serve again is RETIRED with a note instead.
    const twinRemedy =
      `it stays paged until that version is re-served with its original bytes, or an operator retires it: ` +
      `printf 'retired %s — <why>\\n' "$(date -u +%FT%TZ)" > /opt/guild-saas/kit/${name}.tgz.retired ` +
      `(from the next deploy on the bytes are not carried and this 404 is the intended state; the record stays: ` +
      `the deploy guard still remembers this version's bytes — never delete a .sha256)`
    const cause =
      boxTarball === false && kind === "pinned"
        ? refusedNote
          ? `the box holds its record but not its bytes — the deploy refused to carry it: ${refusedNote}; ${twinRemedy}`
          : `the box holds its record but not its bytes, and no ${name}.tgz.refused note — the deploy did not drop them, so the tarball was removed outside a deploy (INCIDENTS 4.8 step 1 is one way); ${twinRemedy}`
        : boxTarball === false
          ? `the box holds its record but not its bytes — removed by hand (INCIDENTS 4.8 step 1?); ./scripts/deploy.sh --apply re-serves it`
          : boxTarball === true
            ? `the file is on the box, so this is the route: Caddy /kit/* (ops/caddy/Caddyfile)`
            : `Caddy /kit/* route, or /opt/guild-saas/kit/${name}.tgz missing?`
    findings.push(
      `${name}: GET /kit/${name}.tgz → ${tarball.status || "no response"}${tarball.error ? ` (${tarball.error})` : ""} — ` +
        `${what} cannot install (${cause})`,
    )
  } else {
    servedSha256 = sha256Hex(tarball.bytes)
    if (expected && servedSha256 !== expected.sha256) {
      tamper = true
      findings.push(
        `${name}: SERVED TARBALL DOES NOT MATCH THE DEPLOY — served sha256 ${servedSha256} vs ${expected.sha256} on the box. ` +
          `Treat as a swap until proven otherwise: docs/INCIDENTS.md 4.8.`,
      )
    }
  }

  if (!shaFile.ok) {
    findings.push(
      `${name}: GET /kit/${name}.tgz.sha256 → ${shaFile.status || "no response"}${shaFile.error ? ` (${shaFile.error})` : ""} — ` +
        `${check} has nothing to compare against`,
    )
  } else {
    const served = parseSha256File(new TextDecoder().decode(shaFile.bytes))
    if (!served) {
      findings.push(`${name}: the served ${name}.tgz.sha256 is not a "<hex>  file" line`)
    } else if (expected && served.sha256 !== expected.sha256) {
      tamper = true
      findings.push(
        `${name}: the served ${name}.tgz.sha256 (${served.sha256}) is not the one the deploy wrote (${expected.sha256})`,
      )
    }
  }

  if (page && expected) {
    if (!page.ok) {
      findings.push(`${name}: GET /agents → ${page.status || "no response"} — cannot confirm the page prints the hash`)
    } else if (!new TextDecoder().decode(page.bytes).includes(expected.sha256)) {
      findings.push(
        `${name}: /agents does not print ${expected.sha256} — the page shows a different hash than the deploy wrote ` +
          `(a stale build, or a build that did not get NEXT_PUBLIC_KIT_SHA256); a person running the check would see a mismatch`,
      )
    }
  }

  // A retired twin that is still served (its note was written but no deploy has run since,
  // so its bytes are still on the box): the watcher says so instead of "404 expected".
  return { findings, tamper, servedSha256, retired, servedWhileRetired: retired !== null && tarball.ok }
}
