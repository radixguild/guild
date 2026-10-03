/**
 * EscrowClaimButton's "Before you claim" block (2026-09-24, from the
 * independent web-app review of #766, item A1): the terms of the claim bond,
 * stated above the button before the commitment.
 *
 * What it must say, each checked against escrow/scrypto/guild-marketplace-escrow/src/lib.rs
 * and the live component's config (Gateway, state version 559475439):
 *   - the EXACT bond — claim_task asserts `claim_bond.amount() == required_bond`,
 *     so the block shows useClaimBond's live derivation, never a guess;
 *   - the submit deadline (human_submit_deadline_secs = 604800, 7 days);
 *   - an hour after it (expire_grace_secs = 3600) anyone can close the claim and
 *     the bond is forfeited: expire_bounty_pct (0.1) to the caller, the rest to
 *     the owner-only forfeited-bonds vault;
 *   - once a dispute is raised, the bond is split by the reward ruling on BOTH
 *     ways out of it — the arbiter's resolve_dispute and the default
 *     auto_resolve_dispute applies after the window (W5, credit_split_for_parties).
 *     Until 2026-10-02 the block said "A dispute ruling splits it", which left the
 *     unruled default (an even split on the live component) out.
 *
 * 2026-09-24, from the web-app reviewer's final pass:
 *   - "exactly" belongs on the XRD figure (what claim_task asserts), never on
 *     the USD estimate — with a rate it read "exactly US$0.04 (76.5 XRD)";
 *   - the block renders ABOVE the no-wallet, poster and no-badge early
 *     returns (useClaimBond needs no wallet), so every visitor sees the terms.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BANNED, PULL_BANNED, violation } from "../../scripts/honest-copy.mjs"

const ACCOUNT = "account_rdx12worker00000000000000000000000000000000000000000000000"
const POSTER = "account_rdx12poster00000000000000000000000000000000000000000000000"

const H = vi.hoisted(() => ({
  bond: { bond: "76.45" as string | null, divisibility: 18 as number | null, status: "ok" as "ok" | "loading" | "error" },
  rate: null as number | null,
  wallet: {
    account: "" as string | null,
    badge: { id: "#1#" } as { id: string } | null,
  },
}))

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  isEscrowDeployed: () => true,
}))

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    account: H.wallet.account,
    rdt: H.wallet.account ? {} : null,
    ensureSession: vi.fn().mockResolvedValue(true),
    sessionMismatch: false,
    badge: H.wallet.badge,
    badgeLoading: false,
  }),
}))

vi.mock("@/lib/use-xrd-usd", () => ({
  useXrdUsd: () => ({ rate: H.rate, stale: false, ageSeconds: 5, source: "test" }),
}))

vi.mock("@/lib/api-fetch", () => ({ apiFetch: vi.fn() }))

vi.mock("@/lib/gateway", () => ({
  loadUserBadge: vi.fn(),
  findClaimReceiptId: vi.fn(),
  readEscrowTaskState: vi.fn(),
}))

vi.mock("@/hooks/useXrdBalance", () => ({
  useXrdBalance: () => ({ balance: 1_000_000, checked: true, recheck: vi.fn() }),
}))
vi.mock("@/hooks/useClaimBond", () => ({
  useClaimBond: () => H.bond,
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

describe("EscrowClaimButton — the terms stated before a claim", () => {
  beforeEach(() => {
    cleanup()
    H.bond = { bond: "76.45", divisibility: 18, status: "ok" }
    H.rate = null
    H.wallet = { account: ACCOUNT, badge: { id: "#1#" } }
  })

  it("states the exact bond, the deadline, the forfeit split and the dispute split", () => {
    render(<EscrowClaimButton taskDbId={1} onChainTaskId={7} posterId={POSTER} />)
    const block = screen.getByTestId("claim-terms")
    expect(block).toHaveTextContent(/Claiming locks a bond of exactly 76\.45 XRD/)
    expect(block).toHaveTextContent(/accepts only that exact amount/)
    expect(block).toHaveTextContent(/7 days to submit/)
    expect(block).toHaveTextContent(/An hour after that deadline, anyone can close your claim/)
    expect(block).toHaveTextContent(/90% to a vault only the operator can withdraw, 10% to whoever closes it/)
    expect(block).toHaveTextContent(
      /If a dispute is raised, it is split the same way as the reward instead, whether an arbiter rules or the 72-hour default applies/,
    )
    expect(block).not.toHaveTextContent(/A dispute ruling splits/)
    // The block sits above the button, not instead of it.
    expect(screen.getByRole("button", { name: /claim task/i })).toBeInTheDocument()
  })

  it("never prints a guessed amount while the bond is unknown", () => {
    H.bond = { bond: null, divisibility: null, status: "error" }
    render(<EscrowClaimButton taskDbId={1} onChainTaskId={7} posterId={POSTER} />)
    const block = screen.getByTestId("claim-terms")
    expect(block).not.toHaveTextContent(/exactly/)
    expect(block).toHaveTextContent(/10% of the reward, at least 76\.45 XRD today \(an owner setting\)/)
  })

  it("with a USD rate, 'exactly' stays on the XRD figure and the dollars are an estimate beside it", () => {
    H.rate = 0.0005 // 76.45 XRD ≈ $0.04
    render(<EscrowClaimButton taskDbId={1} onChainTaskId={7} posterId={POSTER} />)
    const text = screen.getByTestId("claim-terms").textContent ?? ""
    // Locale decides "$" or "US$"; either is fine, the ORDER is the point.
    expect(text).toMatch(/exactly 76\.45 XRD \(≈ (US)?\$0\.04\)/)
    expect(text).not.toMatch(/exactly (US)?\$/)
  })

  it.each([
    ["a disconnected visitor", () => { H.wallet = { account: null, badge: null } }, /Connect your wallet to claim this task/],
    ["a visitor with no badge", () => { H.wallet = { account: ACCOUNT, badge: null } }, /A Guild member badge is required to claim/],
    ["the poster", () => { H.wallet = { account: POSTER, badge: { id: "#1#" } } }, /You posted this task/],
  ])("shows the terms to %s too, above that branch's own notice", (_who, arrange, notice) => {
    arrange()
    const { container } = render(<EscrowClaimButton taskDbId={1} onChainTaskId={7} posterId={POSTER} />)
    const block = screen.getByTestId("claim-terms")
    expect(block).toHaveTextContent(/Claiming locks a bond of exactly 76\.45 XRD/)
    const noticeEl = screen.getByText(notice)
    // DOCUMENT_POSITION_FOLLOWING: the notice comes after the terms block.
    expect(block.compareDocumentPosition(noticeEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // No claim button in these branches.
    expect(container.querySelector("button")).toBeNull()
  })

  it("passes every honest-copy rule, live and pull-era", () => {
    render(<EscrowClaimButton taskDbId={1} onChainTaskId={7} posterId={POSTER} />)
    const text = screen.getByTestId("claim-terms").textContent ?? ""
    const hits = [...BANNED, ...PULL_BANNED]
      .map((r: { label: string; re: RegExp; allow?: RegExp[] }) => [r.label.split(" ")[0], violation(text, r)])
      .filter(([, v]) => v)
    expect(hits).toEqual([])
  })
})
