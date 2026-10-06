import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

import { SignInPrompt } from "@/components/wallet/sign-in-prompt"
import { sessionFailure } from "@/lib/session-outcome"

// Mock useWallet at the boundary (same approach as connect-button.test.tsx —
// the RDT-backed provider isn't cleanly unit-mountable). These tests pin the
// new sign-in wiring: signInDetailed() runs on click, and onSignedIn fires ONLY
// on success — so the dead-end → session → reload path can't silently regress.
// Since 2026-10-06 the error line is the gate's own reason, not a guess.
const signIn = vi.fn()
const signInDetailed = vi.fn()
let walletState = {
  account: "account_rdx12abc" as string | null,
  connected: true,
  rdt: {},
  badge: null,
  badgeLoading: false,
  refreshBadge: vi.fn(),
  signChallenge: vi.fn(),
  authed: false,
  user: null,
  signIn,
  signInDetailed,
  ensureSession: vi.fn(),
  ensureSessionDetailed: vi.fn(),
  signOut: vi.fn(),
}

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => walletState,
}))

describe("SignInPrompt", () => {
  beforeEach(() => {
    signIn.mockReset()
    signInDetailed.mockReset()
    cleanup()
  })

  it("renders the title, description, and a Sign in button", () => {
    render(
      <SignInPrompt
        title="Sign in to view submissions"
        description="Approve a signature."
      />,
    )
    expect(screen.getByText("Sign in to view submissions")).toBeInTheDocument()
    expect(screen.getByText("Approve a signature.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument()
  })

  it("calls signInDetailed and, on success, fires onSignedIn", async () => {
    signInDetailed.mockResolvedValue({ ok: true })
    const onSignedIn = vi.fn()
    render(<SignInPrompt onSignedIn={onSignedIn} />)
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await waitFor(() => expect(signInDetailed).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
  })

  it("does NOT fire onSignedIn on failure, and surfaces the gate's own reason", async () => {
    signInDetailed.mockResolvedValue(sessionFailure("wallet-declined"))
    const onSignedIn = vi.fn()
    render(<SignInPrompt onSignedIn={onSignedIn} />)
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await waitFor(() => expect(signInDetailed).toHaveBeenCalledTimes(1))
    expect(onSignedIn).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/declined the sign-in request in your wallet/i))
  })
})
