/**
 * Escrow Utilities — client wrappers around the escrow manifest builders.
 *
 * Each wrapper builds a transaction manifest for the deployed `Escrow` singleton
 * and sends it via the Radix dApp Toolkit. All wrappers no-op (return an error
 * result) when escrow is not deployed/enabled (FEATURE_ESCROW gate).
 *
 * Commitments: create_task binds sha256(canonicalWorkBrief(title, description))
 * and submit_task binds sha256(canonicalSubmissionEvidence(content)) — see the
 * FROZEN v1 canonicalization section below. raise_dispute's optional evidence
 * commitment stays a free-form reference chosen by the raiser.
 */

"use client"

import {
  ESCROW_COMPONENT,
  ESCROW_RECEIPT_RESOURCE,
  ESCROW_CLAIM_RECEIPT_RESOURCE,
  ESCROW_CLAIM_BOND_XRD,
  BADGE_NFT,
  isEscrowDeployed,
} from "@/lib/config"
import {
  createTaskManifest,
  claimTaskManifest,
  submitTaskManifest,
  approveAndReleaseManifest,
  cancelTaskManifest,
  cancelTaskAfterClaimManifest,
  raiseDisputeManifest,
  autoResolveDisputeManifest,
  releaseAfterReviewTimeoutManifest,
  expireClaimManifest,
  pushEntitlementManifest,
  withdrawWorkerManifest,
  withdrawPosterManifest,
  requiredBond,
} from "@/lib/manifests"
import {
  readEscrowTaskCreated,
  readClaimBondParams,
  readTaskRewardInfo,
  readTokenDivisibility,
} from "@/lib/gateway"
import { INSURANCE_RATE } from "@/lib/marketplace"
import { apiFetch } from "@/lib/api-fetch"
import type { RadixDappToolkit } from "@radixdlt/radix-dapp-toolkit"

// ── Types ──────────────────────────────────────────────────────────────────────

export interface EscrowDepositParams {
  rewardXrd: number
  /**
   * The task's STORED title + description (from the created task row, not
   * unsaved form state) — committed on-chain as the work-brief hash via
   * canonicalWorkBrief, so the brief is verifiable against the DB later.
   */
  title: string
  description: string
  /**
   * Canonical terms block (task-terms.ts canonicalTermsBlock over the STORED
   * terms row + deadline). Non-empty → the v2 brief is committed; ""/absent →
   * v1, byte-identical to pre-terms tasks.
   */
  termsBlock?: string
  account: string
  rdt: RadixDappToolkit
}

export interface EscrowClaimParams {
  escrowComponent: string
  account: string
  badgeId: string
  /** On-chain task_id assigned by create_task (step-4: from the task record). */
  taskId?: number
  rdt: RadixDappToolkit
}

export interface EscrowApproveParams {
  escrowComponent: string
  account: string
  /** Task Receipt local id = on-chain task_id (numeric string). */
  receiptId: string
  // workerAddress / rewardXrd / fundTxHash were PUSH-era fields, all three
  // removed at S3. The push manifest had to be TOLD where the reward went and
  // how much it was, so it needed the worker's account and a chain-verified
  // amount; the pull manifest carries neither, because the blueprint pays the
  // payee pinned at claim from state it already holds. Keeping them as ignored
  // optionals would have been worse than deleting them: a caller passing
  // workerAddress would reasonably expect it to affect where the money lands.
  rdt: RadixDappToolkit
}

export interface EscrowTxResult {
  ok: boolean
  txId?: string
  error?: string
}

// ── Commitment canonicalization (v1 — FROZEN) ─────────────────────────────────
//
// The escrow blueprint stores 32-byte commitments, not content: create_task
// commits to the work brief (title + description) and submit_task to the
// worker's submission evidence. A commitment is only meaningful if it can be
// re-derived byte-for-byte years later — e.g. in a dispute, to prove the DB
// brief/submission is exactly what the chain bound — so the v1 canonical
// formats below are FROZEN: never change a v1 prefix or layout. If the format
// must ever evolve, introduce a new versioned prefix (guild-task-brief-v2, …)
// and keep v1 derivable; the prefix tells a verifier which layout produced a
// given hash and keeps the two commitment domains collision-free. Note that v1
// frames fields with newlines (not length prefixes): the brief hash commits to
// the combined text, so the exact title/description split is not independently
// provable from the hash alone.

/** Canonical v1 work-brief string committed on-chain by create_task (FROZEN). */
export function canonicalWorkBrief(title: string, description: string): string {
  return `guild-task-brief-v1\n${title}\n\n${description}`
}

/**
 * Canonical v2 work-brief (FROZEN): v1's layout plus the structured-terms
 * block (task-terms.ts canonicalTermsBlock — itself fixed-order). Only used
 * when at least one term is set, so v1 tasks stay byte-identical forever.
 * A verifier picks the layout by the prefix; the DB picks it by terms
 * presence (tasks.terms IS NULL → v1).
 */
