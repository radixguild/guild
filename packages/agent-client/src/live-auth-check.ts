// One-shot LIVE auth check against the real Guild deploy.
//
//   bun run auth:live
//
// Uses GUILD_AGENT_PRIVATE_KEY if set; otherwise generates a THROWAWAY key
// (the only side effect server-side is a harmless user row for the derived
// address). Read-only against the wallet/chain — no funds involved.

import { GuildApiClient } from './api.js';
import { loadAgentPrivateKeyHex } from './config.js';
import { AgentIdentity } from './identity.js';
import { generateThrowawayPrivateKeyHex } from './throwaway-key.js';

async function main(): Promise<void> {
  let keyHex: string;
  let keySource: string;
  try {
    keyHex = loadAgentPrivateKeyHex();
    keySource = 'GUILD_AGENT_PRIVATE_KEY';
  } catch {
    keyHex = generateThrowawayPrivateKeyHex();
    keySource = 'throwaway (not persisted)';
  }

  const identity = await AgentIdentity.fromPrivateKeyHex(keyHex);
  const api = new GuildApiClient();
  console.log(`live-auth: key source = ${keySource}`);
  console.log(`live-auth: agent address = ${identity.address}`);
  console.log(`live-auth: target = ${api.config.apiBaseUrl}`);

  const user = await api.authenticate(identity);
  console.log(`live-auth: OK — server user id = ${user.id}`);

  const me = await api.me();
  console.log(`live-auth: /auth/me round-trip OK (id = ${me.id})`);
}

main().catch((error: unknown) => {
  console.error(`live-auth: FAILED: ${String(error)}`);
  process.exit(1);
});
