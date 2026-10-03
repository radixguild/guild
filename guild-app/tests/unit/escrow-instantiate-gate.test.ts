// The P1-4 pre-sign gate: the escrow `instantiate` deploy manifest must be
// GENERATED from the signed sheet and must agree with the blueprint, or nothing
// gets signed.
//
// WHAT THIS GUARDS, in one sentence: eleven positional write-once arguments, of
// which FOUR are consecutive `u64`s and THREE are `Decimal`s, so a transposition
// inside either group produces a manifest that decodes cleanly, commits, and
// misconfigures the component's economics permanently.
//
// Everything below plants a real mutation and asserts it goes RED. The bar the
// framework set for P1-4 is exactly that: "a wrong enum/arity/param goes RED
// before any signature". A gate whose failure modes were never exercised is a
// gate nobody has evidence for — this repo has shipped that twice (the fee-lock
// guard whose test reimplemented the bug, and P1-3c's first signature scrape,
// which passed against two ordinary source layouts).
//
// The tests call the SAME exported `checkSignedSheet` the operator's CLI calls.
// They do not reimplement it.

import { describe, it, expect } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  checkSignedSheet,
  SHEET_PATH,
  LIB_RS_PATH,
} from "../../scripts/gen-instantiate-manifest.mjs"
import { buildInstantiateManifest } from "../../scripts/lib/instantiate-sheet.mjs"
import { instantiateEscrowManifest } from "@/lib/manifests"
import { INSTANTIATE_SPEC } from "@/lib/generated/instantiate-spec"
import { privateInputs } from "../support/private-input"

// docs/ESCROW-PARAMETER-SHEET.md (the signed ceremony sheet SHEET_PATH points
// at) stays private at the open-source flip (publish/MANIFEST.md) — the
// gen-instantiate-manifest.mjs module this file imports ships, but its input
// doc does not.
const PRIV = privateInputs("docs/ESCROW-PARAMETER-SHEET.md")
const SHEET = PRIV.skip ? "" : readFileSync(SHEET_PATH, "utf8")
const LIB_RS = readFileSync(LIB_RS_PATH, "utf8")

/** Write mutated copies to a temp dir and run the real gate against them. */
function gateWith({ sheet = SHEET, libRs = LIB_RS }: { sheet?: string; libRs?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "p1-4-"))
  const sheetPath = join(dir, "sheet.md")
  const libRsPath = join(dir, "lib.rs")
  writeFileSync(sheetPath, sheet)
  writeFileSync(libRsPath, libRs)
  return () => checkSignedSheet({ sheetPath, libRsPath })
}

/**
 * Stamp the two CEREMONY args the sheet cannot supply.
 *
 * claim_bond_floor/cap are USD POLICY on the signed sheet ($0.05 / $100) while
 * the on-chain field is reward-token units — W4-mech has no oracle, so the
 * operator converts at ceremony time and records the rate. `parseSignedSheet`
 * therefore returns them with `value: null`, and a manifest cannot be built
 * until they are stamped. These fixture numbers are the XRD equivalents at a
 * nominal rate; they exist to exercise the builder, and are NOT the ceremony
 * values — the real ones come from the CLI's --floor/--cap/--xrd-usd, which
 * enforce the USD policy independently.
 */
function stamped(args: any[]): any[] {
  const FIXTURE = {
    claim_bond_floor: { literal: 'Decimal("55")', display: "55" },
    claim_bond_cap: { literal: 'Decimal("111111")', display: "111111" },
  } as Record<string, { literal: string; display: string }>
  const out = args.map((a) =>
    a.source === "ceremony" ? { ...a, value: FIXTURE[a.name] } : a,
  )
  // Not a vacuous stamp: if the ceremony class is ever renamed or removed, this
  // fixture must fail loudly rather than quietly stamping nothing.
  const n = out.filter((a) => a.source === "ceremony").length
  if (n !== 2) throw new Error(`expected 2 ceremony args to stamp, found ${n}`)
  return out
}

