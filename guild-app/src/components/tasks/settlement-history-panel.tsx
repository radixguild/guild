import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { formatXrdAmount } from "@/lib/format-xrd-usd"
import { formatAddress } from "@/lib/marketplace-utils"

/**
 * One escrow_transactions row, as GET /api/v1/tasks/[id] serves it on
 * `data.settlementHistory` for a cancelled task's own creator/assignee
 * (see findSettlementHistoryForTask, db/queries/escrow.ts). Deliberately a
 * SUBSET of the DB row's columns — fromUserId/toUserId/destination/status
 * aren't rendered here (status is always 'confirmed', see the query's own
 * honesty filter), so this type only promises what the panel actually uses.
 */
export interface SettlementHistoryEvent {
  id: number
  txType: "fund" | "release" | "refund" | "dispute" | "settle" | "withdraw"
  party: "worker" | "poster" | null
  lane: "reward" | "bond" | null
  amountXrd: string
  rewardResource: string | null
  txHash: string | null
  createdAt: Date
}

const partyLabel = (party: "worker" | "poster" | null): string =>
  party === "worker" ? "Worker" : party === "poster" ? "Poster" : "Party"

/**
 * One ledger row → one plain-English line. XRD-only (formatXrdAmount, no
 * USD conversion): these are HISTORICAL amounts, and converting a past
 * amount at today's rate would misstate what anyone actually received.
 */
function describeEvent(e: SettlementHistoryEvent): string {
  const amount = formatXrdAmount(e.amountXrd, { unit: e.rewardResource ?? "XRD" })
  const lane = e.lane ? ` (${e.lane === "bond" ? "claim bond" : e.lane})` : ""
  switch (e.txType) {
    case "fund":
      return `Escrow funded — ${amount}`
    case "release":
      return `Released to the worker — ${amount}`
    case "refund":
      return `Refunded to the poster — ${amount}`
    case "dispute":
      return "Dispute raised"
    case "settle":
      return `${partyLabel(e.party)} credited${lane} — ${amount}`
    case "withdraw":
      return `${partyLabel(e.party)} withdrew${lane} — ${amount}`
  }
}

/**
 * Cancelled-task "what happened" panel (2026-09-14). Presentational only —
 * no hooks, no fetch — so it's unit-testable on its own, same reasoning as
 * TaskHistoryCard's own extraction: the task detail page pulls in
 * useWallet/RadixDappToolkit at module scope, which turns a test of
 * anything still living there into a heavy provider-mocking exercise.
 *
 * Two sections, each honest about what it does and doesn't know:
 *  - A short timeline strip (posted / claimed / cancelled) built from task
 *    columns the caller already has. "Cancelled" uses the task's updatedAt
 *    as an ESTIMATE, same fallback convention this page already uses for
 *    disputedAt elsewhere — never asserted as the precise on-chain instant.
 *    "Claimed" carries no timestamp at all: there is no claimedAt column,
 *    and inventing one would be exactly the false money-state claim
 *    TaskHistoryCard's own "Unconfirmed" fix (PR #459) was written to stop.
 *  - The escrow ledger itself: every confirmed escrow_transactions row for
 *    this task, oldest first, each carrying a real amount and (where the
 *    chain produced one) a tx hash — the part of "what happened" this page
 *    can actually prove.
 */
export function SettlementHistoryPanel({
  events,
  postedAt,
  assigneeId,
  cancelledAt,
}: {
  events: SettlementHistoryEvent[]
  postedAt: Date
  assigneeId: string | null
  cancelledAt: Date
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
          What happened
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ol className="space-y-1.5 text-sm">
          <li className="flex items-center justify-between gap-2">
            <span>Posted</span>
            <span className="text-xs text-muted-foreground">{postedAt.toLocaleString()}</span>
          </li>
          {assigneeId && (
            <li className="flex items-center justify-between gap-2">
              <span>Claimed by {formatAddress(assigneeId)}</span>
              <span className="text-xs text-muted-foreground">time not recorded</span>
            </li>
          )}
          <li className="flex items-center justify-between gap-2">
            <span>Cancelled</span>
            <span className="text-xs text-muted-foreground" title="Last DB update — not a precise on-chain timestamp">
              ~{cancelledAt.toLocaleString()}
            </span>
          </li>
        </ol>

        {events.length > 0 && (
          <div className="space-y-1.5 border-t border-border/40 pt-3 text-sm">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Escrow ledger
            </div>
            <ul className="space-y-1.5">
              {events.map((e) => (
                <li key={e.id} className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <span>{describeEvent(e)}</span>
                    <span className="text-xs text-muted-foreground">
                      {e.createdAt.toLocaleString()}
                    </span>
                  </div>
                  {e.txHash && (
                    <span className="font-mono text-[10px] text-muted-foreground" title={e.txHash}>
                      tx {formatAddress(e.txHash)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
