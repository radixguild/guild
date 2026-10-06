/**
 * Every escrow button is never a silent no-op (2026-10-06, the money-buttons
 * lane — the Cancel button's 2026-10-03 fix, widened).
 *
 * All of them press through one gate, ensureSessionDetailed(), after their own
 * pre-flights, then hand a manifest to the wallet. Before this lane the others
 * still had the Cancel button's three mute failure modes:
 *
 *   1. a failed sign-in said "Approve the wallet signature to continue." (a
 *      request the wallet never showed), and the gate could THROW out of the
 *      handler — "Claiming..." for good, button disabled, no text;
 *   2. a wallet that never answered left the spinner on with nothing to check;
 *   3. anything else that threw after setLoading(true) died the same way.
 *
 * The table below presses each button through each case and asserts a
 * sentence: the button's own certain fact (SIGN_IN_LEAD — what was NOT sent)
 * plus the gate's reported cause, the wait hint with the button's own closing,
 * or the backstop with the thrown text. The toolkit-code sentences are shared
 * with Cancel (humanizeTxError) and checked once more here per button.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { sessionFailure } from "@/lib/session-outcome"

const POSTER = "account_rdx12poster00000000000000000000000000000000000000000000000"
const WORKER = "account_rdx12worker00000000000000000000000000000000000000000000000"
const ON_CHAIN_TASK_ID = 7
const GENERIC_FALLBACK = "Transaction failed — open the error details below."

const H = vi.hoisted(() => ({ account: "", info: null as unknown }))
const W = vi.hoisted(() => ({ gate: vi.fn() }))
const M = vi.hoisted(() => ({
  sendDepositTx: vi.fn(),
  sendClaimTx: vi.fn(),
  sendSubmitTx: vi.fn(),
  sendApproveTx: vi.fn(),
  sendReleaseAfterReviewTimeoutTx: vi.fn(),
  sendRaiseDisputeTx: vi.fn(),
  sendAutoResolveTx: vi.fn(),
  sendWithdrawTx: vi.fn(),
  sendPushEntitlementTx: vi.fn(),
  sendExpireClaimTx: vi.fn(),
  confirmEscrowTx: vi.fn(),
  resyncEscrowTask: vi.fn(),
  fetchOwnSubmissionContent: vi.fn(),
  loadUserBadge: vi.fn(),
  findClaimReceiptId: vi.fn(),
  readEscrowTaskState: vi.fn(),
  apiFetch: vi.fn(),
}))

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  isEscrowDeployed: () => true,
}))
vi.mock("@/lib/features", () => ({ isEnabled: () => true }))
vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    account: H.account,
    connected: true,
    rdt: {},
    ensureSessionDetailed: W.gate,
    ensureSession: vi.fn(async () => (await W.gate()).ok),
    sessionMismatch: false,
    badge: { id: "#1#" },
    badgeLoading: false,
    user: null,
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}))
vi.mock("@/hooks/useOnChainTaskInfo", () => ({
  useOnChainTaskInfo: () => ({ info: H.info, status: H.info ? "ok" : "idle", reload: vi.fn() }),
}))
vi.mock("@/hooks/useClaimBond", () => ({
  useClaimBond: () => ({ bond: "76.45", divisibility: 18, status: "ok" }),
}))
vi.mock("@/hooks/useXrdBalance", () => ({
  useXrdBalance: () => ({ balance: 1_000_000, checked: true, recheck: vi.fn() }),
}))
vi.mock("@/hooks/useEscrowPostingFrozen", () => ({ useEscrowPostingFrozen: () => false }))
vi.mock("@/lib/api-fetch", () => ({ apiFetch: M.apiFetch }))
vi.mock("@/lib/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gateway")>()),
  loadUserBadge: M.loadUserBadge,
  findClaimReceiptId: M.findClaimReceiptId,
  readEscrowTaskState: M.readEscrowTaskState,
}))
// The REAL humanizeTxError stays in: what the person reads is the point.
vi.mock("@/lib/escrow-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/escrow-utils")>()),
  sendDepositTx: M.sendDepositTx,
  sendClaimTx: M.sendClaimTx,
  sendSubmitTx: M.sendSubmitTx,
  sendApproveTx: M.sendApproveTx,
  sendReleaseAfterReviewTimeoutTx: M.sendReleaseAfterReviewTimeoutTx,
  sendRaiseDisputeTx: M.sendRaiseDisputeTx,
  sendAutoResolveTx: M.sendAutoResolveTx,
  sendWithdrawTx: M.sendWithdrawTx,
  sendPushEntitlementTx: M.sendPushEntitlementTx,
  sendExpireClaimTx: M.sendExpireClaimTx,
  confirmEscrowTx: M.confirmEscrowTx,
  resyncEscrowTask: M.resyncEscrowTask,
  fetchOwnSubmissionContent: M.fetchOwnSubmissionContent,
}))

import {
  EscrowDepositButton,
  EscrowClaimButton,
  EscrowSubmitButton,
  EscrowApproveButton,
  ReleaseAfterReviewTimeoutButton,
  RaiseDisputeButton,
  FinalizeDisputeButton,
  EscrowWithdrawButton,
  EscrowPushEntitlementButton,
  EscrowResyncButton,
  ExpireClaimButton,
  SIGN_IN_LEAD,
  WAIT_CLOSING,
  TX_BACKSTOP,
  WALLET_WAIT_HINT_MS,
  walletWaitHint,
} from "@/components/tasks/escrow-actions"
import { settlementCopy } from "@/lib/settlement-copy"

const toolkitError = (error: string, message = "") =>
  JSON.stringify({ error, interactionId: "c0ffee00-0000-4000-8000-000000000007", message })

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const past = (hours: number) => new Date(Date.now() - hours * 3600_000)

function info(overrides: Record<string, unknown> = {}) {
  return {
    state: "Open",
    claimDeadline: null,
    reviewDeadline: null,
    disputeRaisedBy: null,
    disputedAt: null,
    entitlements: { workerReward: "0", posterReward: "0", workerBond: "0", posterBond: "0" },
    entitlementsPresent: false,
    workerAccount: WORKER,
    posterAccount: POSTER,
    claimerBadgeId: "#1#",
    claimerIsAgent: false,
    ...overrides,
  }
}

type ButtonCase = {
  key: keyof typeof WAIT_CLOSING
  /** Which signed-in account presses it. */
  account: string
  /** What useOnChainTaskInfo returns for it. */
  info?: unknown
  render: () => void
  /** The button's accessible name. */
  name: RegExp
  /** The wallet send this button ends in (undefined: resync, which sends nothing). */
  send?: ReturnType<typeof vi.fn>
  /**
   * A press that first opens a dialog (dispute): `open` gets the confirm
   * button on screen under real timers (findByRole polls with timers), and
   * `confirmName` is the button the handler then runs from.
   */
  open?: () => Promise<void>
  confirmName?: RegExp
  /** This button has no sign-in gate (push: a public chain action). */
  gated: boolean
}

