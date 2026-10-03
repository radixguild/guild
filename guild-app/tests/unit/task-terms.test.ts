import { describe, it, expect } from "vitest"
import {
  TaskTermsSchema,
  DELIVERABLE_DEFAULTS,
  DELIVERABLE_TYPES,
  LEGACY_TEMPLATE_TYPES,
  canonicalTermsBlock,
  renderContractSummary,
  hasTerms,
} from "../../src/lib/task-terms"

// The terms object is the "committed" layer of the task contract: it is
// canonicalized into the v2 work-brief hash (escrow-canonical.test.ts pins
// the composed format), so the block here must be deterministic and the
// schema strict — anything that parses must be exactly reproducible.

describe("TaskTermsSchema", () => {
  it("accepts a full valid terms object", () => {
    const parsed = TaskTermsSchema.safeParse({
      deliverableType: "code",
      reviewWindowDays: 3,
      revisionsIncluded: 1,
      repoUrl: "https://github.com/org/repo",
      specUrl: "https://github.com/org/repo/issues/42",
      acceptanceCriteria: ["PR opened", "Tests stay green"],
      definitionOfDone: ["tests-pass", "ci-green"],
      license: "mit",
      commChannel: "@bigdev_xrd",
      claimEligibility: "both",
    })
    expect(parsed.success).toBe(true)
  })

  it("rejects unknown keys (strict — they would dodge the canonical block)", () => {
    expect(TaskTermsSchema.safeParse({ surprise: "key" }).success).toBe(false)
  })

  it("rejects non-https links, out-of-range numbers, and >7 criteria", () => {
    expect(TaskTermsSchema.safeParse({ repoUrl: "http://insecure.example" }).success).toBe(false)
    expect(TaskTermsSchema.safeParse({ reviewWindowDays: 0 }).success).toBe(false)
    expect(TaskTermsSchema.safeParse({ revisionsIncluded: 4 }).success).toBe(false)
    expect(
      TaskTermsSchema.safeParse({ acceptanceCriteria: Array(8).fill("a criterion") }).success,
    ).toBe(false)
  })

  it("every deliverable-type default parses (the prefills must never 400)", () => {
    for (const type of DELIVERABLE_TYPES) {
      expect(TaskTermsSchema.safeParse(DELIVERABLE_DEFAULTS[type]).success).toBe(true)
    }
  })

  it("every legacy #143 template id maps to a real deliverable type", () => {
    for (const type of Object.values(LEGACY_TEMPLATE_TYPES)) {
      expect(DELIVERABLE_TYPES).toContain(type)
    }
  })
})

describe("canonicalTermsBlock (deterministic — feeds the on-chain hash)", () => {
  it("renders keys in FIXED order regardless of object key order", () => {
    const a = canonicalTermsBlock({ revisionsIncluded: 1, deliverableType: "code" })
    const b = canonicalTermsBlock({ deliverableType: "code", revisionsIncluded: 1 })
    expect(a).toBe(b)
    expect(a).toBe("type: code\nrevisions: 1")
  })

  it("omits absent fields entirely and returns '' for empty terms", () => {
    expect(canonicalTermsBlock({})).toBe("")
    expect(canonicalTermsBlock(null)).toBe("")
    expect(canonicalTermsBlock(undefined)).toBe("")
  })

  it("puts the due date first (single source of truth: the deadline column)", () => {
    expect(canonicalTermsBlock({ deliverableType: "ops" }, { dueIso: "2026-08-01T12:00:00.000Z" }))
      .toBe("due: 2026-08-01\ntype: ops")
  })

  it("sorts definition-of-done and normalizes whitespace in free text", () => {
    const block = canonicalTermsBlock({
      definitionOfDone: ["tests-pass", "ci-green"],
      commChannel: "  @some   handle  ",
    })
    expect(block).toBe("done: ci-green, tests-pass\ncontact: @some handle")
  })

  it("renders criteria as dashed lines", () => {
    expect(canonicalTermsBlock({ acceptanceCriteria: ["First thing", "Second thing"] })).toBe(
      "criteria:\n- First thing\n- Second thing",
    )
  })

  // PR C extension — new keys append at the END of the block (frozen-format
  // rule): pre-C briefs never carried the key, so their bytes are untouched.
  it("renders min-trust last, after claim", () => {
    expect(
      canonicalTermsBlock({ claimEligibility: "both", minTrustTier: "established" }),
    ).toBe("claim: both\nmin-trust: established")
  })

  it("rejects 'new' as a stored min trust tier (no gate = absent key)", () => {
    expect(TaskTermsSchema.safeParse({ minTrustTier: "new" }).success).toBe(false)
    expect(TaskTermsSchema.safeParse({ minTrustTier: "established" }).success).toBe(true)
    expect(TaskTermsSchema.safeParse({ minTrustTier: "top_rated" }).success).toBe(true)
  })
})

