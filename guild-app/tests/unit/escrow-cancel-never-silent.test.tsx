/**
 * EscrowCancelButton must never be a silent no-op (2026-10-03, task 70).
 *
 * The incident: the poster of board task 70 (on-chain task 6) pressed
 * "Cancel Task (credit refund)" twice on the live site. The Radix Wallet never
 * showed a transaction, the page said nothing useful, and the poster believed
 * it had worked. The same cancel_task manifest, pasted into the Radix
 * Dashboard a minute later, committed.
 *
 * What the code shows: pressing Cancel reaches rdt.walletApi.sendTransaction
 * through exactly one gate, ensureSessionDetailed(), and the bundle served that
 * day baked the right component and receipt resource (checked against the
 * public chunks). So when the wallet never prompts, the request either stopped
 * at sign-in or was never delivered by the dApp toolkit. In both cases the page
 * was mute or vague:
 *
 *   1. a failed sign-in said "Approve the wallet signature to continue." —
 *      asking the poster to approve a request their wallet never showed;
 *   2. a toolkit delivery failure (missingExtension, canceledByUser,
 *      SupportedTransportNotFound, FailedToSendDappRequest) collapsed to the
 *      generic "Transaction failed — open the error details below.", although
 *      the toolkit's own code says the request did not get through (or that
 *      the page stopped waiting for it);
 *   3. a request the wallet never answers left the button on "Cancelling..."
 *      forever, with no word on what to check.
 *
 * 2026-10-06 (the money-buttons lane) added what the gate now reports — the
 * cause, in words — and the chain-truth method choice: the DB row's phase can
 * lag the escrow, and cancel_task on a Claimed task only reverts and burns the
 * fee. The other buttons' versions of cases 1–3 live in
 * escrow-money-buttons-never-silent.test.tsx.
 *
 * Each case below must end in a sentence that says what happened and what to
 * do, and every new sentence clears the real honest-copy rule table.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BANNED, PULL_BANNED, violation } from "../../scripts/honest-copy.mjs"
import { sessionFailure } from "@/lib/session-outcome"

const POSTER = "account_rdx12poster70000000000000000000000000000000000000000000000"
const ON_CHAIN_TASK_ID = 6
const GENERIC_FALLBACK = "Transaction failed — open the error details below."

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  isEscrowDeployed: () => true,
}))

const W = vi.hoisted(() => ({ gate: vi.fn() }))
vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    account: POSTER,
    rdt: {},
    ensureSessionDetailed: W.gate,
    ensureSession: vi.fn(async () => (await W.gate()).ok),
    sessionMismatch: false,
  }),
}))

vi.mock("@/lib/api-fetch", () => ({ apiFetch: vi.fn() }))
const G = vi.hoisted(() => ({ readEscrowTaskState: vi.fn() }))
vi.mock("@/lib/gateway", () => ({
  loadUserBadge: vi.fn(),
  findClaimReceiptId: vi.fn(),
  readEscrowTaskState: G.readEscrowTaskState,
  outstandingForParty: vi.fn(),
}))

// The REAL humanizeTxError stays in: what the poster reads is the point.
const { mockSendCancelTx, mockConfirmEscrowTx, mockResyncEscrowTask } = vi.hoisted(() => ({
  mockSendCancelTx: vi.fn(),
  mockConfirmEscrowTx: vi.fn(),
  mockResyncEscrowTask: vi.fn(),
}))
vi.mock("@/lib/escrow-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/escrow-utils")>()),
  sendCancelTx: mockSendCancelTx,
  confirmEscrowTx: mockConfirmEscrowTx,
  resyncEscrowTask: mockResyncEscrowTask,
}))

import {
  EscrowCancelButton,
  CANCEL_SIGN_IN_INCOMPLETE,
  CANCEL_WALLET_WAIT_HINT,
  CANCEL_NOT_CANCELLABLE,
  CANCEL_VOIDS_LIVE_CLAIM,
  WALLET_WAIT_HINT_MS,
  SIGN_IN_LEAD,
  TX_BACKSTOP,
} from "@/components/tasks/escrow-actions"
import { humanizeTxError } from "@/lib/escrow-utils"
import { settlementCopy } from "@/lib/settlement-copy"

/** What the dApp toolkit's sendTransaction error looks like by the time
 *  escrow-utils.ts send() hands it over: JSON.stringify of the SdkError
 *  ({ error, interactionId, message }, @radixdlt/radix-dapp-toolkit 2.2.1). */
const toolkitError = (error: string, message = "") =>
  JSON.stringify({ error, interactionId: "c0ffee00-0000-4000-8000-000000000006", message })

