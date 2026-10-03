#!/usr/bin/env bun
// kit-hash-watch.mjs — keyless, read-only watcher on the SERVED agent kit.
//
//   bun scripts/kit-hash-watch.mjs                       # check + alert
//   bun scripts/kit-hash-watch.mjs --kit agent --kit mcp # more than one kit
//   bun scripts/kit-hash-watch.mjs --dry-run             # print the decision, send nothing, persist nothing
//
// WHY (docs/design/bring-your-agent.md §2.4 "Integrity — owed before S1"): the
// one-liner on /agents runs whatever https://radixguild.com/kit/agent.tgz IS at
// that moment, and a key made by a tampered kit is a stolen key. The deploy
// (scripts/deploy.sh → scripts/pack-kit.sh) writes /opt/guild-saas/kit/agent.tgz
// and agent.tgz.sha256 in the same atomic swap as the app build, and the app it
// builds is meant to print that hash on /agents beside the line (the kit card,
// src/components/agents/kit-card.tsx — PR #802; a build without it makes the page
// check below report "does not print", the honest state). This script is the third
// leg: every 30 minutes it fetches what the site actually serves and compares.
//
// WHAT IT CHECKS, per kit (scripts/lib/kit-hash.mjs `compareKit` — pure, unit
// tested in tests/unit/kit-hash.test.ts):
//   1. the box's <name>.tgz.sha256 exists and is a "<hex>  file" line (the expectation);
//   2. GET /kit/<name>.tgz answers 200 and its bytes hash to that expectation;
//   3. GET /kit/<name>.tgz.sha256 answers 200 with that same line;
//   4. for the kits /agents prints (PAGE_KITS — the agent kit, whose one-liner
//      makes a key): GET /agents carries that hash, so the check the page tells
//      people to run would actually pass — a page showing a different hash is
//      its own incident. The MCP kit is read-only and is not printed on the page.
//   5. every VERSIONED twin the box holds a RECORD for (<name>-<version>.tgz.sha256
//      files) is checked like the stable file (1–3) — those are the URLs long-lived
//      configs pin, and the deploy carries them forward (scripts/kit-carry-forward.sh).
//      A twin the deploy refused to carry (its bytes stopped matching its record) keeps
//      its record on the box WITHOUT its bytes, so its URL stays in this list and pages
//      as a 404 until that version is re-served or an operator RETIRES it with a
//      <name>.tgz.retired note (records are never deleted: they are the deploy guard's
//      memory) — a twin that vanished from the box would otherwise vanish from this
//      check too (rounds 5 and 9 of the review).
// Default kits: `agent` (S1) and `mcp` (P1) — the two scripts/deploy.sh packs. Every
// page names the kits affected (a twin, the mcp kit) — never "Agent kit" for all.
// A hash MISMATCH (2 or 3) is the tamper class and pages at once. Everything
// else (404, no response, a stale page, no file on the box) is a broken surface:
// it pages after holding one run, so a Caddy reload or a deploy in progress does
// not fire a 🔴 and a 🟢 twenty minutes apart.
//
// FETCHED OVER HTTPS THROUGH CADDY, NEVER READ OFF DISK: the served bytes are
// what an outsider gets, and only that path sees a swapped file, a wrong route,
// a stale cache or a lookalike upstream. The box file is only ever the EXPECTATION.
//
// Alerts: reuses KEEPER_ALERT_TG_TOKEN + KEEPER_ALERT_TG_CHAT — the SAME rail
// the keeper, the drift watcher and mint-volume-watch.mjs page on — through the
// shared edge-triggered evaluator (src/lib/alert-core: raise once, remind with
// backoff, one 🟢 on recovery). Two alert keys, so a tamper and a mere outage are
// distinct incidents with distinct recoveries. Without the two vars set, every
// raise/remind/clear still logs in full — it is only never sent.
//
// STATE: the backoff stamp is a small JSON file (mint-volume.mjs's FileAlertStore),
// /var/lib/guild-kit-hash-alert.json by default — not Postgres, so this keeps
// working through a DB pause. No chain read, so no network-halt guard: a halted
// ledger does not change what a tarball should hash to.
//
// EXIT: 0 on a completed run, tamper or not — the Telegram page IS the signal,
// and cron reads nothing else. Exit 1 only for a bad CLI argument. Exit 2 when a
// KIT could not be judged at all is NOT a thing here: an unreachable site is a
// finding, reported through the same rail, because "could not check" must never
// look like "checked and fine".
//
// Cron (documented in CLAUDE.md "Production / SSH (Guild VPS)" beside the other
// watchers; install with the S1 deploy — before it, the kit is not served and
// every run would page "404"):
//   */30 * * * * cd /opt/guild-saas/guild-app && /root/.bun/bin/bun scripts/kit-hash-watch.mjs >> /var/log/guild-kit-hash.log 2>&1
//
// Runbook for a 🔴 from this script: docs/INCIDENTS.md 4.8 "The kit tarball may
// have been swapped".

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseCliArgs, usageText, readExpected, fetchServed, compareKit, kitTarballUrl, versionedKits, alertTexts, PAGE_KITS, UsageError } from "./lib/kit-hash.mjs"
import { FileAlertStore, previewStore } from "./lib/mint-volume.mjs"
import { createAlertEvaluator, SUGGESTED_REMOTE_READ_DEBOUNCE_MS } from "../src/lib/alert-core"
import { sendTelegramMessage } from "../src/lib/tg-alert"
import { KIT_TARBALL_URL, SITE_URL } from "../src/lib/config"

