import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

import { SignInPrompt } from "@/components/wallet/sign-in-prompt"

// Mock useWallet at the boundary (same approach as connect-button.test.tsx —
// the RDT-backed provider isn't cleanly unit-mountable). These tests pin the
// new sign-in wiring: signIn() runs on click, and onSignedIn fires ONLY on
// success — so the dead-end → session → reload path can't silently regress.
const signIn = vi.fn()
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
  ensureSession: vi.fn(),
  signOut: vi.fn(),
}

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => walletState,
}))

describe("SignInPrompt", () => {
  beforeEach(() => {
    signIn.mockReset()
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

  it("calls signIn and, on success, fires onSignedIn", async () => {
    signIn.mockResolvedValue(true)
    const onSignedIn = vi.fn()
    render(<SignInPrompt onSignedIn={onSignedIn} />)
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
  })

  it("does NOT fire onSignedIn on failure, and surfaces an error", async () => {
    signIn.mockResolvedValue(false)
    const onSignedIn = vi.fn()
    render(<SignInPrompt onSignedIn={onSignedIn} />)
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1))
    expect(onSignedIn).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())
  })
})
