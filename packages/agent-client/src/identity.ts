// Agent identity = a self-custodied ed25519 keypair + its mainnet virtual
// account address. The Guild never holds this key (agent-auth-design.md "Key
// custody"); the agent signs ROLA challenges and its own transactions locally.

import { PrivateKey, PublicKey, RadixEngineToolkit } from '@radixdlt/radix-engine-toolkit';
import { assertHex, bytesToHex } from './bytes.js';
import { NETWORK_ID } from './config.js';
import { deriveAgentPrivateKeyHex } from './hd.js';

export class AgentIdentity {
  private constructor(
    /** RET ed25519 private key — also used as the tx notary key. */
    readonly privateKey: PrivateKey,
    /** 32-byte ed25519 public key, lowercase hex. */
    readonly publicKeyHex: string,
    /** Virtual account address derived from the public key (bech32m). */
    readonly address: string,
    /** Network the address was derived for (1 = mainnet). */
    readonly networkId: number
  ) {}

  /**
   * Build an identity from a 32-byte hex private key (env custody). The
   * address derivation is the exact call @radixdlt/rola makes server-side
   * (RadixEngineToolkit.Derive.virtualAccountAddressFromPublicKey), so what we
   * derive here is what the verifier expects.
   */
  static async fromPrivateKeyHex(
    privateKeyHex: string,
    networkId: number = NETWORK_ID
  ): Promise<AgentIdentity> {
    const hex = assertHex(privateKeyHex, 32, 'agent private key');
    const privateKey = new PrivateKey.Ed25519(hex);
    const publicKeyHex = privateKey.publicKeyHex().toLowerCase();
    const address = await RadixEngineToolkit.Derive.virtualAccountAddressFromPublicKey(
      new PublicKey.Ed25519(publicKeyHex),
      networkId
    );
    return new AgentIdentity(privateKey, publicKeyHex, address, networkId);
  }

  /**
   * Build an identity from a fleet `mnemonic` + account `index` — one seed
   * derives the whole agent fleet (CAP-26, matches the Radix wallet; see hd.ts).
   * Convenience over `fromPrivateKeyHex(deriveAgentPrivateKeyHex(...))`. Prefer
   * deriving OFFLINE (`bun run derive`) and shipping only the per-agent derived
   * key to an agent host — keep the mnemonic off hot machines.
   */
  static async fromMnemonic(
    mnemonic: string,
    index: number,
    networkId: number = NETWORK_ID
  ): Promise<AgentIdentity> {
    return AgentIdentity.fromPrivateKeyHex(deriveAgentPrivateKeyHex(mnemonic, index), networkId);
  }

  /** Sign a 32-byte message hash; returns the 64-byte ed25519 signature as hex. */
  signHash(messageHash: Uint8Array): string {
    return bytesToHex(this.privateKey.sign(messageHash));
  }
}
