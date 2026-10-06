/**
 * P4-04 — pre-flight XRD balance check on EscrowDepositButton (the Fund
 * Escrow action).
 *
 * Before this, escrow-actions.tsx had ZERO balance checks anywhere: a
 * poster short on XRD discovered it only after clicking Fund and watching
 * the wallet's sign prompt fail. This pins the same conventions as the mint
 * page's own pre-flight (src/app/mint/page.tsx) and the W3 freeze gate
 * (escrow-posting-freeze.test.tsx): the balance read is a HOOK
 * (useXrdBalance, mocked directly here — its own fetch lifecycle is pinned
 * in use-xrd-balance.test.ts), and only a CONFIRMED reading may gate the
 * button. A reading that never resolves (checked:false) or resolves to
 * "unknown" (checked:true, balance:null — a real Gateway miss) must fail
 * OPEN: normal button, no fabricated warning.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BANNED, violation } from "../../scripts/honest-copy.mjs"
import { FEE_HEADROOM_XRD } from "@/lib/marketplace"

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  isEscrowDeployed: () => true,
}))

const POSTER = "account_rdx12ynlx369poster000000000000000000000000000000000000000000"

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    account: POSTER,
    connected: true,
    rdt: {},
    ensureSession: vi.fn(),
    sessionMismatch: false,
  }),
}))

vi.mock("@/hooks/useEscrowPostingFrozen", () => ({
  useEscrowPostingFrozen: () => false,
}))

const H = vi.hoisted(() => ({
  balance: null as number | null,
  checked: false,
  recheck: vi.fn(),
}))
vi.mock("@/hooks/useXrdBalance", () => ({
  useXrdBalance: () => ({ balance: H.balance, checked: H.checked, recheck: H.recheck }),
}))

import { EscrowDepositButton } from "@/components/tasks/escrow-actions"
import { KUCOIN_XRD_URL } from "@/components/get-xrd-links"

// reward 100 + ceil(100 * 0.05) insurance = 105 required, matching
// sendDepositTx's own rounding (lib/escrow-utils.ts) exactly.
const REWARD_XRD = 100

function renderDeposit() {
  return render(<EscrowDepositButton taskId="1" rewardXrd={REWARD_XRD} title="t" description="d" />)
}

beforeEach(() => {
  cleanup()
  H.balance = null
  H.checked = false
  H.recheck.mockClear()
  // Inert fetch: useXrdUsd etc. fail open instead of hitting the network
  // (same convention as escrow-posting-freeze.test.tsx).
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })))
})
afterEach(() => vi.unstubAllGlobals())

describe("EscrowDepositButton — XRD balance pre-flight", () => {
  it("confirmed 0 XRD: warns the account can't cover reward + insurance, and disables Fund", () => {
    H.balance = 0
    H.checked = true
    renderDeposit()
    expect(screen.getByText(/doesn.t have enough XRD/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /fund escrow/i })).toBeDisabled()
  })

  it("the warning says where to get XRD: KuCoin, in a new tab", () => {
    H.balance = 0
    H.checked = true
    renderDeposit()
    const kucoin = screen.getByRole("link", { name: /kucoin/i })
    expect(kucoin).toHaveAttribute("href", KUCOIN_XRD_URL)
    expect(kucoin).toHaveAttribute("target", "_blank")
    expect(kucoin).toHaveAttribute("rel", "noopener noreferrer")
    // 2026-10-06: Alchemy Pay's ramp would not sell XRD, so it is not offered.
    expect(screen.queryByRole("link", { name: /alchemy pay/i })).toBeNull()
  })

  it("confirmed balance below the required 105 (reward + insurance): same warning + disabled", () => {
    H.balance = 50
    H.checked = true
    renderDeposit()
    expect(screen.getByText(/doesn.t have enough XRD/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /fund escrow/i })).toBeDisabled()
  })

  it("ample balance: no warning, button enabled — no false positive", () => {
    H.balance = 10_000
    H.checked = true
    renderDeposit()
    expect(screen.queryByText(/doesn.t have enough XRD/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /fund escrow/i })).toBeEnabled()
  })

  it("balance exactly equal to the required total: enabled (>= covers it, not just >)", () => {
    H.balance = 105
    H.checked = true
    renderDeposit()
    expect(screen.queryByText(/doesn.t have enough XRD/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /fund escrow/i })).toBeEnabled()
  })

  it("covers the reward but NOT the insurance on top: still warns and disables", () => {
    // The discriminating case. 0 / 50 / 105 / 10_000 all land the same way
    // whether the threshold is `reward` or `reward + insurance`, so none of
    // them actually pins the insurance term — the exact thing sendDepositTx
    // locks beyond the reward. 100 is the only value in the batch that
    // separates the two.
    //
    // MUTATION CHECK — drop `+ insuranceXrd` from requiredXrd in
    // escrow-actions.tsx and this is the ONLY assertion in the file that
    // fails: the button comes back enabled for a poster who cannot cover
    // what the transaction will actually withdraw.
    H.balance = 100 // === REWARD_XRD, one XRD short of the ceil(100 * 0.05) = 5 insurance
    H.checked = true
    renderDeposit()
    expect(screen.getByText(/doesn.t have enough XRD/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /fund escrow/i })).toBeDisabled()
  })

  it("still loading (checked:false): fails OPEN — normal enabled button, no premature warning", () => {
    H.balance = null
    H.checked = false
    renderDeposit()
    expect(screen.queryByText(/doesn.t have enough XRD/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /fund escrow/i })).toBeEnabled()
  })

  it("Gateway read failure (checked:true, balance:null — a real settled 'unknown'): fails OPEN, button ENABLED", () => {
    // This is the direction the task calls out explicitly: failing closed
    // here (blocking a poster whose balance we simply couldn't read) would
    // be a worse bug than the one this check fixes.
    H.balance = null
    H.checked = true
    renderDeposit()
    expect(screen.queryByText(/doesn.t have enough XRD/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /fund escrow/i })).toBeEnabled()
  })

  it("the warning's Re-check balance button calls the hook's recheck()", () => {
    H.balance = 0
    H.checked = true
    renderDeposit()
    screen.getByRole("button", { name: /re-check balance/i }).click()
    expect(H.recheck).toHaveBeenCalledTimes(1)
  })
})

describe("EscrowDepositButton — fee-headroom soft tier", () => {
  // The gap P4-04 left: requiredXrd is reward + insurance and NOTHING ELSE,
  // but the transaction's own network fee comes out of the same XRD balance.
  // Ported from the mint page's lowXrd tier (src/app/mint/page.tsx) — WARNS,
  // never disables, because FEE_HEADROOM_XRD is a generous hint and blocking
  // on it would fail closed on a poster who can actually pay.
  //
  // FEE_HEADROOM_XRD is imported rather than re-typed as `1`: a test that
  // hard-codes the number keeps passing if the constant moves, which is the
  // fixture-coincides-with-the-bug shape this repo treats as a finding.
  const REQUIRED = 105 // REWARD_XRD + Math.ceil(REWARD_XRD * INSURANCE_RATE)

  it("balance exactly equal to the required total: WARNS about the fee, Fund stays ENABLED", () => {
    // The brief's exact case — a poster holding exactly 105 XRD for a 100 XRD
    // task. P4-04's own test asserts this is enabled (correct, and unchanged);
    // what was missing is that it says anything at all.
    //
    // MUTATION CHECK, two independent ones, both verified red:
    //   (a) delete the `{lowFeeHeadroom && (...)}` Alert from
    //       EscrowDepositButton's JSX → the getByText below throws.
    //   (b) add `|| lowFeeHeadroom` to the Fund button's `disabled` (i.e. make
    //       the soft tier a hard block) → the toBeEnabled below fails.
    H.balance = REQUIRED
    H.checked = true
    renderDeposit()
    expect(screen.getByText(/small network fee on top/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /fund escrow/i })).toBeEnabled()
  })

  it("headroom is measured above reward + insurance, not above the reward alone", () => {
    // Discriminating case for the INSURANCE term inside the headroom maths —
    // the same term #679 had to add a dedicated case for in the hard block.
    // At 109 the headroom above requiredXrd (105) is 4 ≥ 1 → silent; the
    // headroom above rewardXrd (100) would be 9, also silent. So 109 alone
    // does not discriminate — 105.5 below does. Both are asserted here:
    // silent at 109, warning at 105.5.
    //
    // MUTATION CHECK — change the headroom subtraction in escrow-actions.tsx
    // from `xrdBalance - requiredXrd` to `xrdBalance - rewardXrd`. The 105.5
    // assertion goes red: headroom above the reward ALONE is 5.5 ≥ 1, so the
    // warning disappears for a poster with half an XRD to spare. (Verified:
    // that mutation also reddens the exactly-105 case above and the
    // honest-copy vacuous-pass guard, for the same reason.)
    H.balance = 109
    H.checked = true
    renderDeposit()
    expect(screen.queryByText(/small network fee on top/i)).not.toBeInTheDocument()

    cleanup()
    H.balance = REQUIRED + 0.5
    renderDeposit()
    expect(screen.getByText(/small network fee on top/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /fund escrow/i })).toBeEnabled()
  })

  it("headroom of exactly FEE_HEADROOM_XRD is enough: no warning (strictly-less-than boundary)", () => {
    // MUTATION CHECK — change `<` to `<=` in the lowFeeHeadroom comparison and
    // this is the only assertion in the file that fails. Pins the boundary the
    // constant names rather than "somewhere near 1 XRD".
    H.balance = REQUIRED + FEE_HEADROOM_XRD
    H.checked = true
    renderDeposit()
    expect(screen.queryByText(/small network fee on top/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /fund escrow/i })).toBeEnabled()
  })

  it("ample balance: neither tier fires — no false positive", () => {
    H.balance = 10_000
    H.checked = true
    renderDeposit()
    expect(screen.queryByText(/small network fee on top/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/doesn.t have enough XRD/i)).not.toBeInTheDocument()
  })

  it("the two tiers are mutually exclusive: a hard-blocked balance shows ONLY the hard block", () => {
    // MUTATION CHECK — drop `!insufficientXrd` from the lowFeeHeadroom
    // conjunction. At 0 the headroom is -105 < 1, so BOTH alerts render and
    // the queryByText below finds the soft one. (The hard-block assertion is
    // the vacuous-pass guard: without it a broken render that shows neither
    // alert would pass this test.)
    H.balance = 0
    H.checked = true
    renderDeposit()
    expect(screen.getByText(/doesn.t have enough XRD/i)).toBeInTheDocument()
    expect(screen.queryByText(/small network fee on top/i)).not.toBeInTheDocument()
  })

  it("Gateway read failure (checked:true, balance:null): the soft tier fails OPEN too — silent", () => {
    // MUTATION CHECK — drop `xrdBalance !== null` from lowFeeHeadroom. JS
    // evaluates `null - 105` to -105, which is < 1, so an UNREAD balance would
    // start telling the poster their account is nearly empty. The hard block
    // has its own null guard, so only this tier would fabricate the claim.
    H.balance = null
    H.checked = true
    renderDeposit()
    expect(screen.queryByText(/small network fee on top/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /fund escrow/i })).toBeEnabled()
  })

  it("still loading (checked:false): the soft tier is silent even at a balance that would warn", () => {
    // MUTATION CHECK — drop `balanceChecked` from lowFeeHeadroom. The fixture
    // is deliberately REQUIRED (not null), so the mutated code computes a real
    // headroom of 0 and warns before any reading has landed. A null-balance
    // fixture here would have been caught by the null guard instead and proved
    // nothing about `balanceChecked` — the coincidence this comment exists to
    // rule out.
    H.balance = REQUIRED
    H.checked = false
    renderDeposit()
    expect(screen.queryByText(/small network fee on top/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /fund escrow/i })).toBeEnabled()
  })
})

describe("balance-preflight copy clears the honest-copy rules", () => {
  // Client-fetched copy (useXrdBalance resolves after mount) — like the W3
  // freeze notice, neither launch-check CHECK 4 nor the cold-user SSR sweep
  // can see this, so this render-and-scan IS its gate. Scans the ACTUAL
  // rendered text (not a hand-copied literal) so the check tracks the real
  // shipped copy.
  //
  // Extended for the fee-headroom soft tier: it is a SEPARATE string that the
  // balance:0 render below can never produce (the two tiers are mutually
  // exclusive by construction), so scanning only the hard block would have
  // left the new sentence ungated. Both states are rendered and scanned, and
  // each is the ACTUAL rendered text rather than a hand-copied literal — a
  // literal would keep passing after someone edits the component.
  const STATES = [
    { label: "hard block (balance 0)", balance: 0 },
    { label: "fee-headroom warning (balance === required)", balance: 105 },
  ]

  function textFor(balance: number): string {
    cleanup()
    H.balance = balance
    H.checked = true
    const { container } = renderDeposit()
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
        // Without this, an empty render — or a state that silently stopped
        // producing an alert — would sail through every rule above, because
        // "" violates nothing. Pins that each STATE really rendered ITS tier.
        const text = textFor(state.balance)
        expect(text).toMatch(
          state.balance === 0 ? /doesn.t have enough XRD/i : /small network fee on top/i,
        )
      })
    })
  }

  it("catches a planted violation (the harness can go red)", () => {
    const planted = "this escrow-guaranteed deposit is trustless"
    expect(BANNED.some((r: any) => violation(planted, r))).toBe(true)
  })
})
