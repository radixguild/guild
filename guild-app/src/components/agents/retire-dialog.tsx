"use client"

import { useEffect, useRef, useState } from "react"
import { Archive } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { CopyButton } from "@/components/copy-button"
import { AgentBalanceLine, readAgentBalance, type AgentBalance } from "@/components/agents/agent-balance"
import { ownerRequest } from "@/components/agents/owner-request"
import type { AgentCardData } from "@/components/agents/status"

/**
 * The kit command that returns a retired (or suspended) agent's money: every
 * XRD but its own transfer's fee lock, to the owner pinned in its agent.json.
 * It never calls the Guild's API, so a retired agent can still run it
 * (packages/agent-client/src/guild-agent.ts `sweep`; design §3.7).
 * tests/unit/agent-retire.test.tsx pins these flags against the kit source.
 */
export const SWEEP_ALL_LINE = "guild-agent sweep --all --live"

/** How the owner gets the money back — what the kit does, stated conditionally where the page cannot know. */
export function SweepInstructions({ neverActivated }: { neverActivated: boolean }) {
  return (
    <div className="space-y-1" data-testid="sweep-instructions">
      <p>Only the agent&apos;s own key can move what it holds. On the agent&apos;s machine, run:</p>
      <div className="flex items-start gap-2">
        <code className="flex-1 rounded-md bg-muted p-2 font-mono text-xs break-all">{SWEEP_ALL_LINE}</code>
        <CopyButton value={SWEEP_ALL_LINE} />
      </div>
      <p className="text-xs text-muted-foreground">
        It needs no Guild sign-in, so it works after retiring. It sends everything but a few XRD for its own transfer fee to the
        owner the agent recorded when it saw itself activated; without one, it refuses and says why.
      </p>
      {neverActivated && (
        <p className="text-xs" data-testid="never-activated">
          This agent was never activated, so it has no owner recorded and that sweep will refuse. If you sent it anything,
          check funding first: activation records your wallet as its owner.
        </p>
      )}
    </div>
  )
}

/**
 * Retire (A2.4c — design §3.7). Irreversible, so it asks first: the dialog
 * says what retiring does and does not do, reads the agent's balance live
 * (never the funded float), and gives the exact sweep line. Offered only when
 * the server's `actions` admit it. The server's answer is applied; a refusal
 * is its own words.
 */
export function RetireDialog({
  agent,
  onUpdated,
  onChanged,
}: {
  agent: AgentCardData
  onUpdated: (card: AgentCardData) => void
  onChanged: () => void
}) {
  const busy = useRef(false)
  const readSeq = useRef(0)
  const [open, setOpen] = useState(false)
  const [balance, setBalance] = useState<AgentBalance>({ k: "reading" })
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  if (!agent.actions.retire) return null

  const readBalance = () => {
    const mine = ++readSeq.current
    setBalance({ k: "reading" })
    readAgentBalance(agent.agentAccount).then((b) => {
      if (mine === readSeq.current) setBalance(b)
    })
  }

  const retire = async () => {
    if (busy.current) return
    busy.current = true
    setWorking(true)
    setError(null)
    try {
      const answer = await ownerRequest(agent.id, "/retire", { method: "POST" })
      if (answer.kind === "card") {
        setOpen(false)
        onUpdated(answer.card)
        return
      }
      if (answer.kind === "reload") {
        if (answer.message) setError(answer.message)
        else setOpen(false)
        onChanged()
        return
      }
      setError(answer.refusal.message)
      if (answer.reload) onChanged()
    } finally {
      busy.current = false
      setWorking(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setError(null)
          readBalance()
        } else readSeq.current++
      }}
    >
      <DialogTrigger render={<Button size="sm" variant="outline" data-testid="agent-retire" />}>
        <Archive className="mr-1 h-4 w-4" />
        Retire
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Retire {agent.label}?</DialogTitle>
          <DialogDescription>
            This is permanent. The Guild refuses its sign-in for good, and this agent&apos;s key can never be paired again —
            pairing again means a new key.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p>Retiring moves no funds: what its account holds stays there until its key sweeps it.</p>
          <AgentBalanceLine balance={balance} />
          <SweepInstructions neverActivated={agent.activatedAt === null} />
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={working}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={retire} disabled={working} data-testid="agent-retire-confirm">
            Retire for good
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * A retired card's standing reminder (design §3.7: "the card shows sweep
 * owed"): the balance read live once when the card mounts, re-read on demand,
 * and the sweep line.
 */
export function RetiredSweep({ agent }: { agent: AgentCardData }) {
  const seq = useRef(0)
  const [balance, setBalance] = useState<AgentBalance>({ k: "reading" })
  const account = agent.agentAccount

  // State is set only in the promise callback (react-hooks/set-state-in-effect).
  useEffect(() => {
    let live = true
    const mine = ++seq.current
    readAgentBalance(account).then((b) => {
      if (live && mine === seq.current) setBalance(b)
    })
    return () => {
      live = false
    }
  }, [account])

  const recheck = () => {
    const mine = ++seq.current
    setBalance({ k: "reading" })
    readAgentBalance(account).then((b) => {
      if (mine === seq.current) setBalance(b)
    })
  }

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="retired-sweep">
      <div className="flex items-start justify-between gap-2">
        <AgentBalanceLine balance={balance} />
        <Button size="xs" variant="ghost" onClick={recheck} disabled={balance.k === "reading"}>
          Check again
        </Button>
      </div>
      <SweepInstructions neverActivated={agent.activatedAt === null} />
    </div>
  )
}
