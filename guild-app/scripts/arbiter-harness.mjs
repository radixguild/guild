#!/usr/bin/env bun
// arbiter-harness.mjs — the ARBITER's on-chain leg: resolve_dispute.
//
// This is the only escape from the unilateral-dispute-lock the P3-3 shared
// context describes: a worker can claim → submit garbage → raise_dispute and
// bank a guaranteed SplitEvenly share via the 72h auto-resolve, and the poster
// has no counter-move except a human arbiter. `resolveDisputeManifest`
// (src/lib/manifests.ts) has existed since the PULL redesign but had ZERO
// callers anywhere in the repo — this is the caller.
//
//   bun scripts/arbiter-harness.mjs badge
//       Read-only. Prints the live arbiter_badge_resource, its local id, and
//       the account that currently holds it. No key needed, nothing signed.
//
//   bun scripts/arbiter-harness.mjs resolve --task <onChainTaskId> \
//       --ruling pay-worker|refund-poster|split \
//       [--worker-pct 0.5 --poster-pct 0.5] [--live]
//       Default: keyless PREVIEW only (Gateway /transaction/preview). Add
//       --live to actually sign and submit — see SAFETY below.
//
// SHAPE AND CONVENTIONS deliberately mirror the existing operator scripts —
// this is not a new house style:
//  * `--live` is opt-in and dry-run is the silent default, exactly like
//    approve-task.mjs (`bun scripts/approve-task.mjs --task N [--live]`) —
//    NOT poster-harness.mjs's `--dry-run`-is-opt-in convention. The inversion
//    is deliberate, not an inconsistency: resolve_dispute is a human arbiter
//    ruling on a REAL dispute after the fact, so the safe default here is
//    "prove it, don't move it" rather than "move it unless told not to".
//  * Keyless preview via /transaction/preview + assume_all_signature_proofs,
//    same recipe as preview-manifest.mjs and edge-revert-probes.mjs.
//  * A pinned expected outcome, reported INCONCLUSIVE (not "pass") when the
//    preview can't say clearly — same discipline as edge-revert-probes.mjs's
//    header note: "A revert is trivial to obtain by accident... every probe
//    therefore pins an expected substring, and a probe that fails differently
//    is reported as INCONCLUSIVE rather than passed." Here the pinned
//    expectation is simpler (this tool exists to make a legitimate ruling
//    succeed, not to prove a revert), but the same three-way split applies:
//    PROVEN (Succeeded) / REVERTED (a real, named failure) / INCONCLUSIVE
//    (the Gateway gave no verdict to read at all — a transport failure is not
//    evidence of anything).
//  * Explicit env vars only: ARBITER_PRIVATE_KEY / ARBITER_ACCOUNT_ADDRESS.
//    Never falls through to signer.js's BOT_PRIVATE_KEY or any other
//    autoload (poster-harness.mjs's SAFETY posture, same reasoning: a wrong
//    key here signs against a REAL dispute).
//
// SAFETY — additional to the two bullets above:
//  * NO hardcoded arbiter resource or account address anywhere in this file.
//    `arbiter_badge_resource` is read from the LIVE escrow component's own
//    state every run (readArbiterBadgeResource); the ACCOUNT that presents it
//    is derived by asking the chain who currently holds the one live badge
//    NFT (findLiveArbiterBadge, via /state/non-fungible/location) — never a
//    constant. This is the standing address-discipline rule taken to its
//    conclusion: a retyped or memorised holder address goes stale the moment
//    custody moves, and it already has moved once (dApp-def → the
//    consolidation account, 2026-08-10). Deriving it live means this script
//    self-corrects instead of silently signing against an emptied vault, and
//    it doubles as the runbook's own "where is the badge held" check.
//  * Chain-state authority: refuses unless the task reads `Disputed` on the
//    Gateway RIGHT NOW (readEscrowTaskInfo) — never trusts a caller-supplied
//    claim about task state.
//  * `--live` ALWAYS previews first and refuses to sign anything the preview
//    did not mark PROVEN. There is no way to submit a transaction this
//    script has not just watched succeed in simulation against the current
//    ledger state — "impossible by accident" applies to a doomed submission,
//    not only to an accidental one.
//  * `--live` additionally asserts the signing key's derived account is the
//    SAME account the chain just named as the live badge holder — not merely
//    equal to a separately-typed ARBITER_ACCOUNT_ADDRESS. A stale/wrong env
//    var is a refusal, not a silent no-op.
//
// WHAT THIS DOES NOT PROVE: a green preview is evidence against the ledger
// AS OF NOW. State moves — re-run immediately before relying on it, same
// caveat as preview-manifest.mjs.

