import { cn } from "@/lib/utils"

// "Need XRD?" pointer, shown under the alerts that tell a user to add XRD
// (fund escrow, claim bond, badge mint). A plain link, not a ramp widget, and it
// carries neither the user's address nor an amount.
//
// KuCoin only since 2026-10-06. The Alchemy Pay link radixdlt.com/token publishes
// opened its ramp on USDT (Tron) whatever crypto=XRD said, and choosing XRD from
// its list fell back to USDT, so "Need XRD?" sent people to buy a different coin.
// Re-add it only after a click-through ends on an XRD purchase. KuCoin: XRD-USDT
// trading and XRD withdrawals to Radix accounts enabled (public API, 2026-10-06).
export const KUCOIN_XRD_URL = "https://www.kucoin.com/trade/XRD-USDT"

export function GetXrdLinks({ className }: { className?: string }) {
  return (
    <p className={cn("mt-1", className)}>
      Need XRD? Buy it on the{" "}
      <a href={KUCOIN_XRD_URL} target="_blank" rel="noopener noreferrer" className="font-medium underline">
        KuCoin
      </a>{" "}
      exchange and withdraw it to this account. KuCoin is a third-party service with its own ID checks, fees and
      country limits.
    </p>
  )
}
