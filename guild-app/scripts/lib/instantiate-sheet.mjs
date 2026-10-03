// instantiate-sheet.mjs — the ONE place that turns the signed parameter sheet
// into escrow `instantiate` arguments, and the only thing allowed to decide what
// the deploy manifest says.
//
// WHY THIS EXISTS, stated as the failure it prevents rather than as a principle.
//
// `instantiate` takes FIFTEEN POSITIONAL arguments (eleven at the PULL cutover
// — the census below was written then and kept as the argument's origin; Wave B
// stages 5/6 added claim_bond_pct/floor/cap, expire_bounty_pct and
// review_window_secs, making the transposition surface WORSE: five u64s and
// six Decimals) and every one is write-once-or-setter-guarded: they are the
// component's economics, and hand-typing them is the failure. The original
// eleven-arg census, kept for the reasoning:
//
//     1  worker_badge_resource          ResourceAddress
//     2  arbiter_badge_resource         ResourceAddress
//     3  agent_badge_resource           Option<ResourceAddress>
//     4  max_arbiter_fee_pct            Decimal      ┐
//     5  human_submit_deadline_secs     u64          │
//     6  agent_submit_deadline_secs     u64          │ consecutive same-typed
//     7  dispute_auto_resolve_secs      u64          │ runs are the trap
//     8  expire_grace_secs              u64          │
//     9  dispute_auto_resolve_default   AutoResolveDefault
//    10  min_insurance_fraction         Decimal      │
//    11  claim_bond_xrd (→ _pct)        Decimal      ┘
//    12  claim_bond_floor               Decimal  (Wave B — CEREMONY input, USD policy)
//    13  claim_bond_cap                 Decimal  (Wave B — CEREMONY input, USD policy)
//    14  expire_bounty_pct              Decimal  (Wave B)
//    15  review_window_secs             u64      (Wave B)
//
// SBOR is typed, so a WRONG-ARITY manifest usually fails loudly at decode. But
// transposing two same-typed args does not: swap `human_submit_deadline_secs`
// with `agent_submit_deadline_secs`, or `min_insurance_fraction` with
// `max_arbiter_fee_pct`, and the transaction COMMITS. The component is then
// permanently wrong, in a way no test, no type-checker and no wallet can see,
// and the only remedy is another migration. Long same-typed runs in one
// positional list are a silent-transposition surface that hand-typing cannot be
// trusted with — and the repo has already shipped three hand-typed copies of
// this manifest, two of them stale, none checked by anything.
//
// So: the signed sheet is the source, this module is the only reader, and the
// gate (tests/unit/escrow-instantiate-gate.test.ts) refuses on any mismatch.
//
// ── What the sheet CAN and CANNOT determine ──────────────────────────────────
//
// Rows 4-11 are hard literals: the sheet fully determines them and nothing else
// may. Rows 1-3 are RESOURCE ADDRESSES the sheet only NAMES, not values it determines:
// row 1's cell is a deliberately truncated `resource_rdx1n22rq94…ppwl` (a real
// U+2026, not "..."), row 2's only backticked token is a FILENAME, and row 3
// says `Some(GAGENT)` — Rust syntax plus a symbolic name. All three resources
// DO already exist on mainnet (§8b minted them in June 2026); the sheet elides
// them, the chain does not. They are supplied explicitly at deploy time and
// shape-checked here.
//
// ⚠️ They are NOT defaulted, deliberately. THREE live docs disagree about row 2:
// the vNext2 table in this same sheet and ESCROW-ADDRESSES.md's v1 table both
// say the arbiter badge IS the worker badge — true of the SUPERSEDED v1
// component, where it was a pilot shortcut. The chain-verified LIVE table
// (ESCROW-ADDRESSES.md) says `resource_rdx1nf229dx…kn3`, "distinct from worker".
// Resolving "unchanged" from the wrong one would re-collapse the arbiter onto
// the PUBLIC-MINT member badge — making every member an arbiter, for the life of
// a component with no setter. Making the operator paste it is the cheap defence.

import { readFileSync } from 'node:fs'

/** The sheet section that governs. Anything outside it is Wave-B raw material. */
// ⚠️ REPOINTED to Wave B. This read '## PULL cutover — the signed sheet',
// which governs the component running on mainnet TODAY. This generator emits
// the manifest for the NEXT component, so reading the old section would have
// produced a perfectly well-formed manifest for the wrong deploy — 11 args of
// superseded economics, and nothing in the output would have looked wrong.
const SECTION_HEADING = '## Wave B — the signed sheet'

