// preview-summary.mjs — read a Gateway `/transaction/preview` response the way an
// operator needs to read it, seconds before deciding whether to sign.
//
// WHY THIS IS A SEPARATE, PURE MODULE
// -----------------------------------
// The CLI half is network plumbing and cannot be tested without mainnet. This half
// is where every judgement lives — did it succeed, what would move, what would it
// emit, and if it failed, WHY — so it is pure, exported, and covered by fixtures
// captured from real mainnet previews.
//
// THE DISTINCTION THIS EXISTS TO PRESERVE
// ---------------------------------------
// A preview fails for two completely different reasons and an operator must never
// confuse them:
//
//   • BlueprintPayloadValidationError — the manifest CANNOT work. Wrong argument
//     type, wrong arity: no state, no wallet and no amount of retrying changes it.
//     This is what proved all three PULL builders broken on 2026-08-09, and what a
//     truncated error string hides.
//   • ApplicationError / PanicMessage — the manifest is well-formed but the CHAIN
//     disagrees right now (wrong task state, nothing owed, deadline not reached).
//     Same manifest may be perfectly correct an hour later.
//
// So `kind` is computed, not left for a human to squint at, and the error message is
// NEVER truncated. A shortened blueprint error is how a signature error gets read as
// a state error and an operator signs anyway.
//
// WHAT `moves` DOES NOT SHOW — MEASURED, NOT SUSPECTED
// ---------------------------------------------------
// `deltas` is a faithful sum of the Gateway's `resource_changes`, and
// `resource_changes` is not a complete account of what moved. MEASURED 2026-08-20
// against mainnet: a transaction that MINTS an NFT to an account and BURNS it in the
// SAME transaction reports the +1 deposit row and NO -1 burn row. Reproduced with a
// full escrow lifecycle manifest ending in `burn_task_receipt` — the receipt resource
// `resource_rdx1nf57tptrl0ar5vhqzl5ln763ktzg86rcwwxyqh3t7esmd38t5qws7w` summed to +1
// for the poster account, while `receipt.events` held 3 Burn events, including the one
// that destroyed it.
//
// So the netting promise in `summarizePreview` below holds FOR FUNGIBLES and does NOT
// hold for non-fungible burns: the -1 side never arrives, so there is nothing to net
// against, and an operator reads `+1 receipt` as a credential they still hold. This is
// upstream Gateway behaviour, not an aggregation bug here — and it is exactly the
// failure class this module exists to prevent: a true-looking readout that means
// something other than what it appears to.
//
// THE EVENT STREAM IS AUTHORITATIVE FOR MINT/BURN, `moves` is not. Both the Mint and
// the Burn event sit in NOISE_EVENTS, so the DEFAULT view hides an NFT burn twice —
// once from the rows, once from the event line — and `--all-events` is what shows it.
// `nftBurnEvents` exists so `formatSummary` can say that where the operator is already
// looking, rather than in a comment nobody opens seconds before signing.
//
// DELIBERATELY NOT "fixed" by synthesising -1 rows from Burn events. Netting is per
// (entity, resource), so a synthetic row has to name the entity the NFT left, and
// nothing here proves a Burn event identifies it — that mapping is UNVERIFIED. A
// confidently wrong `-1 escrow` row would be worse than a documented gap. Flag, do not
// fabricate. If someone proves the mapping against mainnet, this is the place to
// change, and the fixture in tests/unit/preview-summary.test.ts is the place to prove
// it.

/** Entity addresses are long and the middle carries no information for a human. */
export function shortAddr(a) {
  if (typeof a !== 'string' || a.length <= 24) return a
  return `${a.slice(0, 14)}…${a.slice(-8)}`
}

/**
 * Events every transaction emits. Hidden by default because they bury the three or
 * four that actually say what happened — `TaskReleasedEvent` is the signal,
 * `DepositEvent` ×4 is not. Never dropped from the data, only from the default view.
 */
export const NOISE_EVENTS = new Set([
  'WithdrawEvent',
  'DepositEvent',
  'VaultCreationEvent',
  'MintNonFungibleResourceEvent',
  'BurnNonFungibleResourceEvent',
  'MintFungibleResourceEvent',
  'BurnFungibleResourceEvent',
  'LockFeeEvent',
  'PayFeeEvent',
])

/** `SystemError(TypeCheckError(BlueprintPayloadValidationError(...` → the class alone. */
export function classifyError(message) {
  if (!message) return 'unknown'
  if (message.includes('BlueprintPayloadValidationError')) return 'signature-mismatch'
  if (message.includes('PanicMessage') || message.includes('ApplicationError')) return 'chain-state'
  if (message.includes('AuthError')) return 'auth'
  return 'other'
}

/**
 * Aggregate a preview response into the few facts a signing decision turns on.
 *
 * Resource changes are summed per (entity, resource) rather than listed per
 * instruction: a bond that is withdrawn and returned in the same transaction nets to
 * zero, and showing it as -10 then +10 invites reading a round trip as a loss.
 * Rows that net to zero are dropped from `deltas` but counted in `nettedOut`, so
 * "nothing moved" and "nothing was examined" stay distinguishable.
 *
 * ⚠ THAT NETTING IS ONLY AS COMPLETE AS `resource_changes`. Fungible round trips net
 * correctly. NFT BURNS DO NOT — the Gateway omits them from `resource_changes`
 * entirely (measured 2026-08-20; see the module header), so a receipt minted and
 * burned in one transaction renders as a standing `+1`. `allEvents` (CLI:
 * `--all-events`) is authoritative for mint/burn; `nftBurnEvents` counts the burns
 * this sum structurally cannot show.
 */
