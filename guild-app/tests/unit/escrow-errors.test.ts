/**
 * humanizeTxError (src/lib/escrow-utils.ts) — smoke finding 4.
 *
 * Wallet/engine failures must never splash raw JSON across the page: known
 * signatures (seen live in the 2026-06-11 mainnet smoke) translate to a short
 * actionable line, structured payloads collapse to a generic summary with the
 * raw text preserved for the details expando, and the two already-settled
 * signatures flag staleState so the buttons trigger a chain resync instead of
 * stranding the user.
 */
import { describe, it, expect } from "vitest"
import { humanizeTxError } from "@/lib/escrow-utils"

describe("humanizeTxError", () => {
  it("treats a wallet dismissal as a non-event", () => {
    const h = humanizeTxError('{"error":"rejectedByUser"}')
    expect(h.summary).toMatch(/no transaction was sent/i)
    expect(h.staleState).toBeUndefined()
  })

  it("translates the cancel-on-settled signature and flags staleState (smoke: cancel deadlock)", () => {
    const raw =
      '{"error":"transactionRejected","message":"...KernelError(InvalidReference...NonFungibleVaultError(MissingId(NonFungibleLocalId(\\"#2#\\")))..."}'
    const h = humanizeTxError(raw)
    expect(h.summary).toMatch(/already settled or cancelled on-chain/i)
    expect(h.staleState).toBe(true)
    expect(h.detail).toBe(raw)
  })

  it("translates the claim-raced signature and flags staleState (smoke: claim retry)", () => {
    const raw =
      'transactionRejected: PanicMessage("task must be Open — left: Claimed @ escrow.rs:212")'
    const h = humanizeTxError(raw)
    expect(h.summary).toMatch(/no longer open on-chain/i)
    expect(h.staleState).toBe(true)
    expect(h.detail).toBe(raw)
  })

  it("translates the expired-claim submit signature and flags staleState (P2: expire_claim race)", () => {
    const raw =
      'transactionRejected: PanicMessage("task must be Claimed to submit — left: Open @ escrow.rs:1009")'
    const h = humanizeTxError(raw)
    expect(h.summary).toMatch(/no longer active/i)
    expect(h.staleState).toBe(true)
    expect(h.detail).toBe(raw)
  })

  it("translates the stale-claim-receipt signature and flags staleState (P2: re-claim after expire)", () => {
    const raw =
      'transactionRejected: PanicMessage("claim_receipt is not the active one for this task @ escrow.rs:1013")'
    const h = humanizeTxError(raw)
    expect(h.summary).toMatch(/no longer active/i)
    expect(h.staleState).toBe(true)
  })

  it("does NOT flag a non-submit 'must be Claimed' assert as the expired-claim resync (scoped to '…to submit')", () => {
    // The blueprint reuses 'must be Claimed' for expire/cancel-after-claim;
    // this shared humanizer must not turn a cancel-after-claim panic into the
    // worker-facing 'your claim expired, resyncing' message.
    const raw =
      'transactionRejected: PanicMessage("task must be Claimed to cancel-after-claim @ escrow.rs:941")'
    const h = humanizeTxError(raw)
    expect(h.staleState).toBeUndefined()
    expect(h.summary).not.toMatch(/no longer active/i)
  })

  it("collapses structured payloads to a one-line summary with the raw detail", () => {
    const raw = '{"error":"transactionRejected","jsx":{"some":"deep wallet sdk object"}}'
    const h = humanizeTxError(raw)
    expect(h.summary).toMatch(/error details/i)
    expect(h.detail).toBe(raw)
    expect(h.staleState).toBeUndefined()
  })

  it("collapses over-long plain messages, passes short ones through untouched", () => {
    const long = "x".repeat(200)
    expect(humanizeTxError(long).detail).toBe(long)
    const short = "No Guild member badge in your account — you need one to claim."
    expect(humanizeTxError(short)).toEqual({ summary: short })
  })
})