const BUTTONS: ButtonCase[] = [
  {
    key: "fund",
    account: POSTER,
    render: () => {
      render(<EscrowDepositButton taskId="1" rewardXrd={100} title="t" description="d" />)
    },
    name: /fund escrow/i,
    send: M.sendDepositTx,
    gated: true,
  },
  {
    key: "claim",
    account: WORKER,
    render: () => {
      render(<EscrowClaimButton taskDbId={1} onChainTaskId={ON_CHAIN_TASK_ID} posterId={POSTER} />)
    },
    name: /claim task/i,
    send: M.sendClaimTx,
    gated: true,
  },
  {
    key: "submit",
    account: WORKER,
    render: () => {
      render(
        <EscrowSubmitButton
          taskDbId={1}
          onChainTaskId={ON_CHAIN_TASK_ID}
          workerId={WORKER}
          hasSubmission
          title="t"
          description="d"
        />,
      )
    },
    name: /submit work/i,
    send: M.sendSubmitTx,
    gated: true,
  },
  {
    key: "approve",
    account: POSTER,
    render: () => {
      render(
        <EscrowApproveButton
          taskDbId={1}
          onChainTaskId={ON_CHAIN_TASK_ID}
          posterId={POSTER}
          rewardXrd={100}
          workerAddress={WORKER}
        />,
      )
    },
    name: new RegExp(escapeRe(settlementCopy("approveButtonIdle")!), "i"),
    send: M.sendApproveTx,
    gated: true,
  },
  {
    key: "release",
    account: POSTER,
    info: info({ state: "Submitted", reviewDeadline: past(1) }),
    render: () => {
      render(
        <ReleaseAfterReviewTimeoutButton
          taskDbId={1}
          onChainTaskId={ON_CHAIN_TASK_ID}
          posterId={POSTER}
          workerId={WORKER}
        />,
      )
    },
    name: /release/i,
    send: M.sendReleaseAfterReviewTimeoutTx,
    gated: true,
  },
  {
    key: "dispute",
    account: POSTER,
    render: () => {
      render(<RaiseDisputeButton taskDbId={1} onChainTaskId={ON_CHAIN_TASK_ID} posterId={POSTER} workerId={WORKER} />)
    },
    name: /^raise dispute$/i,
    send: M.sendRaiseDisputeTx,
    open: async () => {
      fireEvent.click(screen.getByRole("button", { name: /^raise dispute$/i }))
      await screen.findByRole("button", { name: /raise dispute anyway/i })
    },
    confirmName: /raise dispute anyway/i,
    gated: true,
  },
  {
    key: "finalize",
    account: POSTER,
    render: () => {
      render(
        <FinalizeDisputeButton
          taskDbId={1}
          onChainTaskId={ON_CHAIN_TASK_ID}
          posterId={POSTER}
          workerId={WORKER}
          disputedAt={past(80)}
        />,
      )
    },
    name: /finalize dispute/i,
    send: M.sendAutoResolveTx,
    gated: true,
  },
  {
    key: "withdraw",
    account: WORKER,
    info: info({
      state: "Refunded",
      entitlements: { workerReward: "0", posterReward: "0", workerBond: "76.45", posterBond: "0" },
      entitlementsPresent: true,
    }),
    render: () => {
      render(<EscrowWithdrawButton taskDbId={1} onChainTaskId={ON_CHAIN_TASK_ID} />)
    },
    name: /collect/i,
    send: M.sendWithdrawTx,
    gated: true,
  },
  {
    key: "push",
    account: POSTER,
    info: info({
      state: "Released",
      entitlements: { workerReward: "100", posterReward: "0", workerBond: "0", posterBond: "0" },
      entitlementsPresent: true,
    }),
    render: () => {
      render(<EscrowPushEntitlementButton onChainTaskId={ON_CHAIN_TASK_ID} party="worker" />)
    },
    name: /deliver the worker's payout/i,
    send: M.sendPushEntitlementTx,
    gated: false,
  },
  {
    key: "resync",
    account: POSTER,
    render: () => {
      render(<EscrowResyncButton taskDbId={1} onChainTaskId={ON_CHAIN_TASK_ID} />)
    },
    name: /resync from chain/i,
    gated: true,
  },
  {
    key: "expire",
    account: POSTER,
    info: info({ state: "Claimed", claimDeadline: past(1) }),
    render: () => {
      render(<ExpireClaimButton taskDbId={1} onChainTaskId={ON_CHAIN_TASK_ID} />)
    },
    name: /expire overdue claim/i,
    send: M.sendExpireClaimTx,
    gated: true,
  },
]