export function canonicalWorkBriefV2(
  title: string,
  description: string,
  termsBlock: string,
): string {
  return `guild-task-brief-v2\n${title}\n\n${description}\n\n-- terms --\n${termsBlock}`
}

/** Canonical v1 submission-evidence string committed on-chain by submit_task (FROZEN). */
export function canonicalSubmissionEvidence(content: string): string {
  return `guild-submission-v1\n${content}`
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** 32-byte SHA-256 (lowercase hex) of the UTF-8 input — the on-chain commitment hash. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

// Shared submit + Result-mapping for all wrappers.
async function send(
  rdt: RadixDappToolkit,
  manifest: string,
): Promise<EscrowTxResult> {
  try {
    const result = await rdt.walletApi.sendTransaction({
      transactionManifest: manifest,
      version: 1,
    })
    if (result.isOk()) {
      return { ok: true, txId: result.value.transactionIntentHash }
    }
    return { ok: false, error: JSON.stringify(result.error) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Transaction failed" }
  }
}

// ── Gate check ─────────────────────────────────────────────────────────────────

export function escrowEnabled(): boolean {
  return isEscrowDeployed()
}

// ── Error humanization (smoke finding 4) ───────────────────────────────────────

export interface HumanizedTxError {
  /** One short line safe to splash on the page. */
  summary: string
  /** Raw payload for a collapsed details expando; absent when summary IS the raw text. */
  detail?: string
  /**
   * The failure means on-chain state already moved past this action (e.g. the
   * receipt was burned by an earlier settle, or the task left Open) — a chain
   * resync, not a retry, is the fix. Callers should trigger one.
   */
  staleState?: boolean
}

/**
 * dApp Toolkit codes for a request the toolkit could not hand to the wallet,
 * or stopped waiting on (2026-10-03, task 70).
 *
 * When @radixdlt/radix-dapp-toolkit cannot hand a request to the wallet,
 * walletApi.sendTransaction resolves err(SdkError), `{ error, interactionId,
 * message }` in 2.2.1, and send() above JSON.stringifies it. Where each code
 * comes from in that version's dist/index.js: "missingExtension" when the
 * Connector extension does not acknowledge the request within the toolkit's
 * 200 ms detection window (it is not forwarded at all while the extension
 * reads as unavailable; a merely slow acknowledgement may still reach the
 * wallet, which is why that line says "did not confirm", not "never received");
 * "SupportedTransportNotFound" from getTransport when the browser has neither
 * the extension path nor the mobile relay; "FailedToSendDappRequest" when the
 * mobile relay's deep link to the wallet app fails; "canceledByUser" when the
 * pending request is cancelled from the Connect button or by disconnecting.
 *
 * Until this map existed every one of them reached the page as "Transaction
 * failed — open the error details below.": task 70's poster pressed Cancel
 * twice, the wallet showed nothing, and the one line that said why was folded
 * into an expando. The raw payload stays in `detail` (it carries the
 * interactionId, which is what matches a report to the toolkit's own logs).
 *
 * Read from the payload's own top-level `error` field only, never from a word
 * inside an engine message: a message like that DID reach the wallet.
 */
const TOOLKIT_UNDELIVERED = new Map<string, string>([
  [
    "missingExtension",
    "The Radix Connector browser extension did not confirm it received this transaction, so this page stopped waiting for your wallet. If the wallet shows no request, check that the extension is installed, enabled and linked to your Radix Wallet, reload the page, and try again.",
  ],
  [
    "SupportedTransportNotFound",
    "Your wallet never received this transaction: this browser has no way to reach the Radix Wallet. Use a desktop browser with the Radix Connector extension, or open this page on the phone that has the wallet, and try again.",
  ],
  [
    "FailedToSendDappRequest",
    "Your wallet never received this transaction: this page could not open the Radix Wallet app. Open the wallet, reconnect with the Connect button at the top of the page, and try again.",
  ],
  [
    "canceledByUser",
    "The request was cancelled before your wallet answered (from the Connect button, or by disconnecting), so this page stopped waiting for your wallet. If the wallet still shows the request, reject it there, then try again.",
  ],
])

/** The toolkit's own error code — the top-level `error` field of a JSON
 *  payload — or null when the payload is not a JSON object carrying one. */
function toolkitErrorCode(raw: string): string | null {
  if (!raw.trimStart().startsWith("{")) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A brace-led engine dump rather than JSON: there is no toolkit code to
    // read, and the signature cases in humanizeTxError handle it.
    return null
  }
  if (parsed === null || typeof parsed !== "object") return null
  const code = (parsed as { error?: unknown }).error
  return typeof code === "string" ? code : null
}

/**
 * Map a raw wallet/Gateway error to a short human line. The wallet SDK
 * surfaces failures as JSON.stringify'd objects and the engine as assertion
 * dumps — neither belongs raw on the page (mainnet-smoke finding: errors
 * splashed as full-width JSON). Known signatures (seen live in the smoke)
 * translate to actionable lines; anything long or structured collapses to a
 * generic summary with the payload preserved for the details expando.
 */
export function humanizeTxError(raw: string): HumanizedTxError {
  // RDT: the user dismissed the wallet prompt — not a failure.
  if (/rejectedByUser/i.test(raw)) {
    return { summary: "Cancelled in the wallet — no transaction was sent." }
  }
  // RDT never got the request to the wallet (or stopped waiting for it). Say
  // so: a wallet that shows nothing is otherwise indistinguishable from a
  // page that did nothing.
  const code = toolkitErrorCode(raw)
  const undelivered = code === null ? undefined : TOOLKIT_UNDELIVERED.get(code)
  if (undelivered) return { summary: undelivered, detail: raw }
  // Not enough XRD in the connected account to cover what the manifest tries
  // to withdraw — the deposit (reward + insurance) on create_task, the claim
  // bond on claim_task, or just the network fee. Confirmed against
  // radix-engine 1.3.1, the exact version escrow/scrypto/guild-marketplace-escrow's
  // Cargo.lock pins (checked against the crates.io source cached at
  // ~/.cargo/registry/src/.../radix-engine-1.3.1, not from memory): a plain
  // vault withdraw that exceeds the balance fails
  // fungible_vault.rs's `take` with `VaultError::ResourceError(ResourceError
  // ::InsufficientBalance { requested, actual })`, and the fee-lock path
  // (same file, `lock_fee`) fails the same underlying take with
  // `VaultError::LockFeeInsufficientBalance { requested, actual }` instead —
  // both Debug-print the literal substring "InsufficientBalance", so one
  // pattern catches both without needing to special-case the fee leg. This
  // is a real engine signature, not one seen live in the smoke yet, so it's
  // ordered with the other pre-flight cases rather than the staleState group.
  //
  // ⚠️ `WorktopError::InsufficientBalance` (worktop.rs, a UNIT variant — no
  // `{ requested, actual }` payload) prints the same substring and is a
  // DIFFERENT failure: the manifest asserted more on the worktop than it put
  // there, which is our bug, not the user's balance. Telling that user to
  // "add some XRD" would send them to buy tokens that would not help. So the
  // guard is the WorktopError prefix, not the bare word — a worktop failure
  // falls through to the generic fallback with its raw payload intact.
  if (!/WorktopError/i.test(raw) && /InsufficientBalance/i.test(raw)) {
    return {
      summary: "Not enough XRD in this account to cover this transaction. Add some XRD and try again.",
      detail: raw,
    }
  }
  // Cancel/approve on an already-settled task: the Task Receipt NFT is no
  // longer in the account, so the withdraw fails before the component runs.
  if (/NonFungible(Vault)?Error.*Missing|MissingNonFungible/i.test(raw)) {
    return {
      summary:
        "That receipt is no longer in your account — the task was already settled or cancelled on-chain. Resyncing the status from chain…",
      detail: raw,
      staleState: true,
    }
  }
  // Claim raced: the on-chain task already left Open (someone claimed it — or
  // your own earlier claim landed and the confirm was lost).
  if (/must be Open/i.test(raw)) {
    return {
      summary:
        "This task is no longer open on-chain — someone already claimed it (or your earlier claim landed). Resyncing the status from chain…",
      detail: raw,
      staleState: true,
    }
  }
  // Submit after the claim expired: expire_claim is PUBLIC and, once the claim
  // deadline passes, anyone can reset the task to Open — which burns the claim
  // and (unless re-claimed) forfeits the bond. Either the state left Claimed or
  // the claim_receipt is no longer the active one. A resync, not a retry.
  // Scoped to the SUBMIT assert ("...to submit"), not a bare "must be Claimed":
  // the blueprint reuses that phrase for expire/cancel-after-claim,
  // and this humanizer is shared across every action's error line.
  if (/must be Claimed to submit|claim_receipt is not the active one/i.test(raw)) {
    return {
      summary:
        "Your claim on this task is no longer active — it likely expired (anyone can expire a claim once its deadline passes) or was cancelled. Resyncing the status from chain…",
      detail: raw,
      staleState: true,
    }
  }
  // Structured / long payloads: one-line summary, payload behind the expando.
  if (raw.trimStart().startsWith("{") || raw.length > 160) {
    return { summary: "Transaction failed — open the error details below.", detail: raw }
  }
  return { summary: raw }
}

// ── Resync (self-service chain → DB heal; smoke finding 3) ─────────────────────

/**
 * Trigger the server-side per-task chain resync (auth required — call
 * ensureSession first). Replays any missed lifecycle confirms from chain
 * history; `applied` is how many advanced, `pending` what still can't (with
 * reasons — e.g. a lost claim only the worker's own session can heal).
 */
export async function resyncEscrowTask(taskDbId: number | string): Promise<{
  ok: boolean
  applied: number
  pending: { kind: string; reason: string }[]
  error?: string
}> {
  try {
    const res = await apiFetch(`/api/v1/tasks/${taskDbId}/escrow/resync`, { method: "POST" })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || !json?.ok) {
      return { ok: false, applied: 0, pending: [], error: json?.error?.message || "Resync failed" }
    }
    return {
      ok: true,
      applied: Array.isArray(json.data?.applied) ? json.data.applied.length : 0,
      pending: Array.isArray(json.data?.pending) ? json.data.pending : [],
    }
  } catch (e) {
    return { ok: false, applied: 0, pending: [], error: e instanceof Error ? e.message : "Resync failed" }
  }
}

