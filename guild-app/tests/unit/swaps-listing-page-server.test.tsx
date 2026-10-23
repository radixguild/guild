// /swaps/[id] — what the SERVER sends. The listing's NFT name is written by a
// stranger, so it must never reach the prerendered HTML or the metadata (the
// deploy-time copy gate, launch-check CHECK 4, scans both). The server sends a
// small "Listing #n" label and a "Listing #n · NFT swap" title built from the URL
// parameter alone; the NFT's name is the page's heading, rendered client-side by
// SwapDetail after the chain read (tests/unit/swap-ui-rules.test.tsx).
import { describe, it, expect, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("@/components/app-shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }))
vi.mock("@/components/swaps/swap-detail", () => ({ SwapDetail: () => <div data-testid="detail" /> }))

import SwapListingPage, { generateMetadata } from "@/app/swaps/[id]/page"

const params = (id: string) => ({ params: Promise.resolve({ id }) })

describe("/swaps/[id] server output", () => {
  it("titles the page 'Listing #n · NFT swap' from the URL parameter", async () => {
    const m = await generateMetadata(params("7"))
    expect(m.title).toBe("Listing #7 · NFT swap — Radix Guild")
    expect(m.openGraph?.title).toBe("Listing #7 · NFT swap — Radix Guild")
  })

  it("keeps digits only, whatever the URL says", async () => {
    expect((await generateMetadata(params("7%3Cscript%3E"))).title).toBe("Listing #7 · NFT swap — Radix Guild")
    expect((await generateMetadata(params("abc"))).title).toBe("Listing #? · NFT swap — Radix Guild")
  })

  it("renders a small label and no h1 (the NFT name is the client-rendered heading)", async () => {
    const html = renderToStaticMarkup(
      await SwapListingPage({ ...params("7"), searchParams: Promise.resolve({}) }),
    )
    expect(html).toContain("Listing #7")
    expect(html).not.toMatch(/<h1/)
    expect(html).not.toContain("Swap listing")
  })
})