/** The text of every role="alert" on the page, joined — a button may render other alerts beside TxError. */
const alertsText = async () => {
  const alerts = await screen.findAllByRole("alert")
  return alerts.map((a) => a.textContent ?? "").join("\n")
}

const settle = async () => {
  await new Promise((r) => setTimeout(r, 0))
}

describe.each(BUTTONS)("$key button — never a silent no-op", (b) => {
  const button = () => screen.getByRole("button", { name: b.name })
  /** The click that runs the handler (after `open`, when the button has a dialog). */
  const finalClick = () => fireEvent.click(screen.getByRole("button", { name: b.confirmName ?? b.name }))
  const press = async () => {
    await b.open?.()
    finalClick()
  }

  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.useRealTimers()
    H.account = b.account
    H.info = b.info ?? null
    W.gate.mockResolvedValue({ ok: true })
    // Pre-flights, all satisfied, so the happy path reaches the wallet.
    M.apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, data: [] }) })
    M.loadUserBadge.mockResolvedValue({ id: "#1#" })
    M.findClaimReceiptId.mockResolvedValue("#7#")
    M.readEscrowTaskState.mockResolvedValue("Open")
    M.fetchOwnSubmissionContent.mockResolvedValue({ ok: true, content: "the work, described" })
    M.confirmEscrowTx.mockResolvedValue({ ok: true })
    M.resyncEscrowTask.mockResolvedValue({ ok: true, applied: 0, pending: [] })
    for (const send of Object.values(M)) {
      if (send !== M.resyncEscrowTask && send !== M.confirmEscrowTx && send !== M.apiFetch && send !== M.loadUserBadge && send !== M.findClaimReceiptId && send !== M.readEscrowTaskState && send !== M.fetchOwnSubmissionContent) {
        send.mockResolvedValue({ ok: true, txId: "txid_rdx1happy" })
      }
    }
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("renders, and the happy path reaches the wallet (vacuity guard)", async () => {
    b.render()
    await settle()
    expect(button()).toBeInTheDocument()
    await press()
    if (b.send) {
      await waitFor(() => expect(b.send!).toHaveBeenCalledTimes(1))
    } else {
      await waitFor(() => expect(M.resyncEscrowTask).toHaveBeenCalledTimes(1))
    }
  })

  if (b.gated) {
    it("declined in the wallet → says what was not sent and why, button usable again — not 'approve the wallet signature'", async () => {
      W.gate.mockResolvedValue(sessionFailure("wallet-declined"))
      b.render()
      await settle()
      await press()
      const text = await alertsText()
      expect(text).toContain(SIGN_IN_LEAD[b.key])
      expect(text).toMatch(/declined the sign-in request in your wallet/i)
      expect(text).not.toMatch(/approve the wallet signature/i)
      if (b.send) expect(b.send).not.toHaveBeenCalled()
      else expect(M.resyncEscrowTask).not.toHaveBeenCalled()
      expect(button()).not.toBeDisabled()
    })

    it("/verify unreachable → the cause, with the network error kept under the expando", async () => {
      W.gate.mockResolvedValue(sessionFailure("unreachable", "TypeError: Failed to fetch"))
      b.render()
      await settle()
      await press()
      const text = await alertsText()
      expect(text).toContain(SIGN_IN_LEAD[b.key])
      expect(text).toMatch(/could not reach the site to verify it/i)
      expect(text).toContain("Failed to fetch")
      if (b.send) expect(b.send).not.toHaveBeenCalled()
    })

    it("the gate throws → the backstop says what is and is not known, shows what threw, and the button recovers", async () => {
      W.gate.mockRejectedValue(new TypeError("Failed to fetch"))
      b.render()
      await settle()
      await press()
      const text = await alertsText()
      expect(text).toContain(TX_BACKSTOP)
      expect(text).toContain("Failed to fetch")
      if (b.send) expect(b.send).not.toHaveBeenCalled()
      expect(button()).not.toBeDisabled()
    })
  }

  if (b.send) {
    it("the toolkit never delivered the transaction (missingExtension) → its own sentence, not the generic failure", async () => {
      b.send!.mockResolvedValue({ ok: false, error: toolkitError("missingExtension", "extension could not be found") })
      b.render()
      await settle()
      await press()
      const text = await alertsText()
      expect(text).toMatch(/did not confirm it received this transaction/i)
      expect(text).not.toContain(GENERIC_FALLBACK)
      expect(button()).not.toBeDisabled()
    })

    it("the send throws → the backstop, with what threw", async () => {
      b.send!.mockRejectedValue(new Error("boom from the toolkit"))
      b.render()
      await settle()
      await press()
      const text = await alertsText()
      expect(text).toContain(TX_BACKSTOP)
      expect(text).toContain("boom from the toolkit")
      expect(button()).not.toBeDisabled()
    })

    it(`a wallet that never answers → after ${WALLET_WAIT_HINT_MS / 1000} s the hint, ending with this button's own closing`, async () => {
      b.render()
      await settle()
      await b.open?.() // under real timers: findByRole polls with them
      let settleSend!: (v: { ok: boolean; txId?: string; error?: string }) => void
      b.send!.mockReturnValue(new Promise((r) => (settleSend = r)))
      vi.useFakeTimers()
      await act(async () => {
        finalClick()
      })
      await act(async () => {})
      expect(b.send).toHaveBeenCalledTimes(1)
      const hint = walletWaitHint(WAIT_CLOSING[b.key])
      expect(screen.queryByText(hint)).toBeNull()
      await act(async () => {
        vi.advanceTimersByTime(WALLET_WAIT_HINT_MS)
      })
      expect(screen.getByText(hint)).toHaveAttribute("role", "status")
      await act(async () => {
        settleSend({ ok: false, error: toolkitError("canceledByUser") })
      })
      expect(screen.queryByText(hint)).toBeNull()
    })
  }
})

