// key-file.ts — the kit READS a key file; it never writes one. Everything runs in a
// temp dir; nothing touches the real ~/.radix-guild. The fixtures below are written by
// the TEST (the developer's own file, in real use) — key-file.ts has no writer.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as keyFile from './key-file.js';
import {
  KEY_FILE_ENV,
  keyFileExists,
  keyFileIsGroupOrWorldReadable,
  readKeyFile,
  resolveKeyFilePath,
} from './key-file.js';
import { generateThrowawayPrivateKeyHex } from './throwaway-key.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guild-key-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveKeyFilePath', () => {
  test('defaults under the home directory', () => {
    const p = resolveKeyFilePath({});
    expect(p.endsWith(join('.radix-guild', 'agent.key'))).toBe(true);
  });
  test(`${KEY_FILE_ENV} overrides it; blank is ignored`, () => {
    expect(resolveKeyFilePath({ [KEY_FILE_ENV]: '/x/y.key' })).toBe('/x/y.key');
    expect(resolveKeyFilePath({ [KEY_FILE_ENV]: '   ' }).endsWith('agent.key')).toBe(true);
  });
});

describe('readKeyFile', () => {
  test('reads the hex a developer put there, tolerating a trailing newline', () => {
    const path = join(dir, 'agent.key');
    const hex = generateThrowawayPrivateKeyHex();
    writeFileSync(path, `${hex}\n`, { mode: 0o600 });
    expect(keyFileExists(path)).toBe(true);
    expect(readKeyFile(path)).toBe(hex);
    if (process.platform !== 'win32') expect(keyFileIsGroupOrWorldReadable(path)).toBe(false);
  });

  test('a corrupt file reads as a value-free error', () => {
    const path = join(dir, 'agent.key');
    writeFileSync(path, 'deadbeef\n');
    expect(() => readKeyFile(path)).toThrow(/agent key file/);
    expect(() => readKeyFile(path)).not.toThrow(/deadbeef/);
  });

  test('a missing file reads as a clear error naming the path', () => {
    expect(() => readKeyFile(join(dir, 'nope.key'))).toThrow(/cannot read the agent key file/);
  });

  test('flags a group/world-readable key file', () => {
    if (process.platform === 'win32') return;
    const path = join(dir, 'agent.key');
    writeFileSync(path, `${generateThrowawayPrivateKeyHex()}\n`, { mode: 0o600 });
    chmodSync(path, 0o644);
    expect(keyFileIsGroupOrWorldReadable(path)).toBe(true);
  });
});

describe('the module has no way to make or write a key', () => {
  test('exports only readers and path helpers — no writer, no generator, no overwrite error', () => {
    expect(Object.keys(keyFile).sort()).toEqual(
      [
        'DEFAULT_KEY_DIR_NAME',
        'DEFAULT_KEY_FILE_NAME',
        'KEY_FILE_ENV',
        'findAgentPrivateKeyHex', // a reader: env, else readKeyFile; null when neither exists
        'keyFileExists',
        'keyFileIsGroupOrWorldReadable',
        'readKeyFile',
        'resolveKeyFilePath',
      ].sort()
    );
  });
});