// ⚠️ 2026-08-29: minTrustTier was demoted from an app-enforced gate to a
  // stated preference. These tests are the teeth on that change in BOTH
  // directions — they fail if the exclusivity wording comes back, and they
  // fail if the preference stops being rendered at all.
  describe("minTrustTier renders as a preference, never as a gate", () => {
    for (const tier of ["established", "top_rated"] as const) {
      it(`states ${tier} is not enforced`, () => {
        const lines = renderContractSummary({ rewardXrd: 10, insuranceXrd: 0.5, terms: { minTrustTier: tier } })
        const joined = lines.join(" ")
        expect(joined).toMatch(/not enforced/i)
        expect(joined).toMatch(/anyone can claim/i)
        // The banned shape: any claim of exclusivity.
        expect(joined).not.toMatch(/\bonly\b/i)
        expect(joined).not.toMatch(/open to .* builders only/i)
      })
    }

    it("still says nothing at all when the poster set no preference", () => {
      const joined = renderContractSummary({ rewardXrd: 10, insuranceXrd: 0.5, terms: {} }).join(" ")
      expect(joined).not.toMatch(/preference/i)
    })
  })

describe("hasTerms / renderContractSummary", () => {
  it("hasTerms is false for null/empty and true once any term is set", () => {
    expect(hasTerms(null)).toBe(false)
    expect(hasTerms({})).toBe(false)
    expect(hasTerms({ revisionsIncluded: 0 })).toBe(true)
  })

  it("summary always states the escrow lock and the hash commitment", () => {
    const lines = renderContractSummary({ rewardXrd: 500, insuranceXrd: 25, terms: {} })
    expect(lines[0]).toContain("500 XRD reward + 25 XRD insurance")
    expect(lines[lines.length - 1]).toContain("hashed and committed on-chain")
  })

  it("renders the zero-revisions case unambiguously", () => {
    const lines = renderContractSummary({
      rewardXrd: 100,
      insuranceXrd: 5,
      terms: { revisionsIncluded: 0 },
    })
    expect(lines.join("\n")).toContain("No revision rounds included")
  })

  // Reward-resource flip prep: omitting rewardResource must render byte-for-
  // byte identical to before (every existing caller), and a caller with a
  // task's rewardResource in scope gets that unit instead of a hardcoded XRD —
  // in both the rateless legacy string AND the formatXrdUsd dual label.
  describe("rewardResource (reward-resource flip prep)", () => {
    it("omitted → defaults to XRD, unchanged from before", () => {
      const lines = renderContractSummary({ rewardXrd: 500, insuranceXrd: 25, terms: {} })
      expect(lines[0]).toContain("500 XRD reward + 25 XRD insurance")
    })

    it("null → still defaults to XRD", () => {
      const lines = renderContractSummary({
        rewardXrd: 500,
        insuranceXrd: 25,
        terms: {},
        rewardResource: null,
      })
      expect(lines[0]).toContain("500 XRD reward + 25 XRD insurance")
    })

    it("a non-XRD resource replaces the unit in the rateless (no usdRate) path", () => {
      const lines = renderContractSummary({
        rewardXrd: 500,
        insuranceXrd: 25,
        terms: {},
        rewardResource: "USDC",
      })
      expect(lines[0]).toContain("500 USDC reward + 25 USDC insurance")
      expect(lines[0]).not.toContain("XRD")
    })

    it("a non-XRD resource replaces the unit when a usdRate is also given", () => {
      const lines = renderContractSummary({
        rewardXrd: 500,
        insuranceXrd: 25,
        terms: {},
        usdRate: 0.05,
        rewardResource: "USDC",
      })
      expect(lines[0]).toContain("USDC")
      expect(lines[0]).not.toContain("XRD")
    })
  })
})
