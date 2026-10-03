// The kit never creates a key. Agents are badge-first (ruling 2026-10-03): a developer BRINGS
// their own key (GUILD_AGENT_KEY_FILE or GUILD_AGENT_PRIVATE_KEY), mints a badge for it and acts
// as that badge; funding is only ever their own wallet transaction. Until then `guild-agent join`
// made a key and wrote it to ~/.radix-guild/agent.key, `join --new-key` rotated it,
// `guild-worker onboard --generate` printed one and `new-seed` printed a 24-word seed.
//
// This file is the guard that fails if any of that comes back. It is the "never prints the key"
// test pattern (guild-agent.test.ts, secrets.test.ts) turned the other way round: not "a key we
// hold does not leak" but "no command path MAKES, WRITES or PRINTS a key at all". Three layers,
// because each alone has a way to rot:
//
//   1. STATIC — the files that ship contain no key-making primitive, and the only shipped files
//      that write to disk are the four that were reviewed as not touching key material. A new
//      writer, or a new generator, fails here until a human edits the list below.
//   2. DYNAMIC — every command path that can run offline is driven end to end in a world with
//      an empty key directory, the network trapped and the console captured. Afterwards the key
//      directory must still be empty and no output line may contain a key-shaped (64-hex) string.
//      A reintroduced `join` that generates a key fails here whatever it is called or wired to.
//   3. SURFACE — the package's public exports and its package.json (bin, scripts, files,
//      version) carry no key maker, and the version is past the last kit that had one (0.6.1).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REDACTED, _resetSecretsForTests } from './secrets.js';
import { main as agentMain, type MainDeps as AgentMainDeps } from './guild-agent.js';
import { main as workerMain } from './guild-worker.js';
import { main as posterMain } from './guild-poster.js';
import { runOnboard } from './onboard.js';
import { loadConfig, loadAgentPrivateKeyHex } from './config.js';
import { KEY_FILE_ENV } from './key-file.js';
import * as kit from './index.js';
import { generateThrowawayPrivateKeyHex } from './throwaway-key.js';

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'account_rdx12y5senkxfxg38swfv4tg88lx73jqnkdvcnzv8kwwdmg0efl40r2p7u';

/** A 64-hex run — what a 32-byte ed25519 private key looks like in any output. */
const KEY_SHAPED = /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/;

// ── 1. STATIC ────────────────────────────────────────────────────────────────

function packedFiles(): string[] {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: PKG_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(out)[0].files.map((f: { path: string }) => f.path).sort();
}

const shippedSources = packedFiles()
  .filter(f => /^src\/[^/]+\.ts$/.test(f))
  .map(f => f.slice('src/'.length));

/** A shipped file's code, without comments (a comment that NAMES a maker is not one). `://` is left alone. */
function code(file: string): string {
  return readFileSync(join(PKG_DIR, 'src', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(?<!:)\/\/.*$/gm, '');
}

/**
 * A primitive that makes or stores a key or seed. `generateRandomNonce` (a transaction nonce,
 * from the Radix Engine Toolkit) is not one, and does not match.
 */
const KEY_MAKING: Array<[string, RegExp]> = [
  ['a random-byte source', /\b(getRandomValues|randomBytes|randomFill(Sync)?|randomInt|randomUUID|randomPrivateKey|randomSecretKey|keygen)\b/],
  ['a key-pair generator', /\b(generateKeyPair(Sync)?|generateKey)\b|subtle\.generateKey/],
  ['a mnemonic generator', /\bgenerateMnemonic\b/],
  ['the old key writer / generator / rotator', /\b(writeKeyFile|KeyFileExistsError|generateThrowawayPrivateKeyHex|generateKeyHex|rotateAgentKey)\b/],
];

/** Shipped files that write to disk. Each was read and writes no key: state, stop file, run lock, claim quota, journal. */
const REVIEWED_WRITERS = ['agent-state.ts', 'claim-quota.ts', 'run-lock.ts', 'worker.ts'];
const FS_WRITE = /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile|renameSync|rename|linkSync|symlinkSync|openSync|truncateSync|cpSync)\b/;

