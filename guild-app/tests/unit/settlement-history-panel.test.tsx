/**
 * The cancelled-task "Archived" panel (2026-09-14) — see its docblock in
 * src/components/tasks/settlement-history-panel.tsx. Presentational only
 * (no hooks/fetch), so mounted directly with plain props, same style as
 * task-history-card.test.tsx.
 */
import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

import {
  SettlementHistoryPanel,
  type SettlementHistoryEvent,
} from "@/components/tasks/settlement-history-panel"

afterEach(cleanup)

const POSTED_AT = new Date("2026-09-01T10:00:00Z")
const CANCELLED_AT = new Date("2026-09-14T09:00:00Z")

function makeEvent(overrides: Partial<SettlementHistoryEvent> = {}): SettlementHistoryEvent {
  return {
    id: 1,
    txType: "fund",
    party: null,
    lane: null,
    amountXrd: "500",
    rewardResource: null,
    txHash: null,
    createdAt: new Date("2026-09-01T10:05:00Z"),
    ...overrides,
  }
}

describe("SettlementHistoryPanel", () => {
  it("always renders the Posted and Cancelled timeline steps", () => {
    render(
      <SettlementHistoryPanel events={[]} postedAt={POSTED_AT} assigneeId={null} cancelledAt={CANCELLED_AT} />,
    )
    expect(screen.getByText("Posted")).toBeInTheDocument()
    expect(screen.getByText("Cancelled")).toBeInTheDocument()
  })

  it("renders a Claimed step with the assignee address when the task was claimed", () => {
    render(
      <SettlementHistoryPanel
        events={[]}
        postedAt={POSTED_AT}
        assigneeId="account_rdx1assignee_of_task"
        cancelledAt={CANCELLED_AT}
      />,
    )
    expect(screen.getByText(/Claimed by/)).toBeInTheDocument()
    // No invented timestamp for the claim step — there is no claimedAt
    // column, and asserting one would be exactly the false money/time-state
    // claim TaskHistoryCard's "Unconfirmed" fix (PR #459) was built to stop.
    expect(screen.getByText("time not recorded")).toBeInTheDocument()
  })

  it("omits the Claimed step entirely for a task that was never assigned", () => {
    render(
      <SettlementHistoryPanel events={[]} postedAt={POSTED_AT} assigneeId={null} cancelledAt={CANCELLED_AT} />,
    )
    expect(screen.queryByText(/Claimed by/)).not.toBeInTheDocument()
  })

  it("omits the ledger section entirely when there are no confirmed escrow rows", () => {
    render(
      <SettlementHistoryPanel events={[]} postedAt={POSTED_AT} assigneeId={null} cancelledAt={CANCELLED_AT} />,
    )
    expect(screen.queryByText("Escrow ledger")).not.toBeInTheDocument()
  })

  it("renders a credited (settle) row with party, lane and amount", () => {
    render(
      <SettlementHistoryPanel
        events={[makeEvent({ txType: "settle", party: "worker", lane: "bond", amountXrd: "76.45" })]}
        postedAt={POSTED_AT}
        assigneeId="account_rdx1assignee"
        cancelledAt={CANCELLED_AT}
      />,
    )
    expect(screen.getByText(/Worker credited/)).toBeInTheDocument()
    expect(screen.getByText(/claim bond/)).toBeInTheDocument()
    expect(screen.getByText(/76.45/)).toBeInTheDocument()
  })

  it("renders a withdrawal row with its tx hash", () => {
    render(
      <SettlementHistoryPanel
        events={[
          makeEvent({
            id: 2,
            txType: "withdraw",
            party: "worker",
            lane: "bond",
            amountXrd: "76.45",
            txHash: "txid_rdx1abcdef0123456789",
          }),
        ]}
        postedAt={POSTED_AT}
        assigneeId="account_rdx1assignee"
        cancelledAt={CANCELLED_AT}
      />,
    )
    expect(screen.getByText(/Worker withdrew/)).toBeInTheDocument()
    expect(screen.getByText(/tx /)).toBeInTheDocument()
  })

  it("never asserts a party label for a legacy fund/refund row (party is null on those)", () => {
    render(
      <SettlementHistoryPanel
        events={[makeEvent({ txType: "refund", amountXrd: "500" })]}
        postedAt={POSTED_AT}
        assigneeId={null}
        cancelledAt={CANCELLED_AT}
      />,
    )
    expect(screen.getByText(/Refunded to the poster/)).toBeInTheDocument()
  })
})
