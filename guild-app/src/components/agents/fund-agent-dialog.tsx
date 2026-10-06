"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Wallet } from "lucide-react"
import type { RadixDappToolkit } from "@radixdlt/radix-dapp-toolkit"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { CopyButton } from "@/components/copy-button"
import { XrdAmount } from "@/components/XrdAmount"
import { useNetworkHalt } from "@/hooks/useNetworkHalt"
import { useWallet } from "@/hooks/useWallet"
import { signInDidNotComplete } from "@/lib/session-outcome"
import { useXrdBalance } from "@/hooks/useXrdBalance"
import { apiFetch } from "@/lib/api-fetch"
import {
  browserStorage,
  checkPairManifest,
  classifyFunded,
  forgetPendingFund,
  fundPollDelay,
  readPendingFund,
  RECENT_MANIFEST_MS,
  rememberPendingFund,
  sameXrd,
  type FundedOutcome,
} from "@/lib/agent-fund"
import { MANAGER } from "@/lib/config"
import { timeAgo } from "@/lib/time-ago"
import { pairAgainLine, pairingReleaseAt, type AgentCardData } from "@/components/agents/status"

/**
 * Headroom for the network fee in the balance pre-check only. The wallet shows
 * the real fee; this just stops an owner who plainly cannot cover the float
 * from opening the wallet at all. Never shown as a number.
 */
const FEE_HEADROOM_XRD = 1


const storage = browserStorage
type Phase =
  /** `note`: why it is waiting (e.g. the server asked to slow down). */
  | { k: "checking"; note?: string }
  | { k: "ready"; error?: string; note?: string; recheck?: boolean; pairAgain?: string }
  | { k: "working"; what: string }
  | { k: "confirming"; intentHash?: string; startedAt: number }
  | { k: "slow"; intentHash?: string }
  | { k: "done" }
  | { k: "float_short" }
  | { k: "stopped"; message: string }
  | { k: "mismatch"; reason: string }

/** Ask the Guild whether the funding landed — by the transaction, or (no hash) by what is in the agent's account. */
async function askFunded(agentId: number, intentHash?: string): Promise<FundedOutcome> {
  try {
    const res = await apiFetch(`/api/v1/agents/${agentId}/funded`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(intentHash ? { intentHash } : {}),
    })
    const body = await res.json().catch(() => null)
    return classifyFunded(res.status, body, res.headers.get("Retry-After"))
  } catch {
    return classifyFunded(0, null)
  }
}

/**
 * Send the pairing transaction. A wallet error can still carry an intent hash
 * (submitted, then failed or not polled to the end) — that transaction may
 * have landed, so it is confirmed like any other, never reported as "nothing
 * moved". Only an error with no hash means nothing was submitted.
 */
export async function sendPairTx(rdt: RadixDappToolkit, manifest: string): Promise<{ intentHash: string | null }> {
  try {
    const result = await rdt.walletApi.sendTransaction({ transactionManifest: manifest, version: 1 })
    if (result.isOk()) return { intentHash: result.value.transactionIntentHash }
    return { intentHash: result.error.transactionIntentHash ?? null }
  } catch {
    return { intentHash: null }
  }
}

/** What a settled "not funded" answer means for this dialog. */
function afterStop(o: Extract<FundedOutcome, { kind: "stop" }>, canPrepare: boolean, pairAgain: string): Phase {
  switch (o.code) {
    case "FUNDING_FLOAT_SHORT":
      return { k: "float_short" }
    case "FUNDING_NOT_FOUND":
      return { k: "ready" }
    case "FUNDING_TX_FAILED":
      // Not "the fee is spent": a transaction rejected before it committed costs no fee at all.
      // Past the 24 h window no new transaction can be prepared (the manifest route 410s), so never say "fund again" then.
      return {
        k: "ready",
        error: canPrepare
          ? "That transaction did not go through, so the float and the badge did not move. You can fund the agent again."
          : `That transaction did not go through, so the float and the badge did not move. The pairing is past its 24-hour window: ${pairAgain}.`,
      }
    case "LABEL_TAKEN":
      // Within the window: rename on the card (A2.4d), then fund. Past it,
      // renaming would not reopen funding at all.
      return { k: "stopped", message: labelTakenMessage(canPrepare, pairAgain) }
    default:
      return { k: "stopped", message: o.message }
  }
}

