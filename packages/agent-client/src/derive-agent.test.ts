// derive-agent CLI — the offline fleet-mnemonic → per-agent key entry point.
// It runs main() at import with no import.meta.main guard and keeps its helpers
// module-private, so we pin its behaviour through the CLI contract itself:
// spawn the script as a subprocess, feed the mnemonic on stdin + indices on
// argv, and assert stdout/stderr/exit codes. This also lets us prove the
// security-critical guarantee — the secret mnemonic must NEVER surface in any
// captured output — against the real process, not a stubbed helper.

import { describe, test, expect } from 'bun:test';
import { deriveAgentPrivateKeyHex } from './hd.js';
import { AgentIdentity } from './identity.js';

// BIP-39 zero test vector — PUBLIC, never a real wallet. Same anchor as hd.test.ts.
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const SCRIPT = `${import.meta.dir}/derive-agent.ts`;

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runDerive(args: string[], stdin: string): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe('derive-agent CLI — index parsing', () => {
  test('rejects empty args (no index) with the usage message', async () => {
    const { stderr, exitCode } = await runDerive([], '');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('non-negative integers');
  });

  test('rejects a negative index', async () => {
    const { stderr, exitCode } = await runDerive(['-1'], '');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('non-negative integers');
  });

  test('rejects a non-integer index', async () => {
    const { stderr, exitCode } = await runDerive(['1.5'], '');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('non-negative integers');
  });

  test('rejects a non-numeric index', async () => {
    const { stderr, exitCode } = await runDerive(['abc'], '');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('non-negative integers');
  });
});

describe('derive-agent CLI — mnemonic handling', () => {
  test('rejects an invalid mnemonic via the validateMnemonic path', async () => {
    const { stderr, exitCode } = await runDerive(['0'], 'not a valid bip39 mnemonic phrase at all');
    expect(exitCode).toBe(1);
    expect(stderr).toContain("that doesn't look like a valid BIP-39 mnemonic");
  });

  test('rejects an empty mnemonic on stdin', async () => {
    const { stderr, exitCode } = await runDerive(['0'], '   \n');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('no mnemonic on stdin');
  });

  test('valid mnemonic + index yields the deterministic key/address from hd.ts', async () => {
    const expectedKey = deriveAgentPrivateKeyHex(TEST_MNEMONIC, 3);
    const { address: expectedAddress } = await AgentIdentity.fromPrivateKeyHex(expectedKey);

    const { stdout, exitCode } = await runDerive(['3'], TEST_MNEMONIC);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('agent #3');
    expect(stdout).toContain(expectedKey);
    expect(stdout).toContain(expectedAddress);
  });

  test('derives a batch of indices in one invocation', async () => {
    const { stdout, exitCode } = await runDerive(['0', '1'], TEST_MNEMONIC);
    expect(exitCode).toBe(0);
    for (const index of [0, 1]) {
      expect(stdout).toContain(`agent #${index}`);
      expect(stdout).toContain(deriveAgentPrivateKeyHex(TEST_MNEMONIC, index));
    }
  });
});

describe('derive-agent CLI — never-log-the-mnemonic guarantee', () => {
  test('the secret mnemonic never appears in stdout or stderr', async () => {
    const { stdout, stderr } = await runDerive(['0'], TEST_MNEMONIC);
    expect(stdout).not.toContain(TEST_MNEMONIC);
    expect(stderr).not.toContain(TEST_MNEMONIC);
  });

  test('an invalid mnemonic is not echoed back in the error output', async () => {
    const secretish = 'zzz totally invalid phrase that must not be echoed zzz';
    const { stdout, stderr } = await runDerive(['0'], secretish);
    expect(stdout).not.toContain(secretish);
    expect(stderr).not.toContain(secretish);
  });
});
