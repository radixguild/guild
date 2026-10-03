import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * Mint-form username UX (operator feedback, 2026-07-18 wallet acceptance run):
 * the poster's first live mint died on the on-chain charset rule, discovered
 * only via the post-click error. Pins the fix — the rule is (1) stated up
 * front, (2) enforced live with a hint, (3) the Mint button disables while
 * the input is invalid (so the doomed click can't happen at all).
 */

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    account: "account_rdx1283xglqposter00000000000000000000000000000000000000000",
    connected: true,
    rdt: {},
    badge: null,
    badgeLoading: false,
    badgeError: false,
    refreshBadge: vi.fn(),
  }),
}))

// Confirmed positive balance → neither the noXrd block nor the lowXrd warning
// interferes; the button state is driven by the username alone.
vi.mock("@/lib/gateway", () => ({
  fetchXrdBalance: vi.fn(async () => 100),
}))

vi.mock("@/lib/use-xrd-usd", () => ({
  useXrdUsd: () => ({ rate: null }),
}))

import MintPage from "@/app/mint/page"

afterEach(cleanup)

const input = () => screen.getByPlaceholderText("e.g. bigdevxrd")
const mintButton = () => screen.getByRole("button", { name: /Mint Guild Badge/ })

describe("mint username charset UX", () => {
  it("states the charset rule up front, before any input", () => {
    render(<MintPage />)
    expect(screen.getByText(/only — no spaces/)).toBeInTheDocument()
  })

  it("invalid username → live hint + disabled Mint button", () => {
    render(<MintPage />)
    fireEvent.change(input(), { target: { value: "bad name!" } })
    expect(
      screen.getByText(/Remove spaces\/special characters/),
    ).toBeInTheDocument()
    expect(input()).toHaveAttribute("aria-invalid", "true")
    expect(mintButton()).toBeDisabled()
  })

  it("valid username → no hint, button enabled", () => {
    render(<MintPage />)
    fireEvent.change(input(), { target: { value: "good_name_1" } })
    expect(
      screen.queryByText(/Remove spaces\/special characters/),
    ).not.toBeInTheDocument()
    expect(mintButton()).toBeEnabled()
  })

  it("🔴 a dash is invalid — the chain refuses '-' in a badge id (mainnet preview: ContainsBadCharacter)", () => {
    render(<MintPage />)
    fireEvent.change(input(), { target: { value: "good-name" } })
    expect(screen.getByText(/Remove spaces\/special characters/)).toBeInTheDocument()
    expect(mintButton()).toBeDisabled()
  })

  it("the input stops at 51 characters — the longest name whose badge id fits the chain's 64", () => {
    render(<MintPage />)
    expect(input()).toHaveAttribute("maxLength", "51")
    expect(screen.getByText(/\/51 characters/)).toBeInTheDocument()
  })

  it("empty input → button disabled but no scary hint", () => {
    render(<MintPage />)
    expect(mintButton()).toBeDisabled()
    expect(
      screen.queryByText(/Remove spaces\/special characters/),
    ).not.toBeInTheDocument()
  })
})