// ── Deposit (create_task) ───────────────────────────────────────────────────────

export async function sendDepositTx(
  params: EscrowDepositParams,
): Promise<EscrowTxResult> {
  if (!isEscrowDeployed()) return { ok: false, error: "Escrow not deployed" }
  try {
    const insuranceXrd = Math.ceil(params.rewardXrd * INSURANCE_RATE)
    const workBriefHash = await sha256Hex(
      params.termsBlock
        ? canonicalWorkBriefV2(params.title, params.description, params.termsBlock)
        : canonicalWorkBrief(params.title, params.description),
    )
    const manifest = createTaskManifest(
      ESCROW_COMPONENT,
      params.account,
      params.rewardXrd,
      insuranceXrd,
      "0", // arbiter_fee_pct — no arbiter fee at launch (disputes auto-resolve)
      workBriefHash,
    )
    return await send(params.rdt, manifest)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Deposit failed" }
  }
}

// ── Claim (claim_task) ───────────────────────────────────────────────────────────

export async function sendClaimTx(
  params: EscrowClaimParams,
): Promise<EscrowTxResult> {
  if (!isEscrowDeployed()) return { ok: false, error: "Escrow not deployed" }
  if (params.taskId === undefined) {
    return { ok: false, error: "On-chain task id unavailable (escrow UI wiring pending)" }
  }
  try {
    const component = params.escrowComponent || ESCROW_COMPONENT
    // 🔴 The bond is DERIVED from live chain state, never from a constant.
    // Wave B removed the flat `claim_bond_xrd` this used to read from config;
    // the bond is now clamp(reward * pct, floor, cap) in the task's OWN
    // reward_token. Fails CLOSED — a guessed bond is a reverted tx (too small)
    // or real money bonded on an unverified number (too large), so there is
    // nothing safe to fall back to.
    const bondParams = await readClaimBondParams(component)
    if (!bondParams) {
      return {
        ok: false,
        error:
          "Could not read the escrow's claim-bond parameters from the Gateway — refusing to " +
          "build a claim with a guessed bond. Try again once the network is reachable.",
      }
    }
    const rewardInfo = await readTaskRewardInfo(params.taskId, component)
    if (!rewardInfo) {
      return {
        ok: false,
        error:
          `Could not read task #${params.taskId}'s reward token/amount from the Gateway — ` +
          "the bond is a share of the reward, so it cannot be sized without them.",
      }
    }
    const divisibility = await readTokenDivisibility(rewardInfo.rewardToken)
    if (divisibility === null) {
      return {
        ok: false,
        error:
          "Could not read the reward token's divisibility from the Gateway — refusing to build " +
          "a bond amount the ledger might silently truncate.",
      }
    }
    const bondAmount = requiredBond(
      rewardInfo.rewardAmount,
      bondParams.pct,
      bondParams.floor,
      bondParams.cap,
      divisibility,
    )
    const manifest = claimTaskManifest(
      component,
      params.account,
      BADGE_NFT,
      params.badgeId,
      params.taskId,
      rewardInfo.rewardToken,
      bondAmount,
    )
    return await send(params.rdt, manifest)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Claim failed" }
  }
}

