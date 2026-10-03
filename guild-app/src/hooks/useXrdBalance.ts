"use client"

// Shared XRD-balance read, modelled on the mint page's pre-flight so every
// money action pins the SAME contract instead of re-deriving it per button.
// Callers: P4-04 (the deposit/fund action), P4-05 (the claim action's bond
// check), and src/app/mint/page.tsx.
//
// ⚠️ The mint page was listed as a caller here from the day this hook was
// written, but it kept its own local fetch until 2026-09-16 — so for that span
// this comment described a migration that had not happened, and the page it
// named still had the stale-reading bugs this hook exists to prevent. The
// docblock was the only evidence the extraction was done. mint-balance-
// preflight.test.tsx now pins the wiring at the page level, so the claim is
// checked rather than asserted.
//
// The null/0/>0 contract is fetchXrdBalance's own (lib/gateway.ts) — this
// hook only adds the per-account request lifecycle around it:
//   • `checked` flips true once a request for the CURRENT account has
//     settled (fetchXrdBalance never throws — see its docblock — so this is
//     "the round trip completed", not "the read succeeded").
//   • `balance` stays null until then, and again null (with `checked` reset)
//     the instant `account` changes, so a stale reading for a previous
//     account can never be read as the new one's.
// Callers derive their own gate from `checked && balance === N` — exactly
// the mint page's `noXrd`/`lowXrd` shape — because "checked" alone must
// NEVER gate a button: a Gateway failure resolves `balance` to null, and
// null must fail OPEN (fetchXrdBalance's docblock; mint page comment "Only
// act on a CONFIRMED reading").

import { useCallback, useEffect, useState } from "react"
import { fetchXrdBalance } from "@/lib/gateway"

export interface XrdBalanceResult {
  /** null = unknown (loading, no account, or a Gateway miss) — never block on
   *  this alone. 0 = confirmed empty. >0 = the confirmed balance. */
  balance: number | null
  /** True once a real answer has landed for the CURRENT account. */
  checked: boolean
  /** Re-run the fetch for the current account (e.g. a "re-check" affordance
   *  after the user tops up). No-op with no connected account. */
  recheck: () => void
}

export function useXrdBalance(account: string | null | undefined): XrdBalanceResult {
  const [state, setState] = useState<{
    account: string
    balance: number | null
    checked: boolean
  }>({ account: "", balance: null, checked: false })
  // Bumped on every fetch (mount + each recheck) so a slow, superseded
  // request can't overwrite a newer one's result — the same stale-response
  // guard useOnChainTaskInfo/useClaimBond use, done with a counter here
  // because recheck() needs to re-trigger a fetch for an UNCHANGED account,
  // which a dependency-array effect alone won't do.
  const [attempt, setAttempt] = useState(0)

  // Reset on every account TRANSITION, including a disconnect — React's
  // documented adjust-state-during-render pattern, not an effect, so it does
  // not trip react-hooks/set-state-in-effect.
  //
  // Why this is needed even though `mine` already compares state.account to
  // account: `mine` only covers A → B. It does NOT cover A → disconnect → A,
  // or the wallet's A → B → A account switch. In those, `state` still holds
  // A's old reading, `mine` is true again the instant A returns, and the
  // cached balance is served as CONFIRMED for the render before the refetch
  // lands. A poster who topped up while disconnected would come back to
  // "This account doesn't have enough XRD" and a DISABLED Fund button.
  //
  // That is the fail-CLOSED-on-unknown-data failure this hook's whole
  // contract exists to prevent, so it is worth the extra render: clearing
  // `checked` puts the caller back on the fail-open path until a reading for
  // the current connection actually returns.
  const [lastAccount, setLastAccount] = useState(account)
  if (account !== lastAccount) {
    setLastAccount(account)
    // `checked` is the only field that can make a stale reading look
    // confirmed; if it is already false there is nothing to clear and the
    // extra render is skipped.
    if (state.checked) setState({ account: "", balance: null, checked: false })
  }

  useEffect(() => {
    // No synchronous setState in the effect body — that is the
    // react-hooks/set-state-in-effect trap this repo has already been bitten
    // by once (see app/groups/page.tsx's fetchBrowse comment for the other
    // half of the same lesson). A disconnected wallet needs NO reset anyway:
    // `mine` below is `!!account && state.account === account`, which is
    // already false with no account, so every derived value reads as
    // unchecked without touching state at all.
    if (!account) return
    let live = true
    fetchXrdBalance(account).then((bal) => {
      if (!live) return
      setState({ account, balance: bal, checked: true })
    })
    return () => {
      live = false
    }
  }, [account, attempt])

  const recheck = useCallback(() => {
    if (account) setAttempt((n) => n + 1)
  }, [account])

  const mine = !!account && state.account === account
  return {
    balance: mine ? state.balance : null,
    checked: mine ? state.checked : false,
    recheck,
  }
}
