// Offline agent provisioning — turn ONE fleet mnemonic into the per-agent
// account + key for each index. Run it on your machine, never an agent host.
//
//   pbpaste | bun run derive 3            # one agent at index 3
//   pass show guild/fleet | bun run derive 0 1 2   # a batch, from a pw manager
//   bun run derive 3                      # paste the mnemonic, then Ctrl-D
//
// The mnemonic is read from stdin and NEVER written to disk or logged. The
// derived keys ARE printed — run this in a private shell, drop each key into
// that agent's GUILD_AGENT_PRIVATE_KEY, and never commit/log it. Use a FRESH,
// dedicated, capped-balance seed — never the signer/treasury seed.

import { AgentIdentity } from './identity.js';
import { deriveAgentPrivateKeyHex } from './hd.js';
import { validateMnemonic } from 'bip39';

function parseIndices(args: string[]): number[] {
  const indices = args.map(a => Number(a));
  if (indices.length === 0 || indices.some(n => !Number.isInteger(n) || n < 0)) {
    throw new Error('usage: bun run derive <index> [index...]   (non-negative integers)');
  }
  return indices;
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const indices = parseIndices(process.argv.slice(2));
  if (process.stdin.isTTY) process.stderr.write('Paste the fleet mnemonic, then press Ctrl-D:\n');
  const mnemonic = (await readStdin()).trim().replace(/\s+/g, ' ').toLowerCase();
  if (!mnemonic) {
    throw new Error(
      'no mnemonic on stdin.\n' +
        '       Copy your 24 words first, then:  pbpaste | bun run derive 0\n' +
        '       (or run `bun run derive 0`, paste the words, then press Ctrl-D)'
    );
  }
  if (!validateMnemonic(mnemonic)) {
    const words = mnemonic.split(' ');
    const nonAscii = /[^\x20-\x7e]/.test(mnemonic);
    throw new Error(
      `that doesn't look like a valid BIP-39 mnemonic — got ${words.length} word(s) ` +
        '(expected 12/15/18/21/24), and the checksum/wordlist check failed.\n' +
        (nonAscii
          ? '       It contains non-ASCII characters (smart quotes / hidden chars?) — re-copy as plain text.\n'
          : '') +
        '       Also check for numbering ("1. word"), punctuation, or a wrong/missing word.'
    );
  }

  for (const index of indices) {
    const keyHex = deriveAgentPrivateKeyHex(mnemonic, index);
    const { address } = await AgentIdentity.fromPrivateKeyHex(keyHex);
    console.log(`\nagent #${index}`);
    console.log(`  account:                 ${address}`);
    console.log(`  GUILD_AGENT_PRIVATE_KEY: ${keyHex}`);
  }
  console.log("\n⚠  Keys above are SECRET — put each in that agent's env only, never commit/log.");
  console.log(
    '   Then fund (~15 XRD) + mint a Guild Member badge to each account → agent ready.\n'
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`derive failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