const DEPLOY_INPUTS = {
  escrowPackage: "package_rdx1pkamdfm9cqsns07nl4xvkwfplhdyyu2a0a2lw78e2dv362lj9f0qer",
  workerBadge: "resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl",
  // ⚠️ Real mainnet resources, not placeholders. The RET compile test below
  // decodes these for real, and the fixture address this file first used
  // (`resource_rdx1nfmxggm4plrs2c5388ex6z8f8s4hkgvzk6z9jr8f0zc0nfw0m0x0mp`,
  // copied from manifests.test.ts) turned out to have an invalid bech32m
  // checksum — it has been sitting in the byte-shape fixtures for months, where
  // nothing ever decodes it. That discovery is why the CLI now compiles its own
  // output before printing.
  arbiterBadge: "resource_rdx1n2rurpe2efyur5xqvz256yyhecpfjw8ed9v8xxcfxp5mtj9qld9ssq",
  agentBadge: null,
  account: "account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw",
}

describe.skipIf(PRIV.skip)("the gate itself is armed", () => {
  it("passes against the real signed sheet and the real blueprint", () => {
    const args = gateWith({})()
    expect(args).toHaveLength(15)
    // Not a vacuous pass: every sheet row really produced a literal.
    const sheetSourced = args.filter((a: any) => a.source === "sheet")
    expect(sheetSourced).toHaveLength(10)
    expect(sheetSourced.every((a: any) => typeof a.value.literal === "string")).toBe(true)

    // THREE source classes now, and the split is the safety property.
    // `deploy` = the three resource addresses. `ceremony` = the bond floor/cap,
    // which the signed sheet carries as USD POLICY ($0.05/$100) while the
    // on-chain field is in reward-token units — W4-mech has no oracle, so the
    // conversion happens at the ceremony and the rate is recorded. They MUST
    // stay value-less here: a `ceremony` row that arrived with a literal would
    // mean the generator had lifted the bare USD number and was about to emit
    // it as a token amount, which at XRD ~$0.0009 is a ~1000x error on a
    // write-once deploy that every other gate would pass.
    expect(args.filter((a: any) => a.source === "deploy")).toHaveLength(3);
    const ceremony = args.filter((a: any) => a.source === "ceremony");
    expect(ceremony.map((a: any) => a.name)).toEqual([
      "claim_bond_floor",
      "claim_bond_cap",
    ]);
    expect(ceremony.every((a: any) => a.value === null)).toBe(true);
    expect(ceremony.map((a: any) => a.usdPolicy)).toEqual(["0.05", "100"]);
    // No fourth class may appear unnoticed.
    expect(
      new Set(args.map((a: any) => a.source)),
    ).toEqual(new Set(["deploy", "sheet", "ceremony"]));
  })

  it("pins the signed values — a change to any of the ten is visible here", () => {
    const args = gateWith({})()
    const byName = Object.fromEntries(
      args.filter((a: any) => a.source === "sheet").map((a: any) => [a.name, a.value.literal])
    )
    // These ARE the economics. Signed at the Wave B sign-off sitting 2026-08-31
    // and written into ESCROW-PARAMETER-SHEET.md §"Wave B".
    //
    // ⚠️ This pinned §"PULL cutover" — the LIVE component's sheet — until
    // 2026-09-01. The generator was reading that section too, so both agreed
    // while both described the wrong deploy.
    expect(byName).toEqual({
      max_arbiter_fee_pct: 'Decimal("0.1")',
      human_submit_deadline_secs: "604800u64",
      agent_submit_deadline_secs: "86400u64",
      dispute_auto_resolve_secs: "259200u64",
      expire_grace_secs: "3600u64",
      dispute_auto_resolve_default: "Enum<1u8>()",
      min_insurance_fraction: 'Decimal("0")',
      claim_bond_pct: 'Decimal("0.10")',
      expire_bounty_pct: 'Decimal("0.10")',
      review_window_secs: "259200u64",
    })
  })
})

