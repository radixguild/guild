"use client"

import { settlementCopy } from "@/lib/settlement-copy";
import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { GetXrdLinks } from "@/components/get-xrd-links"
import { useWallet } from "@/hooks/useWallet"
import type { SessionFailure } from "@/lib/session-outcome"
import { useEscrowPostingFrozen } from "@/hooks/useEscrowPostingFrozen"
import {
  PostingPausedNotice,
  POSTING_PAUSED_FUND_DETAIL,
} from "@/components/tasks/posting-paused-notice"
import {
  isEscrowDeployed,
  BADGE_NFT,
  AGENT_BADGE_NFT,
  ESCROW_COMPONENT,
  ESCROW_RECEIPT_RESOURCE,
  ESCROW_CLAIM_RECEIPT_RESOURCE,
  ESCROW_CLAIM_BOND_XRD,
  ESCROW_EXPIRE_BOUNTY_PCT,
  ESCROW_EXPIRE_GRACE_SECS,
  ESCROW_HUMAN_SUBMIT_DEADLINE_SECS,
} from "@/lib/config"
import { isEnabled } from "@/lib/features"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  sendDepositTx,
  sendClaimTx,
  sendSubmitTx,
  sendApproveTx,
  sendCancelTx,
  sendRaiseDisputeTx,
  sendAutoResolveTx,
  sendReleaseAfterReviewTimeoutTx,
  sendExpireClaimTx,
  sendPushEntitlementTx,
  sendWithdrawTx,
  fetchEscrowRows,
  fetchOwnSubmissionContent,
  confirmEscrowTx,
  humanizeTxError,
  resyncEscrowTask,
  fileDisputeEvidence,
  type EscrowTxResult,
} from "@/lib/escrow-utils"
import {
  loadUserBadge,
  findClaimReceiptId,
  readEscrowTaskState,
  outstandingForParty,
  type PartyOutstanding,
} from "@/lib/gateway"
import { AUTO_RESOLVE_DEFAULT } from "@/lib/dispute-outcome"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  DISPUTE_EVIDENCE_MAX_CHARS,
  disputeEvidencePreimage,
  normalizeDisputeEvidence,
} from "@/lib/dispute-evidence"
import { LoadFailed } from "@/components/ui/load-failed"
import { useOnChainTaskInfo } from "@/hooks/useOnChainTaskInfo"
import { useClaimBond } from "@/hooks/useClaimBond"
import { useXrdBalance } from "@/hooks/useXrdBalance"
import {
  resolveWithdrawAffordance,
  explainWithdrawBlocker,
  outstandingLanes,
} from "@/lib/escrow-withdraw"
import { apiFetch } from "@/lib/api-fetch"
import { meetsMinTier, TRUST_TIER_LABELS, type TrustTier } from "@/lib/trust"
import { cancelAfterClaimRate, type PosterCancelStats } from "@/lib/poster-cancel-stats"
import { formatAddress } from "@/lib/marketplace-utils"
import { formatUsdAmount, formatXrdAmount, formatXrdUsd } from "@/lib/format-xrd-usd"
import { useXrdUsd } from "@/lib/use-xrd-usd"
import { INSURANCE_RATE, DEFAULT_DISPUTE_WINDOW_HOURS, FEE_HEADROOM_XRD } from "@/lib/marketplace"
import { formatRemaining } from "@/lib/countdown"
import {
  Shield,
  CheckCircle,
  Lock,
  ArrowRight,
  Send,
  AlertTriangle,
  Gavel,
  Ban,
  RefreshCw,
  Wallet,
  Clock,
} from "lucide-react"

// Synchronous re-entry guard for tx handlers (E3). `disabled={loading}` alone
// leaves a batching window: a second click can fire before React commits the
// disabled prop, sending a duplicate tx (the server is idempotent, so the cost
// is wasted chain reads + a confusing "already settled" error, not corruption).
// A ref flips SYNCHRONOUSLY on the first call, so the second returns at once;
// it clears in `finally` when the handler settles.
//
// 2026-10-06 (the money-buttons lane): the guard also owns the two things
// every handler used to get wrong on its own. `reset` runs before the press
// (clears the previous press's sentence), and `onThrow` catches a handler that
// throws anywhere after setLoading(true) — before this, such a throw died
// unhandled with the button disabled and no text (ensureSession() could do
// exactly that from signIn's /verify fetch; so can any Gateway read).
function useTxGuard(hooks?: { reset?: () => void; onThrow?: (e: unknown) => void }) {
  const inFlight = useRef(false)
  // `hooks` is a fresh literal each render (its callbacks only call stable
  // state setters), so the guard is re-made each render too — harmless, it is
  // only ever read from a click handler.
  return useCallback(async (fn: () => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true
    hooks?.reset?.()
    try {
      await fn()
    } catch (e) {
      console.error("escrow action threw after the press", e)
      hooks?.onThrow?.(e)
    } finally {
      inFlight.current = false
    }
  }, [hooks])
}

