import { describe, test, expect } from 'bun:test';
import { publicKeyToDidKey, didKeyToPublicKeyBytes, didKeyVerificationMethodId, didFromVerificationMethod } from './did-key.js';
import { base58btcDecode, base58btcEncode } from './base58.js';
import { hexToBytes, bytesToHex } from './bytes.js';

describe('base58btc', () => {
  test('round-trips arbitrary bytes', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(34));
    expect(base58btcDecode(base58btcEncode(bytes))).toEqual(bytes);
  });

  test('encodes each leading zero byte as a leading "1"', () => {
    const bytes = new Uint8Array([0, 0, 1, 2, 3]);
    const encoded = base58btcEncode(bytes);
    expect(encoded.startsWith('11')).toBe(true);
    expect(base58btcDecode(encoded)).toEqual(bytes);
  });

  test('rejects characters outside the base58btc alphabet (0, O, I, l)', () => {
    expect(() => base58btcDecode('0OIl')).toThrow();
  });

  test('empty input round-trips to empty', () => {
    expect(base58btcEncode(new Uint8Array(0))).toBe('');
    expect(base58btcDecode('')).toEqual(new Uint8Array(0));
  });
});

describe('did:key (Ed25519)', () => {
  // Known-answer vector. The keypair is RFC 8032 §7.1 Ed25519 test vector 1
  // (secret seed 9d61b19d…cae7f60) — NOT reproduced here from memory, but
  // regenerated with Node's own `node:crypto` Ed25519 (PKCS8-wrapped seed)
  // and cross-checked two ways before being hardcoded as this test's
  // expectation:
  //   1. Signing the empty message with the derived private key reproduced
  //      RFC 8032's own published test-vector-1 signature byte-for-byte,
  //      confirming the derived public key below is the genuine RFC vector
  //      (not a transcription slip — an earlier hand-typed attempt at this
  //      constant WAS off by one trailing byte until this cross-check).
  //   2. The did:key string was computed by an independent base58btc +
  //      multicodec implementation written in Python (not this file's
  //      TypeScript), and the two agreed.
  // So this is a real, externally-reproducible vector — just not claimed as
  // "the" published did:key-spec example, which this pass did not attempt
  // to independently confirm.
  const RFC8032_TEST1_PUBLIC_KEY_HEX =
    'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
  const EXPECTED_DID_KEY = 'did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw';

  test('matches the cross-checked known-answer vector', () => {
    const pub = hexToBytes(RFC8032_TEST1_PUBLIC_KEY_HEX);
    expect(pub.length).toBe(32);
    expect(publicKeyToDidKey(pub)).toBe(EXPECTED_DID_KEY);
  });

  test('round-trips: did:key -> public key bytes -> same did:key', () => {
    const pub = hexToBytes(RFC8032_TEST1_PUBLIC_KEY_HEX);
    const did = publicKeyToDidKey(pub);
    const decoded = didKeyToPublicKeyBytes(did);
    expect(bytesToHex(decoded)).toBe(RFC8032_TEST1_PUBLIC_KEY_HEX);
    expect(publicKeyToDidKey(decoded)).toBe(did);
  });

  test('different keys produce different did:keys', () => {
    const a = publicKeyToDidKey(crypto.getRandomValues(new Uint8Array(32)));
    const b = publicKeyToDidKey(crypto.getRandomValues(new Uint8Array(32)));
    expect(a).not.toBe(b);
  });

  test('rejects a public key of the wrong length', () => {
    expect(() => publicKeyToDidKey(new Uint8Array(31))).toThrow();
    expect(() => publicKeyToDidKey(new Uint8Array(33))).toThrow();
  });

  test('rejects a did:key with a non-Ed25519 multicodec prefix', () => {
    // multicodec 0x1200 (secp256k1-pub)-shaped prefix + 32 bytes of filler,
    // so the length matches Ed25519's and the multicodec check is what fires.
    const fake = new Uint8Array([0x12, 0x00, ...new Array(32).fill(1)]);
    const did = `did:key:z${base58btcEncode(fake)}`;
    expect(() => didKeyToPublicKeyBytes(did)).toThrow(/Ed25519/);
  });

  test('rejects a malformed did:key string', () => {
    expect(() => didKeyToPublicKeyBytes('did:key:0notbase58')).toThrow();
    expect(() => didKeyToPublicKeyBytes('did:web:radixguild.com')).toThrow();
  });

  test('verificationMethodId / didFromVerificationMethod round-trip', () => {
    const did = EXPECTED_DID_KEY;
    const vmId = didKeyVerificationMethodId(did);
    expect(vmId).toBe(`${did}#${did.slice('did:key:'.length)}`);
    expect(didFromVerificationMethod(vmId)).toBe(did);
  });

  test('didFromVerificationMethod tolerates an id with no fragment', () => {
    expect(didFromVerificationMethod(EXPECTED_DID_KEY)).toBe(EXPECTED_DID_KEY);
  });
});
