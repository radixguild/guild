import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * Step 3 of docs/design/github-reality-acceptance.md's build plan: a
 * code/software task defaults onto the GitHub-reality path on
 * /tasks/create. `definitionOfDone` already picked up its machine-verifiable
 * checks (ci-green, code-reviewed) from DELIVERABLE_DEFAULTS.code the moment
 * a "Code" task type is selected (pre-existing #143 template mechanism) —
 * this pins that it still does, plus the genuinely new part: the repoUrl
 * field's "expected, not required" treatment (label + helper text + a soft,
 * non-blocking warning), scoped to the code category only, and that it never
 * overrides an explicit user edit.
 *
 * Heavy mocking below exists because importing this page transitively pulls
 * in escrow-actions.tsx (EscrowDepositButton) — same shape as
 * tests/unit/poster-cancel-disclosure-honest-copy.test.tsx, which mocks the
 * identical module set to safely exercise a different component from the
 * same file.
 */

vi.mock("next/link", () => ({
  default: ({ href, children }: any) => <a href={href}>{children}</a>,
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({ ensureSession: vi.fn().mockResolvedValue(true), ensureSessionDetailed: vi.fn().mockResolvedValue({ ok: true }) }),
}))

vi.mock("@/hooks/useEscrowPostingFrozen", () => ({
  useEscrowPostingFrozen: () => null, // fail-open: no freeze notice in these tests
}))

vi.mock("@/lib/api-fetch", () => ({
  // Backs the create page's on-mount /projects + /groups catalog fetches.
  // Empty lists keep the optional project/working-group pickers hidden,
  // which is irrelevant to this feature and would only add noise.
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

afterEach(cleanup)

const repoLabel = () => screen.getByText(/^Repository/)
const repoInput = () => screen.getByPlaceholderText("https://github.com/org/repo")
const warning = () => screen.queryByText(/No repo linked yet/)
const codeTypeButton = () => screen.getByRole("button", { name: /Code\s*PR against a repo/ })
const designTypeButton = () => screen.getByRole("button", { name: /Design\s*Figma, assets, branding/ })

/** Fills the two required "what" fields and advances to the "reward" step,
 *  where the definitionOfDone toggles live. */
function goToRewardStep() {
  fireEvent.change(screen.getByPlaceholderText(/Add ledger support/), {
    target: { value: "A real task title" },
  })
  fireEvent.change(screen.getByPlaceholderText(/Describe what you need/), {
    target: { value: "A long enough description of the work." },
  })
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }))
}

describe("/tasks/create — GitHub-reality defaults for a code-category task", () => {
  it("no deliverable type picked yet: today's plain 'Repository (optional)', no warning", () => {
    render(<CreateTaskPage />)
    expect(repoLabel().textContent).toBe("Repository (optional)")
    expect(warning()).not.toBeInTheDocument()
  })

  it("picking Code: definitionOfDone defaults include ci-green + code-reviewed (pre-existing DELIVERABLE_DEFAULTS.code, still true)", () => {
    render(<CreateTaskPage />)
    fireEvent.click(codeTypeButton())
    goToRewardStep() // the done-check toggles live on the reward step
    expect(screen.getByRole("button", { name: "CI green" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Code reviewed" })).toHaveAttribute("aria-pressed", "true")
  })

  it("picking Code: repo field becomes 'expected' (no '(optional)'), helper text changes, and warns while empty", () => {
    render(<CreateTaskPage />)
    fireEvent.click(codeTypeButton())
    expect(repoLabel().textContent).toBe("Repository")
    expect(screen.getByText(/GitHub reality can check the work/)).toBeInTheDocument()
    expect(warning()).toBeInTheDocument()
  })

  it("picking Code then filling the repo field clears the warning", () => {
    render(<CreateTaskPage />)
    fireEvent.click(codeTypeButton())
    expect(warning()).toBeInTheDocument()
    fireEvent.change(repoInput(), { target: { value: "https://github.com/bigdevxrd/guild-saas" } })
    expect(warning()).not.toBeInTheDocument()
  })

  it("a NON-code category (Design) keeps today's behaviour — no warning, '(optional)' label stays", () => {
    render(<CreateTaskPage />)
    fireEvent.click(designTypeButton())
    expect(repoLabel().textContent).toBe("Repository (optional)")
    expect(warning()).not.toBeInTheDocument()
  })

  it("switching Code -> Design removes the expected-repo treatment (category-driven, not sticky)", () => {
    render(<CreateTaskPage />)
    fireEvent.click(codeTypeButton())
    expect(repoLabel().textContent).toBe("Repository")
    fireEvent.click(designTypeButton())
    expect(repoLabel().textContent).toBe("Repository (optional)")
  })
})

describe("/tasks/create — an explicit user edit is never silently overridden", () => {
  it("unchecking a done-check after picking Code stays unchecked (no re-apply of defaults)", () => {
    render(<CreateTaskPage />)
    fireEvent.click(codeTypeButton())
    goToRewardStep()

    const ciGreenToggle = screen.getByRole("button", { name: "CI green" })
    expect(ciGreenToggle).toHaveAttribute("aria-pressed", "true") // DELIVERABLE_DEFAULTS.code default
    fireEvent.click(ciGreenToggle) // explicit user edit: turn it off
    expect(ciGreenToggle).toHaveAttribute("aria-pressed", "false")

    // Nothing in this component re-applies the type default on its own —
    // confirm the toggle is still off after other, unrelated state changes.
    fireEvent.click(screen.getByRole("button", { name: /Back/ }))
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }))
    expect(screen.getByRole("button", { name: "CI green" })).toHaveAttribute("aria-pressed", "false")
  })

  it("a manually-typed repoUrl survives navigating away from and back to the 'what' step", () => {
    render(<CreateTaskPage />)
    fireEvent.click(codeTypeButton())
    fireEvent.change(repoInput(), { target: { value: "https://github.com/bigdevxrd/custom-repo" } })
    fireEvent.change(screen.getByPlaceholderText(/Add ledger support/), { target: { value: "A real task title" } })
    fireEvent.change(screen.getByPlaceholderText(/Describe what you need/), {
      target: { value: "A long enough description of the work." },
    })
    fireEvent.click(screen.getByRole("button", { name: /Continue/ })) // what -> reward
    fireEvent.click(screen.getByRole("button", { name: /Back/ })) // reward -> what
    expect((repoInput() as HTMLInputElement).value).toBe("https://github.com/bigdevxrd/custom-repo")
  })
})
