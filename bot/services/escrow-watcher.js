/**
 * escrow-watcher.js — Auto-detect on-chain escrow events
 *
 * Polls the Radix Gateway /stream/transactions for events on the
 * guild-saas PULL escrow component. Auto-updates SQLite records when
 * tasks are funded, claimed, submitted, released, or cancelled on-chain.
 *
 * ⚠️ REPOINTED + RESHAPED 2026-08-29. Until then this watcher's DEFAULTS were
 * two dead pre-guild-saas component addresses, no env override existed on the
 * box, and every handler parsed event fields POSITIONALLY against the retired
 * generation's shapes — so it had never seen a single guild-saas task, and
 * pointing it at the live component without the reshape would have mis-parsed
 * every field (the PULL TaskCreatedEvent's field 1 is the poster's ADDRESS,
 * where the old code read an amount). Shapes below come from the blueprint
 * (guild-saas escrow/scrypto/guild-marketplace-escrow/src/lib.rs, event
 * structs at :193-305) and are parsed BY FIELD NAME, never by position.
 *
 * PULL-era money truth for every DM this file sends: settlement CREDITS
 * entitlements inside the component — nothing lands in a wallet until that
 * party signs their own withdrawal. Copy that says "payment received" at
 * release time is false under PULL; do not reintroduce it.
 *
 * ── Replay guard (added 2026-09-05) ─────────────────────────────────────
 * The cursor (`escrow_last_version`) is only advanced as events are
 * processed. If the bot is down (or the poll loop errors out) for long
 * enough that the cursor falls far behind the ledger tip, a plain restart
 * would walk the ENTIRE gap and re-fire every per-user DM in it — a mass
 * replay of settled history, not a notification. Before paging through the
 * gap, compare the stored cursor to the current gateway tip (one cheap
 * gateway-status call): if the gap is implausibly large for a live poller
 * (ESCROW_WATCHER_MAX_REPLAY, in raw ledger state_versions — see the const
 * below for how the default was chosen), OR the ledger tip itself hasn't
 * moved since the last time we checked (a halted chain: mainnet has been
 * halted since 2026-08-31, so a bot restarted mid-halt would otherwise
 * replay the SAME pre-halt backlog on every restart), skip per-user DMs for
 * the gap entirely: fast-forward the cursor to the tip, log one line, and
 * send at most one operator alert. Normal day-to-day catch-up (the bot was
 * down for minutes to a few hours) stays completely unaffected.
 */

const GATEWAY = process.env.RADIX_GATEWAY || "https://mainnet.radixdlt.com";
// 🔴 Every Gateway read in this file goes through fetchJsonWithTimeout, never
// fetchWithTimeout + resp.json(). fetchWithTimeout disarms its timer when the
// HEADERS arrive, so the body read after it is unbounded — on 2026-09-18 the
// Gateway sent headers, stalled the body, and pollEscrowEvents() never
// returned. The `running` lock stayed held, every later tick was a no-op, and
// because a hang is not a *failed* read, nothing was logged and nobody paged.
const { fetchJsonWithTimeout } = require("./gateway");
const alerts = require("./alerts");

