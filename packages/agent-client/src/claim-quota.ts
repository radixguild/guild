// claim-quota.ts — the day quota on a personal agent's claims
// (Bring Your Agent design note §2.3, private operations repository; rules.maxClaimsPerDay).
//
//   ~/.radix-guild/claims.json   [{ "taskId": 99, "at": "2026-09-27T02:00:00.000Z" }, …]
//
// A ROLLING 24-hour window, not a calendar day: the owner may set the cap as
// high as 100, and a calendar day would let an agent claim the cap just before
// midnight and the cap again just after. Entries older than the window are
// pruned on every write.
//
// Fail closed both ways. A log that cannot be READ counts as a spent quota
// (the loop claims nothing and says why), never as an empty one. A claim that
// cannot be RECORDED is the caller's to stop on — an unrecorded claim would
// let the next tick claim again. The file is written atomically (temp +
// rename), like agent.json beside it.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveStateDir } from './agent-state.js';

export const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ClaimEntry {
  taskId: number;
  /** ISO timestamp of the committed claim. */
  at: string;
}

export type QuotaRead = { ok: true; entries: ClaimEntry[] } | { ok: false; why: string };

export function resolveClaimsLogPath(env: Record<string, string | undefined> = process.env): string {
  return join(resolveStateDir(env), 'claims.json');
}

function isEntry(value: unknown): value is ClaimEntry {
  const e = value as Partial<ClaimEntry> | null;
  return (
    !!e &&
    typeof e === 'object' &&
    Number.isSafeInteger(e.taskId) &&
    typeof e.at === 'string' &&
    Number.isFinite(Date.parse(e.at))
  );
}

/** Every entry inside the window ending at `now` (a future-dated entry counts). */
export function readClaimsInWindow(path: string, now: number): QuotaRead {
  if (!existsSync(path)) return { ok: true, entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { ok: false, why: `the claim log ${path} is unreadable (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!Array.isArray(parsed) || !parsed.every(isEntry)) {
    return { ok: false, why: `the claim log ${path} is not a list of {taskId, at} entries` };
  }
  return { ok: true, entries: parsed.filter(e => Date.parse(e.at) > now - QUOTA_WINDOW_MS) };
}

/**
 * Record a committed claim. Throws if the log cannot be read or written — the
 * caller must then stop claiming, because the next tick could not count it.
 */
export function recordClaim(path: string, taskId: number, at: Date): void {
  const read = readClaimsInWindow(path, at.getTime());
  if (!read.ok) throw new Error(`cannot record claim #${taskId}: ${read.why}`);
  const next: ClaimEntry[] = [...read.entries, { taskId, at: at.toISOString() }];
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/**
 * How many claims this tick may make: at most ONE, however much of the day's
 * quota is left — a burst of open tasks can never spend the day in one tick.
 * An unreadable log allows none.
 */
export function claimsAllowedThisTick(maxClaimsPerDay: number, read: QuotaRead): number {
  if (!read.ok) return 0;
  return Math.min(1, Math.max(0, maxClaimsPerDay - read.entries.length));
}
