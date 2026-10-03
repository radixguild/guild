import type { Metadata } from "next"
import Link from "next/link"
import { AppShell } from "@/components/app-shell"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { NFT_SWAP_COMPONENT } from "@/lib/config"
import {
  SWAPS_HEADER,
  HOW_IT_WORKS,
  WHAT_THIS_IS_NOT,
  PROVING_RUN,
  STATUS,
} from "@/content/swaps"
import { withPageOg } from "@/lib/page-metadata";

// /swaps — the NFT swap landing page. A PLACEHOLDER by design: the component
// is live on mainnet, the listing UI is not built, and this page says so
// rather than 404-ing a visitor who followed the P7 project card. Board task
// 92 (catalogue P7-03) replaces this file with the DB-backed grid; board task
// 93 (P7-05) adds the headless legs. Registered as a COLD_ROUTE in
// scripts/honest-copy.mjs in this same commit — a server component with no
// client-fetched claims, so everything the gate scans is in the SSR'd HTML.

export const metadata: Metadata = withPageOg("/swaps", {
  title: "Swaps — Radix Guild",
  description: SWAPS_HEADER.tagline,
});

export default function SwapsPage() {
  return (
    <AppShell>
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        <header className="space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-semibold">{SWAPS_HEADER.title}</h1>
            <Badge variant="outline">Listing UI not built yet</Badge>
          </div>
          <p className="text-muted-foreground">{SWAPS_HEADER.tagline}</p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{STATUS.heading}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>{STATUS.live}</p>
            <p>{STATUS.notBuilt}</p>
            <p>
              {STATUS.tracked}{" "}
              <Link href="/tasks/92" className="underline underline-offset-4">
                Task 92
              </Link>{" "}
              builds this page from real listings;{" "}
              <Link href="/tasks/93" className="underline underline-offset-4">
                task 93
              </Link>{" "}
              adds the headless legs. Both sit under{" "}
              <Link href="/projects" className="underline underline-offset-4">
                project P7
              </Link>
              .
            </p>
            <dl className="pt-1 text-xs text-muted-foreground space-y-1">
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
    </AppShell>
  )
}
