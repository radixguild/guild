import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, within, fireEvent, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * /tasks projects-first board (task 89 / catalogue P4-21): the flat grid
 * that used to be the whole page is now the "All tasks" tab; the default
 * view groups tasks under project cards built from the rollup GET
 * /api/v1/projects returns, plus a trailing 'Unassigned' group for tasks
 * with no project. Mock set mirrors tests/unit/profile-archived-session.test.tsx
 * (next/link, AppShell, apiFetch) plus the two hooks this page reads that
 * profile doesn't: useAutoGuide and useXrdUsd.
 */

const PROJECT_P4 = {
  id: 4,
  name: "P4 · Product polish",
  slug: "p4-product-polish",
  description: "What a cold visitor sees. — Catalogue: 20 tasks. — Done when: it is deployed and verified live.",
  commissionerId: "account_rdx1poster",
  createdAt: "2026-09-15T07:07:46.616Z",
  taskCount: 2,
  paidCount: 1,
  paidXrd: "500",
  lockedXrd: "1000",
  openCount: 1,
  inProgressCount: 0,
  reviewCount: 0,
}

const TASK_IN_P4 = {
  id: 89,
  title: "Projects-first board task",
  description: "Group tasks under their project.",
  status: "open",
  rewardXrd: "1000",
  creatorId: "account_rdx1poster",
  xpReward: 100,
  requiredTier: "member",
  onChainTaskId: 25,
  deadline: null,
  disputedAt: null,
  projectId: 4,
  createdAt: "2026-09-15T07:11:30.735Z",
  updatedAt: "2026-09-15T07:11:37.010Z",
}

const TASK_UNASSIGNED = {
  id: 12,
  title: "An unfiled bounty",
  description: "Never got a project.",
  status: "open",
  rewardXrd: "50",
  creatorId: "account_rdx1poster",
  xpReward: 10,
  requiredTier: null,
  onChainTaskId: null,
  deadline: null,
  disputedAt: null,
  projectId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}

const H = vi.hoisted(() => ({
  projects: [] as unknown[],
  tasks: [] as unknown[],
  apiFetch: vi.fn(),
}))

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@/components/guides", () => ({
  useAutoGuide: vi.fn(),
}))

vi.mock("@/lib/use-xrd-usd", () => ({
  useXrdUsd: () => ({ rate: null, stale: false, ageSeconds: null, source: null }),
}))

vi.mock("@/lib/api-fetch", () => ({
  apiFetch: H.apiFetch,
}))

import TasksPage from "@/app/tasks/page"

const jsonRes = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

describe("/tasks projects-first board", () => {
  beforeEach(() => {
    H.projects = [PROJECT_P4]
    H.tasks = [TASK_IN_P4, TASK_UNASSIGNED]
    H.apiFetch.mockReset().mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v1/tasks?limit=")) return jsonRes({ ok: true, data: H.tasks })
      if (path === "/api/v1/projects") return jsonRes({ ok: true, data: H.projects })
      throw new Error(`unexpected apiFetch: ${path}`)
    })
  })
  afterEach(cleanup)

  it("defaults to the Projects view, rendering the project card with its rollup fields", async () => {
    render(<TasksPage />)

    const section = await screen.findByRole("region", { name: "P4 · Product polish" })
    // Funnel counts, straight off the rollup row (not recomputed client-side) —
    // scoped to each label's own stat block since "1" (open AND paid) is not
    // unique text in the section.
    expect(within(section).getByText("Open").parentElement).toHaveTextContent("1")
    expect(within(section).getByText("In progress").parentElement).toHaveTextContent("0")
    expect(within(section).getByText("Review").parentElement).toHaveTextContent("0")
    expect(within(section).getByText("Paid").parentElement).toHaveTextContent("1")
    // Money, compact-formatted from paidXrd/lockedXrd.
    expect(within(section).getByText(/escrowed/)).toBeInTheDocument()
    expect(within(section).getByText(/paid/)).toBeInTheDocument()
    // The grouped task renders inside the project's own section.
    expect(within(section).getByText("Projects-first board task")).toBeInTheDocument()
  })

  it("puts a task with no project under the trailing Unassigned group", async () => {
    render(<TasksPage />)

    await screen.findAllByText("Projects-first board task")
    const unassigned = screen.getByRole("region", { name: "Unassigned" })
    expect(within(unassigned).getByText("An unfiled bounty")).toBeInTheDocument()
    // It must NOT also appear inside the project's own section.
    const projectSection = screen.getByRole("region", { name: "P4 · Product polish" })
    expect(within(projectSection).queryByText("An unfiled bounty")).not.toBeInTheDocument()
  })

  it("the project card links to /projects/[slug]", async () => {
    render(<TasksPage />)
    const section = await screen.findByRole("region", { name: "P4 · Product polish" })
    const titleLink = within(section).getByRole("link", { name: "P4 · Product polish" })
    expect(titleLink).toHaveAttribute("href", "/projects/p4-product-polish")
  })

  it("switching to All tasks shows the flat grid with both tasks and the status filter", async () => {
    render(<TasksPage />)
    await screen.findAllByText("Projects-first board task")

    fireEvent.click(screen.getByRole("button", { name: /All tasks/i }))

    expect(await screen.findByPlaceholderText("Search tasks...")).toBeInTheDocument()
    // Both tasks are reachable from the flat grid too — same underlying fetch.
    expect(screen.getAllByText("Projects-first board task").length).toBeGreaterThan(0)
    expect(screen.getAllByText("An unfiled bounty").length).toBeGreaterThan(0)
  })

  it("All tasks: the unassigned task's card carries no project strip, the assigned one does", async () => {
    render(<TasksPage />)
    await screen.findAllByText("Projects-first board task")
    fireEvent.click(screen.getByRole("button", { name: /All tasks/i }))
    await screen.findByPlaceholderText("Search tasks...")

    // Project link appears once per card that has a project — here exactly once.
    expect(screen.getAllByRole("link", { name: /P4 · Product polish/ }).length).toBe(1)
  })

  it("an empty board (no projects, no tasks) shows the first-bounty empty state, not a blank page", async () => {
    H.projects = []
    H.tasks = []
    render(<TasksPage />)
    expect(await screen.findByText("Be the first to post a task")).toBeInTheDocument()
  })
})

