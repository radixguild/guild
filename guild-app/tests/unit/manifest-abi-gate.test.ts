// The manifest↔ABI gate — every escrow CALL_METHOD a builder emits must match
// the blueprint's scraped signature, positionally, by argument KIND.
//
// WHY THIS GATE EXISTS (P1-5, 2026-08-09)
// ---------------------------------------
// Three poster-side builders passed a `Bucket` where the PULL blueprint takes a
// `Proof`, and NOTHING in CI could have caught it: the app↔agent-client
// byte-parity suite compares the two builder copies to EACH OTHER. They agreed,
// because both were updated together — agreement between two artifacts is not
// correctness of either. The defect was found by Gateway preview against a live
// mainnet component, at the cost of a deploy. This file is the missing third
// leg: builders vs `lib.rs` itself, using the SAME scraper the method-inventory
// gate already trusts (a gate that reimplements its parser is a test of the
// reimplementation).
//
// WHAT A GREEN RUN PROVES, EXACTLY
// -------------------------------
// For every gated builder: each CALL_METHOD it emits against the escrow
// component names a method that exists in `lib.rs`, with the right argument
// COUNT and each argument of the right manifest KIND (Proof vs Bucket vs u64 vs
// Decimal vs Bytes vs Enum vs Address). That is precisely the class that
// escaped. PLUS one leg of worktop flow (added with the dispute-lane fix):
// after an escrow call whose scraped RETURN carries no Bucket, a builder may
// not TAKE from the worktop — the dispute finalize builders emitted exactly
// those dead legs, and this file's argument-kind checks passed them because
// the CALL args were right while the flow around them was push-era. It still
// does NOT prove amounts, per-leg routing, or auth — those stay with the unit
// tests, ledger tests, and preview-manifest.mjs.

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { scrapeMethods } from "../../scripts/lib/blueprint-methods.mjs"
import * as manifests from "../../src/lib/manifests"

const REPO = resolve(__dirname, "../../..")
const LIB_RS = resolve(REPO, "escrow/scrypto/guild-marketplace-escrow/src/lib.rs")
const MANIFESTS_TS = resolve(REPO, "guild-app/src/lib/manifests.ts")

// Real-format dummy addresses (must pass the anchored `[a-z0-9]{20,}$` check).
const ESCROW = "component_rdx1cr690hkrk2kv933cw3qdr6amkaphdlu2whjhhh8wppus922yx335r2"
const POSTER = "account_rdx12ynlx369jmpfg23n709g0w7fuk0wwe0lft6h5r0m8sksdjpg858g0z"
const WORKER = "account_rdx12890803ct999t5ss4qatjyktay82gfy295rr6p4qmhks8twekeqgp9"
const RECEIPT_RES = "resource_rdx1n2rurpe2efyur5xqvz256yyhecpfjw8ed9v8xxcfxp5mtj9qld9ssq"
const BADGE_RES = "resource_rdx1n22hp6ydy0lkl0vqrk20cge43cm0lr64v9bldqzhq60g89fnp7j7s9"
// The bond resource for the Wave B claim builder. Deliberately NOT XRD: the
// retired builder hardcoded XRD, so an XRD dummy here would pass against both
// the ported builder and a regression back to the flat one.
const BOND_RES = "resource_rdx1t4dy69k6s0gv040xkv6rejxrmljfhrqmpad5hh4pdgvtjs4tvag5uf"
const HASH64 = "a".repeat(64)

// ── Rust type → manifest argument kind ───────────────────────────────────────
// The five-ish kinds the manifest text distinguishes. `Own<…>`-family types
// (Proof, Bucket) are exactly the confusion that shipped; everything else is
// here so an arity drift in ANY position reads as itself, not as noise.
function rustTypeToKind(rustType: string): string {
  const t = rustType.trim()
  if (t === "u64") return "u64"
  if (t === "Proof") return "Proof"
  if (t === "Bucket") return "Bucket"
  if (t === "Decimal") return "Decimal"
  if (t === "Hash") return "Bytes"
  if (t === "ComponentAddress" || t === "ResourceAddress") return "Address"
  if (t.startsWith("Option<") || t === "DisputeRuling" || t === "EntitledParty" || t === "AutoResolveDefault")
    return "Enum"
  throw new Error(`rustTypeToKind: unmapped blueprint type "${t}" — extend the map`)
}

