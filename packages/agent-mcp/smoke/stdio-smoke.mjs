#!/usr/bin/env node
// stdio-smoke.mjs — prove the built server speaks MCP over stdio under NODE.
//
//   node smoke/stdio-smoke.mjs                                    # spawns: node dist/guild-mcp.js
//   node smoke/stdio-smoke.mjs -- npx -y -p http://127.0.0.1:8766/mcp.tgz guild-mcp
//
// Uses the real MCP client and the real stdio transport from the SDK: spawn the
// command, initialize, list tools, assert the eight read-only tools are there,
// close. No network beyond what the command itself does (tools/list makes no
// Gateway or API call). Exit 0 = the server answered; anything else exits 1 with
// the reason on stderr.
//
// Why a Node smoke and not only `bun test`: the tests drive createServer() over
// an in-memory transport under bun. The thing a person actually runs is a Node
// process reading stdin — a bundle that imports fine but never reaches main(),
// or one whose stdout is polluted by a stray console.log, passes every bun test
// and fails here. This is the check that sees that class.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const EXPECTED_TOOLS = [
  'escrow_config',
  'gateway_status',
  'get_task',
  'list_tasks',
  'readiness',
  'resolve_badge',
  'task_chain_state',
  'task_stats',
];

const sep = process.argv.indexOf('--');
const cmd = sep === -1 ? ['node', 'dist/guild-mcp.js'] : process.argv.slice(sep + 1);
if (cmd.length === 0) {
  console.error('stdio-smoke: nothing to spawn after --');
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: cmd[0],
  args: cmd.slice(1),
  // Inherit stderr so the server's own banner/diagnostics show in the CI log;
  // stdout stays the protocol channel the transport owns.
  stderr: 'inherit',
  env: { ...process.env },
});
const client = new Client({ name: 'stdio-smoke', version: '0.0.0' });

const timer = setTimeout(() => {
  console.error('stdio-smoke: no answer within 90s — the server never completed the MCP handshake');
  process.exit(1);
}, 90_000);

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !EXPECTED_TOOLS.includes(n));
  if (missing.length || extra.length) {
    console.error(`stdio-smoke: tool set differs — missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)}`);
    process.exit(1);
  }
  // One call that needs no network: escrow_config echoes the pinned public params.
  const res = await client.callTool({ name: 'escrow_config' });
  if (res.isError) {
    console.error('stdio-smoke: escrow_config returned isError');
    process.exit(1);
  }
  const text = res.content?.[0]?.text ?? '';
  const parsed = JSON.parse(text);
  if (typeof parsed.escrowComponent !== 'string' || !parsed.escrowComponent.startsWith('component_rdx1')) {
    console.error(`stdio-smoke: escrow_config did not return an escrow component: ${text.slice(0, 120)}`);
    process.exit(1);
  }
  console.log(`stdio-smoke ok: ${names.length} tools over stdio via [${cmd.join(' ')}], escrow ${parsed.escrowComponent.slice(0, 24)}…`);
} catch (err) {
  console.error('stdio-smoke: failed —', err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  clearTimeout(timer);
  await client.close().catch(() => {});
}
