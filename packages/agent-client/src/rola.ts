// Programmatic ROLA proof construction.
//
// Builds the EXACT canonical signature message that @radixdlt/rola's
// verifySignedChallenge checks (the Guild server runs rola 2.1.0 with
// { dAppDefinitionAddress, networkId: 1, expectedOrigin } — see
// guild-saas/guild-app/src/lib/rola.ts):
//
//   blake2b_256( "R" ++ challenge_bytes(32)
//                    ++ dapp_definition_address_length(1 byte)
//                    ++ dapp_definition_address(utf8)
//                    ++ origin(utf8) )
//
// The hash itself is the signed payload (rola verifies the ed25519 signature
// against the hash). We use RET's `hash` (blake2b-256, same digest rola
// computes via blakejs) instead of hand-rolling the hash function.
// The round-trip test (rola.test.ts) feeds our construction through the real
// @radixdlt/rola verifier with identical config — any drift fails the suite.

import { hash } from '@radixdlt/radix-engine-toolkit';
import { assertHex, hexToBytes } from './bytes.js';
import type { AgentIdentity } from './identity.js';

/** Mirror of the server's verifyAuthSchema proof shape (lib/validation.ts). */
export interface RolaProof {
  publicKey: string;
  signature: string;
  curve: 'curve25519' | 'secp256k1';
}

/** Mirror of @radixdlt/rola's SignedChallenge / the server's verifyAuthSchema. */
export interface SignedChallenge {
  challenge: string;
  address: string;
  proof: RolaProof;
  type: 'persona' | 'account';
}

export interface RolaMessageInput {
  /** 32-byte hex challenge issued by GET /api/v1/auth/challenge. */
  challenge: string;
  /** dApp definition account address (length-prefixed into the message). */
  dAppDefinitionAddress: string;
  /** Origin the server verifies against (its ROLA_EXPECTED_ORIGIN). */
  origin: string;
}

/** Compute the 32-byte ROLA signature-message hash. */
export function rolaSignatureMessageHash(input: RolaMessageInput): Uint8Array {
  const challengeHex = assertHex(input.challenge, 32, 'ROLA challenge');
  const addressUtf8 = new TextEncoder().encode(input.dAppDefinitionAddress);
  if (addressUtf8.length === 0 || addressUtf8.length > 255) {
    throw new Error('Invalid dAppDefinitionAddress: length must fit one prefix byte');
  }
  const originUtf8 = new TextEncoder().encode(input.origin);
  const prefixR = 0x52; // ascii "R"
  const message = new Uint8Array(1 + 32 + 1 + addressUtf8.length + originUtf8.length);
  let offset = 0;
  message[offset++] = prefixR;
  message.set(hexToBytes(challengeHex), offset);
  offset += 32;
  message[offset++] = addressUtf8.length;
  message.set(addressUtf8, offset);
  offset += addressUtf8.length;
  message.set(originUtf8, offset);
  return hash(message);
}

/**
 * Construct the SignedChallenge for POST /api/v1/auth/verify: sign the
 * canonical message hash with the agent's key and attach the proof in the
 * exact shape verifyAuthSchema expects (type "account", curve "curve25519").
 */
export function createSignedChallenge(
  identity: AgentIdentity,
  input: RolaMessageInput
): SignedChallenge {
  const messageHash = rolaSignatureMessageHash(input);
  return {
    challenge: input.challenge.toLowerCase(),
    address: identity.address,
    proof: {
      publicKey: identity.publicKeyHex,
      signature: identity.signHash(messageHash),
      curve: 'curve25519',
    },
    type: 'account',
  };
}
