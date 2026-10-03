import type { Metadata } from "next"
import { withPageOg } from "@/lib/page-metadata"

// The page is a client component and cannot export metadata; see src/lib/page-metadata.ts.
export const metadata: Metadata = withPageOg("/link-telegram", {
  title: "Link Telegram — Radix Guild",
  description: "Prove your wallet to the Guild's Telegram bot so /verify can vouch for it.",
})

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
