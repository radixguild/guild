// run-lock.ts — one `guild-agent run` per agent. The lock is taken atomically
// (a complete pid, or nothing), refused while a live process holds it or while
// it cannot be read, taken over when stale, and released only by its holder.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEY_FILE_ENV } from './key-file.js';
import {
  acquireRunLock,
  describeRunLock,
  inspectRunLock,
  processIsAlive,
  releaseRunLock,
  resolveRunLockPath,
} from './run-lock.js';

let dir: string;
let lock: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guild-lock-'));
  lock = join(dir, 'run.lock');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const alive = () => true;
const dead = () => false;

test('the lock sits beside the key file', () => {
  expect(resolveRunLockPath({ [KEY_FILE_ENV]: join(dir, 'k', 'agent.key') })).toBe(join(dir, 'k', 'run.lock'));
});

describe('acquireRunLock', () => {
  test('free → taken, the file holds exactly the pid, no temp file left behind', () => {
    expect(acquireRunLock(lock, { pid: 4242, isAlive: alive })).toEqual({ ok: true });
    expect(readFileSync(lock, 'utf8')).toBe('4242\n');
    expect(readdirSync(dir)).toEqual(['run.lock']);
  });

  test('held by a live process → refused, naming its pid; the lock is untouched', () => {
    writeFileSync(lock, '777\n');
    const result = acquireRunLock(lock, { pid: 4242, isAlive: alive });
    expect(result).toEqual({ ok: false, lock: { state: 'held', pid: 777 } });
    expect(readFileSync(lock, 'utf8')).toBe('777\n');
    expect(readdirSync(dir)).toEqual(['run.lock']);
  });

  test('a second acquire by another live pid loses to the first', () => {
    expect(acquireRunLock(lock, { pid: 1001, isAlive: alive }).ok).toBe(true);
    expect(acquireRunLock(lock, { pid: 1002, isAlive: alive })).toEqual({ ok: false, lock: { state: 'held', pid: 1001 } });
  });

  test('stale (its pid is gone) → taken over', () => {
    writeFileSync(lock, '777\n');
    expect(acquireRunLock(lock, { pid: 4242, isAlive: pid => pid !== 777 })).toEqual({ ok: true });
    expect(readFileSync(lock, 'utf8')).toBe('4242\n');
  });

  test('a stale takeover never removes a lock another process took in the meantime (the re-read guard)', () => {
    writeFileSync(lock, '777\n'); // a dead holder
    // Simulate the race: the moment we judge 777 dead, another starter takes the
    // stale lock over and writes its own live pid (888) — before our removal.
    const result = acquireRunLock(lock, {
      pid: 4242,
      isAlive: pid => {
        if (pid === 777) {
          writeFileSync(lock, '888\n');
          return false;
        }
        return pid === 888;
      },
    });
    expect(result).toEqual({ ok: false, lock: { state: 'held', pid: 888 } });
    expect(readFileSync(lock, 'utf8')).toBe('888\n');
  });

  test('a lock that exists but cannot be read (EACCES) → refused as unreadable, not a crash', () => {
    if (process.getuid?.() === 0) return; // root reads through a 000 mode
    writeFileSync(lock, '777\n');
    chmodSync(lock, 0o000);
    try {
      expect(inspectRunLock(lock, alive)).toEqual({ state: 'unreadable' });
      expect(acquireRunLock(lock, { pid: 4242, isAlive: alive })).toEqual({ ok: false, lock: { state: 'unreadable' } });
    } finally {
      chmodSync(lock, 0o600);
    }
  });

  test('unreadable → refused (fail closed), never overwritten', () => {
    writeFileSync(lock, 'not a pid');
    const result = acquireRunLock(lock, { pid: 4242, isAlive: alive });
    expect(result).toEqual({ ok: false, lock: { state: 'unreadable' } });
    expect(readFileSync(lock, 'utf8')).toBe('not a pid');
  });

  test('a stale lock whose "new owner" is also dead is still reported, not looped on', () => {
    writeFileSync(lock, '777\n');
    // Everything reads as dead, including us: one takeover, then success.
    expect(acquireRunLock(lock, { pid: 4242, isAlive: dead }).ok).toBe(true);
  });
});

describe('releaseRunLock', () => {
  test('the holder releases it', () => {
    acquireRunLock(lock, { pid: 4242, isAlive: alive });
    expect(releaseRunLock(lock, 4242)).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  test("another pid cannot release someone else's lock", () => {
    acquireRunLock(lock, { pid: 4242, isAlive: alive });
    expect(releaseRunLock(lock, 5555)).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe('4242\n');
  });

  test('releasing a missing lock is a no-op', () => {
    expect(releaseRunLock(lock, 4242)).toBe(false);
  });
});

describe('inspectRunLock + processIsAlive', () => {
  test('free / held / stale / unreadable', () => {
    expect(inspectRunLock(lock)).toEqual({ state: 'free' });
    writeFileSync(lock, `${process.pid}\n`);
    expect(inspectRunLock(lock)).toEqual({ state: 'held', pid: process.pid });
    writeFileSync(lock, '-3\n');
    expect(inspectRunLock(lock)).toEqual({ state: 'unreadable' });
  });

  test('a finished child process reads as dead; this process as alive', () => {
    const child = spawnSync(process.execPath, ['-e', '0']);
    expect(typeof child.pid).toBe('number');
    expect(processIsAlive(child.pid as number)).toBe(false);
    expect(processIsAlive(process.pid)).toBe(true);
  });

  test("a process under another user (EPERM) reads as ALIVE — never a stale lock to take over", () => {
    // pid 1 is init/launchd, owned by root: as a normal user kill(1, 0) is EPERM.
    // (Run as root it simply succeeds — alive either way.)
    expect(processIsAlive(1)).toBe(true);
  });

  test('describeRunLock names the pid and the file to clear', () => {
    expect(describeRunLock(lock, { state: 'held', pid: 9 })).toContain('pid 9');
    expect(describeRunLock(lock, { state: 'held', pid: 9 })).toContain('ps -p 9');
    expect(describeRunLock(lock, { state: 'unreadable' })).toContain(`delete that file`);
  });
});
