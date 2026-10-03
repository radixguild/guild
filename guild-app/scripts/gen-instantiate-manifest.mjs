#!/usr/bin/env bun
// gen-instantiate-manifest.mjs — P1-4. Emit the escrow `instantiate` deploy
// manifest FROM the signed sheet, and refuse to emit one that disagrees with
// either the sheet or the blueprint.
//
// This replaces hand-typing. There have been three hand-typed copies of this
// manifest in the repo; two were stale (12 args against a blueprint that took
// 13, then 11), and NOTHING checked any of them — not the type-checker, not a
// test, not CI. A wrong manifest surfaces as a reverted transaction at the
// ceremony if you are lucky, and as permanently wrong economics if you are not.
// See lib/instantiate-sheet.mjs for why "if you are not" is the realistic case.
//
//   bun scripts/gen-instantiate-manifest.mjs --check
//       Sheet vs spec vs blueprint. No inputs needed, no manifest printed.
//       This is the CI gate and the pre-sign gate; exit 1 on any mismatch.
//
//   bun scripts/gen-instantiate-manifest.mjs \
//       --package package_rdx1… --worker resource_rdx1… \
//       --arbiter resource_rdx1… --agent resource_rdx1…|none \
//       --account account_rdx1… \
//       --xrd-usd 0.0009 --floor 55 --cap 111000
//       Print the manifest to sign. Runs every --check assertion first.
//
//   … --json     Emit {manifest, args} instead, for tooling.
//
// The three resource addresses are ceremony inputs, not sheet values: all three
// exist on mainnet already, but the sheet only NAMES them (truncated / by
// filename / as `Some(GAGENT)`). They are required flags rather than defaults —
// see the arbiter note in CEREMONY_NOTES for why guessing that one is unsafe.
//
// Rows 12/13 (claim_bond_floor/cap) are ceremony inputs of a SECOND kind: the
// sheet signs them as USD POLICY values ($0.05 / $100), the on-chain field is
// reward-token units, and W4-mech has no oracle — so the operator passes the
// token amounts AND the rate they used (--xrd-usd), and this script VERIFIES
// floor×rate and cap×rate against the signed USD policy (±5%) instead of
// trusting hand arithmetic. Wrong-by-1000x compiles fine; the policy check is
// the only thing that catches it. Record the rate in the ceremony log.

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  INSTANTIATE_ARGS,
  parseSignedSheet,
  buildInstantiateManifest,
  scrapeAutoResolveOrdinals,
  scrapeInstantiateParams,
} from './lib/instantiate-sheet.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
export const SHEET_PATH = resolve(REPO, 'docs/ESCROW-PARAMETER-SHEET.md')
export const LIB_RS_PATH = resolve(REPO, 'escrow/scrypto/guild-marketplace-escrow/src/lib.rs')

/**
 * Compile the manifest with the real Radix Engine Toolkit and refuse if it does
 * not parse.
 *
 * This is the last gate, and it subsumes a class the shape-checks cannot reach.
 * `requireAddress` validates the FORM of an address (anchored lowercase bech32m)
 * but not its CHECKSUM, so a transposed character in an operator-pasted address
 * passes every regex in this repo and produces a manifest the wallet then
 * rejects — or worse, one that names a real-but-different entity. Found while
 * building the P1-4 gate: a placeholder address that had lived in the test
 * fixtures for months was not a valid address at all, and only RET said so.
 *
 * Radix already has the decoder. Using it here means the CLI cannot hand an
 * operator a manifest that will not compile.
 */
