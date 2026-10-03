import { describe, it, expect } from "vitest"
import { createHash } from "node:crypto"
import {
  canonicalWorkBrief,
  canonicalWorkBriefV2,
  canonicalSubmissionEvidence,
  sha256Hex,
} from "../../src/lib/escrow-utils"
import { canonicalTermsBlock } from "../../src/lib/task-terms"

// ─────────────────────────────────────────────────────────────────────────────
// Commitment canonicalization — v1 is FROZEN.
//
// The on-chain escrow stores 32-byte hashes of these canonical strings
// (create_task → work brief, submit_task → submission evidence). They must be
// re-derivable byte-for-byte years from now to verify a DB brief/submission
// against the chain, so every assertion here pins the EXACT v1 format and
// known SHA-256 vectors. If any of these tests fail, the format drifted —
// that is a breaking change to deployed commitments: revert it (or introduce
// a v2 prefix instead of altering v1).
// ─────────────────────────────────────────────────────────────────────────────

// Independent oracle: node:crypto (sha256Hex uses WebCrypto). Each pinned
// vector below is asserted against BOTH implementations, so a drifted pin,
// hasher, or canonical format all fail loudly.
const nodeSha256 = (s: string) =>
  createHash("sha256").update(s, "utf8").digest("hex")

// Frozen vectors (sha256 of the exact canonical strings spelled out inline).
const BRIEF_INPUT =
  "guild-task-brief-v1\nDesign a logo\n\nA clean vector logo for the guild."
const BRIEF_HASH =
  "57f1107c835e9d60fa05f48ba1a98cbc754865a99f3b8421e78985c4600dbe3f"
const EVIDENCE_INPUT = "guild-submission-v1\nhttps://github.com/guild/site/pull/42"
const EVIDENCE_HASH =
  "285e811f5b609771603db4078c0d76f0bc7219b8441d941dc9fe69eb384e2969"
const UNICODE_INPUT = "guild-submission-v1\nRévision finale ✅"
const UNICODE_HASH =
  "ae8522c313a45ecda9980a1163e32f2d798038929a786ccb75e9b73480636f90"
// FIPS 180-2 appendix B.1 — pins the hasher itself.
const ABC_HASH =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

describe("canonicalWorkBrief (v1 — frozen format)", () => {
  it("produces exactly prefix\\ntitle\\n\\ndescription", () => {
    expect(
      canonicalWorkBrief("Design a logo", "A clean vector logo for the guild."),
    ).toBe(BRIEF_INPUT)
  })

  it("keeps empty fields positional (prefix + three newlines)", () => {
    expect(canonicalWorkBrief("", "")).toBe("guild-task-brief-v1\n\n\n")
  })

  it("never trims or normalizes the inputs", () => {
    expect(canonicalWorkBrief("  a  ", "\nb\n")).toBe(
      "guild-task-brief-v1\n  a  \n\n\nb\n",
    )
  })
})

describe("canonicalSubmissionEvidence (v1 — frozen format)", () => {
  it("produces exactly prefix\\ncontent", () => {
    expect(
      canonicalSubmissionEvidence("https://github.com/guild/site/pull/42"),
    ).toBe(EVIDENCE_INPUT)
  })

  it("keeps empty content positional (prefix + one newline)", () => {
    expect(canonicalSubmissionEvidence("")).toBe("guild-submission-v1\n")
  })
})

describe("sha256Hex (the on-chain commitment hash)", () => {
  it("matches the FIPS 180-2 'abc' vector", async () => {
    expect(await sha256Hex("abc")).toBe(ABC_HASH)
  })

  it("emits 64 lowercase hex chars (manifest Bytes() format)", async () => {
    expect(await sha256Hex("anything")).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("composed commitments (pinned — guard against any drift)", () => {
  it("work-brief commitment is stable", async () => {
    // Oracle agreement: the pinned hex is what node:crypto derives from the
    // frozen literal…
    expect(nodeSha256(BRIEF_INPUT)).toBe(BRIEF_HASH)
    // …and what the app's own canonicalize→hash path produces.
    expect(
      await sha256Hex(
        canonicalWorkBrief("Design a logo", "A clean vector logo for the guild."),
      ),
    ).toBe(BRIEF_HASH)
  })

  it("submission-evidence commitment is stable", async () => {
    expect(nodeSha256(EVIDENCE_INPUT)).toBe(EVIDENCE_HASH)
    expect(
      await sha256Hex(
        canonicalSubmissionEvidence("https://github.com/guild/site/pull/42"),
      ),
    ).toBe(EVIDENCE_HASH)
  })

  it("hashes UTF-8 bytes (unicode content is stable)", async () => {
    expect(nodeSha256(UNICODE_INPUT)).toBe(UNICODE_HASH)
    expect(await sha256Hex(canonicalSubmissionEvidence("Révision finale ✅"))).toBe(
      UNICODE_HASH,
    )
  })

  it("domain-separates briefs from submissions (versioned prefixes)", async () => {
    const payload = "identical payload"
    expect(await sha256Hex(canonicalWorkBrief(payload, payload))).not.toBe(
      await sha256Hex(canonicalSubmissionEvidence(payload)),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// v2 work brief — v1's layout + the structured-terms block (FROZEN once
// shipped, same contract as v1). Only committed when terms exist, so every
// pre-terms task keeps re-deriving its v1 hash forever.
// ─────────────────────────────────────────────────────────────────────────────

const BRIEF_V2_INPUT =
  "guild-task-brief-v2\nDesign a logo\n\nA clean vector logo for the guild.\n\n-- terms --\ndue: 2026-07-01\ntype: design\ncriteria:\n- Source files delivered\nrevisions: 2\nlicense: assigned-on-payment"
const BRIEF_V2_HASH =
  "9b68e278ecbe0a393fef183cb971a4b4e4674dd8a5ebf2ec272cdb957419a25c"

describe("canonicalWorkBriefV2 (frozen format)", () => {
  const terms = {
    deliverableType: "design" as const,
    revisionsIncluded: 2,
    license: "assigned-on-payment" as const,
    acceptanceCriteria: ["Source files delivered"],
  }

  it("produces exactly prefix\\ntitle\\n\\ndescription\\n\\n-- terms --\\nblock", () => {
    expect(
      canonicalWorkBriefV2(
        "Design a logo",
        "A clean vector logo for the guild.",
        canonicalTermsBlock(terms, { dueIso: "2026-07-01T00:00:00.000Z" }),
      ),
    ).toBe(BRIEF_V2_INPUT)
  })

  it("composed v2 commitment is stable (oracle agreement + pinned vector)", async () => {
    expect(nodeSha256(BRIEF_V2_INPUT)).toBe(BRIEF_V2_HASH)
    expect(
      await sha256Hex(
        canonicalWorkBriefV2(
          "Design a logo",
          "A clean vector logo for the guild.",
          canonicalTermsBlock(terms, { dueIso: "2026-07-01T00:00:00.000Z" }),
        ),
      ),
    ).toBe(BRIEF_V2_HASH)
  })

  it("v1 and v2 of the same title+description never collide", async () => {
    const v1 = await sha256Hex(canonicalWorkBrief("t", "d"))
    const v2 = await sha256Hex(canonicalWorkBriefV2("t", "d", ""))
    expect(v1).not.toBe(v2)
  })
})
