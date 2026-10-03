// poster-harness's get-config gate and cancel-after-claim bond read, against
// BOTH claim-bond shapes the chain has had.
//
// Wave B (2026-09-13) deleted the flat `claim_bond_xrd` component field the
// harness read, and replaced it with `claim_bond_pct` / `claim_bond_floor` /
// `claim_bond_cap` plus a per-task `claim_bond_amount` pinned at claim_task.
// Until 2026-09-14 the harness still read the flat field, so against the live
// component its gate refused ("could not read claim_bond_xrd") on every path —
// safe, but unusable, and nothing failed in CI because nothing exercised the
// parse. The fixtures below are the programmatic_json shapes the Gateway
// actually returns (read from the Wave B component and its proving-run tasks
// 1 and 2 on 2026-09-14, and from the retired PULL component's flat field).
//
// Same import shape as poster-harness-withdraw.test.ts: the harness is a Bun
// script, but its exports are plain functions and `main()` only runs when the
// file is the entrypoint, so vitest can import it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { assertConfigOk, parseClaimBond, parseTaskClaimBond } from "../../scripts/poster-harness.mjs"

// Component-state fields, as `details.state.fields` — only the ones the parser
// looks at; the real state carries ~30.
const WAVE_B_FIELDS = [
  { kind: "Decimal", field_name: "min_insurance_fraction", value: "0" },
  { kind: "Decimal", field_name: "claim_bond_pct", value: "0.1" },
  { kind: "Decimal", field_name: "claim_bond_floor", value: "76.45" },
  { kind: "Decimal", field_name: "claim_bond_cap", value: "152894" },
  { kind: "Decimal", field_name: "expire_bounty_pct", value: "0.1" },
]
const PULL_FIELDS = [
  { kind: "Decimal", field_name: "claim_bond_xrd", value: "10" },
  { kind: "Decimal", field_name: "min_insurance_fraction", value: "0.05" },
]

describe("parseClaimBond — component state", () => {
  it("reads Wave B's proportional params as chain-text strings", () => {
    expect(parseClaimBond(WAVE_B_FIELDS)).toEqual({ mode: "proportional", pct: "0.1", floor: "76.45", cap: "152894" })
  })
  it("reads a retired component's flat bond", () => {
    expect(parseClaimBond(PULL_FIELDS)).toEqual({ mode: "flat", amountXrd: "10" })
  })
  it("returns null when neither shape is present, or a param is not a decimal", () => {
    expect(parseClaimBond([])).toBeNull()
    expect(parseClaimBond([{ field_name: "claim_bond_pct", value: "0.1" }])).toBeNull() // floor/cap missing
    expect(parseClaimBond([{ field_name: "claim_bond_xrd", value: "ten" }])).toBeNull()
  })
})

describe("parseTaskClaimBond — one task's struct", () => {
  it("unwraps Some(Decimal) — pinned at claim, still present after settlement", () => {
    const released = [
      { kind: "Enum", field_name: "state", variant_name: "Released", fields: [] },
      { kind: "Enum", field_name: "claim_bond_amount", variant_name: "Some", fields: [{ kind: "Decimal", value: "76.45" }] },
    ]
    expect(parseTaskClaimBond(released)).toBe("76.45")
  })
  it("is null for an unclaimed task (None), a missing field, or garbage", () => {
    expect(parseTaskClaimBond([{ kind: "Enum", field_name: "claim_bond_amount", variant_name: "None", fields: [] }])).toBeNull()
    expect(parseTaskClaimBond([])).toBeNull()
    expect(parseTaskClaimBond(undefined)).toBeNull()
    expect(parseTaskClaimBond([{ field_name: "claim_bond_amount", variant_name: "Some", fields: [{ kind: "Decimal", value: "-1" }] }])).toBeNull()
  })
})

describe("assertConfigOk — the create_task gate", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}))
  afterEach(() => vi.restoreAllMocks())

  const waveB = { xrdWhitelisted: true, claimBond: parseClaimBond(WAVE_B_FIELDS), minInsuranceFraction: 0, workerBadgeResource: null }
  const pull = { xrdWhitelisted: true, claimBond: parseClaimBond(PULL_FIELDS), minInsuranceFraction: 0.05, workerBadgeResource: null }

  it("passes the live Wave B config, with or without a PULL-era expectBond", () => {
    expect(assertConfigOk(waveB)).toBe(true)
    // A PULL-era caller passing { expectBond: 10 } must not turn a correct
    // proportional config into a refusal — it is logged as not applicable.
    expect(assertConfigOk(waveB, { expectBond: 10 })).toBe(true)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[poster-harness]"), expect.stringContaining("does not apply"))
  })
  it("still checks a flat bond against expectBond on a retired-shaped component", () => {
    expect(assertConfigOk(pull, { expectBond: 10 })).toBe(true)
    expect(assertConfigOk(pull, { expectBond: 5 })).toBe(false)
    expect(assertConfigOk(pull)).toBe(true) // no expectation, no complaint
  })
  it("refuses when the bond is unreadable or the params are not sane", () => {
    expect(assertConfigOk({ ...waveB, claimBond: null })).toBe(false)
    expect(assertConfigOk({ ...waveB, claimBond: { mode: "proportional", pct: "0", floor: "76.45", cap: "152894" } })).toBe(false)
    expect(assertConfigOk({ ...waveB, claimBond: { mode: "proportional", pct: "0.1", floor: "200", cap: "100" } })).toBe(false)
  })
  it("refuses when XRD is not whitelisted", () => {
    expect(assertConfigOk({ ...waveB, xrdWhitelisted: false })).toBe(false)
  })
  it("treats min_insurance_fraction as a soft check — Wave B's 0 is not a refusal", () => {
    expect(assertConfigOk({ ...waveB, minInsuranceFraction: 0 })).toBe(true)
    expect(assertConfigOk({ ...waveB, minInsuranceFraction: 0.5 })).toBe(true) // warns, does not fail
  })
})
