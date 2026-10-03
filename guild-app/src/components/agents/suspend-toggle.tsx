"use client"

import { useRef, useState } from "react"
import { Ban, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { apiFetch } from "@/lib/api-fetch"
import { cardFromResponse, type AgentCardData } from "@/components/agents/status"

/**
 * Suspend / Resume on an owner's card (A2.4 — design §3.7). Shown only when
 * the server's `actions` admits one; the button then POSTs and the card
 * becomes whatever the server answers with — never a state this page
 * assumed. A suspension is the owner's stop control, so it asks no
 * confirmation: it is undone by Resume.
 *
 * A refusal is the server's own message. A wrong-state or not-found answer
 * also refreshes the list, since the card was behind the server.
 */
export function SuspendToggle({
  agent,
  onUpdated,
  onChanged,
}: {
  agent: AgentCardData
  /** The server's card after the action — applied at once. */
  onUpdated: (card: AgentCardData) => void
  /** Re-read the whole list (the card was stale, or the answer was unreadable). */
  onChanged: () => void
}) {
  const busy = useRef(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const action = agent.actions.suspend ? "suspend" : agent.actions.resume ? "resume" : null
  if (!action) return null

  const run = async () => {
    if (busy.current) return
    busy.current = true
    setWorking(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/v1/agents/${agent.id}/${action}`, { method: "POST" })
      const body = await res.json().catch(() => null)
      const card = res.ok ? cardFromResponse(body, agent.id) : null
      if (card) {
        onUpdated(card)
        return
      }
      if (res.ok) {
        // Done, but the answer is not a card we can show: ask for the list.
        onChanged()
        return
      }
      if (res.status === 429) {
        const wait = Number(res.headers.get("Retry-After")) || 60
        setError(`Too many tries. Wait ${wait} seconds and try again.`)
        return
      }
      const code = body?.error?.code as string | undefined
      setError((body?.error?.message as string | undefined) ?? `Something went wrong (HTTP ${res.status}). Try again.`)
      if (code === "AGENT_WRONG_STATE" || code === "AGENT_NOT_FOUND") onChanged()
    } catch {
      // The request may or may not have reached the Guild: show where it stands.
      setError("No answer from the Guild. The list is refreshing to show where it stands.")
      onChanged()
    } finally {
      busy.current = false
      setWorking(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" onClick={run} disabled={working} data-testid={`agent-${action}`}>
        {action === "suspend" ? <Ban className="mr-1 h-4 w-4" /> : <Undo2 className="mr-1 h-4 w-4" />}
        {action === "suspend" ? "Suspend" : "Resume"}
      </Button>
      {error && (
        <p role="alert" className="text-right text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
