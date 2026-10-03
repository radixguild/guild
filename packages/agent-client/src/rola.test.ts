// CORE self-verification: round-trip our programmatic ROLA proof through the
// EXACT verifier the Guild server runs — @radixdlt/rola's
// verifySignedChallenge with the same config as guild-app src/lib/rola.ts
// (dAppDefinitionAddress, networkId 1, expectedOrigin) — fully OFFLINE via an
// injected gatewayApiClient stub.
//
// The stub mirrors the live Gateway behaviour for a never-instantiated
// virtual account: no owner_keys metadata ⇒ rola falls back to comparing the
// address derived from the proof's public key (the same RET derivation our
// AgentIdentity uses). A second stub covers the instantiated-account branch
// (owner_keys contains blake2b(pubkey)[-29:]).

import { describe, test, expect } from 'bun:test';
import { Rola } from '@radixdlt/rola';
import { hash } from '@radixdlt/radix-engine-toolkit';
import { AgentIdentity } from './identity.js';
import { generateThrowawayPrivateKeyHex } from './throwaway-key.js';
import { createSignedChallenge, rolaSignatureMessageHash } from './rola.js';
import { loadConfig } from './config.js';
import { bytesToHex, hexToBytes } from './bytes.js';

// Server-side config (guild-app defaults — what radixguild.com runs).
const CONFIG = loadConfig();
const SERVER_ROLA_CONFIG = {
  applicationName: 'Radix Guild',
  dAppDefinitionAddress: CONFIG.dAppDefinitionAddress,
  networkId: CONFIG.networkId,
  expectedOrigin: CONFIG.rolaOrigin,
};

type GatewayStub = {
  state: { getEntityDetailsVaultAggregated: (address: string) => Promise<unknown> };
};

/** Gateway stub: virtual account, never instantiated — no metadata at all. */
const virtualAccountGateway: GatewayStub = {
  state: {
    getEntityDetailsVaultAggregated: () => Promise.resolve({ metadata: { items: [] } }),
  },
};

function rolaWith(config: typeof SERVER_ROLA_CONFIG, gateway: GatewayStub = virtualAccountGateway) {
  // gatewayApiClient is structurally narrowed to the one call rola makes.
  return Rola({ ...config, gatewayApiClient: gateway as never });
}

function freshChallenge(): string {
  return generateThrowawayPrivateKeyHex(); // 32 random bytes, hex — same shape
}

async function freshIdentity(): Promise<AgentIdentity> {
  return AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex(), CONFIG.networkId);
}

describe('ROLA offline round-trip (the contract test)', () => {
  test('our SignedChallenge passes the exact server-side verifier', async () => {
    const identity = await freshIdentity();
    const challenge = freshChallenge();
    const signed = createSignedChallenge(identity, {
      challenge,
      dAppDefinitionAddress: SERVER_ROLA_CONFIG.dAppDefinitionAddress,
      origin: SERVER_ROLA_CONFIG.expectedOrigin,
    });

    const result = await rolaWith(SERVER_ROLA_CONFIG).verifySignedChallenge(signed);
    if (result.isErr()) {
      throw new Error(`verifier rejected our proof: ${JSON.stringify(result.error)}`);
    }
    expect(result.isOk()).toBe(true);
  });

  test('shape matches the server verifyAuthSchema exactly', async () => {
    const identity = await freshIdentity();
    const signed = createSignedChallenge(identity, {
      challenge: freshChallenge(),
      dAppDefinitionAddress: SERVER_ROLA_CONFIG.dAppDefinitionAddress,
      origin: SERVER_ROLA_CONFIG.expectedOrigin,
    });
    expect(Object.keys(signed).sort()).toEqual(['address', 'challenge', 'proof', 'type']);
    expect(Object.keys(signed.proof).sort()).toEqual(['curve', 'publicKey', 'signature']);
    expect(signed.type).toBe('account');
    expect(signed.proof.curve).toBe('curve25519');
    expect(signed.address).toStartWith('account_rdx1');
    expect(signed.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.proof.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.proof.signature).toMatch(/^[0-9a-f]{128}$/);
  });

  test('verifies via owner_keys when the account is instantiated on-ledger', async () => {
    const identity = await freshIdentity();
    // Live gateway shape: owner_keys raw_hex contains blake2b(pubkey)[-29:].
    const pubKeyHash = bytesToHex(hash(hexToBytes(identity.publicKeyHex)).slice(-29));
    const instantiatedGateway: GatewayStub = {
      state: {
        getEntityDetailsVaultAggregated: () =>
          Promise.resolve({
            metadata: {
              items: [{ key: 'owner_keys', value: { raw_hex: `5c90${pubKeyHash}` } }],
            },
          }),
      },
    };
    const signed = createSignedChallenge(identity, {
      challenge: freshChallenge(),
      dAppDefinitionAddress: SERVER_ROLA_CONFIG.dAppDefinitionAddress,
      origin: SERVER_ROLA_CONFIG.expectedOrigin,
    });
    const result = await rolaWith(SERVER_ROLA_CONFIG, instantiatedGateway).verifySignedChallenge(
      signed
    );
    expect(result.isOk()).toBe(true);
  });
});