// One incident for "this watcher cannot read the Gateway". Before this it was
// a console.error per minute and no message to anyone — the 2026-08-31 halt
// produced a week of "[EscrowWatcher] Gateway HTTP 500" with the operator none
// the wiser. Evaluated true on every failed read and false on the first good
// one, so the policy sends one 🔴, silent reminders, one 🟢.
//
// ── Why this is debounced (2026-09-18) ───────────────────────────────────
// Paging on the FIRST failed read was wrong in the other direction. The
// operator got three 🔴/🟢 pairs on 2026-09-17 — open for 57s, 5s and 8s —
// from one Cloudflare 502 and two aborted fetches (the latter caused by the
// dead-signal bug in services/gateway.js, fixed alongside this). Six push
// notifications, nothing to do about any of them, and the real cost is that
// it teaches you to skim the channel.
//
// A single failed poll is not an incident: the loop retries in 60s, the
// cursor is NOT advanced past anything it failed to read, and no user-facing
// promise is broken. What IS an incident is the watcher staying blind, because
// then on-chain funding and settlement stop being reflected in the app.
//
// GATEWAY_ALERT_DEBOUNCE_MS is therefore the smallest outage worth waking
// someone for: five consecutive failed polls at POLL_INTERVAL. The clear is
// never debounced, and an incident that clears while still pending sends
// nothing at all — see the package's `decide()`.
const GATEWAY_ALERT_DEBOUNCE_MS = (() => {
  const n = parseInt(process.env.ESCROW_WATCHER_ALERT_DEBOUNCE_MS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 5 * 60 * 1000;
})();
const GATEWAY_ALERT = {
  key: "escrow-watcher-gateway",
  title: "Escrow watcher cannot read the Gateway",
};
function gatewayFailed(detail) {
  alerts.observe({
    ...GATEWAY_ALERT,
    condition: true,
    detail,
    debounceMs: GATEWAY_ALERT_DEBOUNCE_MS,
  });
}
function gatewayHealthy() {
  alerts.observe({ ...GATEWAY_ALERT, condition: false });
}
const { getBountyByOnchainTask, countUnstampedLinks } = require("./bounty-linkage");
// #119 funded-task DM alerts (see the end of handleTaskCreated).
const copy = require("./copy");
const { workSubmittedDm } = copy;
const { runBroadcast } = require("./broadcast");
const { taskAlertsEnabled } = require("./feature-flags");
// The LIVE guild-saas PULL escrow — must match guild-saas
// guild-app/src/lib/config.ts ESCROW_COMPONENT. Updated 2026-09-13 for the
// Wave B cutover; the prior component (…akd82f) was retired in place that
// day, so this default must never again go stale silently — see the
// unset-env warning in init() below.
const DEFAULT_ESCROW_COMPONENT = "component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly";
const ESCROW_COMPONENT = process.env.ESCROW_COMPONENT || DEFAULT_ESCROW_COMPONENT;
// Optional second component (e.g. across a future swap's drain window).
const ESCROW_SECONDARY = process.env.ESCROW_SECONDARY_COMPONENT || "";
const WATCHED_COMPONENTS = [ESCROW_COMPONENT, ESCROW_SECONDARY].filter(Boolean);
const POLL_INTERVAL = 60 * 1000; // 60 seconds
// Ceiling for one /stream/transactions page. Deliberately far above
// gateway.js's 5s default: this call asks for 50 transactions WITH receipt
// events and affected entities, which is a heavier read than the status and
// state calls that default was sized for, and aborting it early costs a whole
// poll cycle and (before the debounce) an operator page.
const STREAM_TIMEOUT_MS = (() => {
  const n = parseInt(process.env.ESCROW_WATCHER_STREAM_TIMEOUT_MS, 10);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
})();
// Ceiling on one WHOLE poll. The per-request timeouts above bound every
// Gateway read, but a poll also awaits Telegram sends and handlers, and the
// lock below must never again depend on every one of those being bounded. A
// poll still going after this long is abandoned: the lock is released, the
// stall is raised as a Gateway incident, and the abandoned poll stops itself
// at its next transaction boundary (see `isCancelled`). Nothing is lost — the
// cursor only ever advances past transactions that were fully processed.
const POLL_DEADLINE_MS = (() => {
  const n = parseInt(process.env.ESCROW_WATCHER_POLL_DEADLINE_MS, 10);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60 * 1000;
})();

// This watcher's event granularity is one Radix ledger transaction per
// state_version tick, but `state_version` counts EVERY transaction on the
// whole network, not just ones touching the watched component(s) — so the
// raw gap between the stored cursor and the tip is not "N escrow events",
// it is an upper bound on how much unrelated ledger the guard would have to
// reason about. 100,000 versions is sized to comfortably clear an ordinary
// restart-after-an-outage gap (minutes to several hours of any plausible
// mainnet throughput) while still tripping for a genuinely stale cursor
// (days, or a wiped/rolled-back watcher_state row). Tune via env if observed
// mainnet throughput makes this too tight or too loose.
const DEFAULT_MAX_REPLAY_VERSIONS = 100000;
const MAX_REPLAY_VERSIONS = (() => {
  const n = parseInt(process.env.ESCROW_WATCHER_MAX_REPLAY, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_REPLAY_VERSIONS;
})();
// Bound on how many pages the guard will fetch just to COUNT the skipped
// backlog for its log line — this is diagnostic only (nothing in the counted
// range is processed or DMed), so it must never become its own unbounded
// replay. At 50 tx/page this is up to 1000 transactions.
const MAX_GUARD_COUNT_PAGES = 20;

let db = null;
let bot = null;
let dbModule = null; // reference to the db module for helper functions
let lastStateVersion = 0;
let lastTipSeen = 0; // last observed gateway ledger tip (halt detection)
let running = false;
let xpService = null; // lazy-loaded once
let notifyOperatorFn = null; // injected (msg) => void, e.g. a TG DM to admin

function init(dbInstance, botInstance, dbMod, adminNotifier) {
  db = dbInstance;
  bot = botInstance;
  dbModule = dbMod || null;
  if (adminNotifier) notifyOperatorFn = adminNotifier;

  // ESCROW_COMPONENT unset → this watcher is running on a BUILT-IN default.
  // That default has already gone stale once (the pre-Wave-B component was
  // retired in place 2026-09-13 while this file still pointed at it) — warn
  // loudly at startup instead of failing silently again next time.
  if (!process.env.ESCROW_COMPONENT) {
    console.warn(
      "[EscrowWatcher] ESCROW_COMPONENT not set — defaulting to the Wave B component " +
      DEFAULT_ESCROW_COMPONENT + ". Set ESCROW_COMPONENT explicitly so this watcher " +
      "does not silently drift onto a retired component the next time it is swapped."
    );
  }

  // Load last state version + last-seen tip from DB (survives restart)
  try {
    db.exec("CREATE TABLE IF NOT EXISTS watcher_state (key TEXT PRIMARY KEY, value TEXT)");
    const row = db.prepare("SELECT value FROM watcher_state WHERE key = 'escrow_last_version'").get();
    if (row) lastStateVersion = parseInt(row.value) || 0;
    const tipRow = db.prepare("SELECT value FROM watcher_state WHERE key = 'escrow_last_tip_seen'").get();
    if (tipRow) lastTipSeen = parseInt(tipRow.value) || 0;
  } catch (e) {
    console.error("[EscrowWatcher] Failed to load state:", e.message);
  }

  console.log("[EscrowWatcher] Initialized. Last state version:", lastStateVersion);

  // Zero as of the 2026-08-29 correction. A NULL-component link can only match
  // LEGACY generations — if one was actually funded on the live component, its
  // events are silently skipped until the row is stamped.
  try {
    const unstamped = countUnstampedLinks(db);
    if (unstamped > 0) {
      console.warn(
        "[EscrowWatcher] " + unstamped + " linked bounty row(s) have NULL escrow_component — " +
        "they match legacy generations ONLY. Stamp any row funded on the live component."
      );
    }
  } catch (e) {
    console.error("[EscrowWatcher] Unstamped-link check failed:", e.message);
  }

  // Start polling
  setInterval(runPollTick, POLL_INTERVAL);

  // Initial poll on startup (after 10s to let bot connect). Through the same
  // lock as the interval — it used to call pollEscrowEvents() directly, so a
  // slow first poll could overlap the first tick and process a page twice.
  setTimeout(runPollTick, 10000);
}

/**
 * One guarded poll. The lock is released when the poll settles OR when
 * POLL_DEADLINE_MS passes, whichever is first — a poll that never settles can
 * no longer turn every later tick into a silent no-op. Never throws.
 */
async function runPollTick({ deadlineMs = POLL_DEADLINE_MS } = {}) {
  if (running) return "skipped"; // previous poll still inside its deadline
  running = true;
  let cancelled = false;
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deadlineMs);
  });
  const poll = pollEscrowEvents({ isCancelled: () => cancelled }).then(
    () => "done",
    (e) => {
      console.error("[EscrowWatcher] Poll error:", e.message);
      return "error";
    },
  );
  try {
    const outcome = await Promise.race([poll, deadline]);
    if (outcome === "deadline") {
      cancelled = true;
      console.error(
        "[EscrowWatcher] Poll still running after " + deadlineMs + "ms — abandoning it and releasing the lock",
      );
      gatewayFailed("poll did not finish within " + Math.round(deadlineMs / 1000) + "s (stalled read or send)");
    }
    return outcome;
  } finally {
    clearTimeout(timer);
    running = false;
  }
}