import {
  TransactionBuilder,
  PrivateKey,
  NetworkId,
  RadixEngineToolkit,
} from "@radixdlt/radix-engine-toolkit"
import { resolveDisputeManifest } from "../src/lib/manifests"
import { GATEWAY, ESCROW_COMPONENT } from "../src/lib/config"
import { readEscrowTaskInfo } from "../src/lib/gateway"
import { readTxOutcome } from "./lib/tx-outcome.mjs"

const log = (...a) => console.error("[arbiter-harness]", ...a)
const emit = (obj) => console.log("RESULT " + JSON.stringify(obj))

const GATEWAY_URL = process.env.RADIX_GATEWAY_URL || GATEWAY

async function gatewayPost(path, body) {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`)
  return res.json()
}

async function getCurrentEpoch() {
  const data = await gatewayPost("/status/gateway-status", {})
  const epoch = data.ledger_state?.epoch
  if (!epoch) throw new Error("Gateway returned no epoch — refusing to guess one")
  return epoch
}

// ── Chain-derived arbiter identity — see SAFETY above ────────────────────────

/** Reads `arbiter_badge_resource` off the LIVE component's own state. Never a constant. */
export async function readArbiterBadgeResource(component = ESCROW_COMPONENT) {
  const details = await gatewayPost("/state/entity/details", {
    addresses: [component],
    aggregation_level: "Vault",
  })
  const fields = details?.items?.[0]?.details?.state?.fields ?? []
  const f = fields.find((x) => x?.field_name === "arbiter_badge_resource")
  const addr = f?.value
  if (typeof addr !== "string" || !addr.startsWith("resource_rdx1")) {
    throw new Error(
      `could not read arbiter_badge_resource from ${component} (got ${JSON.stringify(f)}) — ` +
        `is ESCROW_COMPONENT pointed at a component that carries this field?`,
    )
  }
  return addr
}

/**
 * The single LIVE (non-burned) arbiter badge's holder + local id, read
 * straight off the ledger via /state/non-fungible/{ids,location}. Refuses
 * rather than guesses when the badge is absent, all-burned, or — should the
 * resource ever be re-minted with more than one live holder — ambiguous. The
 * deployed resource is supply-1 today (Gateway-verified), so the ambiguous
 * branch is untested-by-necessity; it exists so a future re-mint fails LOUD
 * instead of silently presenting whichever id sorted first.
 */
export async function findLiveArbiterBadge(arbiterBadgeResource) {
  const idsResp = await gatewayPost("/state/non-fungible/ids", {
    resource_address: arbiterBadgeResource,
  })
  const ids = (idsResp?.non_fungible_ids?.items ?? [])
    .map((x) => (typeof x === "string" ? x : x?.non_fungible_id))
    .filter(Boolean)
  if (ids.length === 0) {
    throw new Error(`arbiter badge resource ${arbiterBadgeResource} has NO non-fungible ids on chain`)
  }
  const locResp = await gatewayPost("/state/non-fungible/location", {
    resource_address: arbiterBadgeResource,
    non_fungible_ids: ids,
  })
  const live = (locResp?.non_fungible_ids ?? []).filter((x) => x?.is_burned === false)
  if (live.length === 0) {
    throw new Error(`every arbiter badge id on ${arbiterBadgeResource} is burned — no live arbiter to present`)
  }
  if (live.length > 1) {
    const rows = live.map((x) => `${x.non_fungible_id} → ${x.owning_vault_global_ancestor_address}`).join("; ")
    throw new Error(
      `${live.length} live arbiter badges found (${rows}) — this harness resolves against exactly ` +
        `ONE arbiter identity and refuses to guess which. Extend findLiveArbiterBadge with an explicit ` +
        `selector rather than picking one.`,
    )
  }
  return { localId: live[0].non_fungible_id, holderAccount: live[0].owning_vault_global_ancestor_address }
}

// ── Manifest composition (testable seam — see poster-harness.mjs's
//    buildWithdrawManifest for the same rationale: every LIVE run against a
//    real dispute is a refusal or a one-shot resolution, so without this
//    export the one path that actually moves money would be exercised by
//    nothing) ───────────────────────────────────────────────────────────────
export function buildResolveManifest({ arbiterBadgeResource, arbiterBadgeLocalId, arbiterAccount }, { component, taskId, ruling }) {
  return resolveDisputeManifest(component, arbiterAccount, arbiterBadgeResource, arbiterBadgeLocalId, taskId, ruling)
}

/** CLI ruling string → the DisputeRuling shape resolveDisputeManifest expects. */
export function parseRuling(rulingArg, workerPct, posterPct) {
  if (rulingArg === "pay-worker") return { kind: "PayWorker" }
  if (rulingArg === "refund-poster") return { kind: "RefundPoster" }
  if (rulingArg === "split") {
    if (!workerPct || !posterPct) {
      throw new Error("--ruling split needs --worker-pct AND --poster-pct")
    }
    // Client-side sanity check ahead of the on-chain assert (lib.rs:
    // "split worker_pct + poster_pct must equal 1") — the chain still enforces
    // this on the real percentages; this just turns a cryptic revert into a
    // readable refusal before a --live signature is ever considered.
    const w = Number(workerPct)
    const p = Number(posterPct)
    if (!Number.isFinite(w) || !Number.isFinite(p) || Math.abs(w + p - 1) > 1e-12) {
      throw new Error(`--worker-pct + --poster-pct must sum to exactly 1 (got ${workerPct} + ${posterPct})`)
    }
    return { kind: "Split", workerPct, posterPct }
  }
  throw new Error(`--ruling must be pay-worker|refund-poster|split (got ${rulingArg})`)
}

// ── Keyless preview — pinned expected outcome, INCONCLUSIVE when it can't say ─
async function preview(manifest) {
  const epoch = await getCurrentEpoch()
  const res = await fetch(`${GATEWAY_URL}/transaction/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      manifest,
      start_epoch_inclusive: epoch,
      end_epoch_exclusive: epoch + 10,
      tip_percentage: 0,
      nonce: 1,
      signer_public_keys: [],
      flags: { use_free_credit: true, assume_all_signature_proofs: true, skip_epoch_check: false },
    }),
  })
  const json = await res.json()
  const status = json?.receipt?.status
  if (!status) {
    return { verdict: "INCONCLUSIVE", reason: "Gateway returned no receipt status (transport-level, not a verdict)" }
  }
  if (status === "Succeeded") return { verdict: "PROVEN", status }
  return { verdict: "REVERTED", status, errorMessage: json?.receipt?.error_message ?? "" }
}