function renderCancel(phase: "open" | "claimed" = "open", onSuccess?: (txId: string) => void) {
  return render(
    <EscrowCancelButton
      taskDbId={70}
      onChainTaskId={ON_CHAIN_TASK_ID}
      posterId={POSTER}
      workerId={null}
      phase={phase}
      onSuccess={onSuccess}
    />,
  )
}

const cancelButton = (phase: "open" | "claimed" = "open") =>
  screen.getByRole("button", {
    name: new RegExp(
      settlementCopy(phase === "open" ? "cancelButtonOpen" : "cancelButtonClaimed")!.replace(/[()]/g, "\\$&"),
      "i",
    ),
  })

describe("EscrowCancelButton — pressing Cancel is never a silent no-op", () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    W.gate.mockResolvedValue({ ok: true })
    // The chain is unreadable by default (a Gateway hiccup): the row's phase decides.
    G.readEscrowTaskState.mockResolvedValue(null)
    mockConfirmEscrowTx.mockResolvedValue({ ok: true })
    mockResyncEscrowTask.mockResolvedValue({ ok: true, applied: 0, pending: [] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("sends the cancel_task transaction to the wallet when the signed-in poster presses it", async () => {
    // Vacuity guard: the happy path still reaches the wallet with the task's
    // own on-chain id, the poster's account and the open-phase method.
    mockSendCancelTx.mockResolvedValue({ ok: true, txId: "txid_rdx1cancel" })
    renderCancel()
    fireEvent.click(cancelButton())
    await waitFor(() => expect(mockSendCancelTx).toHaveBeenCalledTimes(1))
    expect(mockSendCancelTx.mock.calls[0][0]).toMatchObject({
      account: POSTER,
      taskId: ON_CHAIN_TASK_ID,
      phase: "open",
    })
    await waitFor(() => expect(mockConfirmEscrowTx).toHaveBeenCalledWith(70, "cancel", "txid_rdx1cancel"))
  })

  it("says no transaction was sent, and why, when the person declines the sign-in — not 'approve the wallet signature'", async () => {
    W.gate.mockResolvedValue(sessionFailure("wallet-declined"))
    renderCancel()
    fireEvent.click(cancelButton())
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(SIGN_IN_LEAD.cancel)
    expect(alert).toHaveTextContent(/no cancel transaction was sent/i)
    expect(alert).toHaveTextContent(/declined the sign-in request in your wallet/i)
    expect(alert).not.toHaveTextContent(/approve the wallet signature/i)
    expect(mockSendCancelTx).not.toHaveBeenCalled()
    expect(cancelButton()).not.toBeDisabled()
  })

  it("keeps the gate's detail (the network error) under the expando when /verify was unreachable", async () => {
    W.gate.mockResolvedValue(sessionFailure("unreachable", "TypeError: Failed to fetch"))
    renderCancel()
    fireEvent.click(cancelButton())
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(/could not reach the site to verify it/i)
    expect(alert).toHaveTextContent("Failed to fetch")
    expect(mockSendCancelTx).not.toHaveBeenCalled()
  })

  it("the generic form still exists for a gate that reported nothing", () => {
    expect(CANCEL_SIGN_IN_INCOMPLETE).toMatch(/no cancel transaction was sent/i)
    expect(CANCEL_SIGN_IN_INCOMPLETE).toMatch(/didn't get through/i)
  })

  it("says the Connector extension never confirmed the transaction (missingExtension) instead of a generic failure", async () => {
    mockSendCancelTx.mockResolvedValue({
      ok: false,
      error: toolkitError("missingExtension", "extension could not be found"),
    })
    renderCancel()
    fireEvent.click(cancelButton())
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(/did not confirm it received this transaction/i)
    expect(alert).toHaveTextContent(/Radix Connector/i)
    expect(alert).not.toHaveTextContent(GENERIC_FALLBACK)
    // The button is usable again — the poster can retry after fixing it.
    expect(cancelButton()).not.toBeDisabled()
  })

  it("says the page stopped waiting when the request was cancelled from the Connect button (canceledByUser)", async () => {
    mockSendCancelTx.mockResolvedValue({
      ok: false,
      error: toolkitError("canceledByUser", "user has canceled the request"),
    })
    renderCancel()
    fireEvent.click(cancelButton())
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(/stopped waiting for your wallet/i)
    expect(alert).not.toHaveTextContent(GENERIC_FALLBACK)
  })

  it("tells the poster what to check when the wallet has not answered — never an endless silent spinner", async () => {
    vi.useFakeTimers()
    let settle!: (v: { ok: boolean; error?: string }) => void
    mockSendCancelTx.mockReturnValue(new Promise((r) => (settle = r)))
    renderCancel()

    await act(async () => {
      fireEvent.click(cancelButton())
    })
    expect(mockSendCancelTx).toHaveBeenCalledTimes(1)
    // Not yet: a wallet that answers in a few seconds gets no nagging.
    expect(screen.queryByText(CANCEL_WALLET_WAIT_HINT)).toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(WALLET_WAIT_HINT_MS)
    })
    const hint = screen.getByText(CANCEL_WALLET_WAIT_HINT)
    expect(hint).toHaveAttribute("role", "status")
    expect(hint).toHaveTextContent(/Connect button/i)

    // The wallet finally answers (here: the poster cancelled the stuck
    // request) — the hint gives way to the specific reason.
    await act(async () => {
      settle({ ok: false, error: toolkitError("canceledByUser") })
    })
    expect(screen.queryByText(CANCEL_WALLET_WAIT_HINT)).toBeNull()
    expect(screen.getByRole("alert")).toHaveTextContent(/stopped waiting for your wallet/i)
  })

  it("covers the sign-in request too: a wallet that never answers the ROLA prompt gets the same hint", async () => {
    vi.useFakeTimers()
    W.gate.mockReturnValue(new Promise(() => {}))
    renderCancel()
    await act(async () => {
      fireEvent.click(cancelButton())
    })
    await act(async () => {
      vi.advanceTimersByTime(WALLET_WAIT_HINT_MS)
    })
    expect(screen.getByText(CANCEL_WALLET_WAIT_HINT)).toHaveAttribute("role", "status")
    expect(mockSendCancelTx).not.toHaveBeenCalled()
  })

  it("keeps the wait hint off the post-wallet confirm — it is about the wallet, not the server", async () => {
    // The wallet signs at once; the DB confirm then takes longer than the hint
    // threshold (confirmEscrowTx retries for up to ~16 s on its own). Telling
    // the poster to go and look at their wallet here would be false.
    vi.useFakeTimers()
    mockSendCancelTx.mockResolvedValue({ ok: true, txId: "txid_rdx1cancel" })
    mockConfirmEscrowTx.mockReturnValue(new Promise(() => {}))
    renderCancel()
    await act(async () => {
      fireEvent.click(cancelButton())
    })
    expect(mockConfirmEscrowTx).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(WALLET_WAIT_HINT_MS * 2)
    })
    expect(screen.queryByText(CANCEL_WALLET_WAIT_HINT)).toBeNull()
  })

  it("does not spin forever when the gate THROWS — the backstop says what is and is not known, and shows what threw", async () => {
    // The real gate never throws any more (useWallet.tsx); this is the guard's
    // own catch, for anything that still does. Before the fix the handler died
    // after setLoading(true): "Cancelling..." for good, button disabled, no text.
    W.gate.mockRejectedValue(new TypeError("Failed to fetch"))
    renderCancel()
    fireEvent.click(cancelButton())
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(TX_BACKSTOP)
    expect(alert).toHaveTextContent("Failed to fetch") // the detail, behind the expando
    expect(mockSendCancelTx).not.toHaveBeenCalled()
    expect(cancelButton()).not.toBeDisabled()
  })
})