// ── Approve + Release (approve_and_release) ────────────────────────────────────

export async function sendApproveTx(
  params: EscrowApproveParams,
): Promise<EscrowTxResult> {
  if (!isEscrowDeployed()) return { ok: false, error: "Escrow not deployed" }
  const taskId = Number(params.receiptId)
  if (!Number.isInteger(taskId) || taskId <= 0) {
    return { ok: false, error: "Task id unavailable (escrow UI wiring pending)" }
  }
  const component = params.escrowComponent || ESCROW_COMPONENT
  try {
    // The manifest is a proof + one call, and carries NO amount and NO worker
    // account — the blueprint credits entitlements from state pinned on the task.
    //
    // M1's chain-read reward verification lived in the deleted push branch, and
    // it is MOOT here rather than dropped: its whole job was to stop a drifted DB
    // reward from poisoning the manifest's split, and under pull there is no
    // split for any value to poison. The payout is not expressible in the
    // manifest at all.
    const manifest = approveAndReleaseManifest(
      component,
      params.account,
      ESCROW_RECEIPT_RESOURCE,
      taskId,
    )
    return await send(params.rdt, manifest)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Approval failed" }
  }
}

// ── Submit (submit_task) ────────────────────────────────────────────────────────

export interface EscrowSubmitParams {
  escrowComponent: string
  account: string
  /** Claim Receipt local id (u64) — discover via findClaimReceiptId(). */
  claimReceiptId: number
  /** On-chain task_id. */
  taskId: number
  /**
   * The worker's STORED submission content (the same row the poster reviews) —
   * committed on-chain as the evidence hash via canonicalSubmissionEvidence,
   * so the delivered work is verifiable against the DB later.
   */
  content: string
  /**
   * The task's STORED title + description + canonical terms block — the same
   * three inputs `create_task` hashed. Wave B's `submit_task` takes a
   * `brief_hash` and the blueprint asserts it equals the committed
   * `work_brief_hash` (P4-3, the keystone check's on-chain half).
   *
   * 🔑 RECOMPUTE THESE FROM THE STORED TASK. Do NOT read the committed hash off
   * the chain and pass it back: the blueprint would then be comparing the
   * chain's value against itself, the assert could never fail, and the check
   * would be decoration. Recomputing is what makes it detect a brief that has
   * drifted from what the worker agreed to — which is the entire point.
   */
  title: string
  description: string
  termsBlock?: string
  rdt: RadixDappToolkit
}

