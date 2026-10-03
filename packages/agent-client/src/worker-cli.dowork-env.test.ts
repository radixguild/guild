// P4-2 v1 acceptance (EXTERNAL-V1-FRAMEWORK.md): the doWork BRAIN reads
// attacker-authored task text, so the process running it must never see guild
// credentials. The spawn tests exercise the REAL path (createCommandDoWork →
// node:child_process spawn) via a nested probe process whose environ HOLDS the
// key at launch — red on reverting the `env:` key at the spawn site. A nested
// process is load-bearing, and the reason survived the 2026-08-16 move off
// Bun.spawn unchanged: buildDoWorkEnv() snapshots process.env at the moment
// createCommandDoWork is CALLED, so a canary assigned inside a test never
// reaches the child and an in-process test would stay green with the allowlist
// reverted. (Bun.spawn below is the TEST HARNESS launching the probe — the
// suite runs under bun; the code under test no longer uses it.)

import { describe, expect, test } from 'bun:test';

import { buildDoWorkEnv } from './worker-cli.js';

const CANARY = 'p42-canary-never-a-real-key';
const PROBE = new URL('./worker-cli.dowork-env.probe.ts', import.meta.url).pathname;

async function runProbe(extraEnv: Record<string, string>): Promise<string> {
  const proc = Bun.spawn([process.execPath, 'run', PROBE], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '',
      ...extraEnv,
    },
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`probe exited ${exitCode}: ${stderr.slice(0, 500)}`);
  }
  return stdout;
}

describe('buildDoWorkEnv — allowlist construction', () => {
  test('never passes GUILD_* from the parent env, even when set', () => {
    const env = buildDoWorkEnv({
      PATH: '/usr/bin',
      GUILD_AGENT_PRIVATE_KEY: CANARY,
      GUILD_API_TOKEN_TEST_ONLY: CANARY,
    });
    expect(env.PATH).toBe('/usr/bin');
    for (const key of Object.keys(env)) {
      expect(key.startsWith('GUILD_')).toBe(false);
    }
  });

  test('passes only the default names plus GUILD_DOWORK_ENV entries', () => {
    const env = buildDoWorkEnv({
      PATH: '/usr/bin',
      HOME: '/home/w',
      ANTHROPIC_API_KEY: 'brain-own-key',
      UNRELATED_SECRET: 'nope',
      GUILD_DOWORK_ENV: 'ANTHROPIC_API_KEY',
    });
    expect(env.ANTHROPIC_API_KEY).toBe('brain-own-key');
    expect(env.UNRELATED_SECRET).toBeUndefined();
  });

  test('THROWS when GUILD_DOWORK_ENV tries to allowlist a GUILD_* name (any case)', () => {
    for (const name of ['GUILD_AGENT_PRIVATE_KEY', 'guild_api_token']) {
      expect(() => buildDoWorkEnv({ GUILD_DOWORK_ENV: name })).toThrow(/must not pass GUILD_\*/);
    }
  });

  test('skips blank entries and unset names instead of writing undefined', () => {
    const env = buildDoWorkEnv({ PATH: '/usr/bin', GUILD_DOWORK_ENV: ' , NOT_SET , ' });
    expect('NOT_SET' in env).toBe(false);
    expect(Object.values(env).every((v) => typeof v === 'string')).toBe(true);
  });
});

describe('createCommandDoWork — the real spawn path holds no guild secret', () => {
  test('brain env contains no GUILD_ variable when the worker holds the key', async () => {
    const dump = await runProbe({ GUILD_AGENT_PRIVATE_KEY: CANARY });
    expect(dump).toContain('PATH='); // proves we read a real env dump
    expect(dump).not.toContain(CANARY);
    expect(dump).not.toContain('GUILD_');
  });

  test('operator passthrough reaches the brain; guild key still does not', async () => {
    const dump = await runProbe({
      GUILD_AGENT_PRIVATE_KEY: CANARY,
      P42_BRAIN_ALLOWED: 'visible-to-brain',
      GUILD_DOWORK_ENV: 'P42_BRAIN_ALLOWED',
    });
    expect(dump).toContain('P42_BRAIN_ALLOWED=visible-to-brain');
    expect(dump).not.toContain(CANARY);
    expect(dump).not.toContain('GUILD_');
  });
});