describe("EscrowCancelButton — the chain, not the DB row, decides which cancel applies (2026-10-06)", () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    W.gate.mockResolvedValue({ ok: true })
    mockConfirmEscrowTx.mockResolvedValue({ ok: true })
    mockResyncEscrowTask.mockResolvedValue({ ok: true, applied: 0, pending: [] })
    mockSendCancelTx.mockResolvedValue({ ok: true, txId: "txid_rdx1cancel" })
  })

  it("DB says open, chain says Claimed → the first press sends NOTHING: it says a worker's claim would be voided, resyncs, and shows the claimed-task copy (GM-7)", async () => {
    // The lag case: a claim whose confirm was lost leaves the row "open". The
    // method that applies voids that worker's claim, which the open-task copy
    // never said — so the poster must see it before anything is sent.
    G.readEscrowTaskState.mockResolvedValue("Claimed")
    renderCancel("open")
    fireEvent.click(cancelButton())
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(CANCEL_VOIDS_LIVE_CLAIM)
    expect(alert).toHaveTextContent(/no cancel transaction was sent/i)
    expect(mockSendCancelTx).not.toHaveBeenCalled()
    expect(mockResyncEscrowTask).toHaveBeenCalledWith(70)
    expect(G.readEscrowTaskState).toHaveBeenCalledWith(ON_CHAIN_TASK_ID, expect.any(String))
    // The button and its description now carry the claimed-task copy.
    expect(cancelButton("claimed")).not.toBeDisabled()
    expect(screen.getByText(settlementCopy("cancelDescriptionClaimed")!)).toBeInTheDocument()
  })

  it("…and the second press, made under the claimed copy, sends cancel_task_by_poster_after_claim — not the method that would revert", async () => {
    G.readEscrowTaskState.mockResolvedValue("Claimed")
    renderCancel("open")
    fireEvent.click(cancelButton())
    await screen.findByRole("alert")
    fireEvent.click(cancelButton("claimed"))
    await waitFor(() => expect(mockSendCancelTx).toHaveBeenCalledTimes(1))
    expect(mockSendCancelTx.mock.calls[0][0]).toMatchObject({ phase: "claimed", taskId: ON_CHAIN_TASK_ID })
  })

  it("DB says claimed, chain says Open → cancel_task", async () => {
    G.readEscrowTaskState.mockResolvedValue("Open")
    renderCancel("claimed")
    fireEvent.click(cancelButton("claimed"))
    await waitFor(() => expect(mockSendCancelTx).toHaveBeenCalledTimes(1))
    expect(mockSendCancelTx.mock.calls[0][0]).toMatchObject({ phase: "open" })
  })

  it("chain says Submitted → no transaction, the DB is pulled forward, and the page says the cancel no longer applies", async () => {
    G.readEscrowTaskState.mockResolvedValue("Submitted")
    renderCancel("open")
    fireEvent.click(cancelButton())
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(CANCEL_NOT_CANCELLABLE)
    expect(alert).toHaveTextContent(/no cancel transaction was sent/i)
    expect(mockSendCancelTx).not.toHaveBeenCalled()
    expect(mockResyncEscrowTask).toHaveBeenCalledWith(70)
    expect(cancelButton()).not.toBeDisabled()
  })

  it("chain says Refunded and the resync applies → the page re-fetches instead of showing an error", async () => {
    G.readEscrowTaskState.mockResolvedValue("Refunded")
    mockResyncEscrowTask.mockResolvedValue({ ok: true, applied: 1, pending: [] })
    const onSuccess = vi.fn()
    renderCancel("open", onSuccess)
    fireEvent.click(cancelButton())
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(""))
    expect(mockSendCancelTx).not.toHaveBeenCalled()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("chain unreadable (null) → the row's phase decides, fail open — the on-chain assert stays the backstop", async () => {
    G.readEscrowTaskState.mockResolvedValue(null)
    renderCancel("claimed")
    fireEvent.click(cancelButton("claimed"))
    await waitFor(() => expect(mockSendCancelTx).toHaveBeenCalledTimes(1))
    expect(mockSendCancelTx.mock.calls[0][0]).toMatchObject({ phase: "claimed" })
  })
})

