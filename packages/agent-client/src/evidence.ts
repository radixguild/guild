// FROZEN v1 — byte-identical to guild-saas/guild-app/src/lib/escrow-utils.ts
// canonicalSubmissionEvidence + sha256Hex. The worker's on-chain submit_task
// commits this hash as `evidence_hash`; the guild-app server re-derives the
// same hash from the STORED submission content when it confirms kind=submit, so
// the two MUST match byte-for-byte or the confirm fails verification and a
// dispute can't re-prove the work. Do NOT change the prefix or the single \n —
// a new layout needs a new versioned prefix (guild-submission-v2…), never an
// edit to v1.
const SUBMISSION_PREFIX_V1 = 'guild-submission-v1\n';

/** SHA-256 (lowercase hex) of UTF-8("guild-submission-v1\n" + content). 64 hex chars. */
export async function evidenceHash(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(SUBMISSION_PREFIX_V1 + content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// FROZEN v1 — byte-identical to guild-saas/guild-app/src/lib/dispute-evidence.ts
// (DISPUTE_EVIDENCE_DOMAIN + normalizeDisputeEvidence + disputeEvidenceHash). A
// SEPARATE domain from SUBMISSION_PREFIX_V1 above — this is what `raise_dispute`
// commits as its optional evidence hash, not what `submit_task` commits. guild-app
// stores the raiser's plaintext statement off-chain (POST
// /api/v1/tasks/[id]/dispute-evidence) and re-derives this same hash from it to
// let anyone open the on-chain commitment later; the two MUST agree byte for byte
// or a stored statement can never re-prove what was actually committed. Do NOT
// change the domain string or the single \n — a new scheme needs a new versioned
// domain (guild-dispute-evidence-v2…), never an edit to v1.
const DISPUTE_EVIDENCE_DOMAIN = 'guild-dispute-evidence-v1';

/**
 * Upper bound guild-app's dispute-evidence route accepts for STORAGE. Does not
 * bound what the chain records — the commitment is 32 bytes either way — but a
 * statement over this limit can be hashed and committed on-chain and then never
 * accepted back by the storage route, leaving a commitment nothing can open.
 */
export const DISPUTE_EVIDENCE_MAX_CHARS = 2000;

/**
 * Canonical form of a dispute statement: CRLF folded to LF, leading/trailing
 * whitespace trimmed, interior formatting left exactly as written. Byte-identical
 * to guild-app's normalizeDisputeEvidence — a trailing newline a textarea adds, or
 * CRLF from a paste, must not change the hash for a reason no reader could guess.
 */
export function normalizeDisputeEvidence(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

export type DisputeEvidenceProblem = 'empty' | 'too_long';

/** Validate a statement the same way guild-app's storage route does. Returns null
 *  when it is acceptable. */
export function checkDisputeEvidence(text: string): DisputeEvidenceProblem | null {
  const normalized = normalizeDisputeEvidence(text);
  if (normalized.length === 0) return 'empty';
  if (normalized.length > DISPUTE_EVIDENCE_MAX_CHARS) return 'too_long';
  return null;
}

/**
 * The on-chain commitment for a dispute statement: SHA-256 (lowercase hex) of its
 * domain-separated, normalised preimage — UTF-8("guild-dispute-evidence-v1\n" +
 * normalizeDisputeEvidence(text)). 64 hex chars, exactly what raiseDisputeManifest
 * (manifests.ts) wraps in `Enum<1u8>(Bytes(...))`.
 */
export async function disputeEvidenceHash(text: string): Promise<string> {
  const preimage = `${DISPUTE_EVIDENCE_DOMAIN}\n${normalizeDisputeEvidence(text)}`;
  const bytes = new TextEncoder().encode(preimage);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
