// mint-volume.mjs — pure/testable helpers for scripts/mint-volume-watch.mjs.
//
// Kept side-effect-free at import (no top-level DB/env/network access, no
// top-level await) so it can be unit tested directly — same precedent as
// keeper-alert.mjs and network-halt-guard.mjs in this directory ("kept
// side-effect-free so it can be unit tested").

import { readFileSync, writeFileSync } from "node:fs"

// ── CLI / env argument handling ─────────────────────────────────────────────

export class UsageError extends Error {}

export const DEFAULT_WINDOW_HOURS = 24
export const DEFAULT_THRESHOLD = 20

export function usageText() {
  return [
    "Usage: bun scripts/mint-volume-watch.mjs [--window-hours <n>] [--threshold <n>] [--dry-run]",
    "  --window-hours <n>  rolling window in hours (default 24)",
    "  --threshold <n>     mints in the window that cross the alert condition",
    "                      (default: $MINT_VOLUME_ALERT_THRESHOLD, else 20)",
    "  --dry-run           evaluate + print the decision; send nothing, persist nothing",
  ].join("\n")
}

/**
 * Parse argv (process.argv.slice(2)) + env into this run's settings.
 * Throws UsageError on anything unparsable — the caller prints usageText()
 * and exits 1, same contract reconcile-escrow.mjs's own arg check uses.
 */
export function parseCliArgs(argv, env = process.env) {
  let windowHours = DEFAULT_WINDOW_HOURS
  let threshold =
    env.MINT_VOLUME_ALERT_THRESHOLD !== undefined
      ? Number(env.MINT_VOLUME_ALERT_THRESHOLD)
      : DEFAULT_THRESHOLD
  let dryRun = false
  let windowHoursRaw = null
  let thresholdRaw = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--dry-run") {
      dryRun = true
      continue
    }
    if (arg === "--window-hours") {
      windowHoursRaw = argv[++i]
      windowHours = Number(windowHoursRaw)
      continue
    }
    if (arg === "--threshold") {
      thresholdRaw = argv[++i]
      threshold = Number(thresholdRaw)
      continue
    }
    throw new UsageError(`unrecognized argument: ${arg}`)
  }

  if (!(Number.isFinite(windowHours) && windowHours > 0)) {
    throw new UsageError(
      `--window-hours must be a positive number, got ${JSON.stringify(windowHoursRaw)}`,
    )
  }
  if (!(Number.isFinite(threshold) && threshold >= 0)) {
    throw new UsageError(
      thresholdRaw !== null
        ? `--threshold must be a non-negative number, got ${JSON.stringify(thresholdRaw)}`
        : `MINT_VOLUME_ALERT_THRESHOLD must be a non-negative number, got ${JSON.stringify(env.MINT_VOLUME_ALERT_THRESHOLD)}`,
    )
  }
  return { windowHours, threshold, dryRun }
}

// ── Gateway paging ───────────────────────────────────────────────────────────

const DEFAULT_LIMIT_PER_PAGE = 100
const DEFAULT_MAX_PAGES = 50
const DEFAULT_FETCH_TIMEOUT_MS = 15_000

/**
 * Page the Gateway tx stream BACKWARD from the tip (`order: "Desc"`), pinned
 * to the BadgeManager component (every `public_mint` call necessarily
 * affects it — same "affected_global_entities_filter" pattern
 * escrow-drift-watch.mjs/reconcile-escrow.mjs pin to ESCROW_COMPONENT), and
 * collect MintNonFungibleResourceEvent timestamps for `badgeResource` —
 * fail-closed emitter pin, the SAME rule those two scripts use for escrow
 * events, so a look-alike event from an unrelated resource can never inflate
 * the count.
 *
 * Stops once a page's transactions fall behind `since` (mints only get
 * OLDER as paging continues in Desc order) or `maxPages` is hit, whichever
 * first. May return a few stragglers just past `since` — harmless, since the
 * caller hands the full list to `rollingThresholdCondition`
 * (packages/alert-policy), which does the precise windowing.
 *
 * A transient Gateway failure (bad HTTP status, network error, timeout)
 * THROWS rather than degrading to an empty result — same posture as
 * reconcile-escrow.mjs's fetchPage: an unreadable page must never silently
 * read as "zero mints". A single malformed transaction or event inside an
 * otherwise-good page is skipped defensively instead.
 */
