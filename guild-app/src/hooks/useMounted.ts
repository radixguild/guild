"use client"

import { useSyncExternalStore } from "react"

const subscribeNoop = () => () => {}
const getTrue = () => true
const getFalse = () => false

/**
 * False during SSR and the first hydration pass, true after. Gate anything that
 * depends on client-only state (the wallet, the theme) on it, so the server
 * HTML and the first client render agree. useSyncExternalStore's server
 * snapshot is what makes this hydration-safe without an effect.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(subscribeNoop, getTrue, getFalse)
}
