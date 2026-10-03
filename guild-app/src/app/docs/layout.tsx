import type { Metadata } from "next"
import { withPageOg } from "@/lib/page-metadata"

// This route"s page is a client component and cannot export metadata, so until
// 2026-09-20 it carried the homepage"s <title> and Open Graph card. See
// src/lib/page-metadata.ts.
export const metadata: Metadata = withPageOg("/docs", {
  title: "Docs & FAQ — Radix Guild",
  description: "How the task board, the escrow, badges and the optional community votes work, with the main on-chain addresses.",
})

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