// ── Helpers ────────────────────────────────────────────────

/**
 * Find the SQLite bounty linked to an on-chain task ID — scoped to the
 * component that emitted the event. Task ids restart from 1 on every escrow
 * generation; an unscoped lookup is how the 2026-08-29 replay mis-linked the
 * live component's task #1 to legacy bounty #37 and marked it paid.
 */
function getBountyByOnchainId(onchainTaskId, component) {
  try {
    return getBountyByOnchainTask(db, onchainTaskId, component);
  } catch (e) { return null; }
}

/** Find user by their Radix address (for TG notifications) */
function getUserByAddress(address) {
  try {
    return db.prepare("SELECT * FROM users WHERE radix_address = ?").get(address);
  } catch (e) { return null; }
}

/**
 * Send a TG message to a user by tg_id (best-effort, never throws).
 * parse_mode is HTML: build `message` with a services/copy.js builder, which
 * escapes every interpolated value (services/html-escape.js).
 */
async function notifyUser(tgId, message) {
  if (!bot || !tgId) return;
  try {
    await bot.api.sendMessage(tgId, message, { parse_mode: "HTML" });
  } catch (e) {
    console.error("[EscrowWatcher] TG notify error for " + tgId + ":", e.message);
  }
}

/**
 * Extract a named field from a Gateway receipt event's programmatic JSON.
 * NEVER positional: the 2026-08-29 reshape exists because positional reads
 * against a changed struct silently return the WRONG field, not an error.
 * Returns the raw `.value` (string) or undefined.
 */
function field(fields, name) {
  const f = (fields || []).find((x) => x.field_name === name);
  return f ? f.value : undefined;
}

/**
 * The /stream/transactions lower bound for "everything after `cursor`".
 *
 * 🔴 This used to be sent as `from_state_version`, which is NOT a Gateway
 * field — the Gateway ignores unknown fields, so every request silently
 * returned the component's history from its FIRST transaction. That was
 * invisible while the watched component had fewer than 50 transactions: one
 * short page, everything in it `<= lastStateVersion`, skipped, done. The Wave B
 * component crossed 50 transactions around 2026-09-17, and from then on every
 * poll got a FULL page of old history, skipped all of it, saw "full page, so
 * there is more", and asked for the identical page again — forever, holding
 * the `running` lock, logging nothing, failing nothing. That loop, not a
 * stalled body, is what froze the watcher from 2026-09-18 to 09-19.
 *
 * The real field is `from_ledger_state: { state_version }`, and it is
 * INCLUSIVE, hence the +1. Verified against mainnet 2026-09-19.
 */
function fromCursor(cursor) {
  return cursor > 0 ? { from_ledger_state: { state_version: cursor + 1 } } : {};
}