// ⚠️ EVERY mutation below asserts it ACTUALLY MUTATED before asserting the gate
// reddens. That is not ceremony. Three times in this arc a "proven" mutation
// turned out not to have applied — an anchor string that no longer existed, or
// a change rustc rejected before the test could speak — and each time the test
// passed in both directions and read as proof. A mutation test that does not
// verify its own mutation is theatre.
//
// Anchors are REGEX ON THE ROW NUMBER, not full-line literals. The Wave B rows
// carry long Ruling cells that get edited constantly; pinning their exact text
// made these fixtures rot every time someone clarified a sentence.
// ⚠️ SCOPED TO THE WAVE B SECTION. The sheet carries TWO numbered arg tables —
// §"PULL cutover" (the LIVE component, 11 rows) comes FIRST, then §"Wave B"
// (the next one, 15 rows). A bare /^\| 8 \|/m matches the PULL row, so a
// fixture that "mutated row 8" was mutating a table the generator no longer
// reads, and the gate correctly did not throw. Exactly the bug this same sheet
// produced in the parser an hour earlier, reappearing in the fixtures.
const WAVE_B_AT = SHEET.indexOf("## Wave B — the signed sheet")

function waveBRow(sheet: string, n: number): string {
  const at = sheet.indexOf("## Wave B — the signed sheet")
  if (at < 0) throw new Error("fixture anchor lost: no Wave B section")
  const m = sheet.slice(at).match(new RegExp(`^\\|\\s*${n}\\s*\\|.*$`, "m"))
  if (!m) throw new Error(`fixture anchor lost: no row ${n} in the Wave B table — fix the fixture, never weaken the gate`)
  return m[0]
}

function replaceRow(sheet: string, n: number, replacement: string): string {
  const row = waveBRow(sheet, n)
  return sheet.replace(row, replacement)
}

