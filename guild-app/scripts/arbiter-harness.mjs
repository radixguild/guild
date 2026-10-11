#!/usr/bin/env bun
// arbiter-harness.mjs — the ARBITER's on-chain leg: resolve_dispute.
//
// This is the only escape from the unilateral-dispute-lock the P3-3 shared
// context describes: a worker can claim → submit garbage → raise_dispute and
// bank a guaranteed SplitEvenly share via the auto-resolve window, and the poster
// has no counter-move except a human arbiter. `resolveDisputeManifest`
// (src/lib/manifests.ts) has existed since the PULL redesign but had ZERO
// callers anywhere in the repo — this is the caller.
//
//   bun scripts/arbiter-harness.mjs badge
//       Read-only. Prints the live arbiter_badge_resource, its local id, and
//       the account that currently holds it. No key needed, nothing signed.
//
//   bun scripts/arbiter-harness.mjs disputes
//       Read-only, Gateway reads only. Lists every task in state Disputed on
//       the live component — task id, reward, who raised it (and their
//       account), disputed_at, the window and default PINNED on the task at
//       raise_dispute (the ones auto_resolve_dispute enforces; the component's
//       live values apply only to disputes raised after them), when the window
//       ends and the time remaining. Soonest first. One entity read, then the
//       `tasks` KV store in batches of 100 keys, all pinned to that read's
//       state_version so the list is one consistent snapshot. Exit 2 if any
//       task could not be read: an incomplete list must not pass for a clean
//       one.
//
//   bun scripts/arbiter-harness.mjs resolve --task <onChainTaskId> \
//       --ruling pay-worker|refund-poster|split \
//       [--worker-pct 0.5 --poster-pct 0.5] [--live | --print-manifest]
//       Default: keyless PREVIEW only (Gateway /transaction/preview). Add
//       --live to actually sign and submit — see SAFETY below.
//       --print-manifest is the WALLET path, for an arbiter badge held in a
//       phone wallet (no private key on this machine): same chain-derived
//       holder, same Disputed gate, same builder, then the keyless preview of
//       the exact text to be pasted — and the manifest is printed ONLY if that
//       preview Succeeded, with its fee and events and the one line of what to
//       do with it (Radix Wallet → Send Raw Transaction, connect the holder,
//       paste). It REFUSES a manifest carrying `lock_fee` (Send Raw adds and
//       pays its own fee; a second lock double-pays or fails) or naming any
//       account other than the badge holder. Signs nothing; exclusive with
//       --live.
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
import { readEscrowTaskInfo, parseEscrowTaskInfo } from "../src/lib/gateway"
import { formatRemaining } from "../src/lib/countdown"
import { XRD_ADDRESS } from "../src/lib/radix"
import { readTxOutcome } from "./lib/tx-outcome.mjs"
import { summarizePreview, formatSummary, shortAddr } from "./lib/preview-summary.mjs"

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
// `preview` keeps the verdict-only shape the dry-run and --live paths have
// always reported; `previewWithResponse` also hands back the raw Gateway answer
// for the wallet path, which prints its fee and events.
async function preview(manifest) {
  return (await previewWithResponse(manifest)).result
}

async function previewWithResponse(manifest) {
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
    return {
      result: { verdict: "INCONCLUSIVE", reason: "Gateway returned no receipt status (transport-level, not a verdict)" },
      response: json,
    }
  }
  if (status === "Succeeded") return { result: { verdict: "PROVEN", status }, response: json }
  return { result: { verdict: "REVERTED", status, errorMessage: json?.receipt?.error_message ?? "" }, response: json }
}

// ── Wallet path: resolve --print-manifest ────────────────────────────────────
//
// The arbiter badge lives in the operator's PHONE wallet, so the signing leg is
// the Radix Wallet's Send Raw Transaction, not ARBITER_PRIVATE_KEY. These
// functions produce the text to paste and refuse to produce it when it would
// not work; they never sign.

/**
 * The checks a manifest must pass before it is handed to Send Raw. Throws —
 * never repairs — on any of:
 *  • a `lock_fee`: Send Raw adds and pays its own fee, so a manifest that also
 *    locks one double-pays or fails. resolveDisputeManifest never emits one
 *    (only signAndSubmit prepends it, for --live), so a hit means the builder
 *    changed, and the operator should see that, not have it cut out quietly.
 *  • a proof created from anything but the chain-derived badge holder: the
 *    connected wallet account must be the one whose badge the proof presents.
 *  • any other account at all: the only other account leg is the fee deposit
 *    back to that same holder (PULL — no party is routed by the caller).
 * Returns the manifest unchanged.
 */
