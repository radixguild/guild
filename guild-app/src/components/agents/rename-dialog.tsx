"use client"

import { useRef, useState } from "react"
import { Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { patchAgent } from "@/components/agents/owner-request"
import type { AgentCardData } from "@/components/agents/status"
import { AGENT_LABEL_MAX, AGENT_LABEL_RULE, isValidAgentLabel } from "@/lib/agent-label"

/**
 * Rename (A2.4d — design §3.2). Offered only when the server's `actions`
 * admit a rename. Everything else a rename needs — the current name's state
 * on-chain, the 24 h hold after a funding transaction was prepared, the new
 * name being free here and on-chain — only the PATCH can answer, so this
 * submits and shows the server's answer in its own words. The one check made
 * here is the badge-name format, with the same shared rule the add dialog and
 * the server use.
 */
export function RenameDialog({
  agent,
  onUpdated,
  onChanged,
}: {
  agent: AgentCardData
  onUpdated: (card: AgentCardData) => void
  onChanged: () => void
}) {
  const busy = useRef(false)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(agent.label)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  if (!agent.actions.rename) return null

  const submit = async () => {
    if (busy.current) return
    const label = name.trim()
    if (!isValidAgentLabel(label)) {
      setError(AGENT_LABEL_RULE)
      return
    }
    busy.current = true
    setWorking(true)
    setError(null)
    try {
      const answer = await patchAgent(agent.id, { label })
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
        if (next) {
          setName(agent.label)
          setError(null)
        }
        setOpen(next)
      }}
    >
      <DialogTrigger render={<Button size="sm" variant="outline" data-testid="agent-rename" />}>
        <Pencil className="mr-1 h-4 w-4" />
        Rename
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename {agent.label}</DialogTitle>
          <DialogDescription>
            Its name becomes its Guild badge&apos;s name when it is funded. The Guild checks the new name is free before it
            accepts it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3 text-sm"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="space-y-1">
            <Label htmlFor={`rename-${agent.id}`}>New name</Label>
            <Input
              id={`rename-${agent.id}`}
              value={name}
              maxLength={AGENT_LABEL_MAX}
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
            />
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={working}>
              Cancel
            </Button>
            <Button type="submit" disabled={working || name.trim() === agent.label} data-testid="rename-save">
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
