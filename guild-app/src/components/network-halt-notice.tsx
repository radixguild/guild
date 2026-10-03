"use client"

import { AlertOctagon } from "lucide-react"
import { useNetworkHalt } from "@/hooks/useNetworkHalt"
import { TG_GROUP_HANDLE } from "@/lib/config"

// The halt-era copy, in ONE place — same convention as posting-paused-notice.
// This renders only after a client fetch resolves, so neither launch-check
// CHECK 4 nor the cold-user SSR sweep can see it; the honest-copy gate over
// these strings is the unit test (tests/unit/network-halt-notice.test.tsx).
// Add any new halt-era sentence HERE, never inline in a page, or it ships
// unscanned.
//
// WHY THIS EXISTS AT ALL. On 2026-08-31 Radix mainnet stopped at state version
// 557840622 and stayed there. For the whole of that outage this site said
// nothing: a cold visitor could read the pitch, connect a wallet and watch
// every transaction fail with no explanation offered. A marketplace that
// custodies other people's money should be able to say "the chain is stopped"
// out loud, and should be able to say it without a rebuild.

/** Chain stopped: the tip has not advanced. Nothing we sign can land. */
export const NETWORK_HALTED_NOTICE =
  "Radix mainnet is not producing new transactions right now, so nothing can be signed, funded, claimed or withdrawn. The board is readable and every task's on-chain state is unchanged — wallet actions will start working again when the network resumes."

/** Operator lever: we paused parts of this site, the chain did not stop.
 *
 *  ⚠️ Until 2026-09-24 this said "We have paused wallet actions here". The
 *  lever (GUILD_HALT → chainWriteGate) gates this site's API writes only. The
 *  wallet buttons build their manifests in the browser and never read it, so
 *  claim, submit, approve and collect still reach the chain while it is on —
 *  and every escrow deadline keeps running. The copy says only what is true. */
export const OPERATOR_HALT_NOTICE =
  `We have paused parts of this site while we check something. The escrow is unaffected and its deadlines still apply. Updates are in the Guild group, ${TG_GROUP_HANDLE}.`

/** Beside any instruction that sends a reader to the Telegram bot. The bot is
 *  stopped for the duration of a halt (its watchers would only hammer a stalled
 *  Gateway), so "type /register" needs this next to it while the chain is
 *  down — and it must disappear on its own when the chain resumes, which is
 *  why it is a component over useNetworkHalt and not a sentence in a page. */
export const BOT_PAUSED_NOTICE =
  "The Telegram bot is paused while Radix mainnet is halted, so bot commands will not answer until the network resumes. The dashboard stays readable."
export function BotPausedNote({ className = "" }: { className?: string }) {
  const { halted } = useNetworkHalt()
  if (halted !== true) return null
  return (
    <p role="note" className={`text-xs text-red-600 dark:text-red-400 ${className}`}>
      {BOT_PAUSED_NOTICE}
    </p>
  )
}
/** Appended when the tip figures are a re-served last-known value. */
export const HALT_STALE_DETAIL =
  "We cannot currently reach the Radix Gateway either, so this reads the last ledger position we saw — treat the timing as approximate."

function formatAge(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes`
  const hours = Math.floor(seconds / 3600)
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`
  return `${Math.floor(hours / 24)} days`
}

/**
 * Sitewide incident banner. Renders nothing unless we affirmatively know the
 * network is halted or the operator lever is on — `halted: null` (unknown, or
 * still loading) renders nothing, by design. See useNetworkHalt.
 */
export function NetworkHaltNotice() {
  const { halted, operatorHalt, stale, ageSeconds, stateVersion } = useNetworkHalt()
  if (halted !== true) return null

  return (
    <div
      role="alert"
      className="border-b border-red-500/30 bg-red-500/10 px-4 py-2.5 text-xs text-red-600 dark:text-red-400"
    >
      <div className="mx-auto flex max-w-6xl items-start gap-2">
        <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div className="space-y-1">
          <p>
            {operatorHalt ? OPERATOR_HALT_NOTICE : NETWORK_HALTED_NOTICE}
            {stale ? ` ${HALT_STALE_DETAIL}` : ""}
          </p>
          {!operatorHalt && ageSeconds !== null && stateVersion !== null && (
            <p className="font-mono text-[11px] opacity-80">
              Ledger stopped at state version {stateVersion.toLocaleString("en-US")},{" "}
              {formatAge(ageSeconds)} ago. Check it yourself against any Radix
              Gateway or explorer.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
