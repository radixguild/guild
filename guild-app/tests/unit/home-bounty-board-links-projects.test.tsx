import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * Home page Bounty Board — task 89 acceptance: "the home page's bounty
 * board links into projects (and its task rows link to the task's project
 * where one exists)".
 */

const STATS = { counts: { open: 3, assigned: 1, submitted: 0, paid: 2 }, totalPaidXrd: "600" }

const TASK_WITH_PROJECT = {
  id: 89,
  title: "Projects-first board task",
  rewardXrd: "1000",
  status: "open",
  projectId: 4,
}
const TASK_NO_PROJECT = {
  id: 12,
  title: "An unfiled bounty",
  rewardXrd: "50",
  status: "open",
  projectId: null,
}

const PROJECT_P4 = { id: 4, name: "P4 · Product polish", slug: "p4-product-polish" }

const H = vi.hoisted(() => ({
  recent: [] as unknown[],
  projects: [] as unknown[],
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

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    account: null,
    connected: false,
    badge: null,
    badgeLoading: false,
    badgeError: null,
    refreshBadge: vi.fn(),
  }),
}))

vi.mock("@/lib/api-fetch", () => ({
  apiFetch: H.apiFetch,
}))

import Home from "@/app/page"

const jsonRes = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

describe("Home Bounty Board links into projects", () => {
  beforeEach(() => {
    H.recent = [TASK_WITH_PROJECT, TASK_NO_PROJECT]
    H.projects = [PROJECT_P4]
    H.apiFetch.mockReset().mockImplementation(async (path: string) => {
      if (path === "/api/v1/tasks/stats") return jsonRes({ ok: true, data: STATS })
      if (path.startsWith("/api/v1/tasks?limit=")) return jsonRes({ ok: true, data: H.recent })
      if (path === "/api/v1/projects") return jsonRes({ ok: true, data: H.projects })
      // DisputeActionRequired makes no calls with no connected account, but
      // fail loudly rather than silently if that ever changes.
      throw new Error(`unexpected apiFetch: ${path}`)
    })
  })
  afterEach(cleanup)

  it("the Bounty Board CTA links to /projects, not the flat /tasks grid", async () => {
    render(<Home />)
    const cta = await screen.findByRole("link", { name: "View Projects" })
    expect(cta).toHaveAttribute("href", "/projects")
  })

  it("a recent task row with a resolvable project links to that project", async () => {
    render(<Home />)
    const row = await screen.findByText("Projects-first board task")
    const link = row.closest("a")
    expect(link).not.toBeNull()
    expect(link).toHaveAttribute("href", "/projects/p4-product-polish")
  })

  it("a recent task row with no project stays a plain row, not a broken link", async () => {
    render(<Home />)
    await screen.findByText("Projects-first board task")
    const row = screen.getByText("An unfiled bounty")
    expect(row.closest("a")).toBeNull()
  })
})
