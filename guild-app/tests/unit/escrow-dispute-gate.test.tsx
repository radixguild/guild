import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * The G-L launch guarantee, as a tripwire: NO dispute affordance may render
 * while NEXT_PUBLIC_FEATURE_DISPUTES is off. "Disputes dormant" is the SOLE
 * mitigation for BUG-7 (public auto_resolve drains to the caller's manifest)
 * and H1 (winner-take-all finalize vs the live SplitEvenly default) — see
 * features.ts and docs/GUILD-PRODUCTION-PLAN-2026-07-16.md §3.
 *
 * Every OTHER render condition is deliberately satisfied (escrow deployed,
 * wallet connected, funded task, caller is the poster), and the flag-ON cases
 * prove it — so the flag-OFF cases can't pass vacuously on some unrelated
 * guard short-circuiting first.
 */

const H = vi.hoisted(() => ({ disputes: false }))

vi.mock("@/lib/features", () => ({
  isEnabled: (flag: string) => (flag === "disputes" ? H.disputes : true),
}))

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  isEscrowDeployed: () => true,
}))

const POSTER = "account_rdx12ynlx369poster000000000000000000000000000000000000000000"
const WORKER = "account_rdx12890803worker000000000000000000000000000000000000000000"

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    account: POSTER,
    connected: true,
    rdt: {},
    ensureSession: vi.fn(),
    sessionMismatch: false,
  }),
}))

import { RaiseDisputeButton, FinalizeDisputeButton } from "@/components/tasks/escrow-actions"

// disputedAt 73h ago → the finalize window is OPEN, the strongest render case.
const DISPUTED_AT = new Date(Date.now() - 73 * 3600 * 1000)

function renderRaise() {
  return render(
    <RaiseDisputeButton taskDbId={1} onChainTaskId={7} posterId={POSTER} workerId={WORKER} />,
  )
}

function renderFinalize() {
  return render(
    <FinalizeDisputeButton
      taskDbId={1}
      onChainTaskId={7}
      posterId={POSTER}
      workerId={WORKER}
      disputedAt={DISPUTED_AT}
    />,
  )
}

describe("dispute UI launch gate (NEXT_PUBLIC_FEATURE_DISPUTES)", () => {
  beforeEach(() => {
    cleanup()
    H.disputes = false
  })

  it("flag OFF: RaiseDisputeButton renders NOTHING even for the task's poster", () => {
    const { container } = renderRaise()
    expect(container.firstChild).toBeNull()
  })

  it("flag OFF: FinalizeDisputeButton renders NOTHING even with the window open", () => {
    const { container } = renderFinalize()
    expect(container.firstChild).toBeNull()
  })

  it("flag ON: RaiseDisputeButton renders (proves the OFF case isn't vacuous)", () => {
    H.disputes = true
    renderRaise()
    expect(screen.getByRole("button", { name: /raise dispute/i })).toBeInTheDocument()
  })

  it("flag ON: FinalizeDisputeButton renders the finalize action", () => {
    H.disputes = true
    renderFinalize()
    expect(
      screen.getByRole("button", { name: /finalize dispute/i }),
    ).toBeInTheDocument()
  })

  it("the real flag module defaults disputes OFF (env unset in this run)", async () => {
    // Bypass the file-level mock: the REAL features.ts must read a missing
    // NEXT_PUBLIC_FEATURE_DISPUTES as false — the fail-closed launch default.
    const real = await vi.importActual<typeof import("@/lib/features")>("@/lib/features")
    expect(process.env.NEXT_PUBLIC_FEATURE_DISPUTES).toBeUndefined()
    expect(real.isEnabled("disputes")).toBe(false)
  })
})
