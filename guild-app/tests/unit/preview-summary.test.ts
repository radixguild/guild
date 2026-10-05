import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  summarizePreview,
  formatSummary,
  classifyError,
  shortAddr,
  NOISE_EVENTS,
} from "../../scripts/lib/preview-summary.mjs"

// Fixtures are TRIMMED COPIES OF REAL mainnet `/transaction/preview` responses taken
// on 2026-08-09 against the throwaway PULL component, not invented shapes. The
// failure fixture is the exact error that proved guild-app's `cancelTaskManifest`
// broken — if the Gateway ever changes this envelope, these tests should notice.
// The one exception is MINTED_AND_BURNED below, which is labelled as shaped-from a
// measurement rather than captured; keep that label honest if you edit it.

const ESCROW = "component_rdx1cqudk8vxaf24xevekzu49mw0292qmhaa85klypxu5sh4yh7nsddhwj"
const POSTER = "account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw"
const XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"

const BLUEPRINT_ERROR =
  'SystemError(TypeCheckError(BlueprintPayloadValidationError(BlueprintInfo { blueprint_id: ' +
  'BlueprintId { package_address: PackageAddress("package_rdx1p4da84x3xknr7qtnqdcn28fkqsj6mjgv9ya4ez7h2p0p3cav8gw662"), ' +
  'blueprint_name: "Escrow" }, blueprint_version: BlueprintVersion { major: 1, minor: 0, patch: 0 }, ' +
  'outer_obj_info: None, features: [], generic_substitutions: [] }, Function("cancel_task", Input), ' +
  '"[ERROR] byte offset: 3-34, value path: Escrow_cancel_task_Input.[0|receipt]->Proof, ' +
  'cause: CustomError(\\"Expected = Own<IsProof>, actual node: ... blueprint: \\\\\\"NonFungibleBucket\\\\\\"\\")")))'

function change(entity: string, amount: string, resource = XRD) {
  return {
    resource_address: resource,
    component_entity: { entity_address: entity },
    amount,
  }
}

const SUCCEEDED = {
  receipt: {
    status: "Succeeded",
    fee_summary: { xrd_total_execution_cost: "0.754309", xrd_total_finalization_cost: "0.06252125" },
    events: [
      { type: { name: "WithdrawEvent" } },
      { type: { name: "DepositEvent" } },
      { type: { name: "TaskCancelledEvent" } },
      { type: { name: "SettlementCreditedEvent" } },
      { type: { name: "WithdrawalEvent" } },
      { type: { name: "BurnFungibleResourceEvent" } },
    ],
  },
  resource_changes: [
    { index: 2, resource_changes: [change(ESCROW, "-1.05"), change(POSTER, "1.05")] },
  ],
}

const FAILED = {
  receipt: {
    status: "Failed",
    error_message: BLUEPRINT_ERROR,
    fee_summary: { xrd_total_execution_cost: "0.156854" },
    events: [],
  },
  resource_changes: [],
}

// ⚠ NOT a verbatim capture like the two above — SHAPED FROM the mainnet measurement of
// 2026-08-20, and the resource, the +1 and the three Burn events are that observation's
// numbers. A full escrow lifecycle manifest ending in `burn_task_receipt` previewed
// green: `resource_changes` summed the task receipt to +1 for the poster and carried NO
// burn row, while `receipt.events` held 3 Burn events including the one that destroyed
// it. The Gateway omits NFT burns from `resource_changes`; the module cannot fix that,
// so it must not let the omission read as a standing credential.
const RECEIPT = "resource_rdx1nf57tptrl0ar5vhqzl5ln763ktzg86rcwwxyqh3t7esmd38t5qws7w"

const MINTED_AND_BURNED = {
  receipt: {
    status: "Succeeded",
    fee_summary: { xrd_total_execution_cost: "1.204418" },
    events: [
      { type: { name: "MintNonFungibleResourceEvent" } },
      { type: { name: "DepositEvent" } },
      { type: { name: "TaskReleasedEvent" } },
      { type: { name: "BurnNonFungibleResourceEvent" } },
      { type: { name: "BurnNonFungibleResourceEvent" } },
      { type: { name: "BurnNonFungibleResourceEvent" } },
      { type: { name: "BurnFungibleResourceEvent" } },
    ],
  },
  resource_changes: [{ index: 3, resource_changes: [change(POSTER, "1", RECEIPT)] }],
}