export async function sendSubmitTx(
  params: EscrowSubmitParams,
): Promise<EscrowTxResult> {
  if (!isEscrowDeployed()) return { ok: false, error: "Escrow not deployed" }
  try {
    const evidenceHash = await sha256Hex(
      canonicalSubmissionEvidence(params.content),
    )
    // Same canonicalization and the same v1/v2 selection sendDepositTx used at
    // create_task — the two MUST agree byte for byte or the on-chain assert
    // rejects an honest submission. Terms presence picks the layout, exactly as
    // it does there.
    const briefHash = await sha256Hex(
      params.termsBlock
        ? canonicalWorkBriefV2(params.title, params.description, params.termsBlock)
        : canonicalWorkBrief(params.title, params.description),
    )
    const manifest = submitTaskManifest(
      params.escrowComponent || ESCROW_COMPONENT,
      params.account,
      ESCROW_CLAIM_RECEIPT_RESOURCE,
      params.claimReceiptId,
      params.taskId,
      evidenceHash,
      briefHash,
    )
    return await send(params.rdt, manifest)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Submit failed" }
  }
}

/**
 * Fetch the caller's latest DB submission content for a task (auth required —
 * call ensureSession first). The on-chain submit commits to this STORED row —
 * the same content the poster reviews — rather than any client-held form
 * value, so the chain binds exactly what was delivered. Returns
 * `noSubmission: true` when the worker has not posted a submission yet
 * (the submissions GET 403s for non-submitters, which for the worker means
 * exactly that) — callers must fail closed and direct them to the submit form.
 */
export async function fetchOwnSubmissionContent(
  taskDbId: number | string,
  account: string,
): Promise<{ ok: boolean; content?: string; noSubmission?: boolean; error?: string }> {
  try {
    const res = await apiFetch(`/api/v1/tasks/${taskDbId}/submissions`)
    if (res.status === 403) return { ok: false, noSubmission: true }
    const json = await res.json().catch(() => ({}))
    if (!res.ok || !json?.ok || !Array.isArray(json.data)) {
      return { ok: false, error: json?.error?.message || "Failed to load submissions" }
    }
    // Latest own row by id (identity column — monotonic). Addresses ARE the
    // user ids in this app, so submitterId compares against the account.
    const own = (json.data as { id: number; submitterId: string; content: string }[])
      .filter((s) => s.submitterId === account)
      .sort((a, b) => b.id - a.id)[0]
    if (!own) return { ok: false, noSubmission: true }
    return { ok: true, content: own.content }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to load submissions" }
  }
}

// ── Cancel (cancel_task / cancel_task_by_poster_after_claim) ───────────────────

