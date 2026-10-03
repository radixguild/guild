import { cn } from "@/lib/utils"

// "Need XRD?" pointer, shown under the alerts that tell a user to add XRD
// (fund escrow, claim bond, badge mint). Plain links, not a ramp widget:
// Alchemy Pay's embedded widget needs a merchant KYB and server-signed URLs,
// and neither link carries the user's address or an amount.
//
// ALCHEMY_PAY_XRD_URL is the exact link radixdlt.com/token publishes (checked
// 2026-09-30). Alchemy Pay is buy-only for XRD. KuCoin had XRD-USDT trading
// and XRD withdrawals to Radix accounts enabled on the same day (public API).
export const ALCHEMY_PAY_XRD_URL = "https://ramp.alchemypay.org/?appId=qjpmy9BwBPRGBneF&crypto=XRD#/index"
export const KUCOIN_XRD_URL = "https://www.kucoin.com/trade/XRD-USDT"

export function GetXrdLinks({ className }: { className?: string }) {
  return (
    <p className={cn("mt-1", className)}>
      Need XRD? Buy it with a card or bank transfer on{" "}
      <a href={ALCHEMY_PAY_XRD_URL} target="_blank" rel="noopener noreferrer" className="font-medium underline">
        Alchemy Pay
      </a>
      , or on the{" "}
      <a href={KUCOIN_XRD_URL} target="_blank" rel="noopener noreferrer" className="font-medium underline">
        KuCoin
      </a>{" "}
      exchange and withdraw it to this account. Both are third-party services with their own ID checks, fees and
      country limits.
    </p>
  )
}
