"use client"

// Small pieces shared by the swap board, the listing page and the List form.

import { useCallback, useRef, useState } from "react"
import { ImageOff } from "lucide-react"
import { useWallet } from "@/hooks/useWallet"
import { humanizeTxError, type HumanizedTxError } from "@/lib/escrow-utils"
import { formatAmount, shortAddress, type SwapAsk, type SwapStatus } from "@/lib/nft-swap"
import type { SwapResourceView } from "@/lib/nft-swap-service"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const DASHBOARD = "https://dashboard.radixdlt.com"
export const dashboardTx = (txId: string) => `${DASHBOARD}/transaction/${txId}`
export const dashboardEntity = (address: string) => {
  const kind = address.startsWith("account_")
    ? "account"
    : address.startsWith("resource_")
      ? "resource"
      : "component"
  return `${DASHBOARD}/${kind}/${address}`
}

/**
 * An NFT picture from the NFT's own metadata. A plain <img>, on purpose:
 * next/image would have the SERVER fetch whatever URL a stranger minted into
 * their NFT (and need every host allow-listed). Here the viewer's browser
 * loads it, without a referrer, under the site's CSP (img-src https:), and
 * only after safeImageUrl() accepted it as https.
 */
export function NftImage({ src, alt, className }: { src: string | null; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return (
      <div
        className={cn("flex items-center justify-center bg-muted text-muted-foreground", className)}
        aria-label={`${alt} — no image`}
        role="img"
      >
        <ImageOff className="h-6 w-6" />
      </div>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn("bg-muted object-cover", className)}
    />
  )
}

const STATUS_LABEL: Record<SwapStatus, string> = {
  open: "Open",
  expired: "Expired",
  filled: "Filled",
  cancelled: "Cancelled",
}

export function SwapStatusBadge({ status }: { status: SwapStatus }) {
  return (
    <Badge variant={status === "open" ? "default" : status === "filled" ? "secondary" : "outline"}>
      {STATUS_LABEL[status]}
    </Badge>
  )
}

/** "5,000 XRD" / "1 × Wefty V2 #12#" — the full address stays in the title. */
export function askText(ask: SwapAsk, resources: Record<string, SwapResourceView>): string {
  const r = resources[ask.resource]
  if (ask.kind === "fungible") {
    const unit = r?.symbol ?? r?.name ?? shortAddress(ask.resource)
    return `${formatAmount(ask.amount)} ${unit}`
  }
  const coll = r?.name ?? shortAddress(ask.resource)
  return `NFT ${ask.id} of ${coll}`
}

/** The first alternative, plus "or N more". */
export function askSummary(asks: SwapAsk[], resources: Record<string, SwapResourceView>): string {
  if (asks.length === 0) return "—"
  const first = askText(asks[0], resources)
  return asks.length === 1 ? first : `${first} or ${asks.length - 1} more`
}

/** "in 3 days" / "2 hours ago", against the LEDGER clock the API reported. */
export function relativeTime(targetSecs: number, ledgerNowSecs: number): string {
  const d = targetSecs - ledgerNowSecs
  const abs = Math.abs(d)
  const unit =
    abs >= 86400 ? [Math.round(abs / 86400), "day"] : abs >= 3600 ? [Math.round(abs / 3600), "hour"] : [Math.max(1, Math.round(abs / 60)), "minute"]
  const s = `${unit[0]} ${unit[1]}${unit[0] === 1 ? "" : "s"}`
  return d >= 0 ? `in ${s}` : `${s} ago`
}

export const utcStamp = (secs: number) =>
  new Date(secs * 1000).toISOString().replace("T", " ").replace(/:\d\d\.\d{3}Z$/, " UTC")

/**
 * Send one swap transaction from the connected account. Same contract as the
 * escrow buttons: a synchronous re-entry guard (disabled={busy} alone leaves
 * a batching window where a second click sends a second transaction), and
 * every outcome is reported — the wallet result's own error goes through
 * humanizeSwapTxError, so a request that never reached the wallet says so.
 * One instance per page: the guard only holds across the buttons that share it.
 */
export function useSwapTx() {
  const { account, rdt } = useWallet()
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [txId, setTxId] = useState<string | null>(null)

  const send = useCallback(
    async (build: (account: string) => string): Promise<string | null> => {
      if (inFlight.current) return null
      if (!account || !rdt) {
        setError("Connect your Radix Wallet first.")
        return null
      }
      inFlight.current = true
      setBusy(true)
      setError(null)
      setTxId(null)
      try {
        const manifest = build(account)
        const result = await rdt.walletApi.sendTransaction({ transactionManifest: manifest, version: 1 })
        if (result.isOk()) {
          const { transactionIntentHash, status } = result.value
          setTxId(transactionIntentHash)
          // RDT resolves ok once the transaction reaches a final status; only
          // CommittedSuccess means the swap call ran. Anything else is shown,
          // with the transaction link, rather than read as done.
          if (status !== "CommittedSuccess") {
            setError(`The transaction reached the ledger but did not succeed (${status}). Nothing it asked for happened; the network fee may have been spent.`)
            return null
          }
          return transactionIntentHash
        }
        setError(JSON.stringify(result.error))
        return null
      } catch (e) {
        setError(e instanceof Error ? e.message : "Transaction failed")
        return null
      } finally {
        inFlight.current = false
        setBusy(false)
      }
    },
    [account, rdt],
  )

  const reset = useCallback(() => {
    setError(null)
    setTxId(null)
  }, [])

  return { account, connected: Boolean(account && rdt), send, busy, error, txId, reset }
}

