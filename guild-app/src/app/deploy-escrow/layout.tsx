import type { Metadata } from "next"

// Operator tooling. Titled so a tab is identifiable; never indexed.
export const metadata: Metadata = {
  title: "Deploy Escrow (operator) — Radix Guild",
  robots: { index: false, follow: false },
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