export function assertWalletManifest(manifest, holderAccount) {
  if (/\block_fee\b/.test(manifest)) {
    throw new Error(
      "manifest contains lock_fee — refusing to print it for Send Raw Transaction, which adds and pays its own fee",
    )
  }
  const proofFrom = /CALL_METHOD\s+Address\("([^"]+)"\)\s+"create_proof_of_non_fungibles"/.exec(manifest)?.[1]
  if (proofFrom !== holderAccount) {
    throw new Error(
      `the badge proof is created from ${proofFrom ?? "(no create_proof_of_non_fungibles leg)"}, ` +
        `not the chain-derived holder ${holderAccount} — refusing to print it`,
    )
  }
  const foreign = [...new Set(manifest.match(/account_rdx1[a-z0-9]+/g) ?? [])].filter((a) => a !== holderAccount)
  if (foreign.length > 0) {
    throw new Error(`manifest names account(s) other than the badge holder (${foreign.join(", ")}) — refusing to print it`)
  }
  return manifest
}

/** What --print-manifest prints on success: preview readout, the manifest, the one instruction. */
export function walletHandoffText({ manifest, holderAccount, summary, previewedAt }) {
  return [
    `preview ${previewedAt} — keyless, against the ledger as of then:`,
    formatSummary(summary),
    "",
    "──── manifest (paste as-is) ────",
    manifest,
    "──── end manifest ────",
    "",
    `Radix Wallet → Send Raw Transaction, connect ${holderAccount}, paste the manifest above. ` +
      "The wallet adds and pays the fee. Re-run this first if the preview is more than a few minutes old.",
  ].join("\n")
}

/**
 * --print-manifest, minus the CLI: every decision it makes, RETURNED rather
 * than exited, so a mocked-Gateway test drives the whole path. Same
 * chain-derived holder and the same live Disputed gate as `resolve`; the
 * manifest previewed is byte-for-byte the one returned for pasting, and a
 * manifest comes back only when that preview PROVED it.
 */
export async function prepareWalletResolve({ taskId, ruling, component = ESCROW_COMPONENT, now = () => new Date() }) {
  const arbiterBadgeResource = await readArbiterBadgeResource(component)
  const { localId, holderAccount } = await findLiveArbiterBadge(arbiterBadgeResource)
  const base = { taskId, holderAccount, arbiterBadgeLocalId: localId }

  const info = await readEscrowTaskInfo(taskId, component)
  if (!info) {
    return { ...base, ok: false, verdict: "REFUSED", reason: `could not read task ${taskId} on ${component} — not building a ruling blind` }
  }
  if (info.state !== "Disputed") {
    return { ...base, ok: false, verdict: "REFUSED", reason: `task ${taskId} is ${info.state} on-chain, not Disputed — resolve_dispute would revert` }
  }

  const manifest = assertWalletManifest(
    buildResolveManifest(
      { arbiterBadgeResource, arbiterBadgeLocalId: localId, arbiterAccount: holderAccount },
      { component, taskId, ruling },
    ),
    holderAccount,
  )

  const previewedAt = now().toISOString()
  const { result, response } = await previewWithResponse(manifest)
  if (result.verdict !== "PROVEN") {
    const why = result.verdict === "REVERTED" ? `${result.status}: ${result.errorMessage}` : result.reason
    return { ...base, ok: false, verdict: result.verdict, reason: `preview ${result.verdict} (${why}) — no manifest printed`, preview: result }
  }
  const summary = summarizePreview(response)
  return {
    ...base,
    ok: true,
    verdict: "PROVEN",
    manifest,
    summary,
    text: walletHandoffText({ manifest, holderAccount, summary, previewedAt }),
  }
}

// ── disputes: every live dispute on the component (read-only) ────────────────

/** Keys per /state/key-value-store/data call (the Gateway's cap, measured in src/lib/nft-swap-gateway.ts). */
const KV_KEYS_PER_CALL = 100

const isPositiveU64String = (v) => typeof v === "string" && /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) && Number(v) > 0

/**
 * What the dispute list needs from the component, in ONE entity read: the
 * `tasks` KV store, the id range (next_task_id), the LIVE window and default
 * (what a dispute raised now would pin, and what auto_resolve_dispute falls
 * back to for a task carrying no pin), and the state_version every later read
 * is pinned to. Throws rather than guess on the two fields the scan cannot run
 * without.
 */
