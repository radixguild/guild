// tx-outcome.mjs — the ONE place that decides what a submitted transaction DID,
// and the only one that reads the Gateway's `error_message`.
//
// WHY THIS IS SHARED, and why it is the primitive the settlement probes needed
// first: every waiter in this repo threw the reason away. poster-harness.mjs's
// waitForCommit read `data.status` and dropped `data.error_message`; so did
// packages/agent-client/src/tx.ts. Nine call sites then reported failures as
// `<method> not committed: CommittedFailure (txid_…)` — the one string that
// cannot tell you which assert fired.
//
// That is tolerable while every transaction is expected to SUCCEED: any failure
// is a bug and you go read the ledger by hand. It stops being tolerable the
// moment a test asserts that a transaction FAILS, because then the revert IS the
// evidence, and "it reverted" is not the same claim as "it reverted for the
// reason I am about to write down".
//
// Concretely, `claim_task` runs six checks before the self-claim gate (lib.rs,
// in order): badge resource, worker is a global account, task exists, bond
// resource, bond amount, state==Open. A wrong badge, a stale bond constant, an
// under-funded signer and a mistyped task id all produce exactly the same
// CommittedFailure as the self-claim rejection the probe is trying to prove. A
// `status !== "CommittedSuccess"` check is therefore a FALSE GREEN in every one
// of those cases — and its output is destined for an audit-facing claim that the
// deployed WASM enforces a rule it may not have enforced at all.
//
// This mirrors what the Scrypto tests do on the simulator side, where the engine
// gives us `expect_commit_failure_containing_error(needle)`. assertRevertedWith
// below is that function, for mainnet.
//
// Injection over import: `gatewayPost` is a parameter, not a module import, so
// this is unit-testable without a network and cannot acquire a hidden dependency
// on any one script's Gateway config.

/** Terminal states. `Timeout` is ours — the Gateway never returns it. */
export const TERMINAL = ["CommittedSuccess", "CommittedFailure", "Rejected"]

/**
 * Poll /transaction/status until the tx leaves the mempool, then report the FULL
 * outcome.
 *
 * @param gatewayPost async (path, body) => parsed JSON
 * @returns {Promise<{status: string, errorMessage: string|null, intentHash: string}>}
 *   status is one of TERMINAL, or "Timeout" if it never settled in time.
 *   errorMessage is the Gateway's `error_message`, present on CommittedFailure
 *   and usually on Rejected. null when the Gateway did not supply one — which is
 *   itself worth surfacing rather than papering over with "".
 */
export async function readTxOutcome(gatewayPost, intentHash, opts = {}) {
  const maxWaitMs = opts.maxWaitMs ?? 90_000
  const intervalMs = opts.intervalMs ?? 5_000
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const now = opts.now ?? (() => Date.now())

  const start = now()
  for (;;) {
    const data = await gatewayPost("/transaction/status", { intent_hash: intentHash })
    if (TERMINAL.includes(data?.status)) {
      return {
        status: data.status,
        // The Gateway spells it error_message; keep null distinct from "".
        errorMessage: data.error_message ?? null,
        intentHash,
      }
    }
    // Check the clock AFTER at least one read, so a maxWaitMs of 0 still reports
    // a real status rather than an instant, uninformative Timeout.
    if (now() - start >= maxWaitMs) return { status: "Timeout", errorMessage: null, intentHash }
    await sleep(intervalMs)
  }
}

/**
 * Wait, and throw unless the transaction committed successfully — with the
 * reason attached. Replaces the nine hand-rolled
 * `if (status !== "CommittedSuccess") throw` blocks, which all discarded it.
 */
export async function commitOrThrow(gatewayPost, intentHash, what, opts = {}) {
  const outcome = await readTxOutcome(gatewayPost, intentHash, opts)
  if (outcome.status !== "CommittedSuccess") {
    throw new Error(describeFailure(outcome, what))
  }
  return outcome
}

/**
 * THE PROBE ASSERTION. Proves a transaction failed FOR A SPECIFIC REASON.
 *
 * Throws unless the outcome is a CommittedFailure whose error message contains
 * `needle`. Deliberately strict in three directions:
 *   · CommittedSuccess       — the guard under test did not fire at all
 *   · Rejected / Timeout     — the tx never reached execution, so the blueprint
 *                              asserted nothing; a fee-reserve failure or a
 *                              mempool timeout must never read as "guard works"
 *   · wrong error message    — some OTHER assert fired first
 * Each is a different bug and each gets a different message, because "the probe
 * failed" is not actionable at 5 XRD a run.
 */
export function assertRevertedWith(outcome, needle, what) {
  if (outcome.status === "CommittedSuccess") {
    throw new Error(
      `${what}: expected the transaction to REVERT with ${JSON.stringify(needle)}, but it SUCCEEDED ` +
        `(${outcome.intentHash}). The guard under test did not fire.`
    )
  }
  if (outcome.status !== "CommittedFailure") {
    throw new Error(
      `${what}: expected a CommittedFailure carrying ${JSON.stringify(needle)}, got ${outcome.status} ` +
        `(${outcome.intentHash}). The transaction never reached execution, so the blueprint asserted ` +
        `nothing — this proves neither that the guard works nor that it does not.`
    )
  }
  if (!outcome.errorMessage) {
    throw new Error(
      `${what}: transaction reverted (${outcome.intentHash}) but the Gateway returned no error_message, ` +
        `so WHICH assert fired is unknown. Refusing to record this as proof of ${JSON.stringify(needle)}.`
    )
  }
  if (!outcome.errorMessage.includes(needle)) {
    throw new Error(
      `${what}: reverted for the WRONG reason (${outcome.intentHash}).\n` +
        `  expected to contain: ${JSON.stringify(needle)}\n` +
        `  actual:              ${outcome.errorMessage}`
    )
  }
  return outcome
}

/** One-line human summary of a non-success outcome, reason included. */
export function describeFailure(outcome, what) {
  const reason = outcome.errorMessage ? ` — ${outcome.errorMessage}` : " (no error_message from the Gateway)"
  return `${what} not committed: ${outcome.status} (${outcome.intentHash})${reason}`
}
