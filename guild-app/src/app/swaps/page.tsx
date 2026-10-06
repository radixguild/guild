import type { Metadata } from "next"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { SwapBoard } from "@/components/swaps/swap-board"
import { NFT_SWAP_COMPONENT } from "@/lib/config"
import { SWAPS_HEADER, HOW_IT_WORKS, WHAT_THIS_IS_NOT, PROVING_RUN, VERIFY } from "@/content/swaps"
import { withPageOg } from "@/lib/page-metadata"

// /swaps — the NFT swap board (P7-03). The page itself is static and carries
// only the Guild's own copy, so launch-check CHECK 4 scans every sentence of
// it in the prerendered HTML (it is a COLD_ROUTE in scripts/honest-copy.mjs).
// The listings render client-side in <SwapBoard/> from GET /api/v1/swaps,
// which reads the guild-nft-swap component on chain — see swap-board.tsx for
// why stranger-written NFT text stays out of the prerendered page.

export const metadata: Metadata = withPageOg("/swaps", {
  title: "Swaps — Radix Guild",
  description: SWAPS_HEADER.tagline,
});

export default function SwapsPage() {
  return (
    <AppShell>
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">{SWAPS_HEADER.title}</h1>
          <p className="text-muted-foreground">{SWAPS_HEADER.tagline}</p>
        </header>

        <SwapBoard />

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">How a swap works</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-4 text-sm">
                {HOW_IT_WORKS.map((row) => (
                  <div key={row.term} className="space-y-1">
                    <dt className="font-medium">{row.term}</dt>
                    <dd className="text-muted-foreground">{row.detail}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">What this is not</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3 text-sm text-muted-foreground list-disc pl-5">
                {WHAT_THIS_IS_NOT.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{VERIFY.heading}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">{VERIFY.body}</p>
            <dl className="text-xs text-muted-foreground space-y-1">
              <div className="flex gap-2">
                <dt className="shrink-0">Component</dt>
                <dd className="font-mono break-all">{NFT_SWAP_COMPONENT}</dd>
              </div>
              {PROVING_RUN.map((leg) => (
                <div key={leg.leg} className="flex gap-2">
                  <dt className="shrink-0">{leg.leg}</dt>
                  <dd className="font-mono break-all">{leg.txid}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