/**
 * The blueprint's parameter list, in order, with the Radix manifest type each
 * argument must be encoded as.
 *
 * This array is NOT the source of truth for VALUES — the sheet is. It is the
 * source of truth for SHAPE, and it is cross-checked against `lib.rs` by the
 * gate, so it cannot silently drift from the blueprint either.
 *
 * `source: 'sheet'`  — the sheet determines it; a mismatch is a gate failure.
 * `source: 'deploy'` — an existing on-chain address supplied at the ceremony;
 *                      shape-checked here, checksum-checked by the CLI's RET pass.
 */
export const INSTANTIATE_ARGS = [
  { index: 1, name: 'worker_badge_resource', kind: 'Address', source: 'deploy' },
  { index: 2, name: 'arbiter_badge_resource', kind: 'Address', source: 'deploy' },
  { index: 3, name: 'agent_badge_resource', kind: 'OptionAddress', source: 'deploy' },
  { index: 4, name: 'max_arbiter_fee_pct', kind: 'Decimal', source: 'sheet' },
  { index: 5, name: 'human_submit_deadline_secs', kind: 'u64', source: 'sheet' },
  { index: 6, name: 'agent_submit_deadline_secs', kind: 'u64', source: 'sheet' },
  { index: 7, name: 'dispute_auto_resolve_secs', kind: 'u64', source: 'sheet' },
  { index: 8, name: 'expire_grace_secs', kind: 'u64', source: 'sheet' },
  { index: 9, name: 'dispute_auto_resolve_default', kind: 'Enum', source: 'sheet' },
  { index: 10, name: 'min_insurance_fraction', kind: 'Decimal', source: 'sheet' },
  { index: 11, name: 'claim_bond_pct', kind: 'Decimal', source: 'sheet' },
  // 🔴 ROWS 12-13 ARE **NOT** SHEET VALUES, AND THE DIFFERENCE IS ~1000x.
  //
  // The sign-off ruling (2026-08-31) made the bond floor/cap USD-DENOMINATED
  // POLICY values: "USD 0.05" and "USD 100". The on-chain field is in
  // REWARD-TOKEN units — W4-mech has no oracle by design — so the USD policy is
  // carried by PROCESS: at each set, the on-chain value is the USD figure
  // converted at the then-current rate, and the ceremony must record the rate
  // it used.
  //
  // Parsing these as `source: 'sheet'` would lift the bare number and emit
  // `Decimal("0.05")` as a TOKEN amount. At XRD ~$0.0009 the intended floor is
  // ~55 XRD; 0.05 XRD is about five thousandths of a cent. Roughly a
  // thousand-fold error, on a write-once deploy, and NOT catchable by any
  // downstream gate — 0.05 is a perfectly valid Decimal, the manifest compiles,
  // and the arity and ordering checks all pass. It would simply be wrong
  // forever.
  //
  // So they are ceremony inputs, like the three addresses: required flags with
  // no default, so the generator refuses to run rather than guess a rate.
  { index: 12, name: 'claim_bond_floor', kind: 'Decimal', source: 'ceremony',
    usdPolicy: '0.05',
    note: 'USD policy — pass the reward-token equivalent at the ceremony rate' },
  { index: 13, name: 'claim_bond_cap', kind: 'Decimal', source: 'ceremony',
    usdPolicy: '100',
    note: 'USD policy — pass the reward-token equivalent at the ceremony rate' },
  { index: 14, name: 'expire_bounty_pct', kind: 'Decimal', source: 'sheet' },
  { index: 15, name: 'review_window_secs', kind: 'u64', source: 'sheet' },
]

class SheetError extends Error {}

/** Every backticked token in a cell, in order. */
function ticks(cell) {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1])
}

/**
 * Extract the 11 rows of the signed `instantiate` table.
 *
 * Deliberately strict. A sheet that has been reformatted, reordered, or had a
 * row's value made ambiguous is NOT something to guess at: this is the input to
 * a write-once mainnet transaction, so every unexpected shape throws with the
 * row that caused it rather than producing a plausible manifest.
 */