describe('static: what ships', () => {
  test('the packed source set was found (guards against a listing that matches nothing)', () => {
    expect(shippedSources.length).toBeGreaterThan(30);
    expect(shippedSources).toContain('guild-agent.ts');
    expect(shippedSources).toContain('key-file.ts');
  });

  test('the generator and the old pairing commands are not in the tarball, source or built', () => {
    const files = packedFiles();
    for (const gone of ['throwaway-key', 'new-seed', 'join', 'rotate-key']) {
      expect(files.filter(f => new RegExp(`(^|/)${gone}\\.`).test(f)), gone).toEqual([]);
    }
  });

  for (const [what, re] of KEY_MAKING) {
    test(`no shipped source contains ${what}`, () => {
      expect(shippedSources.filter(f => re.test(code(f)))).toEqual([]);
    });
  }

  test('the only shipped files that write to disk are the reviewed ones — a new writer needs a human to add it here', () => {
    const writers = shippedSources.filter(f => FS_WRITE.test(code(f)));
    expect(writers.sort()).toEqual([...REVIEWED_WRITERS].sort());
  });

  test('key-file.ts only reads: no write call, no mkdir, no chmod', () => {
    const src = code('key-file.ts');
    expect(FS_WRITE.test(src)).toBe(false);
    expect(/\b(mkdirSync|chmodSync|mkdir|chmod)\b/.test(src)).toBe(false);
  });

  test('a known key maker IS caught (the patterns are not vacuous)', () => {
    const planted = [
      'crypto.getRandomValues(new Uint8Array(32))',
      "import { generateMnemonic } from 'bip39'",
      "writeKeyFile(path, hex)",
      "import { randomBytes } from 'node:crypto'",
      'const sk = ed25519.utils.randomPrivateKey()',
      'const sk = ed25519.utils.randomSecretKey()',
      'const { secretKey } = ed25519.keygen()',
      'await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign"])',
    ];
    for (const line of planted) expect(KEY_MAKING.some(([, re]) => re.test(line)), line).toBe(true);
    expect(KEY_MAKING.some(([, re]) => re.test('nonce: generateRandomNonce()'))).toBe(false);
  });
});

// ── 2. DYNAMIC ───────────────────────────────────────────────────────────────