/** Fetch the current ledger tip's state_version from the Gateway. */
async function fetchLedgerTip() {
  const resp = await fetchJsonWithTimeout(GATEWAY + "/status/gateway-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!resp.ok) throw new Error("gateway-status HTTP " + resp.status);
  const tip = resp.body?.ledger_state?.state_version;
  if (!Number.isFinite(tip) || tip <= 0) throw new Error("no state_version in gateway-status");
  return tip;
}

/**
 * Seed the cursor at the CURRENT ledger tip when there is no stored one.
 * Deliberate: with lastStateVersion = 0 the stream would replay the watched
 * component's entire history and DM people about long-settled tasks (measured
 * 2026-08-29: every historic task on the live component is terminal and fully
 * collected — a replay tells nobody anything actionable). Losing the seed
 * write is safe: worst case the next boot re-seeds at a later tip.
 */
async function seedCursorAtTip() {
  const tip = await fetchLedgerTip();
  lastStateVersion = tip;
  db.prepare("INSERT OR REPLACE INTO watcher_state (key, value) VALUES ('escrow_last_version', ?)")
    .run(String(tip));
  console.log("[EscrowWatcher] Cursor seeded at ledger tip:", tip);
}

/** Persist the last-observed ledger tip (used for halt detection). */
function persistTipSeen(tip) {
  lastTipSeen = tip;
  try {
    db.prepare("INSERT OR REPLACE INTO watcher_state (key, value) VALUES ('escrow_last_tip_seen', ?)")
      .run(String(tip));
  } catch (e) {
    console.error("[EscrowWatcher] Failed to save last-seen tip:", e.message);
  }
}

/** Best-effort single operator alert. Never throws. */
async function notifyOperator(msg) {
  if (!notifyOperatorFn) {
    console.warn("[EscrowWatcher] No operator notifier configured — alert not delivered:", msg);
    return;
  }
  try {
    await notifyOperatorFn(msg);
  } catch (e) {
    console.error("[EscrowWatcher] Operator notify failed:", e.message);
  }
}

/**
 * Pure decision: should this poll skip per-user DMs for the backlog between
 * the stored cursor and the current tip? Exported (undocumented in
 * module.exports below is fine — required directly by tests) so the
 * threshold/halt logic can be unit-tested without a network or a DB.
 */
function shouldGuardReplay({ tip, lastVersion, lastTip, maxReplay }) {
  if (!Number.isFinite(tip) || tip <= 0) return { guard: false, lag: 0, halted: false };
  const lag = tip - lastVersion;
  if (lag <= 0) return { guard: false, lag, halted: false };
  const halted = Number.isFinite(lastTip) && lastTip > 0 && tip === lastTip;
  const overThreshold = Number.isFinite(maxReplay) && maxReplay > 0 && lag > maxReplay;
  return { guard: overThreshold || halted, lag, halted };
}

/**
 * Diagnostic-only count of how many WATCHED_COMPONENTS events sit in
 * (fromExclusive, toInclusive]. Nothing counted here is processed or DMed —
 * this exists purely to make the "replay guard: skipped N events" log line
 * meaningful. Bounded by MAX_GUARD_COUNT_PAGES; on truncation the count is
 * reported as a floor ("N+").
 */
async function countBacklogEvents(fromExclusive, toInclusive) {
  let count = 0;
  let cursorVersion = fromExclusive;
  let truncated = false;

  for (let page = 0; page < MAX_GUARD_COUNT_PAGES; page++) {
    let resp;
    try {
      resp = await fetchJsonWithTimeout(GATEWAY + "/stream/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: STREAM_TIMEOUT_MS,
        body: JSON.stringify({
          affected_global_entities_filter: WATCHED_COMPONENTS,
          ...fromCursor(cursorVersion),
          limit_per_page: 50,
          order: "asc",
          opt_ins: { receipt_events: true, affected_global_entities: true },
        }),
      });
    } catch (e) {
      console.error("[EscrowWatcher] Backlog count fetch error:", e.message);
      break;
    }
    if (!resp.ok) break;

    const items = resp.body?.items || [];
    if (items.length === 0) break;

    for (const tx of items) {
      if (tx.transaction_status !== "CommittedSuccess") continue;
      const sv = tx.state_version || 0;
      if (sv <= fromExclusive || sv > toInclusive) continue;
      const events = tx.receipt?.events || [];
      for (const event of events) {
        const emitter = event.emitter?.entity?.entity_address;
        if (WATCHED_COMPONENTS.includes(emitter)) count++;
      }
    }

    const lastItem = items[items.length - 1];
    const nextCursor = lastItem?.state_version || cursorVersion;
    if (nextCursor <= cursorVersion) break; // page did not advance — never re-ask for it
    cursorVersion = nextCursor;
    if (items.length < 50 || cursorVersion >= toInclusive) break;
    if (page === MAX_GUARD_COUNT_PAGES - 1) truncated = true;
  }

  return { count, truncated };
}

// ── Poll Loop ──────────────────────────────────────────────

