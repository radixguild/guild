// HD fleet derivation — one mnemonic → many Radix agent accounts by index,
// CAP-26 m/44'/1022'/1'/525'/1460'/N'. A dev cross-check against an
// independent implementation confirmed byte-identical output, and the
// known-answer vector below locks it against regression.

import { describe, test, expect } from 'bun:test';
import { deriveAgentPrivateKeyHex } from './hd.js';
import { AgentIdentity } from './identity.js';

// BIP-39 zero test vector — PUBLIC, never a real wallet. Regression anchor only.
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('hd / deriveAgentPrivateKeyHex', () => {
  test('deterministic for the same (mnemonic, index)', () => {
    expect(deriveAgentPrivateKeyHex(TEST_MNEMONIC, 0)).toBe(
      deriveAgentPrivateKeyHex(TEST_MNEMONIC, 0)
    );
  });

  test('distinct indices derive distinct keys', () => {
    const keys = [0, 1, 2, 7].map(i => deriveAgentPrivateKeyHex(TEST_MNEMONIC, i));
    expect(new Set(keys).size).toBe(4);
  });

  test('derives a 32-byte ed25519 key (lowercase hex)', () => {
    expect(deriveAgentPrivateKeyHex(TEST_MNEMONIC, 0)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("known-answer vector — CAP-26 m/44'/1022'/1'/525'/1460'/0'", () => {
    // Pinned from the dev cross-check that confirmed byte-identical output to
    // an independent CAP-26 implementation. Confirm wallet PARITY once by
    // importing TEST_MNEMONIC into a Radix wallet — its account 0 must equal
    // AgentIdentity.fromMnemonic(TEST_MNEMONIC, 0).address.
    expect(deriveAgentPrivateKeyHex(TEST_MNEMONIC, 0)).toBe(
      'c6da7f25529087c811de8bcaefbfee3ef1787bef6837f9116dac242d5a3e231a'
    );
  });

  test('normalizes surrounding / interior whitespace', () => {
    const messy = `  ${TEST_MNEMONIC.replace(/ /g, '   ')}\n`;
    expect(deriveAgentPrivateKeyHex(messy, 0)).toBe(deriveAgentPrivateKeyHex(TEST_MNEMONIC, 0));
  });

  test('normalizes capitalization — BIP-39 English is lowercase', () => {
    expect(deriveAgentPrivateKeyHex(TEST_MNEMONIC.toUpperCase(), 0)).toBe(
      deriveAgentPrivateKeyHex(TEST_MNEMONIC, 0)
    );
  });

  test('rejects an invalid mnemonic', () => {
    expect(() => deriveAgentPrivateKeyHex('not a valid mnemonic phrase at all', 0)).toThrow();
  });

  test('rejects out-of-range / non-integer indices', () => {
    expect(() => deriveAgentPrivateKeyHex(TEST_MNEMONIC, -1)).toThrow();
    expect(() => deriveAgentPrivateKeyHex(TEST_MNEMONIC, 1.5)).toThrow();
  });
});

describe('AgentIdentity.fromMnemonic', () => {
  test('matches fromPrivateKeyHex on the derived key', async () => {
    const viaMnemonic = await AgentIdentity.fromMnemonic(TEST_MNEMONIC, 2);
    const viaKey = await AgentIdentity.fromPrivateKeyHex(
      deriveAgentPrivateKeyHex(TEST_MNEMONIC, 2)
    );
    expect(viaMnemonic.address).toBe(viaKey.address);
    expect(viaMnemonic.publicKeyHex).toBe(viaKey.publicKeyHex);
  });

  test('derives a mainnet account; distinct indices → distinct accounts', async () => {
    const a0 = await AgentIdentity.fromMnemonic(TEST_MNEMONIC, 0);
    const a1 = await AgentIdentity.fromMnemonic(TEST_MNEMONIC, 1);
    expect(a0.address).toStartWith('account_rdx1');
    expect(a0.address).not.toBe(a1.address);
    expect(a0.networkId).toBe(1);
  });
});