export async function readDisputeScanConfig(component = ESCROW_COMPONENT) {
  const details = await gatewayPost("/state/entity/details", { addresses: [component] })
  const fields = details?.items?.[0]?.details?.state?.fields ?? []
  const f = (name) => fields.find((x) => x?.field_name === name)
  const tasksKvStore = f("tasks")?.value
  if (typeof tasksKvStore !== "string" || !tasksKvStore.startsWith("internal_keyvaluestore_")) {
    throw new Error(`could not read the tasks KV store of ${component}`)
  }
  const nextRaw = f("next_task_id")?.value
  if (!isPositiveU64String(nextRaw)) throw new Error(`could not read next_task_id of ${component} (got ${JSON.stringify(nextRaw)})`)
  const secsRaw = f("dispute_auto_resolve_secs")?.value
  const liveDefault = f("dispute_auto_resolve_default")?.variant_name
  const stateVersion = details?.ledger_state?.state_version
  return {
    component,
    tasksKvStore,
    nextTaskId: Number(nextRaw),
    liveWindowSecs: isPositiveU64String(secsRaw) ? Number(secsRaw) : null,
    liveDefault: typeof liveDefault === "string" ? liveDefault : null,
    stateVersion: Number.isSafeInteger(stateVersion) ? stateVersion : null,
  }
}

/**
 * One Disputed task as a row. Pure. The window is the task's PINNED one; only a
 * task carrying no pin field at all falls back to the live value, which is
 * exactly what auto_resolve_dispute does (`unwrap_or(self.…)`). A pin that is
 * present but unreadable is UNKNOWN, never replaced — the live value would be
 * wrong for exactly the disputes an owner change did not move.
 */
export function disputeRow(taskId, info, cfg, { pinFieldPresent }, nowMs) {
  const windowSecs =
    info.disputeAutoResolveSecs ?? (pinFieldPresent ? null : cfg.liveWindowSecs)
  const windowSource =
    info.disputeAutoResolveSecs != null ? "pinned" : windowSecs != null ? "live (task has no pin)" : "UNKNOWN"
  const defaultRuling = info.disputeAutoResolveDefault ?? (pinFieldPresent ? null : cfg.liveDefault)
  const defaultSource =
    info.disputeAutoResolveDefault != null ? "pinned" : defaultRuling != null ? "live (task has no pin)" : "UNKNOWN"
  const raiserAccount =
    info.disputeRaisedBy === "worker" ? info.workerAccount : info.disputeRaisedBy === "poster" ? info.posterAccount : null
  const endsAtMs = info.disputedAt && windowSecs != null ? info.disputedAt.getTime() + windowSecs * 1000 : null
  const remainingMs = endsAtMs == null ? null : endsAtMs - nowMs
  return {
    taskId,
    reward: info.rewardAmount,
    rewardToken: info.rewardToken,
    raisedBy: info.disputeRaisedBy,
    raiserAccount,
    disputedAt: info.disputedAt ? info.disputedAt.toISOString() : null,
    windowSecs,
    windowSource,
    defaultRuling,
    defaultSource,
    endsAt: endsAtMs == null ? null : new Date(endsAtMs).toISOString(),
    remainingMs,
    remaining:
      remainingMs == null
        ? "UNKNOWN — treat as urgent"
        : remainingMs > 0
          ? `${formatRemaining(remainingMs)} left`
          : `LAPSED ${formatRemaining(-remainingMs)} ago — auto_resolve_dispute is callable by anyone`,
  }
}

/**
 * Every Disputed task on `component`, soonest window end first (unknown ends
 * first of all). Gateway reads only. `unreadable` and `missing` list task ids
 * the scan could not see; the CLI treats either as an incomplete answer.
 */
export async function listDisputes({ component = ESCROW_COMPONENT, nowMs = Date.now() } = {}) {
  const cfg = await readDisputeScanConfig(component)
  const ids = Array.from({ length: cfg.nextTaskId - 1 }, (_, i) => i + 1)
  const rows = []
  const unreadable = []
  const seen = new Set()
  for (let i = 0; i < ids.length; i += KV_KEYS_PER_CALL) {
    const chunk = ids.slice(i, i + KV_KEYS_PER_CALL)
    const body = {
      key_value_store_address: cfg.tasksKvStore,
      keys: chunk.map((id) => ({ key_json: { kind: "U64", value: String(id) } })),
    }
    if (cfg.stateVersion != null) body.at_ledger_state = { state_version: cfg.stateVersion }
    const resp = await gatewayPost("/state/key-value-store/data", body)
    for (const entry of resp?.entries ?? []) {
      const keyRaw = entry?.key?.programmatic_json?.value
      if (!isPositiveU64String(keyRaw)) continue
      const id = Number(keyRaw)
      seen.add(id)
      const fields = entry?.value?.programmatic_json?.fields
      const info = parseEscrowTaskInfo(fields)
      if (!info) {
        unreadable.push(id)
        continue
      }
      if (info.state !== "Disputed") continue
      const pinFieldPresent = fields.some(
        (x) => x?.field_name === "dispute_auto_resolve_secs" && x?.variant_name === "Some",
      )
      rows.push(disputeRow(id, info, cfg, { pinFieldPresent }, nowMs))
    }
  }
  // Unknown ends sort first (treat as most urgent), then soonest end.
  rows.sort((a, b) =>
    a.remainingMs == null ? (b.remainingMs == null ? a.taskId - b.taskId : -1)
    : b.remainingMs == null ? 1
    : a.remainingMs - b.remainingMs,
  )
  return {
    component,
    stateVersion: cfg.stateVersion,
    scanned: ids.length,
    liveWindowSecs: cfg.liveWindowSecs,
    liveDefault: cfg.liveDefault,
    rows,
    unreadable,
    missing: ids.filter((id) => !seen.has(id)),
  }
}