/**
 * P4-06: insufficient-balance withdraws fell through to the generic
 * "Transaction failed" fallback (no case matched). The two raw shapes below
 * are not from a captured smoke incident — they're built from the exact
 * engine wording at the pinned version, cross-checked against the crates.io
 * source for radix-engine 1.3.1 (the version
 * escrow/scrypto/guild-marketplace-escrow's Cargo.lock pins, not a guess or
 * a newer/older release): a plain withdraw over balance fails
 * fungible_vault.rs's `take` with `VaultError::ResourceError(ResourceError
 * ::InsufficientBalance { requested, actual })`; the fee-lock path fails
 * with `VaultError::LockFeeInsufficientBalance { requested, actual }`
 * instead. Both Debug-print the literal substring "InsufficientBalance",
 * which is what the new case in escrow-utils.ts matches on.
 *
 * TRANSPORT, pinned separately below, because confirming the ENGINE's wording
 * is only half the claim — the other half is that the wording reaches this
 * function at all. It does: humanizeTxError is only ever fed
 * `JSON.stringify(result.error)` from the wallet SDK (sendTx in
 * escrow-utils.ts), and the captured MissingId case at the top of this file
 * pins the real shape that arrives — `{"error":"transactionRejected",
 * "message":"<engine Debug text>"}` — with tests/support/mock-ledger.ts
 * building the same `{ error, message }` object. So the engine string travels
 * inside `message`, and a substring match sees it either way. The last case
 * here asserts that on the JSON-object form rather than the bare string, so
 * the suite does not rest entirely on a shape the wallet never actually sends.
 */
describe("humanizeTxError — insufficient balance (P4-06)", () => {
  const GENERIC_FALLBACK = "Transaction failed — open the error details below."

  it.each([
    [
      "plain withdraw exceeds balance (deposit or claim bond) — VaultError::ResourceError",
      'transactionRejected: RuntimeError(ApplicationError(VaultError(ResourceError(InsufficientBalance { requested: 500, actual: 12.5 }))))',
    ],
    [
      "fee-lock exceeds balance — VaultError::LockFeeInsufficientBalance",
      'transactionRejected: RuntimeError(ApplicationError(VaultError(LockFeeInsufficientBalance { requested: 0.29310563, actual: 0 })))',
    ],
    [
      "the shape the wallet SDK actually sends — engine text inside `message` of a JSON-stringified error",
      '{"error":"transactionRejected","message":"RuntimeError(ApplicationError(VaultError(ResourceError(InsufficientBalance { requested: 1050, actual: 360.54 }))))"}',
    ],
  ])("%s", (_label, raw) => {
    const h = humanizeTxError(raw)
    expect(h.summary).toMatch(/not enough xrd/i)
    expect(h.summary).not.toBe(GENERIC_FALLBACK)
    expect(h.staleState).toBeUndefined()
    expect(h.detail).toBe(raw)
  })

  /**
   * `WorktopError::InsufficientBalance` (worktop.rs) is a UNIT variant that
   * Debug-prints the same substring for an entirely different failure: the
   * manifest asserted more on the worktop than it put there. That is our bug,
   * not the user's balance, and "add some XRD and try again" would send them
   * to buy tokens that cannot fix it.
   *
   * MUTATION CHECK — this test fails if the `!/WorktopError/i` guard in
   * escrow-utils.ts is dropped: with a bare /InsufficientBalance/i the string
   * below matches the balance case and `summary` becomes "Not enough XRD…".
   */
  it("does NOT claim a balance problem for a worktop assertion failure", () => {
    const raw =
      '{"error":"transactionRejected","message":"RuntimeError(ApplicationError(WorktopError(InsufficientBalance)))"}'
    const h = humanizeTxError(raw)
    expect(h.summary).not.toMatch(/not enough xrd/i)
    expect(h.summary).toBe(GENERIC_FALLBACK)
    expect(h.detail).toBe(raw)
  })
})