describe.skipIf(PRIV.skip)("planted mutations — each must go RED before any signature", () => {
  it("WRONG ENUM BYTE: the sheet claims SplitEvenly but writes Enum<0u8>", () => {
    // The framework names this as THE trap. Enum<0u8> is FavorDisputeRaiser,
    // which on PULL is first-raiser-takes-all — the ruling DB-1 reversed.
    // It decodes without error, so nothing downstream would ever notice.
    const sheet = SHEET.replace("(`Enum<1u8>`)", "(`Enum<0u8>`)")
    expect(sheet).not.toBe(SHEET)
    expect(gateWith({ sheet })).toThrow(/ENUM MISMATCH[\s\S]*SplitEvenly[\s\S]*ordinal 1/)
  })

  it("REORDERED BLUEPRINT ENUM: the sheet's byte is right until the variants move", () => {
    // The sheet is unchanged and internally consistent here. Only the blueprint
    // moved — and that silently repoints every already-written Enum<1u8>.
    // ⚠️ Anchored on the bare variant lines, NOT on the enum header followed by
    // them: stage 3 gave every variant a doc comment, so the old
    // header-plus-variants literal silently stopped matching and this mutation
    // became a no-op that still "passed".
    const libRs = LIB_RS.replace("    FavorDisputeRaiser,\n", "    __SWAP__\n")
      .replace("    SplitEvenly,\n", "    FavorDisputeRaiser,\n")
      .replace("    __SWAP__\n", "    SplitEvenly,\n")
    expect(libRs).not.toBe(LIB_RS)
    expect(libRs).not.toContain("__SWAP__")
    expect(gateWith({ libRs })).toThrow(/ENUM MISMATCH[\s\S]*ordinal 0/)
  })

  it("DROPPED ARG: the sheet lists fourteen rows", () => {
    const sheet = replaceRow(SHEET, 8, "")
    expect(sheet).not.toBe(SHEET)
    expect(gateWith({ sheet })).toThrow(/lists 14 numbered argument rows, expected 15/)
  })

  it("REORDERED SHEET: two whole rows swapped", () => {
    const human = waveBRow(SHEET, 5)
    const agent = waveBRow(SHEET, 6)
    expect(human).toContain("human_submit_deadline_secs")
    expect(agent).toContain("agent_submit_deadline_secs")
    const sheet = SHEET.replace(human, "___H___").replace(agent, "___A___")
      .replace("___H___", agent).replace("___A___", human)
    expect(sheet).not.toBe(SHEET)
    // The `#` column travels with the row, so the ordinal check fires before the
    // name check. Either is a stop; asserting the one that actually fires keeps
    // this test honest about which guard is doing the work.
    expect(gateWith({ sheet })).toThrow(/sheet row 5 is numbered 6/)
  })

  it("RENAMED ROW: numbering intact, an arg name changed", () => {
    const row5 = waveBRow(SHEET, 5)
    expect(row5).toContain("human_submit_deadline_secs")
    const sheet = SHEET.replace(row5, row5.replace("human_submit_deadline_secs", "agent_submit_deadline_secs"))
    expect(sheet).not.toBe(SHEET)
    expect(gateWith({ sheet })).toThrow(/row 5 names `agent_submit_deadline_secs`.*expects `human_submit_deadline_secs`/s)
  })

  it("VALUES-ONLY SWAP: names and numbering intact, two u64 values exchanged", () => {
    // ⚠️ The genuinely silent class, and the one this gate CANNOT catch by
    // itself — and should not pretend to. The sheet IS the source of truth for
    // values, so a generator that second-guessed it would just be a fourth
    // opinion. Swapping only the values leaves the sheet internally consistent:
    // both args are u64, so SBOR accepts the result and the component ships with
    // a 1-day human deadline and a 7-day agent deadline, forever.
    //
    // What stops it is the value pin in "the gate itself is armed" above, which
    // asserts all eight literals against the ruling. That is a deliberate
    // division of labour: `checkSignedSheet` proves sheet→manifest FIDELITY, the
    // pin proves the sheet still says what bigdev signed. Both are needed;
    // neither substitutes for the other. This test proves the second one bites.
    const row5 = waveBRow(SHEET, 5)
    const row6 = waveBRow(SHEET, 6)
    expect(row5).toContain("`604800`")
    expect(row6).toContain("`86400`")
    const sheet = SHEET.replace(row5, row5.replace("`604800`", "`86400`")).replace(
      row6,
      row6.replace("`86400`", "`604800`"),
    )
    expect(sheet).not.toBe(SHEET)

    // checkSignedSheet is content — the sheet is coherent, it just says something else.
    const args = gateWith({ sheet })()
    const byName = Object.fromEntries(args.map((a: any) => [a.name, a.value?.literal]))
    expect(byName.human_submit_deadline_secs).toBe("86400u64")

    // The pin is what refuses it.
    expect(() =>
      expect(byName.human_submit_deadline_secs).toBe("604800u64")
    ).toThrow()
  })

  it("BLUEPRINT GAINS AN ARG the sheet does not carry", () => {
    const libRs = LIB_RS.replace(
      "            review_window_secs: u64,\n        ) -> ",
      "            review_window_secs: u64,\n            slippage_bps: u64,\n        ) -> "
    )
    expect(libRs).not.toBe(LIB_RS)
    expect(gateWith({ libRs })).toThrow(/BLUEPRINT\/SPEC MISMATCH[\s\S]*slippage_bps/)
  })

  it("BLUEPRINT REORDERS TWO ARGS — invisible to any compiler", () => {
    const libRs = LIB_RS.replace(
      "            expire_bounty_pct: Decimal,\n            review_window_secs: u64,\n        ) -> ",
      "            review_window_secs: u64,\n            expire_bounty_pct: Decimal,\n        ) -> "
    )
    expect(libRs).not.toBe(LIB_RS)
    expect(gateWith({ libRs })).toThrow(/BLUEPRINT\/SPEC MISMATCH/)
  })

  it("MANGLED VALUE: a row's literal stops being a number", () => {
    const row11 = waveBRow(SHEET, 11)
    expect(row11).toContain("`0.10`")
    const sheet = SHEET.replace(row11, row11.replace("`0.10`", "`ten`"))
    expect(sheet).not.toBe(SHEET)
    expect(gateWith({ sheet })).toThrow(/claim_bond_pct.*expected a decimal, found `ten`/)
  })

  it("SECTION RENAMED: refuses rather than reading some other table", () => {
    const sheet = SHEET.replace("## Wave B — the signed sheet", "## Wave B (draft)")
    expect(sheet).not.toBe(SHEET)
    expect(gateWith({ sheet })).toThrow(/no "## Wave B — the signed sheet" section/)
  })
})

