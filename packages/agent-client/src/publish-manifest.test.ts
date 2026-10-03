// EXACT-SET assertion on the published tarball.
//
// WHY THIS EXISTS AND WHY IT IS NOT scripts/publish-gate.mjs. That gate is a
// DENYLIST BY CLASS: it rejects test files, lockfiles, key material, the intents
// journal, and four named operator CLIs. It therefore only ever catches shapes
// somebody already thought of — and it was measured failing open: dropping a new
// `src/rotate-fleet-keys.ts` that reads GUILD_AGENT_PRIVATE_KEY took the tarball
// from 20 files to 21 and the gate returned exit 0. The `files` allowlist does
// not save it either, because `src/**/*.ts` globs in anything new by design.
//
// So this test pins the EXACT set. Any addition or removal fails until a human
// edits the list, which is the moment somebody has to ask "should that ship?".
// That is the whole mechanism: it converts a fails-open control into a
// fails-closed one, and it costs one line of maintenance per intentional change.
//
// It lives in src/ deliberately. The plan of record publishes an EXTRACTED repo,
// and a guard sitting in the monorepo's scripts/ does not travel with it — this
// one does. It is excluded from the tarball itself by the `!src/**/*.test.ts`
// rule, so it protects the package without shipping in it.

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every file the published tarball may contain. Sorted.
 *
 * ⚠️ Adding a line here is a PUBLISHING decision, not a formality. Ask: does a
 * third-party integrator need this file, and does it contain anything about the
 * operator, their infrastructure, or their wallets? The last audit of this
 * package found 25 kB of live mainnet transaction hashes shipping unnoticed.
 */
const EXPECTED = [
  'LICENSE',
  'README.md',
  'dist/agent-run.d.ts',
  'dist/agent-run.d.ts.map',
  'dist/agent-run.js',
  'dist/agent-run.js.map',
  'dist/agent-rules.d.ts',
  'dist/agent-rules.d.ts.map',
  'dist/agent-rules.js',
  'dist/agent-rules.js.map',
  'dist/agent-state.d.ts',
  'dist/agent-state.d.ts.map',
  'dist/agent-state.js',
  'dist/agent-state.js.map',
  'dist/api.d.ts',
  'dist/api.d.ts.map',
  'dist/api.js',
  'dist/api.js.map',
  'dist/bytes.d.ts',
  'dist/bytes.d.ts.map',
  'dist/bytes.js',
  'dist/bytes.js.map',
  'dist/claim-gate.d.ts',
  'dist/claim-gate.d.ts.map',
  'dist/claim-gate.js',
  'dist/claim-gate.js.map',
  'dist/claim-quota.d.ts',
  'dist/claim-quota.d.ts.map',
  'dist/claim-quota.js',
  'dist/claim-quota.js.map',
  'dist/config.d.ts',
  'dist/config.d.ts.map',
  'dist/config.js',
  'dist/config.js.map',
  'dist/dispute.d.ts',
  'dist/dispute.d.ts.map',
  'dist/dispute.js',
  'dist/dispute.js.map',
  'dist/doctor.d.ts',
  'dist/doctor.d.ts.map',
  'dist/doctor.js',
  'dist/doctor.js.map',
  'dist/evidence.d.ts',
  'dist/evidence.d.ts.map',
  'dist/evidence.js',
  'dist/evidence.js.map',
  'dist/gateway.d.ts',
  'dist/gateway.d.ts.map',
  'dist/gateway.js',
  'dist/gateway.js.map',
  'dist/guild-agent.d.ts',
  'dist/guild-agent.d.ts.map',
  'dist/guild-agent.js',
  'dist/guild-agent.js.map',
  'dist/guild-poster.d.ts',
  'dist/guild-poster.d.ts.map',
  'dist/guild-poster.js',
  'dist/guild-poster.js.map',
  'dist/guild-worker.d.ts',
  'dist/guild-worker.d.ts.map',
  'dist/guild-worker.js',
  'dist/guild-worker.js.map',
  'dist/hd.d.ts',
  'dist/hd.d.ts.map',
  'dist/hd.js',
  'dist/hd.js.map',
  'dist/identity.d.ts',
  'dist/identity.d.ts.map',
  'dist/identity.js',
  'dist/identity.js.map',
  'dist/index.d.ts',
  'dist/index.d.ts.map',
  'dist/index.js',
  'dist/index.js.map',
  'dist/key-file.d.ts',
  'dist/key-file.d.ts.map',
  'dist/key-file.js',
  'dist/key-file.js.map',
  'dist/kit-release.d.ts',
  'dist/kit-release.d.ts.map',
  'dist/kit-release.js',
  'dist/kit-release.js.map',
  'dist/manifests.d.ts',
  'dist/manifests.d.ts.map',
  'dist/manifests.js',
  'dist/manifests.js.map',
  'dist/mint.d.ts',
  'dist/mint.d.ts.map',
  'dist/mint.js',
  'dist/mint.js.map',
  'dist/onboard.d.ts',
  'dist/onboard.d.ts.map',
  'dist/onboard.js',
  'dist/onboard.js.map',
  'dist/rola.d.ts',
  'dist/rola.d.ts.map',
  'dist/rola.js',
  'dist/rola.js.map',
  'dist/run-lock.d.ts',
  'dist/run-lock.d.ts.map',
  'dist/run-lock.js',
  'dist/run-lock.js.map',
  'dist/runtime.d.ts',
  'dist/runtime.d.ts.map',
  'dist/runtime.js',
  'dist/runtime.js.map',
  'dist/scrub-guard.d.ts',
  'dist/scrub-guard.d.ts.map',
  'dist/scrub-guard.js',
  'dist/scrub-guard.js.map',
  'dist/secrets.d.ts',
  'dist/secrets.d.ts.map',
  'dist/secrets.js',
  'dist/secrets.js.map',
  'dist/sweep.d.ts',
  'dist/sweep.d.ts.map',
  'dist/sweep.js',
  'dist/sweep.js.map',
  'dist/tx.d.ts',
  'dist/tx.d.ts.map',
  'dist/tx.js',
  'dist/tx.js.map',
  'dist/worker-cli.d.ts',
  'dist/worker-cli.d.ts.map',
  'dist/worker-cli.js',
  'dist/worker-cli.js.map',
  'dist/withdraw.d.ts',
  'dist/withdraw.d.ts.map',
  'dist/withdraw.js',
  'dist/withdraw.js.map',
  'dist/work-brief.d.ts',
  'dist/work-brief.d.ts.map',
  'dist/work-brief.js',
  'dist/work-brief.js.map',
  'dist/worker.d.ts',
  'dist/worker.d.ts.map',
  'dist/worker.js',
  'dist/worker.js.map',
  'package.json',
  'src/agent-run.ts',
  'src/agent-rules.ts',
  'src/agent-state.ts',
  'src/api.ts',
  'src/bytes.ts',
  'src/claim-gate.ts',
  'src/claim-quota.ts',
  'src/config.ts',
  'src/dispute.ts',
  'src/doctor.ts',
  'src/evidence.ts',
  'src/gateway.ts',
  'src/guild-agent.ts',
  'src/guild-poster.ts',
  'src/guild-worker.ts',
  'src/hd.ts',
  'src/identity.ts',
  'src/index.ts',
  'src/key-file.ts',
  'src/kit-release.ts',
  'src/manifests.ts',
  'src/mint.ts',
  'src/onboard.ts',
  'src/rola.ts',
  'src/run-lock.ts',
  'src/runtime.ts',
  'src/scrub-guard.ts',
  'src/secrets.ts',
  'src/sweep.ts',
  'src/tx.ts',
  'src/withdraw.ts',
  'src/work-brief.ts',
  'src/worker-cli.ts',
  'src/worker.ts',
].sort();

