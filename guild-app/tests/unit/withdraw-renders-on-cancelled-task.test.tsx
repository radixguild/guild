import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * "Confirm the withdraw button renders for a cancelled task" (2026-09-14
 * archived-task fix, point 2). Traced the real production incident (task
 * 68 / on-chain #4: a worker's 76.45 XRD claim bond, credited but
 * uncollected after a poster's cancel-after-claim) back to
 * `EscrowWithdrawButton` / `resolveWithdrawAffordance` and found NO status
 * gate at all — see escrow-withdraw.ts's own docblock: "There is
 * deliberately no `tasks.status` input... the chain says who is owed
 * what". The button was never reachable because the PAGE 404'd first (the
 * fix in src/app/api/v1/tasks/[id]/route.ts + public-task-text.ts); once a
 * party reaches the page at all, this component already renders correctly.
 *
 * This pins that as a real regression test rather than trusting the code
 * reading: it mounts the button against a live on-chain read shaped exactly
 * like the incident (entitlementsPresent, only a worker bond outstanding,
 * viewer = the worker) and asserts the Collect affordance renders — WITHOUT
 * this test ever mentioning a DB task status, because the component
 * genuinely never reads one. Harness copied from withdraw-read-failure.test.tsx.
 */

const H = vi.hoisted(() => ({
  info: null as unknown,
}))

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  isEscrowDeployed: () => true,
}))

vi.mock("@/lib/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gateway")>()),
  readEscrowTaskInfo: vi.fn(async () => H.info),
}))

const WORKER = "account_rdx12ynlx369worker0000000000000000000000000000000000000000000"
const POSTER = "account_rdx12ynlx369poster0000000000000000000000000000000000000000000"

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    account: WORKER,
    connected: true,
    rdt: {},
    ensureSession: vi.fn(),
    sessionMismatch: false,
  }),
}))

import { EscrowWithdrawButton } from "@/components/tasks/escrow-actions"

const renderButton = () => render(<EscrowWithdrawButton taskDbId={68} onChainTaskId={4} />)

/** The component reads on mount; let the resolved promise settle. */
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0))
}

describe("EscrowWithdrawButton on a cancel-after-claim task (2026-09-14)", () => {
  beforeEach(() => {
    // Shaped exactly like the incident: pull entitlements present, the
    // worker's claim bond outstanding, the reward lane empty (the poster's
    // lane, not this viewer's), no reward-token flip. `state: "Refunded"`
    // is the closest on-chain enum value to "the DB calls this cancelled" —
    // resolveWithdrawAffordance never reads `.state` at all (see its
    // source), so this is set purely for type validity, not because the
    // component cares.
    H.info = {
      state: "Refunded",
      claimDeadline: null,
      reviewDeadline: null,
      disputeRaisedBy: null,
      disputedAt: null,
      entitlements: { workerReward: "0", posterReward: "0", workerBond: "76.45", posterBond: "0" },
      entitlementsPresent: true,
      workerAccount: WORKER,
      posterAccount: POSTER,
      claimerBadgeId: "#1#",
      claimerIsAgent: false,
    }
  })
  afterEach(cleanup)

  it("renders a Collect affordance for the worker's outstanding claim bond — no DB status involved", async () => {
    renderButton()
    await settle()
    expect(screen.getByText(/settled and waiting for you/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /collect/i })).toBeInTheDocument()
  })

  it("names the claim bond specifically, not a generic reward label", async () => {
    renderButton()
    await settle()
    expect(screen.getByText(/claim bond/i)).toBeInTheDocument()
  })

  it("still renders nothing once the bond is already collected (both lanes zero) — the control", async () => {
    H.info = {
      ...(H.info as Record<string, unknown>),
      entitlements: { workerReward: "0", posterReward: "0", workerBond: "0", posterBond: "0" },
    }
    renderButton()
    await settle()
    expect(screen.queryByRole("button", { name: /collect/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/settled and waiting for you/i)).not.toBeInTheDocument()
  })
})
