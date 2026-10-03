"use client"

import { Info } from "lucide-react"
import { isEscrowDeployed } from "@/lib/config"

// The escrow-off explainer, in ONE place — same convention as
// posting-paused-notice.tsx and network-halt-notice.tsx: add any new sentence
// about this state HERE, never inline in a page, or it ships unscanned.
//
// WHY THIS EXISTS. NEXT_PUBLIC_FEATURE_ESCROW defaults to false in both
// .env.example (the committed default) and src/lib/features.ts (the code
// default when the var is unset) — so a fresh clone or a self-hosted deploy
// that has not set it renders a marketplace with every money-moving button
// silently gone: all eleven isEscrowDeployed() guards in escrow-actions.tsx
// return null (deposit, claim, submit, approve, cancel, raise/finalize
// dispute, withdraw, push-entitlement, resync, expire-claim), and every
// helper in escrow-utils.ts fails closed with {ok:false, error:"Escrow not
// deployed"}. That is the CORRECT behaviour — it is not the deployed
// blueprint's job to pretend a component exists — but it left nothing on
// screen to say so. A stranger just sees a board with no way to act on it.
//
// This component does not gate anything and does not flip the flag (that
// stays operator-only, in .env.local + a rebuild); it only names the state
// out loud, the same way NetworkHaltNotice names a halted chain and
// PostingPausedNotice names a funding freeze.

export const ESCROW_DISABLED_NOTICE =
  "On-chain escrow is off in this build (NEXT_PUBLIC_FEATURE_ESCROW is not set to true), so funding, claiming, submitting, approving, cancelling, disputing and withdrawing are all switched off — those buttons don't render at all here. Posting and browsing tasks still works. An operator turns this on by pointing NEXT_PUBLIC_FEATURE_ESCROW=true at a deployed escrow component and rebuilding."

export function EscrowDisabledNotice({ className = "" }: { className?: string }) {
  if (isEscrowDeployed()) return null
  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-600 dark:text-blue-400 ${className}`}
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{ESCROW_DISABLED_NOTICE}</span>
    </div>
  )
}
