// Verification: recompute the JCS-canonical signable bytes from the
// credential AS RECEIVED (so any post-signing tampering to credentialSubject
// changes the bytes and breaks every signature that covered them), then
// check each proof's signature against the Ed25519 public key its
// verificationMethod's did:key encodes.

import { hexToBytes } from './bytes.js';
import { didKeyToPublicKeyBytes, didFromVerificationMethod } from './did-key.js';
import { signableBytes } from './sign.js';
import type { CredentialProof, ProofRole, TaskSettlementCredential } from './schema.js';
import { PROOF_TYPE } from './schema.js';

export interface ProofVerification {
  role: ProofRole;
  verificationMethod: string;
  valid: boolean;
  error?: string;
}

export interface VerifyResult {
  /** True only if the credential is signed, every proof checks out, and (unless disabled) a witness proof is present. */
  valid: boolean;
  proofCount: number;
  hasWitness: boolean;
  perProof: ProofVerification[];
  errors: string[];
}

export interface VerifyOptions {
  /** Default true: a credential with only worker+poster proofs (no witness) is flagged invalid. */
  requireWitness?: boolean;
}

async function verifyOneProof(
  message: Uint8Array,
  proof: CredentialProof
): Promise<ProofVerification> {
  const base: Pick<ProofVerification, 'role' | 'verificationMethod'> = {
    role: proof.role,
    verificationMethod: proof.verificationMethod,
  };
  try {
    if (proof.type !== PROOF_TYPE) {
      return { ...base, valid: false, error: `unsupported proof type: ${proof.type}` };
    }
    const did = didFromVerificationMethod(proof.verificationMethod);
    const publicKeyRaw = didKeyToPublicKeyBytes(did);
    // `Uint8Array.from` sidesteps a TS lib mismatch between
    // `Uint8Array<ArrayBufferLike>` and WebCrypto's `BufferSource` (see sign.ts).
    const publicKey = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(publicKeyRaw),
      'Ed25519',
      false,
      ['verify']
    );
    const signature = hexToBytes(proof.signature);
    const ok = await crypto.subtle.verify(
      'Ed25519',
      publicKey,
      Uint8Array.from(signature),
      Uint8Array.from(message)
    );
    return { ...base, valid: ok, error: ok ? undefined : 'signature does not match' };
  } catch (err) {
    return { ...base, valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function verifyCredential(
  credential: TaskSettlementCredential,
  options: VerifyOptions = {}
): Promise<VerifyResult> {
  const requireWitness = options.requireWitness ?? true;
  const message = signableBytes(credential);
  const perProof = await Promise.all(credential.proofs.map((p) => verifyOneProof(message, p)));

  const errors: string[] = [];
  if (perProof.length === 0) errors.push('unsigned: this credential carries no proofs');
  const badProofs = perProof.filter((p) => !p.valid);
  for (const p of badProofs) {
    errors.push(`proof from ${p.verificationMethod} (${p.role}) failed: ${p.error ?? 'invalid signature'}`);
  }
  const hasWitness = perProof.some((p) => p.role === 'witness');
  if (requireWitness && perProof.length > 0 && !hasWitness) {
    errors.push('missing witness proof');
  }

  const valid =
    perProof.length > 0 &&
    badProofs.length === 0 &&
    (!requireWitness || hasWitness);

  return { valid, proofCount: perProof.length, hasWitness, perProof, errors };
}