async function pollEscrowEvents({ isCancelled = () => false } = {}) {
  // First run ever (or wiped state): seed at the tip instead of replaying
  // history. If seeding fails we return WITHOUT polling — polling from 0
  // would replay everything, which is the exact failure this prevents.
  if (lastStateVersion === 0) {
    try {
      await seedCursorAtTip();
    } catch (e) {
      console.error("[EscrowWatcher] Cursor seed failed, skipping poll:", e.message);
      gatewayFailed("cursor seed failed: " + e.message);
      return;
    }
  }

  // Replay guard — one cheap gateway-status call before paging through any
  // backlog. See the module header for the full rationale.
  let tip;
  try {
    tip = await fetchLedgerTip();
  } catch (e) {
    // A tip check that cannot be read is the watcher being blind, same as a
    // failed page read — it used to `return` without telling the alert policy,
    // so a gateway-status outage was invisible however long it lasted.
    console.error("[EscrowWatcher] Replay-guard tip check failed, skipping poll:", e.message);
    gatewayFailed("tip check failed: " + e.message);
    return;
  }

  const decision = shouldGuardReplay({
    tip,
    lastVersion: lastStateVersion,
    lastTip: lastTipSeen,
    maxReplay: MAX_REPLAY_VERSIONS,
  });

  if (decision.guard) {
    const fromExclusive = lastStateVersion;
    let label = "0";
    try {
      const { count, truncated } = await countBacklogEvents(fromExclusive, tip);
      label = truncated ? count + "+" : String(count);
    } catch (e) {
      console.error("[EscrowWatcher] Backlog count failed (guard still applies):", e.message);
      label = "unknown";
    }

    console.log(
      "[EscrowWatcher] replay guard: skipped " + label + " events (lag=" + decision.lag +
      ", halted=" + decision.halted + ", cursor " + fromExclusive + " -> " + tip + ")"
    );

    lastStateVersion = tip;
    try {
      db.prepare("INSERT OR REPLACE INTO watcher_state (key, value) VALUES ('escrow_last_version', ?)").run(String(tip));
    } catch (e) {
      console.error("[EscrowWatcher] Failed to save state version:", e.message);
    }

    await notifyOperator(
      "Replay guard tripped — skipped " + label + " backlog event(s) without DMing users " +
      "(lag=" + decision.lag + (decision.halted ? ", chain appears halted" : "") + "). " +
      "Cursor fast-forwarded from " + fromExclusive + " to " + tip + ". " +
      "Reconcile manually if any of that backlog needed action."
    );

    persistTipSeen(tip);
    return;
  }

  persistTipSeen(tip);

  let totalProcessed = 0;
  let hasMore = true;
  // Paging cursor, separate from lastStateVersion: it advances to the last
  // item of every page whether or not that page held anything to process.
  let pageCursor = lastStateVersion;

  // Pagination loop — fetch all pages to prevent sync loss on >50 TX bursts
  while (hasMore) {
    if (isCancelled()) return; // abandoned by runPollTick's deadline
    let resp;
    try {
      // 🔴 This used to build its own 30s AbortController and pass it as
      // `signal`. fetchWithTimeout dropped it on the floor (the spread order
      // bug fixed in services/gateway.js on 2026-09-18), so this call really
      // ran on the 5s default — and a paged /stream/transactions read with
      // receipt_events on is exactly the kind of call that legitimately takes
      // longer than that. The aborts it produced then paged the operator.
      // The ceiling is now asked for explicitly and is actually applied.
      // The ceiling covers the BODY too (fetchJsonWithTimeout) — see the
      // require at the top of this file.
      resp = await fetchJsonWithTimeout(GATEWAY + "/stream/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: STREAM_TIMEOUT_MS,
        body: JSON.stringify({
          affected_global_entities_filter: WATCHED_COMPONENTS,
          ...fromCursor(pageCursor),
          limit_per_page: 50,
          order: "asc",
          opt_ins: {
            receipt_events: true,
            affected_global_entities: true,
          },
        }),
      });
    } catch (e) {
      console.error("[EscrowWatcher] Gateway fetch error:", e.message);
      gatewayFailed("fetch error: " + e.message);
      return;
    }

    if (!resp.ok) {
      const body = resp.text || "";
      console.error("[EscrowWatcher] Gateway HTTP", resp.status, body.slice(0, 200));
      gatewayFailed(
        "HTTP " + resp.status + ": " + body.slice(0, 160) +
        (body.includes("not sufficiently up to date") ? " (Gateway is behind the ledger — network halted or lagging)" : ""),
      );
      return;
    }
    gatewayHealthy();

    const items = resp.body?.items || [];

    if (items.length === 0) break;

    for (const tx of items) {
      if (isCancelled()) return;
      if (tx.transaction_status !== "CommittedSuccess") continue;

      const stateVersion = tx.state_version || 0;
      if (stateVersion <= lastStateVersion) continue;
      const txHash = tx.intent_hash || "";
      const events = tx.receipt?.events || [];

      // Under PULL the terminal events (Released/Cancelled/Refunded) carry no
      // amounts — SettlementCreditedEvent, co-emitted in the SAME transaction
      // by every settlement path, is the single canonical "who is owed what".
      // Pre-scan it per tx and hand it to the terminal handlers, keyed by
      // task_id (one tx can settle at most one task today, but key anyway).
      const settlements = {};
      for (const event of events) {
        const emitter = event.emitter?.entity?.entity_address;
        if (!WATCHED_COMPONENTS.includes(emitter)) continue;
        if (event.name !== "SettlementCreditedEvent") continue;
        const f = event.data?.fields || [];
        const tid = parseInt(field(f, "task_id")) || 0;
        settlements[tid] = {
          worker_entitled: field(f, "worker_entitled") || "0",
          poster_entitled: field(f, "poster_entitled") || "0",
          worker_bond_entitled: field(f, "worker_bond_entitled") || "0",
          poster_bond_entitled: field(f, "poster_bond_entitled") || "0",
        };
      }

      for (const event of events) {
        const emitter = event.emitter?.entity?.entity_address;
        if (!WATCHED_COMPONENTS.includes(emitter)) continue;

        const name = event.name;
        const fields = event.data?.fields || [];

        try {
          if (name === "TaskCreatedEvent") {
            await handleTaskCreated(fields, txHash, stateVersion, emitter);
          } else if (name === "TaskClaimedEvent") {
            await handleTaskClaimed(fields, txHash, emitter);
          } else if (name === "TaskReleasedEvent") {
            await handleTaskReleased(fields, txHash, settlements, emitter);
          } else if (name === "TaskCancelledEvent") {
            await handleTaskCancelled(fields, txHash, settlements, emitter);
          } else if (name === "WorkSubmittedEvent") {
            // Renamed from the retired generation's TaskSubmittedEvent —
            // the PULL blueprint emits WorkSubmittedEvent (lib.rs:229).
            await handleTaskSubmitted(fields, txHash, emitter);
          }
        } catch (e) {
          console.error("[EscrowWatcher] Error processing " + name + ":", e.message);
        }
      }

      // Save state version after each TX for crash recovery
      if (stateVersion > lastStateVersion) {
        lastStateVersion = stateVersion;
        try {
          db.prepare("INSERT OR REPLACE INTO watcher_state (key, value) VALUES ('escrow_last_version', ?)").run(String(stateVersion));
        } catch (e) {
          console.error("[EscrowWatcher] Failed to save state version:", e.message);
        }
      }

      totalProcessed++;
    }

    // Continue pagination if we got a full page (may have more) — but ONLY if
    // the page moved the cursor forward. A full page that does not advance is
    // the same page again next time, i.e. an infinite loop holding the lock.
    const pageEnd = items[items.length - 1]?.state_version || 0;
    if (items.length >= 50 && pageEnd <= pageCursor) {
      console.error(
        "[EscrowWatcher] Full page did not advance the cursor (cursor=" + pageCursor +
        ", page ends " + pageEnd + ") — stopping this poll instead of re-reading it forever",
      );
      gatewayFailed("stream page did not advance past " + pageCursor + " — cursor parameter ignored?");
      return;
    }
    pageCursor = Math.max(pageCursor, pageEnd);
    hasMore = items.length >= 50;
  }

  if (totalProcessed > 0) {
    console.log("[EscrowWatcher] Processed " + totalProcessed + " TX(s). State version: " + lastStateVersion);
  }
}