export function parseSignedSheet(sheetPath) {
  const raw = readFileSync(sheetPath, 'utf8')
  const at = raw.indexOf(SECTION_HEADING)
  if (at < 0) {
    throw new SheetError(
      `the signed sheet has no "${SECTION_HEADING}" section — refusing to guess which table governs`
    )
  }
  // Stop at the next h2 so a later section's table can never be read as this one.
  const rest = raw.slice(at + SECTION_HEADING.length)
  const nextH2 = rest.indexOf('\n## ')
  const sectionRaw = nextH2 < 0 ? rest : rest.slice(0, nextH2)

  // ⚠️ Then narrow to the instantiate table's own SUBSECTION. Scoping to the
  // whole h2 was not tight enough: the Wave B section also carries the
  // selectable auto-resolve ruling table, whose first column is the SBOR
  // ordinal (0-3). Those rows match the numbered-row filter below exactly as
  // well as the arg rows do, so the parser read 19 args where there are 15 —
  // and that only surfaced because the count happened to disagree. Had the two
  // tables summed to 15, it would have built a manifest out of a mix of both.
  //
  // Anchor on a STABLE heading PREFIX, never the arg count: this heading used
  // to carry "— 14 args", and bumping it at stage 5 broke a different gate's
  // ability to find this same table.
  const TABLE_HEADING = '### `instantiate` —'
  const tableAt = sectionRaw.indexOf(TABLE_HEADING)
  if (tableAt < 0) {
    throw new SheetError(
      `the "${SECTION_HEADING}" section has no "${TABLE_HEADING}" table — refusing to ` +
        'scan the whole section, because every other numbered table in it would parse as args'
    )
  }
  const afterTable = sectionRaw.slice(tableAt + TABLE_HEADING.length)
  const nextH3 = afterTable.indexOf('\n### ')
  const section = nextH3 < 0 ? afterTable : afterTable.slice(0, nextH3)

  const rows = section
    .split('\n')
    .filter((l) => /^\|\s*\d+\s*\|/.test(l))
    .map((l) => l.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()))

  if (rows.length !== INSTANTIATE_ARGS.length) {
    throw new SheetError(
      `the signed sheet lists ${rows.length} numbered argument rows, expected ${INSTANTIATE_ARGS.length}. ` +
        'Arity is write-once at deploy — fix the sheet or the spec, do not let the generator pick.'
    )
  }

  return INSTANTIATE_ARGS.map((spec, i) => {
    const [num, argCell, valueCell] = rows[i]
    if (Number(num) !== spec.index) {
      throw new SheetError(`sheet row ${i + 1} is numbered ${num}, expected ${spec.index} — the table is reordered`)
    }
    // A renamed arg is documented as `~~old~~ → new`, so the CURRENT name is
    // the one after the arrow. Taking `ticks()[0]` lifts the struck-through OLD
    // name — for row 11 that is `claim_bond_xrd`, an argument the Wave B
    // blueprint does not have. The sibling gate (test_setters_match_the_signed
    // _sheet) already reads renames this way; this one did not, and the two
    // reading the same sheet differently is its own hazard.
    const argName = argCell.includes('→')
      ? ticks(argCell.slice(argCell.lastIndexOf('→')))[0]
      : ticks(argCell)[0]
    if (argName !== spec.name) {
      throw new SheetError(
        `sheet row ${spec.index} names \`${argName}\`, the spec expects \`${spec.name}\`. ` +
          'These are POSITIONAL args: a reorder that both sides agree on is still a different component.'
      )
    }
    return { ...spec, value: spec.source === 'sheet' ? readValue(spec, valueCell) : null }
  })
}

/**
 * Pull the one literal a row determines, per its type.
 *
 * Row 9 is the reason this is a switch and not a `ticks(cell)[0]`: its cell
 * carries TWO backticked tokens — the human name (`SplitEvenly`) and the wire
 * encoding (`Enum<1u8>`) — and taking the first would emit `SplitEvenly` into a
 * manifest as if it were manifest syntax. It is also the single
 * highest-consequence value in the file, so both tokens are returned and the
 * gate cross-checks the ordinal against the blueprint's enum declaration.
 */
function readValue(spec, cell) {
  const found = ticks(cell)
  const first = found[0]

  switch (spec.kind) {
    case 'u64': {
      if (!/^\d+$/.test(first ?? '')) {
        throw new SheetError(`sheet row ${spec.index} (${spec.name}): expected an integer, found \`${first}\``)
      }
      return { literal: `${first}u64`, display: first }
    }
    case 'Decimal': {
      if (!/^\d+(\.\d+)?$/.test(first ?? '')) {
        throw new SheetError(`sheet row ${spec.index} (${spec.name}): expected a decimal, found \`${first}\``)
      }
      return { literal: `Decimal("${first}")`, display: first }
    }
    case 'Enum': {
      const variant = found.find((t) => /^[A-Z][A-Za-z]+$/.test(t))
      const wire = found.find((t) => /^Enum<\d+u8>$/.test(t))
      if (!variant || !wire) {
        throw new SheetError(
          `sheet row ${spec.index} (${spec.name}): needs BOTH a variant name and an \`Enum<Nu8>\` encoding, ` +
            `found ${JSON.stringify(found)}. The wrong enum byte is the trap this whole gate exists for — ` +
            'it decodes silently and picks different economics for the life of the component.'
        )
      }
      return { literal: `${wire}()`, display: variant, variant, ordinal: Number(wire.match(/\d+/)[0]) }
    }
    default:
      throw new SheetError(`sheet row ${spec.index} (${spec.name}): kind ${spec.kind} is not sheet-determined`)
  }
}

