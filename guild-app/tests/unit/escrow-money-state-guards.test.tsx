/**
 * The money buttons never act on a state the person was not shown (2026-10-06,
 * the escrow-money fix lane).
 *
 *   GM-2  a committed create whose confirm failed keeps its intent hash, and the
 *         button offers "Finish linking your funding" with THAT hash instead of
 *         a second Fund Escrow (which locked the reward twice);
 *   GM-5  Approve, Raise Dispute and Finalize read the live on-chain state and
 *         send nothing on a task the chain already settled (they reverted and
 *         charged the fee, and stayed on screen for another try);
 *   GM-6  a sign-in proven with a DIFFERENT shared account than the one the
 *         button was pressed under stops before the wallet is asked.
 *
 * Mock seams match escrow-money-buttons-never-silent.test.tsx, which keeps
 * pinning the never-silent guarantees these changes must not weaken.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BANNED, PULL_BANNED, violation } from "../../scripts/honest-copy.mjs"

const POSTER = "account_rdx12poster00000000000000000000000000000000000000000000000"
const WORKER = "account_rdx12worker00000000000000000000000000000000000000000000000"
const OTHER = "account_rdx12other000000000000000000000000000000000000000000000000"
const ON_CHAIN_TASK_ID = 7
const FUND_TX = "txid_rdx1fundcommitted"

const H = vi.hoisted(() => ({ account: "" }))
const W = vi.hoisted(() => ({ gate: vi.fn() }))
const M = vi.hoisted(() => ({
  sendDepositTx: vi.fn(),
  sendClaimTx: vi.fn(),
  sendSubmitTx: vi.fn(),
  sendApproveTx: vi.fn(),
  sendCancelTx: vi.fn(),
  sendRaiseDisputeTx: vi.fn(),
  sendAutoResolveTx: vi.fn(),
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
  useOnChainTaskInfo: () => ({ info: null, status: "idle", reload: vi.fn() }),
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
vi.mock("@/lib/escrow-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/escrow-utils")>()),
  sendDepositTx: M.sendDepositTx,
  sendClaimTx: M.sendClaimTx,
  sendSubmitTx: M.sendSubmitTx,
  sendApproveTx: M.sendApproveTx,
  sendCancelTx: M.sendCancelTx,
  sendRaiseDisputeTx: M.sendRaiseDisputeTx,
  sendAutoResolveTx: M.sendAutoResolveTx,
  confirmEscrowTx: M.confirmEscrowTx,
  resyncEscrowTask: M.resyncEscrowTask,
  fetchOwnSubmissionContent: M.fetchOwnSubmissionContent,
}))

import {
  EscrowDepositButton,
  EscrowClaimButton,
  EscrowSubmitButton,
  EscrowApproveButton,
  EscrowCancelButton,
  RaiseDisputeButton,
  FinalizeDisputeButton,
  FUND_NOT_LINKED,
  APPROVE_NOT_SUBMITTED,
  DISPUTE_NOT_SUBMITTED,
  FINALIZE_NOT_DISPUTED,
  CANCEL_VOIDS_LIVE_CLAIM,
  SIGN_IN_LEAD,
  accountSwitchedSentence,
  readPendingCreate,
} from "@/components/tasks/escrow-actions"
import { humanizeTxError } from "@/lib/escrow-utils"
import { settlementCopy } from "@/lib/settlement-copy"

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const past = (hours: number) => new Date(Date.now() - hours * 3600_000)
const alertsText = async () =>
  (await screen.findAllByRole("alert")).map((a) => a.textContent ?? "").join("\n")

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.localStorage.clear()
  W.gate.mockResolvedValue({ ok: true })
  M.apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, data: [] }) })
  M.loadUserBadge.mockResolvedValue({ id: "#1#" })
  M.findClaimReceiptId.mockResolvedValue("#7#")
  M.fetchOwnSubmissionContent.mockResolvedValue({ ok: true, content: "the work" })
  M.readEscrowTaskState.mockResolvedValue("Open")
  M.resyncEscrowTask.mockResolvedValue({ ok: true, applied: 0, pending: [] })
  M.confirmEscrowTx.mockResolvedValue({ ok: true })
  for (const send of [M.sendDepositTx, M.sendClaimTx, M.sendSubmitTx, M.sendApproveTx, M.sendCancelTx, M.sendRaiseDisputeTx, M.sendAutoResolveTx]) {
    send.mockResolvedValue({ ok: true, txId: "txid_rdx1happy" })
  }
})

// ── GM-2 ──────────────────────────────────────────────────────────────────────

describe("EscrowDepositButton — a committed create whose confirm failed (GM-2)", () => {
  const renderFund = (onSuccess?: (txId: string) => void) =>
    render(
      <EscrowDepositButton taskId="31" posterId={POSTER} rewardXrd={100} title="t" description="d" onSuccess={onSuccess} />,
    )
  const fundButton = () => screen.queryByRole("button", { name: /fund escrow/i })
  const linkButton = () => screen.getByRole("button", { name: /finish linking your funding/i })

  beforeEach(() => {
    H.account = POSTER
    M.sendDepositTx.mockResolvedValue({ ok: true, txId: FUND_TX })
  })

  it("keeps the intent hash, says not to fund again, and after a reload offers Finish linking — never a second Fund", async () => {
    M.confirmEscrowTx.mockResolvedValue({ ok: false, error: "Gateway 502" })
    renderFund()
    fireEvent.click(fundButton()!)
    await waitFor(async () => expect(await alertsText()).toContain(FUND_NOT_LINKED))
    expect(readPendingCreate("31")).toBe(FUND_TX)
    expect(fundButton()).toBeNull()

    // The page reloads: the row still has no on-chain id.
    cleanup()
    renderFund()
    await waitFor(() => expect(linkButton()).toBeInTheDocument())
    expect(fundButton()).toBeNull()
    expect(screen.getByRole("link", { name: /view the funding transaction/i })).toHaveAttribute(
      "href",
      expect.stringContaining(FUND_TX),
    )
  })

  it("Finish linking retries the confirm with the SAME intent hash, sends no transaction, and clears it on success", async () => {
    window.localStorage.setItem("guild:escrow:pending-create:31", FUND_TX)
    const onSuccess = vi.fn()
    renderFund(onSuccess)
    fireEvent.click(await waitFor(() => linkButton()))
    await waitFor(() => expect(M.confirmEscrowTx).toHaveBeenCalledWith("31", "create", FUND_TX))
    expect(M.sendDepositTx).not.toHaveBeenCalled()
    await screen.findByText(/escrow funded/i)
    expect(onSuccess).toHaveBeenCalledWith(FUND_TX)
    expect(readPendingCreate("31")).toBeNull()
  })

  it("a refusal a retry cannot change (409 mismatch) shows the server's own reason, and Fund stays hidden", async () => {
    window.localStorage.setItem("guild:escrow:pending-create:31", FUND_TX)
    M.confirmEscrowTx.mockResolvedValue({
      ok: false,
      code: "WORK_BRIEF_MISMATCH",
      error: "that funding transaction committed to a different work brief — cancel that on-chain task with its Task Receipt, then withdraw.",
    })
    renderFund()
    fireEvent.click(await waitFor(() => linkButton()))
    // The pending notice is an alert too: wait for the press's own sentence.
    await waitFor(async () => expect(await alertsText()).toMatch(/cannot link that funding transaction/i))
    expect(await alertsText()).toMatch(/cancel that on-chain task with its Task Receipt/i)
    expect(fundButton()).toBeNull()
  })

  it("a sign-in that did not complete says the funding is not linked yet", async () => {
    window.localStorage.setItem("guild:escrow:pending-create:31", FUND_TX)
    const { sessionFailure } = await import("@/lib/session-outcome")
    W.gate.mockResolvedValue(sessionFailure("wallet-declined"))
    renderFund()
    fireEvent.click(await waitFor(() => linkButton()))
    await waitFor(async () => expect(await alertsText()).toContain(SIGN_IN_LEAD.link))
    expect(M.confirmEscrowTx).not.toHaveBeenCalled()
  })

  it("Forget this funding transaction brings Fund Escrow back (the poster's explicit choice)", async () => {
    window.localStorage.setItem("guild:escrow:pending-create:31", FUND_TX)
    renderFund()
    fireEvent.click(await screen.findByRole("button", { name: /forget this funding transaction/i }))
    expect(fundButton()).toBeInTheDocument()
    expect(readPendingCreate("31")).toBeNull()
  })

  it("a confirmed link right after the deposit leaves nothing kept (the happy path is unchanged)", async () => {
    renderFund()
    fireEvent.click(fundButton()!)
    await screen.findByText(/escrow funded/i)
    expect(M.confirmEscrowTx).toHaveBeenCalledWith("31", "create", FUND_TX)
    expect(readPendingCreate("31")).toBeNull()
  })
})

// ── GM-5 ──────────────────────────────────────────────────────────────────────

describe("Approve / Raise Dispute / Finalize read the live state first (GM-5)", () => {
  const approve = (onSuccess?: (t: string) => void) => {
    H.account = POSTER
    render(<EscrowApproveButton taskDbId={1} onChainTaskId={ON_CHAIN_TASK_ID} posterId={POSTER} rewardXrd={100} workerAddress={WORKER} onSuccess={onSuccess} />)
    fireEvent.click(screen.getByRole("button", { name: new RegExp(escapeRe(settlementCopy("approveButtonIdle")!), "i") }))
  }
  const dispute = async () => {
    H.account = POSTER
    render(<RaiseDisputeButton taskDbId={1} onChainTaskId={ON_CHAIN_TASK_ID} posterId={POSTER} workerId={WORKER} />)
    fireEvent.click(screen.getByRole("button", { name: /^raise dispute$/i }))
    fireEvent.click(await screen.findByRole("button", { name: /raise dispute anyway/i }))
  }
  const finalize = () => {
    H.account = POSTER
    render(<FinalizeDisputeButton taskDbId={1} onChainTaskId={ON_CHAIN_TASK_ID} posterId={POSTER} workerId={WORKER} disputedAt={past(80)} />)
    fireEvent.click(screen.getByRole("button", { name: /finalize dispute/i }))
  }

  it("Approve on a task the chain already Released → no transaction, resync, and the sentence says so", async () => {
    M.readEscrowTaskState.mockResolvedValue("Released")
    approve()
    expect(await alertsText()).toContain(APPROVE_NOT_SUBMITTED)
    expect(M.sendApproveTx).not.toHaveBeenCalled()
    expect(M.resyncEscrowTask).toHaveBeenCalledWith(1)
  })

  it("…and when the resync pulls the DB forward, the page re-fetches instead of showing an error", async () => {
    M.readEscrowTaskState.mockResolvedValue("Released")
    M.resyncEscrowTask.mockResolvedValue({ ok: true, applied: 1, pending: [] })
    const onSuccess = vi.fn()
    approve(onSuccess)
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(""))
    expect(M.sendApproveTx).not.toHaveBeenCalled()
  })

  it("Raise Dispute on a Released task → no transaction, resync, sentence", async () => {
    M.readEscrowTaskState.mockResolvedValue("Released")
    await dispute()
    expect(await alertsText()).toContain(DISPUTE_NOT_SUBMITTED)
    expect(M.sendRaiseDisputeTx).not.toHaveBeenCalled()
    expect(M.resyncEscrowTask).toHaveBeenCalledWith(1)
  })

  it.each(["Released", "Refunded"])("Finalize on a %s task → no transaction, resync, sentence", async (state) => {
    M.readEscrowTaskState.mockResolvedValue(state)
    finalize()
    expect(await alertsText()).toContain(FINALIZE_NOT_DISPUTED)
    expect(M.sendAutoResolveTx).not.toHaveBeenCalled()
    expect(M.resyncEscrowTask).toHaveBeenCalledWith(1)
  })

  it("an unreadable state (null) proceeds — fail open, the on-chain assert stays the backstop", async () => {
    M.readEscrowTaskState.mockResolvedValue(null)
    approve()
    await waitFor(() => expect(M.sendApproveTx).toHaveBeenCalledTimes(1))
  })

  it("the matching state proceeds (Submitted for approve, Disputed for finalize)", async () => {
    M.readEscrowTaskState.mockResolvedValue("Submitted")
    approve()
    await waitFor(() => expect(M.sendApproveTx).toHaveBeenCalledTimes(1))
    cleanup()
    M.readEscrowTaskState.mockResolvedValue("Disputed")
    finalize()
    await waitFor(() => expect(M.sendAutoResolveTx).toHaveBeenCalledTimes(1))
  })

  it("an approve that reverts on 'task must be Submitted to release' resyncs instead of stranding the poster", async () => {
    M.readEscrowTaskState.mockResolvedValue("Submitted") // the race: settled between the read and the send
    M.sendApproveTx.mockResolvedValue({ ok: false, error: "...Panic: task must be Submitted to release..." })
    M.resyncEscrowTask.mockResolvedValue({ ok: true, applied: 1, pending: [] })
    const onSuccess = vi.fn()
    approve(onSuccess)
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(""))
  })

  it("humanizeTxError marks the three settle asserts stale, but not the review-timeout release's own assert", () => {
    expect(humanizeTxError("task must be Submitted to release").staleState).toBe(true)
    expect(humanizeTxError("task must be Submitted to dispute").staleState).toBe(true)
    expect(humanizeTxError("task must be Disputed to auto-resolve").staleState).toBe(true)
    expect(humanizeTxError("task must be Submitted to release on review timeout").staleState).toBeUndefined()
  })
})

// ── GM-6 ──────────────────────────────────────────────────────────────────────

describe("a sign-in proven with another shared account stops before the wallet (GM-6)", () => {
  const cases: { name: string; account: string; press: () => Promise<void> | void; send: ReturnType<typeof vi.fn> }[] = [
    {
      name: "fund",
      account: POSTER,
      press: () => {
        render(<EscrowDepositButton taskId="1" rewardXrd={100} title="t" description="d" />)
        fireEvent.click(screen.getByRole("button", { name: /fund escrow/i }))
      },
      send: M.sendDepositTx,
    },
    {
      name: "claim",
      account: WORKER,
      press: () => {
        render(<EscrowClaimButton taskDbId={1} onChainTaskId={ON_CHAIN_TASK_ID} posterId={POSTER} />)
        fireEvent.click(screen.getByRole("button", { name: /claim task/i }))
      },
      send: M.sendClaimTx,
    },
    {
      name: "submit",
      account: WORKER,
      press: () => {
        render(<EscrowSubmitButton taskDbId={1} onChainTaskId={ON_CHAIN_TASK_ID} workerId={WORKER} hasSubmission title="t" description="d" />)
        fireEvent.click(screen.getByRole("button", { name: /submit work/i }))
      },
      send: M.sendSubmitTx,
    },
    {
      name: "approve",
      account: POSTER,
      press: () => {
        render(<EscrowApproveButton taskDbId={1} onChainTaskId={ON_CHAIN_TASK_ID} posterId={POSTER} rewardXrd={100} workerAddress={WORKER} />)
        fireEvent.click(screen.getByRole("button", { name: new RegExp(escapeRe(settlementCopy("approveButtonIdle")!), "i") }))
      },
      send: M.sendApproveTx,
    },
    {
      name: "cancel",
      account: POSTER,
      press: () => {
        render(<EscrowCancelButton taskDbId={1} onChainTaskId={ON_CHAIN_TASK_ID} posterId={POSTER} workerId={null} phase="open" />)
        fireEvent.click(screen.getByRole("button", { name: new RegExp(escapeRe(settlementCopy("cancelButtonOpen")!), "i") }))
      },
      send: M.sendCancelTx,
    },
    {
      name: "dispute",
      account: POSTER,
      press: async () => {
        render(<RaiseDisputeButton taskDbId={1} onChainTaskId={ON_CHAIN_TASK_ID} posterId={POSTER} workerId={WORKER} />)
        fireEvent.click(screen.getByRole("button", { name: /^raise dispute$/i }))
        fireEvent.click(await screen.findByRole("button", { name: /raise dispute anyway/i }))
      },
      send: M.sendRaiseDisputeTx,
    },
  ]

  it.each(cases)("$name: the gate signed in as another account → no transaction, and the page says which", async (c) => {
    H.account = c.account
    M.readEscrowTaskState.mockResolvedValue(c.name === "approve" || c.name === "dispute" ? "Submitted" : "Open")
    W.gate.mockResolvedValue({ ok: true, userId: OTHER })
    await c.press()
    expect(await alertsText()).toContain(accountSwitchedSentence(OTHER, c.account))
    expect(c.send).not.toHaveBeenCalled()
    expect(M.confirmEscrowTx).not.toHaveBeenCalled()
  })

  it("the same account (or an outcome that names none) proceeds as before", async () => {
    H.account = POSTER
    W.gate.mockResolvedValue({ ok: true, userId: POSTER })
    render(<EscrowDepositButton taskId="1" rewardXrd={100} title="t" description="d" />)
    fireEvent.click(screen.getByRole("button", { name: /fund escrow/i }))
    await waitFor(() => expect(M.sendDepositTx).toHaveBeenCalledTimes(1))
  })
})

// ── The new sentences clear the real honest-copy rule table ───────────────────

describe("the new money-path copy clears the honest-copy rule table", () => {
  const ALL_RULES = [...BANNED, ...PULL_BANNED]
  const texts = [
    FUND_NOT_LINKED,
    APPROVE_NOT_SUBMITTED,
    DISPUTE_NOT_SUBMITTED,
    FINALIZE_NOT_DISPUTED,
    CANCEL_VOIDS_LIVE_CLAIM,
    SIGN_IN_LEAD.link,
    accountSwitchedSentence(OTHER, POSTER),
    humanizeTxError("task must be Submitted to release").summary,
  ]
  it.each(texts)("no BANNED or PULL_BANNED rule fires on: %s", (text) => {
    expect(text.length).toBeGreaterThan(40)
    const hits = ALL_RULES.map((r: unknown) => violation(text, r)).filter(Boolean)
    expect(hits, `banned claim(s): ${hits.join(" | ")}`).toEqual([])
  })
})
