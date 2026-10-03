import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * /admin — AdminGate and the Badge Manager actions behind it (2026-09-23).
 *
 * The gate asked `loadUserBadge(account, ADMIN_BADGE)`, which only reads an
 * account's NON-fungible resources. ADMIN_BADGE is FUNGIBLE (supply 1,
 * divisibility 0, per the Gateway), so the gate answered "denied" for everyone,
 * including the one account that holds the badge. The only existing check,
 * tests/e2e/admin-gate.spec.ts, covers a disconnected visitor, which a gate
 * that denies everyone passes.
 *
 * This pins that (a) the holder gets the Badge Manager and the check reads a
 * FUNGIBLE balance of ADMIN_BADGE, (b) a non-holder and a failed lookup both
 * fail closed, the failure without claiming the wallet lacks the badge,
 * (c) a verdict never outlives the account it was resolved for, including one
 * that arrives late, and (d) the member actions prove ADMIN_BADGE, while the
 * "Mint Role Badge" action stays gone. It was broken (SCHEMAS.guild_role
 * .adminBadge was "", so the builder threw before the wallet opened) and was
 * then removed: its manager is retired and each mint paid it a 1 XRD royalty.
 *
 * Mock set mirrors tests/unit/profile-archived-session.test.tsx (AppShell,
 * useWallet, the Gateway module). Schemas, config and manifests are real.
 */

const OPERATOR = "account_rdx12yoperator0000000000000000000000000000000000000000000"
const OTHER = "account_rdx12yother000000000000000000000000000000000000000000000000"

type Holding = { ok: true; held: boolean } | { ok: false }

const H = vi.hoisted(() => ({
  account: null as string | null,
  holds: vi.fn(),
  sendTransaction: vi.fn(),
}))

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    account: H.account,
    rdt: { walletApi: { sendTransaction: H.sendTransaction } },
  }),
}))

vi.mock("@/lib/gateway", () => ({
  holdsFungibleBadgeResult: H.holds,
  lookupAllBadges: vi.fn(async () => []),
}))

import AdminPage from "@/app/admin/page"
import { ADMIN_BADGE } from "@/lib/config"
import { SCHEMAS } from "@/lib/schemas"

const CONNECT = "Connect the operator wallet to open the badge manager."
const CHECKING = "Checking operator access…"
const DENIED = /doesn't hold the operator badge/
const UNAVAILABLE = /Couldn't check this wallet for the operator badge/

const tooling = () => screen.queryByRole("heading", { name: "Badge Manager" })

function deferred() {
  let resolve!: (value: Holding) => void
  const promise = new Promise<Holding>((r) => { resolve = r })
  return { promise, resolve }
}

