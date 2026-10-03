// guild-worker.ts arg parsing — the routing contract. (Command behavior lives
// in doctor/onboard/mint tests; here we pin how argv becomes intent.)

import { describe, expect, test } from 'bun:test';
import { parseArgv } from './guild-worker.js';

describe('parseArgv', () => {
  test('bare invocation routes to help', () => {
    expect(parseArgv([]).command).toBe('help');
  });

  test('doctor with flags', () => {
    const args = parseArgv(['doctor', '--auth', '--json']);
    expect(args.command).toBe('doctor');
    expect(args.flags.has('auth')).toBe(true);
    expect(args.flags.has('json')).toBe(true);
  });

  test('value options: separate and = forms', () => {
    expect(parseArgv(['mint-badge', '--username', 'bob']).options.get('username')).toBe('bob');
    expect(parseArgv(['mint-badge', '--username=bob']).options.get('username')).toBe('bob');
  });

  test('--key=value on a non-value flag throws instead of becoming a garbage flag', () => {
    expect(() => parseArgv(['doctor', '--json=1'])).toThrow(/does not take a value/);
  });

  test('a value option without a value throws instead of eating the next flag', () => {
    expect(() => parseArgv(['mint-badge', '--username'])).toThrow(/needs a value/);
    expect(() => parseArgv(['mint-badge', '--username', '--live'])).toThrow(/needs a value/);
  });

  test('mixed flags + option', () => {
    const args = parseArgv(['onboard', '--live', '--username', 'w1', '--generate']);
    expect(args.flags.has('live')).toBe(true);
    expect(args.flags.has('generate')).toBe(true);
    expect(args.options.get('username')).toBe('w1');
  });

  test('run passes worker flags through', () => {
    const args = parseArgv(['run', '--live', '--loop']);
    expect(args.command).toBe('run');
    expect([...args.flags]).toEqual(['live', 'loop']);
    expect(args.rest).toEqual([]);
  });

  /**
   * P1-22: `--auto-withdraw` needs no special-casing in guild-worker.ts's
   * `run` dispatch — it is an unrecognized `--xxx` like `--live`/`--loop`/
   * `--on-chain`, so parseArgv already puts it in `args.flags`, and case
   * 'run' reconstructs `[...args.rest, ...[...args.flags].map(f =>
   * `--${f}`)]` before calling workerCliMain. This test pins that exact
   * reconstruction so a future change to the flag-forwarding shape cannot
   * silently drop a worker flag again.
   */
  test('run passes --auto-withdraw through unchanged, alongside the other worker flags', () => {
    const args = parseArgv(['run', '--live', '--on-chain', '--auto-withdraw', '--loop']);
    expect(args.command).toBe('run');
    expect(new Set(args.flags)).toEqual(new Set(['live', 'on-chain', 'auto-withdraw', 'loop']));
    expect(args.rest).toEqual([]);

    // The exact reconstruction guild-worker.ts's `case 'run':` performs.
    const forwarded = [...args.rest, ...[...args.flags].map(f => `--${f}`)];
    expect(new Set(forwarded)).toEqual(
      new Set(['--live', '--on-chain', '--auto-withdraw', '--loop'])
    );
  });

  test('dispute raise: sub-command and task id land in rest, --reason is a value option', () => {
    const args = parseArgv(['dispute', 'raise', '7', '--reason', 'the PR was never opened']);
    expect(args.command).toBe('dispute');
    expect(args.rest).toEqual(['raise', '7']);
    expect(args.options.get('reason')).toBe('the PR was never opened');
    expect(args.flags.has('live')).toBe(false);
  });

  test('dispute raise --live, and --reason= form', () => {
    const args = parseArgv(['dispute', 'raise', '7', '--reason=short', '--live']);
    expect(args.rest).toEqual(['raise', '7']);
    expect(args.options.get('reason')).toBe('short');
    expect(args.flags.has('live')).toBe(true);
  });

  test('dispute resolve: no --reason needed', () => {
    const args = parseArgv(['dispute', 'resolve', '9', '--live']);
    expect(args.command).toBe('dispute');
    expect(args.rest).toEqual(['resolve', '9']);
    expect(args.options.has('reason')).toBe(false);
    expect(args.flags.has('live')).toBe(true);
  });

  test('--reason without a value throws instead of eating the next flag (same guard as --username)', () => {
    expect(() => parseArgv(['dispute', 'raise', '7', '--reason'])).toThrow(/needs a value/);
    expect(() => parseArgv(['dispute', 'raise', '7', '--reason', '--live'])).toThrow(/needs a value/);
  });
});

// ── custody ruling R1: `run` must hand VALUE options to the loop, not just bare flags ──
describe('runPassthroughArgv — `guild-worker run … --sweep-to owner` reaches the loop', () => {
  test('a value option survives the hand-off (it was silently dropped before 2026-09-21)', async () => {
    const { parseArgv, runPassthroughArgv } = await import('./guild-worker.js');
    const argv = runPassthroughArgv(parseArgv(['run', '--live', '--on-chain', '--auto-withdraw', '--sweep-to', 'owner']));
    expect(argv).toContain('--live');
    expect(argv).toContain('--auto-withdraw');
    const i = argv.indexOf('--sweep-to');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe('owner');
  });

  test('the --key=value spelling survives too, and bare flags are unchanged', async () => {
    const { parseArgv, runPassthroughArgv } = await import('./guild-worker.js');
    const argv = runPassthroughArgv(parseArgv(['run', '--loop', '--sweep-to=owner']));
    expect(argv).toEqual(['--loop', '--sweep-to', 'owner']);
  });

  test('end to end: the loop CLI sees the flag and applies its own gate (needs --auto-withdraw)', async () => {
    const { parseArgv, runPassthroughArgv } = await import('./guild-worker.js');
    const { workerCliMain } = await import('./worker-cli.js');
    const argv = runPassthroughArgv(parseArgv(['run', '--live', '--sweep-to', 'owner']));
    // If the option were dropped, this would NOT throw — it would just start a loop with no sweep.
    await expect(workerCliMain(argv)).rejects.toThrow(/--sweep-to needs --auto-withdraw/);
  });
});
