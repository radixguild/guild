/**
 * P4-05 — pre-flight XRD balance check on EscrowClaimButton (the Claim
 * Task action's claim-bond stake).
 *
 * Same gap as the Deposit balance check (P4-04,
 * escrow-deposit-balance-preflight.test.tsx): before this, a worker short on
 * XRD for the claim bond discovered it only after clicking Claim and
 * watching the wallet's sign prompt fail. This pins the same conventions:
 * the balance read is a HOOK (useXrdBalance, mocked directly here — its own
 * fetch lifecycle is pinned in use-xrd-balance.test.ts), the bond is the
 * SAME live derivation sendClaimTx (lib/escrow-utils.ts) uses to size the
 * manifest (useClaimBond, also mocked directly — its own derivation is
 * pinned in claim-bond-live-derivation.test.tsx), and only a CONFIRMED
 * balance AND a settled ("ok") bond may gate the button. Either read still
 * loading, or either settled to "unknown"/"error" (a Gateway miss), must
 * fail OPEN: normal button, no fabricated warning.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BANNED, violation } from "../../scripts/honest-copy.mjs"
import { FEE_HEADROOM_XRD } from "@/lib/marketplace"

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
    ensureSession: vi.fn(),
    sessionMismatch: false,
    badge: { id: "#1#" }, // render-time badge gate satisfied
    badgeLoading: false,
  }),
}))

vi.mock("@/lib/gateway", () => ({
  loadUserBadge: vi.fn(),
  findClaimReceiptId: vi.fn(),
  readEscrowTaskState: vi.fn(),
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

vi.mock("@/lib/api-fetch", () => ({ apiFetch: vi.fn() }))

const H = vi.hoisted(() => ({
  balance: null as number | null,
  balanceChecked: false,
  recheck: vi.fn(),
  bond: null as string | null,
  bondStatus: "idle" as "idle" | "loading" | "ok" | "error",
}))
vi.mock("@/hooks/useXrdBalance", () => ({
  useXrdBalance: () => ({ balance: H.balance, checked: H.balanceChecked, recheck: H.recheck }),
}))
vi.mock("@/hooks/useClaimBond", () => ({
  useClaimBond: () => ({ bond: H.bond, divisibility: 18, status: H.bondStatus }),
}))

import { EscrowClaimButton } from "@/components/tasks/escrow-actions"
import { ALCHEMY_PAY_XRD_URL, KUCOIN_XRD_URL } from "@/components/get-xrd-links"

// Wave B's documented floor — fixed across every test below so the fixture
// values (0, 50, 76.45, 10_000) read the same way the task brief does.
const BOND_XRD = "76.45"

function renderClaim() {
  return render(<EscrowClaimButton taskDbId={1} onChainTaskId={7} posterId={POSTER} />)
}

beforeEach(() => {
  cleanup()
  H.balance = null
  H.balanceChecked = false
  H.recheck.mockClear()
  H.bond = BOND_XRD
  H.bondStatus = "ok"
  // Inert fetch: useXrdUsd etc. fail open instead of hitting the network
  // (same convention as escrow-deposit-balance-preflight.test.tsx).
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })))
})
afterEach(() => vi.unstubAllGlobals())

describe("EscrowClaimButton — XRD balance pre-flight (claim bond)", () => {
  it("confirmed 0 XRD: warns the account can't cover the claim bond, and disables Claim", () => {
    H.balance = 0
    H.balanceChecked = true
    renderClaim()
    expect(screen.getByText(/doesn.t have enough XRD/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /claim task/i })).toBeDisabled()
  })

  it("the warning says where to get XRD: Alchemy Pay and KuCoin, each in a new tab", () => {
    H.balance = 0
    H.balanceChecked = true
    renderClaim()
    const alchemy = screen.getByRole("link", { name: /alchemy pay/i })
    expect(alchemy).toHaveAttribute("href", ALCHEMY_PAY_XRD_URL)
    expect(alchemy).toHaveAttribute("target", "_blank")
    expect(alchemy).toHaveAttribute("rel", "noopener noreferrer")
    expect(screen.getByRole("link", { name: /kucoin/i })).toHaveAttribute("href", KUCOIN_XRD_URL)
  })

  it("confirmed balance below the 76.45 XRD bond: same warning + disabled", () => {
    H.balance = 50
    H.balanceChecked = true
    renderClaim()
    expect(screen.getByText(/doesn.t have enough XRD/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /claim task/i })).toBeDisabled()
  })

  it("ample balance: no warning, button enabled — no false positive", () => {
    H.balance = 10_000
    H.balanceChecked = true
    renderClaim()
    expect(screen.queryByText(/doesn.t have enough XRD/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /claim task/i })).toBeEnabled()
  })

  it("balance exactly equal to the bond: enabled (>= covers it, not just >)", () => {
    H.balance = 76.45
    H.balanceChecked = true
    renderClaim()
    expect(screen.queryByText(/doesn.t have enough XRD/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /claim task/i })).toBeEnabled()
  })

  it("balance still loading (checked:false): fails OPEN — normal enabled button, no premature warning", () => {
    H.balance = null
    H.balanceChecked = false
    renderClaim()
    expect(screen.queryByText(/doesn.t have enough XRD/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /claim task/i })).toBeEnabled()
  })

  it("balance Gateway read failure (checked:true, balance:null — a real settled 'unknown'): fails OPEN, button ENABLED", () => {
    H.balance = null
    H.balanceChecked = true
    renderClaim()
    expect(screen.queryByText(/doesn.t have enough XRD/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /claim task/i })).toBeEnabled()
  })

  it("bond still deriving (status:loading) — fails OPEN even with an otherwise-insufficient balance", () => {
    H.balance = 0
    H.balanceChecked = true
    H.bond = null
    H.bondStatus = "loading"
    renderClaim()
    expect(screen.queryByText(/doesn.t have enough XRD/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /claim task/i })).toBeEnabled()
  })

  it("bond derivation errored (status:error) — fails OPEN even with an otherwise-insufficient balance", () => {
    H.balance = 0
    H.balanceChecked = true
    H.bond = null
    H.bondStatus = "error"
    renderClaim()
    expect(screen.queryByText(/doesn.t have enough XRD/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /claim task/i })).toBeEnabled()
  })

  it("the warning's Re-check balance button calls the hook's recheck()", () => {
    H.balance = 0
    H.balanceChecked = true
    renderClaim()
    screen.getByRole("button", { name: /re-check balance/i }).click()
    expect(H.recheck).toHaveBeenCalledTimes(1)
  })
})

describe("EscrowClaimButton — fee-headroom soft tier", () => {
  // The gap P4-05 left, identical in shape to the Deposit one
  // (escrow-deposit-balance-preflight.test.tsx): the hard block covers the
  // claim bond and NOTHING ELSE, while claim_task's own network fee is locked
  // from the same XRD balance. Ported from the mint page's lowXrd tier —
  // WARNS, never disables.
  //
  // FEE_HEADROOM_XRD is imported, not re-typed as `1`, so a test cannot keep
  // passing by coincidence if the constant changes.
  const BOND = 76.45 // === Number(BOND_XRD), Wave B's documented floor

  it("balance exactly equal to the bond: WARNS about the fee, Claim stays ENABLED", () => {
    // The brief's exact case — a worker holding exactly the 76.45 bond floor.
    // P4-05's own test asserts this is enabled (correct, and unchanged); what
    // was missing is that it says anything at all.
    //
    // MUTATION CHECK, two independent ones, both verified red:
    //   (a) delete the `{lowFeeHeadroom && (...)}` Alert from
    //       EscrowClaimButton's JSX → the getByText below throws.
    //   (b) add `|| lowFeeHeadroom` to the Claim button's `disabled` → the
    //       toBeEnabled below fails.
    H.balance = BOND
    H.balanceChecked = true
    renderClaim()
    expect(screen.getByText(/small network fee on top/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /claim task/i })).toBeEnabled()
  })

  it("a fraction of an XRD above the bond: still warns", () => {
    // MUTATION CHECK — replace `xrdBalance - claimBondXrd` with
    // `xrdBalance - 0` (i.e. measure headroom against the raw balance and
    // forget the bond entirely). 76.95 is nowhere near < 1, so this goes red.
    // The balance:0 and ample-balance cases below do NOT notice that mutation,
    // which is why this case exists. (Verified: it also reddens the
    // exactly-the-bond case above and the honest-copy vacuous-pass guard.)
    H.balance = BOND + 0.5
    H.balanceChecked = true
    renderClaim()
    expect(screen.getByText(/small network fee on top/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /claim task/i })).toBeEnabled()
  })

  it("headroom of exactly FEE_HEADROOM_XRD is enough: no warning (strictly-less-than boundary)", () => {
    // MUTATION CHECK — change `<` to `<=` in the lowFeeHeadroom comparison and
    // this is the only assertion in the file that fails.
    H.balance = BOND + FEE_HEADROOM_XRD
    H.balanceChecked = true
    renderClaim()
    expect(screen.queryByText(/small network fee on top/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /claim task/i })).toBeEnabled()
  })

  it("ample balance: neither tier fires — no false positive", () => {
    H.balance = 10_000
    H.balanceChecked = true
    renderClaim()
    expect(screen.queryByText(/small network fee on top/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/doesn.t have enough XRD/i)).not.toBeInTheDocument()
  })

  it("the two tiers are mutually exclusive: a hard-blocked balance shows ONLY the hard block", () => {
    // MUTATION CHECK — drop `!insufficientXrd` from the lowFeeHeadroom
    // conjunction. At 0 the headroom is -76.45 < 1, so BOTH alerts render and
    // the queryByText below finds the soft one. The hard-block assertion is
    // the vacuous-pass guard.
    H.balance = 0
    H.balanceChecked = true
    renderClaim()
    expect(screen.getByText(/doesn.t have enough XRD/i)).toBeInTheDocument()
    expect(screen.queryByText(/small network fee on top/i)).not.toBeInTheDocument()
  })

  it("bond still deriving (status:loading): the soft tier fails OPEN too — silent", () => {
    // MUTATION CHECK — drop `claimBondXrd !== null` from lowFeeHeadroom. JS
    // evaluates `76.45 - null` to 76.45, which is NOT < 1, so that mutation
    // alone would not fire here. The discriminating fixture is a balance
    // BELOW the headroom in absolute terms: at 0.5, `0.5 - null` = 0.5 < 1 and
    // the mutated code invents a fee warning for a worker whose bond nobody
    // has managed to read. Both are asserted, in that order.
    H.balance = BOND
    H.balanceChecked = true
    H.bond = null
    H.bondStatus = "loading"
    renderClaim()
    expect(screen.queryByText(/small network fee on top/i)).not.toBeInTheDocument()

    cleanup()
    H.balance = 0.5
    renderClaim()
    expect(screen.queryByText(/small network fee on top/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /claim task/i })).toBeEnabled()
  })

  it("balance Gateway read failure (checked:true, balance:null): the soft tier fails OPEN too", () => {
    // MUTATION CHECK — drop `xrdBalance !== null` from lowFeeHeadroom. JS
    // evaluates `null - 76.45` to -76.45, which is < 1, so an UNREAD balance
    // would start warning about a fee it knows nothing about.
    H.balance = null
    H.balanceChecked = true
    renderClaim()
    expect(screen.queryByText(/small network fee on top/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /claim task/i })).toBeEnabled()
  })

  it("still loading (checked:false): the soft tier is silent even at a balance that would warn", () => {
    // MUTATION CHECK — drop `balanceChecked` from lowFeeHeadroom. The fixture
    // is deliberately the bond itself (not null), so the mutated code computes
    // a real headroom of 0 and warns before any reading has landed. A
    // null-balance fixture would have been stopped by the null guard instead
    // and proved nothing about `balanceChecked`.
    H.balance = BOND
    H.balanceChecked = false
    renderClaim()
    expect(screen.queryByText(/small network fee on top/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /claim task/i })).toBeEnabled()
  })
})

describe("claim balance-preflight copy clears the honest-copy rules", () => {
  // Client-fetched copy (useXrdBalance/useClaimBond both resolve after
  // mount) — like the Deposit preflight, this render-and-scan IS its gate.
  // Scans the ACTUAL rendered text, not a hand-copied literal.
  //
  // Extended for the fee-headroom soft tier: it is a SEPARATE string that the
  // balance:0 render can never produce (the two tiers are mutually exclusive
  // by construction), so scanning only the hard block would have left the new
  // sentence ungated.
  const STATES = [
    { label: "hard block (balance 0)", balance: 0 },
    { label: "fee-headroom warning (balance === bond)", balance: 76.45 },
  ]

  function textFor(balance: number): string {
    cleanup()
    H.balance = balance
    H.balanceChecked = true
    const { container } = renderClaim()
    return container.textContent || ""
  }

  for (const state of STATES) {
    describe(state.label, () => {
      for (const rule of BANNED) {
        it(`copy does not trip: ${rule.label}`, () => {
          expect(violation(textFor(state.balance), rule), rule.label).toBeNull()
        })
      }

      it("the scanned text is actually the tier's copy (guards a vacuous pass)", () => {
        // "" violates no rule, so without this an empty render would pass
        // every scan above. Pins that each STATE really rendered ITS tier.
        const text = textFor(state.balance)
        expect(text).toMatch(
          state.balance === 0 ? /doesn.t have enough XRD/i : /small network fee on top/i,
        )
      })
    })
  }

  it("catches a planted violation (the harness can go red)", () => {
    const planted = "this escrow-guaranteed claim is trustless"
    expect(BANNED.some((r: any) => violation(planted, r))).toBe(true)
  })
})
