import { describe, test, expect } from 'bun:test';
import {
  didWebToUrl,
  resolveDidWeb,
  findVerificationMethod,
  publicKeyBytesFromVerificationMethod,
  type DidDocument,
} from './did-web.js';
import { publicKeyToDidKey } from './did-key.js';
import { base58btcEncode } from './base58.js';

describe('didWebToUrl', () => {
  test('bare domain -> /.well-known/did.json', () => {
    expect(didWebToUrl('did:web:radixguild.com')).toBe('https://radixguild.com/.well-known/did.json');
  });

  test('path segments -> path/did.json (no .well-known)', () => {
    expect(didWebToUrl('did:web:radixguild.com:issuers:settlement')).toBe(
      'https://radixguild.com/issuers/settlement/did.json'
    );
  });

  test('rejects a non-did:web identifier', () => {
    expect(() => didWebToUrl('did:key:z6Mk')).toThrow();
  });

  test('rejects an empty identifier', () => {
    expect(() => didWebToUrl('did:web:')).toThrow();
  });
});

// A fixture "document" standing in for what https://radixguild.com/.well-known/did.json
// would serve. No network call happens anywhere in this file — `resolveDidWeb`
// is handed a fetcher that resolves this object directly.
function fixtureDocument(): { document: DidDocument; publicKeyRaw: Uint8Array } {
  const publicKeyRaw = crypto.getRandomValues(new Uint8Array(32));
  const did = publicKeyToDidKey(publicKeyRaw);
  const multibase = did.slice('did:key:'.length); // did:key's multibase value IS its embedded key
  const vmId = 'did:web:radixguild.com#witness-key-1';
  const document: DidDocument = {
    '@context': 'https://www.w3.org/ns/did/v1',
    id: 'did:web:radixguild.com',
    verificationMethod: [
      {
        id: vmId,
        type: 'Multikey',
        controller: 'did:web:radixguild.com',
        publicKeyMultibase: multibase,
      },
    ],
    assertionMethod: [vmId],
  };
  return { document, publicKeyRaw };
}

describe('resolveDidWeb (fixture fetcher, no network)', () => {
  test('fetches the well-known URL and returns the document', async () => {
    const { document } = fixtureDocument();
    const urlsFetched: string[] = [];
    const resolved = await resolveDidWeb('did:web:radixguild.com', async (url) => {
      urlsFetched.push(url);
      return document;
    });
    expect(urlsFetched).toEqual(['https://radixguild.com/.well-known/did.json']);
    expect(resolved).toBe(document);
  });

  test('rejects a document whose id does not match the requested did', async () => {
    const { document } = fixtureDocument();
    const mismatched = { ...document, id: 'did:web:someone-else.example' };
    await expect(resolveDidWeb('did:web:radixguild.com', async () => mismatched)).rejects.toThrow(
      /mismatch/
    );
  });

  test('propagates a fetcher failure (e.g. the document is unreachable)', async () => {
    await expect(
      resolveDidWeb('did:web:radixguild.com', async () => {
        throw new Error('network unreachable');
      })
    ).rejects.toThrow('network unreachable');
  });
});

describe('findVerificationMethod / publicKeyBytesFromVerificationMethod', () => {
  test('finds the verification method by id and decodes its raw public key', async () => {
    const { document, publicKeyRaw } = fixtureDocument();
    const vm = findVerificationMethod(document, 'did:web:radixguild.com#witness-key-1');
    const decoded = publicKeyBytesFromVerificationMethod(vm);
    expect(decoded).toEqual(publicKeyRaw);
  });

  test('throws when the verification method id is not present', () => {
    const { document } = fixtureDocument();
    expect(() => findVerificationMethod(document, 'did:web:radixguild.com#nope')).toThrow();
  });

  test('accepts a bare 32-byte raw key with no multicodec prefix (older Ed25519VerificationKey2020 style)', () => {
    const publicKeyRaw = crypto.getRandomValues(new Uint8Array(32));
    const bareMultibase = `z${base58btcEncode(publicKeyRaw)}`; // no 0xed01 prefix, but still multibase-'z'
    const vm = {
      id: 'did:web:radixguild.com#bare-key',
      type: 'Ed25519VerificationKey2020',
      controller: 'did:web:radixguild.com',
      publicKeyMultibase: bareMultibase,
    };
    expect(publicKeyBytesFromVerificationMethod(vm)).toEqual(publicKeyRaw);
  });

  test('rejects a multibase value that decodes to neither 32 nor 34 bytes', () => {
    const vm = {
      id: 'did:web:radixguild.com#bad-key',
      type: 'Ed25519VerificationKey2020',
      controller: 'did:web:radixguild.com',
      publicKeyMultibase: `z${base58btcEncode(new Uint8Array(10))}`,
    };
    expect(() => publicKeyBytesFromVerificationMethod(vm)).toThrow();
  });

  test('rejects a verification method with no publicKeyMultibase', () => {
    const vm = {
      id: 'did:web:radixguild.com#no-key',
      type: 'Ed25519VerificationKey2020',
      controller: 'did:web:radixguild.com',
    };
    expect(() => publicKeyBytesFromVerificationMethod(vm)).toThrow();
  });
});
