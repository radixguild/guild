// loadAgentPrivateKeyHex: env first (the fleet's custody, unchanged), then the
// key file (the personal agent's custody). Hermetic — the file lives in a temp
// dir named through GUILD_AGENT_KEY_FILE, never the real home.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentPrivateKeyHex } from './config.js';
import { generateThrowawayPrivateKeyHex } from './throwaway-key.js';
import { KEY_FILE_ENV } from './key-file.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guild-cfg-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadAgentPrivateKeyHex', () => {
  test('env wins, even when a key file exists', () => {
    const path = join(dir, 'agent.key');
    const fileHex = generateThrowawayPrivateKeyHex();
    const envHex = generateThrowawayPrivateKeyHex();
    writeFileSync(path, `${fileHex}\n`, { mode: 0o600 });
    expect(loadAgentPrivateKeyHex({ GUILD_AGENT_PRIVATE_KEY: envHex, [KEY_FILE_ENV]: path })).toBe(envHex);
  });

  test('falls back to the key file when the env var is unset or empty', () => {
    const path = join(dir, 'agent.key');
    const fileHex = generateThrowawayPrivateKeyHex();
    writeFileSync(path, `${fileHex}\n`, { mode: 0o600 });
    expect(loadAgentPrivateKeyHex({ [KEY_FILE_ENV]: path })).toBe(fileHex);
    expect(loadAgentPrivateKeyHex({ GUILD_AGENT_PRIVATE_KEY: '', [KEY_FILE_ENV]: path })).toBe(fileHex);
  });

  test('names both sources and the fix when neither is present', () => {
    const path = join(dir, 'missing.key');
    expect(() => loadAgentPrivateKeyHex({ [KEY_FILE_ENV]: path })).toThrow(/GUILD_AGENT_PRIVATE_KEY is not set/);
    expect(() => loadAgentPrivateKeyHex({ [KEY_FILE_ENV]: path })).toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(() => loadAgentPrivateKeyHex({ [KEY_FILE_ENV]: path })).toThrow(/never creates a key — bring your own/);
    expect(() => loadAgentPrivateKeyHex({ [KEY_FILE_ENV]: path })).not.toThrow(/guild-agent join/);
  });
});