// ── Live signing (ARBITER_PRIVATE_KEY / ARBITER_ACCOUNT_ADDRESS ONLY) ────────
export async function loadArbiterKey() {
  const privateKeyHex = process.env.ARBITER_PRIVATE_KEY
  const account = process.env.ARBITER_ACCOUNT_ADDRESS
  if (!privateKeyHex) {
    log("FATAL: ARBITER_PRIVATE_KEY not set — the arbiter badge holder's signing key.")
    process.exit(1)
  }
  if (!account || !account.startsWith("account_rdx1")) {
    log("FATAL: ARBITER_ACCOUNT_ADDRESS not set (account_rdx1…).")
    process.exit(1)
  }
  const pk = new PrivateKey.Ed25519(privateKeyHex)
  const derived = await RadixEngineToolkit.Derive.virtualAccountAddressFromPublicKey(pk.publicKey(), NetworkId.Mainnet)
  const derivedStr = typeof derived === "string" ? derived : String(derived)
  if (derivedStr !== account) {
    log("FATAL: ARBITER_PRIVATE_KEY does not derive ARBITER_ACCOUNT_ADDRESS — wrong key.")
    log(`  derived = ${derivedStr}`)
    log(`  ARBITER_ACCOUNT_ADDRESS = ${account}`)
    process.exit(1)
  }
  return { privateKeyHex, account, pk }
}

async function signAndSubmit(manifest, pk, account) {
  const epoch = await getCurrentEpoch()
  if (!manifest.includes("lock_fee")) {
    manifest = `CALL_METHOD\n  Address("${account}")\n  "lock_fee"\n  Decimal("2")\n;\n\n` + manifest
  }
  const builder = await TransactionBuilder.new()
  const notarized = await builder
    .header({
      networkId: NetworkId.Mainnet,
      startEpochInclusive: epoch,
      endEpochExclusive: epoch + 10,
      nonce: Math.floor(Math.random() * 0xffffffff),
      notaryPublicKey: pk.publicKey(),
      notaryIsSignatory: true,
      tipPercentage: 0,
    })
    .manifest({ instructions: { kind: "String", value: manifest }, blobs: [] })
    .notarize(pk)
  const compiled = await RadixEngineToolkit.NotarizedTransaction.compile(notarized)
  const hex = Buffer.from(compiled).toString("hex")
  const hashResult = await RadixEngineToolkit.NotarizedTransaction.intentHash(notarized)
  const intentHash = hashResult.id
  await gatewayPost("/transaction/submit", { notarized_transaction_hex: hex })
  return { intentHash }
}