describe("humanizeTxError — dApp toolkit codes for a request the wallet did not get (or the page stopped waiting on)", () => {
  it.each([
    ["missingExtension", /did not confirm it received this transaction/i],
    ["SupportedTransportNotFound", /never received this transaction/i],
    ["FailedToSendDappRequest", /never received this transaction/i],
    ["canceledByUser", /stopped waiting for your wallet/i],
  ])("%s gets its own sentence, with the raw payload kept for the details expando", (code, re) => {
    const raw = toolkitError(code)
    const h = humanizeTxError(raw)
    expect(h.summary).toMatch(re)
    expect(h.summary).not.toBe(GENERIC_FALLBACK)
    expect(h.detail).toBe(raw)
    expect(h.staleState).toBeUndefined()
  })

  it("does not read a code out of a message body — only the toolkit's own `error` field counts", () => {
    // An engine failure whose MESSAGE happens to mention the word must keep
    // the generic summary: it reached the wallet and the ledger.
    const raw = JSON.stringify({
      error: "transactionRejected",
      message: "RuntimeError(... missingExtension ...)",
    })
    expect(humanizeTxError(raw).summary).toBe(GENERIC_FALLBACK)
  })
})

describe("the cancel-path copy clears the real honest-copy rule table", () => {
  const ALL_RULES = [...BANNED, ...PULL_BANNED]
  const texts = [
    CANCEL_SIGN_IN_INCOMPLETE,
    CANCEL_WALLET_WAIT_HINT,
    CANCEL_NOT_CANCELLABLE,
    CANCEL_VOIDS_LIVE_CLAIM,
    ...["missingExtension", "SupportedTransportNotFound", "FailedToSendDappRequest", "canceledByUser"].map(
      (c) => humanizeTxError(toolkitError(c)).summary,
    ),
  ]
  it.each(texts)("no BANNED or PULL_BANNED rule fires on: %s", (text) => {
    expect(text.length).toBeGreaterThan(40) // vacuous-pass guard
    const hits = ALL_RULES.map((r: unknown) => violation(text, r)).filter(Boolean)
    expect(hits, `banned claim(s): ${hits.join(" | ")}`).toEqual([])
  })
})
