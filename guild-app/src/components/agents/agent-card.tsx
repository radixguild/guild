"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { CopyButton } from "@/components/copy-button"
import { InfoTip } from "@/components/info-tip"
import { FundAgentDialog } from "@/components/agents/fund-agent-dialog"
import { SuspendToggle } from "@/components/agents/suspend-toggle"
import { StartPause } from "@/components/agents/start-pause"
import { RulesDialog } from "@/components/agents/rules-dialog"
import { RetireDialog, RetiredSweep } from "@/components/agents/retire-dialog"
import { RenameDialog } from "@/components/agents/rename-dialog"
import { XrdAmount } from "@/components/XrdAmount"
import { timeAgo } from "@/lib/time-ago"
import { browserStorage, readPendingFund } from "@/lib/agent-fund"
import {
  deriveAgentStatus,
  EXPIRED_SIGNED_HERE_DETAIL,
  expiredHeldDetail,
  pairingReleaseAt,
  STATUS_DETAIL,
  STATUS_LABEL,
  STATUS_TONE,
  type AgentCardData,
} from "@/components/agents/status"

const FLOAT_TIP =
  "What your agent keeps in its own account to lock claim bonds and pay network fees. It is the agent's money to work with, not a payment to the Guild."

/**
 * One agent on the owner's "My agents" list (design §3.6). A paired agent that
 * is not funded yet carries Fund & activate (A2.3); Rename, Rules, Start /
 * Pause, Suspend / Resume and Retire show when the server's `actions` admit
 * them (A2.4), and a retired card keeps the live balance and the sweep line in
 * view (§3.7). The float is actionable money, so it is never
 * compacted (tests/unit/xrd-display-standard.test.ts).
 */
export function AgentCard({
  agent,
  now,
  onChanged,
  onUpdated,
}: {
  agent: AgentCardData
  now: number
  onChanged: () => void
  /** Apply the card an owner action answered with. */
  onUpdated: (card: AgentCardData) => void
}) {
  const status = deriveAgentStatus(agent, now)
  // The Fund dialog is offered on a paired, unfunded agent, and on EVERY
  // expired one as "Check funding": whether the server still holds an expired
  // pairing depends on the clock (a funding transaction handed out < 24 h ago)
  // AND on the chain (the badge landed but the float is short; the Gateway
  // could not answer) — so the card does not guess. The check asks the server
  // (POST /agents/{id}/funded) and the dialog says what its answer means.
  // Once open, it stays mounted until the owner closes it.
  const [fundOpen, setFundOpen] = useState(false)
  const releaseAt = pairingReleaseAt(agent.manifestIssuedAt ? Date.parse(agent.manifestIssuedAt) : null)
  const heldByServer = status === "expired" && releaseAt !== null && releaseAt > now
  const signedHere = status === "expired" && readPendingFund(browserStorage(), agent.id, now) !== null
  const showFund = status === "unfunded" || status === "expired" || fundOpen
  const showsCheckIns = agent.status !== "pending"
  const rules = agent.rules

  return (
    <Card size="sm" data-testid="agent-card" data-status={status}>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle as="h3" className="text-sm font-semibold break-all">
            {agent.label}
          </CardTitle>
          <Badge variant="outline" className={`border-transparent ${STATUS_TONE[status]}`}>
            {STATUS_LABEL[status]}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <p className="text-muted-foreground">
          {heldByServer && releaseAt !== null
            ? expiredHeldDetail(releaseAt, now)
            : signedHere
              ? EXPIRED_SIGNED_HERE_DETAIL
              : STATUS_DETAIL[status]}
        </p>
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5">
          <dt className="text-muted-foreground">Account</dt>
          <dd className="flex items-start gap-2">
            {/* Shown in full: CopyButton's contract is that the value stays readable
                when the clipboard is unavailable, and it is the address an owner
                compares with the one the agent printed. */}
            <span className="font-mono break-all">{agent.agentAccount}</span>
            <CopyButton value={agent.agentAccount} />
          </dd>

          <dt className="text-muted-foreground">
            Float <InfoTip text={FLOAT_TIP} />
          </dt>
          <dd>
            <XrdAmount amountXrd={agent.floatXrd} />
          </dd>

          {showsCheckIns && (
            <>
              <dt className="text-muted-foreground">Last check-in</dt>
              <dd>{agent.lastSeenAt ? timeAgo(agent.lastSeenAt, now) : "never"}</dd>
            </>
          )}

          <dt className="text-muted-foreground">Rules</dt>
          <dd>
            up to {rules.maxClaimsPerDay} claim{rules.maxClaimsPerDay === 1 ? "" : "s"} a day · bonds up to{" "}
            <XrdAmount amountXrd={rules.maxBondXrd} /> · {rules.trustedPosters.length} trusted poster
            {rules.trustedPosters.length === 1 ? "" : "s"}
            {rules.dryRun ? " · practice mode" : ""}
          </dd>
        </dl>
        {agent.status === "retired" && <RetiredSweep agent={agent} />}
        {(showFund || Object.values(agent.actions).some(Boolean)) && (
          <div className="flex flex-wrap items-start justify-end gap-2">
            <RenameDialog agent={agent} onUpdated={onUpdated} onChanged={onChanged} />
            <RulesDialog agent={agent} onUpdated={onUpdated} onChanged={onChanged} />
            <StartPause agent={agent} onUpdated={onUpdated} onChanged={onChanged} />
            <SuspendToggle agent={agent} onUpdated={onUpdated} onChanged={onChanged} />
            <RetireDialog agent={agent} onUpdated={onUpdated} onChanged={onChanged} />
            {showFund && (
              <FundAgentDialog
                agent={agent}
                onChanged={onChanged}
                onOpenChange={setFundOpen}
                triggerLabel={status === "unfunded" ? "Fund & activate" : "Check funding"}
                canPrepare={status === "unfunded"}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