function packedFiles(): string[] {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: PKG_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(out)[0].files.map((f: { path: string }) => f.path).sort();
}

describe('published tarball contents', () => {
  // dist/ is a BUILD ARTIFACT and is gitignored, so on a fresh checkout it does not
  // exist and every dist/ line below reads as "removed" — 72 confusing failures whose
  // real cause is one missing command. Say that instead. (CI builds before it tests
  // for the same reason; that ordering is asserted in .github/workflows/test.yml.)
  function assertBuilt(actual: string[]): void {
    const wantsDist = EXPECTED.some((f) => f.startsWith('dist/'));
    const hasDist = actual.some((f) => f.startsWith('dist/'));
    if (wantsDist && !hasDist) {
      throw new Error(
        'dist/ is missing from the packed tarball — run `bun run build` first. ' +
          'This test pins the PUBLISHED file set, and the published set includes the ' +
          'built output; it is not a source-only assertion.'
      );
    }
  }

  it('matches the pinned exact set — nothing added, nothing dropped', () => {
    const actual = packedFiles();
    assertBuilt(actual);
    const added = actual.filter((f) => !EXPECTED.includes(f));
    const removed = EXPECTED.filter((f) => !actual.includes(f));

    // Reported separately: an ADDED file is a possible leak, a REMOVED file is a
    // broken package. Same assertion, very different remedies.
    expect({ added, removed }).toEqual({ added: [], removed: [] });
  });

  it('ships dist/ only as .js/.d.ts/.map twins of files that are themselves allowed', () => {
    // dist/ is a BUILD ARTIFACT (tsconfig.build.json), so a leak there would be
    // a leak of a source file the build config failed to exclude. Every dist
    // file must therefore correspond to an allowed src/*.ts — which is exactly
    // the property that keeps `!src/throwaway-key.ts` meaningful once a `.js` twin
    // exists (publish-gate's operator-CLI rule is extended to [cm]?[jt]s too).
    const srcAllowed = new Set(EXPECTED.filter((f) => f.startsWith('src/')).map((f) => f.slice(4, -3)));
    const distStems = EXPECTED.filter((f) => f.startsWith('dist/')).map((f) =>
      f.slice(5).replace(/\.(d\.ts\.map|d\.ts|js\.map|js)$/, '')
    );
    const orphans = [...new Set(distStems)].filter((stem) => !srcAllowed.has(stem));
    expect(orphans).toEqual([]);
  });

  it('ships no test file, and this list is the reason', () => {
    expect(EXPECTED.filter((f) => f.includes('.test.'))).toEqual([]);
  });

  it('carries a licence — without one the package is unusable by an integrator', () => {
    expect(EXPECTED).toContain('LICENSE');
  });
});
