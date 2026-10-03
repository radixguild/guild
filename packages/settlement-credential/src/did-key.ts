// did:key (Ed25519) — encode/decode per the did:key method: a raw public key
// wrapped in a multicodec tag, multibase-encoded with the 'z' (base58btc)
// prefix. https://w3c-ccg.github.io/did-key-spec/ — Ed25519 uses multicodec
// 0xed01 (varint-encoded; both bytes are single-byte in the varint since
// 0xed < 0x80 is false but the *pair* 0xed,0x01 is the fixed 2-byte varint
// encoding of the registered code point 0xed — see the multicodec table).

import { base58btcDecode, base58btcEncode } from './base58.js';

const MULTICODEC_ED25519_PUB = new Uint8Array([0xed, 0x01]);
const ED25519_PUBLIC_KEY_BYTES = 32;

/** Ed25519 raw public key (32 bytes) -> `did:key:z...`. */
export function publicKeyToDidKey(publicKeyRaw: Uint8Array): string {
  if (publicKeyRaw.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error(`Ed25519 public key must be ${ED25519_PUBLIC_KEY_BYTES} bytes`);
  }
  const prefixed = new Uint8Array(MULTICODEC_ED25519_PUB.length + publicKeyRaw.length);
  prefixed.set(MULTICODEC_ED25519_PUB, 0);
  prefixed.set(publicKeyRaw, MULTICODEC_ED25519_PUB.length);
  return `did:key:z${base58btcEncode(prefixed)}`;
}

/** `did:key:z...` (Ed25519) -> raw 32-byte public key. Throws on any other multicodec. */
export function didKeyToPublicKeyBytes(did: string): Uint8Array {
  const match = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)$/.exec(did);
  if (!match) {
    throw new Error(`not a base58btc did:key: ${JSON.stringify(did)}`);
  }
  const decoded = base58btcDecode(match[1]);
  if (decoded.length !== MULTICODEC_ED25519_PUB.length + ED25519_PUBLIC_KEY_BYTES) {
    throw new Error(`did:key decodes to the wrong length (${decoded.length} bytes)`);
  }
  if (decoded[0] !== MULTICODEC_ED25519_PUB[0] || decoded[1] !== MULTICODEC_ED25519_PUB[1]) {
    throw new Error('did:key is not an Ed25519 key (multicodec 0xed01)');
  }
  return decoded.slice(MULTICODEC_ED25519_PUB.length);
}

/**
 * did:key's own convention: the (sole) verificationMethod id for a did:key
 * subject is `${did}#${multibaseValue}` — the multibase value repeated as
 * the fragment. No external resolution needed; the DID document is derived
 * from the identifier alone.
 */
export function didKeyVerificationMethodId(did: string): string {
  if (!did.startsWith('did:key:')) throw new Error(`not a did:key: ${JSON.stringify(did)}`);
  const multibaseValue = did.slice('did:key:'.length);
  return `${did}#${multibaseValue}`;
}

/** Extract the bare `did:key:z...` subject from a `did:key:z...#z...` verificationMethod id. */
export function didFromVerificationMethod(verificationMethodId: string): string {
  const hashIndex = verificationMethodId.indexOf('#');
  return hashIndex === -1 ? verificationMethodId : verificationMethodId.slice(0, hashIndex);
}