describe('dynamic: no command path makes, writes or prints a key', () => {
  let home: string; // a fresh HOME, so the default ~/.radix-guild is observable
  let keyDir: string; // where GUILD_AGENT_KEY_FILE points: does not exist yet
  let netCalls: string[];
  const realFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};
  const SAVED_VARS = ['HOME', 'USERPROFILE', KEY_FILE_ENV, 'GUILD_AGENT_PRIVATE_KEY', 'POSTER_PRIVATE_KEY', 'GUILD_OWNER_ACCOUNT'];

  beforeAll(() => {
    for (const k of SAVED_VARS) saved[k] = process.env[k];
  });
  afterAll(() => {
    for (const k of SAVED_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    globalThis.fetch = realFetch;
  });

  beforeEach(() => {
    _resetSecretsForTests();
    home = mkdtempSync(join(tmpdir(), 'guild-nokey-home-'));
    keyDir = join(mkdtempSync(join(tmpdir(), 'guild-nokey-dir-')), 'nested');
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env[KEY_FILE_ENV] = join(keyDir, 'agent.key');
    delete process.env.GUILD_AGENT_PRIVATE_KEY;
    delete process.env.POSTER_PRIVATE_KEY;
    delete process.env.GUILD_OWNER_ACCOUNT;
    netCalls = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      netCalls.push(String(input));
      throw new Error('network is trapped in this test');
    }) as typeof fetch;
  });

  /** Everything a command path could have printed, through console.* and the injected loggers. */
  async function capture(run: () => Promise<unknown>): Promise<{ text: string; result: unknown }> {
    const lines: string[] = [];
    const real = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    const sink = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
    console.log = console.error = console.warn = console.info = sink;
    try {
      const result = await run();
      return { text: lines.join('\n'), result };
    } finally {
      Object.assign(console, real);
    }
  }

  /** Nothing was created: not the configured key dir, not the default ~/.radix-guild under the temp HOME. */
  function expectNoKeyWritten(): void {
    expect(existsSync(keyDir), `${keyDir} was created`).toBe(false);
    expect(existsSync(join(home, '.radix-guild')), '~/.radix-guild was created').toBe(false);
    expect(readdirSync(home), 'files appeared in HOME').toEqual([]);
  }

  function expectNoKeyPrinted(text: string): void {
    expect(text).not.toMatch(KEY_SHAPED);
  }

  /** guild-agent deps that can never reach the network or a real loop — only the CLI's own logic runs. */
  function agentDeps(overrides: Partial<AgentMainDeps> = {}): { d: Partial<AgentMainDeps>; out: string[] } {
    const out: string[] = [];
    const d: Partial<AgentMainDeps> = {
      env: { ...process.env } as Record<string, string | undefined>,
      requestStop: () => {
        throw new Error('stop file written');
      },
      runDoctor: async () => ({ checks: [], verdict: 'not-ready', lane: 'unbadged', address: null }),
      createApi: () => {
        throw new Error('the Guild API was called');
      },
      sweepToOwner: async () => {
        throw new Error('a sweep was attempted');
      },
      log: l => out.push(l),
      error: l => out.push(l),
      ...overrides,
    };
    return { d, out };
  }

  const AGENT_PATHS: string[][] = [
    [],
    ['help'],
    ['--help'],
    ['join'],
    ['join', '--code', '7KQ4-M2XZ'],
    ['join', '--code=7KQ4-M2XZ'],
    ['join', '--new-key'],
    ['join', '--new-key', '--code', '7KQ4-M2XZ'],
    ['status'],
    ['status', '--json'],
    ['sweep'],
    ['sweep', '--live', '--all', '--force'],
    ['run'],
    ['dance'],
  ];

  for (const argv of AGENT_PATHS) {
    test(`guild-agent ${argv.join(' ') || '(no args)'} — no key file, no key in the output, no network`, async () => {
      const { d, out } = agentDeps();
      const { text } = await capture(async () => agentMain(argv, d));
      expectNoKeyWritten();
      expectNoKeyPrinted([text, ...out].join('\n'));
      expect(netCalls).toEqual([]);
    });
  }

  test('guild-agent stop — the one verb that writes a file writes the STOP file, never a key (its seam is faked here)', async () => {
    const paths: string[] = [];
    const { d, out } = agentDeps({ requestStop: p => void paths.push(p) });
    const { text } = await capture(async () => agentMain(['stop'], d));
    expect(paths).toEqual([join(keyDir, 'stop')]);
    expectNoKeyPrinted([text, ...out].join('\n'));
    expectNoKeyWritten();
  });

  test('guild-agent status with a key the developer brought (env, then file): it is read and never echoed, and nothing is written', async () => {
    const brought = generateThrowawayPrivateKeyHex();
    for (const env of [{ GUILD_AGENT_PRIVATE_KEY: brought }, null]) {
      const { d, out } = agentDeps({
        env: (env ?? { [KEY_FILE_ENV]: process.env[KEY_FILE_ENV] }) as Record<string, string | undefined>,
        // the doctor report itself tries to leak the key — status must scrub it
        runDoctor: async () => ({ checks: [{ id: 'key', label: 'key', status: 'pass', detail: `env says ${brought}` }], verdict: 'ready', lane: 'unbadged', address: 'account_rdx1x' }),
        createApi: () => ({
          authenticate: async () => ({ id: 'x' }) as never,
          agentMe: async () => {
            throw new kit.GuildApiError(kit.PAIRING_ERROR_CODES.notPaired, 'no row', 404);
          },
        }),
      });
      if (!env) {
        // the file variant: the TEST puts the developer's key where the kit looks for it
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(keyDir, { recursive: true });
        writeFileSync(process.env[KEY_FILE_ENV]!, `${brought}\n`, { mode: 0o600 });
        expect(loadAgentPrivateKeyHex(d.env!)).toBe(brought);
      }
      const { text } = await capture(async () => agentMain(['status', '--json'], d));
      const all = [text, ...out].join('\n');
      expect(all).not.toContain(brought);
      expect(all).toContain(REDACTED);
      expectNoKeyPrinted(all);
      if (!env) expect(readdirSync(keyDir)).toEqual(['agent.key']); // the developer's file, untouched and alone
    }
  });

  const WORKER_PATHS: string[][] = [
    ['onboard'],
    ['onboard', '--generate'],
    ['onboard', '--generate', '--live', '--username', 'newbie'],
    ['help'],
    ['mint-badge'], // no --username → usage error, offline
    ['sweep'], // no key, no owner → refused offline
  ];

  for (const argv of WORKER_PATHS) {
    test(`guild-worker ${argv.join(' ')} — no key made, none printed, nothing written`, async () => {
      const { text, result } = await capture(async () => workerMain(argv));
      expectNoKeyWritten();
      expectNoKeyPrinted(text);
      if (argv.includes('--generate')) {
        expect(result).toBe(2); // refused, not accepted-and-ignored
        expect(text).toContain('onboard --generate is gone');
      }
    });
  }

  test('guild-worker onboard with no key explains how to bring one and offers no maker', async () => {
    const { text } = await capture(async () => workerMain(['onboard']));
    expect(text).toContain('never creates a key');
    expect(text).toContain('GUILD_AGENT_PRIVATE_KEY');
    for (const gone of ['--generate', 'new-seed', 'guild-agent join']) expect(text).not.toContain(gone);
  });

  test('runOnboard with no key and a stray generate option makes nothing (an old caller cannot resurrect it)', async () => {
    const lines: string[] = [];
    const outcome = await runOnboard({ config: loadConfig(), env: {}, log: l => lines.push(l), generate: true } as never);
    expect(outcome.ok).toBe(false);
    expect(outcome.address).toBeNull();
    expectNoKeyPrinted(lines.join('\n'));
    expectNoKeyWritten();
  });

  test('guild-poster help — no key, nothing written', async () => {
    const { text } = await capture(async () => posterMain(['help'], { identity: null } as never));
    expectNoKeyWritten();
    expectNoKeyPrinted(text);
  });

  test('the owner link the kit prints is an account address, not a key (OWNER sanity for the key-shaped check)', () => {
    expect(OWNER).not.toMatch(KEY_SHAPED);
  });

  test('the key-shaped check is not vacuous: it flags a hex key and passes an address', () => {
    expect(`GUILD_AGENT_PRIVATE_KEY=${generateThrowawayPrivateKeyHex()}`).toMatch(KEY_SHAPED);
    expect(OWNER).not.toMatch(KEY_SHAPED);
  });
});