describe("claim — a pre-flight that throws after the press is the backstop's case too", () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    H.account = WORKER
    H.info = null
    W.gate.mockResolvedValue({ ok: true })
    M.apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
  })

  it("loadUserBadge rejecting (a Gateway drop) no longer strands 'Claiming...' — the backstop, with the error, button usable", async () => {
    M.loadUserBadge.mockRejectedValue(new Error("gateway 503"))
    render(<EscrowClaimButton taskDbId={1} onChainTaskId={ON_CHAIN_TASK_ID} posterId={POSTER} />)
    fireEvent.click(screen.getByRole("button", { name: /claim task/i }))
    const text = await alertsText()
    expect(text).toContain(TX_BACKSTOP)
    expect(text).toContain("gateway 503")
    expect(M.sendClaimTx).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: /claim task/i })).not.toBeDisabled()
  })

  it("a sign-in request the wallet never answers gets the wait hint too", async () => {
    vi.useFakeTimers()
    W.gate.mockReturnValue(new Promise(() => {}))
    render(<EscrowClaimButton taskDbId={1} onChainTaskId={ON_CHAIN_TASK_ID} posterId={POSTER} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /claim task/i }))
    })
    await act(async () => {
      vi.advanceTimersByTime(WALLET_WAIT_HINT_MS)
    })
    expect(screen.getByText(walletWaitHint(WAIT_CLOSING.claim))).toHaveAttribute("role", "status")
    expect(M.sendClaimTx).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
