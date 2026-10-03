// @radix-guild/alert-policy v0.1.0 — VENDORED BUILD, do not edit. Source: guild-saas/packages/alert-policy. sha256:0247d2a51227936a9e97950f98fa7048bcd89f4c1be08dbdbd6e8ef8d0b698de
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// src/index.ts
var exports_src = {};
__export(exports_src, {
  rollingThresholdCondition: () => rollingThresholdCondition,
  reminderIntervalAfter: () => reminderIntervalAfter,
  nextReminderDue: () => nextReminderDue,
  humanDuration: () => humanDuration,
  freshAlertState: () => freshAlertState,
  formatAlert: () => formatAlert,
  decide: () => decide,
  crossesThreshold: () => crossesThreshold,
  createAlertEvaluator: () => createAlertEvaluator,
  countInWindow: () => countInWindow,
  SqliteAlertStore: () => SqliteAlertStore,
  SUGGESTED_REMOTE_READ_DEBOUNCE_MS: () => SUGGESTED_REMOTE_READ_DEBOUNCE_MS,
  REMINDER_STEADY_STATE_MS: () => REMINDER_STEADY_STATE_MS,
  REMINDER_SCHEDULE_MS: () => REMINDER_SCHEDULE_MS,
  MemoryAlertStore: () => MemoryAlertStore,
  FLAP_WINDOW_MS: () => FLAP_WINDOW_MS
});
module.exports = __toCommonJS(exports_src);

// src/policy.ts
var REMINDER_SCHEDULE_MS = [
  60 * 60000,
  6 * 60 * 60000,
  24 * 60 * 60000
];
var REMINDER_STEADY_STATE_MS = 24 * 60 * 60000;
var FLAP_WINDOW_MS = 10 * 60000;
var SUGGESTED_REMOTE_READ_DEBOUNCE_MS = 5 * 60000;
function freshAlertState(key) {
  return {
    key,
    active: false,
    since: null,
    lastSentAt: null,
    lastClearedAt: null,
    sentCount: 0,
    suppressedCount: 0,
    inhibitedBy: null,
    version: 0
  };
}
function reminderIntervalAfter(sentCount) {
  return REMINDER_SCHEDULE_MS[sentCount - 1] ?? REMINDER_STEADY_STATE_MS;
}
function nextReminderDue(state) {
  if (!state.active || state.lastSentAt === null || state.sentCount === 0)
    return null;
  return state.lastSentAt + reminderIntervalAfter(state.sentCount);
}
function decide(prev, key, condition, now, inhibitor, debounceMs = 0) {
  const inhibited = inhibitor !== null;
  const base = prev ?? freshAlertState(key);
  const bump = (patch) => ({
    ...base,
    ...patch,
    key,
    version: base.version + 1
  });
  const flapping = base.lastClearedAt !== null && now - base.lastClearedAt < FLAP_WINDOW_MS;
  if (condition) {
    if (!base.active) {
      if (inhibited) {
        return {
          action: "suppress",
          next: bump({
            active: true,
            since: now,
            lastSentAt: null,
            sentCount: 0,
            suppressedCount: 1,
            inhibitedBy: inhibitor
          }),
          flapping,
          heldBy: null,
          reminderNumber: null,
          changed: true
        };
      }
      if (debounceMs > 0) {
        return {
          action: "pend",
          next: bump({
            active: true,
            since: now,
            lastSentAt: null,
            sentCount: 0,
            suppressedCount: 1,
            inhibitedBy: null
          }),
          flapping,
          heldBy: null,
          reminderNumber: null,
          changed: true
        };
      }
      return {
        action: "raise",
        next: bump({
          active: true,
          since: now,
          lastSentAt: now,
          sentCount: 1,
          suppressedCount: 0,
          inhibitedBy: null
        }),
        flapping,
        heldBy: null,
        reminderNumber: null,
        changed: true
      };
    }
    if (inhibited) {
      return {
        action: "suppress",
        next: bump({
          suppressedCount: base.suppressedCount + 1,
          inhibitedBy: inhibitor
        }),
        flapping: false,
        heldBy: null,
        reminderNumber: null,
        changed: true
      };
    }
    if (base.sentCount === 0) {
      const openFor = now - (base.since ?? now);
      if (debounceMs > 0 && openFor < debounceMs) {
        return {
          action: "pend",
          next: bump({ suppressedCount: base.suppressedCount + 1 }),
          flapping: false,
          heldBy: null,
          reminderNumber: null,
          changed: true
        };
      }
      return {
        action: "raise",
        next: bump({ lastSentAt: now, sentCount: 1, inhibitedBy: null }),
        flapping,
        heldBy: base.inhibitedBy !== null ? "inhibited" : debounceMs > 0 ? "debounce" : null,
        reminderNumber: null,
        changed: true
      };
    }
    const due = nextReminderDue(base);
    if (due !== null && now >= due) {
      return {
        action: "remind",
        next: bump({
          lastSentAt: now,
          sentCount: base.sentCount + 1,
          suppressedCount: 0,
          inhibitedBy: null
        }),
        flapping: false,
        heldBy: null,
        reminderNumber: base.sentCount + 1,
        changed: true
      };
    }
    return {
      action: "none",
      next: bump({ suppressedCount: base.suppressedCount + 1 }),
      flapping: false,
      heldBy: null,
      reminderNumber: null,
      changed: true
    };
  }
  if (base.active) {
    const announced = base.sentCount > 0;
    return {
      action: announced ? "clear" : "none",
      next: bump({
        active: false,
        since: null,
        lastSentAt: null,
        lastClearedAt: now,
        sentCount: 0,
        suppressedCount: 0,
        inhibitedBy: null
      }),
      flapping: false,
      heldBy: null,
      reminderNumber: null,
      changed: true
    };
  }
  return {
    action: "none",
    next: base,
    flapping: false,
    heldBy: null,
    reminderNumber: null,
    changed: false
  };
}
// src/store.ts
class MemoryAlertStore {
  rows = new Map;
  async get(key) {
    const row = this.rows.get(key);
    return row ? { ...row } : null;
  }
  async claim(next, expectedVersion) {
    const current = this.rows.get(next.key);
    const currentVersion = current ? current.version : null;
    if (currentVersion !== expectedVersion)
      return false;
    this.rows.set(next.key, { ...next });
    return true;
  }
  async listInhibitedBy(parentKey) {
    return [...this.rows.values()].filter((r) => r.active && r.inhibitedBy === parentKey);
  }
  clear() {
    this.rows.clear();
  }
}
function fromSqlite(r) {
  return {
    key: r.key,
    active: r.active === 1,
    since: r.since,
    lastSentAt: r.last_sent_at,
    lastClearedAt: r.last_cleared_at,
    sentCount: r.sent_count,
    suppressedCount: r.suppressed_count,
    inhibitedBy: r.inhibited_by,
    version: r.version
  };
}

