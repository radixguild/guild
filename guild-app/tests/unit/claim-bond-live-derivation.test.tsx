import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * Wave B claim-bond live derivation (2026-09-13). Wave B deleted the deployed
 * component's flat `claim_bond_xrd` field: the bond is now
 * `clamp(reward * claim_bond_pct, claim_bond_floor, claim_bond_cap)` in the
 * task's own reward token, read live via readClaimBondParams +
 * readTaskRewardInfo + readTokenDivisibility (lib/gateway.ts) and
 * requiredBond (lib/manifests.ts) — the SAME chain reads sendClaimTx
 * (lib/escrow-utils.ts) already uses to build the manifest.
 *
 * ClaimDeadlineNotice (escrow-truth.tsx) used to print the flat
 * ESCROW_CLAIM_BOND_XRD constant regardless of the task. This pins the fix
 * (useClaimBond, hooks/useClaimBond.ts): it derives the bond live, prints NO
 * number while the derivation is in flight or fails, and never falls back to
 * the old constant or a guess.
 */

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const H = vi.hoisted(() => ({
  info: null as unknown,
  // Gates the FIRST of useClaimBond's three reads, so a test can assert what
  // renders while the derivation is still in flight before choosing to
  // resolve or fail it.
  bondParams: null as null | { promise: Promise<unknown>; resolve: (v: unknown) => void },
}))

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  isEscrowDeployed: () => true,
}))

vi.mock("@/lib/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gateway")>()),
  readEscrowTaskInfo: vi.fn(async () => H.info),
  readClaimBondParams: vi.fn(async () => H.bondParams!.promise),
  readTaskRewardInfo: vi.fn(async () => ({
    rewardToken: "resource_rdx1t4kep6gtkajg9nkfr9wqzqf3z9wjhpqcqxkq9y0rfmkgz3ge85u9sf",
    rewardAmount: "1000",
  })),
  readTokenDivisibility: vi.fn(async () => 18),
}))

import { ClaimDeadlineNotice } from "@/components/tasks/escrow-truth"

function baseInfo(overrides: Record<string, unknown> = {}) {
  return {
    state: "Claimed",
    claimDeadline: null,
    reviewDeadline: null,
    disputeRaisedBy: null,
    disputedAt: null,
    entitlements: { workerReward: "0", posterReward: "0", workerBond: "0", posterBond: "0" },
    entitlementsPresent: false,
    workerAccount: null,
    posterAccount: null,
    claimerBadgeId: "1",
    claimerIsAgent: false,
    ...overrides,
  }
}

describe("ClaimDeadlineNotice derives the live claim bond (Wave B)", () => {
  beforeEach(() => {
    cleanup()
    H.info = null
    H.bondParams = deferred()
  })

  it("prints no number while the derivation is in flight, then the derived amount once it resolves", async () => {
    H.info = baseInfo({ claimDeadline: new Date(Date.now() + 3600_000) }) // 1h out, not passed

    const { container } = render(<ClaimDeadlineNotice onChainTaskId={7} />)

    // The on-chain task-info read has no deferred gate, so the notice renders
    // before the bond derivation settles.
    await waitFor(() => expect(container.textContent).toMatch(/bond at risk/i))
    expect(container.textContent).toMatch(/forfeit your claim bond\./i)
    expect(container.textContent).not.toMatch(/\d+(\.\d+)?\s*XRD claim bond/)

    // Reward 1000 XRD * 10% = 100, inside [floor 10, cap 1,000,000] — the
    // same clamp(reward*pct, floor, cap) the deployed component enforces.
    H.bondParams!.resolve({ pct: "0.1", floor: "10", cap: "1000000" })

    await waitFor(() => expect(container.textContent).toMatch(/forfeit your 100 XRD claim bond\./i))
  })

  it("never falls back to a guessed number on a Gateway miss (pre-Wave-B component, or the read fails)", async () => {
    H.info = baseInfo({ claimDeadline: new Date(Date.now() + 3600_000) })
    const { container } = render(<ClaimDeadlineNotice onChainTaskId={7} />)
    await waitFor(() => expect(container.textContent).toMatch(/bond at risk/i))

    // readClaimBondParams returns null when the fields don't exist or the
    // Gateway is unreadable (lib/gateway.ts) — never a guessed number.
    H.bondParams!.resolve(null)

    // Give the resolved (null) derivation a tick to settle, then assert the
    // label never gained a number.
    await waitFor(() => expect(container.textContent).toMatch(/forfeit your claim bond\./i))
    expect(container.textContent).not.toMatch(/\d+(\.\d+)?\s*XRD claim bond/)
  })

  it("also renders the derived bond in the lapsed-deadline branch", async () => {
    H.info = baseInfo({ claimDeadline: new Date(Date.now() - 1000) }) // already passed
    const { container } = render(<ClaimDeadlineNotice onChainTaskId={7} />)
    await waitFor(() => expect(container.textContent).toMatch(/claim deadline reached/i))
    expect(container.textContent).toMatch(/forfeit your claim bond\./i)

    H.bondParams!.resolve({ pct: "0.1", floor: "10", cap: "1000000" })
    await waitFor(() => expect(container.textContent).toMatch(/forfeit your 100 XRD claim bond\./i))
  })
})
