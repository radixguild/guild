/**
 * Postgres alert-state store for the shared alert core (src/lib/alert-core,
 * vendored byte-for-byte from packages/alert-policy — see
 * tests/unit/alert-core-parity.test.ts).
 *
 *   • DbAlertStore     — the `alert_state` table (migration 0025). Survives
 *                        restarts, shared by the app and (later) the cron
 *                        watchers. Used whenever DATABASE_URL is set.
 *   • MemoryAlertStore — from the core. Unit tests, and the store when no
 *                        DATABASE_URL is set.
 *
 * `claim()` persists `next` ONLY if the stored version still equals
 * `expectedVersion` (null = no row yet): the write is the permission to send,
 * so concurrent evaluations of one key cannot double-send.
 *
 * The DB store keeps a short read-through cache so the healthy path (condition
 * false, nothing open) costs at most one SELECT per key per READ_CACHE_MS,
 * rather than one per request.
 */

import { and, eq, sql } from "drizzle-orm";
import { MemoryAlertStore, type AlertState, type AlertStore } from "./alert-core";

export { MemoryAlertStore, type AlertStore };

export const READ_CACHE_MS = 60_000;

type Row = {
  key: string;
  active: boolean;
  since: Date | null;
  lastSentAt: Date | null;
  lastClearedAt: Date | null;
  sentCount: number;
  suppressedCount: number;
  inhibitedBy: string | null;
  version: number;
};

function fromRow(r: Row): AlertState {
  return {
    key: r.key,
    active: r.active,
    since: r.since ? r.since.getTime() : null,
    lastSentAt: r.lastSentAt ? r.lastSentAt.getTime() : null,
    lastClearedAt: r.lastClearedAt ? r.lastClearedAt.getTime() : null,
    sentCount: r.sentCount,
    suppressedCount: r.suppressedCount,
    inhibitedBy: r.inhibitedBy,
    version: r.version,
  };
}

function toRow(s: AlertState) {
  return {
    key: s.key,
    active: s.active,
    since: s.since === null ? null : new Date(s.since),
    lastSentAt: s.lastSentAt === null ? null : new Date(s.lastSentAt),
    lastClearedAt: s.lastClearedAt === null ? null : new Date(s.lastClearedAt),
    sentCount: s.sentCount,
    suppressedCount: s.suppressedCount,
    inhibitedBy: s.inhibitedBy,
    version: s.version,
    updatedAt: new Date(),
  };
}

export class DbAlertStore implements AlertStore {
  private readonly cache = new Map<string, { state: AlertState | null; readAt: number }>();

  async get(key: string): Promise<AlertState | null> {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.readAt < READ_CACHE_MS) return hit.state ? { ...hit.state } : null;
    const { db } = await import("@/db");
    const { alertState } = await import("@/db/schema/alert-state");
    const rows = await db.select().from(alertState).where(eq(alertState.key, key)).limit(1);
    const state = rows[0] ? fromRow(rows[0] as Row) : null;
    this.cache.set(key, { state, readAt: now });
    return state ? { ...state } : null;
  }

  async claim(next: AlertState, expectedVersion: number | null): Promise<boolean> {
    const { db } = await import("@/db");
    const { alertState } = await import("@/db/schema/alert-state");
    const row = toRow(next);
    let won: boolean;
    if (expectedVersion === null) {
      // No row was read: only the first inserter wins.
      const inserted = await db
        .insert(alertState)
        .values(row)
        .onConflictDoNothing()
        .returning({ key: alertState.key });
      won = inserted.length === 1;
    } else {
      const updated = await db
        .update(alertState)
        .set(row)
        .where(and(eq(alertState.key, next.key), eq(alertState.version, expectedVersion)))
        .returning({ key: alertState.key });
      won = updated.length === 1;
    }
    // Losing the race means someone else wrote a newer state; forget ours so
    // the next read goes to the table.
    if (won) this.cache.set(next.key, { state: { ...next }, readAt: Date.now() });
    else this.cache.delete(next.key);
    return won;
  }

  async listInhibitedBy(parentKey: string): Promise<AlertState[]> {
    const { db } = await import("@/db");
    const { alertState } = await import("@/db/schema/alert-state");
    const rows = await db
      .select()
      .from(alertState)
      .where(and(eq(alertState.active, true), eq(alertState.inhibitedBy, parentKey)))
      .orderBy(sql`${alertState.since} asc`);
    return rows.map((r) => fromRow(r as Row));
  }
}

let memorySingleton: MemoryAlertStore | null = null;
let dbSingleton: DbAlertStore | null = null;

/** The process-wide memory store — the fallback, and the store under test. */
export function memoryAlertStore(): MemoryAlertStore {
  if (!memorySingleton) memorySingleton = new MemoryAlertStore();
  return memorySingleton;
}

/**
 * DB-backed when DATABASE_URL is set, memory otherwise. Tests never set
 * DATABASE_URL, so they exercise the same policy against the memory store.
 */
export function defaultAlertStore(): AlertStore {
  if (process.env.DATABASE_URL) {
    if (!dbSingleton) dbSingleton = new DbAlertStore();
    return dbSingleton;
  }
  return memoryAlertStore();
}

/** Test-only: drop both singletons so state cannot leak across cases. */
export function _resetAlertStoresForTests(): void {
  memorySingleton = null;
  dbSingleton = null;
}