export interface EscrowCancelParams {
  escrowComponent?: string
  /** The poster's account — only the Task Receipt holder can cancel. */
  account: string
  /** On-chain task_id (= the Task Receipt local id presented + burned). */
  taskId: number
  /**
   * Which blueprint path to take, from the task's current status:
   *   "open"    → cancel_task (unclaimed; reward + insurance back to poster)
   *   "claimed" → cancel_task_by_poster_after_claim (claimed, not yet
   *               submitted; reward + insurance back to poster, and the
   *               worker's claim bond back to the worker)
   */
  phase: "open" | "claimed"
  /**
   * PUSH era only: worker account, required on the "claimed" phase — the
   * legacy manifest routes the bond leg itself. Under PULL the blueprint
   * credits the bond to the worker's entitlement (payee pinned at claim), so
   * this is ignored.
   */
  workerAccount?: string | null
  rdt: RadixDappToolkit
}

export async function sendCancelTx(
  params: EscrowCancelParams,
): Promise<EscrowTxResult> {
  if (!isEscrowDeployed()) return { ok: false, error: "Escrow not deployed" }
  try {
    const component = params.escrowComponent || ESCROW_COMPONENT
    let manifest: string
    // Both phases are proof + one call; the blueprint credits the poster's refund
    // (and, after-claim, the worker's bond) as entitlements, collected via
    // withdraw_poster / withdraw_worker. No routing legs exist for this side to
    // get wrong — which is why the deleted push branch needed params.workerAccount
    // to hand the claim bond back and this one does not.
    manifest =
      params.phase === "open"
        ? cancelTaskManifest(component, params.account, ESCROW_RECEIPT_RESOURCE, params.taskId)
        : cancelTaskAfterClaimManifest(
            component,
            params.account,
            ESCROW_RECEIPT_RESOURCE,
            params.taskId,
          )
    return await send(params.rdt, manifest)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Cancel failed" }
  }
}

// ── Raise Dispute (raise_dispute) ──────────────────────────────────────────────

export interface EscrowRaiseDisputeParams {
  escrowComponent?: string
  account: string
  /** On-chain task_id. */
  taskId: number
  /**
   * The dispute proof the caller holds: the poster presents their Task Receipt
   * (ESCROW_RECEIPT_RESOURCE, local id = the on-chain task_id); the worker
   * presents the Guild member badge they claimed with (BADGE_NFT, local id = the
   * badge id). The blueprint authorises the dispute off this proof.
   */
  proofResource: string
  proofLocalId: string
  /** Optional free-text evidence reference; hashed to the 32-byte commitment. */
  evidence?: string
  rdt: RadixDappToolkit
}

export async function sendRaiseDisputeTx(
  params: EscrowRaiseDisputeParams,
): Promise<EscrowTxResult> {
  if (!isEscrowDeployed()) return { ok: false, error: "Escrow not deployed" }
  try {
    const evidenceHash = params.evidence ? await sha256Hex(params.evidence) : null
    const manifest = raiseDisputeManifest(
      params.escrowComponent || ESCROW_COMPONENT,
      params.account,
      params.proofResource,
      params.proofLocalId,
      params.taskId,
      evidenceHash,
    )
    return await send(params.rdt, manifest)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Dispute failed" }
  }
}

// ── Finalize Dispute (auto_resolve_dispute) ────────────────────────────────────

/** One row of the task's escrow ledger, as served by GET /api/v1/escrow/[taskId]. */
export interface EscrowLedgerRow {
  txType: "fund" | "release" | "refund" | "dispute"
  txHash: string | null
  amountXrd: string
  status: "pending" | "confirmed" | "failed"
}

/**
 * Fetch the task's escrow ledger rows (auth required — call ensureSession
 * first). The finalize flow needs the `fund` row's txHash (TaskCreatedEvent →
 * exact reward + insurance) and the `dispute` row's txHash (DisputeRaisedEvent
 * → who raised it).
 */
export async function fetchEscrowRows(
  taskDbId: number | string,
): Promise<{ ok: boolean; rows?: EscrowLedgerRow[]; error?: string }> {
  try {
    const res = await apiFetch(`/api/v1/escrow/${taskDbId}`)
    const json = await res.json().catch(() => ({}))
    if (!res.ok || !json?.ok || !Array.isArray(json.data)) {
      return { ok: false, error: json?.error?.message || "Failed to load escrow ledger" }
    }
    return { ok: true, rows: json.data as EscrowLedgerRow[] }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to load escrow ledger" }
  }
}

export interface EscrowAutoResolveParams {
  escrowComponent?: string
  /** On-chain task_id. */
  taskId: number
  rdt: RadixDappToolkit
}

/**
 * Public, time-gated keeper call: settle a Disputed task after the auto-resolve
 * window — PULL ONLY. `auto_resolve_dispute` returns `()`: the component
 * applies the default ruling pinned when the dispute was raised and credits both
 * entitlements internally, so the manifest is a single bare call. No party
 * accounts, no amounts, no chain pre-reads: there is nothing the caller could route, so
 * there is nothing to verify before routing. (The push era needed all of that
 * — TaskCreatedEvent amounts, the raiser, the component's default — because
 * the caller routed both buckets and routing that disagreed with the default
 * paid the wrong party; that was H1. Pull deletes the routing, and the H1
 * class with it.) A too-early call fails on-chain on the window assert.
 *
 * PUSH-era refusal: against the live push component this method returns both
 * settlement buckets to the caller, and no push builder exists any more —
 * disputes there are fused off (GUILD_ALLOW_LIVE_DISPUTE) with the dispute UI
 * compiled out, so this path must simply never run before the cutover. Fail
 * closed rather than build a manifest for the wrong era.
 */
