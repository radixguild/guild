import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

// next/link renders a plain anchor in tests (no router context needed).
vi.mock("next/link", () => ({
  default: ({ href, children }: any) => <a href={href}>{children}</a>,
}))

import { TaskCard } from "@/components/tasks/task-card"
import type { Task } from "@/lib/marketplace-types"

// Minimal Task with just the fields TaskCard reads (cast past the full row).
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "Test task",
    description: "A task description",
    status: "open",
    rewardXrd: "100",
    creatorId: "account_rdx1qwertyuiopasdfghjklzxcvbnm1234567890qwerty",
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

// Rule one: a task is only claimable once its on-chain escrow is funded
// (onChainTaskId set). The card must telegraph that state to a cold visitor.
describe("TaskCard funding indicator", () => {
  beforeEach(() => cleanup())

  it("marks an unfunded task (onChainTaskId null) as Unfunded", () => {
    render(<TaskCard task={makeTask({ onChainTaskId: null })} />)
    expect(screen.getByText("Unfunded")).toBeInTheDocument()
    expect(screen.queryByText("Funded")).not.toBeInTheDocument()
  })

  it("marks a funded task (onChainTaskId set) as Funded", () => {
    render(<TaskCard task={makeTask({ onChainTaskId: 42 })} />)
    expect(screen.getByText("Funded")).toBeInTheDocument()
    expect(screen.queryByText("Unfunded")).not.toBeInTheDocument()
  })

  // 2026-09-24: "Funded" promises the reward is in escrow AND the task can be
  // claimed (the /tasks intro says so). onChainTaskId stays set after a task is
  // claimed or paid, so the chip must follow the status, not the id alone.
  it.each(["assigned", "submitted", "disputed", "paid", "refunded", "cancelled"])(
    "shows no funding chip on a %s task, even with an on-chain id",
    (status) => {
      render(<TaskCard task={makeTask({ onChainTaskId: 42, status } as Partial<Task>)} />)
      expect(screen.queryByText("Funded")).not.toBeInTheDocument()
      expect(screen.queryByText("Unfunded")).not.toBeInTheDocument()
    },
  )
})

// task 89 (/tasks projects-first board): "task cards show and link their
// project". The link must be a SIBLING of the task-detail link, not nested
// inside it — nesting an <a> inside next/link's <a> is invalid HTML.
describe("TaskCard project link", () => {
  beforeEach(() => cleanup())

  it("omits the project strip when the task has no project", () => {
    render(<TaskCard task={makeTask({ projectId: null })} />)
    expect(screen.queryByRole("link", { name: /P4 · Product polish/ })).not.toBeInTheDocument()
  })

  it("shows and links the project when the caller resolves one", () => {
    render(
      <TaskCard
        task={makeTask({ projectId: 4 })}
        project={{ name: "P4 · Product polish", slug: "p4-product-polish" }}
      />
    )
    const projectLink = screen.getByRole("link", { name: /P4 · Product polish/ })
    expect(projectLink).toHaveAttribute("href", "/projects/p4-product-polish")
    // The task link is a SEPARATE anchor, not an ancestor of the project one.
    const taskLink = screen.getByRole("link", { name: /Test task/ })
    expect(taskLink).toHaveAttribute("href", "/tasks/1")
    expect(taskLink).not.toBe(projectLink)
    expect(projectLink.closest("a")).toBe(projectLink)
  })
})

// `tasks.required_tier` is a column default ('member') that no write path sets and
// nothing enforces on claim. Rendering it put "member+ tier" on every card — the
// tier-gating claim, from a DB column no copy gate can see (removed 2026-09-19).
describe("TaskCard shows no tier chip", () => {
  beforeEach(() => cleanup())

  it("renders no tier text even when the row carries the column default", () => {
    const { container } = render(<TaskCard task={makeTask({ requiredTier: "member" })} />)
    expect(container.textContent).not.toMatch(/tier/i)
  })

  it("still renders the XP figure beside where the chip was (control — the footer rendered)", () => {
    const { container } = render(<TaskCard task={makeTask({ requiredTier: "member" })} />)
    expect(container.textContent).toMatch(/\+\d+ XP/)
  })
})