const log = (...args) => console.log("[kit-hash]", ...args)

const STAMP_PATH = process.env.GUILD_KIT_HASH_ALERT_STAMP ?? "/var/lib/guild-kit-hash-alert.json"

let settings
try {
  settings = parseCliArgs(process.argv.slice(2))
} catch (err) {
  if (err instanceof UsageError) {
    console.error(err.message)
    console.error(usageText())
    process.exit(1)
  }
  throw err
}
const { kitDir, kits, dryRun } = settings

// Fetch the page once; the kits in PAGE_KITS are expected to have their hash on it.
const page = kits.some((k) => PAGE_KITS.includes(k)) ? await fetchServed(`${SITE_URL}/agents`) : null

const tamperLines = []
const brokenLines = []
// Every stable kit, then every versioned twin the box holds for it (the URLs
// long-lived configs pin — checked like the stable file, without the page leg).
const names = kits.flatMap((k) => [k, ...versionedKits(kitDir, k)])
for (const name of names) {
  const expected = readExpected(kitDir, name)
  // The URL the page advertises (KIT_TARBALL_URL), never retyped here.
  const url = kitTarballUrl(name, KIT_TARBALL_URL)
  const [tarball, shaFile] = await Promise.all([fetchServed(url), fetchServed(`${url}.sha256`)])
  // Whether the bytes are on the box beside their record: a 404 is then explained as
  // what it is (a record kept without bytes vs. the route) instead of guessed.
  const boxTarball = existsSync(join(kitDir, `${name}.tgz`))
  // The deploy's carry-forward leaves <name>.tgz.refused beside a record whose bytes IT
  // dropped; its absence means the tarball went some other way (an operator's rm).
  const refusedPath = join(kitDir, `${name}.tgz.refused`)
  const boxRefused = existsSync(refusedPath) ? readFileSync(refusedPath, "utf8") : null
  // An operator's <name>.tgz.retired note: this twin's 404 is intended; its record stays.
  const retiredPath = join(kitDir, `${name}.tgz.retired`)
  const boxRetired = existsSync(retiredPath) ? readFileSync(retiredPath, "utf8") : null
  const result = compareKit({ name, expected, tarball, shaFile, page: PAGE_KITS.includes(name) ? page : null, boxTarball, boxRefused, boxRetired })
  log(
    `${name}: expected ${expected?.sha256 ?? "(none on the box)"} — served ${result.servedSha256 ?? `(HTTP ${tarball.status || "none"})`} — ` +
      `${
        result.findings.length === 0
          ? result.retired
            ? result.servedWhileRetired
              ? `retired but still served with matching bytes — the next deploy stops serving it (${result.retired})`
              : `retired, 404 expected (${result.retired})`
            : "OK"
          : `${result.findings.length} finding(s)${result.tamper ? " [TAMPER]" : ""}`
      }`,
  )
  for (const f of result.findings) {
    log(`  ${f}`)
    ;(result.tamper ? tamperLines : brokenLines).push({ name, text: f })
  }
}

// Titles and details name the kits that are actually affected (a twin, the mcp kit) —
// not "Agent kit" for everything (agent-pr-review on #803, round 5).
const texts = alertTexts({ tamper: tamperLines, broken: brokenLines, siteUrl: SITE_URL })

// ── Evaluate through the shared edge-trigger + backoff policy ──────────────
const store = dryRun ? previewStore(new FileAlertStore(STAMP_PATH)) : new FileAlertStore(STAMP_PATH)
const send = dryRun
  ? async (text, { silent }) => {
      log(`DRY-RUN would send${silent ? " (silent)" : ""}:\n${text}`)
      return true
    }
  : (text, opts) => sendTelegramMessage(text, opts)

const evaluate = createAlertEvaluator({
  store,
  send,
  onError: (err, key) => log(`WARN store failure for '${key}': ${err?.message ?? err} — alert not evaluated`),
})

// Tamper: no debounce. The served bytes are not the deploy's bytes — every
// minute the one-liner stays up is a minute of keys made by an unknown kit.
const tamperOutcome = await evaluate({
  key: "kit-hash-tamper",
  condition: tamperLines.length > 0,
  title: texts.tamperTitle,
  detail: texts.tamperDetail,
})

// Broken surface: debounced one remote-read cycle so a reload or a deploy in
// flight does not page; a tamper already open inhibits this so one incident
// does not arrive as two threads.
const brokenOutcome = await evaluate({
  key: "kit-hash-unserved",
  condition: brokenLines.length > 0,
  inhibitedBy: "kit-hash-tamper",
  debounceMs: SUGGESTED_REMOTE_READ_DEBOUNCE_MS,
  title: texts.brokenTitle,
  detail: texts.brokenDetail,
})

log(
  `kits ${names.join(",")} — tamper ${tamperLines.length} (outcome '${tamperOutcome}') — ` +
    `broken ${brokenLines.length} (outcome '${brokenOutcome}')${dryRun ? " [dry-run]" : ""}`,
)
process.exit(0)
