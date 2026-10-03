import type { Metadata } from "next"
import { withPageOg } from "@/lib/page-metadata"

// This route"s page is a client component and cannot export metadata, so until
// 2026-09-20 it carried the homepage"s <title> and Open Graph card. See
// src/lib/page-metadata.ts.
export const metadata: Metadata = withPageOg("/fund/create", {
  title: "Open a Funding Pool — Radix Guild",
  description: "Open a community funding pool on Radix Guild.",
})

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
