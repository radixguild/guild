import { describe, it, expect, vi, beforeEach } from "vitest"
import { settlementCopy } from "@/lib/settlement-copy"
import { render, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * Approve & Release is POSTER-ONLY. Found in the 2026-07-18 mainnet acceptance
 * run: EscrowApproveButton lacked the `account !== posterId` gate that
 * EscrowCancelButton has, so the button rendered for the WORKER too. The release
 * manifest withdraws the poster-held Task Receipt NFT, so a worker press aborts
 * on-chain (funds are never at risk) — but the UI must not offer a button that
 * can only burn a fee. This pins the gate: renders for the poster, not for anyone
 * else, with every OTHER render condition satisfied so it can't pass vacuously.
 */

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  isEscrowDeployed: () => true,
}))

const POSTER = "account_rdx12ynlx369poster000000000000000000000000000000000000000000"
const WORKER = "account_rdx12890803worker000000000000000000000000000000000000000000"

const H = vi.hoisted(() => ({ account: "" }))

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    account: H.account,
    connected: true,
    rdt: {},
    ensureSession: vi.fn(),
    sessionMismatch: false,
  }),
}))

// The approve warning reads the on-chain review deadline (2026-09-24); keep the
// gate test hermetic — no Gateway read.
vi.mock("@/hooks/useOnChainTaskInfo", () => ({
  useOnChainTaskInfo: () => ({ info: null, status: "idle", reload: vi.fn() }),
}))

import { EscrowApproveButton } from "@/components/tasks/escrow-actions"

function renderApprove() {
  // onChainTaskId + workerAddress present, submitted-state — every non-identity
  // render condition met, so a null result is the poster gate and nothing else.
  return render(
    <EscrowApproveButton
      taskDbId={1}
      onChainTaskId={5}
      posterId={POSTER}
      rewardXrd={100}
      workerAddress={WORKER}
    />,
  )
}

describe("EscrowApproveButton poster gate", () => {
  beforeEach(() => cleanup())

  it("renders the approve button for the poster", () => {
    H.account = POSTER
    const { getByRole } = renderApprove()
    // The label is ERA COPY, not a literal. It was pinned to the push string
    // ("Approve & Release Payment") and broke at S3 when the era became a
    // constant — the button was rendering fine, under the pull wording
    // ("Approve & Credit Payment"). Read it from the same source the component
    // does, so this asserts the POSTER GATE (what it is for) rather than a
    // sentence that is allowed to change.
    const label = settlementCopy("approveButtonIdle")!
    expect(getByRole("button", { name: new RegExp(label, "i") })).toBeInTheDocument()
  })

  it("renders NOTHING for the worker (the bug: worker must not see approve)", () => {
    H.account = WORKER
    const { container } = renderApprove()
    expect(container.firstChild).toBeNull()
  })

  it("renders NOTHING for an unrelated third account", () => {
    H.account = "account_rdx12other0000000000000000000000000000000000000000000000000"
    const { container } = renderApprove()
    expect(container.firstChild).toBeNull()
  })
})
