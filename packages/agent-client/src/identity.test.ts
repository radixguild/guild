// Identity derivation: deterministic mainnet virtual-account addresses from a
// 32-byte ed25519 key — the same derivation rola runs server-side (proven by
// the round-trip in rola.test.ts; these are the local invariants).

import { describe, test, expect } from 'bun:test';
import { AgentIdentity } from './identity.js';
import { generateThrowawayPrivateKeyHex } from './throwaway-key.js';

describe('AgentIdentity', () => {
  test('derivation is deterministic for the same key', async () => {
    const keyHex = generateThrowawayPrivateKeyHex();
    const first = await AgentIdentity.fromPrivateKeyHex(keyHex);
    const second = await AgentIdentity.fromPrivateKeyHex(keyHex.toUpperCase());
    expect(first.address).toBe(second.address);
    expect(first.publicKeyHex).toBe(second.publicKeyHex);
  });

  test('derives a mainnet account address and 32-byte public key', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    expect(identity.address).toStartWith('account_rdx1');
    expect(identity.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.networkId).toBe(1);
  });

  test('different keys derive different addresses', async () => {
    const a = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const b = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    expect(a.address).not.toBe(b.address);
  });

  test('signHash produces a 64-byte ed25519 signature (hex)', async () => {
    const identity = await AgentIdentity.fromPrivateKeyHex(generateThrowawayPrivateKeyHex());
    const signature = identity.signHash(new Uint8Array(32).fill(7));
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
  });

  test('rejects malformed private keys', async () => {
    expect(AgentIdentity.fromPrivateKeyHex('abc')).rejects.toThrow();
    expect(AgentIdentity.fromPrivateKeyHex('xx'.repeat(32))).rejects.toThrow();
  });

  test('throwaway keys are 32-byte hex and unique', () => {
    const a = generateThrowawayPrivateKeyHex();
    const b = generateThrowawayPrivateKeyHex();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