describe('ROLA negative cases (verifier must reject)', () => {
  async function signedFor(identity: AgentIdentity, challenge: string) {
    return createSignedChallenge(identity, {
      challenge,
      dAppDefinitionAddress: SERVER_ROLA_CONFIG.dAppDefinitionAddress,
      origin: SERVER_ROLA_CONFIG.expectedOrigin,
    });
  }

  test('tampered challenge fails', async () => {
    const identity = await freshIdentity();
    const signed = await signedFor(identity, freshChallenge());
    const tampered = { ...signed, challenge: freshChallenge() };
    const result = await rolaWith(SERVER_ROLA_CONFIG).verifySignedChallenge(tampered);
    expect(result.isErr()).toBe(true);
  });

  test('origin mismatch fails (server expects its ROLA_EXPECTED_ORIGIN)', async () => {
    const identity = await freshIdentity();
    const signed = createSignedChallenge(identity, {
      challenge: freshChallenge(),
      dAppDefinitionAddress: SERVER_ROLA_CONFIG.dAppDefinitionAddress,
      origin: 'https://evil.example.com',
    });
    const result = await rolaWith(SERVER_ROLA_CONFIG).verifySignedChallenge(signed);
    expect(result.isErr()).toBe(true);
  });

  test('dApp definition mismatch fails', async () => {
    const identity = await freshIdentity();
    const signed = createSignedChallenge(identity, {
      challenge: freshChallenge(),
      // valid bech32m account, but not the Guild's dApp definition
      dAppDefinitionAddress: identity.address,
      origin: SERVER_ROLA_CONFIG.expectedOrigin,
    });
    const result = await rolaWith(SERVER_ROLA_CONFIG).verifySignedChallenge(signed);
    expect(result.isErr()).toBe(true);
  });

  test('claiming someone else address fails (derived-address pin)', async () => {
    const identityA = await freshIdentity();
    const identityB = await freshIdentity();
    const signed = await signedFor(identityA, freshChallenge());
    const spoofed = { ...signed, address: identityB.address };
    const result = await rolaWith(SERVER_ROLA_CONFIG).verifySignedChallenge(spoofed);
    expect(result.isErr()).toBe(true);
  });

  test('signature from a different key fails', async () => {
    const identityA = await freshIdentity();
    const identityB = await freshIdentity();
    const challenge = freshChallenge();
    const signedA = await signedFor(identityA, challenge);
    const signedB = await signedFor(identityB, challenge);
    const franken = { ...signedA, proof: { ...signedA.proof, signature: signedB.proof.signature } };
    const result = await rolaWith(SERVER_ROLA_CONFIG).verifySignedChallenge(franken);
    expect(result.isErr()).toBe(true);
  });
});

describe('rolaSignatureMessageHash', () => {
  test('is deterministic and 32 bytes', () => {
    const input = {
      challenge: 'aa'.repeat(32),
      dAppDefinitionAddress: SERVER_ROLA_CONFIG.dAppDefinitionAddress,
      origin: SERVER_ROLA_CONFIG.expectedOrigin,
    };
    const first = rolaSignatureMessageHash(input);
    const second = rolaSignatureMessageHash(input);
    expect(first.length).toBe(32);
    expect(bytesToHex(first)).toBe(bytesToHex(second));
  });

  test('rejects a malformed challenge', () => {
    expect(() =>
      rolaSignatureMessageHash({
        challenge: 'not-hex',
        dAppDefinitionAddress: SERVER_ROLA_CONFIG.dAppDefinitionAddress,
        origin: SERVER_ROLA_CONFIG.expectedOrigin,
      })
    ).toThrow();
  });
});
