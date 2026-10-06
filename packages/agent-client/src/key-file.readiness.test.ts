// doctor and onboard read the agent key from the same sources the signing
// commands do: GUILD_AGENT_PRIVATE_KEY, else the file GUILD_AGENT_KEY_FILE
// names. Before 0.8.1 both read only the env var, so an agent that followed the
// README with a key file was told "agent key: fail" while `run` and
// `mint-badge --live` signed with that same file key.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { runDoctor, type DoctorDeps } from './doctor.js';
import { AgentIdentity } from './identity.js';
import { findAgentPrivateKeyHex } from './key-file.js';
import { runOnboard, type OnboardDeps } from './onboard.js';

const CONFIG = loadConfig();
const FILE_KEY = 'dd'.repeat(32);
const ENV_KEY = 'ee'.repeat(32);
let dir: string;
let goodFile: string;
let badFile: string;
let missingFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'guild-keyfile-readiness-'));
  goodFile = join(dir, 'agent.key');
  badFile = join(dir, 'bad.key');
  missingFile = join(dir, 'missing.key');
  writeFileSync(goodFile, `${FILE_KEY}\n`, { mode: 0o600 });
  writeFileSync(badFile, 'not-a-key\n', { mode: 0o600 });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Doctor deps with no network: the gateway is "down", so only the key check matters. */
const offlineDoctor: Partial<DoctorDeps> = {
  fetchGatewayStatus: async () => null,
  fetchFn: (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch,
  localPairing: () => null,
};

describe('findAgentPrivateKeyHex', () => {
  test('env first, then the file, else null; a bad file throws value-free', () => {
    expect(findAgentPrivateKeyHex({ GUILD_AGENT_PRIVATE_KEY: ENV_KEY, GUILD_AGENT_KEY_FILE: goodFile })?.source).toBe('env');
    expect(findAgentPrivateKeyHex({ GUILD_AGENT_KEY_FILE: goodFile })).toEqual({ keyHex: FILE_KEY, source: 'file', path: goodFile });
    expect(findAgentPrivateKeyHex({ GUILD_AGENT_KEY_FILE: missingFile })).toBeNull();
    let message = '';
    try {
      findAgentPrivateKeyHex({ GUILD_AGENT_KEY_FILE: badFile });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(badFile);
    expect(message).not.toContain('not-a-key');
  });
});

describe('doctor key check', () => {
  test('only GUILD_AGENT_KEY_FILE set → key passes with the derived address', async () => {
    const expected = (await AgentIdentity.fromPrivateKeyHex(FILE_KEY)).address;
    const report = await runDoctor({ config: CONFIG, env: { GUILD_AGENT_KEY_FILE: goodFile }, deps: offlineDoctor });
    const key = report.checks.find(c => c.id === 'key')!;
    expect(key.status).toBe('pass');
    expect(key.detail).toContain(expected);
    expect(report.address).toBe(expected);
  });

  test('a malformed key file is named as such, not "no key", and never echoed', async () => {
    const report = await runDoctor({ config: CONFIG, env: { GUILD_AGENT_KEY_FILE: badFile }, deps: offlineDoctor });
    const key = report.checks.find(c => c.id === 'key')!;
    expect(key.status).toBe('fail');
    expect(key.detail).toContain(badFile);
    expect(key.detail).not.toContain('No agent key');
    expect(JSON.stringify(report)).not.toContain('not-a-key');
  });

  test('no env key and no file → the "no key" failure names the file it looked for', async () => {
    const report = await runDoctor({ config: CONFIG, env: { GUILD_AGENT_KEY_FILE: missingFile }, deps: offlineDoctor });
    const key = report.checks.find(c => c.id === 'key')!;
    expect(key.status).toBe('fail');
    expect(key.detail).toContain(missingFile);
  });
});

describe('onboard key stage', () => {
  const deps: Partial<OnboardDeps> = {
    fetchXrdBalance: async () => 0, // stops at funding — enough to prove the key stage passed
    readClaimBondBasis: async () => ({ mode: 'flat', amountXrd: '10' }),
    resolveBadgeLocalId: async () => null,
    localPairing: () => null,
  };

  test('only GUILD_AGENT_KEY_FILE set → passes the key stage with the file key', async () => {
    const expected = (await AgentIdentity.fromPrivateKeyHex(FILE_KEY)).address;
    const outcome = await runOnboard({ config: CONFIG, env: { GUILD_AGENT_KEY_FILE: goodFile }, deps, log: () => {} });
    expect(outcome.address).toBe(expected);
    expect(outcome.reached).not.toBe('none');
  });

  test('a malformed key file stops at the key, named as unusable (not "no key")', async () => {
    const lines: string[] = [];
    const outcome = await runOnboard({ config: CONFIG, env: { GUILD_AGENT_KEY_FILE: badFile }, deps, log: l => lines.push(l) });
    expect(outcome.reached).toBe('none');
    expect(outcome.stoppedBecause).toBe('key file unusable');
    expect(lines.join('\n')).not.toContain('not-a-key');
  });
});
