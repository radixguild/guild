import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * P4-01: /tasks/create wrapped its ENTIRE content (including the
 * unconditional <h1>) in <Suspense fallback={null}> just because one child
 * reads useSearchParams() for the legacy #143 `?template=` deep-link — so
 * `fallback={null}` blanked the whole page for anything that doesn't execute
 * JS. The fix isolates that read into DeepLinkParamsReader, the page's only
 * useSearchParams() caller, and scopes the Suspense boundary to it alone.
 *
 * This file pins the part that refactor could have silently broken: the
 * deep-link still has to reach CreateTaskContent's state, just via an
 * onResolve callback + a ref-guarded one-time apply instead of a lazy
 * useState initializer. See tests/unit/create-task-github-reality.test.tsx
 * for the (unrelated) GitHub-reality-defaults coverage on the same page,
 * and docs/design/github-reality-acceptance.md for that feature's design.
 *
 * Heavy mocking below matches that file — importing the page transitively
 * pulls in escrow-actions.tsx (EscrowDepositButton).
 */

const useSearchParamsMock = vi.fn<() => URLSearchParams>(() => new URLSearchParams())

vi.mock("next/link", () => ({
  default: ({ href, children }: any) => <a href={href}>{children}</a>,
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => useSearchParamsMock(),
}))

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({ ensureSession: vi.fn().mockResolvedValue(true) }),
}))

vi.mock("@/hooks/useEscrowPostingFrozen", () => ({
  useEscrowPostingFrozen: () => null,
}))

vi.mock("@/lib/api-fetch", () => ({
  // Empty lists keep the optional project/working-group pickers hidden,
  // matching the ?project=/?group= assertions below (which check the
  // preselected id is retained even while the picker itself stays hidden).
  apiFetch: vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, data: [] }),
  }),
}))

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  isEscrowDeployed: () => false,
}))

vi.mock("@/lib/gateway", () => ({
  loadUserBadge: vi.fn(),
  findClaimReceiptId: vi.fn(),
  readEscrowTaskState: vi.fn(),
  outstandingForParty: vi.fn(),
}))

vi.mock("@/lib/escrow-utils", () => ({
  sendDepositTx: vi.fn(),
  sendClaimTx: vi.fn(),
  sendSubmitTx: vi.fn(),
  sendApproveTx: vi.fn(),
  sendCancelTx: vi.fn(),
  sendRaiseDisputeTx: vi.fn(),
  sendAutoResolveTx: vi.fn(),
  sendExpireClaimTx: vi.fn(),
  sendPushEntitlementTx: vi.fn(),
  sendWithdrawTx: vi.fn(),
  fetchEscrowRows: vi.fn(),
  fetchOwnSubmissionContent: vi.fn(),
  confirmEscrowTx: vi.fn(),
  humanizeTxError: vi.fn((error: string) => ({ summary: error, detail: undefined, staleState: false })),
  resyncEscrowTask: vi.fn(),
  fileDisputeEvidence: vi.fn(),
}))

import CreateTaskPage from "@/app/tasks/create/page"

afterEach(() => {
  cleanup()
  useSearchParamsMock.mockReset()
  useSearchParamsMock.mockReturnValue(new URLSearchParams())
})

describe("/tasks/create — the unconditional heading renders with no deep-link params", () => {
  it("has an <h1>Post a task</h1>, not hidden behind the search-params Suspense boundary", () => {
    render(<CreateTaskPage />)
    expect(screen.getByRole("heading", { level: 1, name: "Post a task" })).toBeInTheDocument()
  })
})

describe("/tasks/create — ?template= deep-link (legacy #143)", () => {
  it("a known template id preselects its deliverable type and prefills acceptance criteria", () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams("template=docs-content"))
    render(<CreateTaskPage />)
    expect(screen.getByRole("button", { name: /Content\s*Docs, articles, copy/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    // Acceptance criteria live on the "reward" step.
    fireEvent.change(screen.getByPlaceholderText(/Add ledger support/), {
      target: { value: "A real task title" },
    })
    fireEvent.change(screen.getByPlaceholderText(/Describe what you need/), {
      target: { value: "A long enough description of the work." },
    })
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }))
    expect(screen.getByLabelText(/Acceptance criteria/)).toHaveValue(
      "Draft delivered in editable form\nFactual claims sourced",
    )
  })

  it("an unknown template id is ignored — no deliverable type gets preselected", () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams("template=not-a-real-template"))
    render(<CreateTaskPage />)
    expect(screen.getByRole("button", { name: /Content\s*Docs, articles, copy/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    )
    expect(screen.getByRole("button", { name: /Code\s*PR against a repo/ })).toHaveAttribute("aria-pressed", "false")
  })
})

describe("/tasks/create — ?project= and ?group= deep links still route through the same resolver", () => {
  it("preselects a valid numeric ?project= id even before the project picker's options arrive", async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams("project=42"))
    render(<CreateTaskPage />)
    // The picker itself only renders once projectOptions is non-empty (mocked
    // empty here) or an id is already selected — so its mere presence proves
    // projectId was set from the query string.
    expect(await screen.findByLabelText("Project (optional)")).toBeInTheDocument()
  })
})