class SqliteAlertStore {
  db;
  table;
  constructor(db, table = "alert_state") {
    this.db = db;
    this.table = table;
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
        key TEXT PRIMARY KEY,
        active INTEGER NOT NULL DEFAULT 0,
        since INTEGER,
        last_sent_at INTEGER,
        last_cleared_at INTEGER,
        sent_count INTEGER NOT NULL DEFAULT 0,
        suppressed_count INTEGER NOT NULL DEFAULT 0,
        inhibited_by TEXT,
        version INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )`);
  }
  async get(key) {
    const row = this.db.prepare(`SELECT * FROM ${this.table} WHERE key = ?`).get(key);
    return row ? fromSqlite(row) : null;
  }
  async claim(next, expectedVersion) {
    const params = [
      next.active ? 1 : 0,
      next.since,
      next.lastSentAt,
      next.lastClearedAt,
      next.sentCount,
      next.suppressedCount,
      next.inhibitedBy,
      next.version,
      Math.floor(Date.now() / 1000)
    ];
    if (expectedVersion === null) {
      const r2 = this.db.prepare(`INSERT OR IGNORE INTO ${this.table}
           (key, active, since, last_sent_at, last_cleared_at, sent_count, suppressed_count, inhibited_by, version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(next.key, ...params);
      return r2.changes === 1;
    }
    const r = this.db.prepare(`UPDATE ${this.table}
         SET active = ?, since = ?, last_sent_at = ?, last_cleared_at = ?, sent_count = ?,
             suppressed_count = ?, inhibited_by = ?, version = ?, updated_at = ?
         WHERE key = ? AND version = ?`).run(...params, next.key, expectedVersion);
    return r.changes === 1;
  }
  async listInhibitedBy(parentKey) {
    const rows = this.db.prepare(`SELECT * FROM ${this.table} WHERE active = 1 AND inhibited_by = ? ORDER BY since ASC`).all(parentKey);
    return rows.map(fromSqlite);
  }
}
// src/format.ts
function humanDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor(s % 86400 / 3600);
  const m = Math.floor(s % 3600 / 60);
  if (d > 0)
    return `${d}d ${h}h`;
  if (h > 0)
    return `${h}h ${m}m`;
  if (m > 0)
    return `${m}m`;
  return `${s}s`;
}
function iso(ms) {
  return ms === null ? "?" : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function formatAlert(action, input, next, now, extra) {
  const lines = [];
  const since = extra.openedAt;
  if (action === "raise") {
    lines.push(`\uD83D\uDD34 ${input.title}`);
    if (input.detail)
      lines.push(input.detail);
    lines.push(`since ${iso(since)} · key ${input.key}`);
    if (extra.flapping) {
      lines.push(`⚠️ re-opened ${humanDuration(now - (next.lastClearedAt ?? now))} after clearing — flapping?`);
    }
    if (next.sentCount === 1 && now - since > 60000) {
      const why = extra.heldBy === "debounce" ? "held to confirm it was not a blip" : extra.heldBy === "inhibited" ? "was inhibited by a parent incident" : "raised late";
      lines.push(`(already open ${humanDuration(now - since)} — ${why})`);
    }
    lines.push("Reminders at 1h, 6h, 24h, then daily (silent). You will get a \uD83D\uDFE2 when it clears.");
  } else if (action === "remind") {
    lines.push(`\uD83D\uDFE0 STILL OPEN ${humanDuration(now - since)} — ${input.title}`);
    if (input.detail)
      lines.push(input.detail);
    lines.push(`since ${iso(since)} · reminder #${extra.reminderNumber ?? "?"} · ${extra.suppressedBeforeThis} checks confirmed it since the last message · key ${input.key}`);
    const due = nextReminderDue(next);
    if (due !== null)
      lines.push(`next reminder in ${humanDuration(due - now)}`);
  } else {
    lines.push(`\uD83D\uDFE2 RESOLVED — ${input.title}`);
    lines.push(`was open ${humanDuration(now - since)} · key ${input.key}`);
  }
  if (extra.inhibited.length > 0) {
    lines.push("");
    lines.push(`Inhibited by this incident (${extra.inhibited.length}):`);
    for (const child of extra.inhibited) {
      lines.push(`  • ${child.key} — open ${humanDuration(now - (child.since ?? now))}, ${child.suppressedCount} checks swallowed`);
    }
  }
  return lines.join(`
`);
}
// src/evaluate.ts
function createAlertEvaluator(opts) {
  const clock = opts.now ?? (() => Date.now());
  const onError = opts.onError ?? ((err, key) => console.error("[alert-policy] store failure — alert not evaluated", { key, err }));
  return async function evaluate(input) {
    const now = input.now ?? clock();
    const store = opts.store;
    try {
      const prev = await store.get(input.key);
      let inhibitor = null;
      if (input.inhibitedBy) {
        const parent = await store.get(input.inhibitedBy);
        if (parent?.active)
          inhibitor = input.inhibitedBy;
      }
      const d = decide(prev, input.key, input.condition, now, inhibitor, input.debounceMs ?? 0);
      if (!d.changed)
        return "none";
      const won = await store.claim(d.next, prev?.version ?? null);
      if (!won)
        return "lost-race";
      if (d.action === "none" || d.action === "suppress" || d.action === "pend")
        return d.action;
      const text = formatAlert(d.action, input, d.next, now, {
        flapping: d.flapping,
        heldBy: d.heldBy,
        reminderNumber: d.reminderNumber,
        suppressedBeforeThis: prev?.suppressedCount ?? 0,
        openedAt: prev?.since ?? d.next.since ?? now,
        inhibited: d.action === "raise" || d.action === "remind" ? await store.listInhibitedBy(input.key) : []
      });
      const sent = await opts.send(text, { silent: d.action === "remind" });
      return sent ? d.action : "send-failed";
    } catch (err) {
      onError(err, input.key);
      return "store-failed";
    }
  };
}
// src/rolling-window.ts
function countInWindow(timestampsMs, windowMs, now) {
  const since = now - windowMs;
  let count = 0;
  for (const t of timestampsMs) {
    if (t >= since && t <= now)
      count++;
  }
  return count;
}
function crossesThreshold(count, threshold) {
  return count >= threshold;
}
function rollingThresholdCondition(input) {
  const count = countInWindow(input.timestampsMs, input.windowMs, input.now);
  return { count, condition: crossesThreshold(count, input.threshold) };
}