export async function assertManifestCompiles(manifest) {
  const { RadixEngineToolkit } = await import('@radixdlt/radix-engine-toolkit')
  try {
    await RadixEngineToolkit.Instructions.convert({ kind: 'String', value: manifest }, 1, 'Parsed')
  } catch (err) {
    const detail = String(err?.message ?? err)
    // RET's message arrives double-escaped inside nested JSON, so match the
    // address itself rather than trying to count backslashes.
    const bad = detail.match(/InvalidGlobalAddress\([\\"]*([a-z_]+_rdx1[a-z0-9]+)/)?.[1]
    const why = bad
      ? `  The address \`${bad}\` is not a valid mainnet address. A shape-check passes on a\n` +
        '  transposed character; the bech32m checksum does not. Re-copy it from the ledger.\n'
      : `  ${detail.slice(0, 400)}\n`
    throw new Error(
      'MANIFEST DOES NOT COMPILE — the Radix Engine Toolkit refused to parse it.\n' +
        why +
        '  Nothing was printed. Fix the input rather than hand-editing the output.'
    )
  }
}

/**
 * Every check that must hold before a manifest may be printed, let alone signed.
 *
 * Exported so the gate test runs the SAME code the operator runs. A gate that
 * reimplements the thing it guards is a test of the reimplementation — this repo
 * shipped exactly that in the fee-lock guard (#U4), whose test was a byte-for-byte
 * copy of the buggy logic and stayed green when the real prepend was deleted.
 *
 * Returns the parsed args on success; throws with a named reason otherwise.
 */
export function checkSignedSheet({ sheetPath = SHEET_PATH, libRsPath = LIB_RS_PATH } = {}) {
  const args = parseSignedSheet(sheetPath)

  // 1. SHAPE — the spec's arg list must equal the blueprint's, in order.
  //    Catches: an arg added/removed/reordered in the blueprint without the
  //    sheet and this generator moving with it.
  const blueprint = scrapeInstantiateParams(libRsPath)
  const spec = INSTANTIATE_ARGS.map((a) => a.name)
  if (blueprint.join(',') !== spec.join(',')) {
    throw new Error(
      'BLUEPRINT/SPEC MISMATCH — `instantiate` does not take the arguments this generator emits.\n' +
        `  blueprint: ${blueprint.join(' · ')}\n` +
        `  generator: ${spec.join(' · ')}\n` +
        'These are positional write-once economics. Reconcile the sheet, the blueprint and\n' +
        'INSTANTIATE_ARGS before generating anything.'
    )
  }

  // 2. THE ENUM BYTE — do not trust the sheet's own encoding.
  //    The sheet says both `SplitEvenly` and `Enum<1u8>`. Declaration order in
  //    the blueprint IS the SBOR discriminant, so the byte is only correct if
  //    the blueprint agrees. A reordered enum decodes silently into different
  //    economics; nothing else in the stack would notice.
  const enumArg = args.find((a) => a.kind === 'Enum')
  const ordinals = scrapeAutoResolveOrdinals(libRsPath)
  const expected = ordinals[enumArg.value.variant]
  if (expected === undefined) {
    throw new Error(
      `ENUM MISMATCH — the sheet selects \`${enumArg.value.variant}\`, which is not a variant of ` +
        `AutoResolveDefault in the blueprint (${Object.keys(ordinals).join(', ')}).`
    )
  }
  if (expected !== enumArg.value.ordinal) {
    throw new Error(
      `ENUM MISMATCH — the sheet writes \`${enumArg.value.variant}\` = Enum<${enumArg.value.ordinal}u8>, ` +
        `but the blueprint declares ${enumArg.value.variant} at ordinal ${expected} ` +
        `(${Object.entries(ordinals).map(([k, v]) => `${k}=${v}`).join(', ')}).\n` +
        'This is the highest-consequence value in the sheet: the wrong byte selects different\n' +
        'dispute economics for the life of the component, decodes without error, and is\n' +
        'unfixable except by migration.'
    )
  }

  // 3. VALUES PRESENT — every sheet-sourced arg produced a literal.
  const missing = args.filter((a) => a.source === 'sheet' && !a.value?.literal)
  if (missing.length) {
    throw new Error(`sheet rows produced no value: ${missing.map((a) => a.name).join(', ')}`)
  }

  return args
}

/**
 * Printed to stderr beside every generated manifest, so it reaches the operator
 * at the moment of signing rather than sitting in a runbook they already read.
 *
 * The custody note is not boilerplate: it is a real gap between what DB-2 ruled
 * and what one transaction can do, found while building this generator.
 */
const CEREMONY_NOTES = `
  ── Before you sign ────────────────────────────────────────────────────────

  Where the three ceremony addresses come from (the sheet NAMES them; only the
  ledger determines them):
    1. worker_badge_resource   — ESCROW-ADDRESSES.md, the LIVE component table.
    2. arbiter_badge_resource  — ESCROW-ADDRESSES.md, the LIVE table:
       resource_rdx1nf229dxvw72cqzrrkgqvn6zxxjmjpf3hx0zhulsfz4tka5kgnvakn3
       (supply 1, guild-held, DISTINCT from the worker badge).
       ⚠️ THREE live docs disagree here. The vNext2 table in the parameter sheet
       and ESCROW-ADDRESSES.md's v1 table both say the arbiter badge IS the
       worker badge — true of the SUPERSEDED v1 component, where it was a pilot
       shortcut. Copying that collapses the arbiter onto the PUBLIC-MINT member
       badge, making every member an arbiter for the component's whole life.
       There is no setter. Read it off the LIVE table, not from "unchanged".
    3. agent_badge_resource    — GAGENT, from ASSET-REGISTRY.json (the LIVE
       table elides it as \`Some(…)\`). ⚠️ This note read "Supply is 0 today, so
       the agent branch is wired but unreachable" until 2026-08-16; the chain
       says total_supply = 2 (#1# standing worker, #2# Operations), and #2#
       live-proved the 1-day agent deadline during the P1-5 rehearsal. The lane
       is wired AND reachable. --agent none is Option::None and turns it off;
       that is a real choice, so it is spelled out rather than defaulted.
       ⚠️ GAGENT is permanently operator-gated and soulbound (\`minter_updater\`
       and \`withdrawer_updater\` both DenyAll), so passing it here does not make
       the agent lane self-serve — that is a posture, not an oversight.

  ⚠️ TWO BADGES COME BACK, AND THIS TRANSACTION CANNOT SEPARATE THEM.
  \`instantiate\` returns (component, owner_badge, royalty_admin_badge). Both
  badges are MINTED INSIDE the call, so their addresses do not exist while this
  manifest is being written and no TAKE_FROM_WORKTOP can name one of them. The
  sweep therefore lands BOTH in --account.

  DB-2's separation therefore needs a SECOND transaction, once the resource
  addresses exist. ⚠️ RULED 2026-08-16 — this note said "a FRESH DEDICATED SEED"
  and that the ceremony "is not complete when this manifest commits". Both are
  superseded. ⚠️ RE-RULED 2026-09-10 — the standing poster sits on the
  COMPROMISED seed (SEED-MIGRATION-2026-09-07), so --account is now the NEW-SEED
  Guild admin account_rdx12y6ch4m8wjcgu7hrnwfqjeqt70w4kh7qy7k3gs2j9wyx3596fgt3fm,
  the account M1 moves the existing Escrow Owner set into (RUNBOOK-8B Finding 2).
  DB-2's separation of the royalty-admin badge still happens in a SECOND
  transaction, DEFERRED OUT of the ceremony, now to the new-seed poster
  account_rdx12y5senkxfxg38swfv4tg88lx73jqnkdvcnzv8kwwdmg0efl40r2p7u: Phase 1 is
  steps 1–2 only. Deferring is safe because the royalty-admin badge is a plain supply-1
  fungible with no withdraw restriction, so its location is an ordinary transfer,
  not a write-once binding. What IS permanent is which RESOURCE carries the
  authority, and that is fixed here regardless of where the badge sits.
  ⛔ NOT Operations — it plays the worker side of Phase-3 verification.

  So: record both badge addresses now; move the royalty-admin badge at any later
  sitting. Until you do, dial authority and operator authority share an account —
  worth closing, but it grieves only the fee dial (protocol-capped ~166.67
  XRD/call), never escrowed funds, bonds or claim revenue (royalty_claimer is the
  OWNER badge). See RUNBOOK-8B-CUTOVER.md Phase 1 step 3 for the exact manifest.
`

/**
 * Render the committed TypeScript artifact the /deploy-escrow page imports.
 *
 * The page is `"use client"`, and `docs/` sits above `guild-app/` and outside
 * its tsconfig include and Next's module root — so the page cannot read the
 * sheet, at build time or any other time. A generated-and-committed artifact is
 * the only way the browser bundle can carry sheet-derived values, and the drift
 * test (tests/unit/escrow-instantiate-gate.test.ts) is what stops it going
 * stale: it regenerates from the sheet and byte-compares.
 *
 * This follows the repo's existing generated-and-committed precedent
 * (`guild-app/drizzle/*.sql`), not a new one.
 */
function renderArtifact(args) {
  const rows = args
    .map((a) => {
      const value = a.source === 'sheet' ? JSON.stringify(a.value.literal) : 'null'
      return `  { index: ${a.index}, name: ${JSON.stringify(a.name)}, kind: ${JSON.stringify(
        a.kind
      )}, source: ${JSON.stringify(a.source)}, literal: ${value} },`
    })
    .join('\n')

  return `// GENERATED — DO NOT EDIT BY HAND.
//
//   bun scripts/gen-instantiate-manifest.mjs --emit-artifact
//
// Source of truth: docs/ESCROW-PARAMETER-SHEET.md §"Wave B — the signed sheet"
// (signed 2026-08-31, re-signed 2026-09-01). Regenerating is the ONLY correct
// way to change anything below; tests/unit/escrow-instantiate-gate.test.ts
// regenerates from the sheet and byte-compares, so a hand-edit goes red.
//
// Unlike most "do not edit" banners in this repo — one of which guarded a doc
// nothing regenerated for four ABI changes — this one names a real generator and
// a real gate that enforces it.
//
// \`literal: null\` marks a CEREMONY input, of which there are two kinds:
// source "deploy" = an address the sheet only NAMES (truncated, by filename,
// or as \`Some(GAGENT)\`); source "ceremony" = a USD POLICY value (rows 12/13,
// bond floor/cap) whose token amount is computed at the ceremony rate and
// verified against the signed policy by the generator. Never defaulted.

export type InstantiateArgSpec = {
  index: number
  name: string
  kind: "Address" | "OptionAddress" | "Decimal" | "u64" | "Enum"
  source: "sheet" | "deploy" | "ceremony"
  literal: string | null
}

export const INSTANTIATE_SPEC: readonly InstantiateArgSpec[] = [
${rows}
] as const
`
}

function parseArgv(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

async function main() {
  const opts = parseArgv(process.argv.slice(2))
  let args
  try {
    args = checkSignedSheet()
  } catch (err) {
    console.error(`\n  ⛔ REFUSING TO GENERATE\n\n${err.message}\n`)
    process.exit(1)
  }

  if (opts['emit-artifact']) {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const out = resolve(REPO, 'guild-app/src/lib/generated/instantiate-spec.ts')
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, renderArtifact(args))
    console.error(`  wrote ${out}`)
    return
  }

  if (opts.check) {
    // Count derived, never hardcoded: this line read "all 11 positional args"
    // while the blueprint took 15 — the same expiry-dated-count class as the
    // "— 14 args" heading, in the ceremony tool's own PASS banner.
    console.error(
      `  PASS  sheet ↔ generator ↔ blueprint agree on all ${args.length} positional args`
    )
    console.error(
      `  PASS  dispute_auto_resolve_default = ${args.find((a) => a.kind === 'Enum').value.display} ` +
        `(${args.find((a) => a.kind === 'Enum').value.literal}), ordinal confirmed against the blueprint enum`
    )
    console.error('\n  Sheet-determined values:')
    for (const a of args.filter((x) => x.source === 'sheet')) {
      console.error(`    ${String(a.index).padStart(2)}. ${a.name.padEnd(30)} ${a.value.literal}`)
    }
    console.error('\n  Ceremony inputs — addresses (the sheet names these; only the ledger determines them):')
    for (const a of args.filter((x) => x.source === 'deploy')) {
      console.error(`    ${String(a.index).padStart(2)}. ${a.name}`)
    }
    // Rows 12/13 matched NEITHER filter above and silently vanished from the
    // display — an operator reading --check saw 13 args accounted for and no
    // hint the other two existed. Every source gets a list; a row that fits
    // none of them is now a loud error, not a quiet omission.
    console.error('\n  Ceremony inputs — USD policy values (sheet signs the POLICY; you supply the token amount + rate):')
    for (const a of args.filter((x) => x.source === 'ceremony')) {
      console.error(
        `    ${String(a.index).padStart(2)}. ${a.name.padEnd(30)} USD ${a.usdPolicy} — pass the reward-token equivalent; verified against --xrd-usd`
      )
    }
    const unlisted = args.filter((x) => !['sheet', 'deploy', 'ceremony'].includes(x.source))
    if (unlisted.length) {
      console.error(`\n  ⛔ args with an UNKNOWN source (display would have hidden them): ${unlisted.map((a) => a.name).join(', ')}`)
      process.exit(1)
    }
    console.error('')
    return
  }

  const need = ['package', 'worker', 'arbiter', 'agent', 'account', 'xrd-usd', 'floor', 'cap']
  const absent = need.filter((k) => !opts[k])
  if (absent.length) {
    console.error(
      `\n  Missing required input(s): ${absent.map((k) => '--' + k).join(', ')}\n\n` +
        '  --package/--worker/--arbiter/--agent/--account are the ceremony addresses the\n' +
        '  sheet names but cannot determine (--agent none for Option::None).\n' +
        '  --floor/--cap are the claim-bond clamps in REWARD-TOKEN units, and --xrd-usd is\n' +
        '  the rate you converted at: the sheet signs these as USD POLICY values, and this\n' +
        '  script verifies your token amounts against that policy rather than trusting\n' +
        '  hand arithmetic. Run --check alone to verify the sheet without supplying any.\n'
    )
    process.exit(2)
  }

  // ── The USD-policy check (rows 12/13) ─────────────────────────────────────
  // floor×rate and cap×rate must land within 5% of the SIGNED USD policy. 5%
  // absorbs round-number token amounts against a moving rate; it does not
  // absorb a missed conversion — the failure this exists for is off by ~1000x.
  const rate = Number(opts['xrd-usd'])
  if (!Number.isFinite(rate) || rate <= 0) {
    console.error(`\n  ⛔ --xrd-usd must be a positive number (got ${JSON.stringify(opts['xrd-usd'])})\n`)
    process.exit(2)
  }
  for (const [flag, argName] of [['floor', 'claim_bond_floor'], ['cap', 'claim_bond_cap']]) {
    const spec = args.find((a) => a.name === argName)
    const amount = Number(opts[flag])
    if (!Number.isFinite(amount) || amount < 0 || !/^\d+(\.\d+)?$/.test(String(opts[flag]))) {
      console.error(`\n  ⛔ --${flag} must be a plain non-negative decimal in reward-token units (got ${JSON.stringify(opts[flag])})\n`)
      process.exit(2)
    }
    const usd = amount * rate
    const policy = Number(spec.usdPolicy)
    const drift = Math.abs(usd - policy) / policy
    if (drift > 0.05) {
      console.error(
        `\n  ⛔ USD POLICY VIOLATION on ${argName}\n\n` +
          `  You passed --${flag} ${opts[flag]} at --xrd-usd ${rate}: that is USD ${usd.toPrecision(4)}.\n` +
          `  The signed sheet's policy for row ${spec.index} is USD ${spec.usdPolicy} (drift ${(drift * 100).toFixed(1)}%, allowed 5%).\n` +
          `  At this rate the policy value is ~${(policy / rate).toPrecision(4)} tokens.\n` +
          '  This is the ~1000x class the sign-off found: a bare sheet number emitted as a\n' +
          '  token amount compiles, commits, and is wrong for the life of the component.\n' +
          '  Fix the amount (or the rate), and record the rate you used in the ceremony log.\n'
      )
      process.exit(1)
    }
    spec.value = { literal: `Decimal("${opts[flag]}")`, display: `${opts[flag]} (USD ${usd.toPrecision(3)} @ ${rate})` }
  }
  console.error(
    `  PASS  USD policy: floor ${opts.floor} × ${rate} ≈ $${(Number(opts.floor) * rate).toPrecision(3)} (policy $${args.find((a) => a.name === 'claim_bond_floor').usdPolicy}) · ` +
      `cap ${opts.cap} × ${rate} ≈ $${(Number(opts.cap) * rate).toPrecision(4)} (policy $${args.find((a) => a.name === 'claim_bond_cap').usdPolicy})`
  )
  console.error(`  ⚠️  RECORD --xrd-usd ${rate} in the ceremony log — the USD policy is carried by process, not by chain.\n`)

  let manifest
  try {
    manifest = buildInstantiateManifest(args, {
      escrowPackage: opts.package,
      workerBadge: opts.worker,
      arbiterBadge: opts.arbiter,
      agentBadge: opts.agent === 'none' ? null : opts.agent,
      account: opts.account,
    })
  } catch (err) {
    console.error(`\n  ⛔ REFUSING TO GENERATE\n\n${err.message}\n`)
    process.exit(1)
  }

  try {
    await assertManifestCompiles(manifest)
  } catch (err) {
    console.error(`\n  ⛔ REFUSING TO PRINT\n\n${err.message}\n`)
    process.exit(1)
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        { manifest, args: args.map(({ index, name, kind, source, value }) => ({ index, name, kind, source, value })) },
        null,
        2
      ) + '\n'
    )
    return
  }

  console.error('  Generated from docs/ESCROW-PARAMETER-SHEET.md §"Wave B — the signed sheet". Verify before signing.')
  console.error('  Compiled by the Radix Engine Toolkit — every address decoded.\n')
  process.stdout.write(manifest + '\n')
  console.error(CEREMONY_NOTES)
}

if (import.meta.main) await main()