// Shared success alert (with a dashboard tx link).
function TxSuccess({ label, txId }: { label: string; txId: string }) {
  return (
    <Alert>
      <CheckCircle className="h-4 w-4" />
      <AlertDescription>
        {label}{" "}
        <a
          href={`https://dashboard.radixdlt.com/transaction/${txId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline"
        >
          View transaction
        </a>
      </AlertDescription>
    </Alert>
  )
}

// Shared error line (smoke finding 4): one short human summary, the raw
// payload tucked behind a collapsed expando — never full-width JSON.
//
// `summary` overrides the humanized line, for a sentence the caller wrote
// itself: humanizeTxError folds anything over 160 characters into "Transaction
// failed — open the error details below.", which would hide exactly the
// explanation the caller is trying to show. `error` then becomes the detail.
function TxError({ error, summary: fixedSummary }: { error: string; summary?: string }) {
  if (!error && !fixedSummary) return null
  const { summary, detail } = fixedSummary
    ? { summary: fixedSummary, detail: error || undefined }
    : humanizeTxError(error)
  return (
    <div className="space-y-1 text-xs" role="alert">
      <p className="text-destructive">{summary}</p>
      {detail && (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer select-none">Error details</summary>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[10px]">
            {detail}
          </pre>
        </details>
      )}
    </div>
  )
}

// Hard-block shown IN PLACE of a tx button while the signed-in session's
// account is not among the accounts the wallet shares (smoke finding 1 — the
// root cause of every incident in the mainnet smoke: a tx sent by one account
// must never be confirmed under another's session). ANY shared account is a
// legitimate session — the provider normally self-heals by dropping a session
// whose account stops being shared; this persists only when the sign-in proof
// was given for an account the wallet doesn't share at all.
function SessionMismatchAlert() {
  const { account, user, signOut, signIn } = useWallet()
  const [busy, setBusy] = useState(false)
  return (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription className="space-y-2 text-xs">
        <p>
          Your connected wallet ({formatAddress(account ?? "")}) is not the account you signed in
          with ({formatAddress(user?.id ?? "")}). On-chain actions are blocked until they match.
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            await signOut()
            await signIn() // pick one of the SHARED accounts in the wallet prompt
            setBusy(false)
          }}
        >
          Sign in with the connected wallet
        </Button>
      </AlertDescription>
    </Alert>
  )
}

// ── Deposit (create_task) — /tasks/create after the task is saved, and the
//    unfunded-task detail view ("Skip for now — fund later" recovery path) ────

// ── Never silent (2026-10-03 task 70; every button since 2026-10-06) ──────────
//
// Every button here hands a transaction to rdt.walletApi.sendTransaction
// through one gate, ensureSessionDetailed(), after its own pre-flights. Three
// things used to leave a press mute: the gate answered a bare false (and could
// throw), a wallet that never answered left the spinner on for good, and a
// handler that threw anywhere after setLoading(true) died with the button
// disabled and no text. Each has one shared answer below and every button uses
// all three — escrow-money-buttons-never-silent.test.tsx presses each one.

/**
 * A handler threw somewhere after the press. The page cannot know whether the
 * wallet had already been asked, so it says both halves and keeps the thrown
 * text under Error details.
 */
export const TX_BACKSTOP =
  "This page hit an error and stopped. If your wallet showed a transaction and you approved it, refresh this page to see where it stands; if the wallet showed nothing, nothing was sent. The error is under Error details."

/** Each button's own certain fact when sign-in does not complete: what was NOT sent. */
export const SIGN_IN_LEAD = {
  fund: "Sign-in didn't complete, so no funding transaction was sent to your wallet.",
  link: "Sign-in didn't complete, so your funding is not linked to this task yet.",
  claim: "Sign-in didn't complete, so no claim transaction was sent to your wallet.",
  submit: "Sign-in didn't complete, so no submit transaction was sent to your wallet.",
  approve: "Sign-in didn't complete, so no approval transaction was sent to your wallet.",
  release: "Sign-in didn't complete, so no release transaction was sent to your wallet.",
  cancel: "Sign-in didn't complete, so no cancel transaction was sent to your wallet.",
  dispute: "Sign-in didn't complete, so no dispute transaction was sent to your wallet.",
  finalize: "Sign-in didn't complete, so no settlement transaction was sent to your wallet.",
  withdraw: "Sign-in didn't complete, so no collection transaction was sent to your wallet.",
  resync: "Sign-in didn't complete, so nothing was re-synced.",
  expire: "Sign-in didn't complete, so no expire-claim transaction was sent to your wallet.",
} as const

/** The last sentence of each button's wait hint: what is not done until the wallet approves. */
export const WAIT_CLOSING = {
  fund: "Nothing is funded until you approve it in the wallet.",
  link: "Nothing is linked until you approve the sign-in in the wallet.",
  claim: "Nothing is claimed until you approve it in the wallet.",
  submit: "Nothing is submitted until you approve it in the wallet.",
  approve: "Nothing is released until you approve it in the wallet.",
  release: "Nothing is released until you approve it in the wallet.",
  cancel: "Nothing is cancelled until you approve it in the wallet.",
  dispute: "No dispute is raised until you approve it in the wallet.",
  finalize: "Nothing is settled until you approve it in the wallet.",
  withdraw: "Nothing is collected until you approve it in the wallet.",
  push: "Nothing is delivered until you approve it in the wallet.",
  resync: "Nothing is re-synced until you approve the sign-in in the wallet.",
  expire: "Nothing expires until you approve it in the wallet.",
} as const

/**
 * Sign-in did not complete, so the button's transaction was never sent. `lead`
 * is the button's own certain fact (SIGN_IN_LEAD); `failure` adds the cause and
 * the fix the gate reported (session-outcome.ts). Without one — the gate itself
 * could not be reached — the generic check stands, because the one silent case
 * left is a request that never got through.
 */
export function signInIncomplete(lead: string, failure?: SessionFailure): string {
  return failure
    ? `${lead} ${failure.message}`
    : `${lead} If your wallet never showed a sign-in request, the request didn't get through: reload the page, or disconnect and reconnect with the Connect button at the top, then try again.`
}

/**
 * The sign-in the gate just ran was proven with a DIFFERENT shared account than
 * the one this button was rendered for (GM-6, 2026-10-06). The wallet lets the
 * person sign the proof with any shared account, and the session — and the
 * page's `account` — follow it, but the running handler still holds the
 * account it was pressed under. Sending would withdraw from and name that
 * account, then confirm under the other one's session: a create the server
 * refuses (not the creator), a claim it cannot attribute. Stop before the
 * wallet is asked for anything.
 */
export function accountSwitchedSentence(signedInAs: string, pressedAs: string): string {
  return `You signed in as ${formatAddress(signedInAs)}, but this button was for ${formatAddress(pressedAs)}, so no transaction was sent to your wallet. The page now follows the account you signed in with: check it is the one you meant, then press again.`
}

function switchedAccount(gate: { userId?: string }, pressedAs: string | null): string | null {
  return gate.userId && pressedAs && gate.userId !== pressedAs
    ? accountSwitchedSentence(gate.userId, pressedAs)
    : null
}

/**
 * Under a still-spinning button once the wallet has gone WALLET_WAIT_HINT_MS
 * without answering. Before it, a request the toolkit could not deliver left
 * "…ing" on screen indefinitely, with nothing to check and the button disabled.
 * Every action here needs the person's signature, so `closing` (WAIT_CLOSING)
 * holds however long the wait.
 */
export function walletWaitHint(closing: string): string {
  return `Still waiting for your Radix Wallet. If the wallet isn't showing a request, it hasn't received this one: cancel the pending request from the Connect button at the top of the page (or reload), reconnect, and try again. ${closing}`
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ── A committed create whose confirm did not land (GM-2, 2026-10-06) ──────────
//
// create_task commits the reward + insurance BEFORE the confirm links the
// on-chain task to this row. When that confirm failed (a Gateway lag past its
// retries, a server error, a network drop), the row still read unfunded, so a
// refresh offered Fund Escrow again — and a second press locked the reward a
// second time, leaving the first escrow with no row the site could show. The
// committed intent hash is now kept (this browser, keyed by task) the moment
// the wallet returns it, and while it is kept the button offers to finish
// linking THAT transaction instead of funding again.

const pendingCreateKey = (taskId: string) => `guild:escrow:pending-create:${taskId}`

/** The kept intent hash for this task, or null. Never throws (storage may be blocked). */
export function readPendingCreate(taskId: string): string | null {
  try {
    const v = window.localStorage.getItem(pendingCreateKey(taskId))
    return v && /^txid_[a-z0-9_]+$/.test(v) ? v : null
  } catch {
    return null
  }
}

// A tiny external store over that key, so the button reads it with
// useSyncExternalStore (hydration-safe: the server snapshot is null) and
// re-renders on a write here or in another tab.
const pendingCreateListeners = new Set<() => void>()
function subscribePendingCreate(onChange: () => void): () => void {
  pendingCreateListeners.add(onChange)
  window.addEventListener("storage", onChange)
  return () => {
    pendingCreateListeners.delete(onChange)
    window.removeEventListener("storage", onChange)
  }
}
function notifyPendingCreate() {
  for (const onChange of pendingCreateListeners) onChange()
}

function writePendingCreate(taskId: string, txId: string) {
  try {
    window.localStorage.setItem(pendingCreateKey(taskId), txId)
  } catch {
    // Blocked storage: the button's in-memory copy still covers this page view.
  }
  notifyPendingCreate()
}

function clearPendingCreate(taskId: string) {
  try {
    window.localStorage.removeItem(pendingCreateKey(taskId))
  } catch {
    // Nothing to clear.
  }
  notifyPendingCreate()
}

/** Shown when the funding committed but linking it to the task did not. */
export const FUND_NOT_LINKED =
  "Your funding transaction went through, but this page could not link it to the task yet, so the task does not show as funded. Don't fund it again: press Finish linking your funding to retry with the same transaction."

/** The confirm refused for a reason a retry will not change (a deterministic 409). */
const FUND_LINK_REFUSED_CODES = new Set([
  "FUNDED_REWARD_MISMATCH",
  "CREATE_POSTER_MISMATCH",
  "WORK_BRIEF_MISMATCH",
  "CONFLICT",
])

export function EscrowDepositButton({
  taskId,
  posterId,
  rewardXrd,
  title,
  description,
  termsBlock,
  onSuccess,
}: {
  taskId: string
  /** When set (task detail page), only the poster sees the fund affordance.
      Absent on /tasks/create, where the viewer is the creator by construction. */
  posterId?: string
  rewardXrd: number
  /** The created task's STORED title + description — committed on-chain as the work-brief hash. */
  title: string
  description: string
  /** Canonical terms block from the STORED terms row — non-empty commits the v2 brief. */
  termsBlock?: string
  onSuccess?: (txId: string) => void
}) {
  const { account, rdt, ensureSessionDetailed, sessionMismatch } = useWallet()
  const { rate: usdRate } = useXrdUsd()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [txId, setTxId] = useState("")
  const [summary, setSummary] = useState<string | undefined>(undefined)
  const walletWait = useWalletWaitHint()
  const runGuarded = useTxGuard({
    reset: () => setSummary(undefined),
    onThrow: (e) => {
      setSummary(TX_BACKSTOP)
      setError(errText(e))
      setLoading(false)
    },
  })
  const postingFrozen = useEscrowPostingFrozen()
  // P4-04 pre-flight: this file had ZERO balance checks anywhere, so a poster
  // short on XRD discovered it only after the wallet attempted (and reverted)
  // the transaction. Hook called unconditionally, ahead of every early return
  // below, same as the other hooks here (rules of hooks) — it degrades to
  // `checked: false` on its own when `account` is null.
  const { balance: xrdBalance, checked: balanceChecked, recheck: recheckXrdBalance } = useXrdBalance(account)
  // The committed-but-unlinked create for this task: the copy this browser
  // kept (storage is client-only, so the server snapshot is null), or the
  // in-memory one from this page view when storage is blocked.
  const storedPendingTx = useSyncExternalStore(
    subscribePendingCreate,
    () => readPendingCreate(taskId),
    () => null,
  )
  const [memPendingTx, setPendingTx] = useState<string | null>(null)
  const pendingTx = memPendingTx ?? storedPendingTx

  if (!isEscrowDeployed()) return null
  // W3 freeze: while XRD is frozen on the escrow, create_task reverts for
  // everyone — render the honest pause instead of a fund affordance that can
  // only fail in the wallet. Shown to every viewer of this region (it also
  // explains WHY an unfunded task is stuck). `null` (unknown/loading) falls
  // through — fail open; the on-chain assert stays the backstop.
  if (postingFrozen === true)
    return (
      <div className="space-y-2">
        <PostingPausedNotice detail={POSTING_PAUSED_FUND_DETAIL} />
        <Button disabled className="w-full">
          <Lock className="mr-2 h-4 w-4" />
          Funding paused
        </Button>
      </div>
    )
  // Disconnected: say what's missing instead of silently rendering nothing
  // (frontend audit — the vanishing fund button read as "funding is broken").
  if (!account || !rdt)
    return (
      <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
        <Lock className="mr-1 inline h-3 w-3" />
        {posterId
          ? "The task poster can connect their wallet to fund this escrow."
          : "Connect your wallet to fund the escrow."}
      </div>
    )
  // A press that stopped on an account switch keeps its sentence on screen
  // even though the switch now hides this poster-only button.
  if (posterId && account !== posterId) return summary ? <TxError error="" summary={summary} /> : null
  if (sessionMismatch) return <SessionMismatchAlert />

  // Sized against the EXACT amount sendDepositTx will lock: reward plus
  // Math.ceil(reward * INSURANCE_RATE) insurance (lib/escrow-utils.ts) — the
  // same rounding, so this never warns on a number the tx wouldn't actually
  // need (or worse, passes a check the tx then fails on a rounding gap).
  //
  // ⚠️ Only a CONFIRMED reading gates the button: `balanceChecked &&
  // xrdBalance !== null`. A Gateway miss resolves xrdBalance to null and
  // insufficientXrd stays false — FAILS OPEN, deliberately, mirroring the
  // mint page's noXrd/lowXrd split (src/app/mint/page.tsx). A balance we
  // could not read must never block a poster who actually has the funds;
  // failing closed here would be a worse bug than the one this fixes.
  const insuranceXrd = Math.ceil(rewardXrd * INSURANCE_RATE)
  const requiredXrd = rewardXrd + insuranceXrd
  const insufficientXrd =
    balanceChecked && xrdBalance !== null && xrdBalance < requiredXrd

  // ── The SOFT tier: fee headroom ─────────────────────────────────────────────
  // The hard block above covers reward + insurance and NOTHING ELSE, but the
  // transaction's own network fee is locked from the SAME XRD balance. So a
  // poster holding exactly requiredXrd passed the check above, reached the
  // wallet's sign prompt, and watched the tx fail on the fee lock — the very
  // outcome the pre-flight exists to prevent.
  //
  // Ported from the mint page's two-tier split (src/app/mint/page.tsx), which
  // both this check and the claim check below cite as their reference but
  // originally carried only half of: noXrd hard-blocks, lowXrd WARNS without
  // disabling. This is the lowXrd half, measured as headroom ABOVE requiredXrd
  // rather than as an absolute balance, because here the tx locks a reward too.
  //
  // ⚠️ NOT a hard block, deliberately. FEE_HEADROOM_XRD is a generous hint, not
  // a fee estimate (real fees run well under 1 XRD), so a balance under it may
  // be perfectly sufficient. Disabling Fund on a hint would block posters who
  // can actually pay — the fail-closed direction this pre-flight's contract
  // forbids (useXrdBalance.ts), and a worse bug than the one it fixes.
  //
  // `!insufficientXrd` keeps the two tiers mutually exclusive, so the hard
  // block never renders alongside a softer warning about the same balance. It
  // also carries the confirmed-reading guard, but the explicit `balanceChecked
  // && xrdBalance !== null` stays because `!insufficientXrd` is ALSO true for
  // an unread balance — without them, `null - requiredXrd` is a negative
  // number and every unknown balance would warn.
  const lowFeeHeadroom =
    balanceChecked &&
    xrdBalance !== null &&
    !insufficientXrd &&
    xrdBalance - requiredXrd < FEE_HEADROOM_XRD

  async function handleDeposit() {
    setLoading(true)
    setError("")
    // Session is needed for the post-tx confirm (POST /tasks/[id]/escrow is
    // withAuth). Establish it BEFORE the on-chain tx so we don't spend gas on a
    // tx the DB can't then confirm. No-op if already signed in.
    const gate = await walletWait.during(ensureSessionDetailed())
    if (!gate.ok) {
      setSummary(signInIncomplete(SIGN_IN_LEAD.fund, gate))
      setError(gate.detail ?? "")
      setLoading(false)
      return
    }
    const switched = switchedAccount(gate, account)
    if (switched) {
      setSummary(switched)
      setLoading(false)
      return
    }
    const result = await walletWait.during(sendDepositTx({ rewardXrd, title, description, termsBlock, account: account!, rdt: rdt! }))
    if (!result.ok) {
      setError(result.error ?? "Deposit failed")
      setLoading(false)
      return
    }
    // Committed: keep the intent hash BEFORE the confirm, so a failed confirm
    // (or a closed tab) can never bring Fund Escrow back for a second lock.
    writePendingCreate(taskId, result.txId!)
    setPendingTx(result.txId!)
    // Capture the blueprint-assigned on-chain task_id (retries past commit lag).
    await linkFunding(result.txId!)
  }

  // Link a committed create to this row — the deposit's own follow-up, and the
  // "Finish linking your funding" button's whole job (no transaction is sent).
  async function linkFunding(intentHash: string) {
    const confirm = await confirmEscrowTx(taskId, "create", intentHash)
    if (!confirm.ok) {
      setSummary(
        confirm.code && FUND_LINK_REFUSED_CODES.has(confirm.code)
          ? `This page cannot link that funding transaction to this task: ${confirm.error}`
          : FUND_NOT_LINKED,
      )
      setError(confirm.error ?? "")
      setLoading(false)
      return
    }
    clearPendingCreate(taskId)
    setPendingTx(null)
    setTxId(intentHash)
    onSuccess?.(intentHash)
    setLoading(false)
  }

  async function handleFinishLinking() {
    if (!pendingTx) return
    setLoading(true)
    setError("")
    // The confirm route is withAuth; this sends no transaction.
    const gate = await walletWait.during(ensureSessionDetailed())
    if (!gate.ok) {
      setSummary(signInIncomplete(SIGN_IN_LEAD.link, gate))
      setError(gate.detail ?? "")
      setLoading(false)
      return
    }
    // Only the creator can link (the confirm refuses anyone else), so a
    // sign-in that switched accounts says so instead of asking the server.
    if (gate.userId && account && gate.userId !== account) {
      setSummary(
        `You signed in as ${formatAddress(gate.userId)}, but this page was showing ${formatAddress(account)} when you pressed, so nothing was linked. Only the task's poster can link its funding: sign in with that account and press Finish linking your funding again.`,
      )
      setLoading(false)
      return
    }
    await linkFunding(pendingTx)
  }

  if (txId) return <TxSuccess label="Escrow funded." txId={txId} />

  if (pendingTx)
    return (
      <div className="space-y-3">
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="space-y-1 text-xs">
            <p className="font-medium text-foreground">You already sent a funding transaction for this task.</p>
            <p>
              It is not linked to the task yet, so the task does not show as funded. Finish linking it
              here — funding again would lock the reward a second time.{" "}
              <a
                href={`https://dashboard.radixdlt.com/transaction/${pendingTx}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                View the funding transaction
              </a>
            </p>
          </AlertDescription>
        </Alert>
        <Button onClick={() => runGuarded(handleFinishLinking)} disabled={loading} className="w-full">
          <RefreshCw className="mr-2 h-4 w-4" />
          {loading ? "Linking..." : "Finish linking your funding"}
        </Button>
        {loading && walletWait.slow && (
          <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
            {walletWaitHint(WAIT_CLOSING.link)}
          </p>
        )}
        <TxError error={error} summary={summary} />
        <div className="space-y-1 border-t pt-2 text-xs text-muted-foreground">
          <p>
            If that transaction failed, or you have already cancelled that on-chain task and
            withdrawn its funds, you can forget it here and fund again.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => {
              clearPendingCreate(taskId)
              setPendingTx(null)
              setSummary(undefined)
              setError("")
            }}
          >
            Forget this funding transaction
          </Button>
        </div>
      </div>
    )

  return (
    <div className="space-y-3">
      <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
        <Shield className="mr-1 inline h-3 w-3" />
        {formatXrdUsd(rewardXrd, usdRate)} reward + {formatXrdUsd(insuranceXrd, usdRate)} insurance
        will be locked in escrow. {settlementCopy("fundInsuranceNote")}{" "}
        <Link href="/money" className="font-medium underline">Exactly what leaves your wallet, and the honest limit of &ldquo;escrow.&rdquo;</Link>
      </div>
      {insufficientXrd && (
        <Alert variant="destructive">
          <AlertDescription>
            <p className="font-medium text-foreground">This account doesn&rsquo;t have enough XRD.</p>
            <p className="mt-1">
              Funding this task locks {formatXrdUsd(requiredXrd, usdRate)} — the{" "}
              {formatXrdUsd(rewardXrd, usdRate)} reward plus {formatXrdUsd(insuranceXrd, usdRate)} insurance.
              This account holds {formatXrdUsd(xrdBalance ?? 0, usdRate)}. Add XRD to this account and try again.
            </p>
            <GetXrdLinks />
            <Button variant="outline" size="sm" className="mt-2" onClick={recheckXrdBalance}>
              Re-check balance
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {lowFeeHeadroom && (
        <Alert>
          <AlertDescription>
            This account holds {formatXrdUsd(xrdBalance ?? 0, usdRate, { xrdDecimals: 4 })} — enough
            for the {formatXrdUsd(requiredXrd, usdRate)} this locks, but little more. Radix charges a
            small network fee on top, taken from the same balance — usually enough, but top up a
            little if the transaction fails.
          </AlertDescription>
        </Alert>
      )}
      <Button onClick={() => runGuarded(handleDeposit)} disabled={loading || insufficientXrd} className="w-full">
        <Lock className="mr-2 h-4 w-4" />
        {loading ? "Sending..." : "Fund Escrow"}
      </Button>
      {loading && walletWait.slow && (
        <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
          {walletWaitHint(WAIT_CLOSING.fund)}
        </p>
      )}
      <TxError error={error} summary={summary} />
    </div>
  )
}

// ── Claim (claim_task) — worker, on the task detail page ───────────────────────

export function EscrowClaimButton({
  taskDbId,
  onChainTaskId,
  posterId,
  posterCancelStats,
  onSuccess,
}: {
  taskDbId: number
  onChainTaskId: number | null
  /** The task's creator. Passed so the poster is never offered a claim they
   *  cannot make — the blueprint asserts worker != poster (lib.rs
   *  `claim_task`'s "self-claim not allowed" assert). */
  posterId?: string
  /** PROJECT-STATE.md's 2026-09-01 §20 design packet (unnumbered
   *  "Also in §20" bullet — NOT §20.4, an unrelated open bug) — SHIPPABLE-NOW:
   *  shown to the worker BEFORE they claim, so the disclosure below actually
   *  lands before the commitment rather than after. Undefined while the task
   *  is still loading; the block simply doesn't render until it arrives. */
  posterCancelStats?: PosterCancelStats
  onSuccess?: (txId: string) => void
}) {
  const { account, rdt, ensureSessionDetailed, sessionMismatch, badge, badgeLoading } = useWallet()
  const { rate: usdRate } = useXrdUsd()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [txId, setTxId] = useState("")
  const [summary, setSummary] = useState<string | undefined>(undefined)
  const walletWait = useWalletWaitHint()
  const runGuarded = useTxGuard({
    reset: () => setSummary(undefined),
    onThrow: (e) => {
      setSummary(TX_BACKSTOP)
      setError(errText(e))
      setLoading(false)
    },
  })
  // P4-05 pre-flight: same convention as the Deposit balance check (P4-04,
  // useXrdBalance.ts) — both hooks called unconditionally, ahead of every
  // early return below (rules of hooks). useClaimBond is the SAME live
  // derivation sendClaimTx (lib/escrow-utils.ts) uses to size the manifest:
  // under Wave B the bond is clamp(reward * pct, floor, cap) in the task's
  // own reward token, not a flat constant (see that hook's own doc) —
  // recomputing it here instead of reusing the hook is exactly the stale
  // flat-bond assumption this task calls out.
  const { balance: xrdBalance, checked: balanceChecked, recheck: recheckXrdBalance } = useXrdBalance(account)
  const { bond: claimBondStr, status: claimBondStatus } = useClaimBond(onChainTaskId)

  if (!isEscrowDeployed()) return null
  if (onChainTaskId == null) return null // not funded — detail page shows the awaiting-funding notice

  // Before you claim (2026-09-24) — the terms of the bond, stated before the
  // commitment, and ABOVE every early return below: useClaimBond needs no
  // wallet, so a disconnected visitor, the poster and a badgeless visitor all
  // see the terms too. The amount is useClaimBond's live derivation: the SAME
  // clamp(reward × pct, floor, cap), rounded down to the token, that
  // sendClaimTx builds and claim_task asserts EXACT equality against — so
  // "exactly" sits on the XRD figure, and the USD figure is only an estimate
  // beside it. The deadline, grace and bounty split are the display mirrors of
  // the component's human_submit_deadline_secs, expire_grace_secs and
  // expire_bounty_pct (config.ts). Forfeit: expire_claim pays the bounty to its
  // caller and puts the rest in the owner-only forfeited-bonds vault. Return:
  // approve_and_release, release_after_review_timeout and
  // cancel_task_by_poster_after_claim all credit the whole bond back; once a
  // dispute is raised, BOTH ways out of it (resolve_dispute, and
  // auto_resolve_dispute's pinned default when nobody rules) split it by the
  // reward ruling (W5, credit_split_for_parties).
  const bountyPct = Math.round(ESCROW_EXPIRE_BOUNTY_PCT * 100)
  const graceHours = ESCROW_EXPIRE_GRACE_SECS / 3600
  const bondKnown = claimBondStatus === "ok" && claimBondStr !== null
  const bondUsd = bondKnown ? formatUsdAmount(claimBondStr!, usdRate) : null
  const claimTerms = (
    <div
      data-testid="claim-terms"
      className="space-y-1 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
    >
      <p className="font-medium text-foreground">Before you claim</p>
      <p>
        Claiming locks a bond of{" "}
        {bondKnown ? (
          <>
            <span className="font-medium text-foreground">exactly {formatXrdAmount(claimBondStr!)} XRD</span>
            {bondUsd ? ` (≈ ${bondUsd})` : ""}
          </>
        ) : (
          <>10% of the reward, at least {ESCROW_CLAIM_BOND_XRD} XRD today (an owner setting)</>
        )}{" "}
        from this account — the escrow accepts only that exact amount. You then have{" "}
        {Math.round(ESCROW_HUMAN_SUBMIT_DEADLINE_SECS / 86400)} days to submit.
      </p>
      <p>
        {graceHours === 1 ? "An hour" : `${graceHours} hours`} after that deadline, anyone can
        close your claim and the bond is forfeited: {100 - bountyPct}% to a vault only the
        operator can withdraw, {bountyPct}% to whoever closes it.
      </p>
      <p>
        It comes back to you in full when the task is approved or released after the review
        window, or if the poster cancels. If a dispute is raised, it is split the same way as the
        reward instead, whether an arbiter rules or the {DEFAULT_DISPUTE_WINDOW_HOURS}-hour default
        applies.
      </p>
    </div>
  )

  if (!account || !rdt) {
    return (
      <div className="space-y-2">
        {claimTerms}
        <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <Shield className="h-4 w-4 shrink-0" />
          <span>Connect your wallet to claim this task.</span>
        </div>
      </div>
    )
  }
  if (sessionMismatch)
    return (
      <div className="space-y-2">
        {claimTerms}
        <SessionMismatchAlert />
      </div>
    )
  // Self-claim gate. The blueprint refuses worker == poster (lib.rs
  // `claim_task`'s "self-claim not allowed" assert), so
  // this claim can only ever land as a CommittedFailure — offering the button
  // charges the poster a network fee to be told no. Explain rather than hide:
  // a silently vanishing button reads as "claiming is broken" (the same
  // frontend-audit lesson as the fund button above).
  if (posterId && account === posterId)
    return (
      <div className="space-y-2">
        {claimTerms}
        <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <Lock className="h-4 w-4 shrink-0" />
          <span>You posted this task — it has to be claimed by someone else.</span>
        </div>
      </div>
    )
  // Badge gate at CLAIM, not at the submit form (#4): tell a badgeless worker
  // up front and route them to mint, instead of a dead-end submit form.
  if (!badgeLoading && !badge) {
    return (
      <div className="space-y-2">
        {claimTerms}
        <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            A Guild member badge is required to claim.{" "}
            <Link href="/mint" className="font-medium underline">Mint one</Link>.
          </span>
        </div>
      </div>
    )
  }

  // Only a CONFIRMED balance AND a settled ("ok") bond derivation may gate
  // the button — the Deposit check's fail-open rule, now over TWO async
  // reads instead of one. Either read still loading, or either settled to
  // "unknown" (a Gateway miss), leaves insufficientXrd false: a worker whose
  // balance or bond we could not confirm must never be blocked from a claim
  // they can actually afford. sendClaimTx derives this same bond and fails
  // CLOSED on these reads for the on-chain leg — this warning is advisory
  // only, so it takes the opposite (fail-open) default on purpose.
  const claimBondXrd = claimBondStatus === "ok" && claimBondStr !== null ? Number(claimBondStr) : null
  const insufficientXrd =
    balanceChecked && xrdBalance !== null && claimBondXrd !== null && xrdBalance < claimBondXrd

  // The SOFT tier — same argument as the Deposit check's (see the long comment
  // there): the bond above is ALL the hard block covers, while claim_task's own
  // network fee is locked from the same XRD balance, so a worker holding
  // exactly the bond floor cleared the pre-flight and then failed at the fee
  // lock. Warns, never disables — FEE_HEADROOM_XRD is a hint, not an estimate.
  //
  // Headroom is computed against the SAME `claimBondXrd` the hard block uses,
  // so a bond still deriving or settled to "unknown" leaves this false too:
  // one fail-open rule over both async reads, not two.
  //
  // Comparing in `number` is fine HERE and would not be in the manifest:
  // `claimBondStr` is an 18dp Decimal string and Number() can lose its tail,
  // but this tier only asks "is there about an XRD spare", and the exact
  // amount the tx locks is sized by sendClaimTx from the string. The hard
  // block above already made the same trade for the same reason.
  const lowFeeHeadroom =
    balanceChecked &&
    xrdBalance !== null &&
    claimBondXrd !== null &&
    !insufficientXrd &&
    xrdBalance - claimBondXrd < FEE_HEADROOM_XRD

  async function handleClaim() {
    setLoading(true)
    setError("")
    // Session is needed for the post-tx confirm (POST /tasks/[id]/escrow is
    // withAuth). Establish it BEFORE the on-chain tx so we don't spend gas on a
    // tx the DB can't then confirm. No-op if already signed in.
    const gate = await walletWait.during(ensureSessionDetailed())
    if (!gate.ok) {
      setSummary(signInIncomplete(SIGN_IN_LEAD.claim, gate))
      setError(gate.detail ?? "")
      setLoading(false)
      return
    }
    const switched = switchedAccount(gate, account)
    if (switched) {
      setSummary(switched)
      setLoading(false)
      return
    }
    // Server-side self-claim guard (P3-3b) — asks the app BEFORE any chain
    // interaction, so a self-claim costs an HTTP round-trip instead of a
    // burned ~0.5 XRD lock fee. The render-time gate above (posterId ===
    // account) already hides this button for that case in the browser, but
    // this call is what makes the refusal real: it is a genuine server 403
    // (GET /tasks/[id]/escrow/claim-check, same SELF_CLAIM shape as
    // SELF_SUBMIT), reachable by any client, not just this component. Fails
    // CLOSED: a network error or an unparsable body blocks the claim with a
    // "try again" message rather than falling through as permission — a
    // failed pre-flight is not an allowed one.
    try {
      const check = await apiFetch(`/api/v1/tasks/${taskDbId}/escrow/claim-check`)
      const checkBody = await check.json().catch(() => null)
      if (!checkBody || typeof checkBody.ok !== "boolean") {
        setError("Couldn't verify claim eligibility — try again.")
        setLoading(false)
        return
      }
      if (!checkBody.ok) {
        setError(checkBody.error?.message ?? "This task can't be claimed right now.")
        setLoading(false)
        return
      }
    } catch {
      setError("Couldn't reach the server to verify claim eligibility — try again.")
      setLoading(false)
      return
    }
    // Resolve the worker's Guild member badge id from their account holdings.
    const badge = await loadUserBadge(account!, BADGE_NFT)
    if (!badge) {
      setError("No Guild member badge in your account — you need one to claim.")
      setLoading(false)
      return
    }
    // ⚠️ The min-trust gate was REMOVED here 2026-08-29 (operator ruling). It
    // read the claimer's ledger tier and blocked the button — but `claim_task`
    // is PUBLIC and asserts nothing about trust, so anyone building a manifest
    // by hand walked straight past it. It was enforcement in the React tree
    // only, presented to posters as a real gate with specific numeric criteria.
    // That is worse than no gate: it misled the poster who set it, and this
    // product's audience reads the blueprint. Enforcing it on-chain would need
    // a reputation source that does not exist. `minTrustTier` survives as
    // unenforced prose in the brief — see the note in tasks/create/page.tsx.
    // On-chain Open pre-flight (checked before spending gas, like the gates
    // above). The DB row can lag the chain — a refund/cancel whose confirm was
    // lost leaves a task `open` in the DB while its on-chain escrow is already
    // Refunded/Released. Claiming that sends a tx that reverts on the
    // blueprint's `must be Open` assert and burns the lock fee (~0.5 XRD). Read
    // the live state first; if it has left Open, pull the DB forward (resync)
    // and stop — no tx, no fee. A null read (Gateway hiccup) is NOT a block: we
    // proceed and let the on-chain assert + the post-failure resync below be the
    // backstop, so a transient read failure can't wedge a legitimate claim.
    //
    // We read (ESCROW_COMPONENT, onChainTaskId) — the EXACT tuple sendClaimTx
    // targets below — so this guards precisely what the claim will hit, and can
    // only prevent a burn or be neutral, never make one worse. (on_chain_task_id
    // collides across component cutovers, but a claimable task is by definition
    // on the current component; stale cross-component `open` rows don't exist —
    // all pre-cutover tasks are terminal — and are covered by the fund-tx-pinned
    // drift watcher. Recording the funding component per task is a follow-up.)
    const onChainState = await readEscrowTaskState(onChainTaskId!, ESCROW_COMPONENT)
    if (onChainState !== null && onChainState !== "Open") {
      const resync = await resyncEscrowTask(taskDbId)
      if (resync.ok && resync.applied > 0) {
        // The page re-fetches on success and the corrected status hides the
        // claim button — no error needed.
        onSuccess?.("")
      } else {
        setError(
          "This task is no longer open on-chain — it was already claimed, cancelled, or settled. Refresh to see its current status.",
        )
      }
      setLoading(false)
      return
    }
    const result = await walletWait.during(sendClaimTx({
      escrowComponent: ESCROW_COMPONENT,
      account: account!,
      badgeId: badge.id,
      taskId: onChainTaskId!,
      rdt: rdt!,
    }))
    if (!result.ok) {
      const failure = result.error ?? "Claim failed"
      // "task must be Open" = the chain already moved past this claim (raced,
      // or our own earlier claim landed without its confirm) — pull the DB
      // forward instead of stranding the user on the error (finding 4).
      if (humanizeTxError(failure).staleState) {
        const resync = await resyncEscrowTask(taskDbId)
        if (resync.ok && resync.applied > 0) {
          onSuccess?.("")
          setLoading(false)
          return
        }
      }
      setError(failure)
      setLoading(false)
      return
    }
    const confirm = await confirmEscrowTx(taskDbId, "claim", result.txId!)
    if (!confirm.ok) {
      setError(`Claimed on-chain, but syncing status failed: ${confirm.error}. Refresh shortly.`)
      setLoading(false)
      return
    }
    setTxId(result.txId!)
    onSuccess?.(result.txId!)
    setLoading(false)
  }

  if (txId) return <TxSuccess label="Task claimed." txId={txId} />

  // PROJECT-STATE.md's 2026-09-01 §20 design packet (unnumbered
  // "Also in §20" bullet — NOT §20.4, which is an unrelated, still-open
  // expire-bounty poster leak): SHIPPABLE-NOW, no ruling needed: (a) the
  // poster's historical cancel-after-claim count + rate, so a worker sees it
  // BEFORE they commit, and (b) the claim-time disclosure that
  // cancel_task_by_poster_after_claim (lib.rs) returns the worker's claim
  // bond in full but pays nothing for the time already spent. Both facts, one
  // block, directly above the button that starts the commitment.
  const cancelRate = posterCancelStats ? cancelAfterClaimRate(posterCancelStats) : null

  return (
    <div className="space-y-2">
      {claimTerms}
      {posterCancelStats && (
        <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <Shield className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            This poster has cancelled {posterCancelStats.cancelledAfterClaim} of{" "}
            {posterCancelStats.totalPosted} posted task
            {posterCancelStats.totalPosted === 1 ? "" : "s"} after a worker had already claimed
            {cancelRate !== null ? ` (${Math.round(cancelRate * 100)}%)` : ""}. If they cancel
            this one after you claim it, your claim bond returns to you in full — there is no
            payment for time you already spent on the task.
          </span>
        </div>
      )}
      {insufficientXrd && (
        <Alert variant="destructive">
          <AlertDescription>
            <p className="font-medium text-foreground">This account doesn&rsquo;t have enough XRD to cover the claim bond.</p>
            <p className="mt-1">
              Claiming this task posts a bond of {formatXrdUsd(claimBondStr ?? "0", usdRate)}. This
              account holds {formatXrdUsd(xrdBalance ?? 0, usdRate)} — short{" "}
              {formatXrdUsd(Math.max((claimBondXrd ?? 0) - (xrdBalance ?? 0), 0), usdRate)}. Add XRD to
              this account and try again.
            </p>
            <GetXrdLinks />
            <Button variant="outline" size="sm" className="mt-2" onClick={recheckXrdBalance}>
              Re-check balance
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {lowFeeHeadroom && (
        <Alert>
          <AlertDescription>
            This account holds {formatXrdUsd(xrdBalance ?? 0, usdRate, { xrdDecimals: 4 })} — enough
            for the {formatXrdUsd(claimBondStr ?? "0", usdRate)} claim bond, but little more. Radix
            charges a small network fee on top, taken from the same balance — usually enough, but
            top up a little if the transaction fails.
          </AlertDescription>
        </Alert>
      )}
      <Button onClick={() => runGuarded(handleClaim)} disabled={loading || insufficientXrd} className="w-full">
        <ArrowRight className="mr-2 h-4 w-4" />
        {loading ? "Claiming..." : "Claim Task"}
      </Button>
      {loading && walletWait.slow && (
        <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
          {walletWaitHint(WAIT_CLOSING.claim)}
        </p>
      )}
      <TxError error={error} summary={summary} />
    </div>
  )
}

// ── Submit (submit_task) — worker, on the task detail page ─────────────────────

export function EscrowSubmitButton({
  taskDbId,
  onChainTaskId,
  workerId,
  hasSubmission,
  title,
  description,
  termsBlock,
  onSuccess,
}: {
  taskDbId: number
  onChainTaskId: number | null
  /** The task's STORED brief, for the Wave B brief_hash. Must be the SAME
   *  expressions the fund button passes — see the note at the call site. */
  title: string
  description: string
  termsBlock?: string
  /** The task's assignee — the only account that can submit on-chain. */
  workerId: string | null
  /**
   * Whether a DB submission exists for this task (the page's submissionCount).
   * The on-chain submit commits to the worker's STORED submission, so without
   * one this button IS the "describe your work" link (smoke finding 6) — for
   * the assignee any existing submission is theirs (the route enforces it).
   */
  hasSubmission?: boolean
  onSuccess?: (txId: string) => void
}) {
  const { account, rdt, ensureSessionDetailed, sessionMismatch } = useWallet()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  // Click-time backstop for the hasSubmission prop (the count can be stale):
  // the submissions fetch failing closed flips this and we render the link.
  const [needsSubmission, setNeedsSubmission] = useState(false)
  const [txId, setTxId] = useState("")
  const [summary, setSummary] = useState<string | undefined>(undefined)
  const walletWait = useWalletWaitHint()
  const runGuarded = useTxGuard({
    reset: () => setSummary(undefined),
    onThrow: (e) => {
      setSummary(TX_BACKSTOP)
      setError(errText(e))
      setLoading(false)
    },
  })

  if (!isEscrowDeployed()) return null
  if (!account || !rdt) return null
  if (onChainTaskId == null) return null
  // Worker-only: submitting presents (and burns) the worker's claim receipt.
  // (A press stopped by an account switch keeps its sentence on screen.)
  if (account !== workerId) return summary ? <TxError error="" summary={summary} /> : null
  if (sessionMismatch) return <SessionMismatchAlert />

  // No work described yet → there is nothing to commit on-chain. BE the link
  // to the submit form instead of erroring into one (smoke finding 6).
  if (needsSubmission || hasSubmission === false) {
    return (
      <div className="space-y-2">
        <Link href={`/tasks/${taskDbId}/submit`}>
          <Button className="w-full">
            <Send className="mr-2 h-4 w-4" />
            Describe your work first
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </Link>
        <p className="text-xs text-muted-foreground">
          Post what you built, then submit on-chain to lock its hash in escrow
          (that step moves no money — your claim bond stays in escrow until the task settles).
        </p>
      </div>
    )
  }

  async function handleSubmit() {
    setLoading(true)
    setError("")
    setNeedsSubmission(false)
    // Session is needed for the submissions read AND the post-tx confirm (both
    // withAuth). Establish it BEFORE the on-chain tx so we don't spend gas on a
    // tx the DB can't then confirm. No-op if already signed in.
    const gate = await walletWait.during(ensureSessionDetailed())
    if (!gate.ok) {
      setSummary(signInIncomplete(SIGN_IN_LEAD.submit, gate))
      setError(gate.detail ?? "")
      setLoading(false)
      return
    }
    const switched = switchedAccount(gate, account)
    if (switched) {
      setSummary(switched)
      setLoading(false)
      return
    }
    // The on-chain evidence commits to the worker's STORED submission row (the
    // same content the poster reviews) — fetched at click time, never a client
    // form value. Fail closed if they haven't posted a submission yet.
    const submission = await fetchOwnSubmissionContent(taskDbId, account!)
    if (!submission.ok || !submission.content) {
      if (submission.noSubmission) {
        setNeedsSubmission(true)
      } else {
        setError(submission.error ?? "Failed to load your submission")
      }
      setLoading(false)
      return
    }
    const claimReceiptId = await findClaimReceiptId(
      account!,
      ESCROW_CLAIM_RECEIPT_RESOURCE,
      onChainTaskId!,
    )
    if (claimReceiptId == null) {
      // The claim receipt burns on a successful on-chain submit, so this also
      // covers "already submitted on-chain".
      setError("No claim receipt for this task in your account — either you haven't claimed it on-chain, or you already submitted.")
      setLoading(false)
      return
    }
    const result = await walletWait.during(sendSubmitTx({
      escrowComponent: ESCROW_COMPONENT,
      account: account!,
      claimReceiptId,
      taskId: onChainTaskId!,
      content: submission.content,
      title,
      description,
      termsBlock,
      rdt: rdt!,
    }))
    if (!result.ok) {
      const failure = result.error ?? "Submit failed"
      // The claim expired mid-flow (expire_claim reset the task to Open and the
      // receipt is gone) — pull the DB forward instead of stranding the worker
      // on a raw assert, same as the claim path does on a stale state.
      if (humanizeTxError(failure).staleState) {
        const resync = await resyncEscrowTask(taskDbId)
        if (resync.ok && resync.applied > 0) {
          onSuccess?.("")
          setLoading(false)
          return
        }
      }
      setError(failure)
      setLoading(false)
      return
    }
    const confirm = await confirmEscrowTx(taskDbId, "submit", result.txId!)
    if (!confirm.ok) {
      setError(`Submitted on-chain, but syncing status failed: ${confirm.error}. Refresh shortly.`)
      setLoading(false)
      return
    }
    setTxId(result.txId!)
    onSuccess?.(result.txId!)
    setLoading(false)
  }

  if (txId) return <TxSuccess label="Work submitted." txId={txId} />

  return (
    <div className="space-y-2">
      <Button onClick={() => runGuarded(handleSubmit)} disabled={loading} className="w-full">
        <Send className="mr-2 h-4 w-4" />
        {loading ? "Submitting..." : "Submit Work"}
      </Button>
      {loading && walletWait.slow && (
        <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
          {walletWaitHint(WAIT_CLOSING.submit)}
        </p>
      )}
      <TxError error={error} summary={summary} />
    </div>
  )
}

// ── Approve + Release (approve_and_release) — poster, on the detail page ────────

export function EscrowApproveButton({
  taskDbId,
  onChainTaskId,
  posterId,
  rewardXrd,
  workerAddress,
  onSuccess,
}: {
  taskDbId: number
  onChainTaskId: number | null
  /** The task poster. Approve is poster-only — the release manifest withdraws the
      Task Receipt NFT, which only the poster holds, so a non-poster press aborts
      on-chain (wasting a fee). Gate it in the UI too, mirroring EscrowCancelButton. */
  posterId: string
  rewardXrd: number
  workerAddress: string | null
  onSuccess?: (txId: string) => void
}) {
  const { account, rdt, ensureSessionDetailed, sessionMismatch } = useWallet()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [txId, setTxId] = useState("")
  const [windowWarning, setWindowWarning] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | undefined>(undefined)
  const walletWait = useWalletWaitHint()
  const runGuarded = useTxGuard({
    reset: () => setSummary(undefined),
    onThrow: (e) => {
      setSummary(TX_BACKSTOP)
      setError(errText(e))
      setLoading(false)
    },
  })
  // The review deadline PINNED at submit_task (TaskInfo.review_deadline). Until
  // 2026-09-24 the warning below counted a 72h "dispute window" from the DB
  // row's updatedAt, which moves on ANY write to the row. Fails open: no read,
  // no warning — the warning never blocks the approval anyway.
  const { info: onChainInfo } = useOnChainTaskInfo(onChainTaskId)

  if (!isEscrowDeployed()) return null
  if (!account || !rdt) return null
  if (onChainTaskId == null) return null
  // Poster-only: the release manifest presents the Task Receipt NFT (poster-held),
  // so a non-poster press aborts on-chain. Gate it here so the worker never sees a
  // button that can only burn a fee (mainnet acceptance run, 2026-07-18).
  // (A press stopped by an account switch keeps its sentence on screen.)
  if (account !== posterId) return summary ? <TxError error="" summary={summary} /> : null
  if (sessionMismatch) return <SessionMismatchAlert />

  async function handleApprove() {
    // Warn (don't block) while the review window is still open.
    const reviewDeadline = onChainInfo?.state === "Submitted" ? onChainInfo.reviewDeadline : null
    if (reviewDeadline) {
      const remainingMs = reviewDeadline.getTime() - Date.now()
      if (remainingMs > 0) {
        const remaining = Math.ceil(remainingMs / 3600000)
        setWindowWarning(
          `Review window: ${remaining}h before anyone can release payment. ${settlementCopy("approveWindowNote")}`,
        )
      }
    }
    setLoading(true)
    setError("")
    // Session is needed for the post-tx confirm (POST /tasks/[id]/escrow is
    // withAuth). Establish it BEFORE the on-chain tx so we don't spend gas on a
    // tx the DB can't then confirm. No-op if already signed in.
    const gate = await walletWait.during(ensureSessionDetailed())
    if (!gate.ok) {
      setSummary(signInIncomplete(SIGN_IN_LEAD.approve, gate))
      setError(gate.detail ?? "")
      setLoading(false)
      return
    }
    const switched = switchedAccount(gate, account)
    if (switched) {
      setSummary(switched)
      setLoading(false)
      return
    }
    // Live-state pre-flight (APPROVE_NOT_SUBMITTED says why).
    const live = await readEscrowTaskState(onChainTaskId!, ESCROW_COMPONENT)
    if (live != null && live !== "Submitted") {
      const resync = await resyncEscrowTask(taskDbId)
      if (resync.ok && resync.applied > 0) {
        onSuccess?.("")
        setLoading(false)
        return
      }
      setSummary(APPROVE_NOT_SUBMITTED)
      setLoading(false)
      return
    }
    // The pre-flight fund-row fetch that used to sit here was M1, and it went
    // with the push branch: the push manifest carried the payout AMOUNT, so it
    // re-read the funded reward on-chain rather than trust a possibly-drifted DB
    // value. The pull manifest carries no amount and no destination, so there is
    // nothing for a drifted value to poison and no fund row to need.
    const result = await walletWait.during(sendApproveTx({
      escrowComponent: ESCROW_COMPONENT,
      account: account!,
      receiptId: String(onChainTaskId),
      rdt: rdt!,
    }))
    if (!result.ok) {
      const failure = result.error ?? "Approval failed"
      // The chain settled this task first (see APPROVE_NOT_SUBMITTED): pull
      // the DB forward instead of leaving Approve on screen for another fee.
      if (humanizeTxError(failure).staleState) {
        const resync = await resyncEscrowTask(taskDbId)
        if (resync.ok && resync.applied > 0) {
          onSuccess?.("")
          setLoading(false)
          return
        }
      }
      setError(failure)
      setLoading(false)
      return
    }
    const confirm = await confirmEscrowTx(taskDbId, "approve", result.txId!)
    if (!confirm.ok) {
      setError(`${settlementCopy("approveSyncErrorLead")}, but syncing status failed: ${confirm.error}. Refresh shortly.`)
      setLoading(false)
      return
    }
    setTxId(result.txId!)
    onSuccess?.(result.txId!)
    setLoading(false)
  }

  if (txId) return <TxSuccess label={settlementCopy("approveSuccessLabel")!} txId={txId} />

  return (
    <div className="space-y-2">
      {windowWarning && (
        <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          {windowWarning}
        </div>
      )}
      <Button onClick={() => runGuarded(handleApprove)} disabled={loading} className="w-full">
        <CheckCircle className="mr-2 h-4 w-4" />
        {loading ? settlementCopy("approveButtonLoading") : settlementCopy("approveButtonIdle")}
      </Button>
      {loading && walletWait.slow && (
        <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
          {walletWaitHint(WAIT_CLOSING.approve)}
        </p>
      )}
      <TxError error={error} summary={summary} />
    </div>
  )
}

// ── Release after review timeout (release_after_review_timeout, Wave B stage 6)
//    — worker or poster, on the task detail page, once Submitted ──────────────

/**
 * Countdown + finalize action for a Submitted task's review window. The
 * deadline (`review_deadline`, pinned onto the task at submit_task from the
 * component's `review_window_secs`) is on-chain only — the DB has no column
 * for it — so it is read live via useOnChainTaskInfo, the same source
 * ClaimDeadlineNotice (escrow-truth.tsx) reads its own on-chain deadline
 * from. Renders nothing until there is a live Submitted task with a review
 * deadline to show.
 *
 * `release_after_review_timeout` is PUBLIC on-chain — literally anyone may
 * call it once the window lapses — but the UI surface stays to the task's
 * two parties for now, the same restraint FinalizeDisputeButton takes on the
 * identically-shaped auto_resolve_dispute (a keeper picks up the rest).
 */
export function ReleaseAfterReviewTimeoutButton({
  taskDbId,
  onChainTaskId,
  posterId,
  workerId,
  onSuccess,
}: {
  taskDbId: number
  onChainTaskId: number | null
  posterId: string
  workerId: string | null
  onSuccess?: (txId: string) => void
}) {
  const { account, rdt, ensureSessionDetailed, sessionMismatch } = useWallet()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [txId, setTxId] = useState("")
  const [summary, setSummary] = useState<string | undefined>(undefined)
  const walletWait = useWalletWaitHint()
  const runGuarded = useTxGuard({
    reset: () => setSummary(undefined),
    onThrow: (e) => {
      setSummary(TX_BACKSTOP)
      setError(errText(e))
      setLoading(false)
    },
  })
  // Fails OPEN on purpose, same posture as ClaimDeadlineNotice: this renders a
  // countdown/action, not a silent money movement — a Gateway hiccup hides the
  // affordance rather than showing a wrong one.
  const { info } = useOnChainTaskInfo(onChainTaskId)
  const [now, setNow] = useState(() => Date.now())

  // Tick only while there is a live deadline to count down against — no
  // ticking an empty subtree once the task leaves Submitted.
  const active = info?.state === "Submitted" && !!info.reviewDeadline
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [active])

  if (!isEscrowDeployed()) return null
  if (!account || !rdt) return null
  if (onChainTaskId == null || !workerId) return null
  if (account !== posterId && account !== workerId) return null
  if (sessionMismatch) return <SessionMismatchAlert />
  // Absent on a pre-Wave-B component (no such field) and on any state but
  // Submitted — render nothing rather than a countdown to a deadline that
  // does not exist yet.
  if (!info || info.state !== "Submitted" || !info.reviewDeadline) return null

  const remaining = info.reviewDeadline.getTime() - now
  const windowOpen = remaining <= 0

  async function handleRelease() {
    setLoading(true)
    setError("")
    // Session is needed for the post-tx confirm (withAuth). Establish it
    // BEFORE the on-chain tx so we don't spend gas on a tx the DB can't then
    // confirm. No-op if already signed in.
    const gate = await walletWait.during(ensureSessionDetailed())
    if (!gate.ok) {
      setSummary(signInIncomplete(SIGN_IN_LEAD.release, gate))
      setError(gate.detail ?? "")
      setLoading(false)
      return
    }
    const result = await walletWait.during(sendReleaseAfterReviewTimeoutTx({
      taskId: onChainTaskId!,
      rdt: rdt!,
    }))
    if (!result.ok) {
      setError(result.error ?? "Release failed")
      setLoading(false)
      return
    }
    // "approve", not a new kind: release_after_review_timeout emits the SAME
    // TaskReleasedEvent approve_and_release does and pays EXACTLY what an
    // approval pays (lib.rs) — the confirm route classifies by event NAME
    // only (escrow-confirm.ts), and EscrowApproveButton above confirms its
    // own TaskReleasedEvent the identical way.
    const confirm = await confirmEscrowTx(taskDbId, "approve", result.txId!)
    if (!confirm.ok) {
      setError(`Released on-chain, but syncing status failed: ${confirm.error}. Refresh shortly.`)
      setLoading(false)
      return
    }
    setTxId(result.txId!)
    onSuccess?.(result.txId!)
    setLoading(false)
  }

  if (txId) return <TxSuccess label="Released — the review window lapsed." txId={txId} />

  return (
    <div className="space-y-2">
      <Button
        onClick={() => runGuarded(handleRelease)}
        disabled={loading || !windowOpen}
        variant="outline"
        className="w-full"
      >
        <Clock className="mr-2 h-4 w-4" />
        {loading
          ? "Releasing..."
          : windowOpen
            ? "Release after review timeout"
            : `Review window: ${formatRemaining(remaining)} left`}
      </Button>
      <p className="text-xs text-muted-foreground">
        {windowOpen
          ? "The poster's review window has lapsed. This is a PUBLIC method — anyone may call it, not just the two of you — and it pays exactly what an approval pays: the reward and your held claim bond credited to the worker, the insurance credited home to the poster. Each of you then collects with your own signed withdrawal, same as approval."
          : `The poster's review window is still open (estimated from the last on-chain read). Once it lapses, anyone — not just the two of you — may call this to finalize the release. The chain enforces the exact deadline; a too-early call fails and still costs the network fee.`}
      </p>
      {loading && walletWait.slow && (
        <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
          {walletWaitHint(WAIT_CLOSING.release)}
        </p>
      )}
      <TxError error={error} summary={summary} />
    </div>
  )
}

// ── Cancel (cancel_task / …after_claim) — poster, while open or assigned ───────
//
// 2026-10-03, task 70: the poster pressed Cancel twice, the Radix Wallet showed
// no transaction, and the page said nothing that explained it; the same
// cancel_task manifest committed from the Radix Dashboard a minute later. The
// press reaches rdt.walletApi.sendTransaction through one gate, ensureSession(),
// and the bundle served that day baked the right component and receipt
// resource — so a wallet that shows nothing means the request stopped at
// sign-in or the dApp toolkit did not deliver it. Each of those now ends in a
// sentence on this button: the sign-in line below, the toolkit codes in
// humanizeTxError (escrow-utils.ts), and the wait hint for a request the wallet
// never answers.

/**
 * Pressed, but sign-in did not complete, so the cancel was never sent — the
 * generic form (no reported cause). It replaces the shared "Approve the wallet
 * signature to continue." that asked the poster to approve a request their
 * wallet never showed. With a reported cause the button shows
 * signInIncomplete(SIGN_IN_LEAD.cancel, failure) instead.
 */
export const CANCEL_SIGN_IN_INCOMPLETE = signInIncomplete(SIGN_IN_LEAD.cancel)

/** How long a press waits on the wallet before the page says so. */
export const WALLET_WAIT_HINT_MS = 20_000

/** The cancel button's wait hint (walletWaitHint with its own closing). */
export const CANCEL_WALLET_WAIT_HINT = walletWaitHint(WAIT_CLOSING.cancel)

/**
 * The chain says this task has moved past the point where either cancel
 * method applies (submitted, settled or refunded), and the DB row was behind.
 * No transaction is sent: the method would only revert and burn the fee.
 */
export const CANCEL_NOT_CANCELLABLE =
  "This task can no longer be cancelled: on-chain it has already moved past the point where a cancel applies (the work was submitted, or the task settled or was refunded), so no cancel transaction was sent. Refresh to see its current status."

/**
 * Approve, Raise Dispute and Finalize read the live on-chain state before they
 * send (GM-5, 2026-10-06), as Claim and Cancel already did. The row can lag the
 * chain: release_after_review_timeout and auto_resolve_dispute are PUBLIC, so a
 * worker, a keeper or a stranger can settle the task and the confirm can be
 * lost. Sending then only reverts on the blueprint's state assert and charges
 * the fee, and the buttons stayed on screen for another try. When the state is
 * not the one the method needs, the DB is pulled forward and nothing is sent.
 * An unreadable state proceeds (the on-chain assert stays the backstop).
 */
export const APPROVE_NOT_SUBMITTED =
  "This task is no longer waiting for review on-chain, so no approval transaction was sent. Refresh the page to see its current status."
export const DISPUTE_NOT_SUBMITTED =
  "This task is no longer waiting for review on-chain, so no dispute transaction was sent. Refresh the page to see its current status."
export const FINALIZE_NOT_DISPUTED =
  "This task is no longer in dispute on-chain, so no settlement transaction was sent. Refresh the page to see its current status."

/**
 * Cancel on a task the DB shows unclaimed but the chain shows Claimed (GM-7).
 * The method that applies then voids a worker's live claim, which the "cancel
 * open task" copy never said. The first press stops here; the button switches
 * to the claimed-task copy, and a second press sends.
 */
export const CANCEL_VOIDS_LIVE_CLAIM =
  "A worker has claimed this task on-chain, which this page did not show yet, so no cancel transaction was sent. Cancelling now voids their claim: the contract credits their claim bond back to them in full, and pays them nothing for the work so far. Press the button again if you still want to cancel."

/**
 * Times the stretch of a handler that waits on the wallet. `start()` arms a
 * WALLET_WAIT_HINT_MS timer and returns the function that disarms it;
 * `during(p)` arms it for exactly as long as `p` is pending. Disarm as soon as
 * the wallet answers, so the hint never covers a later wait that is not the
 * wallet's (confirmEscrowTx alone retries for up to ~16 s after a successful
 * send). Every button wraps its sign-in gate and its send in `during`.
 */
function useWalletWaitHint() {
  const [slow, setSlow] = useState(false)
  const start = useCallback(() => {
    const timer = setTimeout(() => setSlow(true), WALLET_WAIT_HINT_MS)
    return () => {
      clearTimeout(timer)
      setSlow(false)
    }
  }, [])
  const during = useCallback(
    async <T,>(p: Promise<T>): Promise<T> => {
      const stop = start()
      try {
        return await p
      } finally {
        stop()
      }
    },
    [start],
  )
  return { slow, start, during }
}

export function EscrowCancelButton({
  taskDbId,
  onChainTaskId,
  posterId,
  workerId,
  phase,
  onSuccess,
}: {
  taskDbId: number
  onChainTaskId: number | null
  posterId: string
  workerId: string | null
  /**
   * "open"    — unclaimed task (cancel_task): escrow refunds to the poster.
   * "claimed" — assigned, not yet submitted (cancel_task_by_poster_after_claim):
   *             escrow refunds to the poster AND the worker's claim bond is
   *             returned to the worker in the same transaction.
   */
  phase: "open" | "claimed"
  onSuccess?: (txId: string) => void
}) {
  const { account, rdt, ensureSessionDetailed, sessionMismatch } = useWallet()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [txId, setTxId] = useState("")
  const [summary, setSummary] = useState<string | undefined>(undefined)
  // The phase the poster has SEEN the copy for. Starts as the row's phase; set
  // to "claimed" when a press finds a live claim the row did not show
  // (CANCEL_VOIDS_LIVE_CLAIM), so only a second press, made under the
  // claimed-task copy, voids it.
  const [seenPhase, setSeenPhase] = useState<"open" | "claimed" | null>(null)
  const shownPhase = seenPhase ?? phase
  const walletWait = useWalletWaitHint()
  const runGuarded = useTxGuard({
    reset: () => setSummary(undefined),
    onThrow: (e) => {
      setSummary(TX_BACKSTOP)
      setError(errText(e))
      setLoading(false)
    },
  })

  if (!isEscrowDeployed()) return null
  if (!account || !rdt) return null
  if (onChainTaskId == null) return null // not funded on-chain yet
  // Poster-only: cancelling presents (and burns) the poster's Task Receipt.
  // (A press stopped by an account switch keeps its sentence on screen.)
  if (account !== posterId) return summary ? <TxError error="" summary={summary} /> : null
  if (sessionMismatch) return <SessionMismatchAlert />

  async function handleCancel() {
    setLoading(true)
    setError("")
    // Session is needed for the post-tx confirm (POST /tasks/[id]/escrow is
    // withAuth). Establish it BEFORE the on-chain tx so we don't spend gas on
    // a tx the DB can't then confirm. No-op if already signed in. Reported,
    // never thrown, and under the wait hint: a sign-in request the wallet
    // never answers is the same silence as a transaction it never answers.
    const gate = await walletWait.during(ensureSessionDetailed())
    if (!gate.ok) {
      setSummary(signInIncomplete(SIGN_IN_LEAD.cancel, gate))
      setError(gate.detail ?? "")
      setLoading(false)
      return
    }
    const switched = switchedAccount(gate, account)
    if (switched) {
      setSummary(switched)
      setLoading(false)
      return
    }
    // Which cancel applies is the chain's call, not the DB row's. The row can
    // lag the chain — a claim whose confirm was lost leaves the task "open" in
    // the DB while the escrow says Claimed, and cancel_task then reverts on the
    // blueprint's state assert and burns the lock fee. Read the live state
    // first, as the claim button does: Open → cancel_task, Claimed →
    // cancel_task_by_poster_after_claim, anything later → no cancel applies,
    // pull the DB forward instead. An unreadable state (null: a Gateway hiccup)
    // falls back to the row's phase — fail open, the on-chain assert stays the
    // backstop.
    const live = await readEscrowTaskState(onChainTaskId!, ESCROW_COMPONENT)
    const livePhase: "open" | "claimed" | null =
      live == null ? shownPhase : live === "Open" ? "open" : live === "Claimed" ? "claimed" : null
    if (livePhase === null) {
      const resync = await resyncEscrowTask(taskDbId)
      if (resync.ok && resync.applied > 0) {
        onSuccess?.("")
        setLoading(false)
        return
      }
      setSummary(CANCEL_NOT_CANCELLABLE)
      setLoading(false)
      return
    }
    // The chain shows a live claim the poster was not shown (GM-7): stop, say
    // so, switch to the claimed-task copy, and pull the DB forward. The method
    // that applies would void that worker's claim, which the open-task copy
    // never mentioned.
    if (livePhase === "claimed" && shownPhase === "open") {
      setSeenPhase("claimed")
      const resync = await resyncEscrowTask(taskDbId)
      if (resync.ok && resync.applied > 0) onSuccess?.("")
      setSummary(CANCEL_VOIDS_LIVE_CLAIM)
      setLoading(false)
      return
    }
    const result = await walletWait.during(
      sendCancelTx({
        escrowComponent: ESCROW_COMPONENT,
        account: account!,
        taskId: onChainTaskId!,
        phase: livePhase,
        workerAccount: workerId,
        rdt: rdt!,
      }),
    )
    if (!result.ok) {
      const failure = result.error ?? "Cancel failed"
      // Missing receipt NFT = the task already settled/cancelled on-chain (the
      // smoke's cancel deadlock) — pull the DB forward instead of stranding
      // the user on the error (finding 4).
      if (humanizeTxError(failure).staleState) {
        const resync = await resyncEscrowTask(taskDbId)
        if (resync.ok && resync.applied > 0) {
          onSuccess?.("")
          setLoading(false)
          return
        }
      }
      setError(failure)
      setLoading(false)
      return
    }
    const confirm = await confirmEscrowTx(taskDbId, "cancel", result.txId!)
    if (!confirm.ok) {
      setError(`Cancelled on-chain, but syncing status failed: ${confirm.error}. Refresh shortly.`)
      setLoading(false)
      return
    }
    setTxId(result.txId!)
    onSuccess?.(result.txId!)
    setLoading(false)
  }

  if (txId) return <TxSuccess label={settlementCopy("cancelSuccessLabel")!} txId={txId} />

  return (
    <div className="space-y-2">
      <Button
        onClick={() => runGuarded(handleCancel)}
        disabled={loading}
        variant="outline"
        className="w-full text-destructive hover:text-destructive"
      >
        <Ban className="mr-2 h-4 w-4" />
        {loading
          ? "Cancelling..."
          : shownPhase === "open"
            ? settlementCopy("cancelButtonOpen")
            : settlementCopy("cancelButtonClaimed")}
      </Button>
      {loading && walletWait.slow && (
        <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
          {CANCEL_WALLET_WAIT_HINT}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {shownPhase === "open"
          ? settlementCopy("cancelDescriptionOpen")
          : settlementCopy("cancelDescriptionClaimed")}
      </p>
      <TxError error={error} summary={summary} />
    </div>
  )
}

// ── Raise Dispute (raise_dispute) — poster or worker, while submitted ───────────

export function RaiseDisputeButton({
  taskDbId,
  onChainTaskId,
  posterId,
  workerId,
  onSuccess,
}: {
  taskDbId: number
  onChainTaskId: number | null
  posterId: string
  workerId: string | null
  onSuccess?: (txId: string) => void
}) {
  const { account, rdt, ensureSessionDetailed, sessionMismatch } = useWallet()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [txId, setTxId] = useState("")
  // Finding 5: the auto-resolve terms must be agreed to in a dialog before the
  // wallet ever opens — the one-line caption under the button does not land.
  const [confirmOpen, setConfirmOpen] = useState(false)
  // The raiser's statement of what went wrong. Hashed into the on-chain
  // commitment AND stored as plaintext so the commitment can be opened later —
  // see src/lib/dispute-evidence.ts for why both halves are needed.
  const [evidence, setEvidence] = useState("")
  // Set when the dispute landed on-chain but the statement did not reach us.
  // A warning, never an error: the dispute is real and irreversible by then.
  const [evidenceWarning, setEvidenceWarning] = useState("")
  const [summary, setSummary] = useState<string | undefined>(undefined)
  const walletWait = useWalletWaitHint()
  const runGuarded = useTxGuard({
    reset: () => setSummary(undefined),
    onThrow: (e) => {
      setSummary(TX_BACKSTOP)
      setError(errText(e))
      setLoading(false)
    },
  })

  // The flag decides whether OUR UI exposes this affordance, not whether it
  // is safe to — BUG-7 + H1 are closed structurally under pull, and P3-3/DB-5
  // (2026-08-27) made ON the intended posture (see features.ts). Gate FIRST
  // regardless: a build with the flag deliberately off must render nothing
  // here, whoever the caller is.
  if (!isEnabled("disputes")) return null
  if (!isEscrowDeployed()) return null
  if (!account || !rdt) return null
  if (onChainTaskId == null) return null
  // Only the task's two parties can dispute, and the proof differs by party
  // (poster presents the Task Receipt, worker the Guild badge), so resolve it up
  // front and hide the action from everyone else.
  const party: "poster" | "worker" | null =
    account === posterId ? "poster" : account === workerId ? "worker" : null
  // (A press stopped by an account switch keeps its sentence on screen.)
  if (party === null) return summary ? <TxError error="" summary={summary} /> : null
  if (sessionMismatch) return <SessionMismatchAlert />

  async function handleDispute() {
    setConfirmOpen(false)
    setLoading(true)
    setError("")
    // Session is needed for the post-tx confirm (POST /tasks/[id]/escrow is
    // withAuth). Establish it BEFORE the on-chain tx so we don't spend gas on a
    // tx the DB can't then confirm. No-op if already signed in.
    const gate = await walletWait.during(ensureSessionDetailed())
    if (!gate.ok) {
      setSummary(signInIncomplete(SIGN_IN_LEAD.dispute, gate))
      setError(gate.detail ?? "")
      setLoading(false)
      return
    }
    const switched = switchedAccount(gate, account)
    if (switched) {
      setSummary(switched)
      setLoading(false)
      return
    }
    // Live-state pre-flight (APPROVE_NOT_SUBMITTED's doc says why).
    const live = await readEscrowTaskState(onChainTaskId!, ESCROW_COMPONENT)
    if (live != null && live !== "Submitted") {
      const resync = await resyncEscrowTask(taskDbId)
      if (resync.ok && resync.applied > 0) {
        onSuccess?.("")
        setLoading(false)
        return
      }
      setSummary(DISPUTE_NOT_SUBMITTED)
      setLoading(false)
      return
    }
    // Poster proves with the Task Receipt (local id = the on-chain task id);
    // worker proves with the Guild member badge resolved from their account.
    let proofResource: string
    let proofLocalId: string
    if (party === "poster") {
      proofResource = ESCROW_RECEIPT_RESOURCE
      proofLocalId = `#${onChainTaskId}#`
    } else {
      const badge = await loadUserBadge(account!, BADGE_NFT)
      if (!badge) {
        setError("No Guild member badge in your account — can't prove you claimed this task.")
        setLoading(false)
        return
      }
      proofResource = BADGE_NFT
      proofLocalId = badge.id
    }
    // The evidence hash is the ONE part of a dispute that carries the raiser's
    // side of the story, and until 2026-09-01 we filled it with
    // `dispute:task:<id>` — a commitment to a string derivable from the task
    // id, i.e. to nothing. Now it commits to what the raiser actually wrote,
    // over the shared domain-separated preimage so the server can recompute it.
    // Empty statement -> no commitment at all (Enum<0u8>), which is honest:
    // better an explicit absence than a hash of "".
    const statement = normalizeDisputeEvidence(evidence)
    const result = await walletWait.during(sendRaiseDisputeTx({
      escrowComponent: ESCROW_COMPONENT,
      account: account!,
      taskId: onChainTaskId!,
      proofResource,
      proofLocalId,
      evidence: statement ? disputeEvidencePreimage(statement) : undefined,
      rdt: rdt!,
    }))
    if (!result.ok) {
      const failure = result.error ?? "Dispute failed"
      if (humanizeTxError(failure).staleState) {
        const resync = await resyncEscrowTask(taskDbId)
        if (resync.ok && resync.applied > 0) {
          onSuccess?.("")
          setLoading(false)
          return
        }
      }
      setError(failure)
      setLoading(false)
      return
    }
    const confirm = await confirmEscrowTx(taskDbId, "dispute", result.txId!)
    if (!confirm.ok) {
      setError(`Dispute raised on-chain, but syncing status failed: ${confirm.error}. Refresh shortly.`)
      setLoading(false)
      return
    }
    // Store the preimage AFTER the confirm, and never before: the route only
    // accepts a statement against a task the DB already shows as `disputed`.
    //
    // Failure here is a WARNING, not an error, and the distinction is the whole
    // design. By this line the dispute is on-chain and irreversible; the 72h
    // clock is running whether or not our database learned what was written.
    // Reporting this as a failed dispute would be false and would invite the
    // user to retry a transaction that already succeeded.
    if (statement) {
      const filed = await fileDisputeEvidence(taskDbId, statement)
      if (!filed.ok) {
        setEvidenceWarning(
          `The dispute is raised on-chain, but your written statement was not saved (${filed.error}). The commitment to it is already on the ledger — keep your copy of the text so it can still be checked against that hash.`,
        )
      }
    }
    setTxId(result.txId!)
    onSuccess?.(result.txId!)
    setLoading(false)
  }

  if (txId)
    return (
      <div className="space-y-2">
        <TxSuccess label="Dispute raised." txId={txId} />
        {evidenceWarning && (
          <p
            role="status"
            className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
          >
            {evidenceWarning}
          </p>
        )}
      </div>
    )

  return (
    <div className="space-y-2">
      <Button
        onClick={() => setConfirmOpen(true)}
        disabled={loading}
        variant="outline"
        className="w-full"
      >
        <AlertTriangle className="mr-2 h-4 w-4" />
        {loading ? "Raising dispute..." : "Raise Dispute"}
      </Button>
      <p className="text-xs text-muted-foreground">
        Opens a dispute on this submission. If nobody rules within{" "}
        {DEFAULT_DISPUTE_WINDOW_HOURS}h, anyone can settle it by the default: the reward and the
        worker&apos;s claim bond each split 50/50, and the insurance returns to the poster. Under
        the {DEFAULT_DISPUTE_WINDOW_HOURS}-hour default, a dispute can only lose a worker money;
        for the poster, an unruled dispute recovers half the reward and half the worker&apos;s
        bond.
      </p>
      {loading && walletWait.slow && (
        <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
          {walletWaitHint(WAIT_CLOSING.dispute)}
        </p>
      )}
      <TxError error={error} summary={summary} />
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Raise a dispute — how it resolves</DialogTitle>
            <DialogDescription>
              Make sure these terms are what you want before signing.
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-2 pl-5 text-sm">
            <li>
              Raising takes no stake beyond the network fee — but it puts the worker&apos;s claim
              bond on the table: a ruling, or the default below, splits it with the reward.
            </li>
            <li>
              <span className="font-medium">A human arbiter can rule this instead</span>: the
              Guild&apos;s operator, who also posts today&apos;s tasks, holding the one arbiter
              badge. It is an operator ceremony, not a button either party clicks, and we
              promise no turnaround before the window below closes — there is no public SLA on
              this leg. On tasks funded through this app the arbiter takes no fee.
            </li>
            <li>
              If nobody rules first, after the {DEFAULT_DISPUTE_WINDOW_HOURS}h window the
              contract applies its configured default,{" "}
              <span className="font-mono">{AUTO_RESOLVE_DEFAULT}</span>, and{" "}
              <span className="font-medium">
                who raised it makes no difference to the money
              </span>
              . The reward splits 50/50, and so does the worker&apos;s claim bond; the
              insurance premium returns whole to the poster.
            </li>
            <li>
              Under the {DEFAULT_DISPUTE_WINDOW_HOURS}-hour default, a dispute can only lose a
              worker money: they end up with half the reward instead of all of it, and half of
              their claim bond. For the poster, an unruled dispute recovers half the reward and
              half the worker&apos;s bond, and the premium comes back as it always does. An
              arbiter&apos;s ruling can go either way. Once it is raised, neither side has an
              on-chain counter-move. Settle disagreements off-chain first if you can.
            </li>
          </ul>
          {/* The statement. Optional on purpose: the on-chain method takes an
              Option<Hash> and a raiser who wants to say nothing should be able
              to raise anyway rather than be blocked by a form. But it is the
              only place either party can put their side on the record, and the
              other party is on a clock, so it is offered by default. */}
          <div className="space-y-1.5">
            <Label htmlFor="dispute-evidence" className="text-sm font-medium">
              What went wrong? <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="dispute-evidence"
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              maxLength={DISPUTE_EVIDENCE_MAX_CHARS}
              rows={4}
              placeholder="What was delivered, what the brief asked for, and where they differ."
              className="text-sm"
            />
            <p className="text-xs text-muted-foreground">
              A hash of this text is written into the dispute transaction, and the
              text itself is stored here so the other party and any arbiter can
              read it. That means it is public and permanent: anyone can check
              the text against the hash on the ledger, so it cannot be quietly
              edited later — by them or by us. Leave it blank to raise the
              dispute with no statement attached.{" "}
              <span className="font-mono">
                {normalizeDisputeEvidence(evidence).length}/{DISPUTE_EVIDENCE_MAX_CHARS}
              </span>
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Keep talking
            </Button>
            <Button variant="destructive" onClick={() => runGuarded(handleDispute)}>
              <AlertTriangle className="mr-2 h-4 w-4" />
              Raise dispute anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Finalize Dispute (auto_resolve_dispute) — disputed tasks, post-window ──────

export function FinalizeDisputeButton({
  taskDbId,
  onChainTaskId,
  posterId,
  workerId,
  disputedAt,
  onSuccess,
}: {
  taskDbId: number
  onChainTaskId: number | null
  posterId: string
  workerId: string | null
  /**
   * The dispute time: the task's persisted on-chain disputedAt, with the
   * caller falling back to updatedAt for rows disputed before that column
   * shipped (approximation only). Display-only either way: the CHAIN enforces
   * the real 72h window off its own disputed_at.
   */
  disputedAt: Date | null
  onSuccess?: (txId: string) => void
}) {
  const { account, rdt, ensureSessionDetailed, sessionMismatch } = useWallet()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [txId, setTxId] = useState("")
  // Re-render each minute while the window countdown is showing.
  const [now, setNow] = useState(() => Date.now())
  const [summary, setSummary] = useState<string | undefined>(undefined)
  const walletWait = useWalletWaitHint()
  const runGuarded = useTxGuard({
    reset: () => setSummary(undefined),
    onThrow: (e) => {
      setSummary(TX_BACKSTOP)
      setError(errText(e))
      setLoading(false)
    },
  })
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  // Same launch gate as RaiseDisputeButton. Under pull the finalize manifest
  // routes nothing (the H1 class is structurally gone). P3-3/DB-5 opened the
  // dispute surface on the new component 2026-08-27, gated on the task-3
  // auto-resolve probe settling as predicted (docs/PROJECT-STATE.md,
  // 2026-08-26 "TASK 3 SETTLED") — and sendAutoResolveTx refuses the push era
  // regardless.
  if (!isEnabled("disputes")) return null
  if (!isEscrowDeployed()) return null
  if (!account || !rdt) return null
  if (onChainTaskId == null || !workerId) return null
  // On-chain auto_resolve_dispute is PUBLIC (any keeper may settle after the
  // window) — but keep the UI surface to the task's two parties for now; the
  // automated keeper cron picks up the rest later.
  if (account !== posterId && account !== workerId) return null
  if (sessionMismatch) return <SessionMismatchAlert />

  // Before (disputedAt + 72h) the chain would reject the call anyway, so
  // disable the button with a countdown.
  const windowEndsMs = disputedAt
    ? disputedAt.getTime() + DEFAULT_DISPUTE_WINDOW_HOURS * 3600 * 1000
    : 0
  const remainingHours = Math.max(0, Math.ceil((windowEndsMs - now) / 3600_000))
  const windowOpen = remainingHours === 0

  async function handleFinalize() {
    setLoading(true)
    setError("")
    // Session is needed for the post-tx confirm (withAuth). Establish it
    // BEFORE the on-chain tx so we don't spend gas on a tx the DB can't then
    // confirm. No-op if already signed in.
    const gate = await walletWait.during(ensureSessionDetailed())
    if (!gate.ok) {
      setSummary(signInIncomplete(SIGN_IN_LEAD.finalize, gate))
      setError(gate.detail ?? "")
      setLoading(false)
      return
    }
    // Live-state pre-flight (APPROVE_NOT_SUBMITTED's doc says why): an
    // arbiter's ruling or another party's finalize may have settled it.
    const live = await readEscrowTaskState(onChainTaskId!, ESCROW_COMPONENT)
    if (live != null && live !== "Disputed") {
      const resync = await resyncEscrowTask(taskDbId)
      if (resync.ok && resync.applied > 0) {
        onSuccess?.("")
        setLoading(false)
        return
      }
      setSummary(FINALIZE_NOT_DISPUTED)
      setLoading(false)
      return
    }
    // PULL: no ledger pre-reads. The push-era flow re-read the exact amounts
    // and the raiser from chain because the caller routed the settlement;
    // under pull the component credits both entitlements itself, so the only
    // input is the task id and there is nothing to verify before routing.
    const result = await walletWait.during(sendAutoResolveTx({
      taskId: onChainTaskId!,
      rdt: rdt!,
    }))
    if (!result.ok) {
      const failure = result.error ?? "Auto-resolve failed"
      if (humanizeTxError(failure).staleState) {
        const resync = await resyncEscrowTask(taskDbId)
        if (resync.ok && resync.applied > 0) {
          onSuccess?.("")
          setLoading(false)
          return
        }
      }
      setError(failure)
      setLoading(false)
      return
    }
    const confirm = await confirmEscrowTx(taskDbId, "resolve", result.txId!)
    if (!confirm.ok) {
      setError(`Settled on-chain, but syncing status failed: ${confirm.error}. Refresh shortly.`)
      setLoading(false)
      return
    }
    setTxId(result.txId!)
    onSuccess?.(result.txId!)
    setLoading(false)
  }

  if (txId) return <TxSuccess label="Dispute finalized — funds settled." txId={txId} />

  return (
    <div className="space-y-2">
      <Button
        onClick={() => runGuarded(handleFinalize)}
        disabled={loading || !windowOpen}
        variant="outline"
        className="w-full"
      >
        <Gavel className="mr-2 h-4 w-4" />
        {loading
          ? "Finalizing..."
          : windowOpen
            ? "Finalize Dispute (auto-resolve)"
            : `Finalize available in ~${remainingHours}h`}
      </Button>
      <p className="text-xs text-muted-foreground">
        {windowOpen
          ? `Settles the dispute with the contract's default ruling. Who raised it
             makes no difference to the money: the reward and the claim bond each
             split 50/50, and the insurance premium returns whole to the poster. The chain enforces the
             real ${DEFAULT_DISPUTE_WINDOW_HOURS}h window — a too-early transaction
             fails and still costs the network fee.`
          : `The ${DEFAULT_DISPUTE_WINDOW_HOURS}h dispute window is still open
             (estimated from the dispute time). The chain enforces the exact
             window — a too-early transaction fails and still costs the network
             fee.`}
      </p>
      {loading && walletWait.slow && (
        <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
          {walletWaitHint(WAIT_CLOSING.finalize)}
        </p>
      )}
      <TxError error={error} summary={summary} />
    </div>
  )
}

// ── Withdraw (withdraw_worker / withdraw_poster) — PULL collection, §5c ────────

/**
 * Renders what a party is owed, ONE AMOUNT PER LANE, never a total.
 *
 * The reward and bond lanes are different resources (bond is always XRD; reward
 * is the task's reward token), so adding them is only safe while this app pins
 * the reward token to XRD — which `add_accepted_token` on the component means is
 * an assumption, not a law. `outstandingForParty` used to return the sum and
 * this component labelled it "XRD".
 *
 * The amounts are passed to formatXrdUsd as STRINGS: they arrive from the chain
 * at up to 18dp, and Number() on those does not round, it invents digits.
 */
function OutstandingAmount({
  outstanding,
  usdRate,
}: {
  outstanding: PartyOutstanding
  usdRate: number | null
}) {
  const lanes = outstandingLanes(outstanding)
  const label = (lane: "reward" | "bond") =>
    lane === "reward"
      ? formatXrdUsd(outstanding.reward, usdRate)
      : `${formatXrdUsd(outstanding.bondXrd, usdRate)} claim bond`
  return <>{lanes.map(label).join(" + ")}</>
}

/**
 * Collect a settled entitlement.
 *
 * ⚠️ Rendered WITHOUT a task-status condition, on purpose. Under pull an
 * entitlement outlives the lifecycle: a worker's reward is owed while the task
 * reads `paid`, a poster's refund while it reads `cancelled`, a poster's
 * forfeited claim bond while it reads `open` again after an expire. Gating this
 * on status would hide the money on precisely the rows that owe it — the same
 * regression chunk E refused in the drift watcher. The CHAIN decides; see
 * resolveWithdrawAffordance.
 *
 * Against a pre-pull component this renders NOTHING and says nothing, because
 * settlement there PUSHES funds and there is genuinely nothing to collect. It
 * self-activated at the PULL cutover (2026-08-17), when the entitlement fields
 * started existing; the live Wave B component carries them too.
 */
export function EscrowWithdrawButton({
  taskDbId,
  onChainTaskId,
  onSuccess,
}: {
  taskDbId: number
  onChainTaskId: number | null
  onSuccess?: (txId: string) => void
}) {
  const { account, rdt, ensureSessionDetailed, sessionMismatch } = useWallet()
  const { rate: usdRate } = useXrdUsd()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [txId, setTxId] = useState("")
  const [summary, setSummary] = useState<string | undefined>(undefined)
  const walletWait = useWalletWaitHint()
  const runGuarded = useTxGuard({
    reset: () => setSummary(undefined),
    onThrow: (e) => {
      setSummary(TX_BACKSTOP)
      setError(errText(e))
      setLoading(false)
    },
  })
  // Hooks must run unconditionally — the early returns come after.
  // This one does NOT fail open. See the `status === "error"` branch below.
  const { info, status: infoStatus, reload: reloadInfo } = useOnChainTaskInfo(onChainTaskId)

  const affordance = resolveWithdrawAffordance(info, account ?? null, {
    memberBadge: BADGE_NFT,
    agentBadge: AGENT_BADGE_NFT,
    taskReceipt: ESCROW_RECEIPT_RESOURCE,
  })

  if (!isEscrowDeployed()) return null
  if (!rdt) return null

  if (onChainTaskId == null) return null

  // ⚠️ The one branch that must come BEFORE `kind === "none"`.
  //
  // A failed Gateway read resolves to `{ kind: "none", reason: "unknown" }` —
  // the same shape as `nothing-owed`. Returning null for both is what made an
  // entitlement genuinely owed to this viewer render identically to no
  // entitlement at all: no button, no error, nothing to go looking for. Under
  // pull that is money sitting uncollected because a network blip was silent.
  //
  // We do NOT guess which it was. We say we could not tell, and offer a retry.
  if (infoStatus === "error") {
    return (
      <LoadFailed
        what="what this task owes you"
        onRetry={reloadInfo}
      />
    )
  }

  if (affordance.kind === "none") return null

  // Owed, but this client can't build a working proof. Say so rather than
  // rendering nothing: a silent gap on a task that owes you money is the one
  // outcome with nothing to tell the payee to go looking.
  if (affordance.kind === "blocked") {
    return (
      <Alert className="border-amber-500/40 bg-amber-500/10">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription className="text-xs text-amber-700 dark:text-amber-400">
          <span className="font-medium">
            <OutstandingAmount outstanding={affordance.outstanding} usdRate={usdRate} /> is settled and
            waiting for you.
          </span>{" "}
          {explainWithdrawBlocker(affordance.reason)}
        </AlertDescription>
      </Alert>
    )
  }

  if (sessionMismatch) return <SessionMismatchAlert />

  async function handleWithdraw() {
    if (affordance.kind !== "collect") return
    setLoading(true)
    setError("")
    // Session is needed for the post-tx resync (POST /tasks/[id]/escrow/resync
    // is withAuth). Establish it BEFORE the on-chain tx, same as every other
    // action here, so we don't spend gas on a collection the DB can't record.
    const gate = await walletWait.during(ensureSessionDetailed())
    if (!gate.ok) {
      setSummary(signInIncomplete(SIGN_IN_LEAD.withdraw, gate))
      setError(gate.detail ?? "")
      setLoading(false)
      return
    }
    const result = await walletWait.during(sendWithdrawTx(
      affordance.party === "worker"
        ? {
            escrowComponent: ESCROW_COMPONENT,
            account: account!,
            taskId: onChainTaskId!,
            party: "worker",
            badgeResource: affordance.badgeResource,
            badgeLocalId: affordance.badgeLocalId,
            rdt: rdt!,
          }
        : {
            escrowComponent: ESCROW_COMPONENT,
            account: account!,
            taskId: onChainTaskId!,
            party: "poster",
            receiptResource: affordance.receiptResource,
            rdt: rdt!,
          },
    ))
    if (!result.ok) {
      setError(result.error ?? "Collection failed")
      setLoading(false)
      return
    }
    // NOT confirmEscrowTx: a withdrawal is not an EscrowConfirmKind and advances
    // no task status (chunk B). It is proven by its own WithdrawalEvent, which
    // the resync scanner ingests into the entitlement ledger. A failure here
    // costs only ledger freshness — the money has already moved on-chain — so
    // it is reported as a note, never as a failed collection.
    const resync = await resyncEscrowTask(taskDbId)
    if (!resync.ok) {
      setError(`Collected on-chain, but recording it failed: ${resync.error}. Refresh shortly.`)
    }
    setTxId(result.txId!)
    onSuccess?.(result.txId!)
    setLoading(false)
  }

  const amount = <OutstandingAmount outstanding={affordance.outstanding} usdRate={usdRate} />

  if (txId) return <TxSuccess label="Collected — the funds are in your account." txId={txId} />

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
        <Wallet className="mr-1 inline h-3 w-3" />
        <span className="font-medium">{amount} is settled and waiting for you.</span>{" "}
        {affordance.party === "worker"
          ? settlementCopy("collectWorkerNote")
          : // Poster-side credits in lib.rs: insurance (approve / timeout release),
            // reward + insurance (cancel, RefundPoster), and a share of the bond
            // only via a dispute — an arbiter's ruling or the unruled default,
            // both split it like the reward (W5). expire_claim credits the poster
            // NOTHING — the old "a forfeited claim bond" here was false.
            "This covers everything the escrow owes you on this task: your insurance, a refunded reward, or your share of the worker's claim bond after a dispute."}
      </div>
      <Button onClick={() => runGuarded(handleWithdraw)} disabled={loading} className="w-full">
        <Wallet className="mr-2 h-4 w-4" />
        {loading ? "Collecting..." : `Collect ${amount}`}
      </Button>
      <p className="text-xs text-muted-foreground">
        Costs only the network fee. The escrow sends the funds to the account it
        recorded for you when the task was {affordance.party === "worker" ? "claimed" : "posted"} —
        the amount and destination are set on-chain, not by this page.
      </p>
      {loading && walletWait.slow && (
        <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
          {walletWaitHint(WAIT_CLOSING.withdraw)}
        </p>
      )}
      <TxError error={error} summary={summary} />
    </div>
  )
}

// ── Resync from chain (per-task reconcile) — any signed-in viewer ──────────────

// ── Deliver someone else's settled entitlement (push_entitlement) ────────────

/**
 * Pay a party who has not collected — on anyone's call.
 *
 * 🔴 WHY A STRANGER'S BUTTON. Under PULL, collection is a separate signed step,
 * so a payee who never notices it — or who has LOST the badge or receipt that
 * authorises it — leaves settled funds in the component with no remedy. There
 * is no admin override anywhere in the blueprint, and both credentials are
 * permanently transferable bearer instruments. On mainnet task 1 the poster
 * completed the whole walk and did not notice Collect; a lost credential is the
 * worse version of the same thing.
 *
 * The blueprint's `push_entitlement` exists for exactly this and, until now, had
 * no caller anywhere — the same gap `expire_claim` had.
 *
 * Safe to offer to anyone because there is no destination argument: the
 * blueprint pays the account pinned at claim/create. The caller spends a network
 * fee to pay somebody else.
 *
 * Renders only when the CHAIN says a party is owed something. Fails closed —
 * an unreadable chain shows nothing rather than an action we cannot justify.
 */
export function EscrowPushEntitlementButton({
  onChainTaskId,
  party,
  onSuccess,
}: {
  onChainTaskId: number | null
  party: "worker" | "poster"
  onSuccess?: (txId: string) => void
}) {
  const { account, rdt, sessionMismatch } = useWallet()
  const { info } = useOnChainTaskInfo(onChainTaskId)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [txId, setTxId] = useState("")
  const [summary, setSummary] = useState<string | undefined>(undefined)
  const walletWait = useWalletWaitHint()
  const runGuarded = useTxGuard({
    reset: () => setSummary(undefined),
    onThrow: (e) => {
      setSummary(TX_BACKSTOP)
      setError(errText(e))
      setLoading(false)
    },
  })

  if (!isEscrowDeployed() || onChainTaskId == null) return null
  if (!info) return null
  const outstanding = outstandingForParty(info, party)
  if (!outstanding) return null
  const lanes = outstandingLanes(outstanding)
  if (lanes.length === 0) return null
  if (!account || !rdt) return null
  if (sessionMismatch) return <SessionMismatchAlert />

  async function handlePush() {
    await runGuarded(async () => {
      setLoading(true)
      setError("")
      // No ensureSession: this is a pure chain action with nothing to confirm
      // server-side, and requiring an account would re-close what the blueprint
      // deliberately left open to anyone.
      const res = await walletWait.during(sendPushEntitlementTx({
        taskId: onChainTaskId!,
        party,
        rdt: rdt!,
      }))
      if (res.ok && res.txId) {
        setTxId(res.txId)
        onSuccess?.(res.txId)
      } else {
        setError(res.error || "Push failed")
      }
      setLoading(false)
    })
  }

  if (txId)
    return <TxSuccess label={`Paid the ${party} their settled entitlement.`} txId={txId} />

  return (
    <div className="space-y-2">
      <Button size="sm" variant="outline" disabled={loading} onClick={handlePush}>
        <Send className="mr-1.5 h-3.5 w-3.5" />
        {loading ? "Delivering…" : `Deliver the ${party}'s payout`}
      </Button>
      <p className="text-[11px] text-muted-foreground">
        The {party} has funds settled in escrow that they have not collected. Anyone can
        deliver them — the escrow pays the account pinned when the task was created or
        claimed, so this cannot send the money anywhere else.{" "}
        <span className="font-medium">You pay only the network fee.</span>
      </p>
      {loading && walletWait.slow && (
        <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
          {walletWaitHint(WAIT_CLOSING.push)}
        </p>
      )}
      <TxError error={error} summary={summary} />
    </div>
  )
}

export function EscrowResyncButton({
  taskDbId,
  onChainTaskId,
  onSynced,
}: {
  taskDbId: number
  onChainTaskId: number | null
  /** Called when the resync applied at least one missed confirm. */
  onSynced?: () => void
}) {
  const { account, rdt, ensureSessionDetailed } = useWallet()
  const [loading, setLoading] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [summary, setSummary] = useState<string | undefined>(undefined)
  const walletWait = useWalletWaitHint()
  const runGuarded = useTxGuard({
    reset: () => setSummary(undefined),
    onThrow: (e) => {
      setSummary(TX_BACKSTOP)
      setError(errText(e))
      setLoading(false)
    },
  })

  if (!isEscrowDeployed()) return null
  if (!account || !rdt) return null
  if (onChainTaskId == null) return null // nothing on-chain to sync from

  // Deliberately NOT blocked on sessionMismatch: resync only pulls the DB
  // toward chain truth (the server re-verifies every event), and it is the
  // recovery tool for exactly the tangled-session situations the smoke hit.
  // ensureSession() below re-auths to the connected account first anyway.
  async function handleResync() {
    setLoading(true)
    setError("")
    setNote(null)
    const gate = await walletWait.during(ensureSessionDetailed())
    if (!gate.ok) {
      setSummary(signInIncomplete(SIGN_IN_LEAD.resync, gate))
      setError(gate.detail ?? "")
      setLoading(false)
      return
    }
    const result = await resyncEscrowTask(taskDbId)
    if (!result.ok) {
      setError(result.error ?? "Resync failed")
      setLoading(false)
      return
    }
    if (result.applied > 0) {
      setNote(`Re-synced ${result.applied} step${result.applied === 1 ? "" : "s"} from chain.`)
      onSynced?.()
    } else if (result.pending.length > 0) {
      setNote(result.pending[0].reason)
    } else {
      setNote("Already in sync with the chain.")
    }
    setLoading(false)
  }

  return (
    <div className="space-y-2">
      <Button
        onClick={() => runGuarded(handleResync)}
        disabled={loading}
        variant="ghost"
        size="sm"
        className="w-full text-muted-foreground"
      >
        <RefreshCw className={`mr-2 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        {loading ? "Checking the chain..." : "Resync from chain"}
      </Button>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      {loading && walletWait.slow && (
        <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
          {walletWaitHint(WAIT_CLOSING.resync)}
        </p>
      )}
      <TxError error={error} summary={summary} />
    </div>
  )
}

// ── Expire Claim (expire_claim) — PUBLIC, time-gated, ANY signed-in caller ────
//
// Operator ruling 2026-08-29 (docs/PROJECT-STATE.md): expire_claim is PUBLIC
// on-chain and pays its bounty to whoever calls it, so this surface is NOT
// restricted to the task's poster or worker the way FinalizeDisputeButton
// restricts auto_resolve_dispute — any signed-in viewer may call it, matching
// EscrowResyncButton's "any signed-in viewer" posture. This is UI-only: no
// keeper/cron is added here, the standing decision stays watch-only.

// Wave B deleted the flat "up to 1 XRD" bounty this copy used to quote (that
// was ~a tenth of a cent of the pre-Wave-B flat bond, never actually
// collected) — expire_claim's caller bounty is now `expire_bounty_pct` of the
// forfeited bond, UNCAPPED (docs/ESCROW-PARAMETER-SHEET.md row 14: 0.10).
// There is no live/derived read for this field to prefer: readClaimBondParams
// (lib/gateway.ts) surfaces only claim_bond_pct/floor/cap, and
// `grep -rn 'expire_bounty|EXPIRE_BOUNTY|expireBounty' guild-app/src` turns up
// nothing but the generated deploy-time literal at
// lib/generated/instantiate-spec.ts (an instantiate arg, not a chain read) —
// so this is the UI's own named copy of the signed sheet value.
const EXPIRE_BOUNTY_PCT = "0.10"

/**
 * 10% of an already-exact bond STRING (requiredBond / formatAttos,
 * lib/manifests.ts) — done in integer attos, same shape as requiredBond
 * itself, so this copy states what the contract will actually pay out.
 * Reusing Number() here would reintroduce the float residue that function's
 * own comment warns about.
 *
 * Also rounds DOWN to `divisibility`, matching expire_claim's own rounding
 * (lib.rs ~1759-1761: `(forfeited_amount * expire_bounty_pct).checked_round(
 * token_divisibility, RoundingMode::ToZero)`). `bond` is already rounded to
 * the reward token's divisibility (requiredBond), but 10% of a
 * divisibility-rounded amount need not itself land on that divisibility's
 * smallest unit — e.g. a bond of 10.03 at divisibility 2 has a bounty of
 * 1.003, which isn't representable at 2dp. Without this step the copy could
 * show more decimal digits than the token supports, and a number LARGER than
 * what the contract will actually pay (ToZero always rounds down).
 */
function expireBountyFromBond(bond: string, divisibility: number): string {
  const ONE = BigInt(10) ** BigInt(18)
  const scale = (v: string): bigint => {
    const [whole, frac = ""] = v.split(".")
    return BigInt(whole + frac.padEnd(18, "0").slice(0, 18))
  }
  const attos = (scale(bond) * scale(EXPIRE_BOUNTY_PCT)) / ONE
  const divisor = BigInt(10) ** BigInt(18 - divisibility)
  const roundedAttos = attos - (attos % divisor)
  const whole = roundedAttos / ONE
  const frac = (roundedAttos % ONE).toString().padStart(18, "0").replace(/0+$/, "")
  return frac ? `${whole}.${frac}` : String(whole)
}

export function ExpireClaimButton({
  taskDbId,
  onChainTaskId,
  onSuccess,
}: {
  taskDbId: number
  onChainTaskId: number | null
  onSuccess?: (txId: string) => void
}) {
  const { account, rdt, ensureSessionDetailed, sessionMismatch } = useWallet()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [txId, setTxId] = useState("")
  const [summary, setSummary] = useState<string | undefined>(undefined)
  const walletWait = useWalletWaitHint()
  const runGuarded = useTxGuard({
    reset: () => setSummary(undefined),
    onThrow: (e) => {
      setSummary(TX_BACKSTOP)
      setError(errText(e))
      setLoading(false)
    },
  })
  // Hooks must run unconditionally — the early returns come after.
  const { info } = useOnChainTaskInfo(onChainTaskId)
  // Wave B deleted the flat `claim_bond_xrd` field ESCROW_CLAIM_BOND_XRD used
  // to mirror — the bond is a share of THIS task's own reward now, so derive
  // it live (same read sendClaimTx uses). No number renders until it resolves.
  const { bond, divisibility } = useClaimBond(onChainTaskId)
  const [now, setNow] = useState(() => Date.now())

  // Same estimate-and-tick shape as ClaimDeadlineNotice (escrow-truth.tsx):
  // claim_deadline is read once at mount (no polling) and the countdown is an
  // ESTIMATE against that snapshot, so only tick while there is a live
  // Claimed deadline to watch for.
  const active = info?.state === "Claimed" && !!info.claimDeadline
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [active])

  if (!isEscrowDeployed()) return null
  if (!account || !rdt) return null
  if (onChainTaskId == null) return null // not funded on-chain yet
  // Fails OPEN, like ClaimDeadlineNotice above it on the page: a Gateway
  // hiccup shows no button rather than a wrong one. This is an opportunity to
  // earn a bounty, not money owed to the viewer, so there is no
  // EscrowWithdrawButton-style "blocked" case to surface here.
  if (!info || info.state !== "Claimed" || !info.claimDeadline) return null
  const passed = info.claimDeadline.getTime() <= now
  if (!passed) return null // not overdue yet — ClaimDeadlineNotice covers the countdown
  if (sessionMismatch) return <SessionMismatchAlert />

  async function handleExpire() {
    setLoading(true)
    setError("")
    // Session is needed for the post-tx resync (POST /tasks/[id]/escrow/resync
    // is withAuth). Establish it BEFORE the on-chain tx, same as every other
    // action here, so we don't spend gas on an expiry the DB can't then record.
    const gate = await walletWait.during(ensureSessionDetailed())
    if (!gate.ok) {
      setSummary(signInIncomplete(SIGN_IN_LEAD.expire, gate))
      setError(gate.detail ?? "")
      setLoading(false)
      return
    }
    const result = await walletWait.during(sendExpireClaimTx({
      escrowComponent: ESCROW_COMPONENT,
      account: account!,
      taskId: onChainTaskId!,
      rdt: rdt!,
    }))
    if (!result.ok) {
      setError(result.error ?? "Expire claim failed")
      setLoading(false)
      return
    }
    // NOT confirmEscrowTx: 'expire' is not a confirmable EscrowConfirmKind —
    // expire_claim is public on-chain, so the sender need not be a party, and
    // ROUTE_KINDS excludes it (escrow-confirm.ts: "resync the task from chain
    // instead"). Recovery is resync, the same path EscrowWithdrawButton uses
    // for its own non-confirm on-chain event.
    const resync = await resyncEscrowTask(taskDbId)
    if (!resync.ok) {
      setError(`Expired on-chain, but syncing status failed: ${resync.error}. Refresh shortly.`)
    }
    setTxId(result.txId!)
    onSuccess?.(result.txId!)
    setLoading(false)
  }

  if (txId) return <TxSuccess label="Claim expired — the task is open again." txId={txId} />

  // Never falls back to a guessed number: while the derivation is loading (or
  // fails) this reads "the claimer's claim bond", not a flat/stale figure.
  const bondLabel = bond != null ? `${bond} XRD claim bond` : "claim bond"
  // Same contract as bondLabel: no number until the bond it's a share of AND
  // the divisibility it must be rounded to (expireBountyFromBond) have both
  // resolved — never a number computed at an assumed 18dp.
  const bounty = bond != null && divisibility != null ? expireBountyFromBond(bond, divisibility) : null
  const bountyLabel = bounty != null ? `${bounty} XRD (10% of that bond)` : "10% of that bond"
  // The button renders from the deadline itself, but expire_claim refuses until
  // deadline + expire_grace_secs (lib.rs; display mirror in config.ts), so the
  // copy says so rather than offer an expiry the chain will reject.
  const graceHours = ESCROW_EXPIRE_GRACE_SECS / 3600

  return (
    <div className="space-y-2">
      <Button
        onClick={() => runGuarded(handleExpire)}
        disabled={loading}
        variant="outline"
        className="w-full text-destructive hover:text-destructive"
      >
        <AlertTriangle className="mr-2 h-4 w-4" />
        {loading ? "Expiring claim..." : "Expire overdue claim"}
      </Button>
      <p className="text-xs text-muted-foreground">
        This claim&apos;s submit deadline has passed. Expiring it reopens the task for
        someone else to claim and forfeits the claimer&apos;s {bondLabel} — a bounty of{" "}
        {bountyLabel} is paid to whoever calls this, the rest goes to the operator
        pool. Anyone signed in can call it, not just the poster or worker. The chain refuses it
        until {graceHours === 1 ? "an hour" : `${graceHours} hours`} after the deadline — a
        too-early transaction fails and still costs the network fee.
      </p>
      {loading && walletWait.slow && (
        <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
          {walletWaitHint(WAIT_CLOSING.expire)}
        </p>
      )}
      <TxError error={error} summary={summary} />
    </div>
  )
}
