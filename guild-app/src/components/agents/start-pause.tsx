"use client"

import { useRef, useState } from "react"
import { Pause, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { XrdAmount } from "@/components/XrdAmount"
import { patchAgent } from "@/components/agents/owner-request"
import type { AgentCardData } from "@/components/agents/status"

/**
 * Start / Pause — the owner's practice-mode control (A2.4b, design §3.5:
 * `dryRun` is the owner's Start). Start shows only when the server's
 * `actions.start` admits it — not before the agent is funded, so its owner
 * sees it practise first; Pause whenever `actions.edit` does.
 *
 * Pause sends `dryRun` ALONE: it is a stop, so it must land whatever else
 * changed meanwhile, and it never writes back this page's copy of the other
 * rules. Start asks first, showing the rules it will run on, and sends those
 * rules as `baseRules`: if they changed since this page read them, the server
 * refuses (RULES_CHANGED) and the list is re-read — an agent is only ever
 * started on rules its owner has seen.
 */
export function StartPause({
  agent,
  onUpdated,
  onChanged,
}: {
  agent: AgentCardData
  onUpdated: (card: AgentCardData) => void
  onChanged: () => void
}) {
  const busy = useRef(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const practice = agent.rules.dryRun
  if (practice ? !agent.actions.start : !agent.actions.edit) return null
  const rules = agent.rules

  const send = async (dryRun: boolean) => {
    if (busy.current) return
    busy.current = true
    setWorking(true)
    setError(null)
    try {
      const answer = await patchAgent(agent.id, dryRun ? { dryRun: true } : { dryRun: false, baseRules: rules })
      if (answer.kind === "card") {
        setConfirming(false)
        onUpdated(answer.card)
        return
      }
      if (answer.kind === "reload") {
        if (answer.message) setError(answer.message)
        else setConfirming(false)
        onChanged()
        return
      }
      setError(answer.refusal.message)
      if (answer.card) onUpdated(answer.card)
      else if (answer.reload) onChanged()
    } finally {
      busy.current = false
      setWorking(false)
    }
  }

  if (!practice) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button size="sm" variant="outline" onClick={() => send(true)} disabled={working} data-testid="agent-pause">
          <Pause className="mr-1 h-4 w-4" />
          Pause
        </Button>
        {error && (
          <p role="alert" className="text-right text-destructive">
            {error}
          </p>
        )}
      </div>
    )
  }

  const posters = rules.trustedPosters.length
  return (
    <Dialog
      open={confirming}
      onOpenChange={(next) => {
        setConfirming(next)
        if (next) setError(null)
      }}
    >
      <Button size="sm" onClick={() => setConfirming(true)} data-testid="agent-start">
        <Play className="mr-1 h-4 w-4" />
        Start
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Start {agent.label}?</DialogTitle>
          <DialogDescription>
            Practice mode ends: your agent may claim Guild tasks within these rules, signing with its own key.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="start-rules">
          <li>
            Up to {rules.maxClaimsPerDay} claim{rules.maxClaimsPerDay === 1 ? "" : "s"} a day
            {rules.maxClaimsPerDay === 0 ? " — so its rules allow no claims" : ""}.
          </li>
          <li>
            {posters === 0
              ? "It trusts no posters, so its rules allow no claims."
              : `Only tasks from its ${posters} trusted poster${posters === 1 ? "" : "s"}.`}
          </li>
          <li>
            Each claim locks a bond of up to <XrdAmount amountXrd={rules.maxBondXrd} /> from its float.
          </li>
        </ul>
        <p className="text-xs text-muted-foreground">
          It picks this up at its next check-in. Pause puts it back in practice mode, where it reports what it would claim and
          signs nothing.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirming(false)} disabled={working}>
            Cancel
          </Button>
          <Button onClick={() => send(false)} disabled={working} data-testid="agent-start-confirm">
            Start
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
