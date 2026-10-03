import type { TaskStatus } from "@/lib/types"

export function formatXrd(amount: string): string {
  return `${Number(amount).toLocaleString()} XRD`
}

export function formatAddress(address: string): string {
  if (address.length <= 20) return address
  return `${address.slice(0, 12)}...${address.slice(-6)}`
}

export function getStatusColor(status: TaskStatus): string {
  switch (status) {
    case "open":
      return "bg-green-500/10 text-green-500"
    case "assigned":
      return "bg-yellow-500/10 text-yellow-500"
    case "submitted":
      return "bg-blue-500/10 text-blue-500"
    case "paid":
      return "bg-muted text-muted-foreground"
    case "cancelled":
      return "bg-red-500/10 text-red-500"
    case "disputed":
      return "bg-orange-500/10 text-orange-500"
    case "refunded":
      return "bg-muted text-muted-foreground"
  }
}

/**
 * Open AND funded on-chain: the reward is in escrow and the task can be claimed
 * now. The ONE predicate behind every "Funded" signal on the board (2026-09-24):
 * the task card's chip, the "Claimable now" strip, the "Funded only" filter and
 * the task page's Escrow row. `onChainTaskId` alone is not enough — it stays set
 * for the task's whole life, so a claimed, submitted or paid task still has one.
 * The API's `?funded=true` is deliberately the WIDER set (id set, any status);
 * its OpenAPI description says so.
 */
export function isOpenAndFunded(task: { status: string; onChainTaskId?: number | null }): boolean {
  return task.status === "open" && task.onChainTaskId != null
}