export type SwapTx = ReturnType<typeof useSwapTx>

/** The blueprint's own refusals (nft_swap.rs assert/panic text, which the
 *  engine carries into the error), in words. First match wins, so the more
 *  specific line sits above the shorter one it contains. Only refusals this
 *  site's own manifests can reach are here: the ones they rule out by
 *  construction (one escrowed NFT, the component's receipt resource, an
 *  alternative index from the rendered listing) fall through to the generic
 *  line with the raw detail kept, rather than as copy nobody can trigger. */
const SWAP_REFUSALS: readonly [RegExp, string][] = [
  [/listing is not Listed/, "This listing is no longer open: it was filled or cancelled before your transaction ran. Nothing changed hands. Reload the page to see where it stands."],
  [/listing is not Filled/, "This listing has not been filled, so there are no proceeds to withdraw. Nothing changed hands."],
  [/listing has expired/, "This listing passed its expiry before your fill ran, so it can no longer be filled. Nothing changed hands."],
  [/payment (resource|amount|NFT id) does not match|payment must be exactly the one NFT/, "The payment did not match the alternative you picked, so the component refused it. Nothing changed hands. Reload the page and pick again."],
  [/proceeds already withdrawn/, "These proceeds were already withdrawn, to the account the listing pays. Nothing changed hands."],
  [/cannot burn the receipt while the listing is still Listed/, "The receipt cannot be burned while the listing is still listed. Cancel the listing first."],
  [/cannot burn the receipt while proceeds are still owed/, "The receipt cannot be burned while proceeds are still owed. Withdraw them first."],
  [/expires_at must be/, "The component refused the expiry: it must be in the future and at most thirty days out on the ledger clock. Nothing was listed. Pick the term again."],
]

const SWAP_NFT_MISSING =
  "This account does not hold the NFT this transaction withdraws (the listing receipt, or the NFT offered as payment), so nothing changed hands."
const SWAP_BALANCE =
  "This account does not hold enough for this transaction: the payment it sends, or XRD for the fees. Nothing changed hands."
const SWAP_FAILED = "The transaction failed and nothing changed hands. Open the error details below."

/**
 * A raw wallet/engine error, in words for a swap page. The task humanizer
 * (humanizeTxError) is used for what is not about tasks: the wallet-transport
 * outcomes and its neutral fallback. Its signature lines speak of tasks and
 * promise a resync this page does not run, so a swap meaning of the same
 * engine error is matched here first, and any staleState line it still
 * returns is replaced.
 */
export function humanizeSwapTxError(raw: string): Omit<HumanizedTxError, "staleState"> {
  for (const [pattern, summary] of SWAP_REFUSALS) if (pattern.test(raw)) return { summary, detail: raw }
  if (/NonFungible(Vault)?Error.*Missing|MissingNonFungible/i.test(raw)) return { summary: SWAP_NFT_MISSING, detail: raw }
  // Same guard as humanizeTxError: a WorktopError is a manifest fault, not
  // the account's balance. Its "add XRD" wording does not fit here — a fill
  // can withdraw any token the seller asked for.
  if (!/WorktopError/i.test(raw) && /InsufficientBalance/i.test(raw)) return { summary: SWAP_BALANCE, detail: raw }
  const h = humanizeTxError(raw)
  if (h.staleState) return { summary: SWAP_FAILED, detail: raw }
  return h.detail === undefined ? { summary: h.summary } : { summary: h.summary, detail: h.detail }
}

export function TxErrorLine({ error }: { error: string | null }) {
  if (!error) return null
  const h = humanizeSwapTxError(error)
  return (
    <div className="space-y-1 text-xs" role="alert">
      <p className="text-destructive">{h.summary}</p>
      {h.detail && (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer select-none">Error details</summary>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[10px]">
            {h.detail}
          </pre>
        </details>
      )}
    </div>
  )
}

export function TxDoneLine({ txId, children }: { txId: string | null; children: React.ReactNode }) {
  if (!txId) return null
  return (
    <p className="text-xs text-muted-foreground" role="status">
      {children}{" "}
      <a href={dashboardTx(txId)} target="_blank" rel="noopener noreferrer" className="text-primary underline">
        View transaction
      </a>
    </p>
  )
}

/** A full address, monospaced and breakable, linked to the Dashboard. */
export function AddressLink({ address, className }: { address: string; className?: string }) {
  return (
    <a
      href={dashboardEntity(address)}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("font-mono text-xs break-all underline-offset-4 hover:underline", className)}
    >
      {address}
    </a>
  )
}
