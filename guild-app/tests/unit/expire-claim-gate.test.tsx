import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * ExpireClaimButton (fix for the 2026-08-29 operator ruling, docs/PROJECT-STATE.md):
 * expire_claim is PUBLIC and time-gated on-chain, so the button must render for
 * ANY signed-in viewer once a claim's deadline has passed — not just the task's
 * poster or worker. That is the OPPOSITE gate from EscrowApproveButton
 * (poster-only) and FinalizeDisputeButton (poster-or-worker-only), so this pins
 * the positive case explicitly: an unrelated third account must still see it.
 *
 * It must also stay silent — same as ClaimDeadlineNotice right above it on the
 * page — while the task is Claimed but not yet overdue, while it is in any
 * other state, and on a Gateway read failure (fails open: this is an
 * opportunity to earn a bounty, not money owed to the viewer, so there is
 * nothing lost by staying quiet until the next successful read).
 */

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const H = vi.hoisted(() => ({
  account: "",
  // What readEscrowTaskInfo does: "ok" | "throw"
  mode: "ok" as "ok" | "throw",
  info: null as unknown,
  // Gates readClaimBondParams when a test needs to inspect the mid-flight
  // (no-number) render before resolving it — null means "resolve immediately"
  // with the default fixture below, same as every pre-existing test here.
  bondParamsDeferred: null as null | { promise: Promise<unknown>; resolve: (v: unknown) => void },
  // The reward token's on-chain divisibility. Defaults to 18 (XRD, today's
  // only reward token) for every pre-existing test; the divisibility-rounding
  // test below overrides it to prove expireBountyFromBond rounds the bounty
  // to THIS, not an assumed 18dp (guild-app/src/components/tasks/escrow-actions.tsx).
  divisibility: 18 as number,
}))

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  isEscrowDeployed: () => true,
}))

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    account: H.account,
    connected: true,
    rdt: {},
    ensureSession: vi.fn(async () => true),
    ensureSessionDetailed: vi.fn(async () => ({ ok: true })),
    sessionMismatch: false,
  }),
}))

vi.mock("@/lib/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gateway")>()),
  readEscrowTaskInfo: vi.fn(async () => {
    if (H.mode === "throw") throw new Error("gateway unreachable")
    return H.info
  }),
  // ExpireClaimButton also derives the live claim bond (useClaimBond, Wave B)
  // for its own disclosure paragraph — mocked here purely so this suite stays
  // hermetic (no real Gateway fetch). Reward 1000 * pct 0.1 = 100, inside
  // [floor 10, cap 1,000,000] → bond "100", exercised by the bounty-copy
  // tests below (the bond figure itself is pinned in
  // claim-bond-live-derivation.test.tsx).
  readClaimBondParams: vi.fn(async () =>
    H.bondParamsDeferred
      ? H.bondParamsDeferred.promise
      : { pct: "0.1", floor: "10", cap: "1000000" },
  ),
  readTaskRewardInfo: vi.fn(async () => ({
    rewardToken: "resource_rdx1t4kep6gtkajg9nkfr9wqzqf3z9wjhpqcqxkq9y0rfmkgz3ge85u9sf",
    rewardAmount: "1000",
  })),
  readTokenDivisibility: vi.fn(async () => H.divisibility),
}))

const M = vi.hoisted(() => ({
  sendExpireClaimTx: vi.fn(async () => ({ ok: true, txId: "txid_rdx1expire" })),
  resyncEscrowTask: vi.fn(async () => ({ ok: true, applied: 1, pending: [] as { kind: string; reason: string }[] })),
}))

vi.mock("@/lib/escrow-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/escrow-utils")>()),
  sendExpireClaimTx: M.sendExpireClaimTx,
  resyncEscrowTask: M.resyncEscrowTask,
}))

import { ExpireClaimButton } from "@/components/tasks/escrow-actions"

const POSTER = "account_rdx12ynlx369poster000000000000000000000000000000000000000000"
const WORKER = "account_rdx12890803worker000000000000000000000000000000000000000000"
const THIRD_PARTY = "account_rdx12stranger00000000000000000000000000000000000000000000"

function baseInfo(overrides: Record<string, unknown> = {}) {
  return {
    state: "Claimed",
    claimDeadline: null,
    disputeRaisedBy: null,
    disputedAt: null,
    entitlements: { workerReward: "0", posterReward: "0", workerBond: "0", posterBond: "0" },
    entitlementsPresent: false,
    workerAccount: WORKER,
    posterAccount: POSTER,
    claimerBadgeId: "1",
    claimerIsAgent: false,
    ...overrides,
  }
}

function renderButton() {
  return render(<ExpireClaimButton taskDbId={1} onChainTaskId={7} />)
}

/** The hook reads on mount; let the resolved/rejected promise settle. */
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0))
}

