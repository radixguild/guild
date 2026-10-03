/**
 * Dispute evidence — the commitment rule.
 *
 * WHAT WAS WRONG. `raise_dispute` takes an Option<Hash>. Until 2026-09-01 the
 * app filled it with sha256("dispute:task:<id>") — a commitment to a string
 * anyone can derive from the task id, so it committed to nothing, and the party
 * on the other side of a 72-hour clock got no statement of the case at all.
 *
 * WHAT MAKES THE FIX WORTH ANYTHING. We store the plaintext; the ledger stores
 * the hash. The pair is only useful if the plaintext we serve re-hashes to the
 * value on-chain — which means the client and the server must agree on the
 * preimage BYTE FOR BYTE, including normalisation. These tests pin exactly that
 * agreement, because a silent disagreement produces evidence that renders fine
 * and verifies false, which is worse than no evidence.
 */
import { describe, it, expect } from "vitest"
import {
  DISPUTE_EVIDENCE_DOMAIN,
  DISPUTE_EVIDENCE_MAX_CHARS,
  checkDisputeEvidence,
  disputeEvidenceHash,
  disputeEvidencePreimage,
  normalizeDisputeEvidence,
  sha256Hex,
} from "@/lib/dispute-evidence"

describe("normalisation happens before hashing", () => {
  it("folds CRLF so a pasted statement hashes the same as a typed one", () => {
    expect(normalizeDisputeEvidence("a\r\nb")).toBe("a\nb")
  })

  it("trims the trailing newline a textarea submit adds", () => {
    expect(normalizeDisputeEvidence("  the PR was never opened\n")).toBe(
      "the PR was never opened",
    )
  })

  it("leaves interior formatting alone — this is not a prose filter", () => {
    const text = "line one\n\n  indented detail\nline three"
    expect(normalizeDisputeEvidence(text)).toBe(text)
  })

  it("normalising twice changes nothing (idempotent, so re-hashing is safe)", () => {
    const once = normalizeDisputeEvidence("  x\r\ny  ")
    expect(normalizeDisputeEvidence(once)).toBe(once)
  })
})

describe("the preimage is domain-separated", () => {
  it("prefixes the separator so the hash cannot be replayed as another commitment", () => {
    expect(disputeEvidencePreimage("late delivery")).toBe(
      `${DISPUTE_EVIDENCE_DOMAIN}\nlate delivery`,
    )
  })

  it("is NOT a bare hash of the text — the old behaviour would collide", async () => {
    const text = "late delivery"
    expect(await disputeEvidenceHash(text)).not.toBe(await sha256Hex(text))
  })

  it("normalises inside the preimage, so whitespace cannot fork the hash", async () => {
    expect(await disputeEvidenceHash("late delivery\n")).toBe(
      await disputeEvidenceHash("  late delivery  "),
    )
  })

  it("is 64 lowercase hex characters — the shape raise_dispute accepts", async () => {
    expect(await disputeEvidenceHash("anything")).toMatch(/^[0-9a-f]{64}$/)
  })

  it("different statements commit to different hashes", async () => {
    expect(await disputeEvidenceHash("delivered nothing")).not.toBe(
      await disputeEvidenceHash("delivered late"),
    )
  })
})

describe("validation bounds what we store, not what the chain records", () => {
  it("accepts an ordinary statement", () => {
    expect(checkDisputeEvidence("The brief asked for tests; the PR has none.")).toBeNull()
  })

  it("rejects an empty statement, and whitespace counts as empty", () => {
    expect(checkDisputeEvidence("")).toBe("empty")
    expect(checkDisputeEvidence("   \n\r\n  ")).toBe("empty")
  })

  it("rejects an over-long statement", () => {
    expect(checkDisputeEvidence("x".repeat(DISPUTE_EVIDENCE_MAX_CHARS + 1))).toBe("too_long")
  })

  it("measures the length AFTER normalising, so padding cannot fail a valid statement", () => {
    const atLimit = "x".repeat(DISPUTE_EVIDENCE_MAX_CHARS)
    expect(checkDisputeEvidence(`  ${atLimit}  `)).toBeNull()
  })
})

describe("the domain separator is load-bearing", () => {
  it("is pinned — changing it silently invalidates every stored hash", () => {
    // If this fails you are about to break verification for every dispute
    // already on the ledger. That may be intentional; it may not be. Either
    // way it must be a deliberate edit to this line, not a drive-by rename.
    expect(DISPUTE_EVIDENCE_DOMAIN).toBe("guild-dispute-evidence-v1")
  })
})
