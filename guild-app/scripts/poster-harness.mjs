#!/usr/bin/env bun
// poster-harness.mjs — Gate-1 agent-lane: the programmatic POSTER's ON-CHAIN legs.
//
// Workstream D of docs/design/agent-lane-pilot-execution-plan.md. This file ONLY
// signs the poster's escrow transactions (create_task+fund, approve_and_release,
// cancel_task, cancel_task_by_poster_after_claim) and reads the live escrow
// get_config gate. It NEVER touches /api/v1 — the DB confirms (confirmEscrow
// kind=create|approve|cancel) are done by gate1-e2e.mjs / approve-task.mjs /
// cancel-task.mjs through the guild-client GuildApiClient. Bun runtime so it can
// import the TS manifest builders directly and keep their assertCanonicalXrd /
// validate* guards in force.
//
//   bun scripts/poster-harness.mjs get-config                     # read-only gate (no key needed)
//   bun scripts/poster-harness.mjs create-fund --reward 5 --title "..." --desc "..." [--dry-run]
//   bun scripts/poster-harness.mjs approve --task <onChainTaskId> --worker account_rdx1... --reward 5 [--dry-run]
//   bun scripts/poster-harness.mjs cancel  --task <onChainTaskId> [--dry-run]
//   bun scripts/poster-harness.mjs cancel-after-claim --task <onChainTaskId> --worker account_rdx1... [--dry-run]
//   bun scripts/poster-harness.mjs dispute --task <onChainTaskId> --as <poster|worker> [--evidence <hex>] [--dry-run]
//   bun scripts/poster-harness.mjs auto-resolve --task <onChainTaskId> [--raised-by <worker|poster>] [--dry-run]
//   bun scripts/poster-harness.mjs withdraw --task <onChainTaskId> --as <poster|worker> [--dry-run]
//
// SAFETY (critique fixes baked in):
//  * Reads POSTER_PRIVATE_KEY / POSTER_ACCOUNT_ADDRESS EXPLICITLY — never falls
//    through to signer.js's BOT_PRIVATE_KEY / ~/.secrets/.env autoload.
//  * Asserts the key's DERIVED account == POSTER_ACCOUNT_ADDRESS (a set-but-wrong
//    key fails, not just an unset one).
//  * Fail-closed live-rails guard (assertPull): refuses to sign unless the
//    resolved escrow component AND task receipt are the pinned LIVE ones below
//    — an env or a config.ts default pointing at a retired component exits 1
//    instead of signing.

import {
  TransactionBuilder,
  PrivateKey,
  NetworkId,
  RadixEngineToolkit,
} from "@radixdlt/radix-engine-toolkit"
// The CANONICAL (PULL) poster builders. Flipped 2026-08-17 when the P2 cutover
// moved the pin — see assertPull() below. Wave B (2026-09-13) kept the pull
// settlement shape and left the poster-side method signatures unchanged, so
// these imports did not move again; what Wave B DID change for this harness is
// the claim bond (flat `claim_bond_xrd` → per-task clamp(reward × pct, floor,
// cap), pinned on the task at claim) — see readEscrowConfig / readTaskClaimBond.
//
// ⚠️ Two claims that stood here until 2026-08-22 were both false. It said the
// LegacyPush builders "are still exported from manifests.ts" — S3 (PR #419)
// DELETED them, so there is no push builder anywhere in shipped code — and that
// they "keep rollback a one-step env revert", which was never true: launch-check
// CHECK 7 compares the compiled shape against the on-chain shape of the baked
// component and hard-fails on mismatch, so flipping the flag alone always failed
// the gate. Rollback was, and is, a code change. Note the PULL signatures are SHORTER,
// not merely renamed: approve drops `workerAccount`, cancel-after-claim drops
// `workerAccount` + `claimBondXrd` — under pull, settlement credits an
// entitlement instead of pushing a bucket at a named account.
import {
  createTaskManifest,
  approveAndReleaseManifest,
  cancelTaskManifest,
  cancelTaskAfterClaimManifest,
  publicMintManifest,
  raiseDisputeManifest,
  autoResolveDisputeManifest,
  autoResolveRuling,
  withdrawWorkerManifest,
  withdrawPosterManifest,
} from "../src/lib/manifests"
import {
  GATEWAY,
  ESCROW_COMPONENT,
  ESCROW_RECEIPT_RESOURCE,
  BADGE_NFT,
  AGENT_BADGE_NFT,
} from "../src/lib/config"
import { canonicalWorkBrief, sha256Hex } from "../src/lib/escrow-utils"
import { XRD_ADDRESS } from "../src/lib/radix"
import {
  readEscrowTaskCreated,
  readOnChainClaimInfo,
  readEscrowTaskInfo,
  outstandingForParty,
} from "../src/lib/gateway"
import { isPositiveDecimal } from "../src/lib/escrow-drift"
// REUSED, not reimplemented. guild-app already decides "who is owed what and can
// they prove it" in one place, covered by tests/unit/escrow-withdraw.test.ts, and
// its return type is a discriminated union that makes the poster/worker split
// unrepresentable-wrong. A third copy here (after the UI and the agent-client
// CLI) is exactly the drift isPositiveDecimal's own comment warns about.
import { resolveWithdrawAffordance, explainWithdrawBlocker, outstandingLanes } from "../src/lib/escrow-withdraw"
import { INSURANCE_RATE } from "../src/lib/marketplace"
import { readTxOutcome, commitOrThrow } from "./lib/tx-outcome.mjs"
import { posterEnvFatalLines } from "./lib/poster-env.mjs"

// ── Pinned ground truth (the live WAVE B rails — docs/ESCROW-ADDRESSES.md) ───
// Wave B cutover 2026-09-13; repointed here 2026-09-14. This pin has now lagged
// a cutover TWICE (push → PULL until 2026-08-17, PULL → Wave B until 2026-09-14).
// Because assertPull() is fail-closed, a stale pin never risked a
// wrong-component signature — it made every signing path `process.exit(1)`
// against the CORRECT component instead, which is safe but leaves the harness
// unusable until someone notices. Repoint these (and the builder imports, if a
// cutover changes a poster-side method) in the same commit as the cutover.
export const LIVE_COMPONENT =
  "component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly"
export const LIVE_TASK_RECEIPT =
  "resource_rdx1n2gxh84q62taekne4d5mys5yk23du7yyvma6zjuh0vvhn4w2vrtkju"
export const MEMBER_BADGE =
  "resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl"
