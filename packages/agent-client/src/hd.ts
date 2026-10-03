// HD agent-key derivation — one BIP-39 mnemonic → a whole fleet of Radix agent
// accounts by index, using the Radix wallet's CAP-26 path
// m/44'/1022'/1'/525'/1460'/<index>' over SLIP-10 Ed25519 (checked byte for
// byte against an independent implementation; hd.test.ts pins a known answer). Because it matches
// the path the Radix wallet uses, every derived account shows up in a mobile
// wallet loaded with the same seed — so you can fund/monitor the fleet there.
//
// SECURITY — the mnemonic is the WHOLE fleet's secret. Prefer deriving OFFLINE
// (`bun run derive <index>`) and putting only the per-agent derived key
// (GUILD_AGENT_PRIVATE_KEY) on an agent host; keep the mnemonic off hot
// machines. SLIP-10 hardened derivation is one-way, so a leaked child key never
// exposes the seed or sibling agents — but a leaked *mnemonic* exposes them all.
// Use a FRESH, dedicated, capped-balance seed — never a funded signer/treasury seed.

import { createHmac } from 'node:crypto';
import { mnemonicToSeedSync, validateMnemonic } from 'bip39';

/** CAP-26 Radix mainnet account path prefix: m/44'/1022'/1'/525'/1460'/<index>'. */
const CAP26_ACCOUNT_PREFIX = [44, 1022, 1, 525, 1460] as const;
/** SLIP-10 hardened offset; Ed25519 supports hardened derivation only. */
const HARDENED_OFFSET = 0x80000000;

interface Slip10Node {
  key: Buffer;
  chainCode: Buffer;
}

function slip10Master(seed: Buffer): Slip10Node {
  const I = createHmac('sha512', 'ed25519 seed').update(seed).digest();
  return { key: I.subarray(0, 32), chainCode: I.subarray(32, 64) };
}

function slip10DeriveChild(parent: Slip10Node, index: number): Slip10Node {
  const data = Buffer.alloc(37);
  data[0] = 0x00;
  parent.key.copy(data, 1);
  data.writeUInt32BE(HARDENED_OFFSET + index, 33);
  const I = createHmac('sha512', parent.chainCode).update(data).digest();
  return { key: I.subarray(0, 32), chainCode: I.subarray(32, 64) };
}

/**
 * Derive the 32-byte Ed25519 private key (lowercase hex) for agent `index` from
 * a BIP-39 `mnemonic`. The result is the exact value `GUILD_AGENT_PRIVATE_KEY`
 * expects (`AgentIdentity.fromPrivateKeyHex`). Throws on an invalid mnemonic
 * (checksum/wordlist) or an out-of-range index.
 */
export function deriveAgentPrivateKeyHex(mnemonic: string, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED_OFFSET) {
    throw new Error(`agent account index must be an integer in [0, 2^31) — got ${index}`);
  }
  // BIP-39 English words are lowercase; normalize so a phrase that picked up
  // capitalization (mobile auto-caps / a title-cased wallet display) still
  // derives the canonical seed instead of failing the checksum.
  const phrase = mnemonic.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!validateMnemonic(phrase)) {
    throw new Error('invalid BIP-39 mnemonic (failed checksum/wordlist) — check the words');
  }
  let node = slip10Master(mnemonicToSeedSync(phrase));
  for (const component of [...CAP26_ACCOUNT_PREFIX, index]) {
    node = slip10DeriveChild(node, component);
  }
  return node.key.toString('hex');
}