export async function fetchMintTimestamps({
  gateway,
  badgeManagerComponent,
  badgeResource,
  since,
  now,
  fetchImpl = fetch,
  limitPerPage = DEFAULT_LIMIT_PER_PAGE,
  maxPages = DEFAULT_MAX_PAGES,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  log = () => {},
}) {
  const timestampsMs = []
  let cursor = null
  let pinnedSv = null
  let pages = 0
  let scannedTxs = 0
  let matchedEvents = 0
  let crossedWindow = false

  do {
    const body = {
      order: "Desc",
      limit_per_page: limitPerPage,
      affected_global_entities_filter: [badgeManagerComponent],
      opt_ins: { receipt_events: true },
    }
    if (cursor) {
      body.cursor = cursor
      // Pin pagination to the first page's ledger snapshot so pages stay
      // consistent — same technique escrow-resync.ts/reconcile-escrow.mjs use.
      body.at_ledger_state = { state_version: pinnedSv }
    }

    let resp
    try {
      resp = await fetchImpl(`${gateway}/stream/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      const kind = err?.name === "TimeoutError" ? "timeout" : "network-error"
      throw new Error(`[gateway-transient] /stream/transactions ${kind}: ${err?.message ?? err}`)
    }
    if (!resp.ok) {
      throw new Error(`Gateway /stream/transactions HTTP ${resp.status}`)
    }
    const page = await resp.json()
    pinnedSv = pinnedSv ?? page?.ledger_state?.state_version ?? null

    for (const tx of page?.items ?? []) {
      if (tx?.transaction_status !== "CommittedSuccess") continue
      scannedTxs++
      // round_timestamp is present on every stream item (unlike confirmed_at,
      // which the SDK types as optional); confirmed_at is tried first only
      // because it is what the rest of this codebase already reads
      // (src/lib/gateway.ts:245) when both are available.
      const tsRaw = tx?.confirmed_at ?? tx?.round_timestamp
      const ts = typeof tsRaw === "string" ? Date.parse(tsRaw) : NaN
      if (!Number.isFinite(ts)) continue // unparseable timestamp — skip, never guessed
      if (ts < since) {
        crossedWindow = true
        continue // still finish this page (order can wobble tx-to-tx within it)
      }
      for (const ev of tx?.receipt?.events ?? []) {
        if (ev?.name !== "MintNonFungibleResourceEvent") continue
        if (ev?.emitter?.entity?.entity_address !== badgeResource) continue
        timestampsMs.push(ts)
        matchedEvents++
      }
    }

    cursor = page?.next_cursor ?? null
    pages++
  } while (cursor && pages < maxPages && !crossedWindow)

  const truncated = !!cursor && pages >= maxPages && !crossedWindow
  if (truncated) {
    log(
      `WARN scan capped at ${maxPages} pages (${scannedTxs} tx scanned) before reaching the ` +
        `window start — count may be a floor, not exact`,
    )
  }
  return { timestampsMs, scannedTxs, matchedEvents, pages, truncated }
}

// ── Persisted alert state, file-backed (no DATABASE_URL needed) ────────────

/**
 * AlertStore (packages/alert-policy's interface — duck-typed here, this file
 * has no TS import of it) backed by one small JSON file. Same convention as
 * escrow-drift-watch.mjs's INACTIVE_STAMP/DISPUTE_STAMP and keeper.mjs's
 * KEEPER_LAPSED_STAMP: `/var/lib` is where this box already keeps cron state.
 *
 * Deliberately NOT guild-app/src/lib/alert-store.ts's Postgres DbAlertStore.
 * This watcher has no task/DB linkage at all — it is a pure Gateway read —
 * and the DB is a dependency this keyless, read-only cron should not need:
 * the 2026-09-04 wind-down paused it with no restart date set, and mint
 * volume must still be watchable while that stands.
 *
 * Single-key store in practice (this script only ever evaluates the
 * "mint-volume" key, with no inhibitor), so `listInhibitedBy` always
 * returns `[]` — kept general (multi-key JSON blob) rather than assuming
 * that, in case a second volume alert is added later.
 */
export class FileAlertStore {
  constructor(path) {
    this.path = path
  }

  readAll() {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"))
      return raw && typeof raw === "object" ? raw : {}
    } catch {
      return {}
    }
  }

  writeAll(all) {
    writeFileSync(this.path, JSON.stringify(all), "utf8")
  }

  async get(key) {
    const all = this.readAll()
    return all[key] ?? null
  }

  /** Optimistic-concurrency claim, same contract as MemoryAlertStore/SqliteAlertStore/DbAlertStore. */
  async claim(next, expectedVersion) {
    const all = this.readAll()
    const current = all[next.key] ?? null
    const currentVersion = current ? current.version : null
    if (currentVersion !== expectedVersion) return false
    all[next.key] = next
    try {
      this.writeAll(all)
    } catch {
      // Fail toward "lost the race" rather than silently claiming a write
      // that never landed — the caller must not send on an unwritten claim.
      return false
    }
    return true
  }

  async listInhibitedBy(_parentKey) {
    return []
  }
}

/**
 * Wrap any AlertStore so `claim()` always "succeeds" without writing
 * anything. `--dry-run` uses this over the REAL FileAlertStore so it shows
 * the actual decision (raise/remind/clear/none) the current mint volume
 * would produce against the REAL prior state — not a decision manufactured
 * from an empty in-memory store — while guaranteeing zero mutation of the
 * on-disk stamp and zero chance of racing a real cron run.
 */
export function previewStore(inner) {
  return {
    get: (key) => inner.get(key),
    claim: async () => true,
    listInhibitedBy: (parentKey) => inner.listInhibitedBy(parentKey),
  }
}