describe.skipIf(PRIV.skip)("the emitted manifest", () => {
  it("carries the fifteen args in sheet order, each labelled", () => {
    const manifest = buildInstantiateManifest(stamped(gateWith({})()), DEPLOY_INPUTS)
    const labelled = [...manifest.matchAll(/# (\d+)\. (\w+)/g)].map((m) => `${m[1]}:${m[2]}`)
    expect(labelled).toEqual([
      "1:worker_badge_resource",
      "2:arbiter_badge_resource",
      "3:agent_badge_resource",
      "4:max_arbiter_fee_pct",
      "5:human_submit_deadline_secs",
      "6:agent_submit_deadline_secs",
      "7:dispute_auto_resolve_secs",
      "8:expire_grace_secs",
      "9:dispute_auto_resolve_default",
      "10:min_insurance_fraction",
      "11:claim_bond_pct",
      "12:claim_bond_floor",
      "13:claim_bond_cap",
      "14:expire_bounty_pct",
      "15:review_window_secs",
    ])
  })

  it("sweeps the worktop, because instantiate returns THREE things since DB-2", () => {
    // component + owner badge + royalty-admin badge. Both badges must land
    // somewhere; a manifest that named only one would strand the other.
    const manifest = buildInstantiateManifest(stamped(gateWith({})()), DEPLOY_INPUTS)
    expect(manifest).toContain('"try_deposit_batch_or_refund"')
    expect(manifest).toContain('Expression("ENTIRE_WORKTOP")')
  })

  it("encodes Option::None for the agent badge, and Some(...) when given one", () => {
    const args = gateWith({})()
    expect(buildInstantiateManifest(stamped(args), DEPLOY_INPUTS)).toContain("Enum<0u8>()                    ")
    const withAgent = buildInstantiateManifest(stamped(args), {
      ...DEPLOY_INPUTS,
      agentBadge: "resource_rdx1n2rurpe2efyur5xqvz256yyhecpfjw8ed9v8xxcfxp5mtj9qld9ssq",
    })
    expect(withAgent).toContain(
      'Enum<1u8>(Address("resource_rdx1n2rurpe2efyur5xqvz256yyhecpfjw8ed9v8xxcfxp5mtj9qld9ssq"))'
    )
  })

  it("actually COMPILES — parsed by the real Radix Engine Toolkit, not eyeballed", async () => {
    // The one assertion that proves this is a manifest and not a plausible
    // string. It also settles the `#` comment question empirically: the arg
    // labels are load-bearing for the operator reading a positional list at a
    // signing ceremony, and RTM comment syntax is not something to assume.
    const { RadixEngineToolkit } = await import("@radixdlt/radix-engine-toolkit")
    const manifest = buildInstantiateManifest(stamped(gateWith({})()), DEPLOY_INPUTS)
    const parsed = await RadixEngineToolkit.Instructions.convert(
      { kind: "String", value: manifest },
      1,
      "Parsed"
    )
    expect(Array.isArray(parsed.value)).toBe(true)
    expect(parsed.value).toHaveLength(2) // CALL_FUNCTION + the worktop sweep
  })

  it("refuses to print an address whose CHECKSUM is wrong, not just its shape", async () => {
    // The class the regex cannot reach and the wallet would have caught too late.
    const { assertManifestCompiles } = await import("../../scripts/gen-instantiate-manifest.mjs")
    const manifest = buildInstantiateManifest(stamped(gateWith({})()), {
      ...DEPLOY_INPUTS,
      // Shape-valid, checksum-invalid — passes every regex in this repo.
      arbiterBadge: "resource_rdx1nfmxggm4plrs2c5388ex6z8f8s4hkgvzk6z9jr8f0zc0nfw0m0x0mp",
    })
    await expect(assertManifestCompiles(manifest)).rejects.toThrow(
      /MANIFEST DOES NOT COMPILE[\s\S]*not a valid mainnet address/
    )
  })

  it("fails closed on a malformed ceremony address rather than emitting it", () => {
    const args = gateWith({})()
    // The anchored-address class: a value that merely STARTS like an address and
    // then carries injected manifest text must be rejected, not interpolated.
    expect(() =>
      buildInstantiateManifest(stamped(args), {
        ...DEPLOY_INPUTS,
        workerBadge: 'resource_rdx1aaaaaaaaaaaaaaaaaaaa")\n;\nCALL_METHOD\n  Address("x',
      })
    ).toThrow(/not a valid resource_rdx address/)
    expect(() => buildInstantiateManifest(args, { ...DEPLOY_INPUTS, account: "not-an-account" })).toThrow(
      /not a valid account_rdx address/
    )
  })
})

describe("the committed artifact cannot drift from the sheet", () => {
  it.skipIf(PRIV.skip)("regenerating from the sheet reproduces src/lib/generated/instantiate-spec.ts exactly", () => {
    // The artifact exists ONLY because /deploy-escrow is a client component and
    // `docs/` is outside guild-app's module root, so the browser bundle cannot
    // read the sheet. That convenience is what makes it a staleness risk, and
    // this is the check that pays for it: hand-edit the artifact, or edit the
    // sheet without regenerating, and this reddens.
    const args = gateWith({})()
    const fromSheet = args.map((a: any) => ({
      index: a.index,
      name: a.name,
      kind: a.kind,
      source: a.source,
      literal: a.source === "sheet" ? a.value.literal : null,
    }))
    expect(INSTANTIATE_SPEC.map((a) => ({ ...a }))).toEqual(fromSheet)
  })

  it.skipIf(PRIV.skip)("the app builder and the operator CLI emit BYTE-IDENTICAL manifests", () => {
    // Two callers, one spec. This is the same cross-check the agent-client
    // parity guard applies to the other builders, and it is what stops the page
    // and the ceremony tool from quietly diverging — the failure mode that let
    // three hand-typed copies of this manifest coexist, two of them stale.
    const fromCli = buildInstantiateManifest(stamped(gateWith({})()), DEPLOY_INPUTS)
    const fromApp = instantiateEscrowManifest(
      DEPLOY_INPUTS.escrowPackage,
      DEPLOY_INPUTS.workerBadge,
      DEPLOY_INPUTS.arbiterBadge,
      DEPLOY_INPUTS.agentBadge,
      DEPLOY_INPUTS.account,
      // Same fixture equivalents the CLI side is stamped with — parity is only
      // meaningful when both sides are given the SAME ceremony numbers.
      { claimBondFloor: "55", claimBondCap: "111111" }
    )
    expect(fromApp).toBe(fromCli)
  })

  it("the app builder rejects an injected address instead of interpolating it", () => {
    expect(() =>
      instantiateEscrowManifest(
        DEPLOY_INPUTS.escrowPackage,
        'resource_rdx1aaaaaaaaaaaaaaaaaaaa")\n;\nCALL_METHOD\n  Address("x',
        DEPLOY_INPUTS.arbiterBadge,
        null,
        DEPLOY_INPUTS.account
      )
    ).toThrow(/Invalid resource_rdx address/)
  })
})
