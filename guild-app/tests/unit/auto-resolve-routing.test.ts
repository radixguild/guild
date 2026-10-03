import { describe, it, expect } from "vitest"
import { autoResolveDisputeManifest, autoResolveRuling } from "@/lib/manifests"

/**
 * H1 — history, and why this file shrank.
 *
 * Under the PUSH escrow, auto_resolve_dispute handed both settlement buckets
 * back to the CALLER's worktop and the manifest routed them. The finalize
 * builder once hard-routed everything to the dispute raiser (correct only
 * under FavorDisputeRaiser) while the live component was configured
 * SplitEvenly — that mismatch was H1, and this file held the routing tests
 * that pinned the fix: exact BigInt split math, remainder-to-counterparty,
 * try_deposit_batch_or_abort for non-caller destinations.
 *
 * Under PULL none of that routing EXISTS to test. auto_resolve_dispute
 * returns `()`, the component credits both entitlements internally, and the
 * manifest is a single bare call — the H1 class is closed structurally, not
 * behaviourally. What remains testable here:
 *
 *   1. autoResolveRuling still mirrors lib.rs — it now only PREDICTS the
 *      ruling (keeper alerts, harness logs, gate1-e2e expectations), and a
 *      wrong prediction misreports a settlement even if it can't misroute one.
 *   2. The finalize manifest exposes no routing surface at all — the
 *      assertions that would have caught H1 now assert the surface is gone.
 *
 * (Worktop-flow vs the scraped ABI — no TAKE after a ()-returning call — is
 * gated for EVERY builder in manifest-abi-gate.test.ts.)
 */

const COMPONENT = "component_rdx1cr690hkrk2kv933cw3qdr6amkaphdlu2whjhhh8wppus922yx335r2"

describe("autoResolveRuling mirrors the blueprint's ruling derivation", () => {
  it("FavorDisputeRaiser maps the raiser to the paying ruling", () => {
    expect(autoResolveRuling("FavorDisputeRaiser", "Worker")).toBe("PayWorker")
    expect(autoResolveRuling("FavorDisputeRaiser", "Poster")).toBe("RefundPoster")
  })

  it("SplitEvenly is always Split, regardless of who raised", () => {
    expect(autoResolveRuling("SplitEvenly", "Worker")).toBe("Split")
    expect(autoResolveRuling("SplitEvenly", "Poster")).toBe("Split")
  })

  it("ReturnToPoster is always RefundPoster, regardless of who raised", () => {
    expect(autoResolveRuling("ReturnToPoster", "Worker")).toBe("RefundPoster")
    expect(autoResolveRuling("ReturnToPoster", "Poster")).toBe("RefundPoster")
  })
})

describe("the pull finalize manifest has no routing surface", () => {
  it("emits the bare trigger and nothing else", () => {
    expect(autoResolveDisputeManifest(COMPONENT, 7)).toBe(`CALL_METHOD
  Address("${COMPONENT}")
  "auto_resolve_dispute"
  7u64
;`)
  })

  it("names no account, takes nothing, deposits nothing", () => {
    // Each of these strings was load-bearing in the push-era builder; each one
    // reappearing would mean a caller-routing surface came back.
    const m = autoResolveDisputeManifest(COMPONENT, 7)
    expect(m).not.toContain("account_rdx")
    expect(m).not.toContain("TAKE_FROM_WORKTOP")
    expect(m).not.toContain("deposit")
    expect(m).not.toContain("Bucket(")
  })

  it("accepts no party accounts or amounts — the routing surface is gone from the signature too", () => {
    // Arity pin: (escrowComponent, taskId). A third parameter is how H1's
    // surface would sneak back in.
    expect(autoResolveDisputeManifest.length).toBe(2)
  })
})
