/**
 * Regression coverage for DEFECT 1 (HIGH, 2026-08-26 adversarial screen on
 * PR #459): the profile page's task-history list used to render an
 * "Unfunded" badge whenever `task.onChainTaskId == null`. That is not what
 * NULL means — prune-unfunded.ts's SOFT-HIDE ruling and escrow-confirm.ts's
 * `create` NOT_RECONCILABLE note both establish that a poster can fund a
 * task on-chain (real XRD into escrow) and still land at onChainTaskId NULL
 * forever, if the create-confirm callback is lost. "Unfunded" told a
 * visitor's browser a false thing about a possibly-funded position — this
 * pins the wording that replaced it.
 *
 * This is also the first-ever test coverage for the poster-history feature
 * introduced in PR #459 (zero `postedTasks`/`creator=` references existed in
 * any test before this).
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

// next/link renders a plain anchor in tests (no router context needed).
vi.mock("next/link", () => ({
  default: ({ href, children }: any) => <a href={href}>{children}</a>,
}))

import { TaskHistoryCard } from "@/components/tasks/task-history-card"
import type { Task } from "@/lib/marketplace-types"

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "Design the widget",
    description: "A task description",
    status: "open",
    rewardXrd: "100",
    creatorId: "account_rdx1qposter",
    xpReward: 10,
    requiredTier: null,
    onChainTaskId: null,
    deadline: null,
    disputedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Task
}

describe("TaskHistoryCard escrow-state badge (defect 1)", () => {
  beforeEach(() => cleanup())

  it("never claims a NULL-onChainTaskId row is 'Unfunded' — that asserts money state this page cannot back up", () => {
    render(
      <TaskHistoryCard title="Tasks Posted" tasks={[makeTask({ onChainTaskId: null })]} emptyLabel="none" />,
    )
    // The whole point of the fix: this specific false claim must never render,
    // for ANY wording the fix lands on.
    expect(screen.queryByText("Unfunded")).not.toBeInTheDocument()
  })

  it("renders the honest 'Unconfirmed' label for a row with no on-chain escrow id", () => {
    render(
      <TaskHistoryCard title="Tasks Posted" tasks={[makeTask({ onChainTaskId: null })]} emptyLabel="none" />,
    )
    expect(screen.getByText("Unconfirmed")).toBeInTheDocument()
  })

  it("the Unconfirmed badge's tooltip states BOTH readings as possibilities, not a single conclusion", () => {
    render(
      <TaskHistoryCard title="Tasks Posted" tasks={[makeTask({ onChainTaskId: null })]} emptyLabel="none" />,
    )
    const badge = screen.getByText("Unconfirmed")
    const tooltip = (badge.getAttribute("title") ?? "").toLowerCase()
    expect(tooltip.length).toBeGreaterThan(0)
    // Both real readings named ...
    expect(tooltip).toMatch(/never funded/)
    expect(tooltip).toMatch(/confirmation (was )?lost|lost.*confirmation/)
    // ... explicitly hedged as alternatives, not asserted as a single fact.
    expect(tooltip).toMatch(/\bor\b/)
    expect(tooltip).toMatch(/not a claim/)
  })

  it("does NOT render the Unconfirmed badge once onChainTaskId is set (funded + linked)", () => {
    render(
      <TaskHistoryCard title="Tasks Posted" tasks={[makeTask({ onChainTaskId: 42 })]} emptyLabel="none" />,
    )
    expect(screen.queryByText("Unconfirmed")).not.toBeInTheDocument()
    expect(screen.queryByText("Unfunded")).not.toBeInTheDocument()
  })

  it("still renders the raw DB status badge alongside the escrow-state badge", () => {
    render(
      <TaskHistoryCard
        title="Tasks Posted"
        tasks={[makeTask({ onChainTaskId: null, status: "open" })]}
        emptyLabel="none"
      />,
    )
    expect(screen.getByText("open")).toBeInTheDocument()
  })

  it("renders the empty-state label when there are no tasks", () => {
    render(<TaskHistoryCard title="Tasks Posted" tasks={[]} emptyLabel="No posted tasks yet." />)
    expect(screen.getByText("No posted tasks yet.")).toBeInTheDocument()
  })
})
