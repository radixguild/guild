/**
 * Runs the REAL honest-copy rule table (scripts/honest-copy.mjs — the same
 * module launch-check.sh CHECK 4 and the cold-user e2e spec both import)
 * against the poster cancel-after-claim disclosure added to EscrowClaimButton
 * for PROJECT-STATE.md's 2026-09-01 §20 design packet (unnumbered
 * "Also in §20" bullet — NOT §20.4, an unrelated open bug).
 *
 * This component (src/components/tasks/escrow-actions.tsx) is NOT yet wired
 * into scripts/honest-copy.mjs's own DETAIL_COMPONENTS list on this branch
 * (that list is a later addition — see docs/PROJECT-STATE.md's 2026-09-02
 * entry on a sibling branch), so nothing else in this baseline scans it
 * automatically. Rather than add that wiring here — a bigger, separate
 * decision about gating the whole file, already being made independently
 * elsewhere — this test applies the exact same rule table directly to the
 * new copy's RENDERED text, at every count/rate combination it can show
 * (including the two edges: zero cancels, and every posted task cancelled
 * after claim), so the claim "this copy passes honest-copy.mjs" is actually
 * checked rather than asserted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { BANNED, PULL_BANNED, violation } from "../../scripts/honest-copy.mjs"

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
    badge: { id: "#1#" },
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
// useClaimBond) — mocked to ample/settled values so its warning copy never
// renders here; it has its own honest-copy pass in
// escrow-claim-balance-preflight.test.tsx.
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

const ALL_RULES = [...BANNED, ...PULL_BANNED]

// count/rate combinations the block can actually render, including both
// edges: nothing ever cancelled after claim, and every posted task was.
const FIXTURES: Array<{ totalPosted: number; cancelledAfterClaim: number }> = [
  { totalPosted: 5, cancelledAfterClaim: 0 }, // 0% edge
  { totalPosted: 4, cancelledAfterClaim: 1 }, // the task's documented "1" fixture
  { totalPosted: 6, cancelledAfterClaim: 3 }, // the task's documented "3" fixture
  { totalPosted: 3, cancelledAfterClaim: 3 }, // 100% edge
  { totalPosted: 1, cancelledAfterClaim: 0 }, // singular-task pluralization
]

describe("poster cancel-after-claim disclosure clears the real honest-copy rule table", () => {
  beforeEach(() => cleanup())

  it.each(FIXTURES)(
    "no BANNED or PULL_BANNED rule fires on the rendered copy for %j",
    (posterCancelStats) => {
      const { container } = render(
        <EscrowClaimButton
          taskDbId={1}
          onChainTaskId={7}
          posterId={POSTER}
          posterCancelStats={posterCancelStats}
        />,
      )
      const text = container.textContent ?? ""
      expect(text.length).toBeGreaterThan(0) // vacuous-pass guard

      const hits = ALL_RULES.map((r: unknown) => violation(text, r)).filter(Boolean)
      expect(hits, `banned claim(s) in rendered copy: ${hits.join(" | ")}`).toEqual([])
    },
  )
})
