/**
 * Unit tests for Zod validation schemas.
 *
 * Tests happy path, edge cases, and error cases for all request body schemas.
 */
import { describe, it, expect } from "vitest"
import {
  createTaskSchema,
  updateTaskSchema,
  createSubmissionSchema,
  reviewSubmissionSchema,
  verifyAuthSchema,
  createFundingPoolSchema,
  pledgeFundingPoolSchema,
} from "@/lib/validation"
import { MIN_REWARD_XRD } from "@/lib/marketplace"

describe("createTaskSchema", () => {
  const valid = {
    title: "Fix bug in auth",
    description: "The auth flow fails when...",
    reward_amount: "100.5",
  }

  it("accepts valid task", () => {
    expect(createTaskSchema.safeParse(valid).success).toBe(true)
  })

  it("accepts with optional fields", () => {
    const result = createTaskSchema.safeParse({
      ...valid,
      deadline: "2026-06-01T00:00:00.000Z",
      requirements: "Must have experience",
    })
    expect(result.success).toBe(true)
  })

  it("rejects empty title", () => {
    expect(createTaskSchema.safeParse({ ...valid, title: "" }).success).toBe(false)
  })

  it("rejects title over 200 chars", () => {
    expect(
      createTaskSchema.safeParse({ ...valid, title: "x".repeat(201) }).success,
    ).toBe(false)
  })

  it("rejects empty description", () => {
    expect(
      createTaskSchema.safeParse({ ...valid, description: "" }).success,
    ).toBe(false)
  })

  it("rejects invalid XRD amount format", () => {
    expect(
      createTaskSchema.safeParse({ ...valid, reward_amount: "abc" }).success,
    ).toBe(false)
  })

  it("rejects XRD amount with > 8 decimal places", () => {
    expect(
      createTaskSchema.safeParse({ ...valid, reward_amount: "1.123456789" }).success,
    ).toBe(false)
  })

  it("accepts XRD amount with exactly 8 decimal places", () => {
    expect(
      createTaskSchema.safeParse({ ...valid, reward_amount: "1.12345678" }).success,
    ).toBe(true)
  })

  it("accepts whole number XRD amount", () => {
    expect(
      createTaskSchema.safeParse({ ...valid, reward_amount: "100" }).success,
    ).toBe(true)
  })

  it("rejects negative XRD amount", () => {
    expect(
      createTaskSchema.safeParse({ ...valid, reward_amount: "-10" }).success,
    ).toBe(false)
  })

  it("rejects missing required fields", () => {
    expect(createTaskSchema.safeParse({}).success).toBe(false)
    expect(createTaskSchema.safeParse({ title: "x" }).success).toBe(false)
  })
})

describe("updateTaskSchema", () => {
  it("accepts partial update", () => {
    expect(updateTaskSchema.safeParse({ title: "New title" }).success).toBe(true)
  })

  it("accepts empty object (no changes)", () => {
    expect(updateTaskSchema.safeParse({}).success).toBe(true)
  })

  it("rejects invalid reward_amount", () => {
    expect(
      updateTaskSchema.safeParse({ reward_amount: "not-a-number" }).success,
    ).toBe(false)
  })
})

// The reward FLOOR — the API half of the (0, 1) XRD defect. The live escrow
// registered XRD with min_amount 1 and `create_task` asserts
// `reward_amount >= min_amount` ("reward below per-token minimum"). Until
// 2026-09-17 both schemas were shape-only, so "0.5" got a 201 and a task row
// whose funding tx could only revert. Run against BOTH schemas from one table,
// because a floor on create alone has a side door: post at "1", PATCH to "0.5".
//
// Falsifiable, per schema: delete the `.refine(...)` from rewardAmountSchema
// and every "refuses" case below fails for create AND update; point only
// updateTaskSchema back at a bare regex and only its half fails — which is the
// mutation that proves the PATCH door is separately guarded.
describe.each([
  [
    "createTaskSchema (POST /api/v1/tasks)",
    (reward_amount: string) =>
      createTaskSchema.safeParse({ title: "Fix bug in auth", description: "The auth flow fails when...", reward_amount }),
  ],
  ["updateTaskSchema (PATCH /api/v1/tasks/[id])", (reward_amount: string) => updateTaskSchema.safeParse({ reward_amount })],
] as const)("reward floor — %s", (_name, parse) => {
  const minIssue = (reward: string) => {
    const r = parse(reward)
    if (r.success) return null
    return r.error.issues.find((i) => i.path.join(".") === "reward_amount" && /at least/.test(i.message)) ?? null
  }

  it.each([["0.5"], ["0.99999999"], ["0.00000001"], ["00.5"]])(
    "refuses %s — positive, well-formed, and unfundable on chain",
    (reward) => {
      expect(parse(reward).success).toBe(false)
      // …and says WHY, naming the number: a caller told only "invalid" for a
      // perfectly well-formed decimal has nothing to act on.
      expect(minIssue(reward)?.message).toContain(`at least ${MIN_REWARD_XRD} XRD`)
    },
  )

  it("the floor is inclusive, and exact at the schema's full 8dp", () => {
    expect(parse(MIN_REWARD_XRD).success).toBe(true)
    expect(parse("1.00000000").success).toBe(true)
    expect(parse("1.00000001").success).toBe(true)
    expect(parse("0.99999999").success).toBe(false)
  })

  // DELIBERATE, not an oversight — see rewardAmountSchema's note. A zero-reward
  // row is the unfunded off-chain lane (never sent to create_task, exempt from
  // the funded minimum by decision F3). The refused band is (0, min), open at 0.
  it.each([["0"], ["0.0"], ["0.00000000"]])("still accepts %s — the unfunded off-chain lane is not the defect", (reward) => {
    expect(parse(reward).success).toBe(true)
  })

  // zod 4 runs refinements even after an earlier check on the same schema has
  // failed, so the floor's predicate IS handed "abc". It must neither throw
  // (that escapes safeParse as a 500) nor pile a misleading "at least 1 XRD"
  // onto input whose actual problem is its shape.
  it.each([["abc"], ["-10"], ["1e3"], [""], ["1.123456789"], [" 5"]])(
    "malformed %j is refused for its SHAPE only — no throw, no floor message",
    (reward) => {
      let result: ReturnType<typeof parse> | undefined
      expect(() => {
        result = parse(reward)
      }).not.toThrow()
      expect(result!.success).toBe(false)
      expect(minIssue(reward)).toBeNull()
    },
  )
})

