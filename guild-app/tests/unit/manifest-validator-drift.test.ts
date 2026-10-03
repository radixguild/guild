import { describe, it, expect } from "vitest"
import {
  approveAndReleaseManifest,
  createTaskManifest,
  mintAgentBadgeManifest,
} from "@/lib/manifests"

/**
 * The manifest builders exist in TWO packages — guild-app/src/lib/manifests.ts and
 * packages/agent-client/src/manifests.ts — and their validators have drifted
 * before: agent-client was hardened first and guild-app, which builds the
 * manifests the UI actually signs, kept the weaker checks. These tests pin the
 * hardened behaviour on the guild-app side so the copies cannot silently diverge
 * again.
 */

const COMPONENT = "component_rdx1cr690hkrk2kv933cw3qdr6amkaphdlu2whjhhh8wppus922yx335r2"
const POSTER = "account_rdx12ynlx369jmpfg23n709g0w7fuk0wwe0lft6h5r0m8sksdjpg858g0z"
const WORKER = "account_rdx12890803ct999t5ss4qatjyktay82gfy295rr6p4qmhks8twekeqgp9"
const RECEIPT = "resource_rdx1n2rurpe2efyur5xqvz256yyhecpfjw8ed9v8xxcfxp5mtj9qld9ssq"
const OWNER_BADGE = "resource_rdx1thnh5cuyv0uspqgnfgt6c0w5gsn2j4wjc8f9mzztrg9xjqyvmkafcp"

describe("validateAddress is anchored (no manifest injection)", () => {
  // Without a trailing `$` the pattern matches a valid prefix followed by
  // ANYTHING, so a crafted value escapes `Address("…")` and appends its own
  // instructions to a real money manifest.
  const INJECTION =
    'account_rdx1aaaaaaaaaaaaaaaaaaaa")\n;\nCALL_METHOD\n  Address("account_rdx1attackerxxxxxxxxxxxxxxx")\n  "deposit_batch"\n  Expression("ENTIRE_WORKTOP")\n;\nCALL_METHOD\n  Address("x'

  // S3 deleted approveAndReleaseLegacyPushManifest, which was this file's
  // vehicle. The subject was never that builder — it is validateAddress — so the
  // tests moved to approveAndReleaseManifest, which validates an account_rdx the
  // same way. The push builder took a SEPARATE worker address to route the reward
  // to; the pull builder has none, because the blueprint pays the account it
  // pinned at claim. So the injection is aimed at the poster account instead: the
  // one caller-supplied address that still reaches a manifest.
  it("rejects an address carrying injected instructions", () => {
    expect(() =>
      approveAndReleaseManifest(COMPONENT, INJECTION, RECEIPT, 7),
    ).toThrow(/Invalid account_rdx address/)
  })

  it("rejects trailing whitespace and uppercase (real addresses are lowercase bech32m)", () => {
    expect(() => approveAndReleaseManifest(COMPONENT, `${POSTER} `, RECEIPT, 7)).toThrow()
    expect(() => approveAndReleaseManifest(COMPONENT, POSTER.toUpperCase(), RECEIPT, 7)).toThrow()
  })

  it("still accepts every real address unchanged", () => {
    const m = approveAndReleaseManifest(COMPONENT, POSTER, RECEIPT, 7)
    expect(m).toContain(`Address("${POSTER}")`)
    expect(m).toContain(`Address("${COMPONENT}")`)
  })
})

describe("validatePositiveInt refuses ids past the exactly-representable range", () => {
  // Number.isInteger stays true past MAX_SAFE_INTEGER, but the value is no longer
  // exact — `${n}u64` would name a DIFFERENT task than intended.
  it("rejects a task id beyond MAX_SAFE_INTEGER", () => {
    expect(() =>
      createTaskManifest(COMPONENT, POSTER, 5, 1, "0", "a".repeat(64)),
    ).not.toThrow() // sanity: the valid case builds
    expect(() =>
      approveAndReleaseManifest(COMPONENT, POSTER, RECEIPT, Number.MAX_SAFE_INTEGER + 2),
    ).toThrow(/positive integer/)
  })

  it("accepts the largest exactly-representable id", () => {
    expect(() =>
      approveAndReleaseManifest(COMPONENT, POSTER, RECEIPT, Number.MAX_SAFE_INTEGER),
    ).not.toThrow()
  })
})

describe("deposit_batch is only ever aimed at the transaction signer", () => {
  // Account::deposit_batch is _owner_-restricted; a non-signer destination reverts
  // the whole transaction with an AuthError. Non-signers need the public
  // try_deposit_*_or_abort form.
  it("the agent-badge mint routes to the agent via the public deposit variant", () => {
    const m = mintAgentBadgeManifest(
      COMPONENT,
      POSTER, // owner — signs, via create_proof_of_amount
      OWNER_BADGE,
      WORKER, // agent — NOT the signer
      "alice_agent",
      WORKER,
      "100",
      "500",
    )
    expect(m).toContain(`"try_deposit_batch_or_abort"`)
    expect(m).not.toContain(`"deposit_batch"`)
  })
})
