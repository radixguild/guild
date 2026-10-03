"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Bot } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { LoadFailed } from "@/components/ui/load-failed"
import { SignInPrompt } from "@/components/wallet/sign-in-prompt"
import { AgentCard } from "@/components/agents/agent-card"
import { AddAgentDialog } from "@/components/agents/add-agent-dialog"
import type { AgentCardData, PendingCodeData } from "@/components/agents/status"
import { useMounted } from "@/hooks/useMounted"
import { useWallet } from "@/hooks/useWallet"
import { apiFetch } from "@/lib/api-fetch"
import { isEnabled } from "@/lib/features"

/** Refresh while the page is open, so check-ins and status changes show up. */
const POLL_MS = 30_000

type View =
  | { kind: "loading" }
  | { kind: "signin" }
  | { kind: "locked"; message: string }
  | { kind: "failed" }
  | { kind: "ready"; agents: AgentCardData[]; pendingCodes: PendingCodeData[] }

function minutesLeft(iso: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - now) / 60_000))
}

/**
 * "My agents" — the signed-in owner's section of /agents (design §3.6).
 *
 * Renders nothing until the page has hydrated and a wallet is connected, so the
 * cold page (and its prerendered HTML) is unchanged for every other visitor.
 * Keyed on the account: switching accounts starts from a blank list, never
 * showing one account's agents under another.
 */
export function MyAgentsSection() {
  const mounted = useMounted()
  const { connected, account } = useWallet()
  if (!mounted || !connected) return null
  return <MyAgentsList key={account ?? ""} />
}

/**
 * A failed load is never shown as "no agents": LoadFailed on the first load,
 * and a failed poll keeps the last good list on screen.
 */
function MyAgentsList() {
  const canAdd = isEnabled("agentsAdd")
  const [view, setView] = useState<View>({ kind: "loading" })
  const [now, setNow] = useState(() => Date.now())
  const hasData = useRef(false)
  // Each list read is numbered; only the latest may land. applyCard re-reads
  // through load(), so a read that left before an owner action can never put
  // that card back as it was.
  const seq = useRef(0)

  // State is set only in promise callbacks, never synchronously in the effect
  // that calls this (react-hooks/set-state-in-effect) — notifications-menu's shape.
  const load = useCallback(() => {
    const mine = ++seq.current
    apiFetch("/api/v1/agents/mine")
      .then(async (res) => ({ status: res.status, ok: res.ok, body: await res.json().catch(() => null) }))
      .then(({ status, ok, body }) => {
        if (mine !== seq.current) return
        if (status === 401) {
          hasData.current = false
          setView({ kind: "signin" })
          return
        }
        if (status === 403 && body?.error?.code === "ACCOUNT_SUSPENDED") {
          hasData.current = false
          setView({ kind: "locked", message: String(body.error.message ?? "This account is suspended.") })
          return
        }
        if (!ok || !body?.ok) throw new Error(`agents/mine ${status}`)
        hasData.current = true
        setNow(Date.now())
        setView({ kind: "ready", agents: body.data.agents ?? [], pendingCodes: body.data.pendingCodes ?? [] })
      })
      .catch(() => {
        if (mine !== seq.current) return
        if (!hasData.current) setView({ kind: "failed" })
      })
  }, [])

  /** The server's card after an owner action: shown at once, then the list re-read. */
  const applyCard = useCallback(
    (card: AgentCardData) => {
      setNow(Date.now())
      setView((v) => (v.kind === "ready" ? { ...v, agents: v.agents.map((a) => (a.id === card.id ? card : a)) } : v))
      load()
    },
    [load],
  )

  useEffect(() => {
    load()
    const id = setInterval(() => {
      if (!document.hidden) load()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  return (
    <section aria-labelledby="my-agents-heading" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="my-agents-heading" className="text-lg font-semibold">
          My agents
        </h2>
        {/* Only once the list has loaded: before sign-in, while locked, or
            after a failed load, adding would dead-end at the server. */}
        {canAdd && view.kind === "ready" && <AddAgentDialog onChanged={load} />}
      </div>
      {view.kind === "loading" && (
        <p className="text-sm text-muted-foreground" aria-busy="true">
          Loading your agents…
        </p>
      )}
      {view.kind === "signin" && (
        <SignInPrompt
          title="Sign in to see your agents"
          description="Approve a one-time wallet signature to verify your account."
          onSignedIn={load}
        />
      )}
      {view.kind === "locked" && (
        <Card>
          <CardContent className="py-4 text-sm" role="alert">
            {view.message}
          </CardContent>
        </Card>
      )}
      {view.kind === "failed" && <LoadFailed what="your agents" onRetry={load} />}
      {view.kind === "ready" && view.agents.length === 0 && view.pendingCodes.length === 0 && (
        <EmptyState
          icon={<Bot />}
          title="No agents yet"
          description={
            canAdd
              ? "An agent you run yourself can pair with your account here and work Guild tasks within rules you set."
              : "An agent you run yourself can pair with your account here and work Guild tasks within rules you set. Adding one from this page opens when the agent kit is published."
          }
        />
      )}
      {view.kind === "ready" && view.pendingCodes.length > 0 && (
        <ul className="space-y-2">
          {view.pendingCodes.map((c) => (
            <li key={c.code}>
              <Card size="sm" data-testid="pending-code">
                <CardContent className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                  <span>
                    <span className="font-semibold">{c.label}</span>{" "}
                    <span className="text-muted-foreground">— waiting for the agent to check in</span>
                  </span>
                  <span className="text-muted-foreground">
                    code <span className="font-mono text-foreground">{c.code}</span> · expires in{" "}
                    {minutesLeft(c.expiresAt, now)} min
                  </span>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {view.kind === "ready" && view.agents.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {view.agents.map((a) => (
            <AgentCard key={a.id} agent={a} now={now} onChanged={load} onUpdated={applyCard} />
          ))}
        </div>
      )}
    </section>
  )
}
