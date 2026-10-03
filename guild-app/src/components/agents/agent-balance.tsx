"use client"

import { XrdAmount } from "@/components/XrdAmount"
import { readFungibleVaultTotal } from "@/lib/gateway"
import { XRD_ADDRESS } from "@/lib/radix"

/**
 * What the agent's own account holds, read live from the Gateway — never the
 * card's `floatXrd`, which is what the owner FUNDED, not what is there now
 * (bonds, fees, earnings and sweeps all move it). An exact 18-dp decimal;
 * `complete: false` when the vault list runs past one page, so the total is a
 * lower bound; unknown when the Gateway did not answer — never read as 0.
 */
export type AgentBalance = { k: "reading" } | { k: "known"; total: string; complete: boolean } | { k: "unknown" }

export async function readAgentBalance(agentAccount: string): Promise<AgentBalance> {
  const read = await readFungibleVaultTotal(agentAccount, XRD_ADDRESS)
  return read ? { k: "known", total: read.total, complete: read.complete } : { k: "unknown" }
}

export function AgentBalanceLine({ balance }: { balance: AgentBalance }) {
  if (balance.k === "reading") {
    return (
      <p role="status" aria-busy="true" className="text-muted-foreground">
        Reading its account&apos;s balance…
      </p>
    )
  }
  if (balance.k === "unknown") {
    return (
      <p role="status" data-testid="agent-balance">
        We couldn&apos;t read its account&apos;s balance just now.
      </p>
    )
  }
  return (
    <p role="status" data-testid="agent-balance">
      Its account holds {balance.complete ? "" : "at least "}
      <XrdAmount amountXrd={balance.total} /> right now.
    </p>
  )
}