// BadgeManager (public_mint) — the guild Member badge component (global CLAUDE.md).
export const MANAGER =
  "component_rdx1czexylvvm0q4uhwpjaqmlznj9sd3y2jnmmah6qug9lm9sfm3tyrtva"
// Sourced from the one canonical definition (src/lib/radix.ts), not a local
// literal — consolidated so a future reward-resource flip (XRD → USD
// stablecoin) only ever needs to change one file's value. This harness itself
// stays XRD-only until that flip lands on-chain (get_config's accepted-token
// whitelist below is checked against this constant on purpose).
const XRD = XRD_ADDRESS
// Valid-format placeholder account for --dry-run manifest previews when
// POSTER_ACCOUNT_ADDRESS is unset (validateAddress requires a real bech32m form).
// Derived from a fixed dummy Ed25519 public key (32 bytes of 0x01): no private key
// exists. Replaced RX-10 (the old dApp definition on the compromised seed) 2026-09-29.
const DRYRUN_ACCOUNT = "account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw"
const FEE_HEADROOM = 2 // XRD left behind for the lock_fee on a sweep (unused part refunds)

const log = (...a) => console.error("[poster-harness]", ...a)
/** Print one machine-readable result line for gate1-e2e.mjs to parse. */
const emit = (obj) => console.log("RESULT " + JSON.stringify(obj))

// ── Gateway plumbing ─────────────────────────────────────────────────────────
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
  return data.ledger_state?.epoch ?? 1
}

export async function currentStateVersion() {
  const data = await gatewayPost("/status/gateway-status", {})
  return data.ledger_state?.state_version ?? null
}

// ── Fail-closed guards (run only on a real signing path) ─────────────────────
// Named for the settlement shape it guards (pull), which Wave B kept — the
// pinned addresses are what moved. Every signing leg calls this first.
export function assertPull() {
  if (ESCROW_COMPONENT !== LIVE_COMPONENT || ESCROW_RECEIPT_RESOURCE !== LIVE_TASK_RECEIPT) {
    log("FATAL: escrow addresses are not the live Wave B rails — refusing to sign.")
    log(`  ESCROW_COMPONENT        = ${ESCROW_COMPONENT}`)
    log(`  expected                = ${LIVE_COMPONENT}`)
    log(`  ESCROW_RECEIPT_RESOURCE = ${ESCROW_RECEIPT_RESOURCE}`)
    log(`  expected                = ${LIVE_TASK_RECEIPT}`)
    log("  Set NEXT_PUBLIC_ESCROW_COMPONENT / NEXT_PUBLIC_ESCROW_RECEIPT_RESOURCE to the Wave B")
    log("  addresses in docs/ESCROW-ADDRESSES.md (ops/agent-env/gate1-env.sh exports them).")
    process.exit(1)
  }
}
// Kept as an alias so any out-of-tree caller fails loudly at the guard rather
// than silently skipping it via an undefined import.
export const assertVNext = assertPull

// Reaching the Disputed state on the LIVE (push) component arms BUG-7 on real
// XRD, so the dispute legs refuse to sign there unless explicitly unfused:
//   • BUG-7 — the push component's auto_resolve_dispute is PUBLIC with
//     caller-routed settlement, so any third party can drain a Disputed pot.
//     The PULL blueprint fixes the root cause (settlement is credited
//     internally; the caller receives nothing) — but the fix lives in the NEW
//     component, and this fuse guards the OLD one until the P2 cutover
//     retires it.
//   • The dispute builders are now PULL-form only (bare trigger, no routing
//     legs), so they cannot serve the push component even unfused: against it
//     the returned buckets would strand on the worktop and the tx reverts —
//     fail-closed, funds stay vaulted.
// Until the cutover, disputes are exercised on the mock VM only (escrow-dispute
// e2e + battle-test --mock). This replaces "don't run it" with a real interlock.
export function assertLiveDisputeAllowed(verb) {
  if (process.env.GUILD_ALLOW_LIVE_DISPUTE === "1") {
    log(`WARNING: GUILD_ALLOW_LIVE_DISPUTE=1 — signing ${verb} against ${ESCROW_COMPONENT}.`)
    return
  }
  // ⚠️ This read `ESCROW_COMPONENT === VNEXT_COMPONENT` until 2026-08-17. The P2
  // cutover renamed that constant, leaving a DANGLING REFERENCE on a signing
  // path — it would have thrown ReferenceError instead of refusing, i.e. the
  // fuse would have failed OPEN under the one condition it exists for. Caught by
  // grep, not by a test, because nothing exercises the dispute legs.
  //
  // The fuse is now component-INDEPENDENT, and deliberately so. Its old form
  // guarded only the push component because BUG-7 (public auto_resolve with
  // caller-routed settlement) lived there; the PULL blueprint fixes that root
  // cause. The two reasons this comment used to add have since gone — H1 is
  // closed and the dispute UI has been compiled ON since 2026-08-29 (launch-check
  // now fails an OFF build) — but the campaign ruling for THIS harness is still
  // MOCK-ONLY, and the fuse enforces that ruling, not the UI flag. Narrow it only
  // when a live harness dispute is a decision someone has actually taken.
  if (ESCROW_COMPONENT?.startsWith("component_rdx1")) {
    log(`FATAL: refusing to sign ${verb} against a LIVE escrow component (${ESCROW_COMPONENT}).`)
    log("  BUG-7's root cause is fixed in the PULL blueprint (settlement is credited")
    log("  internally; the caller receives nothing), but live dispute legs from this")
    log("  harness remain MOCK-ONLY by campaign ruling.")
    log("  Exercise disputes on the mock VM instead:")
    log("    bun scripts/battle-test-campaign.mjs --mock --matrix")
    log("    npx vitest run tests/integration/escrow-dispute.e2e.test.ts")
    log("  Override only with a deliberate GUILD_ALLOW_LIVE_DISPUTE=1 (throwaway funds).")
    process.exit(1)
  }
}