/** Classify one manifest argument line into the same kind vocabulary. */
function argLineToKind(line: string): string {
  const l = line.trim()
  if (/^\d+u64$/.test(l)) return "u64"
  if (l.startsWith("Proof(")) return "Proof"
  if (l.startsWith("Bucket(")) return "Bucket"
  if (l.startsWith("Decimal(")) return "Decimal"
  if (l.startsWith("Bytes(")) return "Bytes"
  if (l.startsWith("Address(")) return "Address"
  if (l.startsWith("Enum<")) return "Enum"
  if (l.startsWith('"')) return "String"
  if (l.startsWith("Expression(")) return "Expression"
  if (l.startsWith("Array<")) return "Array"
  if (l.startsWith("NonFungibleLocalId(")) return "NonFungibleLocalId"
  throw new Error(`argLineToKind: unclassifiable manifest arg line "${l}"`)
}

/** Every CALL_METHOD in `manifest` addressed at `component`, as {method, kinds}. */
function escrowCalls(manifest: string, component: string) {
  const calls: Array<{ method: string; kinds: string[] }> = []
  for (const instruction of manifest.split(";")) {
    const lines = instruction
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
    if (lines[0] !== "CALL_METHOD") continue
    if (lines[1] !== `Address("${component}")`) continue
    const nameMatch = /^"([a-z_0-9]+)"$/.exec(lines[2] ?? "")
    if (!nameMatch) throw new Error(`CALL_METHOD with unparsable method line: ${lines[2]}`)
    calls.push({ method: nameMatch[1], kinds: lines.slice(3).map(argLineToKind) })
  }
  return calls
}

// ── The builder roster ───────────────────────────────────────────────────────
// GATED: called here with dummy args; every escrow CALL_METHOD they emit is
// checked against the ABI. When a builder changes shape, update its invocation —
// the completeness test below makes silently dropping one impossible.
const GATED: Record<string, () => string> = {
  createTaskManifest: () =>
    manifests.createTaskManifest(ESCROW, POSTER, 100, 5, "0", HASH64),
  claimTaskManifest: () =>
    // Wave B: (…, bondResource, bondAmount). The bond is the task's own reward
    // token at a computed amount — a non-XRD resource here on purpose, since a
    // dummy of XRD would not distinguish this from the retired flat builder.
    manifests.claimTaskManifest(ESCROW, WORKER, BADGE_RES, "#1#", 7, BOND_RES, "12.5"),
  submitTaskManifest: () =>
    // Wave B stage 6: submit_task is 4 args now (+ brief_hash). This gate
    // scrapes escrow/scrypto/guild-marketplace-escrow/src/lib.rs from the
    // WORKING TREE, so it proves source agreement only. The DEPLOYED side is
    // settled too: the swap ceremony put the live component on Wave B
    // (2026-09-13), and scripts/launch-check.sh — which compares the built
    // artifact's shape against the live component — is still the deploy-time
    // gate for that, not this source-scrape test.
    manifests.submitTaskManifest(ESCROW, WORKER, RECEIPT_RES, 3, 7, HASH64, HASH64),
  releaseAfterReviewTimeoutManifest: () =>
    // Same source-vs-deployed distinction: release_after_review_timeout is
    // present in main's Wave B lib.rs (in source, via #502), which is all
    // this entry's "matches the ABI" assertion proves. Gated (not
    // NON_ESCROW) because it genuinely does CALL_METHOD the escrow
    // component. The live Wave B package exposes it (Gateway blueprint
    // interface, read 2026-09-16); keeping the app pointed at a component
    // that does is launch-check.sh's job, not this test's.
    manifests.releaseAfterReviewTimeoutManifest(ESCROW, 7),
  approveAndReleaseManifest: () =>
    manifests.approveAndReleaseManifest(ESCROW, POSTER, RECEIPT_RES, 7),
  cancelTaskManifest: () =>
    manifests.cancelTaskManifest(ESCROW, POSTER, RECEIPT_RES, 7),
  cancelTaskAfterClaimManifest: () =>
    manifests.cancelTaskAfterClaimManifest(ESCROW, POSTER, RECEIPT_RES, 7),
  raiseDisputeManifest: () =>
    manifests.raiseDisputeManifest(ESCROW, POSTER, RECEIPT_RES, "#7#", 7, HASH64),
  resolveDisputeManifest: () =>
    manifests.resolveDisputeManifest(ESCROW, POSTER, BADGE_RES, "#1#", 7, { kind: "PayWorker" }),
  autoResolveDisputeManifest: () => manifests.autoResolveDisputeManifest(ESCROW, 7),
  expireClaimManifest: () => manifests.expireClaimManifest(ESCROW, WORKER, 7),
  pushEntitlementManifest: () => manifests.pushEntitlementManifest(ESCROW, 7, "worker"),
  withdrawWorkerManifest: () =>
    manifests.withdrawWorkerManifest(ESCROW, WORKER, BADGE_RES, "#1#", 7),
  withdrawPosterManifest: () =>
    manifests.withdrawPosterManifest(ESCROW, POSTER, RECEIPT_RES, 7),
  registerAcceptedTokenManifest: () =>
    manifests.registerAcceptedTokenManifest(ESCROW, POSTER, BADGE_RES, RECEIPT_RES, 1),
}