/** Radix addresses are all-lowercase bech32m; anchored so nothing can break out of the string. */
function requireAddress(value, label, prefix) {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}[a-z0-9]{20,}$`).test(value)) {
    throw new SheetError(`${label}: not a valid ${prefix} address (got ${JSON.stringify(value)})`)
  }
  return value
}

/**
 * Build the deploy manifest.
 *
 * `deployInputs` supplies the three rows the sheet only names. `agentBadge` may
 * be null for `None`, which is a real configuration (the pre-GAGENT era used it)
 * and therefore has to be expressible rather than assumed.
 *
 * The trailing sweep is `try_deposit_batch_or_refund`, not `deposit_batch`:
 * `instantiate` returns a THREE-tuple since DB-2 (component, owner badge,
 * royalty-admin badge) and BOTH badges must land somewhere. A sweep of the whole
 * worktop takes both without naming them, and the `or_refund` form cannot revert
 * the ceremony on a deposit rule.
 */
export function buildInstantiateManifest(args, deployInputs) {
  const pkg = requireAddress(deployInputs.escrowPackage, 'escrowPackage', 'package_rdx')
  const account = requireAddress(deployInputs.account, 'account', 'account_rdx')
  const resolved = {
    worker_badge_resource: `Address("${requireAddress(deployInputs.workerBadge, 'workerBadge', 'resource_rdx')}")`,
    arbiter_badge_resource: `Address("${requireAddress(deployInputs.arbiterBadge, 'arbiterBadge', 'resource_rdx')}")`,
    agent_badge_resource:
      deployInputs.agentBadge == null
        ? 'Enum<0u8>()'
        : `Enum<1u8>(Address("${requireAddress(deployInputs.agentBadge, 'agentBadge', 'resource_rdx')}"))`,
  }

  const lines = args.map((a) => {
    // 'sheet' rows carry their literal from the parse; 'ceremony' rows carry
    // one only after the CLI's USD-policy check stamped it (so calling this
    // without that check still refuses); 'deploy' rows resolve to addresses.
    const literal = a.source === 'deploy' ? resolved[a.name] : a.value?.literal
    if (!literal) throw new SheetError(`no value resolved for arg ${a.index} (${a.name})`)
    // The arg name rides in a comment: a positional list is unreadable at a
    // signing ceremony, and the operator is the last line of defence.
    return `    ${literal}${' '.repeat(Math.max(1, 34 - literal.length))}# ${a.index}. ${a.name}`
  })

  return `CALL_FUNCTION
    Address("${pkg}")
    "Escrow"
    "instantiate"
${lines.join('\n')}
;
CALL_METHOD
    Address("${account}")
    "try_deposit_batch_or_refund"
    Expression("ENTIRE_WORKTOP")
    Enum<0u8>()
;`
}

/**
 * The ordinal each `AutoResolveDefault` variant decodes to, scraped from the
 * blueprint. Declaration order IS the SBOR discriminant, so this is the only
 * honest way to know what `Enum<1u8>` selects — and the reason the gate does not
 * simply trust the sheet's byte.
 */
export function scrapeAutoResolveOrdinals(libRsPath) {
  const src = readFileSync(libRsPath, 'utf8')
  const at = src.indexOf('pub enum AutoResolveDefault {')
  if (at < 0) throw new SheetError('blueprint has no `pub enum AutoResolveDefault` — cannot verify the enum byte')
  const body = src.slice(at, src.indexOf('}', at))
  const variants = body
    .split('\n')
    .slice(1)
    .map((l) => l.trim().replace(/,$/, ''))
    .filter((l) => /^[A-Z][A-Za-z]+$/.test(l))
  if (variants.length < 2) {
    throw new SheetError(`AutoResolveDefault scrape found ${variants.length} variants — the PARSER is broken`)
  }
  return Object.fromEntries(variants.map((v, i) => [v, i]))
}

/** The blueprint's `instantiate` parameter names, in order. Shape cross-check. */
export function scrapeInstantiateParams(libRsPath) {
  const src = readFileSync(libRsPath, 'utf8')
  const head = 'pub fn instantiate('
  const at = src.indexOf(head)
  if (at < 0) throw new SheetError('blueprint has no `pub fn instantiate(`')
  const open = at + head.length
  const end = open + src.slice(open).indexOf(') -> ')
  const flattened = src
    .slice(open, end)
    .split('\n')
    .map((l) => l.split('//')[0])
    .join(' ')
  const names = flattened
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.includes(':'))
    .map((s) => s.slice(0, s.indexOf(':')).trim())
  if (names.length === 0) throw new SheetError('instantiate scrape found NO parameters — the PARSER is broken')
  return names
}