/** Returns {privateKeyHex, account, pk}. Asserts the key derives POSTER_ACCOUNT_ADDRESS. */
export async function loadPosterKey() {
  const privateKeyHex = process.env.POSTER_PRIVATE_KEY
  const account = process.env.POSTER_ACCOUNT_ADDRESS
  // Shape first (lib/poster-env.mjs, the message every poster script shares): a
  // malformed key would otherwise throw raw out of PrivateKey.Ed25519 below.
  const envFatal = posterEnvFatalLines(process.env)
  if (envFatal.length) { for (const l of envFatal) log(l); process.exit(1) }
  const pk = new PrivateKey.Ed25519(privateKeyHex)
  const derived = await RadixEngineToolkit.Derive.virtualAccountAddressFromPublicKey(
    pk.publicKey(),
    NetworkId.Mainnet,
  )
  const derivedStr = typeof derived === "string" ? derived : String(derived)
  if (derivedStr !== account) {
    log("FATAL: POSTER_PRIVATE_KEY does not derive POSTER_ACCOUNT_ADDRESS — wrong key (treasury/bot key leak?).")
    log(`  derived = ${derivedStr}`)
    log(`  POSTER_ACCOUNT_ADDRESS = ${account}`)
    process.exit(1)
  }
  return { privateKeyHex, account, pk }
}