// ── Verbs ──────────────────────────────────────────────────────────────────
async function badge() {
  const arbiterBadgeResource = await readArbiterBadgeResource()
  const { localId, holderAccount } = await findLiveArbiterBadge(arbiterBadgeResource)
  log(`arbiter_badge_resource = ${arbiterBadgeResource}`)
  log(`live badge             = ${localId}`)
  log(`held by                = ${holderAccount}`)
  emit({ arbiterBadgeResource, localId, holderAccount })
}

async function resolve({ taskId, rulingArg, workerPct, posterPct, live }) {
  const ruling = parseRuling(rulingArg, workerPct, posterPct)

  const arbiterBadgeResource = await readArbiterBadgeResource()
  const { localId, holderAccount } = await findLiveArbiterBadge(arbiterBadgeResource)
  log(`arbiter badge ${localId} is held by ${holderAccount} (chain-derived, not hardcoded)`)

  // Chain-state authority — never trust a caller-supplied claim about state.
  const info = await readEscrowTaskInfo(taskId, ESCROW_COMPONENT)
  if (!info) {
    log(`FATAL: could not read task ${taskId} on ${ESCROW_COMPONENT} — refusing to build a ruling blind.`)
    process.exit(1)
  }
  log(`task ${taskId}: state=${info.state} raisedBy=${info.disputeRaisedBy ?? "n/a"} worker=${info.workerAccount ?? "n/a"} poster=${info.posterAccount ?? "n/a"}`)
  if (info.state !== "Disputed") {
    log(`FATAL: task ${taskId} is ${info.state} on-chain, not Disputed — resolve_dispute would revert. Refusing to sign or preview a doomed call.`)
    process.exit(1)
  }

  const manifest = buildResolveManifest(
    { arbiterBadgeResource, arbiterBadgeLocalId: localId, arbiterAccount: holderAccount },
    { component: ESCROW_COMPONENT, taskId, ruling },
  )
  log("\n" + manifest)

  const result = await preview(manifest)
  log(`preview: ${result.verdict}${result.status ? ` (${result.status})` : ""}`)
  if (result.verdict === "REVERTED") log(`  error: ${result.errorMessage}`)
  if (result.verdict === "INCONCLUSIVE") log(`  ${result.reason}`)

  if (!live) {
    log("DRY-RUN — nothing signed. Re-run with --live to actually resolve_dispute (only if PROVEN).")
    emit({ dryRun: true, taskId, ruling, arbiterAccount: holderAccount, arbiterBadgeLocalId: localId, preview: result })
    process.exit(result.verdict === "PROVEN" ? 0 : result.verdict === "INCONCLUSIVE" ? 2 : 1)
  }

  // --live: refuse to submit anything the preview did not just prove.
  if (result.verdict !== "PROVEN") {
    log(`FATAL: --live given but the preview was ${result.verdict}, not PROVEN — refusing to submit a doomed or unverified transaction.`)
    process.exit(1)
  }

  const { account, pk } = await loadArbiterKey()
  if (account !== holderAccount) {
    log(`FATAL: ARBITER_ACCOUNT_ADDRESS=${account} does not currently hold the live arbiter badge — the chain says ${holderAccount} does. Refusing to sign.`)
    process.exit(1)
  }

  const { intentHash } = await signAndSubmit(manifest, pk, account)
  const outcome = await readTxOutcome(gatewayPost, intentHash)
  if (outcome.status !== "CommittedSuccess") {
    log(`FATAL: resolve_dispute did not commit — ${outcome.status}: ${outcome.errorMessage ?? "(no error_message)"}`)
    process.exit(1)
  }
  log(`resolve_dispute COMMITTED — ${intentHash}`)
  emit({ live: true, taskId, ruling, arbiterAccount: holderAccount, intentHash })
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const hasFlag = (name) => process.argv.includes(`--${name}`)

async function main() {
  const cmd = process.argv[2]
  switch (cmd) {
    case "badge":
      await badge()
      break
    case "resolve": {
      const taskId = Number(arg("task"))
      if (!Number.isInteger(taskId) || taskId <= 0) throw new Error("resolve needs --task <onChainTaskId>")
      const rulingArg = arg("ruling")
      if (!rulingArg) throw new Error("resolve needs --ruling pay-worker|refund-poster|split")
      await resolve({
        taskId,
        rulingArg,
        workerPct: arg("worker-pct"),
        posterPct: arg("poster-pct"),
        live: hasFlag("live"),
      })
      break
    }
    default:
      log("usage: arbiter-harness.mjs <badge|resolve> [...]")
      log("  badge                                                     read-only: who holds the live arbiter badge")
      log("  resolve --task <id> --ruling pay-worker|refund-poster|split [--worker-pct X --poster-pct Y] [--live]")
      process.exit(2)
  }
}

if (import.meta.main) {
  main().catch((e) => {
    log("fatal: " + String(e))
    process.exit(1)
  })
}
