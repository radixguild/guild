import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * /tasks/create — a disabled "Continue" must say WHY.
 *
 * Signed-out stranger walkthrough, 2026-09-17 (docs/PROJECT-STATE.md), finding 1:
 * "Step 2 'Continue' with an empty Reward does nothing visible — no message, no
 * aria-invalid; a first-time poster sees a dead button." The button was (and
 * still is) `disabled` while the step is incomplete; what was missing was any
 * statement of what it is waiting for.
 *
 * The disabled/enabled TRANSITIONS are pinned by tests/e2e/task-flows.spec.ts
 * and are deliberately unchanged. This file pins the new half: whenever the
 * button is disabled, a `role="status"` line names every missing thing, and it
 * empties the moment nothing is missing.
 *
 * Mocks: identical module set to create-task-github-reality.test.tsx — importing
 * this page transitively pulls in the whole escrow action tree.
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
  useEscrowPostingFrozen: () => null,
}))

vi.mock("@/lib/api-fetch", () => ({
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
import { MIN_REWARD_XRD } from "@/lib/marketplace"

afterEach(cleanup)

const continueBtn = () => screen.getByRole("button", { name: /Continue/ })
const reason = () => screen.getByRole("status")
const titleInput = () => screen.getByPlaceholderText(/Add ledger support/)
const descriptionInput = () => screen.getByPlaceholderText(/Describe what you need/)
const rewardInput = () => screen.getByPlaceholderText("500")

function fillStepOne() {
  fireEvent.change(titleInput(), { target: { value: "A real task title" } })
  fireEvent.change(descriptionInput(), { target: { value: "A description long enough to pass." } })
}

describe("/tasks/create — a disabled Continue says why", () => {
  it("step 1, untouched: Continue is disabled AND the reason names both fields", () => {
    render(<CreateTaskPage />)
    expect(continueBtn()).toBeDisabled()
    expect(reason()).toHaveTextContent(/To continue:/)
    expect(reason()).toHaveTextContent(/title of at least 5 characters/)
    expect(reason()).toHaveTextContent(/at least 10 characters/)
  })

  it("step 1: the reason narrows as fields are fixed, and empties when none are left", () => {
    render(<CreateTaskPage />)
    fireEvent.change(titleInput(), { target: { value: "A real task title" } })
    expect(reason()).not.toHaveTextContent(/title of at least/)
    expect(reason()).toHaveTextContent(/at least 10 characters/)
    expect(continueBtn()).toBeDisabled()

    fireEvent.change(descriptionInput(), { target: { value: "A description long enough to pass." } })
    expect(reason()).toBeEmptyDOMElement()
    expect(continueBtn()).not.toBeDisabled()
  })

  // THE WALKTHROUGH'S EXACT CASE.
  it("step 2 with an EMPTY reward: disabled, and the reason names the reward", () => {
    render(<CreateTaskPage />)
    fillStepOne()
    fireEvent.click(continueBtn()) // what -> reward

    expect(rewardInput()).toHaveValue(null)
    expect(continueBtn()).toBeDisabled()
    expect(reason()).toHaveTextContent("To continue: Enter a reward of at least 1 XRD.")
  })

  it("step 2: a zero reward still blocks; one at the minimum clears the reason and enables Continue", () => {
    render(<CreateTaskPage />)
    fillStepOne()
    fireEvent.click(continueBtn())

    fireEvent.change(rewardInput(), { target: { value: "0" } })
    expect(continueBtn()).toBeDisabled()
    expect(reason()).toHaveTextContent(/Enter a reward of at least 1 XRD/)

    fireEvent.change(rewardInput(), { target: { value: "50" } })
    expect(reason()).toBeEmptyDOMElement()
    expect(continueBtn()).not.toBeDisabled()
  })

  // THE STRANDED-POSTER CASE, on the real page. "0.5" is positive and
  // well-formed; the old `> 0` rule enabled Continue for it, the API took it,
  // and the funding tx then reverted on chain ("reward below per-token
  // minimum" — XRD min_amount is 1). The input's `min` attribute is a browser
  // hint only: jsdom, like a real browser, lets the value through to React.
  // Falsifiable: with the old rule this test fails at the FIRST toBeDisabled.
  it("step 2: a reward BELOW the escrow minimum (0.5) keeps Continue disabled and says the minimum", () => {
    render(<CreateTaskPage />)
    fillStepOne()
    fireEvent.click(continueBtn())

    fireEvent.change(rewardInput(), { target: { value: "0.5" } })
    expect(rewardInput()).toHaveValue(0.5) // the browser hint did NOT stop it — the rule must
    expect(continueBtn()).toBeDisabled()
    expect(reason()).toHaveTextContent("To continue: Enter a reward of at least 1 XRD.")

    fireEvent.change(rewardInput(), { target: { value: "0.99999999" } })
    expect(continueBtn()).toBeDisabled()

    fireEvent.change(rewardInput(), { target: { value: "1" } }) // inclusive
    expect(reason()).toBeEmptyDOMElement()
    expect(continueBtn()).not.toBeDisabled()
  })

  // THE POSTER-CONFUSION CASE, on the real page. "1e3" and "1.000000001" are
  // numbers `Number()` calls at least 1, so the old rule enabled Continue; the
  // API's shape regex refuses both, so the poster met a raw zod error only after
  // Post Task. jsdom, like Chromium, keeps both as the input's value (checked
  // below), so they do reach the rule.
  // Falsifiable: remove the REWARD_SHAPE_RE test from createStepBlockers and
  // this fails at the first toBeDisabled.
  it("step 2: a reward the API refuses for its SHAPE (1e3, 9 decimal places) keeps Continue disabled and says so", () => {
    render(<CreateTaskPage />)
    fillStepOne()
    fireEvent.click(continueBtn())

    fireEvent.change(rewardInput(), { target: { value: "1e3" } })
    expect((rewardInput() as HTMLInputElement).value).toBe("1e3") // not sanitised away — the rule sees it
    expect(continueBtn()).toBeDisabled()
    expect(reason()).toHaveTextContent(
      "To continue: Enter the reward as a plain number (like 250 or 12.5) with up to 8 decimal places.",
    )
    // …and NOT the floor message: 1e3 IS at least 1 XRD.
    expect(reason()).not.toHaveTextContent(/at least/)

    fireEvent.change(rewardInput(), { target: { value: "1.000000001" } })
    expect((rewardInput() as HTMLInputElement).value).toBe("1.000000001")
    expect(continueBtn()).toBeDisabled()
    expect(reason()).toHaveTextContent(/plain number .* up to 8 decimal places/)

    fireEvent.change(rewardInput(), { target: { value: "1000" } }) // the same amount, written plainly
    expect(reason()).toBeEmptyDOMElement()
    expect(continueBtn()).not.toBeDisabled()
  })

  it("step 2: a malformed reward that is ALSO below the minimum (-5, 1e-3) gets the minimum message, not the shape one", () => {
    render(<CreateTaskPage />)
    fillStepOne()
    fireEvent.click(continueBtn())

    for (const value of ["-5", "1e-3"]) {
      fireEvent.change(rewardInput(), { target: { value } })
      expect(continueBtn()).toBeDisabled()
      expect(reason()).toHaveTextContent("To continue: Enter a reward of at least 1 XRD.")
    }
  })

  it("the reward input's `min` hint is the rule's number, not a second copy of it", () => {
    render(<CreateTaskPage />)
    fillStepOne()
    fireEvent.click(continueBtn())
    expect(rewardInput()).toHaveAttribute("min", MIN_REWARD_XRD)
  })

  it("the status region exists BEFORE its text changes (an absent live region announces nothing)", () => {
    render(<CreateTaskPage />)
    fillStepOne()
    // Valid step 1: nothing to say — but the region must still be in the DOM.
    expect(reason()).toBeInTheDocument()
    expect(reason()).toBeEmptyDOMElement()
  })
})

describe("/tasks/create — aria-invalid only after the poster has left the field", () => {
  it("an untouched blocked field is described by the reason line but NOT marked invalid", () => {
    render(<CreateTaskPage />)
    expect(titleInput()).toHaveAttribute("aria-describedby", "create-continue-blocker")
    expect(titleInput()).not.toHaveAttribute("aria-invalid")
  })

  it("blurring a blocked field marks it invalid; fixing it clears both attributes", () => {
    render(<CreateTaskPage />)
    fillStepOne()
    fireEvent.click(continueBtn())

    fireEvent.blur(rewardInput())
    expect(rewardInput()).toHaveAttribute("aria-invalid", "true")
    expect(rewardInput()).toHaveAttribute("aria-describedby", "create-continue-blocker")

    fireEvent.change(rewardInput(), { target: { value: "50" } })
    expect(rewardInput()).not.toHaveAttribute("aria-invalid")
    expect(rewardInput()).not.toHaveAttribute("aria-describedby")
  })
})
describe("/tasks/create — \"Show me\" takes the poster to the first missing field", () => {
  const showMe = () => screen.queryByRole("button", { name: "Show me" })

  it("step 1: focuses the TITLE first (the first blocker), and marks it invalid", () => {
    render(<CreateTaskPage />)
    // The title is autoFocused on mount — without this blur the focus assertion
    // below would pass with the handler deleted (caught by mutation, 2026-09-17).
    titleInput().blur()
    expect(titleInput()).not.toHaveFocus()
    fireEvent.click(showMe()!)
    expect(titleInput()).toHaveFocus()
    expect(titleInput()).toHaveAttribute("aria-invalid", "true")
  })

  it("step 1 with a valid title: focuses the DESCRIPTION instead", () => {
    render(<CreateTaskPage />)
    fireEvent.change(titleInput(), { target: { value: "A real task title" } })
    fireEvent.click(showMe()!)
    expect(descriptionInput()).toHaveFocus()
  })

  it("step 2: focuses the REWARD field — the walkthrough's dead-button case", () => {
    render(<CreateTaskPage />)
    fillStepOne()
    fireEvent.click(continueBtn())
    rewardInput().blur()
    expect(rewardInput()).not.toHaveFocus()

    fireEvent.click(showMe()!)
    expect(rewardInput()).toHaveFocus()
    expect(rewardInput()).toHaveAttribute("aria-invalid", "true")
  })

  it("is not rendered when nothing is blocking — there is nowhere to take them", () => {
    render(<CreateTaskPage />)
    fillStepOne()
    expect(showMe()).toBeNull()
  })

  it("sits OUTSIDE the status region, so it is not re-announced with every text change", () => {
    render(<CreateTaskPage />)
    expect(reason()).not.toContainElement(showMe())
  })
})