describe("ExpireClaimButton — any signed-in viewer, time-gated", () => {
  beforeEach(() => {
    cleanup()
    H.mode = "ok"
    H.info = null
    H.account = THIRD_PARTY
    H.bondParamsDeferred = null
    H.divisibility = 18
    M.sendExpireClaimTx.mockClear()
    M.resyncEscrowTask.mockClear()
  })

  it("renders NOTHING while Claimed but before the deadline (ClaimDeadlineNotice covers the countdown)", async () => {
    H.info = baseInfo({ claimDeadline: new Date(Date.now() + 3600_000) }) // 1h from now
    const { container } = renderButton()
    await settle()
    expect(container.firstChild).toBeNull()
  })

  it("renders the expire button once the deadline has passed", async () => {
    H.info = baseInfo({ claimDeadline: new Date(Date.now() - 1000) }) // 1s ago
    renderButton()
    expect(await screen.findByRole("button", { name: /expire overdue claim/i })).toBeInTheDocument()
  })

  it("renders for an UNRELATED third account — expire_claim is public, not poster/worker-only", async () => {
    H.account = THIRD_PARTY // neither POSTER nor WORKER
    H.info = baseInfo({ claimDeadline: new Date(Date.now() - 1000) })
    renderButton()
    expect(await screen.findByRole("button", { name: /expire overdue claim/i })).toBeInTheDocument()
  })

  it("renders NOTHING when the task is not Claimed (e.g. Open)", async () => {
    H.info = baseInfo({ state: "Open", claimDeadline: null })
    const { container } = renderButton()
    await settle()
    expect(container.firstChild).toBeNull()
  })

  it("renders NOTHING when the task is Submitted (claim already resolved)", async () => {
    H.info = baseInfo({ state: "Submitted", claimDeadline: null })
    const { container } = renderButton()
    await settle()
    expect(container.firstChild).toBeNull()
  })

  it("fails OPEN on a Gateway read failure — no button, same posture as the notice above it", async () => {
    H.mode = "throw"
    const { container } = renderButton()
    await settle()
    expect(container.firstChild).toBeNull()
  })

  it("clicking sends the expire tx with the connected account as caller, then resyncs", async () => {
    H.account = THIRD_PARTY
    H.info = baseInfo({ claimDeadline: new Date(Date.now() - 1000) })
    renderButton()
    const button = await screen.findByRole("button", { name: /expire overdue claim/i })
    fireEvent.click(button)
    await waitFor(() => expect(M.sendExpireClaimTx).toHaveBeenCalledTimes(1))
    expect(M.sendExpireClaimTx.mock.calls[0][0]).toMatchObject({
      account: THIRD_PARTY,
      taskId: 7,
    })
    await waitFor(() => expect(M.resyncEscrowTask).toHaveBeenCalledWith(1))
    expect(await screen.findByText(/claim expired/i)).toBeInTheDocument()
  })

  // Wave B (2026-09-13): the caller bounty is 10% of the forfeited bond,
  // UNCAPPED (docs/ESCROW-PARAMETER-SHEET.md row 14) — not the pre-Wave-B flat
  // "up to 1 XRD" (~a tenth of a cent, never actually collected, and actively
  // wrong once a bond is capped in the tens of thousands of a stablecoin).
  it("states the bounty as 10% of that bond, with no number while the derivation is loading", async () => {
    H.account = THIRD_PARTY
    H.info = baseInfo({ claimDeadline: new Date(Date.now() - 1000) })
    H.bondParamsDeferred = deferred()
    const { container } = renderButton()
    await screen.findByRole("button", { name: /expire overdue claim/i })

    // Bond derivation still in flight: neither the bond nor the bounty prints
    // a number, and the old flat figure never reappears.
    expect(container.textContent).toMatch(/forfeits the claimer's claim bond/)
    expect(container.textContent).toMatch(/a bounty of 10% of that bond/)
    expect(container.textContent).not.toMatch(/up to 1 XRD/i)
    expect(container.textContent).not.toMatch(/\d+(\.\d+)?\s*XRD/)
  })

  it("shows the derived bounty amount once the bond resolves — 10% of the bond, not a flat figure", async () => {
    H.account = THIRD_PARTY
    H.info = baseInfo({ claimDeadline: new Date(Date.now() - 1000) })
    H.bondParamsDeferred = deferred()
    const { container } = renderButton()
    await screen.findByRole("button", { name: /expire overdue claim/i })

    // Reward 1000 * pct 0.1 = 100 (inside [floor 10, cap 1,000,000]); the
    // bounty is 10% of THAT bond, i.e. 10 — not the old flat "up to 1 XRD".
    H.bondParamsDeferred!.resolve({ pct: "0.1", floor: "10", cap: "1000000" })

    await waitFor(() => expect(container.textContent).toMatch(/100 XRD claim bond/))
    expect(container.textContent).toMatch(/a bounty of 10 XRD \(10% of that bond\)/)
    expect(container.textContent).not.toMatch(/up to 1 XRD/i)
  })

  // Review fix (2026-09-13): expireBountyFromBond used to compute 10% of the
  // bond at a fixed 18dp, never rounding to the reward token's ACTUAL
  // divisibility the way expire_claim itself does (checked_round(
  // token_divisibility, RoundingMode::ToZero), lib.rs ~1759-1761). Every
  // other test in this file pins divisibility at 18 (H.divisibility's
  // default), the one value at which that bug cannot manifest — this test
  // is the one that actually exercises a lower divisibility.
  it("rounds the bounty DOWN to the reward token's divisibility, not a fixed 18dp", async () => {
    H.account = THIRD_PARTY
    H.info = baseInfo({ claimDeadline: new Date(Date.now() - 1000) })
    H.divisibility = 2
    H.bondParamsDeferred = deferred()
    const { container } = renderButton()
    await screen.findByRole("button", { name: /expire overdue claim/i })

    // Reward 1000 * pct 0.03333 = 33.33 (inside [floor 0, cap 1,000,000]) —
    // already exact at 2dp, so requiredBond does not itself truncate it.
    // 10% of 33.33 is 3.333, which needs 3dp: at divisibility 2 the contract
    // truncates the PAYOUT to 3.33, not 3.333 — this copy must match.
    H.bondParamsDeferred!.resolve({ pct: "0.03333", floor: "0", cap: "1000000" })

    await waitFor(() => expect(container.textContent).toMatch(/33.33 XRD claim bond/))
    expect(container.textContent).toMatch(/a bounty of 3.33 XRD \(10% of that bond\)/)
    // The un-rounded (buggy) 18dp figure must never appear.
    expect(container.textContent).not.toMatch(/3\.333/)
  })
})
