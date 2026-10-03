/**
 * Render test for EscrowClaimButton's poster cancel-after-claim disclosure
 * (PROJECT-STATE.md's 2026-09-01 §20 design packet, unnumbered "Also in §20"
 * bullet — NOT §20.4, an unrelated still-open expire-bounty poster leak —
 * SHIPPABLE-NOW, no ruling needed):
 *   (a) the poster's historical cancel-after-claim count + rate, shown to a
 *       worker BEFORE they claim;
 *   (b) a claim-time disclosure that cancel_task_by_poster_after_claim
 *       returns the worker's claim bond but not their time.
 *
 * Both facts are one block, rendered directly above the Claim Task button
 * whenever `posterCancelStats` is provided. This file only proves the
 * render — the count/rate arithmetic is proven in
 * tests/unit/poster-cancel-stats.test.ts and the DB read that produces it in
 * tests/integration/poster-cancel-stats.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

const ACCOUNT = "account_rdx12worker00000000000000000000000000000000000000000000000"
const POSTER = "account_rdx12poster00000000000000000000000000000000000000000000000"

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  isEscrowDeployed: () => true,
}))

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    account: ACCOUNT,
    rdt: {},
    ensureSession: vi.fn().mockResolvedValue(true),
    sessionMismatch: false,
    badge: { id: "#1#" }, // render-time badge gate satisfied, same as escrow-claim-preflight.test.tsx
    badgeLoading: false,
  }),
}))

vi.mock("@/lib/api-fetch", () => ({ apiFetch: vi.fn() }))

vi.mock("@/lib/gateway", () => ({
  loadUserBadge: vi.fn(),
  findClaimReceiptId: vi.fn(),
  readEscrowTaskState: vi.fn(),
}))

// P4-05 added a balance/bond pre-flight to this same button (useXrdBalance,
// useClaimBond) — mocked to ample/settled values so it never fires here;
// the disclosure block this file tests is unrelated to XRD balance.
vi.mock("@/hooks/useXrdBalance", () => ({
  useXrdBalance: () => ({ balance: 1_000_000, checked: true, recheck: vi.fn() }),
}))
vi.mock("@/hooks/useClaimBond", () => ({
  useClaimBond: () => ({ bond: "76.45", divisibility: 18, status: "ok" }),
}))

vi.mock("@/lib/escrow-utils", () => ({
  sendDepositTx: vi.fn(),
  sendClaimTx: vi.fn(),
  sendSubmitTx: vi.fn(),
  sendApproveTx: vi.fn(),
  sendCancelTx: vi.fn(),
  sendRaiseDisputeTx: vi.fn(),
  sendAutoResolveTx: vi.fn(),
  sendWithdrawTx: vi.fn(),
  sendExpireClaimTx: vi.fn(),
  fetchEscrowRows: vi.fn(),
  fetchOwnSubmissionContent: vi.fn(),
  confirmEscrowTx: vi.fn(),
  humanizeTxError: vi.fn((error: string) => ({ summary: error, detail: undefined, staleState: false })),
  resyncEscrowTask: vi.fn(),
  fileDisputeEvidence: vi.fn(),
}))

import { EscrowClaimButton } from "@/components/tasks/escrow-actions"

describe("EscrowClaimButton — poster cancel-after-claim disclosure", () => {
  beforeEach(() => {
    cleanup()
  })

  it("renders nothing extra when posterCancelStats hasn't loaded yet (task still loading)", () => {
    render(<EscrowClaimButton taskDbId={1} onChainTaskId={7} posterId={POSTER} />)
    expect(screen.queryByText(/posted task/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/claim bond returns/i)).not.toBeInTheDocument()
    // The button itself must still render — the disclosure is additive, never blocking.
    expect(screen.getByRole("button", { name: /claim task/i })).toBeInTheDocument()
  })

  it("shows the count, the computed rate, and the bond-not-time disclosure — 1 of 4 (25%)", () => {
    render(
      <EscrowClaimButton
        taskDbId={1}
        onChainTaskId={7}
        posterId={POSTER}
        posterCancelStats={{ totalPosted: 4, cancelledAfterClaim: 1 }}
      />,
    )

    expect(
      screen.getByText(/cancelled 1 of 4 posted tasks after a worker had already claimed \(25%\)/i),
    ).toBeInTheDocument()
    // (b) the bond-not-time disclosure — must state the chain fact (bond
    // returns) without promising anything the chain doesn't enforce, and must
    // NOT claim the worker is compensated for lost time.
    expect(screen.getByText(/claim bond returns to you in full/i)).toBeInTheDocument()
    expect(screen.getByText(/no payment for time you already spent/i)).toBeInTheDocument()
  })

  it("still renders the disclosure (and a 0% rate, not a blank) for a poster with zero cancels-after-claim", () => {
    render(
      <EscrowClaimButton
        taskDbId={1}
        onChainTaskId={7}
        posterId={POSTER}
        posterCancelStats={{ totalPosted: 5, cancelledAfterClaim: 0 }}
      />,
    )

    expect(
      screen.getByText(/cancelled 0 of 5 posted tasks after a worker had already claimed \(0%\)/i),
    ).toBeInTheDocument()
    expect(screen.getByText(/claim bond returns to you in full/i)).toBeInTheDocument()
  })

  it("pluralizes correctly for a poster with exactly one posted task", () => {
    render(
      <EscrowClaimButton
        taskDbId={1}
        onChainTaskId={7}
        posterId={POSTER}
        posterCancelStats={{ totalPosted: 1, cancelledAfterClaim: 0 }}
      />,
    )

    expect(screen.getByText(/cancelled 0 of 1 posted task after a worker/i)).toBeInTheDocument()
    expect(screen.queryByText(/1 posted tasks/i)).not.toBeInTheDocument()
  })

  it("scales the rate to 3 of 6 (50%) — the third documented fixture", () => {
    render(
      <EscrowClaimButton
        taskDbId={1}
        onChainTaskId={7}
        posterId={POSTER}
        posterCancelStats={{ totalPosted: 6, cancelledAfterClaim: 3 }}
      />,
    )

    expect(
      screen.getByText(/cancelled 3 of 6 posted tasks after a worker had already claimed \(50%\)/i),
    ).toBeInTheDocument()
  })
})
