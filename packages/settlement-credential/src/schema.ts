// TaskSettlementCredential v0.1 — a signed, chain-agnostic, verifiable
// receipt that a Guild task settled. See README.md for what this credential
// is and, more importantly, what it is NOT (no score is stored in it; any
// reputation score is recomputed at query time from >=3 distinct funders —
// this package issues raw receipts only).

export const CREDENTIAL_SCHEMA_VERSION = '0.1' as const;

export const CREDENTIAL_CONTEXT = [
  'https://www.w3.org/2018/credentials/v1',
  'https://radixguild.com/credentials/settlement/v0.1',
] as const;

export const CREDENTIAL_TYPE = ['VerifiableCredential', 'TaskSettlementCredential'] as const;

/** Matches the escrow blueprint's terminal outcomes this credential can attest to. */
export type SettlementOutcome = 'approved' | 'dispute_resolved';

export type SettlementNetwork = 'mainnet' | 'stokenet';

export type ProofRole = 'witness' | 'worker' | 'poster';

export interface CredentialSubject {
  /** The escrow blueprint's on-chain task id (u64, but JS-safe for realistic task counts). */
  task_id: number;
  /** Escrow component address the task settled against. */
  escrow_component: string;
  /** Transaction intent hash of the terminal settlement call (approve/auto_resolve). */
  settlement_tx: string;
  /**
   * Ledger state_version the settlement_tx committed at. `null` when the
   * credential was built without a confirmed Gateway read (e.g. during a
   * network halt) — a `null` here means WITNESS-ONLY: verifiers should not
   * treat the credential as chain-pinned, only as attesting to what its
   * signers claim happened.
   */
  state_version: number | null;
  network: SettlementNetwork;
  /** did:key of the task's poster. */
  poster: string;
  /** did:key of the task's worker. */
  worker: string;
  /** Decimal string — the worker's settled payout, in XRD (not the total escrowed amount). */
  amount_xrd: string;
  /** Resource address the payout was denominated in. */
  resource: string;
  outcome: SettlementOutcome;
  /**
   * ISO-8601 timestamp of the point after which the outcome can no longer
   * change on-chain (the review/dispute window's close, or — for an
   * already-disputed task — the terminal call's own commit time, since a
   * dispute's resolution is itself final).
   */
  review_window_closed_at: string;
}

/**
 * Not a claim to the exact W3C Ed25519Signature2020 cryptosuite (which has
 * its own canonicalization + multibase signature encoding); this is a
 * simpler, explicitly-named suite: sign raw Ed25519 over the JCS-canonical
 * bytes of the credential minus `proofs`, hex-encode the 64-byte signature.
 * Named distinctly so nobody mistakes it for cross-compatible with a
 * generic VC verifier expecting the real cryptosuite.
 */
export const PROOF_TYPE = 'Ed25519Signature2020Jcs' as const;

export interface CredentialProof {
  type: typeof PROOF_TYPE;
  /** `did:key:z...#z...` (or a did:web verificationMethod id) identifying the signer. */
  verificationMethod: string;
  created: string;
  role: ProofRole;
  /** 64-byte Ed25519 signature, lowercase hex. */
  signature: string;
}

export interface TaskSettlementCredential {
  '@context': readonly string[];
  type: readonly string[];
  /** Deterministic id — see `credentialId()`. */
  id: string;
  /** `did:web:radixguild.com` — the Guild's own issuer identity for this credential type. */
  issuer: string;
  issuanceDate: string;
  credentialSubject: CredentialSubject;
  proofs: CredentialProof[];
}

export function credentialId(subject: Pick<CredentialSubject, 'network' | 'settlement_tx'>): string {
  return `urn:radixguild:settlement:${subject.network}:${subject.settlement_tx}`;
}

export interface BuildCredentialInput {
  issuer: string;
  issuanceDate?: string;
  subject: CredentialSubject;
}

/** Build an UNSIGNED credential shell (`proofs: []`) from a subject. Pure — no I/O, no signing. */
export function buildUnsignedCredential(input: BuildCredentialInput): TaskSettlementCredential {
  return {
    '@context': CREDENTIAL_CONTEXT,
    type: CREDENTIAL_TYPE,
    id: credentialId(input.subject),
    issuer: input.issuer,
    issuanceDate: input.issuanceDate ?? new Date().toISOString(),
    credentialSubject: input.subject,
    proofs: [],
  };
}
