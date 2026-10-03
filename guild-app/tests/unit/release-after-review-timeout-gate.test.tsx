import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * ReleaseAfterReviewTimeoutButton (Wave B stage 6, escrow-actions.tsx):
 * release_after_review_timeout is PUBLIC and time-gated on-chain — same shape
 * as expire_claim (see expire-claim-gate.test.tsx) — but the UI restricts the
 * affordance to the task's two parties, poster OR worker, the same restraint
 * FinalizeDisputeButton takes on the identically-shaped auto_resolve_dispute
 * (the component's own docstring, escrow-actions.tsx ~793-797, and the
 * "poster-or-worker" contrast expire-claim-gate.test.tsx's docstring draws
 * against ExpireClaimButton's fully-public gate). That is deliberately NOT
 * worker-only: an unaffiliated third account must be gated out, but the
 * POSTER is a legitimate viewer too — this suite pins both halves of the real
 * gate (party check) rather than assuming a worker-only shape, alongside the
 * state + deadline checks.
 *
 * Coverage: hidden (no enabled release affordance, just a disabled countdown)
 * before the review deadline, shown/enabled once it has elapsed, hidden for
 * an unrelated third-party account, shown for the poster too (documenting the
 * real poster-or-worker gate), hidden while the task is not Submitted, and
 * hidden when Submitted but the on-chain read has no reviewDeadline (the
 * pre-Wave-B-component case the component's own comment calls out).
 */

const POSTER = "account_rdx12ynlx369poster000000000000000000000000000000000000000000"
const WORKER = "account_rdx12890803worker000000000000000000000000000000000000000000"
const THIRD_PARTY = "account_rdx12stranger00000000000000000000000000000000000000000000"

// review_window_secs on the live Wave B component (259200s = 72h, per the
// task brief and docs/ESCROW-PARAMETER-SHEET.md) — used only to build a
// realistic not-yet-elapsed deadline; the gate logic itself just compares
// reviewDeadline against "now", not against this constant.
const REVIEW_WINDOW_SECS = 259_200

const H = vi.hoisted(() => ({
  account: "",
  // What readEscrowTaskInfo does: "ok" | "throw"
  mode: "ok" as "ok" | "throw",
  info: null as unknown,
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
    sessionMismatch: false,
  }),
}))

vi.mock("@/lib/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gateway")>()),
  readEscrowTaskInfo: vi.fn(async () => {
    if (H.mode === "throw") throw new Error("gateway unreachable")
    return H.info
  }),
}))

import { ReleaseAfterReviewTimeoutButton } from "@/components/tasks/escrow-actions"

function baseInfo(overrides: Record<string, unknown> = {}) {
  return {
    state: "Submitted",
    claimDeadline: null,
    reviewDeadline: null,
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

function renderButton(overrides: { posterId?: string; workerId?: string | null } = {}) {
  return render(
    <ReleaseAfterReviewTimeoutButton
      taskDbId={1}
      onChainTaskId={7}
      posterId={overrides.posterId ?? POSTER}
      workerId={overrides.workerId === undefined ? WORKER : overrides.workerId}
    />,
  )
}

/** The hook reads on mount; let the resolved/rejected promise settle. */
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0))
}

describe("ReleaseAfterReviewTimeoutButton — poster-or-worker, time-gated", () => {
  beforeEach(() => {
    cleanup()
    H.mode = "ok"
    H.info = null
    H.account = WORKER
  })

  it("hides the release affordance before the review deadline (disabled countdown instead)", async () => {
    H.info = baseInfo({ reviewDeadline: new Date(Date.now() + REVIEW_WINDOW_SECS * 1000) })
    renderButton()

    // The countdown renders...
    await screen.findByText(/review window:.*left/i)
    // ...but the "Release after review timeout" affordance is not queryable by
    // its accessible name yet, and the one button present is disabled.
    expect(screen.queryByRole("button", { name: /release after review timeout/i })).toBeNull()
    expect(screen.getByRole("button")).toBeDisabled()
  })

  it("shows the enabled release button once the review deadline has elapsed", async () => {
    H.info = baseInfo({ reviewDeadline: new Date(Date.now() - 1000) }) // 1s ago
    renderButton()
    const button = await screen.findByRole("button", { name: /release after review timeout/i })
    expect(button).toBeEnabled()
  })

  it("hides for an unrelated third-party account — not the poster or the worker", async () => {
    H.account = THIRD_PARTY
    H.info = baseInfo({ reviewDeadline: new Date(Date.now() - 1000) })
    const { container } = renderButton()
    await settle()
    expect(container.firstChild).toBeNull()
  })

  it("still shows for the POSTER, not just the worker — the real gate is poster-or-worker", async () => {
    H.account = POSTER
    H.info = baseInfo({ reviewDeadline: new Date(Date.now() - 1000) })
    renderButton()
    expect(
      await screen.findByRole("button", { name: /release after review timeout/i }),
    ).toBeInTheDocument()
  })

  it("hides when the task is not Submitted (e.g. Claimed)", async () => {
    H.info = baseInfo({ state: "Claimed", reviewDeadline: null })
    const { container } = renderButton()
    await settle()
    expect(container.firstChild).toBeNull()
  })

  it("hides when Submitted but the on-chain read has no reviewDeadline (pre-Wave-B component)", async () => {
    H.info = baseInfo({ state: "Submitted", reviewDeadline: null })
    const { container } = renderButton()
    await settle()
    expect(container.firstChild).toBeNull()
  })
})
