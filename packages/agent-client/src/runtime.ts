// runtime.ts — the two places this client touches "which runtime am I on".
//
// The published package runs under Node AND Bun (see package.json `exports`:
// Bun resolves the `bun` condition straight to src/*.ts; everything else gets
// dist/*.js). Keeping the runtime seams in one file is what makes that claim
// checkable: `grep -rn 'Bun\.' src` should find nothing outside tests.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when the module at `moduleUrl` (pass `import.meta.url`) is the process
 * entrypoint — i.e. it was invoked directly (`node dist/guild-worker.js`,
 * `bun src/guild-worker.ts`, or via a `bin` symlink), not imported.
 *
 * Why not `import.meta.main`: Node only grew it in 22.18 / 24.2. On anything
 * older it is `undefined`, the guard never fires, and a CLI "runs" by doing
 * nothing and exiting 0 — the worst failure shape for an unattended agent.
 * `realpathSync` on argv[1] is what makes the `bin` symlink case work:
 * node_modules/.bin/guild-worker → ../@radix-guild/agent-client/dist/guild-worker.js.
 */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