// ── Inline signer (ported from scripts/signer.js, POSTER key, lock_fee prepend) ─
async function signAndSubmit(manifest, pk, account) {
  const epoch = await getCurrentEpoch()
  if (account && !manifest.includes("lock_fee")) {
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
  const data = await gatewayPost("/transaction/submit", { notarized_transaction_hex: hex })
  return { intentHash, duplicate: data.duplicate }
}

// Wait for a tx and throw unless it committed — WITH the Gateway's reason.
// This replaced nine copies of `if (status !== "CommittedSuccess") throw new
// Error(\`X not committed: ${status}\`)`, every one of which discarded
// error_message and left an operator with the one string that cannot say which
// assert fired. See scripts/lib/tx-outcome.mjs for why that matters more than it
// looks. Callers that need the reason WITHOUT throwing (the settlement probes,
// which assert a specific revert) use readTxOutcome/assertRevertedWith directly.
async function commitOrThrowHere(intentHash, what) {
  return commitOrThrow(gatewayPost, intentHash, what)
}

export async function txOutcome(intentHash, opts = {}) {
  return readTxOutcome(gatewayPost, intentHash, opts)
}

// ── get_config gate (read-only) ──────────────────────────────────────────────
// Walks the escrow component's on-chain state. The authoritative XRD whitelist is
// the accepted_tokens KeyValueStore; component state also mirrors it as
// accepted_token_addresses. We check the mirror first, fall back to the KVS.
function stateFields(details) {
  const s = details?.items?.[0]?.details?.state
  return s?.fields ?? s?.programmatic_json?.fields ?? []
}
function field(fields, name) {
  return fields.find((f) => f?.field_name === name)
}
function scalar(f) {
  return f?.value ?? null
}
function arrayValues(f) {
  const els = f?.elements ?? f?.entries ?? []
  return els.map((e) => e?.value ?? e).filter(Boolean)
}

/**
 * The claim bond as the component's STATE describes it — one of two shapes.
 *
 *   flat          retired components (v1 / push / PULL): a single `claim_bond_xrd`.
 *   proportional  Wave B onward: `claim_bond_pct` / `claim_bond_floor` /
 *                 `claim_bond_cap`; the bond a claim posts is
 *                 clamp(reward × pct, floor, cap) in the task's reward token,
 *                 and the amount actually posted is PINNED on the task
 *                 (`claim_bond_amount`, see readTaskClaimBond) — so a later
 *                 set_claim_bond_params never changes an open claim's bond.
 *
 * Null when neither shape is readable, and callers refuse on null rather than
 * assume. Decimals stay STRINGS (the chain's own text) — the bond is money,
 * and `Number` residue is how a preview reports one figure while the ledger
 * moves another. Pure: exported for the unit test that pins both shapes.
 */
export function parseClaimBond(fields) {
  const dec = (name) => {
    const v = scalar(field(fields, name))
    return typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? v : null
  }
  const flat = dec("claim_bond_xrd")
  if (flat !== null) return { mode: "flat", amountXrd: flat }
  const pct = dec("claim_bond_pct")
  const floor = dec("claim_bond_floor")
  const cap = dec("claim_bond_cap")
  if (pct !== null && floor !== null && cap !== null) return { mode: "proportional", pct, floor, cap }
  return null
}

export async function readEscrowConfig(component = ESCROW_COMPONENT) {
  const details = await gatewayPost("/state/entity/details", {
    addresses: [component],
    aggregation_level: "Vault",
  })
  const fields = stateFields(details)
  const fieldNames = fields.map((f) => f?.field_name).filter(Boolean)

  const claimBond = parseClaimBond(fields)
  const minInsurance = scalar(field(fields, "min_insurance_fraction"))
  const workerBadge = scalar(field(fields, "worker_badge_resource"))
  const nextTaskId = scalar(field(fields, "next_task_id"))
  // The ruling auto_resolve_dispute applies. An Enum field, so the variant NAME is
  // the value — the finalize routing must match it exactly or it pays the wrong
  // party (H1). Null when unreadable; callers refuse rather than assume.
  const autoResolveField = field(fields, "dispute_auto_resolve_default")
  const disputeAutoResolveDefault =
    autoResolveField?.variant_name === "FavorDisputeRaiser" ||
    autoResolveField?.variant_name === "SplitEvenly" ||
    autoResolveField?.variant_name === "ReturnToPoster"
      ? autoResolveField.variant_name
      : null

  // XRD whitelist: try the mirror array, then the KVS.
  let xrdWhitelisted = false
  const acceptedArr = field(fields, "accepted_token_addresses")
  if (acceptedArr) {
    xrdWhitelisted = arrayValues(acceptedArr).includes(XRD)
  }
  let kvsAddress = null
  if (!xrdWhitelisted) {
    const acceptedKvs = field(fields, "accepted_tokens")
    kvsAddress = scalar(acceptedKvs) || acceptedKvs?.value
    if (kvsAddress && String(kvsAddress).startsWith("internal_keyvaluestore")) {
      try {
        const keys = await gatewayPost("/state/key-value-store/keys", {
          key_value_store_address: kvsAddress,
        })
        const found = (keys.items ?? []).some((k) => {
          const v = k?.key?.programmatic_json?.value ?? k?.key?.raw_hex ?? ""
          return String(v).includes("radxrd")
        })
        if (found) xrdWhitelisted = true
      } catch (e) {
        log(`get-config: KVS read failed (${String(e)}) — could not confirm XRD via KVS`)
      }
    }
  }

  return {
    component,
    claimBond,
    // Flat-bond figure for callers written against retired components; null
    // under Wave B (there is no single bond). claimBondMinXrd is the least any
    // claim can cost under either shape — the right figure for a funding
    // reserve, never for a manifest.
    claimBondXrd: claimBond?.mode === "flat" ? Number(claimBond.amountXrd) : null,
    claimBondMinXrd:
      claimBond?.mode === "flat" ? Number(claimBond.amountXrd)
      : claimBond?.mode === "proportional" ? Number(claimBond.floor)
      : null,
    minInsuranceFraction: minInsurance === null ? null : Number(minInsurance),
    workerBadgeResource: workerBadge,
    nextTaskId: nextTaskId === null ? null : Number(nextTaskId),
    disputeAutoResolveDefault,
    xrdWhitelisted,
    _fieldNames: fieldNames,
    _kvsAddress: kvsAddress,
  }
}

/**
 * `claim_bond_amount` from ONE task's on-chain struct — `Option<Decimal>`, Some
 * from claim_task onward (pinned; survives settlement, so a Released/Refunded
 * task still reports what its claim posted). Null for an unclaimed task or an
 * unreadable entry. Pure; exported for the unit test.
 */
export function parseTaskClaimBond(taskFields) {
  const f = field(taskFields ?? [], "claim_bond_amount")
  if (f?.variant_name !== "Some") return null
  const v = f?.fields?.[0]?.value
  return typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? v : null
}

/** Resolve the component's `tasks` KVS and read one task's pinned claim bond (string XRD or null). */
export async function readTaskClaimBond(onChainTaskId, component = ESCROW_COMPONENT) {
  const details = await gatewayPost("/state/entity/details", { addresses: [component] })
  const kvs = scalar(field(stateFields(details), "tasks"))
  if (typeof kvs !== "string" || !kvs.startsWith("internal_keyvaluestore_")) return null
  const data = await gatewayPost("/state/key-value-store/data", {
    key_value_store_address: kvs,
    keys: [{ key_json: { kind: "U64", value: String(onChainTaskId) } }],
  })
  return parseTaskClaimBond(data?.entries?.[0]?.value?.programmatic_json?.fields)
}

/**
 * Hard gate: false (after logging why) if the config can't support a safe
 * create_task with XRD. `expectBond` applies to the FLAT shape only (retired
 * components); under Wave B's proportional bond there is no single figure to
 * expect, so the gate requires the three params to be present and sane
 * (0 < pct ≤ 1, 0 < floor ≤ cap) and says so. No in-tree caller passes
 * `expectBond` any more (the five PULL-era `{ expectBond: 10 }` sites were
 * dropped 2026-09-14); an out-of-tree one still works — the argument is simply
 * not applicable, and the log line says that rather than staying quiet.
 */
export function assertConfigOk(cfg, { expectBond = null } = {}) {
  const problems = []
  if (!cfg.xrdWhitelisted) problems.push("XRD is NOT whitelisted on the escrow (create_task would CommittedFailure)")
  const bond = cfg.claimBond ?? null
  if (bond === null) {
    problems.push("could not read the claim bond (neither claim_bond_xrd nor claim_bond_pct/floor/cap in state)")
  } else if (bond.mode === "flat") {
    if (expectBond !== null && Number(bond.amountXrd) !== expectBond)
      problems.push(`claim_bond_xrd=${bond.amountXrd} (expected ${expectBond})`)
  } else {
    const pct = Number(bond.pct), floor = Number(bond.floor), cap = Number(bond.cap)
    if (!(pct > 0 && pct <= 1)) problems.push(`claim_bond_pct=${bond.pct} (expected 0 < pct ≤ 1)`)
    if (!(floor > 0)) problems.push(`claim_bond_floor=${bond.floor} (expected > 0)`)
    if (!(cap >= floor)) problems.push(`claim_bond_cap=${bond.cap} < floor ${bond.floor}`)
    if (expectBond !== null)
      log(`NOTE get-config: bond is proportional (pct=${bond.pct} floor=${bond.floor} cap=${bond.cap}); expectBond=${expectBond} is a flat-bond check and does not apply`)
  }
  // soft checks — warn, don't fail (state-shape parsing can drift)
  if (cfg.workerBadgeResource && cfg.workerBadgeResource !== MEMBER_BADGE)
    log(`WARN get-config: worker_badge_resource=${cfg.workerBadgeResource} (expected Member ${MEMBER_BADGE})`)
  // The harness funds insurance at INSURANCE_RATE; a component floor ABOVE that
  // would make every create_task revert. (Wave B instantiated at 0 — the old
  // "expected 0.05" warn would have fired on every run against the live escrow.)
  if (cfg.minInsuranceFraction !== null && cfg.minInsuranceFraction > INSURANCE_RATE)
    log(`WARN get-config: min_insurance_fraction=${cfg.minInsuranceFraction} exceeds this harness's INSURANCE_RATE ${INSURANCE_RATE} — create_task would revert`)
  if (problems.length) {
    log("FATAL get-config gate failed:")
    for (const p of problems) log("  • " + p)
    log(`  (state fields seen: ${cfg._fieldNames?.join(", ") || "none"})`)
    return false
  }
  return true
}

// ── Poster on-chain legs ─────────────────────────────────────────────────────
export async function createAndFundTask({ reward, title, description, workBriefHashHex, dryRun }) {
  assertPull()
  const insurance = Math.max(Math.ceil(reward * INSURANCE_RATE), Math.ceil(reward * INSURANCE_RATE))
  const wbh = workBriefHashHex ?? (await sha256Hex(canonicalWorkBrief(title ?? "", description ?? "")))
  const { account, pk } = dryRun
    ? { account: process.env.POSTER_ACCOUNT_ADDRESS ?? DRYRUN_ACCOUNT, pk: null }
    : await loadPosterKey()
  const manifest = createTaskManifest(ESCROW_COMPONENT, account, reward, insurance, "0", wbh)
  if (dryRun) {
    log(`DRY-RUN create_task reward=${reward} insurance=${insurance} workBriefHash=${wbh}`)
    log("\n" + manifest)
    return { dryRun: true, reward, insurance, workBriefHashHex: wbh }
  }
  const { intentHash } = await signAndSubmit(manifest, pk, account)
  await commitOrThrowHere(intentHash, "create_task")
  // Gateway lags commit ~5–10 s; retry the event read.
  let created = null
  for (let i = 0; i < 6 && created === null; i++) {
    created = await readEscrowTaskCreated(intentHash, ESCROW_COMPONENT)
    if (created === null) await new Promise((r) => setTimeout(r, 4000))
  }
  if (created === null) throw new Error(`readEscrowTaskCreated null after retries for ${intentHash}`)
  return {
    intentHash,
    onChainTaskId: created.taskId,
    rewardAmount: created.rewardAmount,
    insuranceAmount: created.insuranceAmount,
    workBriefHashHex: wbh,
  }
}

export async function approveAndRelease({ onChainTaskId, workerAccount, rewardXrd, dryRun }) {
  assertPull()
  const { account, pk } = dryRun
    ? { account: process.env.POSTER_ACCOUNT_ADDRESS ?? DRYRUN_ACCOUNT, pk: null }
    : await loadPosterKey()
  // PULL: no workerAccount / rewardXrd here. approve_and_release CREDITS the
  // worker's entitlement inside the component; the money moves only when the
  // worker calls withdraw_worker. Passing a routing account was the push form.
  const manifest = approveAndReleaseManifest(
    ESCROW_COMPONENT,
    account,
    ESCROW_RECEIPT_RESOURCE,
    onChainTaskId,
  )
  if (dryRun) {
    log(`DRY-RUN approve_and_release task=${onChainTaskId} → ${workerAccount} reward=${rewardXrd}`)
    log("\n" + manifest)
    return { dryRun: true }
  }
  const { intentHash } = await signAndSubmit(manifest, pk, account)
  await commitOrThrowHere(intentHash, "approve_and_release")
  return { intentHash }
}

// Recovery: ONLY valid while the task is still Open (pre-claim) and the poster
// still holds the Task Receipt #taskId#. Once the worker has bonded a claim,
// cancel is rejected on-chain — recover via expire_claim (public once the
// deadline plus grace has passed; the caller is paid a min(1 XRD, bond) bounty)
// or the dispute path instead. There is no heartbeat timeout to wait out: DB-3
// removed the leg, so the claim deadline is fixed at claim time.
export async function cancelTask({ onChainTaskId, dryRun }) {
  assertPull()
  const { account, pk } = dryRun
    ? { account: process.env.POSTER_ACCOUNT_ADDRESS ?? DRYRUN_ACCOUNT, pk: null }
    : await loadPosterKey()
  const manifest = cancelTaskManifest(ESCROW_COMPONENT, account, ESCROW_RECEIPT_RESOURCE, onChainTaskId)
  if (dryRun) {
    log(`DRY-RUN cancel_task task=${onChainTaskId} (Open/pre-claim only)`)
    log("\n" + manifest)
    return { dryRun: true }
  }
  const { intentHash } = await signAndSubmit(manifest, pk, account)
  await commitOrThrowHere(intentHash, "cancel_task")
  return { intentHash }
}

// Recovery after a worker has bonded: cancel_task_by_poster_after_claim. Valid
// ONLY while the task is Claimed (not yet submitted). Pays nobody: reward + insurance
// are CREDITED to the poster's entitlement and the worker's claim bond IN FULL to the
// worker's; each party collects via `withdraw --as <poster|worker>`.
//
// Under push the blueprint handed ALL THREE buckets to the caller, so routing the
// bond back was this manifest's responsibility and a short leg silently kept
// worker collateral. Under pull the component credits the bond back itself, but
// the figure this harness REPORTS is still read from chain, never from a local
// constant — and since Wave B it is read from the TASK (`claim_bond_amount`,
// pinned at claim_task), not from component config: the bond is per-task now,
// and the component's params can be re-set after a claim without changing what
// that claim posted. Every gate below runs on the --dry-run path too: the
// preview is only honest if it is built from the same chain facts the signed tx
// would be.
export async function cancelTaskAfterClaim({ onChainTaskId, workerAccount, dryRun }) {
  assertPull()
  if (!workerAccount || !workerAccount.startsWith("account_rdx1")) {
    log("FATAL: cancel-after-claim needs --worker account_rdx1… — the claim bond must have a destination.")
    process.exit(1)
  }
  // readOnChainClaimInfo THROWS on a Gateway transport failure and returns nulls on
  // an absent entry — both refuse below rather than guessing at the task's state.
  const info = await readOnChainClaimInfo(onChainTaskId, ESCROW_COMPONENT)
  if (info.state !== "Claimed") {
    log(`FATAL: task ${onChainTaskId} is ${info.state ?? "unreadable"} on-chain, not Claimed — refusing to sign.`)
    log("  Open → use the `cancel` verb; Submitted onward → approve or dispute.")
    process.exit(1)
  }
  // The escrow's own worker_account is the authority; --worker must agree with it.
  if (info.workerAccount !== workerAccount) {
    log(`FATAL: on-chain worker_account=${info.workerAccount ?? "none"} ≠ --worker ${workerAccount} — refusing to sign.`)
    process.exit(1)
  }
  const bond = await readTaskClaimBond(onChainTaskId, ESCROW_COMPONENT)
  if (!(Number(bond) > 0)) {
    log(`FATAL: could not read a positive claim_bond_amount for task ${onChainTaskId} from the live escrow — refusing to sign.`)
    process.exit(1)
  }
  const { account, pk } = dryRun
    ? { account: process.env.POSTER_ACCOUNT_ADDRESS ?? DRYRUN_ACCOUNT, pk: null }
    : await loadPosterKey()
  // PULL: no workerAccount / bond here either — the bond is credited back to the
  // worker as an entitlement, not pushed to an account in this transaction. The
  // live-bond read above is KEPT: it still gates on the task being Claimed and
  // proves the bond figure this harness reports, and under push a short bond
  // silently kept worker collateral, which is exactly the class of bug worth
  // keeping a chain read for even once the manifest stopped carrying the number.
  const manifest = cancelTaskAfterClaimManifest(
    ESCROW_COMPONENT,
    account,
    ESCROW_RECEIPT_RESOURCE,
    onChainTaskId,
  )
  if (dryRun) {
    log(`DRY-RUN cancel_task_by_poster_after_claim task=${onChainTaskId} bond=${bond} → ${workerAccount} (Claimed only)`)
    log("\n" + manifest)
    return { dryRun: true, workerAccount, claimBondXrd: bond }
  }
  const { intentHash } = await signAndSubmit(manifest, pk, account)
  await commitOrThrowHere(intentHash, "cancel_task_by_poster_after_claim")
  return { intentHash, workerAccount, claimBondXrd: bond }
}

// ── Dispute legs (raise + finalize) ──────────────────────────────────────────
// raise_dispute moves NO money — it flips the on-chain task Submitted→Disputed and
// emits DisputeRaisedEvent. Two callers, distinguished by proof:
//   • poster path — Task Receipt NFT, local id `#<taskId>#`, POSTER key.
//   • worker  path — Member badge (Gate-1 claimer_is_agent=false), WORKER key.
// The poster path is harness-native (Task Receipt + POSTER key); the worker path
// mirrors what gate1-e2e drives from the client. Both go through assertVNext.
export async function raiseDispute({ onChainTaskId, as, evidenceHashHex, dryRun }) {
  assertPull()
  if (!dryRun) assertLiveDisputeAllowed("raise_dispute")
  const raiser = as === "poster" ? "poster" : "worker"
  let account, pk, proofResource, proofLocalId
  if (raiser === "poster") {
    ;({ account, pk } = dryRun
      ? { account: process.env.POSTER_ACCOUNT_ADDRESS ?? DRYRUN_ACCOUNT, pk: null }
      : await loadPosterKey())
    proofResource = ESCROW_RECEIPT_RESOURCE
    proofLocalId = `#${onChainTaskId}#`
  } else {
    // Worker path — Member badge. Local id form `<guild_member_<username>>`; for a
    // --dry-run preview accept an explicit --badge-local-id, else a placeholder.
    const keyHex = process.env.GUILD_AGENT_PRIVATE_KEY
    if (keyHex) {
      pk = new PrivateKey.Ed25519(keyHex)
      account = String(
        await RadixEngineToolkit.Derive.virtualAccountAddressFromPublicKey(pk.publicKey(), NetworkId.Mainnet),
      )
    } else if (dryRun) {
      account = process.env.GUILD_AGENT_ACCOUNT_ADDRESS ?? DRYRUN_ACCOUNT
    } else {
      log("FATAL: GUILD_AGENT_PRIVATE_KEY (worker key) not set — cannot raise as worker.")
      process.exit(1)
    }
    proofResource = process.env.GUILD_AGENT_BADGE_RESOURCE ?? MEMBER_BADGE
    proofLocalId = process.env.GUILD_AGENT_BADGE_LOCAL_ID ?? "<guild_member_placeholder>"
  }
  const evidence = evidenceHashHex ?? null
  const manifest = raiseDisputeManifest(
    ESCROW_COMPONENT,
    account,
    proofResource,
    proofLocalId,
    onChainTaskId,
    evidence,
  )
  if (dryRun) {
    log(`DRY-RUN raise_dispute task=${onChainTaskId} as=${raiser} evidence=${evidence ?? "none"}`)
    log("\n" + manifest)
    return { dryRun: true, raisedBy: raiser }
  }
  const { intentHash } = await signAndSubmit(manifest, pk, account)
  await commitOrThrowHere(intentHash, "raise_dispute")
  return { intentHash, raisedBy: raiser }
}

// auto_resolve_dispute is PUBLIC (any funded key can finalize) once the window
// has elapsed. PULL: the manifest is a bare trigger — the component applies its
// own dispute_auto_resolve_default and credits both entitlements internally, so
// the harness supplies no accounts and no amounts and CANNOT mis-route (the H1
// class is structurally gone). The component's default is still read, but only
// to REPORT the ruling the chain will apply — gate1-e2e derives its payout
// expectations from that report rather than assuming a ruling, and under
// pull auto-resolve the ruling governs the REWARD only (insurance is always
// credited to the poster — auto_resolve_dispute passes RefundPoster as the
// insurance ruling to lib.rs credit_split_for_parties).
export async function autoResolve({ onChainTaskId, raisedBy, dryRun }) {
  assertPull()
  if (!dryRun) assertLiveDisputeAllowed("auto_resolve_dispute")
  // Explicit, case-insensitive mapping to the blueprint's capitalized enum. A
  // silent `else → Worker` would REPORT a poster-raised dispute as worker-raised,
  // which under FavorDisputeRaiser predicts the wrong winner.
  const raisedLower = String(raisedBy ?? "worker").toLowerCase()
  if (raisedLower !== "poster" && raisedLower !== "worker") {
    log(`FATAL: --raised-by must be poster|worker (got ${raisedBy}).`)
    process.exit(1)
  }
  const raiser = raisedLower === "poster" ? "Poster" : "Worker"
  const autoDefault = (await readEscrowConfig()).disputeAutoResolveDefault
  if (!autoDefault) {
    log("FATAL: could not read dispute_auto_resolve_default from the component — refusing to report a ruling blind.")
    process.exit(1)
  }
  const ruling = autoResolveRuling(autoDefault, raiser)
  const { account, pk } = dryRun
    ? { account: process.env.POSTER_ACCOUNT_ADDRESS ?? DRYRUN_ACCOUNT, pk: null }
    : await loadPosterKey()
  const manifest = autoResolveDisputeManifest(ESCROW_COMPONENT, onChainTaskId)
  if (dryRun) {
    log(`DRY-RUN auto_resolve_dispute task=${onChainTaskId} raisedBy=${raiser} default=${autoDefault} → ruling=${ruling}`)
    log("\n" + manifest)
    return { dryRun: true, raisedBy: raiser, autoDefault, ruling }
  }
  const { intentHash } = await signAndSubmit(manifest, pk, account)
  await commitOrThrowHere(intentHash, "auto_resolve_dispute")
  return { intentHash, raisedBy: raiser, autoDefault, ruling }
}

// ── Programmatic Member-badge mint (headless worker self-mints) ──────────────
// The web radixguild.com/mint flow needs the account in the Radix Wallet; a
// capped fleet key isn't, so the worker signs public_mint(username) itself. The
// Member badge local id is string-derived: `guild_member_<username>` (loadConfig's
// normalizeLocalId wraps it to the angle-bracket form the manifest builder needs).
export async function mintMemberBadge({ username, dryRun }) {
  const keyHex = process.env.GUILD_AGENT_PRIVATE_KEY // worker key self-mints
  let account, pk
  if (keyHex) {
    pk = new PrivateKey.Ed25519(keyHex)
    account = String(await RadixEngineToolkit.Derive.virtualAccountAddressFromPublicKey(pk.publicKey(), NetworkId.Mainnet))
  } else if (dryRun) {
    account = DRYRUN_ACCOUNT
  } else {
    log("FATAL: GUILD_AGENT_PRIVATE_KEY (worker key) not set — cannot mint.")
    process.exit(1)
  }
  const manifest = publicMintManifest(MANAGER, username, account)
  const badgeLocalId = `guild_member_${username}`
  if (dryRun) {
    log(`DRY-RUN public_mint("${username}") → ${account}`)
    log("\n" + manifest)
    return { dryRun: true, account, badgeLocalId, badgeResource: MEMBER_BADGE }
  }
  const { intentHash } = await signAndSubmit(manifest, pk, account)
  await commitOrThrowHere(intentHash, "public_mint")
  return { intentHash, account, badgeLocalId, badgeResource: MEMBER_BADGE }
}

// ── Recovery: sweep an account's full XRD back to a wallet you control ────────
// "Get the funds back" button. Works for any fleet key (raw private key = full
// signing control). role=worker → GUILD_AGENT_PRIVATE_KEY; role=poster → POSTER_PRIVATE_KEY.
// ── Collection (withdraw_worker / withdraw_poster) — PULL §5c ────────────────
//
// The harness had NO withdraw verb for EITHER payee, which meant the settlement
// half of the lifecycle could not be driven headlessly at all: the first real
// two-party collection (2026-08-20) had to be walked through the browser. This
// is what makes it repeatable.
//
// ⚠️ Which badge the WORKER must present is decided ON CHAIN by claimer_is_agent
// and claimer_badge_id — never by what this harness has configured. Getting that
// from config is precisely the bug that shipped in the agent-client CLI and was
// caught in review: a member-claimed task read against a config default agrees
// by luck, and an agent-claimed one silently presents the wrong resource.
/**
 * The manifest a resolved `collect` affordance calls for.
 *
 * Split out and exported PURELY so the composition is testable: every live run
 * against a settled task hits a refusal, so without this the one path that
 * actually moves money would be exercised by nothing. The resolver and the
 * builders each have their own tests; this is the seam between them.
 *
 * Switching on `affordance.party` rather than on a caller-supplied role is the
 * point — the party is chain-derived, so the poster branch has no badge fields
 * to leave blank and the worker branch has no receipt to guess.
 */
export function buildWithdrawManifest(affordance, { component, account, taskId }) {
  if (affordance.kind !== "collect") {
    throw new Error(`buildWithdrawManifest needs a collect affordance, got ${affordance.kind}`)
  }
  return affordance.party === "poster"
    ? withdrawPosterManifest(component, account, affordance.receiptResource, taskId)
    : withdrawWorkerManifest(component, account, affordance.badgeResource, affordance.badgeLocalId, taskId)
}

export async function withdrawEntitlement({ onChainTaskId, as, dryRun }) {
  assertPull()
  if (as !== "poster" && as !== "worker") {
    throw new Error("withdraw --as must be poster|worker")
  }

  // Resolve the SIGNER first: --as picks which key to load, and the chain then
  // tells us what that account actually is. Deriving the party from the account
  // rather than trusting the flag is what makes a wrong key a refusal instead of
  // a transaction that pays somebody else.
  let account, pk
  if (as === "poster") {
    ;({ account, pk } = dryRun
      ? { account: process.env.POSTER_ACCOUNT_ADDRESS ?? DRYRUN_ACCOUNT, pk: null }
      : await loadPosterKey())
  } else {
    const keyHex = process.env.GUILD_AGENT_PRIVATE_KEY
    if (!keyHex) {
      if (!dryRun) { log("FATAL: withdraw --as worker needs GUILD_AGENT_PRIVATE_KEY."); process.exit(1) }
      log("NOTE: GUILD_AGENT_PRIVATE_KEY unset — dry run cannot check the payee pin.")
      account = DRYRUN_ACCOUNT
      pk = null
    } else {
      const key = new PrivateKey.Ed25519(keyHex)
      account = String(await RadixEngineToolkit.Derive.virtualAccountAddressFromPublicKey(key.publicKey(), NetworkId.Mainnet))
      pk = dryRun ? null : key
    }
  }

  // null = UNKNOWN, never "nothing owed". Collapsing the two tells a payee the
  // money already arrived.
  const info = await readEscrowTaskInfo(onChainTaskId, ESCROW_COMPONENT)
  if (!info) {
    log(`FATAL: could not read task ${onChainTaskId} on ${ESCROW_COMPONENT}.`)
    log("       That is UNKNOWN, not 'nothing owed'. Check the task id is on THIS")
    log("       component — ids are per-component and collide across cutovers.")
    process.exit(1)
  }

  const affordance = resolveWithdrawAffordance(info, account, {
    memberBadge: BADGE_NFT,
    agentBadge: AGENT_BADGE_NFT,
    taskReceipt: ESCROW_RECEIPT_RESOURCE,
  })

  if (affordance.kind === "none") {
    const why = {
      "not-on-chain": "this task is not funded on-chain",
      unknown: "the task info could not be read (UNKNOWN, not zero)",
      "no-entitlement-fields": "this component records no entitlements — it is a pre-PULL escrow",
      "not-a-payee": `${account} is neither payee pinned on this task`,
      "nothing-owed": "nothing is owed — already collected, or not settled yet",
    }[affordance.reason]
    log(`nothing to collect as ${as} on task ${onChainTaskId}: ${why}.`)
    // `not-a-payee` is an OPERATOR error (wrong key for --as), not a benign
    // state, so it fails closed; the rest are legitimate no-ops.
    const isMisconfig = affordance.reason === "not-a-payee" || affordance.reason === "no-entitlement-fields"
    if (isMisconfig) process.exit(1)
    return { collected: false, reason: affordance.reason }
  }

  if (affordance.kind === "blocked") {
    log(`FATAL: owed, but this harness cannot build the proof: ${explainWithdrawBlocker(affordance.reason)}`)
    process.exit(1)
  }

  // The chain decided the party; the flag only chose a keyring. Disagreement
  // means the wrong key is in the env for the role that was asked for.
  if (affordance.party !== as) {
    log(`FATAL: --as ${as} but ${account} is the ${affordance.party} on task ${onChainTaskId}.`)
    process.exit(1)
  }

  const manifest = buildWithdrawManifest(affordance, {
    component: ESCROW_COMPONENT,
    account,
    taskId: onChainTaskId,
  })

  const lanes = outstandingLanes(affordance.outstanding)
    .map((l) => (l === "reward" ? `${affordance.outstanding.reward} reward` : `${affordance.outstanding.bondXrd} XRD claim bond`))
    .join(" + ")
  const pinned = as === "poster" ? info.posterAccount : info.workerAccount

  if (dryRun) {
    log(`DRY-RUN withdraw_${as} task=${onChainTaskId} owed=${lanes} → pinned ${pinned ?? "(unset)"}`)
    log("\n" + manifest)
    return { dryRun: true, outstanding: affordance.outstanding }
  }
  const { intentHash } = await signAndSubmit(manifest, pk, account)
  await commitOrThrowHere(intentHash, `withdraw_${as}`)
  // Deliberately does not name a destination as fact: withdraw_* takes no
  // destination argument, so the chain is the record.
  log(`collected ${lanes} — deposited into the account pinned at ${as === "poster" ? "create" : "claim"}`)
  return { intentHash, collected: true, outstanding: affordance.outstanding }
}

export async function sweep({ role, to, dryRun }) {
  if (!to || !to.startsWith("account_rdx1")) {
    log("FATAL: sweep needs --to account_rdx1… (a wallet you control)")
    process.exit(1)
  }
  const keyHex = role === "poster" ? process.env.POSTER_PRIVATE_KEY : process.env.GUILD_AGENT_PRIVATE_KEY
  if (!keyHex) { log(`FATAL: no key in env for role=${role} (need ${role === "poster" ? "POSTER_PRIVATE_KEY" : "GUILD_AGENT_PRIVATE_KEY"}).`); process.exit(1) }
  const pk = new PrivateKey.Ed25519(keyHex)
  const account = String(await RadixEngineToolkit.Derive.virtualAccountAddressFromPublicKey(pk.publicKey(), NetworkId.Mainnet))
  const fung = await gatewayPost("/state/entity/page/fungibles", { address: account })
  const balance = Number((fung.items ?? []).find((i) => i.resource_address === XRD)?.amount ?? "0")
  const amount = Math.max(0, balance - FEE_HEADROOM)
  log(`sweep ${role}: ${account} balance=${balance} XRD → send ${amount} to ${to} (leave ${FEE_HEADROOM} for fee)`)
  if (amount <= 0) { log("nothing to sweep (balance ≤ fee headroom)"); return { swept: 0, account } }
  const manifest = `CALL_METHOD
  Address("${account}")
  "withdraw"
  Address("${XRD}")
  Decimal("${amount}")
;
TAKE_FROM_WORKTOP
  Address("${XRD}")
  Decimal("${amount}")
  Bucket("sweep")
;
CALL_METHOD
  Address("${to}")
  "try_deposit_or_abort"
  Bucket("sweep")
  Enum<0u8>()
;`
  if (dryRun) { log("DRY-RUN sweep manifest:\n" + manifest); return { dryRun: true, amount, account, to } }
  const { intentHash } = await signAndSubmit(manifest, pk, account)
  await commitOrThrowHere(intentHash, "sweep")
  return { intentHash, swept: amount, account, to }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const hasFlag = (name) => process.argv.includes(`--${name}`)

async function main() {
  const cmd = process.argv[2]
  const dryRun = hasFlag("dry-run")
  switch (cmd) {
    case "get-config": {
      const cfg = await readEscrowConfig()
      const ok = assertConfigOk(cfg)
      emit({ ok, ...cfg })
      process.exit(ok ? 0 : 1)
      break
    }
    case "create-fund": {
      const reward = Number(arg("reward", "5"))
      const title = arg("title", "Gate-1 e2e smoke task")
      const description = arg("desc", "Programmatic agent-lane money-path proof (Gate-1).")
      const out = await createAndFundTask({ reward, title, description, dryRun })
      emit(out)
      break
    }
    case "approve": {
      const onChainTaskId = Number(arg("task"))
      const workerAccount = arg("worker")
      const rewardXrd = Number(arg("reward", "5"))
      if (!onChainTaskId || !workerAccount) throw new Error("approve needs --task and --worker")
      const out = await approveAndRelease({ onChainTaskId, workerAccount, rewardXrd, dryRun })
      emit(out)
      break
    }
    case "cancel": {
      const onChainTaskId = Number(arg("task"))
      if (!onChainTaskId) throw new Error("cancel needs --task")
      const out = await cancelTask({ onChainTaskId, dryRun })
      emit(out)
      break
    }
    case "cancel-after-claim": {
      const onChainTaskId = Number(arg("task"))
      const workerAccount = arg("worker")
      if (!onChainTaskId) throw new Error("cancel-after-claim needs --task <onChainTaskId>")
      if (!workerAccount) throw new Error("cancel-after-claim needs --worker <account> (the claim bond returns to them)")
      const out = await cancelTaskAfterClaim({ onChainTaskId, workerAccount, dryRun })
      emit(out)
      break
    }
    case "dispute": {
      const onChainTaskId = Number(arg("task"))
      const as = arg("as", "worker")
      const evidenceHashHex = arg("evidence") ?? null
      if (!onChainTaskId) throw new Error("dispute needs --task <onChainTaskId>")
      if (as !== "poster" && as !== "worker") throw new Error("dispute --as must be poster|worker")
      const out = await raiseDispute({ onChainTaskId, as, evidenceHashHex, dryRun })
      emit(out)
      break
    }
    case "auto-resolve": {
      const onChainTaskId = Number(arg("task"))
      const raisedBy = arg("raised-by", "worker")
      if (!onChainTaskId) throw new Error("auto-resolve needs --task <onChainTaskId>")
      const out = await autoResolve({ onChainTaskId, raisedBy, dryRun })
      emit(out)
      break
    }
    case "mint-badge": {
      const username = arg("username")
      if (!username) throw new Error("mint-badge needs --username (worker self-mints via GUILD_AGENT_PRIVATE_KEY)")
      const out = await mintMemberBadge({ username, dryRun })
      emit(out)
      break
    }
    case "withdraw": {
      const onChainTaskId = Number(arg("task"))
      const as = arg("as")
      if (!onChainTaskId) throw new Error("withdraw needs --task <onChainTaskId>")
      if (!as) throw new Error("withdraw needs --as <poster|worker> (there is no safe default — the two use different credentials)")
      const out = await withdrawEntitlement({ onChainTaskId, as, dryRun })
      emit(out)
      break
    }
    case "sweep": {
      const role = arg("role", "worker")
      const to = arg("to")
      const out = await sweep({ role, to, dryRun })
      emit(out)
      break
    }
    default:
      log("usage: poster-harness.mjs <get-config|create-fund|approve|cancel|cancel-after-claim|dispute|auto-resolve|mint-badge|sweep> [--dry-run] [...]")
      process.exit(2)
  }
}

// Run as CLI only when invoked directly (importable by gate1-e2e.mjs without side effects).
if (import.meta.main) {
  main().catch((e) => {
    log("fatal: " + String(e))
    process.exit(1)
  })
}