// ── Event Handlers ─────────────────────────────────────────

async function handleTaskCreated(fields, txHash, stateVersion, component) {
  // PULL shape (lib.rs:193-200): task_id, poster, reward_token, reward_amount,
  // insurance_amount, arbiter_fee_pct, work_brief_hash.
  const taskId = parseInt(field(fields, "task_id")) || 0;
  const amount = field(fields, "reward_amount") || "0";
  const resource = field(fields, "reward_token") || "";
  const creator = field(fields, "poster") || "";
  const tokenLabel = resource.includes("radxrd") ? "XRD" : resource.includes("usdc") ? "xUSDC" : resource.includes("usdt") ? "xUSDT" : "XRD";

  console.log("[EscrowWatcher] TaskCreated: #" + taskId + " | " + amount + " " + tokenLabel + " | poster: " + creator.slice(0, 25) + "...");

  // Find linked bounty first — use bounty.id (SQLite FK) not taskId (on-chain ID)
  const bounty = getBountyByOnchainId(taskId, component);
  const bountyIdForLog = bounty ? bounty.id : null;

  // Log to audit trail
  try {
    db.prepare(
      "INSERT OR IGNORE INTO bounty_transactions (bounty_id, tx_type, amount_xrd, tx_hash, description, verified_onchain, onchain_task_id, escrow_component) VALUES (?, 'deposit', ?, ?, ?, 1, ?, ?)"
    ).run(bountyIdForLog, parseFloat(amount), txHash, "Auto-detected by gateway watcher", taskId, component);
  } catch (e) {
    console.error("[EscrowWatcher] DB log error:", e.message);
  }

  // Sync bounty status: mark as funded if we can find the linked bounty.
  // Stamp escrow_component so every later lookup takes the exact-match path.
  if (bounty && !bounty.funded) {
    try {
      db.prepare("UPDATE bounties SET funded = 1, escrow_verified = 1, escrow_component = ? WHERE id = ?").run(component, bounty.id);
      console.log("[EscrowWatcher] Bounty #" + bounty.id + " auto-marked funded via on-chain event");

      // Notify creator
      await notifyUser(bounty.creator_tg_id,
        copy.taskFundedPosterDm({ id: bounty.id, amount, tokenLabel })
      );
    } catch (e) {
      console.error("[EscrowWatcher] Bounty sync error:", e.message);
    }
  }

  // ── #119: opt-in DM to subscribers ──────────────────────────────────
  // Independent of `bounty` ON PURPOSE: tasks posted on radixguild.com have no
  // row in this bot's bounties table, so gating on it would never fire in
  // production. Only on-chain facts are used; the link is the board, never a
  // /tasks/<id> page (taskId is the escrow's id, not the web app's).
  if (taskAlertsEnabled() && bot && dbModule && typeof dbModule.getTaskAlertOptInTgIds === "function") {
    try {
      const ids = dbModule.getTaskAlertOptInTgIds();
      if (ids.length > 0) {
        const portal = process.env.PORTAL_URL || "https://radixguild.com";
        const msg = copy.fundedTaskAlert({ taskId, amount, tokenLabel, portal });
        // Awaited: this is the background poll loop (bounded by
        // POLL_DEADLINE_MS), not grammY's sequential update handler.
        const r = await runBroadcast(bot.api, ids, msg);
        console.log("[EscrowWatcher] Task #" + taskId + " alert: " + r.sent + " sent, " + r.failed + " failed");
      }
    } catch (e) {
      console.error("[EscrowWatcher] Task alert broadcast error:", e.message);
    }
  }
}

