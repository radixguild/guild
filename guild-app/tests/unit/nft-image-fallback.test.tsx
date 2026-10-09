/**
 * NftImage's collection-icon fallback (bigdev, 2026-10-07: "can we put images
 * to all our NFTs"). An NFT with no `key_image_url` shows its collection's
 * `icon_url` instead, labelled as the collection's icon; a picture that fails
 * to load gives way to the next one; with neither, the no-image placeholder.
 * The four call sites (board card, listing page, NFT asks, List picker) pass
 * the resource icon from the display data the server already reads, and a
 * hidden listing passes none.
 */
import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { NftImage, pickNftImage } from "@/components/swaps/swap-bits"

afterEach(cleanup)

const NFT_PIC = "https://example.org/nft-7.png"
const ICON = "https://example.org/collection-icon.png"

describe("pickNftImage", () => {
  it("prefers the NFT's own image, then the collection icon, then none", () => {
    const none = new Set<string>()
    expect(pickNftImage(NFT_PIC, ICON, none)).toEqual({ url: NFT_PIC, source: "nft" })
    expect(pickNftImage(null, ICON, none)).toEqual({ url: ICON, source: "collection" })
    expect(pickNftImage(null, null, none)).toBeNull()
  })

  it("skips a URL that already failed to load", () => {
    expect(pickNftImage(NFT_PIC, ICON, new Set([NFT_PIC]))).toEqual({ url: ICON, source: "collection" })
    expect(pickNftImage(NFT_PIC, ICON, new Set([NFT_PIC, ICON]))).toBeNull()
  })
})

describe("NftImage", () => {
  it("shows the collection icon, labelled as such, when the NFT has no image", () => {
    render(<NftImage src={null} fallbackSrc={ICON} alt="Guild badge #3#" />)
    const img = screen.getByRole("img", { name: "Guild badge #3# (collection icon)" })
    expect(img).toHaveAttribute("src", ICON)
    expect(img).toHaveAttribute("data-image-source", "collection")
    expect(img).toHaveAttribute("referrerpolicy", "no-referrer")
  })

  it("shows the NFT's own image when it has one, under its own name", () => {
    render(<NftImage src={NFT_PIC} fallbackSrc={ICON} alt="Guild badge #3#" />)
    const img = screen.getByRole("img", { name: "Guild badge #3#" })
    expect(img).toHaveAttribute("src", NFT_PIC)
    expect(img).toHaveAttribute("data-image-source", "nft")
  })

  it("falls back to the icon when the NFT's image fails, then to the placeholder", () => {
    render(<NftImage src={NFT_PIC} fallbackSrc={ICON} alt="Guild badge #3#" />)
    fireEvent.error(screen.getByRole("img", { name: "Guild badge #3#" }))
    const icon = screen.getByRole("img", { name: "Guild badge #3# (collection icon)" })
    expect(icon).toHaveAttribute("src", ICON)
    fireEvent.error(icon)
    expect(screen.getByRole("img", { name: "Guild badge #3# — no image" })).toBeInTheDocument()
  })

  it("with neither picture, shows the no-image placeholder", () => {
    render(<NftImage src={null} alt="Guild badge #3#" />)
    expect(screen.getByRole("img", { name: "Guild badge #3# — no image" })).toBeInTheDocument()
  })
})

describe("the call sites pass the collection icon", () => {
  const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8")

  it("board card and listing page: the asset's resource icon, none for a hidden listing", () => {
    expect(src("src/components/swaps/swap-board.tsx")).toContain(
      "fallbackSrc={l.hidden ? null : (board.resources[l.assetResource]?.iconUrl ?? null)}",
    )
    expect(src("src/components/swaps/swap-detail.tsx")).toContain(
      "fallbackSrc={l.hidden ? null : (view.resources[l.assetResource]?.iconUrl ?? null)}",
    )
  })

  it("NFT asks and the List picker: the ask's and the holding's resource icon", () => {
    expect(src("src/components/swaps/swap-detail.tsx")).toContain("fallbackSrc={view.resources[ask.resource]?.iconUrl ?? null}")
    expect(src("src/components/swaps/list-nft-form.tsx")).toContain("fallbackSrc={r?.iconUrl ?? null}")
  })
})
