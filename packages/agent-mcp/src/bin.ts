// guild-mcp — the Node entry point. Bundled by `npm run build` (esbuild) into
// dist/guild-mcp.js together with @radix-guild/agent-client, so the tarball
// runs with `npx -y -p <served tarball URL> guild-mcp` on any Node 20+ and needs
// no monorepo, no bun, no `file:` dependency at install time.
//
// Kept separate from server.ts on purpose: server.ts exports createServer for
// the tests (an import must never start a server), and `import.meta.main` —
// the guard it used to rely on — is undefined on Node < 22.18, so a bundle
// built from server.ts alone would print nothing and exit 0 under the very
// runtime the one-liner targets. This file has one job: run main().
//
// No shebang HERE: the build's --banner adds it, and esbuild also preserves a
// source hashbang, so one in both places produced a file whose line 2 was
// `#!/usr/bin/env node` — a SyntaxError under Node (measured 2026-09-28).
import { main, SERVER_NAME } from './server';

main().catch((err) => {
  // stderr only — stdout is the JSON-RPC channel.
  console.error(`${SERVER_NAME} fatal:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