function labelTakenMessage(canPrepare: boolean, pairAgain: string): string {
  return canPrepare
    ? "This agent's badge name is now held by another account, so it can't be funded under that name. Close this, rename it on its card, then fund it."
    : `This agent's badge name is now held by another account, and the pairing is past its 24-hour window: ${pairAgain} and a different name.`
}

/**
 * Fund & activate (A2.3 — design §1a step 3, §3.4, §3.6): one wallet
 * transaction sends the agent its float and mints its Guild badge into its own
 * account, then the Guild confirms both arrived and activates it.
 *
 * Opening the dialog first asks whether funding already landed (a closed tab
 * mid-confirmation must not lead to a second signature). The transaction the
 * Guild builds is checked against this card before the wallet opens
 * (checkPairManifest) — a mismatch stops here, it is never signed.
 */
export function FundAgentDialog({
  agent,
  onChanged,
  onOpenChange,
  triggerLabel = "Fund & activate",
  canPrepare = true,
}: {
  agent: AgentCardData
  onChanged: () => void
  /** Tells the card the dialog is open, so the card keeps it mounted whatever the list says meanwhile. */
  onOpenChange?: (open: boolean) => void
  triggerLabel?: string
  /**
   * False once the pairing is past its 24 h window: the manifest route refuses
   * to prepare a new funding transaction then (410), so the dialog only checks
   * whether an earlier one landed and never offers "Fund & activate".
   */
  canPrepare?: boolean
}) {
  const { rdt, user, ensureSessionDetailed, sessionMismatch } = useWallet()
  const halt = useNetworkHalt()
  const { balance } = useXrdBalance(user?.id)
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>({ k: "checking" })
  const busy = useRef(false)
  // The confirm loop settles long after it started; by then the pairing may
  // have crossed its 24 h window. Read canPrepare at settle time, not start.
  const canPrepareNow = useRef(canPrepare)
  // The latest known moment a funding transaction was handed out: the card's
  // manifestIssuedAt, or one this dialog just prepared (the card only learns
  // of it on the list's next refresh). The server's hold runs 24 h from it.
  const manifestAt = useRef<number | null>(null)
  const issuedHere = useRef<number | null>(null)
  useEffect(() => {
    canPrepareNow.current = canPrepare
    manifestAt.current = agent.manifestIssuedAt ? Date.parse(agent.manifestIssuedAt) : null
  }, [canPrepare, agent.manifestIssuedAt])
  const pairAgainNow = () => {
    const known = [manifestAt.current, issuedHere.current].filter((t): t is number => t !== null && Number.isFinite(t))
    return pairAgainLine(pairingReleaseAt(known.length > 0 ? Math.max(...known) : null), Date.now())
  }

  /** What the open-time check means here. FUNDING_NOT_FOUND right after a manifest was handed out is not "never funded". */
  const afterCheck = useCallback(
    (o: FundedOutcome): Phase => {
      if (o.kind === "active") return { k: "done" }
      if (o.kind === "retry") {
        return {
          k: "ready",
          note: canPrepare
            ? "We couldn't check the chain for an earlier transaction just now. Funding is still safe to try: if an earlier one already landed, this one fails, and it can never send a second float."
            : "We couldn't check the chain just now.",
          recheck: true,
        }
      }
      const next = afterStop(o, canPrepare, pairAgainNow())
      const issued = agent.manifestIssuedAt ? Date.parse(agent.manifestIssuedAt) : Number.NaN
      if (o.code === "FUNDING_NOT_FOUND" && Date.now() - issued < RECENT_MANIFEST_MS) {
        return {
          k: "ready",
          note: canPrepare
            ? `A funding transaction for this agent was prepared ${timeAgo(agent.manifestIssuedAt!)}. If you approved it in your wallet, it may still be landing — check again before approving another. A second approval cannot send a second float, but it can cost another network fee.`
            : `A funding transaction for this agent was prepared ${timeAgo(agent.manifestIssuedAt!)}. If you approved it in your wallet, it may still be landing.`,
          recheck: true,
        }
      }
      return next
    },
    [agent.manifestIssuedAt, canPrepare],
  )

  // Each open-time check is numbered; only the latest may change the phase,
  // and only while the dialog is still in "checking" (a close and reopen, or
  // a quick retry, must not let an older answer land on a newer state).
  const checkSeq = useRef(0)
  const runCheck = () => {
    const seq = ++checkSeq.current
    setPhase({ k: "checking" })
    askFunded(agent.id).then((o) => {
      if (seq !== checkSeq.current) return
      // Rate limited: honour the server's Retry-After and ask again by
      // ourselves — never report it as the chain being unreadable, never
      // offer a button that would only earn another 429.
      if (o.kind === "retry" && o.code === "RATE_LIMITED") {
        const wait = o.retryAfterSec ?? 10
        setPhase((p) => (p.k === "checking" ? { k: "checking", note: `Checking too often — checking again in ${wait} seconds.` } : p))
        setTimeout(() => {
          if (seq === checkSeq.current) runCheck()
        }, wait * 1000)
        return
      }
      const pairAgain = pairAgainNow()
      setPhase((p) => {
        if (p.k !== "checking") return p
        const next = afterCheck(o)
        return next.k === "ready" && !canPrepare ? { ...next, pairAgain } : next
      })
      if (o.kind === "active") onChanged()
    })
  }

  const openDialog = () => {
    setOpen(true)
    // A confirmation already running keeps running: reopening must never drop
    // the one handle on a signed transaction.
    if (phase.k === "confirming" || phase.k === "slow") return
    // Signed in an earlier visit (tab closed, page reloaded)? Resume THAT one.
    const pending = readPendingFund(storage(), agent.id, Date.now())
    if (pending) {
      setPhase({ k: "confirming", intentHash: pending, startedAt: Date.now() })
      return
    }
    runCheck()
  }

  // Confirmation loop. State changes only inside timer callbacks.
  useEffect(() => {
    if (phase.k !== "confirming") return
    const { intentHash, startedAt } = phase
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      const o = await askFunded(agent.id, intentHash)
      if (cancelled) return
      if (o.kind === "active") {
        forgetPendingFund(storage(), agent.id)
        setPhase({ k: "done" })
        onChanged()
        return
      }
      if (o.kind === "stop") {
        // Settled either way (landed short, failed, or refused): nothing left to resume.
        forgetPendingFund(storage(), agent.id)
        const next = afterStop(o, canPrepareNow.current, pairAgainNow())
        setPhase(next.k === "ready" && !canPrepareNow.current ? { ...next, pairAgain: pairAgainNow() } : next)
        return
      }
      const delay = fundPollDelay(Date.now() - startedAt)
      if (delay === null) {
        setPhase({ k: "slow", intentHash })
        return
      }
      timer = setTimeout(tick, o.retryAfterSec ? Math.max(delay, o.retryAfterSec * 1000) : delay)
    }
    timer = setTimeout(tick, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [phase, agent.id, onChanged])

  const fund = async () => {
    if (!canPrepare || busy.current) return
    busy.current = true
    try {
      const owner = user?.id
      setPhase({ k: "working", what: "Checking your sign-in…" })
      const gate = await ensureSessionDetailed()
      if (!gate.ok) {
        setPhase({ k: "ready", error: signInDidNotComplete("nothing was funded", gate) })
        return
      }
      if (!owner) {
        // Signed in just now: the session is set, but this render has not seen it yet.
        setPhase({ k: "ready", note: "Signed in. Press Fund & activate again to continue." })
        return
      }
      setPhase({ k: "working", what: "Preparing the transaction…" })
      const res = await apiFetch(`/api/v1/agents/${agent.id}/manifest`, { method: "POST" })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.ok) {
        const code = body?.error?.code as string | undefined
        const message = (body?.error?.message as string | undefined) ?? `Something went wrong (HTTP ${res.status}). Try again.`
        if (res.status === 429) {
          const wait = Number(res.headers.get("Retry-After")) || 60
          setPhase({ k: "ready", error: `Too many tries. Wait ${wait} seconds and try again.` })
        } else if (code === "ALREADY_FUNDED" || code === "AGENT_WRONG_STATE") {
          // Funding already landed (or the agent moved on): let the confirm route settle it.
          setPhase({ k: "confirming", startedAt: Date.now() })
        } else if (code === "LABEL_TAKEN") {
          setPhase({ k: "stopped", message: labelTakenMessage(true, pairAgainNow()) })
          onChanged()
        } else if (code === "PAIRING_EXPIRED") {
          // Not the server's generic line: this one follows the release rule
          // (while the Guild holds the pairing, re-pairing is refused).
          const line = pairAgainNow()
          setPhase({
            k: "stopped",
            message: `This pairing has just passed its 24-hour window, so a new funding transaction can't be prepared: ${line}.`,
          })
          onChanged()
        } else if (code === "AGENT_CHANGED") {
          setPhase({ k: "stopped", message })
          onChanged()
        } else {
          setPhase({ k: "ready", error: message })
        }
        return
      }

      issuedHere.current = Date.now() // the server stamped manifestIssuedAt just now
      const d = body.data as { manifest: string; agentAccount: string; labelNorm: string; floatXrd: string }
      if (d.agentAccount !== agent.agentAccount || d.labelNorm !== agent.labelNorm || !sameXrd(d.floatXrd, agent.floatXrd)) {
        setPhase({ k: "mismatch", reason: "the Guild answered for a different agent or amount than this card shows" })
        return
      }
      const check = checkPairManifest(d.manifest, {
        manager: MANAGER,
        owner,
        agentAccount: agent.agentAccount,
        labelNorm: agent.labelNorm,
        floatXrd: agent.floatXrd,
      })
      if (!check.ok) {
        setPhase({ k: "mismatch", reason: check.reason })
        return
      }
      if (!rdt) {
        setPhase({ k: "ready", error: "Connect your Radix Wallet first." })
        return
      }

      setPhase({ k: "working", what: "Approve it in your Radix Wallet…" })
      const { intentHash } = await sendPairTx(rdt, d.manifest)
      if (intentHash) {
        rememberPendingFund(storage(), agent.id, intentHash, Date.now())
        setPhase({ k: "confirming", intentHash, startedAt: Date.now() })
      } else {
        setPhase({ k: "ready", error: "Your wallet did not send it, so nothing moved." })
      }
    } catch {
      setPhase({ k: "ready", error: "Couldn't reach the Guild. Nothing was sent to your wallet. Try again." })
    } finally {
      busy.current = false
    }
  }

  const needs = Number(agent.floatXrd) + FEE_HEADROOM_XRD
  const short = balance !== null && balance < needs
  const halted = halt.halted === true || halt.operatorHalt
  const blocked = canPrepare && (short || halted || sessionMismatch)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) openDialog()
        else {
          setOpen(false)
          checkSeq.current++ // a check (or a scheduled re-check) still out must not act on a closed dialog
        }
        onOpenChange?.(next)
      }}
    >
      <DialogTrigger render={<Button size="sm" />}>
        <Wallet className="mr-1 h-4 w-4" />
        {triggerLabel}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Fund &amp; activate {agent.label}</DialogTitle>
          <DialogDescription>
            One wallet transaction sends your agent its float and mints its Guild badge into its own account.
          </DialogDescription>
        </DialogHeader>

        {phase.k === "checking" && (
          <p role="status" aria-busy="true" className="text-sm text-muted-foreground">
            {phase.note ?? "Checking whether this agent is already funded…"}
          </p>
        )}

        {phase.k === "ready" && (
          <div className="space-y-3 text-sm">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Your agent&apos;s own account — it printed this address when it checked in:</p>
              <p className="rounded-md bg-muted p-2 font-mono text-xs break-all" data-testid="agent-address">
                {agent.agentAccount}
              </p>
            </div>
            {canPrepare && (
              <>
                <p data-testid="fund-disclosure">
                  Your wallet will show <XrdAmount amountXrd={agent.floatXrd} /> and a Guild badge going to{" "}
                  <span className="font-mono break-all">{agent.agentAccount}</span> — an address you have not seen before. That is
                  your agent&apos;s own account; your agent printed the same address. If they differ, do not approve.
                </p>
                <p className="text-xs text-muted-foreground">
                  Your wallet adds a small network fee. The float stays in your agent&apos;s account for its claim bonds and fees.
                </p>
                {short && (
                  <p role="alert" className="text-destructive">
                    Your account holds <XrdAmount amountXrd={balance ?? 0} />, not enough for a <XrdAmount amountXrd={agent.floatXrd} />{" "}
                    float plus the network fee.
                  </p>
                )}
                {halted && (
                  <p role="alert" className="text-destructive">
                    {halt.operatorHalt
                      ? "Funding is paused by the operator. Nothing is lost — try again when it reopens."
                      : "The Radix network has stopped producing blocks, so this cannot be signed now. Try again once it resumes."}
                  </p>
                )}
                {sessionMismatch && (
                  <p role="alert" className="text-destructive">
                    Your wallet&apos;s account is not the one you signed in with. Switch accounts in your wallet, or sign in again, before
                    funding.
                  </p>
                )}
              </>
            )}
            {/* One live region: in check-only mode the explainer joins the note. */}
            {(phase.note || !canPrepare) && (
              <p role="status" className="text-xs text-muted-foreground">
                {[
                  phase.note,
                  canPrepare
                    ? null
                    : `The pairing is past its 24-hour window, so a new funding transaction can't be prepared. If one you already approved lands, this agent activates; if not, ${phase.pairAgain ?? "pair the agent again with a new code"}.`,
                ]
                  .filter(Boolean)
                  .join(" ")}
              </p>
            )}
            {phase.recheck && (
              <Button className="w-full" variant="outline" onClick={runCheck}>
                Check again
              </Button>
            )}
            {phase.error && (
              <p role="alert" className="text-destructive">
                {phase.error}
              </p>
            )}
            {canPrepare ? (
              <Button className="w-full" onClick={fund} disabled={blocked}>
                Fund &amp; activate
              </Button>
            ) : (
              !phase.recheck && (
                <Button className="w-full" variant="outline" onClick={runCheck}>
                  Check again
                </Button>
              )
            )}
          </div>
        )}

        {phase.k === "working" && (
          <p role="status" aria-busy="true" className="text-sm">
            {phase.what}
          </p>
        )}

        {phase.k === "confirming" && (
          <div className="space-y-2 text-sm">
            <p role="status" aria-busy="true">
              Waiting for the transaction to land on the network… no need to sign again.
            </p>
            {phase.intentHash && <TxLink intentHash={phase.intentHash} />}
          </div>
        )}

        {phase.k === "slow" && (
          <div className="space-y-3 text-sm">
            <p role="status">
              Not confirmed after 3 minutes. It may still land — check again in a little while rather than signing a second time.
            </p>
            {phase.intentHash && <TxLink intentHash={phase.intentHash} />}
            <Button className="w-full" variant="outline" onClick={() => setPhase({ k: "confirming", intentHash: phase.intentHash, startedAt: Date.now() })}>
              Check again
            </Button>
          </div>
        )}

        {phase.k === "done" && (
          <div className="space-y-3 text-sm">
            <p role="status">
              <span className="font-semibold">{agent.label}</span> is active. Its float and Guild badge are in its own account.
            </p>
            <Button
              className="w-full"
              onClick={() => {
                setOpen(false)
                onOpenChange?.(false)
              }}
            >
              Done
            </Button>
          </div>
        )}

        {phase.k === "float_short" && (
          <div className="space-y-3 text-sm">
            <p role="alert">
              The badge reached {agent.label}&apos;s account, but less than its <XrdAmount amountXrd={agent.floatXrd} /> float. Send the
              difference from your wallet as an ordinary XRD transfer to its account, then check again.
            </p>
            <div className="flex items-start gap-2">
              <span className="flex-1 font-mono text-xs break-all">{agent.agentAccount}</span>
              <CopyButton value={agent.agentAccount} />
            </div>
            <Button className="w-full" variant="outline" onClick={() => setPhase({ k: "confirming", startedAt: Date.now() })}>
              Check again
            </Button>
          </div>
        )}

        {phase.k === "stopped" && (
          <p role="alert" className="text-sm">
            {phase.message}
          </p>
        )}

        {phase.k === "mismatch" && (
          <p role="alert" className="text-sm text-destructive">
            Don&apos;t sign anything. The transaction the Guild prepared does not match this agent: {phase.reason}. That is a problem on
            our side, not something you did, and nothing was sent to your wallet. Close this and reload the page.
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

function TxLink({ intentHash }: { intentHash: string }) {
  return (
    <a
      href={`https://dashboard.radixdlt.com/transaction/${intentHash}`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-xs text-primary underline"
    >
      View the transaction
    </a>
  )
}
