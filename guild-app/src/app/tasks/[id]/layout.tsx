import type { Metadata } from "next"
import { withPageOg } from "@/lib/page-metadata"

// A shared link to this route used to unfurl as the homepage. The title is built
// from the URL parameter ONLY — deliberately no database read: task text has a
// public-scrub rule (src/lib/public-task-text.ts) that a metadata fetch would have
// to replicate, and a generic, correct card beats a specific, leaky one.
export async function generateMetadata(
  { params }: { params: Promise<{ id: string }> },
): Promise<Metadata> {
  const v = decodeURIComponent((await params).id).slice(0, 80)
  return withPageOg(`/tasks/${encodeURIComponent(v)}`, {
    title: `Task #${v} — Radix Guild`,
    description: "A task on the Radix Guild board: its reward, terms and escrow status.",
  })
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
