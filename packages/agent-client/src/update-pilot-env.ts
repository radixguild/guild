// update-pilot-env — derive the pilot pair (worker=index 0, poster=index 1) from a
// fleet mnemonic and rewrite .env.guild-pilot in place. One paste, zero hand-editing.
//
//   bun run update-pilot-env          # paste the 24 words, then Ctrl-D
//   pbpaste | bun run update-pilot-env
//
// The mnemonic is read from stdin and NEVER written to disk or logged (same contract
// as `derive`). The previous env file is preserved as .env.guild-pilot.bak-<date>
// (mode 600) — the OLD keys still control the old accounts until their balances are
// swept, so the backup is load-bearing, not clutter. Prints ONLY the new addresses.

import { writeFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateMnemonic } from 'bip39';
import { AgentIdentity } from './identity.js';
import { deriveAgentPrivateKeyHex } from './hd.js';

const ENV_PATH = process.env.GUILD_PILOT_ENV_PATH
  ?? resolve(import.meta.dir, '../../../.env.guild-pilot');

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8').trim();
}

const mnemonic = (await readStdin()).replace(/\s+/g, ' ');
if (!validateMnemonic(mnemonic)) {
  console.error('update-pilot-env: that is not a valid BIP-39 mnemonic (24 words, single spaces). Nothing written.');
  process.exit(1);
}

const [workerKey, posterKey] = [deriveAgentPrivateKeyHex(mnemonic, 0), deriveAgentPrivateKeyHex(mnemonic, 1)];
const worker = await AgentIdentity.fromPrivateKeyHex(workerKey);
const posterId = await AgentIdentity.fromPrivateKeyHex(posterKey);

if (existsSync(ENV_PATH)) {
  const stamp = new Date().toISOString().slice(0, 10);
  const bak = `${ENV_PATH}.bak-${stamp}`;
  copyFileSync(ENV_PATH, bak);
  chmodSync(bak, 0o600);
  console.error(`update-pilot-env: previous file preserved at ${bak} (old keys still control old balances until swept)`);
}

const body = `# Guild pilot agent keys — mnemonic-derived fleet (CAP-26 m/44'/1022'/1'/525'/1460'/N').
# Rotated ${new Date().toISOString().slice(0, 10)} from the 2026-06-10 raw pair per the key-rotation
# directive. Recovery = the fleet mnemonic (console vault + bigdev offline backup).
# CAPPED BALANCES ONLY. worker = index 0, poster = index 1.
GUILD_AGENT_1_ADDRESS=${worker.address}
GUILD_AGENT_1_PRIVATE_KEY=${workerKey}
GUILD_AGENT_2_ADDRESS=${posterId.address}
GUILD_AGENT_2_PRIVATE_KEY=${posterKey}
`;
writeFileSync(ENV_PATH, body, { mode: 0o600 });
chmodSync(ENV_PATH, 0o600);

console.error('update-pilot-env: wrote ' + ENV_PATH);
console.log('worker (index 0): ' + worker.address);
console.log('poster (index 1): ' + posterId.address);