describe("/tasks first impression — what a newcomer can act on comes first (2026-09-20)", () => {
  const EMPTY_PROJECT = { ...PROJECT_P4, id: 10, name: "P10 · Finish the grid game", slug: "p10", taskCount: 0, openCount: 0, paidCount: 0 }
  const UNFUNDED_OPEN = { ...TASK_UNASSIGNED, id: 501, title: "Open but not funded", status: "open", onChainTaskId: null }
  const FUNDED_OPEN_UNASSIGNED = { ...TASK_UNASSIGNED, id: 99, title: "Find something we say that is not true", status: "open", onChainTaskId: 41 }
  const PAID = { ...TASK_UNASSIGNED, id: 502, title: "Already paid", status: "paid", onChainTaskId: 12 }

  beforeEach(() => {
    H.projects = [EMPTY_PROJECT, PROJECT_P4]
    H.tasks = [TASK_IN_P4, FUNDED_OPEN_UNASSIGNED, UNFUNDED_OPEN, PAID]
    H.apiFetch.mockReset().mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v1/tasks?limit=")) return jsonRes({ ok: true, data: H.tasks })
      if (path === "/api/v1/projects") return jsonRes({ ok: true, data: H.projects })
      throw new Error(`unexpected apiFetch: ${path}`)
    })
  })
  afterEach(cleanup)

  it("lists exactly the open, FUNDED tasks under 'Claimable now' — never an unfunded or a paid one", async () => {
    render(<TasksPage />)
    const strip = await screen.findByRole("region", { name: "Claimable now" })
    const rows = within(strip).getAllByTestId("claimable-now-row")
    expect(rows.map((r) => r.getAttribute("href")).sort()).toEqual(["/tasks/89", "/tasks/99"])
    expect(within(strip).queryByText("Open but not funded")).toBeNull()
    expect(within(strip).queryByText("Already paid")).toBeNull()
  })

  it("puts that strip ABOVE every project card", async () => {
    render(<TasksPage />)
    const strip = await screen.findByRole("region", { name: "Claimable now" })
    const project = screen.getByRole("region", { name: PROJECT_P4.name })
    expect(strip.compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("folds a project with no tasks under one line instead of leading the board with it", async () => {
    render(<TasksPage />)
    await screen.findByRole("region", { name: "Claimable now" })
    const summary = screen.getByText(/1 planned project with no tasks filed yet/)
    const details = summary.closest("details")
    expect(details).not.toBeNull()
    expect(details).not.toHaveAttribute("open")
    // It is still ON the board — folded, not deleted.
    expect(within(details as HTMLElement).getByText("P10 · Finish the grid game")).toBeInTheDocument()
  })

  it("shows no strip at all when nothing is claimable (control)", async () => {
    H.tasks = [UNFUNDED_OPEN, PAID]
    render(<TasksPage />)
    await screen.findByText("Already paid")
    expect(screen.queryByRole("region", { name: "Claimable now" })).toBeNull()
  })
})
