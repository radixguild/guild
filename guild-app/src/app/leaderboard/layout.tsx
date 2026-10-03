import type { Metadata } from "next"
import { withPageOg } from "@/lib/page-metadata"

// This route"s page is a client component and cannot export metadata, so until
// 2026-09-20 it carried the homepage"s <title> and Open Graph card. See
// src/lib/page-metadata.ts.
export const metadata: Metadata = withPageOg("/leaderboard", {
  title: "Leaderboard — Radix Guild",
  // Said "ranked by XP" until 2026-09-23; the page ranks by reputation
  // (users.ts orders by reputation, then XP) and says so in its own subtitle.
  description: "Guild members ranked by reputation earned from completed tasks.",
})

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