export function summarizePreview(response) {
  const receipt = response?.receipt ?? {}
  const status = receipt.status ?? 'Unknown'
  const ok = status === 'Succeeded'
  const message = receipt.error_message ?? null

  const fees = receipt.fee_summary ?? {}
  const feeXrd =
    [fees.xrd_total_execution_cost, fees.xrd_total_finalization_cost, fees.xrd_total_storage_cost]
      .map((n) => Number(n ?? 0))
      .reduce((a, b) => a + b, 0) || null

  const sums = new Map()
  for (const group of response?.resource_changes ?? []) {
    for (const change of group.resource_changes ?? []) {
      const entity = change.component_entity?.entity_address ?? change.entity_address ?? '?'
      // \x1f (ASCII unit separator) joins the halves; the split below must use the
      // same char. No control character can occur inside a Radix address -- bech32m
      // confines the HRP to printable ASCII and the data part to a 32-char alphanumeric
      // set -- so the halves can never collide and the split can never cut in the wrong
      // place. That guarantee comes from the address FORMAT, not from a survey of the
      // addresses we happen to see today, which is why this is a purpose-built
      // separator rather than a space or a dash.
      //
      // It was a literal NUL byte until 2026-08-20. NUL holds the same property, but
      // git's binary heuristic keys on NUL, so `git diff` rendered this entire module
      // "Binary file not shown": a money-path file an operator reads seconds before
      // signing, which no PR could review. It is written as an ESCAPE, never a raw
      // byte, for that same reason -- see the source-level guard in the test file.
      const key = `${entity}\x1f${change.resource_address}`
      sums.set(key, (sums.get(key) ?? 0) + Number(change.amount))
    }
  }
  const deltas = []
  let nettedOut = 0
  for (const [key, amount] of sums) {
    const [entity, resource] = key.split('\x1f')  // must match the join above
    // 1e-15 not 0: Decimal is 18dp and summing its string forms in JS floats leaves
    // dust well below any amount that could matter. Comparing to exact zero would
    // print a phantom `+0.0000000000000001` row on a clean round trip.
    if (Math.abs(amount) < 1e-15) {
      nettedOut++
      continue
    }
    deltas.push({ entity, resource, amount })
  }

  const allEvents = (receipt.events ?? []).map((e) => e.type?.name ?? e.name ?? '?')
  return {
    status,
    ok,
    kind: ok ? null : classifyError(message),
    error: message,
    feeXrd,
    deltas,
    nettedOut,
    // Burns that `deltas` CANNOT show — see the module header. Counted, never folded
    // into the sums: netting needs the entity the NFT left, which a Burn event is not
    // proven here to carry. Fungible burns are excluded deliberately — every
    // transaction burns its fee, so counting those would fire this warning always and
    // therefore mean nothing.
    nftBurnEvents: allEvents.filter((n) => n === 'BurnNonFungibleResourceEvent').length,
    events: allEvents.filter((n) => !NOISE_EVENTS.has(n)),
    allEvents,
  }
}

/** Render a summary for a terminal. `labels` maps addresses to human names. */
export function formatSummary(summary, { labels = {}, allEvents = false } = {}) {
  const out = []
  out.push(`  status   ${summary.status}${summary.ok ? '' : `  (${summary.kind})`}`)
  if (summary.feeXrd) out.push(`  fee      ~${summary.feeXrd.toFixed(6)} XRD`)

  if (!summary.ok) {
    // Deliberately unabridged — see the module header.
    out.push('', '  error', ...String(summary.error ?? '(no message)').split('\n').map((l) => `    ${l}`))
    if (summary.kind === 'signature-mismatch') {
      out.push(
        '',
        '  This is a SIGNATURE mismatch, not a state problem. The manifest passes an',
        '  argument the blueprint does not accept; no wallet, epoch or retry fixes it.',
        '  Compare the call against the scraped ABI:',
        '      cd guild-app && bun scripts/gen-method-inventory.mjs',
      )
    }
    return out.join('\n')
  }

  if (summary.deltas.length === 0) {
    out.push(`  moves    nothing${summary.nettedOut ? ` (${summary.nettedOut} round-trip, net zero)` : ''}`)
  } else {
    out.push('  moves')
    for (const d of summary.deltas) {
      const who = labels[d.entity] ?? shortAddr(d.entity)
      const what = labels[d.resource] ?? shortAddr(d.resource)
      const sign = d.amount > 0 ? '+' : ''
      out.push(`    ${who.padEnd(22)} ${what.padEnd(24)} ${sign}${d.amount}`)
    }
    if (summary.nettedOut) out.push(`    (${summary.nettedOut} further vault(s) net to zero)`)
  }

  // The rows above are structurally incapable of showing an NFT burn. Say it here,
  // under the `+1` it qualifies, because that is where the operator is looking.
  if (summary.nftBurnEvents) {
    const n = summary.nftBurnEvents
    out.push(
      `    ⚠ ${n} non-fungible BURN event${n === 1 ? '' : 's'} NOT reflected above — the Gateway omits NFT`,
      '      burns from resource_changes, so a "+1" row can name a receipt or badge this',
      '      same transaction destroyed. The event stream is authoritative: --all-events',
    )
  }

  const events = allEvents ? summary.allEvents : summary.events
  out.push(`  events   ${events.length ? events.join(' → ') : '(none)'}`)
  return out.join('\n')
}