async function handleTaskClaimed(fields, txHash, component) {
  // PULL shape (lib.rs:207-211): task_id, claimer_badge_id, is_agent,
  // claim_deadline. ⚠️ The worker's ACCOUNT is NOT in this event — only the
  // on-chain TaskInfo.worker_account has it (pinned at claim). Until the
  // task_parties state-read lands (next unit), `worker` here is the BADGE ID:
  // usable for logging, NOT resolvable to a TG user via getUserByAddress.
  const taskId = parseInt(field(fields, "task_id")) || 0;
  const worker = field(fields, "claimer_badge_id") || "";

  console.log("[EscrowWatcher] TaskClaimed: #" + taskId + " | claimer badge: " + String(worker).slice(0, 25) + "...");

  const bounty = getBountyByOnchainId(taskId, component);
  const bountyIdForLog = bounty ? bounty.id : null;

  try {
    db.prepare(
      "INSERT OR IGNORE INTO bounty_transactions (bounty_id, tx_type, amount_xrd, tx_hash, description, verified_onchain, onchain_task_id, escrow_component) VALUES (?, 'claim', 0, ?, ?, 1, ?, ?)"
    ).run(bountyIdForLog, txHash, "Task claimed on-chain. Claimer badge: " + String(worker).slice(0, 30), taskId, component);
  } catch (e) {
    console.error("[EscrowWatcher] DB log error:", e.message);
  }

  // Sync bounty status to 'assigned'
  if (bounty && bounty.status === "open") {
    try {
      const now = Math.floor(Date.now() / 1000);
      // assignee_address deliberately NOT set from this event — under PULL the
      // event carries a badge id, not an account, and writing a badge id into
      // an address column poisons every later getUserByAddress lookup.
      db.prepare("UPDATE bounties SET status = 'assigned', assigned_at = ? WHERE id = ? AND status = 'open'")
        .run(now, bounty.id);
      console.log("[EscrowWatcher] Bounty #" + bounty.id + " auto-assigned via on-chain claim");

      // Notify creator
      await notifyUser(bounty.creator_tg_id,
        copy.taskClaimedDm({ id: bounty.id, title: bounty.title, worker })
      );

      // Worker DM is NOT possible from this event alone (badge id ≠ account
      // address). It arrives with the task_parties state-read in the
      // dispute-notification unit — do not fake it from the badge id.
    } catch (e) {
      console.error("[EscrowWatcher] Bounty assign sync error:", e.message);
    }
  }
}

async function handleTaskReleased(fields, txHash, settlements, component) {
  // PULL shape (lib.rs:270-273): task_id, ruling, arbiter_fee — NO worker, NO
  // payout. The amounts live in the co-fired SettlementCreditedEvent (passed
  // in via `settlements`), and they are CREDITS, not payments: each party
  // still collects with their own signed withdrawal.
  const taskId = parseInt(field(fields, "task_id")) || 0;
  const fee = field(fields, "arbiter_fee") || "0";
  const s = (settlements || {})[taskId] || {};
  const payout = s.worker_entitled || "0";
  const tokenLabel = "XRD";

  console.log("[EscrowWatcher] TaskReleased: #" + taskId + " | worker credited " + payout + " " + tokenLabel + " | arbiter fee: " + fee);

  const bounty = getBountyByOnchainId(taskId, component);
  const bountyIdForLog = bounty ? bounty.id : null;

  try {
    db.prepare(
      "INSERT OR IGNORE INTO bounty_transactions (bounty_id, tx_type, amount_xrd, tx_hash, description, verified_onchain, onchain_task_id, escrow_component) VALUES (?, 'release', ?, ?, ?, 1, ?, ?)"
    ).run(bountyIdForLog, parseFloat(payout), txHash, "Escrow released on-chain. Fee: " + fee + " " + tokenLabel, taskId, component);
  } catch (e) {
    console.error("[EscrowWatcher] DB log error:", e.message);
  }

  // Sync bounty status to 'paid' + track fees
  if (bounty && bounty.status !== "paid") {
    try {
      const now = Math.floor(Date.now() / 1000);
      db.prepare("UPDATE bounties SET status = 'paid', paid_at = ?, paid_tx = ? WHERE id = ?")
        .run(now, txHash, bounty.id);

      // Record fee tracking (Phase 0.6)
      if (dbModule && dbModule.recordEscrowRelease) {
        dbModule.recordEscrowRelease(bounty.id, parseFloat(payout), parseFloat(fee), txHash);
      } else {
        // Fallback: direct update
        db.prepare("UPDATE bounties SET fee_collected_xrd = ? WHERE id = ?").run(parseFloat(fee), bounty.id);
        db.prepare("UPDATE escrow_wallet SET total_released_xrd = total_released_xrd + ?, total_fees_collected_xrd = total_fees_collected_xrd + ? WHERE id = 1")
          .run(parseFloat(payout) + parseFloat(fee), parseFloat(fee));
      }

      console.log("[EscrowWatcher] Bounty #" + bounty.id + " auto-marked paid via on-chain release");

      // Queue XP reward for the assignee (lazy-load xp service once)
      try {
        if (!xpService) xpService = require("./xp.js");
        if (bounty.assignee_address && xpService.queueXpReward) {
          xpService.queueXpReward(bounty.assignee_address, "bounty_complete");
        }
      } catch (_) {
        // XP service may not be loaded yet
      }

      // Notify assignee — PULL truth: this is a CREDIT, not a payment. The
      // money sits inside the escrow until the worker signs their own
      // withdrawal; saying "payment received" here would be false.
      const workerUser =
        (bounty.assignee_address ? getUserByAddress(bounty.assignee_address) : null) ||
        (bounty.assignee_tg_id ? { tg_id: bounty.assignee_tg_id } : null);
      if (workerUser) {
        await notifyUser(workerUser.tg_id,
          copy.taskSettledWorkerDm({ id: bounty.id, title: bounty.title, payout, txHash })
        );
      }

      // Notify creator
      await notifyUser(bounty.creator_tg_id,
        copy.taskSettledPosterDm({ id: bounty.id, title: bounty.title, payout })
      );
    } catch (e) {
      console.error("[EscrowWatcher] Bounty release sync error:", e.message);
    }
  }
}

