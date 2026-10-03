import type { Metadata } from "next"
import { withPageOg } from "@/lib/page-metadata"

// This route"s page is a client component and cannot export metadata, so until
// 2026-09-20 it carried the homepage"s <title> and Open Graph card. See
// src/lib/page-metadata.ts.
export const metadata: Metadata = withPageOg("/about", {
  title: "About — Radix Guild",
  description: "Who builds and runs Radix Guild, what is on-chain and checkable, and what is not.",
})

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
