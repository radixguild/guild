import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { LIST_COPY } from "@/content/swaps"
import { AppShell } from "@/components/app-shell"
import { ListNftForm } from "@/components/swaps/list-nft-form"
import { withPageOg } from "@/lib/page-metadata"

// /swaps/list — "List an NFT" (P7-04). A static shell around a client form:
// the prerendered HTML holds the form's headings and copy for launch-check
// CHECK 4 (a COLD_ROUTE), and the account's NFTs load in the browser.

export const metadata: Metadata = withPageOg("/swaps/list", {
  title: "List an NFT — Radix Guild",
  description: "List one NFT from your Radix account for a fixed price or an NFT swap, settled atomically on the ledger.",
})

export default function ListNftPage() {
  return (
    <AppShell>
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        <Link href="/swaps" className="inline-flex items-center gap-1 text-sm text-muted-foreground no-underline hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> All listings
        </Link>
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">{LIST_COPY.heading}</h1>
          <p className="text-muted-foreground">{LIST_COPY.intro}</p>
        </header>
        <ListNftForm />
      </div>
    </AppShell>
  )
}