const secsLabel = (s) => (s == null ? "?" : s % 86400 === 0 ? `${s}s = ${s / 86400}d` : `${s}s = ${s / 3600}h`)

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

async function resolveForWallet({ taskId, rulingArg, workerPct, posterPct }) {
  const ruling = parseRuling(rulingArg, workerPct, posterPct)
  const r = await prepareWalletResolve({ taskId, ruling })
  log(`arbiter badge ${r.arbiterBadgeLocalId} is held by ${r.holderAccount} (chain-derived, not hardcoded)`)
  if (!r.ok) {
    log(`REFUSED — ${r.reason}`)
    emit({ printManifest: true, printed: false, taskId, ruling, verdict: r.verdict, reason: r.reason })
    process.exit(r.verdict === "INCONCLUSIVE" ? 2 : 1)
  }
  // stdout, so `> file` captures exactly the readout and the paste.
  console.log(r.text)
  emit({
    printManifest: true,
    printed: true,
    taskId,
    ruling,
    arbiterAccount: r.holderAccount,
    arbiterBadgeLocalId: r.arbiterBadgeLocalId,
    feeXrd: r.summary.feeXrd,
    events: r.summary.events,
  })
}

async function disputes() {
  const out = await listDisputes()
  const label = (resource) => (resource === XRD_ADDRESS ? "XRD" : shortAddr(resource ?? "?"))
  log(`component ${out.component} @ state_version ${out.stateVersion ?? "(unpinned)"} — scanned tasks 1..${out.scanned}`)
  log(
    `live config (what a dispute raised NOW pins): window ${secsLabel(out.liveWindowSecs)}, default ${out.liveDefault ?? "?"}`,
  )
  log(`${out.rows.length} task(s) in Disputed:`)
  for (const r of out.rows) {
    log(
      `  task ${r.taskId}: reward ${r.reward ?? "?"} ${label(r.rewardToken)} · raised by ${r.raisedBy ?? "?"} ` +
        `(${r.raiserAccount ?? "account ?"}) · disputed_at ${r.disputedAt ?? "?"}`,
    )
    log(
      `           window ${secsLabel(r.windowSecs)} (${r.windowSource}) · default ${r.defaultRuling ?? "?"} (${r.defaultSource}) · ` +
        `ends ${r.endsAt ?? "?"} → ${r.remaining}`,
    )
  }
  const incomplete = out.unreadable.length > 0 || out.missing.length > 0
  if (incomplete) {
    log(
      `INCOMPLETE — unreadable task(s): ${out.unreadable.join(", ") || "none"}; no entry for: ${out.missing.join(", ") || "none"}. ` +
        "A dispute among them would not be listed above.",
    )
  }
  emit(out)
  process.exit(incomplete ? 2 : 0)
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
    case "disputes":
      await disputes()
      break
    case "resolve": {
      const taskId = Number(arg("task"))
      if (!Number.isInteger(taskId) || taskId <= 0) throw new Error("resolve needs --task <onChainTaskId>")
      const rulingArg = arg("ruling")
      if (!rulingArg) throw new Error("resolve needs --ruling pay-worker|refund-poster|split")
      if (hasFlag("print-manifest")) {
        if (hasFlag("live")) {
          throw new Error("--print-manifest and --live are exclusive: one prints for the phone wallet, the other signs here")
        }
        await resolveForWallet({ taskId, rulingArg, workerPct: arg("worker-pct"), posterPct: arg("poster-pct") })
        break
      }
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
      log("usage: arbiter-harness.mjs <badge|disputes|resolve> [...]")
      log("  badge                                                     read-only: who holds the live arbiter badge")
      log("  disputes                                                  read-only: every Disputed task, its pinned window and time left")
      log("  resolve --task <id> --ruling pay-worker|refund-poster|split [--worker-pct X --poster-pct Y] [--live | --print-manifest]")
      process.exit(2)
  }
}

if (import.meta.main) {
  main().catch((e) => {
    log("fatal: " + String(e))
    process.exit(1)
  })
}
