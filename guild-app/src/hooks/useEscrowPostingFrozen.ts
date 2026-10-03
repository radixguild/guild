"use client"

import { useEffect, useState } from "react"
import { apiFetch } from "@/lib/api-fetch"

/**
 * Whether XRD posting is frozen on the live escrow, read once per mount from
 * the server-side probe (which does the actual chain read, short-cached).
 *
 * `null` = unknown OR still loading — callers fail OPEN and render the normal
 * affordance: a transient read failure must not fabricate a "posting paused"
 * notice, and the on-chain assert remains the backstop if a frozen tx does
 * reach the wallet. Only `true` gates anything.
 */
export function useEscrowPostingFrozen(): boolean | null {
  const [frozen, setFrozen] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    apiFetch("/api/v1/escrow/posting-status")
      .then((res) => res.json())
      .then((body) => {
        if (!cancelled && body?.ok && typeof body.data?.frozen === "boolean") {
          setFrozen(body.data.frozen)
        }
      })
      .catch(() => {}) // fail open — see above
    return () => {
      cancelled = true
    }
  }, [])
  return frozen
}
