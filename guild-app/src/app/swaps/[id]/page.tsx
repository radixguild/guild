import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { AppShell } from "@/components/app-shell"
import { SwapDetail } from "@/components/swaps/swap-detail"
import { withPageOg } from "@/lib/page-metadata"

// /swaps/[id] — one listing (P7-03 detail, P7-04 Fill / Cancel / Extend /
// Withdraw proceeds). The title and the eyebrow are built from the URL
// parameter only, same posture as /tasks/[id]: no chain read for a metadata
// card, and NFT names are a stranger's text, so they stay out of the
// prerendered HTML and the metadata (launch-check CHECK 4 scans both).
// Everything else renders client-side from GET /api/v1/swaps/{id}: the NFT's
// name is the page's heading, and the tab title switches to it once the
// listing has loaded — see swap-detail.tsx.

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const v = decodeURIComponent((await params).id).replace(/[^0-9]/g, "").slice(0, 20) || "?"
  return withPageOg(`/swaps/${v}`, {
    title: `Listing #${v} · NFT swap — Radix Guild`,
    description: "An NFT swap listing on the Radix Guild: the NFT, the seller's terms, and its state on the ledger.",
  })
}

export default async function SwapListingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ listed?: string }>
}) {
  const { id } = await params
  // `?listed=1` is set by /swaps/list after the viewer's own list transaction:
  // the page then retries a "no such listing" read for a few seconds, because a
  // Gateway read can trail the node the wallet confirmed against.
  const justListed = (await searchParams).listed === "1"
  // Digits only in the label: the parameter is a stranger's URL.
  const shown = decodeURIComponent(id).replace(/[^0-9]/g, "").slice(0, 20) || "?"
  return (
    <AppShell>
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        <Link href="/swaps" className="inline-flex items-center gap-1 text-sm text-muted-foreground no-underline hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> All listings
        </Link>
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">Listing #{shown}</p>
          <SwapDetail listingId={id} justListed={justListed} />
        </div>
      </div>
    </AppShell>
  )
}