// NON-ESCROW: exported functions that never CALL_METHOD the escrow component —
// badge-manager, agent-badge-controller, governance, plain transfers, and pure
// helpers. Listed by name so the completeness check can prove the roster covers
// every export.
const NON_ESCROW = new Set([
  "publicMintManifest",
  "updateTierManifest",
  "updateXpManifest",
  "revokeBadgeManifest",
  "updateExtraDataManifest",
  "mintAgentBadgeManifest",
  "recallAgentBadgeManifest",
  "instantiateAgentBadgeControllerManifest",
  "giftXrdManifest",
  // Bring Your Agent's funding tx: the owner's account, the badge manager's
  // public_mint and the agent's account — never the escrow component.
  "pairAgentManifest",
  // Governance component, not the escrow.
  "makeTemperatureCheckManifest",
  "voteOnTemperatureCheckManifest",
  // Pure arithmetic — a faithful port of the blueprint's `required_bond`,
  // returns a Decimal string and emits no manifest. Exported because
  // escrow-utils' claim path must size the bond before building anything.
  "requiredBond",
  // Pure ruling helper — returns a string, emits no manifest.
  "autoResolveRuling",
  // CALL_FUNCTION on the PACKAGE, no component CALL_METHOD to gate here. Its
  // argument order/types are covered by the sheet-driven instantiate gate
  // (escrow-instantiate-gate.test.ts + the source-scrape signature pin).
  "instantiateEscrowManifest",
])

// EMPTY SINCE S3, and it stays empty. This was the grandfather list for the
// LegacyPush poster builders, exempted because they targeted the deployed
// pre-PULL component whose blueprint was never in this tree — so gating them
// against lib.rs (the PULL source) would have asserted them against the wrong
// ABI. Its own comment set the expiry: "DELETED at the P2 cutover". That cutover
// landed 2026-08-17 and S3 deleted the builders, so the set now matches nothing.
//
// It is emptied rather than left inert because of what it IS: an exemption list
// on a money-path gate. A dormant one is worse than none — any future builder
// that happened to match a name here would be silently skipped by the check that
// exists to catch exactly the Bucket-vs-Proof mismatch these builders had.
// Nothing may join it.
const LEGACY_PUSH = new Set<string>([])

