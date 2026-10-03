// did:web resolution — turns `did:web:radixguild.com` into the well-known
// document URL and picks a verification method's raw public key out of a
// (fixture or real) DID document. No network calls happen in this file
// itself: `resolveDidWeb` takes a `fetcher` the caller supplies, so tests
// inject a fixture and production code injects a real `fetch`.
// https://w3c-ccg.github.io/did-method-web/

import { base58btcDecode } from './base58.js';

export interface DidDocumentVerificationMethod {
  id: string;
  type: string;
  controller: string;
  /** base58btc multibase ('z...'), either bare 32-byte Ed25519 or 0xed01-multicodec-prefixed. */
  publicKeyMultibase?: string;
}

export interface DidDocument {
  '@context'?: string | string[];
  id: string;
  verificationMethod?: DidDocumentVerificationMethod[];
  assertionMethod?: Array<string | DidDocumentVerificationMethod>;
}

export type DidWebFetcher = (url: string) => Promise<DidDocument>;

/**
 * `did:web:example.com` -> `https://example.com/.well-known/did.json`
 * `did:web:example.com:issuers:radixguild` -> `https://example.com/issuers/radixguild/did.json`
 * (colon-separated path segments per the did:web spec; `%3A`-encoded ports are preserved.)
 */
export function didWebToUrl(did: string): string {
  const prefix = 'did:web:';
  if (!did.startsWith(prefix)) {
    throw new Error(`not a did:web identifier: ${JSON.stringify(did)}`);
  }
  const idPart = did.slice(prefix.length);
  if (idPart.length === 0) throw new Error(`empty did:web identifier: ${JSON.stringify(did)}`);
  const segments = idPart.split(':').map((s) => decodeURIComponent(s));
  const [domain, ...pathSegments] = segments;
  const path = pathSegments.length === 0 ? '.well-known' : pathSegments.join('/');
  return `https://${domain}/${path}/did.json`;
}

/** Fetch (via the injected fetcher) and sanity-check a did:web document's own `id`. */
export async function resolveDidWeb(did: string, fetcher: DidWebFetcher): Promise<DidDocument> {
  const url = didWebToUrl(did);
  const document = await fetcher(url);
  if (document.id !== did) {
    throw new Error(`did:web document id mismatch: expected ${did}, got ${document.id}`);
  }
  return document;
}

export function findVerificationMethod(
  document: DidDocument,
  verificationMethodId: string
): DidDocumentVerificationMethod {
  const vm = (document.verificationMethod ?? []).find((v) => v.id === verificationMethodId);
  if (!vm) {
    throw new Error(`verificationMethod not found in did:web document: ${verificationMethodId}`);
  }
  return vm;
}

const MULTICODEC_ED25519_PUB = [0xed, 0x01];

/** Decode a verificationMethod's publicKeyMultibase into a raw 32-byte Ed25519 public key. */
export function publicKeyBytesFromVerificationMethod(
  vm: DidDocumentVerificationMethod
): Uint8Array {
  if (!vm.publicKeyMultibase) {
    throw new Error(`verificationMethod ${vm.id} has no publicKeyMultibase`);
  }
  if (!vm.publicKeyMultibase.startsWith('z')) {
    throw new Error('only base58btc (z-prefixed) multibase keys are supported');
  }
  const decoded = base58btcDecode(vm.publicKeyMultibase.slice(1));
  if (decoded.length === 34 && decoded[0] === MULTICODEC_ED25519_PUB[0] && decoded[1] === MULTICODEC_ED25519_PUB[1]) {
    return decoded.slice(2);
  }
  if (decoded.length === 32) return decoded;
  throw new Error(`unexpected publicKeyMultibase length for ${vm.id}: ${decoded.length} bytes`);
}
