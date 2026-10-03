/**
 * Client-wiring test for EscrowClaimButton's self-claim pre-flight (P3-3b).
 *
 * The server route (tests/unit/escrow-claim-check-route.test.ts) proves the
 * 403 itself. This file proves the OTHER half of the deliverable: that the
 * browser button actually calls that route, and — critically — BEFORE it
 * ever calls sendClaimTx (the function that signs and broadcasts the
 * fee-burning on-chain tx). A regression that reordered the two (or dropped
 * the pre-flight call entirely) would slip past a route-only test suite.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
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
    badge: { id: "#1#" }, // render-time badge gate satisfied
    badgeLoading: false,
  }),
}))

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }))
vi.mock("@/lib/api-fetch", () => ({ apiFetch: mockApiFetch }))

const { mockLoadUserBadge, mockReadEscrowTaskState } = vi.hoisted(() => ({
  mockLoadUserBadge: vi.fn(),
  mockReadEscrowTaskState: vi.fn(),
}))
vi.mock("@/lib/gateway", () => ({
  loadUserBadge: mockLoadUserBadge,
  findClaimReceiptId: vi.fn(),
  readEscrowTaskState: mockReadEscrowTaskState,
}))

// P4-05 added a balance/bond pre-flight to this same button, sourced from
// two OTHER hooks (useXrdBalance, useClaimBond) rather than @/lib/gateway
// directly. Mock them at ample/settled values so this file's self-claim
// assertions (unrelated to XRD balance) aren't perturbed by the new gate —
// the balance-preflight behaviour itself is pinned in
// escrow-claim-balance-preflight.test.tsx.
vi.mock("@/hooks/useXrdBalance", () => ({
  useXrdBalance: () => ({ balance: 1_000_000, checked: true, recheck: vi.fn() }),
}))
vi.mock("@/hooks/useClaimBond", () => ({
  useClaimBond: () => ({ bond: "76.45", divisibility: 18, status: "ok" }),
}))

const { mockSendClaimTx, mockConfirmEscrowTx, mockResyncEscrowTask } = vi.hoisted(() => ({
  mockSendClaimTx: vi.fn(),
  mockConfirmEscrowTx: vi.fn(),
  mockResyncEscrowTask: vi.fn(),
}))
vi.mock("@/lib/escrow-utils", () => ({
  sendDepositTx: vi.fn(),
  sendClaimTx: mockSendClaimTx,
  sendSubmitTx: vi.fn(),
  sendApproveTx: vi.fn(),
  sendCancelTx: vi.fn(),
  sendRaiseDisputeTx: vi.fn(),
  sendAutoResolveTx: vi.fn(),
  sendWithdrawTx: vi.fn(),
  fetchEscrowRows: vi.fn(),
  fetchOwnSubmissionContent: vi.fn(),
  confirmEscrowTx: mockConfirmEscrowTx,
  // TxError renders `summary`, not the raw string — echo it back so the
  // assertions can match on the actual message the precheck set.
  humanizeTxError: vi.fn((error: string) => ({ summary: error, detail: undefined, staleState: false })),
  resyncEscrowTask: mockResyncEscrowTask,
}))

import { EscrowClaimButton } from "@/components/tasks/escrow-actions"

function renderClaim() {
  return render(
    <EscrowClaimButton taskDbId={1} onChainTaskId={7} posterId={POSTER} />,
  )
}

describe("EscrowClaimButton — self-claim pre-flight wiring", () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    mockLoadUserBadge.mockResolvedValue({ id: "#1#" })
    mockReadEscrowTaskState.mockResolvedValue("Open")
    mockSendClaimTx.mockResolvedValue({ ok: true, txId: "txid_rdx1abc" })
    mockConfirmEscrowTx.mockResolvedValue({ ok: true })
  })

  it("blocks the claim and never calls sendClaimTx when the server pre-flight denies it (403 SELF_CLAIM)", async () => {
    mockApiFetch.mockResolvedValue({
      json: async () => ({ ok: false, error: { code: "SELF_CLAIM", message: "Cannot claim your own task" } }),
    })

    renderClaim()
    fireEvent.click(screen.getByRole("button", { name: /claim task/i }))

    await waitFor(() => expect(screen.getByText(/cannot claim your own task/i)).toBeInTheDocument())

    expect(mockApiFetch).toHaveBeenCalledWith("/api/v1/tasks/1/escrow/claim-check")
    expect(mockSendClaimTx).not.toHaveBeenCalled() // no fee burned on a denied pre-flight
  })

  it("calls the pre-flight BEFORE sendClaimTx when the pre-flight allows the claim", async () => {
    mockApiFetch.mockResolvedValue({ json: async () => ({ ok: true, data: { allowed: true } }) })

    renderClaim()
    fireEvent.click(screen.getByRole("button", { name: /claim task/i }))

    await waitFor(() => expect(mockSendClaimTx).toHaveBeenCalled())

    expect(mockApiFetch).toHaveBeenCalledWith("/api/v1/tasks/1/escrow/claim-check")
    const preflightOrder = mockApiFetch.mock.invocationCallOrder[0]
    const sendClaimOrder = mockSendClaimTx.mock.invocationCallOrder[0]
    expect(preflightOrder).toBeLessThan(sendClaimOrder)
  })

  it("fails CLOSED (blocks the claim, does not call sendClaimTx) when the pre-flight network call throws", async () => {
    mockApiFetch.mockRejectedValue(new Error("network down"))

    renderClaim()
    fireEvent.click(screen.getByRole("button", { name: /claim task/i }))

    await waitFor(() =>
      expect(screen.getByText(/couldn't reach the server to verify claim eligibility/i)).toBeInTheDocument(),
    )
    expect(mockSendClaimTx).not.toHaveBeenCalled() // a failed pre-flight must never fall through as "allowed"
  })
})
