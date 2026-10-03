// EXACT-SET assertion on the packed tarball — the agent-client precedent
// (packages/agent-client/src/publish-manifest.test.ts), for the same reason:
// scripts/publish-gate.mjs is a DENYLIST BY CLASS and was measured failing open
// on a file nobody had thought of. This pins the exact set, so any addition or
// removal fails until a human edits the list — the moment someone asks "should
// that ship?".
//
// The tarball is what scripts/pack-kit.sh serves at radixguild.com/kit/mcp.tgz
// (P1, 2026-09-28) and what `npx -y -p <that URL> guild-mcp` installs. Its one
// runnable file is dist/guild-mcp.js: the esbuild bundle of src/bin.ts with
// @radix-guild/agent-client inlined (the `file:` dependency never reaches a
// consumer's `npm install`). The .ts sources ship for reading, not for running.
//
// Requires `bun run build` first, like agent-client's — dist/ is gitignored.

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every file the packed tarball may contain. Sorted.
 *
 * ⚠️ Adding a line here is a PUBLISHING decision. The bundle carries
 * agent-client's public reads; a new file here is public the moment the deploy
 * packs it.
 */
const EXPECTED = [
  'LICENSE',
  'README.md',
  'dist/guild-mcp.js',
  'package.json',
  'src/bin.ts',
  'src/server.ts',
  'src/tools.ts',
];

function packedFiles(): string[] {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: PKG_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const parsed = JSON.parse(out);
  return parsed[0].files.map((f: { path: string }) => f.path).sort();
}

describe('published tarball contents (exact set)', () => {
  const files = packedFiles();

  it('contains exactly the expected files — nothing more, nothing less', () => {
    const added = files.filter((f) => !EXPECTED.includes(f));
    const removed = EXPECTED.filter((f) => !files.includes(f));
    expect({ added, removed }).toEqual({ added: [], removed: [] });
  });

  it('ships the Node bundle the bin points at, and no test or smoke file', () => {
    expect(files).toContain('dist/guild-mcp.js');
    expect(files.some((f) => /\.test\.[cm]?[jt]s$/.test(f))).toBe(false);
    expect(files.some((f) => f.startsWith('smoke/'))).toBe(false);
  });

  it('the bundle is what package.json bin names, with a node shebang', () => {
    const pkg = JSON.parse(execFileSync('cat', [`${PKG_DIR}/package.json`], { encoding: 'utf8' }));
    expect(pkg.bin['guild-mcp']).toBe('./dist/guild-mcp.js');
    // The first line, and ONLY one shebang: a source hashbang plus the build
    // banner once yielded two, and Node rejects a `#!` on line 2 (SyntaxError).
    const head = execFileSync('head', ['-c', '40', `${PKG_DIR}/dist/guild-mcp.js`], { encoding: 'utf8' });
    expect(head.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(head.slice(20).startsWith('#!')).toBe(false);
  });

  it('a consumer install never sees the file: dependency — agent-client is bundled, not depended on', () => {
    const pkg = JSON.parse(execFileSync('cat', [`${PKG_DIR}/package.json`], { encoding: 'utf8' }));
    for (const range of Object.values(pkg.dependencies ?? {})) {
      expect(String(range)).not.toMatch(/^(file|link):/);
    }
    expect(pkg.dependencies['@radix-guild/agent-client']).toBeUndefined();
    // …and what the bundle leaves external IS declared, exactly.
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@modelcontextprotocol/sdk',
      '@radixdlt/radix-engine-toolkit',
      'bip39',
      'zod',
    ]);
  });
});

// ONE VERSION, EVERYWHERE. scripts/kit-version-guard.mjs refuses a changed tarball under an unchanged
// version, so any byte change bumps the version — and the version is written in five places a person
// edits by hand. The agent-client kit stopped making keys in 0.7.0 (ruling 2026-10-03); the MCP
// bundle inlines agent-client, so its bytes changed with it and it moved to 0.3.0. Each spot
// below drifted from the others at some point or could; this pins them together.
describe('the version is the same everywhere it is written', () => {
  const read = (rel: string) => readFileSync(`${PKG_DIR}/${rel}`, 'utf8');
  const version = JSON.parse(read('package.json')).version as string;

  it('is past 0.2.0 — the last MCP kit built before the key-making commands left agent-client', () => {
    const [maj, min] = version.split('.').map(Number);
    expect(maj > 0 || min >= 3).toBe(true);
  });

  it('server.json (the registry entry and its package), SERVER_VERSION and the pinned URLs in the README all agree', () => {
    const server = JSON.parse(read('server.json'));
    expect(server.version).toBe(version);
    expect(server.packages[0].version).toBe(version);
    expect(read('src/server.ts')).toContain(`export const SERVER_VERSION = '${version}';`);
    const pinned = [...read('README.md').matchAll(/kit\/mcp-(\d+\.\d+\.\d+)\.tgz/g)].map((m) => m[1]);
    expect(pinned.length).toBeGreaterThan(0);
    expect([...new Set(pinned)]).toEqual([version]);
  });
});
