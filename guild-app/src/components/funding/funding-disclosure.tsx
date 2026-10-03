import { Info } from "lucide-react"

/**
 * The one place the community-funding surface says what a pledge is.
 *
 * Written as an exported CONSTANT plus a component, matching
 * network-halt-notice.tsx: the string is the asset, so the honest-copy gate
 * and the unit tests can both read the exact words, and no page can quietly
 * paraphrase them into something softer. Every funding screen renders this —
 * the list, the detail, the create form — because a contributor can land on
 * any of the three first.
 *
 * The claim being guarded: `funding_pools` is an app-layer pledging ledger.
 * The FundingPool Scrypto blueprint it is shaped to reconcile against does
 * not exist (schema/funding-pools.ts's header; funding-state-machine.ts's
 * module doc). A pledge here moves no XRD, locks no XRD, and gives a
 * contributor no on-chain claim on anything. Saying so plainly, on the screen
 * where someone is about to type a number, is the difference between an
 * honest early feature and a promise we cannot keep.
 */
export const FUNDING_LEDGER_NOTICE =
  "A pledge here is a recorded commitment, not a payment. No XRD leaves your wallet, nothing is held on your behalf, and this pool has no on-chain component behind it yet — the pooled figure below is this site's own ledger of who has said they would chip in."

export const FUNDING_SETTLE_NOTICE =
  "When a pool meets its target the poster turns it into a task, and funding it happens the normal way — the poster deposits into escrow at that point. Meeting a target here does not by itself pay anyone."

export function FundingDisclosure({ className = "" }: { className?: string }) {
  return (
    <div
      role="note"
      className={`flex gap-2.5 rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground ${className}`}
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="space-y-1.5">
        <p>{FUNDING_LEDGER_NOTICE}</p>
        <p>{FUNDING_SETTLE_NOTICE}</p>
      </div>
    </div>
  )
}