async function handleTaskSubmitted(fields, txHash, component) {
  // PULL shape (lib.rs:229-232, WorkSubmittedEvent): task_id, evidence_hash,
  // submitted_at. No worker identity in the event.
  const taskId = parseInt(field(fields, "task_id")) || 0;
  const worker = "";

  console.log("[EscrowWatcher] WorkSubmitted: #" + taskId);

  const bounty = getBountyByOnchainId(taskId, component);
  const bountyIdForLog = bounty ? bounty.id : null;

  try {
    db.prepare(
      "INSERT OR IGNORE INTO bounty_transactions (bounty_id, tx_type, amount_xrd, tx_hash, description, verified_onchain, onchain_task_id, escrow_component) VALUES (?, 'submit', 0, ?, ?, 1, ?, ?)"
    ).run(bountyIdForLog, txHash, "Work submitted on-chain.", taskId, component);
  } catch (e) {
    console.error("[EscrowWatcher] DB log error:", e.message);
  }

  if (bounty && bounty.status === "assigned") {
    try {
      const now = Math.floor(Date.now() / 1000);
      db.prepare("UPDATE bounties SET status = 'submitted', submitted_at = ? WHERE id = ? AND status = 'assigned'")
        .run(now, bounty.id);
      console.log("[EscrowWatcher] Bounty #" + bounty.id + " auto-marked submitted via on-chain event");

      // Until 2026-09-24: "Review and verify with: /bounty verify N" — a retired local-board
      // command that cannot touch the on-chain task. Text: services/copy.js.
      await notifyUser(bounty.creator_tg_id,
        workSubmittedDm({ id: bounty.id, title: bounty.title })
      );
    } catch (e) {
      console.error("[EscrowWatcher] Bounty submit sync error:", e.message);
    }
  }
}

async function handleTaskCancelled(fields, txHash, settlements, component) {
  // PULL shape (lib.rs:204): task_id only. The refunded amount is the poster's
  // credit in the co-fired SettlementCreditedEvent — a CREDIT they collect
  // with their own signed withdrawal, not an automatic refund landing.
  const taskId = parseInt(field(fields, "task_id")) || 0;
  const s = (settlements || {})[taskId] || {};
  const refunded = s.poster_entitled || "0";
  const tokenLabel = "XRD";

  console.log("[EscrowWatcher] TaskCancelled: #" + taskId + " | poster credited: " + refunded + " " + tokenLabel);

  const bounty = getBountyByOnchainId(taskId, component);
  const bountyIdForLog = bounty ? bounty.id : null;

  try {
    db.prepare(
      "INSERT OR IGNORE INTO bounty_transactions (bounty_id, tx_type, amount_xrd, tx_hash, description, verified_onchain, onchain_task_id, escrow_component) VALUES (?, 'cancel', ?, ?, ?, 1, ?, ?)"
    ).run(bountyIdForLog, parseFloat(refunded), txHash, "Task cancelled on-chain. Refunded: " + refunded + " " + tokenLabel, taskId, component);
  } catch (e) {
    console.error("[EscrowWatcher] DB log error:", e.message);
  }

  // Sync bounty status to 'cancelled'
  if (bounty && bounty.status !== "cancelled" && bounty.status !== "paid") {
    try {
      const now = Math.floor(Date.now() / 1000);
      db.prepare("UPDATE bounties SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'on_chain_cancel' WHERE id = ?")
        .run(now, bounty.id);
      console.log("[EscrowWatcher] Bounty #" + bounty.id + " auto-cancelled via on-chain event");

      // Notify creator — credit, not an automatic refund landing.
      await notifyUser(bounty.creator_tg_id,
        copy.taskCancelledDm({ id: bounty.id, title: bounty.title, refunded })
      );
    } catch (e) {
      console.error("[EscrowWatcher] Bounty cancel sync error:", e.message);
    }
  }
}

/**
 * Test-only seam: set the module's internal state directly, WITHOUT
 * scheduling the production setInterval/setTimeout pollers that init()
 * starts. Lets tests call pollEscrowEvents()/exported helpers against a
 * fake db/bot without leaving timers running past the test.
 */
function _resetForTest({ dbInstance, botInstance, lastVersion = 0, lastTip = 0, adminNotifier = null, dbMod = null } = {}) {
  db = dbInstance;
  bot = botInstance;
  dbModule = dbMod || null;
  lastStateVersion = lastVersion;
  lastTipSeen = lastTip;
  notifyOperatorFn = adminNotifier;
  running = false;
}

module.exports = {
  init,
  // Exported for unit tests only (replay-guard logic + backlog counting).
  shouldGuardReplay,
  countBacklogEvents,
  fetchLedgerTip,
  pollEscrowEvents,
  runPollTick,
  _resetForTest,
  // Exported for unit tests only (default-component resolution).
  ESCROW_COMPONENT,
};
