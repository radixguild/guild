#!/usr/bin/env bun
// edge-autoresolve-shape.mjs — prove the PULL-era `auto_resolve_dispute` BUILDER
// against the live component, keyless, BEFORE the operator signs it.
//
//   cd guild-app && bun scripts/edge-autoresolve-shape.mjs
//
// Exit 0 only if the preview reverted for the CLOCK. 1 on any other verdict,
// 2 if the live state read came back empty.
//
// ⚠️ CANNOT SIGN, CANNOT SUBMIT. Reads no key material; calls only
// `/status/gateway-status` and `/transaction/preview`, which commits nothing.
//
// WHY THIS EXISTS
// ---------------
// The two live clocks were NOT equally proven. `expire_claim` on task 2 was
// previewed against the real task and reverted with the exact panic naming its
// own source line. `auto_resolve_dispute` on task 3 had no equivalent: its only
// live mainnet proof (2026-08-15) was against the RETIRED push-shaped component
// and its bucket-returning version of the method. The PULL builder returns `()`
// and routes nothing — a materially different call shape.
//
// That gap is the exact shape of the defect that bit on 2026-08-09, when THREE
// poster-side builders passed a `Bucket` where the PULL blueprint takes a
// `Proof`, and failed on every task post-cutover. Errors of that class are
// invisible to unit tests and to builder-vs-builder parity tests, because both
// sides can agree with each other and disagree with the blueprint. Only the
// live ABI settles it.
import { autoResolveDisputeManifest } from "../src/lib/manifests"
import { GATEWAY, ESCROW_COMPONENT } from "../src/lib/config"
import { readEscrowTaskInfo } from "../src/lib/gateway"

const AUTO_RESOLVE_SECS = 259_200 // 72h — docs/ESCROW-PARAMETER-SHEET.md

// ── THE CLASSIFIER ──────────────────────────────────────────────────────────
// Exported and unit-tested, because a mutation run proved the first version of
// it produced a FALSE GREEN.
//
// That version matched the clock on /auto_resolve/i. Renaming the method to a
// non-existent `auto_resolve_disputes` still classified as ✅ CLOCK — the
// blueprint had rejected the call outright with `NoMethodMapping`, but the
// error text *quotes the method name back*, so the pattern matched its own
// input. A revert message contains the thing you asked for; matching on that
// proves only that you asked.
//
// So the clock pattern is pinned to the blueprint's own panic string, and it
// must be a PanicMessage: a panic is the blueprint running and choosing to
// stop, which is the only outcome that proves the argument types were accepted.
export const CLOCK_REVERT =
  /PanicMessage\("dispute auto-resolve window has not elapsed/
// Shape/ABI rejections — the call never reached the blueprint body at all.
// NoMethodMapping belongs here, not in the clock class. See above.
export const SHAPE_REVERT =
  /TypeCheckError|InputSchemaNotMatchingSchema|InvalidArgument|ArgumentCount|NoMethodMapping|MethodNotFound|FnNotFound|BucketError/i

/** SHAPE is tested FIRST, so a shape error can never be read as a clock revert. */
export function classifyPreview(status, errorMessage = "") {
  if (SHAPE_REVERT.test(errorMessage)) return "shape"
  if (status === "Failed" && CLOCK_REVERT.test(errorMessage)) return "clock"
  if (status === "Succeeded") return "succeeded"
  return "inconclusive"
}

async function gwPost(path, body) {
  const r = await fetch(`${GATEWAY}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}: ${await r.text()}`)
  return r.json()
}

export async function previewAutoResolve(taskId, component = ESCROW_COMPONENT) {
  const epoch = (await gwPost("/status/gateway-status", {})).ledger_state?.epoch
  if (!epoch) throw new Error("Gateway returned no epoch — refusing to guess one")
  const manifest = autoResolveDisputeManifest(component, taskId)
  const out = await gwPost("/transaction/preview", {
    manifest,
    start_epoch_inclusive: epoch,
    end_epoch_exclusive: epoch + 2,
    tip_percentage: 0,
    nonce: 42,
    signer_public_keys: [],
    flags: { use_free_credit: true, assume_all_signature_proofs: true, skip_epoch_check: false },
  })
  return {
    manifest,
    status: out.receipt?.status ?? "(no receipt)",
    error: out.receipt?.error_message ?? "",
  }
}

async function main() {
  const TASK = Number(process.env.PROBE_TASK ?? 3)
  console.log(`component: ${ESCROW_COMPONENT}`)
  console.log(`gateway:   ${GATEWAY}`)

  const info = await readEscrowTaskInfo(TASK, ESCROW_COMPONENT)
  // A null here is a FAILED READ, not "no dispute". Printing it as data is how a
  // broken leg gets mistaken for evidence — so it stops the probe instead.
  if (!info) {
    console.error(`\n  ⛔ state read returned null for task ${TASK} on ${ESCROW_COMPONENT}.`)
    console.error("     Not proceeding: a preview verdict only means something next to the state it ran against.")
    process.exit(2)
  }

  console.log(`\n── LIVE STATE, on-chain task ${TASK} ──`)
  console.log(`  state:            ${info.state}`)
  console.log(`  disputeRaisedBy:  ${info.disputeRaisedBy}`)
  console.log(`  disputedAt:       ${info.disputedAt?.toISOString() ?? "null"}`)
  if (info.disputedAt) {
    const opens = new Date(info.disputedAt.getTime() + AUTO_RESOLVE_SECS * 1000)
    console.log(`  window opens:     ${opens.toISOString()}   (disputedAt + 72h)`)
    console.log(`  time remaining:   ${((opens - Date.now()) / 3_600_000).toFixed(2)} h`)
  }
  console.log(`  entitlements:     ${JSON.stringify(info.entitlements)}`)

  const { manifest, status, error } = await previewAutoResolve(TASK)
  console.log(`\n── MANIFEST, from the real builder ──\n${manifest}`)
  console.log(`\n── PREVIEW ──\n  status: ${status}`)
  if (error) console.log(`  error : ${error.split("\n")[0]}`)

  const verdict = classifyPreview(status, error)
  console.log("\n── VERDICT ──")
  if (verdict === "shape") {
    console.log("  🔴 BUILDER BROKEN — shape/ABI mismatch, not the clock.")
    console.log(`     The operator signature would FAIL. Full error:\n${error}`)
  } else if (verdict === "clock") {
    console.log("  ✅ BUILDER PROVEN. Reverted on the CLOCK, not the shape —")
    console.log("     the blueprint accepted the argument types and reached its time gate.")
  } else if (verdict === "succeeded") {
    console.log("  ⚠️  SUCCEEDED — the window is already open. Not a shape proof on its own;")
    console.log("     re-read the clock and hand the manifest to the operator.")
  } else {
    console.log(`  ⚠️  INCONCLUSIVE — reverted for an unexpected reason:\n${error}`)
  }
  process.exit(verdict === "clock" ? 0 : 1)
}

if (import.meta.main) await main()
