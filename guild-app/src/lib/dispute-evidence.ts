/**
 * Dispute evidence — the preimage rule, shared by the client that commits it
 * on-chain and the server that stores it.
 *
 * THE PROBLEM THIS SOLVES. `raise_dispute` takes an `Option<Hash>`: 32 bytes,
 * not a message. Until 2026-09-01 the app hashed the literal
 * `dispute:task:<id>` and put THAT on-chain — a commitment to a value anyone
 * could derive from the task id, which commits to nothing. Meanwhile the party
 * on the other side of a 72-hour auto-resolve clock was given no statement of
 * what they were accused of, because there was nowhere to put one.
 *
 * THE RULE. The on-chain hash is SHA-256 over a domain-separated preimage. The
 * separator matters for the same reason it does on the work brief
 * (`guild-submission-v1`): a bare hash of user text can be replayed as a
 * commitment in some other context that also hashes user text. Prefixing binds
 * this hash to this meaning.
 *
 * WHAT VERIFICATION LOOKS LIKE, and why it is worth having. We store the
 * plaintext; the ledger stores the hash. Anyone can take the plaintext from the
 * API, run it through this function, and compare against the RaiseDisputeEvent
 * on-chain. That makes us the CUSTODIAN of the text and not an authority on it:
 * if we ever edited a word — or an operator did — the hashes stop matching and
 * the ledger is the one that gets believed. This is the whole reason the
 * plaintext is worth storing at all.
 */

/** Domain separator. Changing this invalidates every stored hash — don't. */
export const DISPUTE_EVIDENCE_DOMAIN = "guild-dispute-evidence-v1"

/**
 * Upper bound on the stored statement. Generous enough for a real account of
 * what went wrong, small enough that the column is not a file host. The hash is
 * 32 bytes either way — this bounds what WE keep, not what the chain records.
 */
export const DISPUTE_EVIDENCE_MAX_CHARS = 2000

/** The exact bytes that get hashed. Both sides must call this, never sha256 the
 *  raw text — that is how a client and a server silently disagree. */
export function disputeEvidencePreimage(text: string): string {
  return `${DISPUTE_EVIDENCE_DOMAIN}\n${normalizeDisputeEvidence(text)}`
}

/**
 * Canonical form of the statement.
 *
 * Normalisation happens BEFORE hashing and is stored in the same form, so the
 * plaintext we serve always re-hashes to the value on-chain. Without this, a
 * trailing newline the browser adds on submit — or CRLF from a paste — changes
 * the hash and breaks verification for a reason no reader could ever guess.
 * CRLF is folded, and leading/trailing whitespace trimmed; interior formatting
 * is left exactly as written.
 */
export function normalizeDisputeEvidence(text: string): string {
  return text.replace(/\r\n/g, "\n").trim()
}

export type DisputeEvidenceProblem = "empty" | "too_long"

/** Validate a statement for storage. Returns null when it is acceptable. */
export function checkDisputeEvidence(text: string): DisputeEvidenceProblem | null {
  const normalized = normalizeDisputeEvidence(text)
  if (normalized.length === 0) return "empty"
  if (normalized.length > DISPUTE_EVIDENCE_MAX_CHARS) return "too_long"
  return null
}

/** 32-byte SHA-256 (lowercase hex) of a UTF-8 string. Duplicated from
 *  escrow-utils rather than imported: that module pulls in the Radix dApp
 *  Toolkit, which must never be dragged into a server route. WebCrypto is
 *  present in both runtimes, so the implementation is genuinely identical. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** The on-chain commitment for a statement: SHA-256 of its domain-separated,
 *  normalised preimage. */
export async function disputeEvidenceHash(text: string): Promise<string> {
  return sha256Hex(disputeEvidencePreimage(text))
}