describe("/admin AdminGate — the operator badge is fungible", () => {
  beforeEach(() => {
    H.account = null
    H.holds.mockReset()
    H.sendTransaction.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it("disconnected: the connect prompt on first paint, and no Gateway read", async () => {
    render(<AdminPage />)
    expect(screen.getByText(CONNECT)).toBeInTheDocument()

    // Let the effect's own "no account → denied" verdict land, then look again.
    await act(async () => {})
    expect(screen.getByText(CONNECT)).toBeInTheDocument()
    expect(tooling()).toBeNull()
    expect(H.holds).not.toHaveBeenCalled()
  })

  it("the badge holder gets the Badge Manager, after a fungible read of ADMIN_BADGE", async () => {
    H.account = OPERATOR
    const check = deferred()
    H.holds.mockReturnValueOnce(check.promise)

    render(<AdminPage />)
    expect(screen.getByText(CHECKING)).toBeInTheDocument()
    expect(tooling()).toBeNull()

    await act(async () => { check.resolve({ ok: true, held: true }) })
    expect(tooling()).toBeInTheDocument()
    expect(H.holds).toHaveBeenCalledExactlyOnceWith(OPERATOR, ADMIN_BADGE)
  })

  it("a wallet without the badge is denied", async () => {
    H.account = OTHER
    H.holds.mockResolvedValueOnce({ ok: true, held: false })

    render(<AdminPage />)
    expect(await screen.findByText(DENIED)).toBeInTheDocument()
    expect(tooling()).toBeNull()
  })

  it("a failed lookup fails closed and says the check failed, not that the badge is missing", async () => {
    H.account = OPERATOR
    H.holds.mockResolvedValueOnce({ ok: false })

    render(<AdminPage />)
    expect(await screen.findByText(UNAVAILABLE)).toBeInTheDocument()
    expect(screen.queryByText(DENIED)).toBeNull()
    expect(tooling()).toBeNull()
  })

  it("a lookup that throws fails closed", async () => {
    H.account = OPERATOR
    H.holds.mockRejectedValueOnce(new Error("gateway exploded"))

    render(<AdminPage />)
    expect(await screen.findByText(UNAVAILABLE)).toBeInTheDocument()
    expect(tooling()).toBeNull()
  })

  it("an account switch hides the tooling until the NEW account is checked", async () => {
    H.account = OPERATOR
    H.holds.mockResolvedValueOnce({ ok: true, held: true })
    const { rerender } = render(<AdminPage />)
    expect(await screen.findByRole("heading", { name: "Badge Manager" })).toBeInTheDocument()

    H.account = OTHER
    const otherCheck = deferred()
    H.holds.mockReturnValueOnce(otherCheck.promise)
    rerender(<AdminPage />)
    expect(tooling()).toBeNull()
    expect(screen.getByText(CHECKING)).toBeInTheDocument()

    await act(async () => { otherCheck.resolve({ ok: true, held: false }) })
    expect(screen.getByText(DENIED)).toBeInTheDocument()
    expect(tooling()).toBeNull()
    expect(H.holds).toHaveBeenLastCalledWith(OTHER, ADMIN_BADGE)
  })

  /** OPERATOR connects, then OTHER before OPERATOR's check has answered. */
  function switchMidCheck() {
    H.account = OPERATOR
    const operatorCheck = deferred()
    H.holds.mockReturnValueOnce(operatorCheck.promise)
    const { rerender } = render(<AdminPage />)

    H.account = OTHER
    const otherCheck = deferred()
    H.holds.mockReturnValueOnce(otherCheck.promise)
    rerender(<AdminPage />)
    return { operatorCheck, otherCheck }
  }

  it("the old account's verdict landing first does not open the gate for the new one", async () => {
    const { operatorCheck, otherCheck } = switchMidCheck()

    await act(async () => { operatorCheck.resolve({ ok: true, held: true }) })
    expect(tooling()).toBeNull()
    expect(screen.getByText(CHECKING)).toBeInTheDocument()

    await act(async () => { otherCheck.resolve({ ok: true, held: false }) })
    expect(screen.getByText(DENIED)).toBeInTheDocument()
    expect(tooling()).toBeNull()
  })

  it("the old account's verdict landing last does not overwrite the new one", async () => {
    const { operatorCheck, otherCheck } = switchMidCheck()

    await act(async () => { otherCheck.resolve({ ok: true, held: false }) })
    expect(screen.getByText(DENIED)).toBeInTheDocument()

    await act(async () => { operatorCheck.resolve({ ok: true, held: true }) })
    expect(screen.getByText(DENIED)).toBeInTheDocument()
    expect(tooling()).toBeNull()
  })
})

describe("/admin Badge Manager actions — each proves its own manager's admin badge", () => {
  beforeEach(async () => {
    H.account = OPERATOR
    H.holds.mockReset()
    H.holds.mockResolvedValue({ ok: true, held: true })
    H.sendTransaction.mockReset()
    H.sendTransaction.mockResolvedValue({ isOk: () => true, value: { transactionIntentHash: "txid_rdx1test" } })
    render(<AdminPage />)
    await screen.findByRole("heading", { name: "Badge Manager" })
  })

  afterEach(() => {
    cleanup()
  })

  const fill = (placeholder: string, index: number, value: string) =>
    fireEvent.change(screen.getAllByPlaceholderText(placeholder)[index], { target: { value } })

  it("every schema names a real admin badge resource (guild_role's was blank)", () => {
    for (const cfg of Object.values(SCHEMAS)) {
      expect(cfg.adminBadge).toMatch(/^resource_rdx1[a-z0-9]{20,}$/)
    }
  })

  it("has no Mint Role Badge action (removed: its manager is retired and charged 1 XRD a mint)", () => {
    expect(screen.queryByRole("button", { name: "Mint Role Badge" })).toBeNull()
    expect(screen.queryByPlaceholderText("username")).toBeNull()
  })

  it("every remaining action proves ADMIN_BADGE against the member manager, never the role manager", async () => {
    const actions: [string, () => void, string][] = [
      ["Update Tier", () => fill("<guild_member_bigdevxrd>", 0, "<guild_member_alice>"), "update_tier"],
      ["Update XP", () => { fill("<guild_member_bigdevxrd>", 1, "<guild_member_alice>"); fill("100", 0, "250") }, "update_xp"],
      ["Revoke Badge", () => { fill("<guild_member_bigdevxrd>", 2, "<guild_member_alice>"); fill("Reason", 0, "test") }, "revoke_badge"],
      ["Update Extra Data", () => { fill("<guild_member_bigdevxrd>", 3, "<guild_member_alice>"); fill('{"role":"mod"}', 0, "x") }, "update_extra_data"],
    ]

    for (const [i, [label, fillForm, method]] of actions.entries()) {
      fillForm()
      fireEvent.click(screen.getByRole("button", { name: label }))
      await waitFor(() => expect(H.sendTransaction).toHaveBeenCalledTimes(i + 1))

      const manifest = H.sendTransaction.mock.calls[i][0].transactionManifest as string
      expect(manifest).toContain(`"create_proof_of_amount"\n  Address("${ADMIN_BADGE}")\n  Decimal("1")`)
      expect(manifest).toContain(`Address("${SCHEMAS.guild_member.manager}")\n  "${method}"`)
      expect(manifest).not.toContain(SCHEMAS.guild_role.manager)
      expect(manifest).toContain('NonFungibleLocalId("<guild_member_alice>")')
    }
  })

  it("wraps a bare badge id in <…>: the wallet rejects NonFungibleLocalId(\"guild_member_alice\")", async () => {
    fill("<guild_member_bigdevxrd>", 1, "guild_member_alice"); fill("100", 0, "250")
    fireEvent.click(screen.getByRole("button", { name: "Update XP" }))
    await waitFor(() => expect(H.sendTransaction).toHaveBeenCalledTimes(1))
    const manifest = H.sendTransaction.mock.calls[0][0].transactionManifest as string
    expect(manifest).toContain('NonFungibleLocalId("<guild_member_alice>")')
  })

  it("a badge id the builder refuses shows the error and never reaches the wallet", async () => {
    fill("<guild_member_bigdevxrd>", 0, "not a badge id!")
    fireEvent.click(screen.getByRole("button", { name: "Update Tier" }))
    expect(await screen.findByText(/Invalid badge id/)).toBeInTheDocument()
    expect(H.sendTransaction).not.toHaveBeenCalled()
  })
})