export async function sendAutoResolveTx(
  params: EscrowAutoResolveParams,
): Promise<EscrowTxResult> {
  if (!isEscrowDeployed()) return { ok: false, error: "Escrow not deployed" }
  try {
    const component = params.escrowComponent || ESCROW_COMPONENT
    const manifest = autoResolveDisputeManifest(component, params.taskId)
    return await send(params.rdt, manifest)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Auto-resolve failed" }
  }
}

// ── Release after review timeout (release_after_review_timeout, Wave B) ──────

export interface EscrowReleaseAfterReviewTimeoutParams {
  escrowComponent?: string
  /** On-chain task_id. */
  taskId: number
  rdt: RadixDappToolkit
}

// ── Push entitlement (push_entitlement) — permissionless delivery ────────────

export type EscrowPushParams = {
  escrowComponent?: string
  taskId: number
  party: "worker" | "poster"
  rdt: RadixDappToolkit
}

/**
 * Public, time-gated keeper call: finalize a Submitted task once its review
 * window has lapsed. `release_after_review_timeout` returns `()` — same PULL
 * shape as sendAutoResolveTx above: the component credits both entitlements
 * internally (reward + held bond to the worker, insurance to the poster,
 * exactly what approve would have credited), so the manifest is a single bare
 * call with no accounts, no amounts, and nothing for the caller to route. A
 * too-early call fails on-chain on the review_deadline assert.
 */
export async function sendReleaseAfterReviewTimeoutTx(
  params: EscrowReleaseAfterReviewTimeoutParams,
): Promise<EscrowTxResult> {
  if (!isEscrowDeployed()) return { ok: false, error: "Escrow not deployed" }
  try {
    const component = params.escrowComponent || ESCROW_COMPONENT
    const manifest = releaseAfterReviewTimeoutManifest(component, params.taskId)
    return await send(params.rdt, manifest)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Release failed" }
  }
}

/**
 * Deliver a settled entitlement to its PINNED account, on anyone's call.
 *
 * The remedy for a payee who cannot or does not collect — a lost badge or
 * receipt (both are permanently transferable bearer instruments), or simply not
 * noticing the Collect step, which has already happened once on mainnet.
 *
 * No Proof, and no destination argument: the blueprint reads the pin from its
 * own state, so the caller cannot redirect. Paying the network fee to pay
 * someone else is the whole of what a hostile caller achieves.
 *
 * ✅ Deployed: `push_entitlement` is in the live Wave B blueprint (Gateway-read
 * 2026-09-16). Like the withdraw paths, it aborts if the pinned account rejects
 * the deposit.
 */
export async function sendPushEntitlementTx(
  params: EscrowPushParams,
): Promise<EscrowTxResult> {
  if (!isEscrowDeployed()) return { ok: false, error: "Escrow not deployed" }
  try {
    const manifest = pushEntitlementManifest(
      params.escrowComponent || ESCROW_COMPONENT,
      params.taskId,
      params.party,
    )
    return await send(params.rdt, manifest)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Push failed" }
  }
}

// ── Withdraw (withdraw_worker / withdraw_poster) — PULL collection, §5c ────────

export type EscrowWithdrawParams = {
  escrowComponent?: string
  /** The connected account — creates the proof AND is the pinned payee. */
  account: string
  /** On-chain task_id. */
  taskId: number
  rdt: RadixDappToolkit
} & (
  | {
      party: "worker"
      /** Chain-sourced: member or agent badge, per TaskInfo.claimer_is_agent. */
      badgeResource: string
      /** Chain-sourced: TaskInfo.claimer_badge_id, the id the blueprint matches. */
      badgeLocalId: string
    }
  | { party: "poster"; receiptResource: string }
)

/**
 * Collect a settled entitlement (PULL). Both lanes — reward and bond — move in
 * this one call: the blueprint's `deposit_both_lanes` takes each, skips an
 * empty one, and reverts before touching any account if both are empty.
 *
 * ⚠️ There is no amount parameter, and that is the point. The blueprint reads
 * the entitlement from its own state and deposits into the payee pin captured
 * at create_task / claim_task, so nothing this client passes can change who is
 * paid or how much. Unlike sendApproveTx — which routes a manifest-split payout
 * and therefore re-reads the exact reward from chain first — there is no amount
 * here to verify, so there is no chain re-read to do.
 *
 * The caller must have decided the party and proof with
 * resolveWithdrawAffordance (escrow-withdraw.ts), which sources both from the
 * live TaskInfo rather than from DB columns.
 */
