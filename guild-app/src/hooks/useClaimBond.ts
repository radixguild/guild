"use client"

// Live claim-bond derivation for one on-chain task (Wave B, 2026-09-13).
//
// Wave B deleted the deployed component's flat `claim_bond_xrd` field — the
// bond is now `clamp(reward * claim_bond_pct, claim_bond_floor, claim_bond_cap)`
// in the task's own reward token (readClaimBondParams/readTaskRewardInfo in
// lib/gateway.ts, requiredBond in lib/manifests.ts). sendClaimTx
// (lib/escrow-utils.ts) already derives it this way to build the manifest and
// fails closed rather than guessing; this hook runs the SAME derivation so
// copy that quotes the bond states what the transaction will actually move,
// not the old ESCROW_CLAIM_BOND_XRD constant.
//
// There is deliberately no fallback constant: `bond` stays null until every
// read resolves, on both `loading` and `error` — a guessed bond is either a
// reverted transaction (too small) or real money quoted on an unverified
// number (too large), same reasoning as sendClaimTx's own fail-closed comment.

import { useEffect, useState } from "react"
import { isEscrowDeployed, ESCROW_COMPONENT } from "@/lib/config"
import { readClaimBondParams, readTaskRewardInfo, readTokenDivisibility } from "@/lib/gateway"
import { requiredBond } from "@/lib/manifests"

export type ClaimBondStatus = "idle" | "loading" | "ok" | "error"

export interface ClaimBondResult {
  /** The derived bond amount, as a plain decimal string in the task's own
   *  reward token. Null until a real derivation resolves — on `loading` AND
   *  on `error` (a Gateway miss on any of the three reads), never a guess. */
  bond: string | null
  /** The reward token's on-chain divisibility (0-18) — the SAME value
   *  `requiredBond` rounded `bond` to. Callers that derive a further amount
   *  FROM `bond` (e.g. a percentage of it) must round to this, not assume
   *  18dp, or they can print a number the contract would never actually pay
   *  (expire_claim's own bounty rounds to this same divisibility,
   *  escrow/scrypto/guild-marketplace-escrow/src/lib.rs). Null exactly when
   *  `bond` is null. */
  divisibility: number | null
  status: ClaimBondStatus
}

/**
 * Derive the live claim bond for one on-chain task id, keyed off the deployed
 * escrow component (defaults to the current `ESCROW_COMPONENT`).
 */
export function useClaimBond(
  taskId: number | null,
  component: string = ESCROW_COMPONENT,
): ClaimBondResult {
  // Tagged by id/component/attempt for the same reason useOnChainTaskInfo
  // tags its state: a stale response must not overwrite a newer request, and
  // must not keep rendering once the caller has moved on to a different task.
  const [state, setState] = useState<{
    id: number | null
    component: string
    bond: string | null
    divisibility: number | null
    settled: "ok" | "error"
  } | null>(null)

  useEffect(() => {
    let live = true
    const read = async (): Promise<{
      bond: string | null
      divisibility: number | null
      settled: "ok" | "error"
    }> => {
      if (!isEscrowDeployed() || taskId == null) {
        return { bond: null, divisibility: null, settled: "ok" }
      }
      const bondParams = await readClaimBondParams(component)
      if (!bondParams) return { bond: null, divisibility: null, settled: "error" }
      const rewardInfo = await readTaskRewardInfo(taskId, component)
      if (!rewardInfo) return { bond: null, divisibility: null, settled: "error" }
      const divisibility = await readTokenDivisibility(rewardInfo.rewardToken)
      if (divisibility === null) return { bond: null, divisibility: null, settled: "error" }
      const bond = requiredBond(
        rewardInfo.rewardAmount,
        bondParams.pct,
        bondParams.floor,
        bondParams.cap,
        divisibility,
      )
      return { bond, divisibility, settled: "ok" }
    }
    read()
      .then((r) => {
        if (live) {
          setState({ id: taskId, component, bond: r.bond, divisibility: r.divisibility, settled: r.settled })
        }
      })
      .catch(() => {
        if (live) setState({ id: taskId, component, bond: null, divisibility: null, settled: "error" })
      })
    return () => {
      live = false
    }
  }, [taskId, component])

  const applicable = isEscrowDeployed() && taskId != null
  const mine = state !== null && state.id === taskId && state.component === component
  const status: ClaimBondStatus = !applicable ? "idle" : mine ? state.settled : "loading"
  return {
    bond: mine ? state.bond : null,
    divisibility: mine ? state.divisibility : null,
    status,
  }
}
