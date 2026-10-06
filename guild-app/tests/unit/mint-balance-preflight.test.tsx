import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * /mint's XRD balance pre-flight, wired through useXrdBalance.
 *
 * WHY THIS FILE EXISTS. Until 2026-09-16 the mint page ran its OWN balance
 * fetch — a bare `xrdBalance` / `balanceChecked` pair never tagged with the
 * account it was read for — while useXrdBalance's docblock claimed the page
 * had already been migrated onto it. That local copy disabled Mint on data
 * already known to be stale, three ways: wallet switch A → B, disconnect →
 * reconnect the same account, and an unguarded recheck. The hook handles all
 * three and its own suite proves it (use-xrd-balance.test.ts).
 *
 * What the hook's suite CANNOT prove is that this page wires it correctly — in
 * particular the `account && !badge ? account : null` argument, and that the
 * page reads the hook rather than a local shadow of it. That is what this file
 * pins, at the page level, against the rendered Mint button.
 *
 * ⚠️ Every case that asserts on the button types a VALID username first. Mint
 * is disabled whenever the username is empty, so a "disabled" assertion without
 * one passes whatever the balance logic does — a fixture that coincides with
 * the bug it claims to guard.
 */

const A = "account_rdx12mintbalanceaaaa0000000000000000000000000000000000000000"
const B = "account_rdx12mintbalancebbbb0000000000000000000000000000000000000000"

const H = vi.hoisted(() => ({
  account: null as string | null,
  badge: null as null | { id: string; tier: string; level: number },
  // Per-account balance behaviour. A never-settling promise models "fetch in
  // flight", which is the only window in which a stale reading can be served.
  impl: (_acct: string): Promise<number | null> => Promise.resolve(100),
}))

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/badge-card", () => ({ BadgeCard: () => <div>badge-card</div> }))
vi.mock("@/components/tier-progression", () => ({ TierProgression: () => null }))

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    account: H.account,
    connected: !!H.account,
    rdt: {},
    badge: H.badge,
    badgeLoading: false,
    badgeError: false,
    refreshBadge: vi.fn(),
  }),
}))

const fetchXrdBalance = vi.hoisted(() => vi.fn((acct: string) => H.impl(acct)))
vi.mock("@/lib/gateway", () => ({ fetchXrdBalance }))

vi.mock("@/lib/use-xrd-usd", () => ({
  useXrdUsd: () => ({ rate: null }),
}))

import MintPage from "@/app/mint/page"
import { KUCOIN_XRD_URL } from "@/components/get-xrd-links"

const PENDING = () => new Promise<number | null>(() => {})
const mintButton = () => screen.getByRole("button", { name: /Mint Guild Badge/ })
const noXrdNotice = () => screen.queryByText(/This account has no XRD/i)
const typeValidUsername = () =>
  fireEvent.change(screen.getByPlaceholderText("e.g. bigdevxrd"), { target: { value: "valid_name" } })

beforeEach(() => {
  H.account = null
  H.badge = null
  H.impl = () => Promise.resolve(100)
  fetchXrdBalance.mockClear()
})
afterEach(cleanup)

describe("/mint balance pre-flight — wired through useXrdBalance", () => {
  it("confirmed 0 XRD: shows the no-XRD notice and disables Mint", async () => {
    H.account = A
    H.impl = () => Promise.resolve(0)
    render(<MintPage />)
    typeValidUsername()
    await waitFor(() => expect(noXrdNotice()).toBeInTheDocument())
    expect(mintButton()).toBeDisabled()
  })

  it("the no-XRD notice says where to get XRD: KuCoin, in a new tab", async () => {
    H.account = A
    H.impl = () => Promise.resolve(0)
    render(<MintPage />)
    typeValidUsername()
    await waitFor(() => expect(noXrdNotice()).toBeInTheDocument())
    const kucoin = screen.getByRole("link", { name: /kucoin/i })
    expect(kucoin).toHaveAttribute("href", KUCOIN_XRD_URL)
    expect(kucoin).toHaveAttribute("target", "_blank")
    expect(kucoin).toHaveAttribute("rel", "noopener noreferrer")
    // 2026-10-06: Alchemy Pay's ramp would not sell XRD, so it is not offered.
    expect(screen.queryByRole("link", { name: /alchemy pay/i })).toBeNull()
  })

  it("control: a funded wallet with a valid username can mint", async () => {
    // Without this, the case above could pass because Mint is disabled for
    // some unrelated reason. Same username, funded account → enabled.
    H.account = A
    H.impl = () => Promise.resolve(100)
    render(<MintPage />)
    typeValidUsername()
    await waitFor(() => expect(fetchXrdBalance).toHaveBeenCalledWith(A))
    expect(noXrdNotice()).not.toBeInTheDocument()
    expect(mintButton()).toBeEnabled()
  })

  /**
   * THE REGRESSION GUARD. MUTATION CHECK — restore the page's pre-2026-09-16
   * local `useState` + `useEffect` fetch and this goes red: `balanceChecked`
   * stays true and `xrdBalance` stays at A's 0 across the switch, so B renders
   * "This account has no XRD" over a disabled Mint button until B's own fetch
   * lands.
   */
  it("switching from an empty wallet to another never disables Mint on the first wallet's balance", async () => {
    H.account = A
    H.impl = (acct) => (acct === A ? Promise.resolve(0) : PENDING())
    const { rerender } = render(<MintPage />)
    typeValidUsername()
    await waitFor(() => expect(noXrdNotice()).toBeInTheDocument())

    H.account = B // B's balance is still in flight
    rerender(<MintPage />)

    expect(noXrdNotice()).not.toBeInTheDocument()
    expect(mintButton()).toBeEnabled() // unknown balance fails OPEN, never on A's number
  })

  /**
   * MUTATION CHECK — same restoration as above goes red here too: the early
   * `if (!account) return` in the old effect never cleared state on disconnect,
   * so A's confirmed 0 came straight back on reconnect.
   */
  it("reconnecting the same empty wallet does not bring back its pre-disconnect reading", async () => {
    H.account = A
    H.impl = () => Promise.resolve(0)
    const { rerender } = render(<MintPage />)
    typeValidUsername()
    await waitFor(() => expect(noXrdNotice()).toBeInTheDocument())

    H.account = null // disconnect
    rerender(<MintPage />)

    H.account = A
    H.impl = PENDING // the reconnect's fetch has not landed yet
    rerender(<MintPage />)
    typeValidUsername()

    expect(noXrdNotice()).not.toBeInTheDocument()
    expect(mintButton()).toBeEnabled()
  })

  /**
   * MUTATION CHECK — pass `account` to useXrdBalance unconditionally (drop the
   * `&& !badge`) and this goes red: a wallet that already holds a badge, and is
   * shown the badge card rather than the mint form, still spends a Gateway read.
   */
  it("an already-badged wallet never fetches a balance", async () => {
    H.account = A
    H.badge = { id: "#1#", tier: "member", level: 1 }
    render(<MintPage />)
    expect(await screen.findByText("badge-card")).toBeInTheDocument()
    expect(fetchXrdBalance).not.toHaveBeenCalled()
  })
})
