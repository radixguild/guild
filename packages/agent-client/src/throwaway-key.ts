// A random 32-byte ed25519 private key (hex) for TESTS and operator scripts only.
//
// NOT SHIPPED — package.json `files` and tsconfig.build.json both exclude this file,
// scripts/publish-gate.mjs refuses it, and publish-manifest.test.ts pins the packed set.
// It used to live in identity.ts and be exported from the package index, where `join`,
// `join --new-key` and `onboard --generate` made agents' keys with it. Agents are
// badge-first now (ruling 2026-10-03): the kit never creates a key — a developer brings
// their own (GUILD_AGENT_KEY_FILE or GUILD_AGENT_PRIVATE_KEY) — so nothing that ships
// may generate one. key-never-made.test.ts fails if that changes.

import { bytesToHex } from './bytes.js';

export function generateThrowawayPrivateKeyHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}
