import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * A Gateway read failure must NOT render as "nothing is owed".
 *
 * Under pull an entitlement sits in the component until the payee collects it.
 * `useOnChainTaskInfo` used to return a bare `OnChainTaskInfo | null`, so a
 * failed read and a settled-and-collected task produced the identical value —
 * and `EscrowWithdrawButton` returned `null` for both. A payment genuinely owed
 * to the viewer rendered pixel-for-pixel identically to no payment at all: no
 * button, no error, nothing to go looking for.
 *
 * That is the exact failure the withdraw affordance was built for. PROJECT-STATE
 * records a real poster completing a settlement without noticing the money owed
 * to them, and the fix for THAT was this button.
 *
 * The falsifying input is named explicitly: with the fix reverted (the button
 * returning null whenever `affordance.kind === "none"`), the first test below
 * finds no alert and fails. The second and third exist so it cannot pass
 * vacuously by simply always rendering something.
 */

const H = vi.hoisted(() => ({
  // What the Gateway read does: "throw" | "ok"
  mode: "throw" as "throw" | "ok",
  info: null as unknown,
}))

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  isEscrowDeployed: () => true,
}))

vi.mock("@/lib/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gateway")>()),
  readEscrowTaskInfo: vi.fn(async () => {
    if (H.mode === "throw") throw new Error("gateway unreachable")
    return H.info
  }),
}))

const VIEWER = "account_rdx12ynlx369viewer000000000000000000000000000000000000000000"

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    account: VIEWER,
    connected: true,
    rdt: {},
    ensureSession: vi.fn(),
    sessionMismatch: false,
  }),
}))

import { EscrowWithdrawButton } from "@/components/tasks/escrow-actions"

const renderButton = () => render(<EscrowWithdrawButton taskDbId={1} onChainTaskId={7} />)

/** The component reads on mount; let the rejected/resolved promise settle. */
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0))
}

describe("withdraw affordance on a failed on-chain read", () => {
  beforeEach(() => {
    H.mode = "throw"
    H.info = null
  })
  afterEach(cleanup)

  it("says it could not tell — it does not render silence", async () => {
    renderButton()
    await settle()
    // The LoadFailed primitive, not a Collect button and not nothing.
    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(screen.getByText(/what this task owes you/i)).toBeInTheDocument()
  })

  it("offers a retry, because the honest answer is 'ask again'", async () => {
    renderButton()
    await settle()
    expect(await screen.findByRole("button", { name: /retry|try again/i })).toBeInTheDocument()
  })

  it("stays silent when the read SUCCEEDS and nothing is owed", async () => {
    // The control. If this also rendered the failure state, the first test
    // would be proving nothing — the component would just always shout.
    H.mode = "ok"
    H.info = null
    renderButton()
    await settle()
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