describe("createFundingPoolSchema — target_xrd positivity (FIX 3)", () => {
  const base = { title: "Repave the docs site", description: "Community-funded infra work." }

  it("accepts a positive target", () => {
    expect(createFundingPoolSchema.safeParse({ ...base, target_xrd: "100" }).success).toBe(true)
    expect(
      createFundingPoolSchema.safeParse({ ...base, target_xrd: "0.000000000000000001" }).success,
    ).toBe(true)
  })

  it("REGRESSION: rejects target_xrd=\"0\" — a zero-target pool has pooledXrd === " +
     "targetXrd on creation, so every pledge is rejected OVER_TARGET and the " +
     "pool can never reach `funded`", () => {
    const result = createFundingPoolSchema.safeParse({ ...base, target_xrd: "0" })
    expect(result.success).toBe(false)
  })

  it("rejects zero written with trailing decimal zeros too", () => {
    expect(createFundingPoolSchema.safeParse({ ...base, target_xrd: "0.0" }).success).toBe(false)
    expect(
      createFundingPoolSchema.safeParse({ ...base, target_xrd: "0.000000000000000000" }).success,
    ).toBe(false)
  })

  it("still rejects a negative or malformed target (unchanged pre-existing behavior)", () => {
    expect(createFundingPoolSchema.safeParse({ ...base, target_xrd: "-5" }).success).toBe(false)
    expect(createFundingPoolSchema.safeParse({ ...base, target_xrd: "abc" }).success).toBe(false)
  })

  // The guard lives on createFundingPoolSchema specifically, not on the
  // xrdAmountSchema it shares with pledgeFundingPoolSchema — a pledge of "0"
  // is already caught downstream by applyPledge's own isPositiveXrd check
  // (funding-state-machine.ts), and that path carries pledge-specific
  // context a bare schema regex can't. This test documents that the shared
  // regex itself still permits "0" syntactically, so a future refactor
  // doesn't accidentally "fix" positivity in the wrong, shared place.
  it("does NOT reject amount_xrd=\"0\" at the shared-schema level (pledge's own state machine guards it)", () => {
    expect(pledgeFundingPoolSchema.safeParse({ amount_xrd: "0" }).success).toBe(true)
  })
})

describe("createSubmissionSchema", () => {
  it("accepts valid submission", () => {
    expect(
      createSubmissionSchema.safeParse({ content: "Here is my work..." }).success,
    ).toBe(true)
  })

  it("rejects empty content", () => {
    expect(createSubmissionSchema.safeParse({ content: "" }).success).toBe(false)
  })

  it("rejects content over 10000 chars", () => {
    expect(
      createSubmissionSchema.safeParse({ content: "x".repeat(10001) }).success,
    ).toBe(false)
  })
})

describe("reviewSubmissionSchema", () => {
  it("accepts approved", () => {
    expect(
      reviewSubmissionSchema.safeParse({ status: "approved" }).success,
    ).toBe(true)
  })

  it("accepts rejected with notes", () => {
    const result = reviewSubmissionSchema.safeParse({
      status: "rejected",
      reviewer_notes: "Needs more detail",
    })
    expect(result.success).toBe(true)
  })

  it("accepts revision_requested", () => {
    expect(
      reviewSubmissionSchema.safeParse({ status: "revision_requested" }).success,
    ).toBe(true)
  })

  it("rejects invalid status", () => {
    expect(
      reviewSubmissionSchema.safeParse({ status: "invalid" }).success,
    ).toBe(false)
  })
})

describe("verifyAuthSchema", () => {
  const valid = {
    signed_challenge: {
      challenge: "abc123",
      address: "account_rdx12test",
      proof: {
        publicKey: "00".repeat(33),
        signature: "ab".repeat(64),
        curve: "curve25519" as const,
      },
      type: "account" as const,
    },
  }

  it("accepts valid signed challenge", () => {
    expect(verifyAuthSchema.safeParse(valid).success).toBe(true)
  })

  it("rejects missing fields", () => {
    expect(verifyAuthSchema.safeParse({}).success).toBe(false)
    expect(
      verifyAuthSchema.safeParse({ signed_challenge: {} }).success,
    ).toBe(false)
  })

  it("rejects invalid curve", () => {
    const invalid = {
      signed_challenge: {
        ...valid.signed_challenge,
        proof: { ...valid.signed_challenge.proof, curve: "invalid" },
      },
    }
    expect(verifyAuthSchema.safeParse(invalid).success).toBe(false)
  })

  it("rejects invalid type", () => {
    const invalid = {
      signed_challenge: { ...valid.signed_challenge, type: "invalid" },
    }
    expect(verifyAuthSchema.safeParse(invalid).success).toBe(false)
  })
})
