"use client"

import { useEffect, useState } from "react"
import { apiFetch } from "@/lib/api-fetch"

export interface NetworkHaltState {
  /** null = unknown or still loading. Callers fail OPEN on null. */
  halted: boolean | null
  /** True when the operator lever is on rather than the chain being stopped. */
  operatorHalt: boolean
  /** True when the tip figures are a re-served last-known value. */
  stale: boolean
  /** Age of the ledger tip in seconds, or null when never read. */
  ageSeconds: number | null
  stateVersion: number | null
}

const UNKNOWN: NetworkHaltState = {
  halted: null,
  operatorHalt: false,
  stale: false,
  ageSeconds: null,
  stateVersion: null,
}

/** How often the banner re-checks. A halt is a minutes-scale event and the
 *  server read is cached for ten seconds, so a minute is plenty and keeps an
 *  idle tab from hammering the route. */
const POLL_MS = 60_000

/**
 * Sitewide network-liveness state, polled from the server-side probe.
 *
 * Fails OPEN: `halted` stays null on any fetch or shape failure, and every
 * consumer must render the normal affordance on null. Inventing a halt notice
 * from a transient error is worse than briefly missing one — a banner that
 * cries wolf gets removed, and then there is no banner at all.
 */
export function useNetworkHalt(): NetworkHaltState {
  const [state, setState] = useState<NetworkHaltState>(UNKNOWN)

  useEffect(() => {
    let cancelled = false
    const read = () => {
      apiFetch("/api/v1/network/status")
        .then((res) => res.json())
        .then((body) => {
          if (cancelled || !body?.ok || !body.data) return
          const d = body.data
          setState({
            halted: typeof d.halted === "boolean" ? d.halted : null,
            operatorHalt: d.operatorHalt === true,
            stale: d.stale === true,
            ageSeconds: typeof d.ageSeconds === "number" ? d.ageSeconds : null,
            stateVersion: typeof d.stateVersion === "number" ? d.stateVersion : null,
          })
        })
        .catch(() => {}) // fail open — see above
    }
    read()
    const timer = setInterval(read, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return state
}
