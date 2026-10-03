import type { Metadata } from "next"
import { withPageOg } from "@/lib/page-metadata"

// A shared link to this route used to unfurl as the homepage. The title is built
// from the URL parameter ONLY — deliberately no database read: task text has a
// public-scrub rule (src/lib/public-task-text.ts) that a metadata fetch would have
// to replicate, and a generic, correct card beats a specific, leaky one.
export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const v = decodeURIComponent((await params).slug).slice(0, 80)
  return withPageOg(`/projects/${encodeURIComponent(v)}`, {
    title: `Project ${v} — Radix Guild`,
    description: "A Radix Guild project: its tasks, what has been paid and what is locked in escrow.",
  })
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
