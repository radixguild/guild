"use client"

// Worker-truth notices sourced from LIVE on-chain TaskInfo (P2 U2 + U3). Both
// facts the worker most needs — the bond-at-risk claim deadline and who raised a
// dispute — live only on-chain (the DB never stores them), so read them live and
// fail open: a Gateway hiccup shows no notice rather than a wrong one.

import { useEffect, useState } from "react"
import { settlementCopy } from "@/lib/settlement-copy";
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertTriangle, Clock, Gavel } from "lucide-react"
import { useOnChainTaskInfo } from "@/hooks/useOnChainTaskInfo"
import { useClaimBond } from "@/hooks/useClaimBond"
import { formatRemaining } from "@/lib/countdown"
import { DEFAULT_DISPUTE_WINDOW_HOURS } from "@/lib/marketplace"
import { ESCROW_EXPIRE_GRACE_SECS } from "@/lib/config"

const TICK_MS = 30_000

/**
 * Bond-at-risk notice for a Claimed (DB: assigned) task (U2). The worker posted
 * a claim bond and must submit before the on-chain claim_deadline; from
 * expire_grace_secs (an hour, read live by the contract) after it, anyone can
 * call the PUBLIC expire_claim and forfeit the bond. That deadline is
 * on-chain only (fixed at claim = claim_time + the human or agent submit
 * deadline; DB-3 removed heartbeat, so nothing extends it), so it is read live —
 * the DB has no column for it.
 */
export function ClaimDeadlineNotice({ onChainTaskId }: { onChainTaskId: number | null }) {
  // Fails OPEN on purpose: this renders a notice, not money. A Gateway
  // hiccup should show nothing rather than something wrong. The withdraw
  // affordance makes the opposite choice — see useOnChainTaskInfo.
  const { info } = useOnChainTaskInfo(onChainTaskId)
  // Wave B deleted the flat `claim_bond_xrd` field this used to read via the
  // ESCROW_CLAIM_BOND_XRD constant — the bond is a share of THIS task's own
  // reward now, so it must be derived live (same read sendClaimTx uses). No
  // number renders until the derivation resolves; a Gateway miss leaves it
  // unresolved rather than falling back to a guess.
  const { bond } = useClaimBond(onChainTaskId)
  const [now, setNow] = useState(() => Date.now())

  // The claim_deadline is read ONCE at mount (no polling) and the countdown is
  // an ESTIMATE against that snapshot — a submit or an expire can end the claim
  // without this notice re-reading. So only tick while there is a
  // live deadline to count down (no ticking an empty subtree when the task
  // isn't Claimed), and the lapsed copy is hedged accordingly below.
  const active = info?.state === "Claimed" && !!info.claimDeadline
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(t)
  }, [active])

  if (!info || info.state !== "Claimed" || !info.claimDeadline) return null

  const remaining = info.claimDeadline.getTime() - now
  // Never falls back to a guessed number: while the derivation is loading (or
  // fails) this reads "your claim bond", not a flat/stale figure.
  const bondLabel = bond != null ? `your ${bond} XRD claim bond` : "your claim bond"
  const passed = remaining <= 0
  // expire_claim refuses until deadline + expire_grace_secs (lib.rs; 3600 live,
  // display mirror in config.ts) — the same grace the "Before you claim" terms
  // state. Saying "anyone can expire" AT the deadline was off by that hour.
  const graceHours = ESCROW_EXPIRE_GRACE_SECS / 3600
  const grace = graceHours === 1 ? "an hour" : `${graceHours} hours`

  return (
    <Alert
      variant={passed ? "destructive" : "default"}
      className={passed ? undefined : "border-amber-500/40 bg-amber-500/10"}
    >
      {passed ? <AlertTriangle className="h-4 w-4" /> : <Clock className="h-4 w-4" />}
      <AlertDescription
        className={passed ? "text-xs" : "text-xs text-amber-700 dark:text-amber-400"}
      >
        {passed ? (
          <>
            <span className="font-medium">Claim deadline reached</span> (estimated from the
            last on-chain read). Submit now — {grace} after it truly lapses, anyone can call{" "}
            <span className="font-mono">expire_claim</span> and forfeit {bondLabel}. The
            chain enforces the exact time; use Resync from chain to refresh{" "}
            {settlementCopy("escrowTruthCountdownCaveat")}.
          </>
        ) : (
          <>
            <span className="font-medium">Bond at risk:</span> submit within{" "}
            <span className="font-mono">{formatRemaining(remaining)}</span>; {grace} after that,
            anyone can expire this claim and forfeit {bondLabel}. Submitting your work
            on-chain ends that risk — the bond then stays in escrow until the task settles.
          </>
        )}
      </AlertDescription>
    </Alert>
  )
}

/**
 * Dispute-raiser + outcome notice for a Disputed task (U3). The raiser is
 * on-chain (dispute_raised_by); the ledger records it, it just wasn't surfaced.
 *
 * The copy must state the outcome the DEPLOYED component actually applies. Its
 * dispute_auto_resolve_default is SplitEvenly, so on a lapsed window the pot is
 * split 50/50 — under that default the worker can only lose by it, and the
 * poster recovers half the reward and half the worker's bond (2026-09-24:
 * "raising a dispute does not win it" was false for a poster, and "a worker
 * can only lose" is false once an arbiter rules for the worker — that pays the
 * reward, the insurance AND the bond). This previously promised
 * winner-take-all, which is the opposite advice: it told the non-raiser they
 * would get nothing, inviting them to concede off-chain a claim they'd half-win.
 * If the component is ever reconfigured, this copy must move with it.
 */
export function DisputeRaiserNotice({ onChainTaskId }: { onChainTaskId: number | null }) {
  // Fails OPEN on purpose: this renders a notice, not money. A Gateway
  // hiccup should show nothing rather than something wrong. The withdraw
  // affordance makes the opposite choice — see useOnChainTaskInfo.
  const { info } = useOnChainTaskInfo(onChainTaskId)
  if (!info || info.state !== "Disputed" || !info.disputeRaisedBy) return null

  const raiser = info.disputeRaisedBy // "poster" | "worker"

  return (
    <Alert className="border-orange-500/40 bg-orange-500/10">
      <Gavel className="h-4 w-4" />
      <AlertDescription className="space-y-1 text-xs text-orange-700 dark:text-orange-400">
        <p>
          <span className="font-medium">Dispute raised by the {raiser}.</span>
        </p>
        <p>
          A human arbiter can rule this — an operator ceremony with no promised turnaround, not
          a button. If nobody rules, anyone can settle it after the{" "}
          {DEFAULT_DISPUTE_WINDOW_HOURS}h window by the default: the{" "}
          <span className="font-medium">reward</span> splits evenly between both parties, the
          worker&apos;s claim bond splits the same way, and the insurance returns whole to the
          poster, whoever raised it. Under the {DEFAULT_DISPUTE_WINDOW_HOURS}-hour default, a
          dispute can only lose a worker money: they end up with half the reward instead of all
          of it. For the poster, an unruled dispute recovers half the reward and half the
          worker&apos;s bond. Settle off-chain if you can.
        </p>
      </AlertDescription>
    </Alert>
  )
}
