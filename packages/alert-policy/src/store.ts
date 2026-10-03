/**
 * Alert state persistence — the interface every consumer implements, plus the
 * two stores every consumer can use as-is.
 *
 * `claim()` is the whole point of the interface. It persists `next` ONLY if
 * the stored version still equals `expectedVersion` (null = no row yet). The
 * evaluator sends a message only when claim() returns true, so concurrent
 * evaluations of one key cannot double-send: the write is the permission.
 *
 *   MemoryAlertStore  a Map. Tests, and the per-call fail-soft fallback.
 *   SqliteAlertStore  any better-sqlite3-shaped handle (duck-typed, no
 *                     dependency) — the guild-public bot, auto-trader-xrd and
 *                     sats-trader-tg all already carry one.
 *
 * Postgres (guild-app) implements the interface in its own tree because it
 * needs drizzle; the shape is identical.
 */

import type { AlertState } from "./policy";

export interface AlertStore {
  get(key: string): Promise<AlertState | null>;
  /** Persist `next` iff the stored version is still `expectedVersion`. True = this caller won. */
  claim(next: AlertState, expectedVersion: number | null): Promise<boolean>;
  /** Open incidents whose raise was swallowed by `parentKey` (for the parent's reminders). */
  listInhibitedBy(parentKey: string): Promise<AlertState[]>;
}

export class MemoryAlertStore implements AlertStore {
  private readonly rows = new Map<string, AlertState>();

  async get(key: string): Promise<AlertState | null> {
    const row = this.rows.get(key);
    return row ? { ...row } : null;
  }

  async claim(next: AlertState, expectedVersion: number | null): Promise<boolean> {
    const current = this.rows.get(next.key);
    const currentVersion = current ? current.version : null;
    if (currentVersion !== expectedVersion) return false;
    this.rows.set(next.key, { ...next });
    return true;
  }

  async listInhibitedBy(parentKey: string): Promise<AlertState[]> {
    return [...this.rows.values()].filter((r) => r.active && r.inhibitedBy === parentKey);
  }

  /** Test helper. */
  clear(): void {
    this.rows.clear();
  }
}

/** The subset of better-sqlite3's Database this store touches. */
export interface SqliteLike {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number };
  };
}

type SqliteRow = {
  key: string;
  active: number;
  since: number | null;
  last_sent_at: number | null;
  last_cleared_at: number | null;
  sent_count: number;
  suppressed_count: number;
  inhibited_by: string | null;
  version: number;
};

function fromSqlite(r: SqliteRow): AlertState {
  return {
    key: r.key,
    active: r.active === 1,
    since: r.since,
    lastSentAt: r.last_sent_at,
    lastClearedAt: r.last_cleared_at,
    sentCount: r.sent_count,
    suppressedCount: r.suppressed_count,
    inhibitedBy: r.inhibited_by,
    version: r.version,
  };
}

/**
 * SQLite store for the CommonJS bots. Creates its table on construction
 * (idempotent), so adoption is one line: `new SqliteAlertStore(db)`.
 */
export class SqliteAlertStore implements AlertStore {
  constructor(
    private readonly db: SqliteLike,
    private readonly table = "alert_state",
  ) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (
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
      )`,
    );
  }

  async get(key: string): Promise<AlertState | null> {
    const row = this.db.prepare(`SELECT * FROM ${this.table} WHERE key = ?`).get(key) as
      | SqliteRow
      | undefined;
    return row ? fromSqlite(row) : null;
  }

  async claim(next: AlertState, expectedVersion: number | null): Promise<boolean> {
    const params = [
      next.active ? 1 : 0,
      next.since,
      next.lastSentAt,
      next.lastClearedAt,
      next.sentCount,
      next.suppressedCount,
      next.inhibitedBy,
      next.version,
      Math.floor(Date.now() / 1000),
    ];
    if (expectedVersion === null) {
      const r = this.db
        .prepare(
          `INSERT OR IGNORE INTO ${this.table}
           (key, active, since, last_sent_at, last_cleared_at, sent_count, suppressed_count, inhibited_by, version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(next.key, ...params);
      return r.changes === 1;
    }
    const r = this.db
      .prepare(
        `UPDATE ${this.table}
         SET active = ?, since = ?, last_sent_at = ?, last_cleared_at = ?, sent_count = ?,
             suppressed_count = ?, inhibited_by = ?, version = ?, updated_at = ?
         WHERE key = ? AND version = ?`,
      )
      .run(...params, next.key, expectedVersion);
    return r.changes === 1;
  }

  async listInhibitedBy(parentKey: string): Promise<AlertState[]> {
    const rows = this.db
      .prepare(`SELECT * FROM ${this.table} WHERE active = 1 AND inhibited_by = ? ORDER BY since ASC`)
      .all(parentKey) as SqliteRow[];
    return rows.map(fromSqlite);
  }
}
