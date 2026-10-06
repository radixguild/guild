// guild-mcp — a read-only Model Context Protocol server over the Radix Guild
// marketplace. Speaks stdio JSON-RPC (the transport Claude Desktop and other MCP
// clients spawn). It wires the REAL agent-client public reads into the tool set
// defined in tools.ts and does nothing else: no writes, no signing, no secrets
// on the wire.
//
// STDOUT belongs to the JSON-RPC transport — every diagnostic goes to stderr, or
// it would corrupt the protocol stream.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  GuildApiClient,
  fetchGatewayStatus,
  loadConfig,
  readTaskState,
  resolveBadgeLocalId,
  runDoctor,
} from '@radix-guild/agent-client';
import { buildTools, type ToolDeps } from './tools';

export const SERVER_NAME = 'guild-mcp';
export const SERVER_VERSION = '0.3.4';

/** Register every read-only tool on a fresh McpServer (deps injected → testable). */
export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const tool of buildTools(deps)) {
    const meta = { title: tool.title, description: tool.description };
    if (Object.keys(tool.inputSchema).length === 0) {
      // No-parameter tool: omit inputSchema ENTIRELY. The SDK validates incoming
      // arguments against the schema and rejects a MISSING `arguments` field
      // (undefined ≠ object, mcp.js:validateToolInput) — clients and LLMs routinely
      // omit it for no-arg tools — so an empty {} schema would -32602 the very calls
      // it should accept. No schema ⇒ no validation ⇒ a bare { name } call works.
      server.registerTool(tool.name, meta, async () => tool.handler({}));
    } else {
      server.registerTool(
        tool.name,
        { ...meta, inputSchema: tool.inputSchema },
        async (args: Record<string, unknown>) => tool.handler(args)
      );
    }
  }
  return server;
}

/** Production deps: real agent-client reads over the configured mainnet endpoints. */
function realDeps(): ToolDeps {
  const config = loadConfig();
  return {
    client: new GuildApiClient(config),
    config,
    // includeAuth stays false at the tool layer; bind the booted config so the
    // readiness report reflects exactly what this server is pointed at.
    runDoctor: ({ includeAuth }) => runDoctor({ includeAuth, config }),
    fetchGatewayStatus,
    readTaskState,
    resolveBadgeLocalId,
    // process.env: readiness reads this ONLY to scrub sensitive values out of the
    // report (the same env runDoctor derived it from), never to emit anything.
    env: process.env,
  };
}

/**
 * Start the real server on stdio. Called by src/bin.ts (the Node bundle's entry
 * point) and by nothing else: importing this module — as every test does for
 * createServer — must never start a server or touch stdin.
 *
 * This file used to guard `main()` behind `import.meta.main`. That is a bun
 * feature Node grew only in 22.18 / 24.2; under the Node 20 the one-liner
 * targets it is `undefined`, so a bundle built from this file alone imported
 * cleanly, ran nothing, and exited 0 — a silent no-op where a server was
 * expected. The entry is a separate file now (P1, 2026-09-28).
 */
export async function main(): Promise<void> {
  const server = createServer(realDeps());
  await server.connect(new StdioServerTransport());
  // stderr only — stdout is the JSON-RPC channel.
  console.error(
    `${SERVER_NAME} v${SERVER_VERSION} ready on stdio (read-only; ${loadConfig().apiBaseUrl})`
  );
}
