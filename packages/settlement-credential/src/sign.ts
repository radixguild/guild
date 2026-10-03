// Ed25519 signing over WebCrypto — works unmodified in Node >=20, Bun, and
// any browser new enough to have shipped WebCrypto Ed25519 (Chrome 135+,
// Firefox 130+, Safari 17+). Chosen over adding a dependency: neither
// packages/agent-client nor packages/agent-mcp already depend on a
// noble/* library (agent-client's ed25519 need is met by
// @radixdlt/radix-engine-toolkit, which is a heavier, WASM-backed
// dependency not meant for bundling into a static page) — so per the task
// brief's own fallback rule, WebCrypto is the right choice here, not a new
// package.json entry.

import { canonicalizeToBytes } from './jcs.js';
import { bytesToHex } from './bytes.js';
import { publicKeyToDidKey, didKeyVerificationMethodId } from './did-key.js';
import type { CredentialProof, ProofRole, TaskSettlementCredential } from './schema.js';
import { PROOF_TYPE } from './schema.js';

export interface SigningKey {
  did: string;
  verificationMethod: string;
  privateKey: CryptoKey;
  publicKeyRaw: Uint8Array;
}

/** Generate a THROWAWAY Ed25519 keypair. Never used for the real ceremony — that is bigdev's hand-signed key. */
export async function generateThrowawaySigningKey(): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const publicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', (pair as CryptoKeyPair).publicKey)
  );
  const did = publicKeyToDidKey(publicKeyRaw);
  return {
    did,
    verificationMethod: didKeyVerificationMethodId(did),
    privateKey: (pair as CryptoKeyPair).privateKey,
    publicKeyRaw,
  };
}

/** Import a raw 32-byte Ed25519 private key (PKCS8-wrapped) — for a real ceremony's key material. */
export async function importEd25519PrivateKeyPkcs8(pkcs8: Uint8Array): Promise<CryptoKey> {
  // `Uint8Array.from` (not the plain array) sidesteps a TS lib mismatch between
  // `Uint8Array<ArrayBufferLike>` (what most Uint8Array expressions infer as)
  // and WebCrypto's `BufferSource`, which wants a concrete non-shared `ArrayBuffer`.
  return crypto.subtle.importKey('pkcs8', Uint8Array.from(pkcs8), 'Ed25519', false, ['sign']);
}

/** Bytes actually signed: JCS-canonical UTF-8 of the credential with `proofs` removed entirely. */
export function signableBytes(credential: TaskSettlementCredential): Uint8Array {
  const { proofs: _proofs, ...unsigned } = credential;
  return canonicalizeToBytes(unsigned);
}

export interface AddProofOptions {
  role: ProofRole;
  now?: Date;
}

/** Append one proof, signing with `key`. Returns a NEW credential (does not mutate the input). */
export async function addProof(
  credential: TaskSettlementCredential,
  key: SigningKey,
  options: AddProofOptions
): Promise<TaskSettlementCredential> {
  const message = signableBytes(credential);
  const signatureBuf = await crypto.subtle.sign('Ed25519', key.privateKey, Uint8Array.from(message));
  const proof: CredentialProof = {
    type: PROOF_TYPE,
    verificationMethod: key.verificationMethod,
    created: (options.now ?? new Date()).toISOString(),
    role: options.role,
    signature: bytesToHex(new Uint8Array(signatureBuf)),
  };
  return { ...credential, proofs: [...credential.proofs, proof] };
}