export async function sendWithdrawTx(
  params: EscrowWithdrawParams,
): Promise<EscrowTxResult> {
  if (!isEscrowDeployed()) return { ok: false, error: "Escrow not deployed" }
  try {
    const component = params.escrowComponent || ESCROW_COMPONENT
    const manifest =
      params.party === "worker"
        ? withdrawWorkerManifest(
            component,
            params.account,
            params.badgeResource,
            params.badgeLocalId,
            params.taskId,
          )
        : withdrawPosterManifest(
            component,
            params.account,
            params.receiptResource,
            params.taskId,
          )
    return await send(params.rdt, manifest)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Collection failed" }
  }
}

// ── Expire Claim (expire_claim) — PUBLIC, time-gated, ANY signed-in caller ────

export interface EscrowExpireClaimParams {
  escrowComponent?: string
  /** The connected account — also the CALLER who receives the forfeited-bond bounty. */
  account: string
  /** On-chain task_id. */
  taskId: number
  rdt: RadixDappToolkit
}

/**
 * Public, time-gated cleanup call: forfeit an overdue claim. Once a claim's
 * submit deadline plus its grace (`expire_grace_secs`) passes, while the task is
 * still unsubmitted, `expire_claim` is callable by ANYONE — not just the
 * poster or worker (operator ruling 2026-08-29, docs/PROJECT-STATE.md). It
 * resets the task to Open (assignee cleared) and splits the forfeited claim
 * bond: a bounty of `expire_bounty_pct` of the bond (0.1 live), rounded down,
 * to the caller, the remainder to the operator vault, never a poster credit
 * (DB-4). The manifest deposits that returned bucket straight into the
 * caller's own account — see expireClaimManifest.
 *
 * ⚠️ This had NO product surface until 2026-08-29 — `expireClaimManifest` was
 * reachable only from scripts, so the one lifecycle recovery the blueprint made
 * permissionless was, in practice, available to nobody. A stranger who would
 * have collected the bounty needed a CLI.
 *
 * Note what this does NOT do: `expire_claim` REOPENS the task to `Open` rather
 * than terminating it. The poster still needs `cancel_task` + `withdraw_poster`
 * to get their money back afterwards — see the SoT's Probe A accounting.
 */
export async function sendExpireClaimTx(
  params: EscrowExpireClaimParams,
): Promise<EscrowTxResult> {
  if (!isEscrowDeployed()) return { ok: false, error: "Escrow not deployed" }
  try {
    const component = params.escrowComponent || ESCROW_COMPONENT
    const manifest = expireClaimManifest(component, params.account, params.taskId)
    return await send(params.rdt, manifest)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Expire claim failed" }
  }
}

// ── Confirm (sync the DB to on-chain state via the escrow-confirm endpoint) ──────

export async function confirmEscrowTx(
  taskDbId: number | string,
  kind: "create" | "claim" | "submit" | "approve" | "dispute" | "resolve" | "cancel",
  intentHash: string,
): Promise<{ ok: boolean; onChainTaskId?: number; error?: string }> {
  // The Gateway can't see the tx's events until it commits (~5-10s after the
  // wallet submits), so a 422 (event-not-found) is retried before giving up.
  const ATTEMPTS = 4
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const res = await apiFetch(`/api/v1/tasks/${taskDbId}/escrow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intentHash, kind }),
      })
      const json = await res.json().catch(() => ({}))
      if (res.ok && json?.ok) {
        return { ok: true, onChainTaskId: json.data?.onChainTaskId ?? undefined }
      }
      if (res.status === 422 && i < ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 4000))
        continue
      }
      return { ok: false, error: json?.error?.message || "Confirmation failed" }
    } catch (e) {
      if (i < ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 4000))
        continue
      }
      return { ok: false, error: e instanceof Error ? e.message : "Confirmation failed" }
    }
  }
  return { ok: false, error: "Confirmation timed out" }
}

// ── Dispute evidence (off-chain half of the commitment) ───────────────────────

/**
 * Store the raiser's written statement against a task already showing
 * `disputed`. The on-chain commitment to this text went out with the dispute
 * transaction; this call saves the preimage so the commitment can be OPENED —
 * by the other party, by an arbiter, or by anyone auditing the ledger.
 *
 * Returns a result rather than throwing because the CALLER'S failure handling
 * is the important part: by the time this runs the dispute is irreversible, so
 * a failure here is a warning about a lost statement, never a failed dispute.
 */
export async function fileDisputeEvidence(
  taskDbId: number | string,
  evidence: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`/api/v1/tasks/${taskDbId}/dispute-evidence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ evidence }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error?.message || `HTTP ${res.status}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" }
  }
}
