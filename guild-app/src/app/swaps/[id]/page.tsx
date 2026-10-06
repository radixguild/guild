import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { AppShell } from "@/components/app-shell"
import { SwapDetail } from "@/components/swaps/swap-detail"
import { withPageOg } from "@/lib/page-metadata"

// /swaps/[id] — one listing (P7-03 detail, P7-04 Fill / Cancel / Extend /
// Withdraw proceeds). The title is built from the URL parameter only, same
// posture as /tasks/[id]: no chain read for a metadata card, and NFT names
// are a stranger's text. Everything else renders client-side from
// GET /api/v1/swaps/{id} — see swap-detail.tsx.

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const v = decodeURIComponent((await params).id).replace(/[^0-9]/g, "").slice(0, 20) || "?"
  return withPageOg(`/swaps/${v}`, {
    title: `Swap listing ${v} — Radix Guild`,
    description: "An NFT swap listing on the Radix Guild: the NFT, the seller's terms, and its state on the ledger.",
  })
}

export default async function SwapListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // Digits only in the heading: the parameter is a stranger's URL.
  const shown = decodeURIComponent(id).replace(/[^0-9]/g, "").slice(0, 20) || "?"
  return (
    <AppShell>
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        <Link href="/swaps" className="inline-flex items-center gap-1 text-sm text-muted-foreground no-underline hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> All listings
        </Link>
        <h1 className="text-2xl font-semibold">Swap listing {shown}</h1>
        <SwapDetail listingId={id} />
      </div>
    </AppShell>
  )
}
