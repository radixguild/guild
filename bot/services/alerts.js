/**
 * alerts.js — operator alerts through the ONE shared policy.
 *
 * Every bigdev bot pages the operator through @radixguild/alert-policy
 * (guild-saas/packages/alert-policy, vendored here as lib/alert-policy.cjs
 * with a sha256 header — test/alert-policy-vendor.test.js recomputes it).
 * The rule, in one line: one 🔴 when a condition becomes true, SILENT 🟠
 * reminders at 1h / 6h / 24h then daily, one 🟢 when it clears, nothing while
 * a named parent incident is open. State lives in the bot's own SQLite
 * (`alert_state`, auto-created) with a version-gated write, so a restart or
 * two overlapping checks cannot double-send.
 *
 * Why this exists here: the signer's low-balance check paged the admin EVERY
 * HOUR for as long as the balance stayed low (level-triggered), and the escrow
 * watcher's Gateway failures paged nobody at all (log-only) — a full week of
 * "[EscrowWatcher] Gateway HTTP 500" once a minute during the 2026-08-31 halt
 * with no operator message. Both are INCIDENTS: a state that persists. Events
 * (signer disabled/enabled, a TX failing) are one-shot facts and keep going
 * out the plain notifier as before.
 *
 * Usage:
 *   alerts.init({ db, send })            once, after the bot exists
 *   alerts.observe({ key, condition, title, detail?, inhibitedBy? })
 *     — on EVERY observation, true AND false. The false call is what
 *       produces the 🟢; skip it and an incident never closes.
 */
"use strict";

const { createAlertEvaluator, SqliteAlertStore, MemoryAlertStore } = require("../lib/alert-policy.cjs");

let evaluate = null;
let warnedUninitialised = false;

/**
 * Build an evaluator. Exposed for tests (memory store, fake clock, recording
 * send); `init()` below is the production wiring.
 */
function create({ db, send, now, store } = {}) {
  const alertStore = store || (db ? new SqliteAlertStore(db) : new MemoryAlertStore());
  return createAlertEvaluator({
    store: alertStore,
    send: async (text, opts) => {
      try {
        return await send(text, { silent: !!(opts && opts.silent) });
      } catch (e) {
        console.error("[alerts] send failed:", e && e.message);
        return false;
      }
    },
    now: now || (() => Date.now()),
    onError: (err, key) => console.error("[alerts] store failure — alert not evaluated", key, err && err.message),
  });
}

function init(opts) {
  evaluate = create(opts);
  console.log("[alerts] initialised (" + (opts && opts.db ? "sqlite" : "memory") + " store)");
}

/**
 * Fire-and-forget observation. Never throws, never rejects — alerting must not
 * break the check that observed the condition. Returns the policy outcome
 * ("raise" | "remind" | "clear" | "suppress" | "none" | ...) for logging/tests.
 */
async function observe(input) {
  if (!evaluate) {
    if (!warnedUninitialised) {
      warnedUninitialised = true;
      console.warn("[alerts] observe() before init() — alert dropped:", input && input.key);
    }
    return "uninitialised";
  }
  try {
    const outcome = await evaluate(input);
    if (outcome === "raise" || outcome === "remind" || outcome === "clear") {
      console.log("[alerts] " + outcome + " " + input.key);
    }
    return outcome;
  } catch (e) {
    console.error("[alerts] observe failed:", e && e.message);
    return "store-failed";
  }
}

/** Test-only. */
function _reset() {
  evaluate = null;
  warnedUninitialised = false;
}

module.exports = { init, observe, create, _reset };