describe("summarizePreview", () => {
  it("reports a success with its net movements and de-noised events", () => {
    const s = summarizePreview(SUCCEEDED)
    expect(s.ok).toBe(true)
    expect(s.kind).toBeNull()
    expect(s.deltas).toEqual([
      { entity: ESCROW, resource: XRD, amount: -1.05 },
      { entity: POSTER, resource: XRD, amount: 1.05 },
    ])
    expect(s.events).toEqual([
      "TaskCancelledEvent",
      "SettlementCreditedEvent",
      "WithdrawalEvent",
    ])
    // The noise is filtered from the view, never dropped from the data.
    expect(s.allEvents).toHaveLength(6)
    expect(s.feeXrd).toBeCloseTo(0.81683025, 8)
  })

  it("nets a round trip to zero instead of reporting it as a loss and a gain", () => {
    // A claim bond posted and returned in ONE transaction. Reported per-instruction
    // this reads as -10 then +10, which is exactly how a worker concludes they were
    // charged. It moved nothing.
    const s = summarizePreview({
      receipt: { status: "Succeeded", events: [] },
      resource_changes: [
        { index: 0, resource_changes: [change(POSTER, "-10")] },
        { index: 4, resource_changes: [change(POSTER, "10")] },
      ],
    })
    expect(s.deltas).toEqual([])
    expect(s.nettedOut).toBe(1)
    expect(formatSummary(s)).toContain("nothing (1 round-trip, net zero)")
  })

  it("distinguishes a SIGNATURE mismatch from a chain-state failure", () => {
    expect(summarizePreview(FAILED).kind).toBe("signature-mismatch")
    expect(
      summarizePreview({
        receipt: {
          status: "Failed",
          error_message: 'ApplicationError(PanicMessage("task must be Open to cancel"))',
        },
      }).kind,
    ).toBe("chain-state")
  })

  it("treats a missing receipt as unknown rather than as success", () => {
    const s = summarizePreview({})
    expect(s.ok).toBe(false)
    expect(s.status).toBe("Unknown")
  })

  it("counts NFT burns the Gateway leaves out of resource_changes", () => {
    // The trap this guards: the receipt was minted AND burned in one transaction, and
    // the sum still says the poster is +1, because the Gateway never sent a -1 row.
    // Both assertions matter — the first records the limitation as REAL (if a future
    // Gateway starts reporting burn rows this flips to 0 and should be re-measured,
    // not patched), the second is the flag that keeps it from reading as a credential.
    const s = summarizePreview(MINTED_AND_BURNED)
    expect(s.deltas).toEqual([{ entity: POSTER, resource: RECEIPT, amount: 1 }])
    expect(s.nftBurnEvents).toBe(3)
  })

  it("does NOT count the fee burn every transaction emits", () => {
    // SUCCEEDED carries a BurnFungibleResourceEvent — the fee. Widening the match to
    // any Burn event is the obvious 'improvement' that would make this test fail, and
    // would fire the warning on every transaction, which is the same as never firing.
    expect(summarizePreview(SUCCEEDED).nftBurnEvents).toBe(0)
  })
})

describe("formatSummary", () => {
  it("NEVER truncates the error — the whole diagnostic is in the tail", () => {
    // The class is at the head but the ANSWER ("expected Own<IsProof>, got
    // NonFungibleBucket") is ~700 chars in. Every hand-rolled curl during the P1-5
    // sitting cut it off and the mismatch had to be re-derived by hand each time.
    const out = formatSummary(summarizePreview(FAILED))
    expect(out).toContain("Expected = Own<IsProof>")
    expect(out).toContain("NonFungibleBucket")
    expect(out).not.toContain("…")
    expect(out.length).toBeGreaterThan(BLUEPRINT_ERROR.length)
  })

  it("says plainly that a signature mismatch will not fix itself", () => {
    const out = formatSummary(summarizePreview(FAILED))
    expect(out).toContain("SIGNATURE mismatch, not a state problem")
    expect(out).toContain("ESCROW-METHOD-INVENTORY.md")
  })

  it("does not offer that advice on a state failure, where retrying IS valid", () => {
    const out = formatSummary(
      summarizePreview({
        receipt: { status: "Failed", error_message: 'PanicMessage("task must be Open to cancel")' },
      }),
    )
    expect(out).not.toContain("SIGNATURE mismatch")
  })

  it("warns that a '+1' row can name an NFT this transaction already burned", () => {
    const out = formatSummary(summarizePreview(MINTED_AND_BURNED), { labels: { [POSTER]: "POSTER" } })
    expect(out).toContain("+1")
    expect(out).toContain("3 non-fungible BURN events NOT reflected above")
    expect(out).toContain("--all-events")
  })

  it("stays silent about burns when there are none — the warning must mean something", () => {
    // SUCCEEDED burns only its fee. A warning on every preview is a warning on none.
    expect(formatSummary(summarizePreview(SUCCEEDED))).not.toContain("BURN")
  })

  it("labels known addresses when given them, and shortens the rest", () => {
    const out = formatSummary(summarizePreview(SUCCEEDED), {
      labels: { [POSTER]: "POSTER", [XRD]: "XRD" },
    })
    expect(out).toContain("POSTER")
    expect(out).toContain("XRD")
    expect(out).toContain(shortAddr(ESCROW))
  })
})

