import type { Metadata } from "next"
import { withPageOg } from "@/lib/page-metadata"

// This route"s page is a client component and cannot export metadata, so until
// 2026-09-20 it carried the homepage"s <title> and Open Graph card. See
// src/lib/page-metadata.ts.
export const metadata: Metadata = withPageOg("/fund", {
  title: "Community Funding — Radix Guild",
  description: "Funding pools on Radix Guild: what they are and their current state.",
})

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