// ── 3. SURFACE ───────────────────────────────────────────────────────────────

describe('surface: exports and package.json', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
    version: string;
    bin: Record<string, string>;
    scripts: Record<string, string>;
    files: string[];
  };

  test('the public exports carry no key maker, writer or rotator', () => {
    const makers = Object.keys(kit).filter(k => /generate|writeKey|rotateAgent|newSeed|throwaway|runJoin/i.test(k));
    expect(makers).toEqual([]);
    // what the kit still exports for KEYS is read-only: load, resolve, read, derive-from-YOUR-seed, sign
    for (const kept of ['AgentIdentity', 'loadAgentPrivateKeyHex', 'readKeyFile', 'resolveKeyFilePath', 'deriveAgentPrivateKeyHex']) {
      expect(Object.keys(kit)).toContain(kept);
    }
  });

  test('no package script or bin is a key maker', () => {
    expect(Object.keys(pkg.bin).sort()).toEqual(['guild-agent', 'guild-poster', 'guild-worker']);
    expect(pkg.scripts['new-seed']).toBeUndefined();
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      expect(`${name}: ${cmd}`, name).not.toMatch(/new-seed|--generate|throwaway-key/);
    }
  });

  test('the key generator is excluded from the tarball and from the build, in package.json and tsconfig.build.json', () => {
    expect(pkg.files).toContain('!src/throwaway-key.ts');
    const build = readFileSync(join(PKG_DIR, 'tsconfig.build.json'), 'utf8');
    expect(build).toContain('src/throwaway-key.ts');
  });

  test('the version is past the last kit that made keys (0.6.1 and every 0.6.x before it served the old join)', () => {
    const [maj, min] = pkg.version.split('.').map(Number);
    expect(maj > 0 || min >= 7, `${pkg.version} would pass the kit-version guard as a "patch" of a key-making kit`).toBe(true);
  });
});