describe("manifest-abi gate — every escrow call matches the blueprint signature", () => {
  const methods = new Map(
    scrapeMethods(LIB_RS).map((m: { name: string; params: string[] }) => [m.name, m]),
  )

  it("scraped an ABI that contains the money-path methods (the scraper is alive)", () => {
    for (const name of ["create_task", "approve_and_release", "cancel_task", "withdraw_worker"]) {
      expect(methods.has(name), `lib.rs scrape is missing ${name}`).toBe(true)
    }
  })

  for (const [builder, build] of Object.entries(GATED)) {
    it(`${builder} matches the ABI on every escrow call it emits`, () => {
      const calls = escrowCalls(build(), ESCROW)
      expect(calls.length, `${builder} emitted no escrow CALL_METHOD at all`).toBeGreaterThan(0)
      for (const call of calls) {
        const abi = methods.get(call.method)
        expect(abi, `${builder} calls "${call.method}" which does not exist in lib.rs`).toBeTruthy()
        const expected = abi!.params
          .filter((p: string) => !/^&(mut )?self$/.test(p.trim()))
          .map((p: string) => rustTypeToKind(p.split(":").slice(1).join(":")))
        expect(
          call.kinds,
          `${builder} → "${call.method}": manifest args [${call.kinds}] vs blueprint [${expected}]`,
        ).toEqual(expected)
      }
    })
  }

  // ── Worktop-flow leg ───────────────────────────────────────────────────────
  // The dispute-lane escape (P2 prep, 2026-08-10): builders whose CALL args all
  // type-checked kept push-era TAKE_FROM_WORKTOP legs after methods that, under
  // PULL, return `()` — dead against an empty worktop, and fatal the moment a
  // share is non-zero. Argument kinds cannot see that, but the scraper already
  // captures each method's RETURN type, so the flow is checkable from the same
  // source of truth: after an escrow call that returns no Bucket, nothing new
  // is on the worktop, and a TAKE_* before the next escrow call (which could
  // legitimately be preceded by its own input legs) is a bug by construction.
  // The converse also holds and is cheap: a call that DOES return buckets must
  // be followed by some deposit leg, or the returned value strands and the
  // whole transaction fails to balance.

  /** Ordered instruction list: [{head, escrowMethod?}] */
  function instructionFlow(manifest: string, component: string) {
    return manifest
      .split(";")
      .map((chunk) => chunk.split("\n").map((l) => l.trim()).filter(Boolean))
      .filter((lines) => lines.length > 0)
      .map((lines) => ({
        head: lines[0],
        escrowMethod:
          lines[0] === "CALL_METHOD" && lines[1] === `Address("${component}")`
            ? /^"([a-z_0-9]+)"$/.exec(lines[2] ?? "")?.[1]
            : undefined,
        isDeposit:
          lines[0] === "CALL_METHOD" &&
          lines[1] !== `Address("${component}")` &&
          /^"(deposit_batch|try_deposit_batch_or_abort|try_deposit_or_abort|try_deposit_batch_or_refund)"$/.test(
            lines[2] ?? "",
          ),
      }))
  }

  const returnsBucket = (returns: string) => /\bBucket\b/.test(returns)

  for (const [builder, build] of Object.entries(GATED)) {
    it(`${builder} takes from the worktop only what the blueprint actually returns`, () => {
      const flow = instructionFlow(build(), ESCROW)
      const escrowIdx = flow
        .map((ins, i) => (ins.escrowMethod ? i : -1))
        .filter((i) => i !== -1)
      for (let k = 0; k < escrowIdx.length; k++) {
        const i = escrowIdx[k]
        const method = flow[i].escrowMethod!
        const abi = methods.get(method)
        expect(abi, `${builder} calls "${method}" which does not exist in lib.rs`).toBeTruthy()
        const until = k + 1 < escrowIdx.length ? escrowIdx[k + 1] : flow.length
        const after = flow.slice(i + 1, until)
        if (!returnsBucket(abi!.returns)) {
          const dead = after.filter((ins) => /^TAKE(_ALL)?_FROM_WORKTOP$/.test(ins.head))
          expect(
            dead,
            `${builder} → "${method}" returns ${abi!.returns} (no bucket), but the manifest ` +
              `TAKEs from the worktop after it — a push-era routing leg that fails against ` +
              `an empty worktop`,
          ).toEqual([])
        } else {
          expect(
            after.some((ins) => ins.isDeposit || /^TAKE(_ALL)?_FROM_WORKTOP$/.test(ins.head)),
            `${builder} → "${method}" returns ${abi!.returns}, but nothing after the call ` +
              `consumes the worktop — the returned value strands and the tx fails to balance`,
          ).toBe(true)
        }
      }
    })
  }

  it("the roster is COMPLETE — every exported builder is gated or explicitly non-escrow", () => {
    // A new escrow builder that skips the gate re-opens the exact hole this file
    // closes. Scrape the export list from source; every name must be accounted for.
    const src = readFileSync(MANIFESTS_TS, "utf8")
    const exported = [...src.matchAll(/^export function (\w+)/gm)].map((m) => m[1])
    expect(exported.length).toBeGreaterThan(10) // the scrape itself works
    const unaccounted = exported.filter(
      (n) => !(n in GATED) && !NON_ESCROW.has(n) && !LEGACY_PUSH.has(n),
    )
    expect(
      unaccounted,
      `builders neither gated nor listed non-escrow: ${unaccounted.join(", ")} — add each to the roster`,
    ).toEqual([])
  })

  it("the grandfather list is EMPTY and every builder is gated — no exemptions remain", () => {
    // LEGACY_PUSH was an escape hatch from the gate, and an escape hatch that can
    // absorb new names silently is the gate not existing. It held exactly the
    // three push poster builders, exempt because their target blueprint was never
    // in this tree. S3 deleted those builders, so the hatch is now closed rather
    // than merely unused — a dormant exemption is worse than none, because a
    // future builder matching one of those names would be skipped by the very
    // check that exists to catch the Bucket-vs-Proof mismatch they had.
    expect([...LEGACY_PUSH]).toEqual([])
    // And the gate really is covering the builders now, not vacuously passing:
    // every exported *Manifest function is either checked or explicitly listed
    // as non-escrow, with nothing in between.
    expect(LEGACY_PUSH.size).toBe(0)
  })

  it("the classifier fails loud on an unknown arg form rather than skipping it", () => {
    expect(() => argLineToKind("SomeNewSyntax(1)")).toThrow(/unclassifiable/)
    expect(() => rustTypeToKind("Vec<Bucket>")).toThrow(/unmapped/)
  })
})