describe("the guard rails themselves", () => {
  it("classifies an unknown failure as 'other' rather than guessing", () => {
    expect(classifyError("KernelError(Whatever)")).toBe("other")
    expect(classifyError(null)).toBe("unknown")
  })

  it("keeps settlement events OUT of the noise list", () => {
    // If a future edit ever adds one of these to NOISE_EVENTS, the money-path event
    // disappears from the operator's view while the preview still reads green.
    for (const e of [
      "TaskCancelledEvent",
      "TaskReleasedEvent",
      "SettlementCreditedEvent",
      "WithdrawalEvent",
      "DisputeRaisedEvent",
      "TaskCancelledAfterClaimEvent",
    ]) {
      expect(NOISE_EVENTS.has(e)).toBe(false)
    }
  })
})

describe("the (entity, resource) composite key", () => {
  // These exist because the key is built by CONCATENATION and read back by SPLIT, and
  // neither failure throws. A key that merges two vaults, or splits in the wrong
  // place, just prints a wrong number on the screen an operator reads seconds before
  // signing. Nothing but a test catches that.

  it("keeps two pairs apart even when their halves concatenate identically", () => {
    // "a"+"bc" and "ab"+"c" are the same string once joined with no delimiter, so this
    // is the case that fails if the separator is ever dropped or emptied.
    const s = summarizePreview({
      receipt: { status: "Succeeded", events: [] },
      resource_changes: [
        {
          index: 0,
          resource_changes: [
            { resource_address: "bc", component_entity: { entity_address: "a" }, amount: "1" },
            { resource_address: "c", component_entity: { entity_address: "ab" }, amount: "2" },
          ],
        },
      ],
    })
    expect(s.deltas).toEqual([
      { entity: "a", resource: "bc", amount: 1 },
      { entity: "ab", resource: "c", amount: 2 },
    ])
  })

  it("round-trips real bech32 addresses without cutting inside one", () => {
    // The separator must be a character no Radix address can contain. Both `_` and `1`
    // occur in EVERY address ("component_rdx1..."), so picking either -- the two most
    // tempting "readable" delimiters -- collapses this to entity "component". Two
    // entities sharing a resource, plus one entity holding two resources, cover both
    // directions of the split.
    const OTHER = "resource_rdx1nfxxxxxxxxxxglcllrxxxxxxxxxacrulpuxxxxxxxxxjmw6r7glcllr"
    const s = summarizePreview({
      receipt: { status: "Succeeded", events: [] },
      resource_changes: [
        {
          index: 0,
          resource_changes: [
            change(ESCROW, "1", XRD),
            change(POSTER, "2", XRD),
            change(ESCROW, "3", OTHER),
          ],
        },
      ],
    })
    expect(s.deltas).toEqual([
      { entity: ESCROW, resource: XRD, amount: 1 },
      { entity: POSTER, resource: XRD, amount: 2 },
      { entity: ESCROW, resource: OTHER, amount: 3 },
    ])
    // Belt and braces: nothing was truncated at a `_` or a `1`.
    for (const d of s.deltas) {
      expect(d.entity).toMatch(/^(component|account)_rdx1/)
      expect(d.resource).toMatch(/^resource_rdx1/)
    }
  })

  it("holds no NUL byte in its source, or git renders the module unreviewable", () => {
    // The separator was a literal NUL until 2026-08-20. It split correctly, but git's
    // binary heuristic keys on NUL bytes, so `git diff` reported "Binary file not
    // shown" for a money-path module and no PR could ever review it. Checkable from
    // source in microseconds, so it is checked rather than trusted. NOTE both
    // assertions use ESCAPES, never literal bytes -- writing one here would make this
    // test file binary and reproduce the bug inside the guard against it.
    const src = readFileSync(join(process.cwd(), "scripts/lib/preview-summary.mjs"), "utf8")
    expect(src).not.toContain("\u0000")
  })
})
