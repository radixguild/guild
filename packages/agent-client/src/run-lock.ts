// run-lock.ts — one `guild-agent run` per agent (Bring Your Agent design note §2.3, private operations repository).
//
//   ~/.radix-guild/run.lock   the pid of the running loop, beside the key
//
// `run` takes it at start and releases it on exit; `sweep` refuses while a
// live loop holds it (unless --force), because a sweep between the loop's
// balance check and its claim makes that claim abort — a wasted fee, never
// lost funds.
//
// Created atomically and complete: the pid is written to a temp file first,
// then hard-linked into place, and link(2) fails if the lock already exists —
// so two starts cannot both win, and nobody ever reads a half-written lock.
// A lock whose pid is no longer running is STALE and is taken over; one that
// cannot be read is treated as held (fail closed) and names the file to clear.
//
// Liveness is POSIX kill(pid, 0) on this host only: a lock on a filesystem
// shared between machines cannot see the other machine's processes, and a pid
// the OS has since REUSED for an unrelated process reads as held (the refusal
// names the pid so a person can check it). A stale takeover re-reads the pid
// before removing it, which narrows — does not close — the window where two
// simultaneous takeovers both succeed.

import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveStateDir } from './agent-state.js';

export type RunLockState =
  | { state: 'free' }
  | { state: 'held'; pid: number }
  | { state: 'stale'; pid: number }
  | { state: 'unreadable' };

export type IsAlive = (pid: number) => boolean;

export function resolveRunLockPath(env: Record<string, string | undefined> = process.env): string {
  return join(resolveStateDir(env), 'run.lock');
}

/** kill(pid, 0): ESRCH = gone; EPERM = running under another user, so alive. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

function readPid(path: string): number | 'missing' | 'unreadable' {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    // EACCES, EISDIR, … — a lock that exists but cannot be read refuses.
    return 'unreadable';
  }
  const pid = Number(text.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : 'unreadable';
}

export function inspectRunLock(path: string, isAlive: IsAlive = processIsAlive): RunLockState {
  const pid = readPid(path);
  if (pid === 'missing') return { state: 'free' };
  if (pid === 'unreadable') return { state: 'unreadable' };
  return isAlive(pid) ? { state: 'held', pid } : { state: 'stale', pid };
}

/**
 * Take the lock for `pid` (this process by default). Refuses while a live
 * process holds it or while it cannot be read; takes over a stale one.
 */
export function acquireRunLock(
  path: string,
  options: { pid?: number; isAlive?: IsAlive } = {}
): { ok: true } | { ok: false; lock: RunLockState } {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${pid}.tmp`;
  writeFileSync(tmp, `${pid}\n`, { mode: 0o600 });
  try {
    // Two rounds: a stale lock (or one that vanished between link and read)
    // gets one retry; anything still in the way after that is reported.
    for (let round = 0; round < 2; round++) {
      try {
        linkSync(tmp, path);
        return { ok: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const lock = inspectRunLock(path, isAlive);
      if (lock.state === 'held' || lock.state === 'unreadable') return { ok: false, lock };
      if (lock.state === 'stale' && readPid(path) === lock.pid) rmSync(path, { force: true });
    }
    return { ok: false, lock: inspectRunLock(path, isAlive) };
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Release the lock only if `pid` holds it. Returns whether a lock was removed. */
export function releaseRunLock(path: string, pid: number = process.pid): boolean {
  if (readPid(path) !== pid) return false;
  rmSync(path, { force: true });
  return true;
}

/** The line a refused `run` / `sweep` prints for a lock it could not take or pass. */
export function describeRunLock(path: string, lock: RunLockState): string {
  switch (lock.state) {
    case 'held':
      return (
        `guild-agent run is already running for this agent (pid ${lock.pid}, lock ${path}). ` +
        `If \`ps -p ${lock.pid}\` shows some other program, that pid was reused: delete the lock file.`
      );
    case 'unreadable':
      return `the run lock ${path} cannot be read. If no guild-agent run is running, delete that file and retry.`;
    case 'stale':
      return `the run lock ${path} names pid ${lock.pid}, which is no longer running.`;
    case 'free':
      return `no guild-agent run holds ${path}.`;
  }
}
