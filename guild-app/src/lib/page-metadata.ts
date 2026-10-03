import type { Metadata } from "next"

/**
 * Per-page Open Graph / Twitter metadata.
 *
 * WHY THIS EXISTS (2026-09-20, from a site-wide audit). Next.js does not MERGE a
 * child page's metadata into the parent's `openGraph` object — a page that sets
 * only `title` and `description` inherits the root layout's `openGraph`
 * wholesale, including its `title`, `description` and `url: "/"`. So every page
 * except /guide announced itself to Telegram, Discord and X as the homepage:
 * a link to /disputes or /tasks/99 unfurled as "Radix Guild — Task Marketplace"
 * pointing at "/". /guide was right only because it restated the whole block by
 * hand. This does that restating once.
 *
 * It also sets `alternates.canonical`, which no page had.
 */

// The card image URL carries the first 10 hex of the PNG's SHA-256.
//
// WHY (2026-09-20): Telegram caches a preview IMAGE by its URL, separately from the page's
// title and text. public/og-image.png was a blank gradient for months (see
// tests/unit/og-image.test.ts) and was then fixed IN PLACE — same URL — so Telegram kept
// serving the blank one. @WebpageBot refreshed the title and description in front of the
// operator and the image stayed blank: the server was sending the right bytes (verified with
// Telegram's own user agent), Telegram simply never asked again. A new URL is the only thing
// that makes it ask. tests/unit/page-metadata-coverage.test.ts recomputes the hash, so
// re-rendering the PNG without bumping this fails CI instead of shipping a stale card.
export const OG_IMAGE_VERSION = "a7e6cefa58"
export const OG_IMAGE_URL = `/og-image.png?v=${OG_IMAGE_VERSION}`

const OG_IMAGE = {
  url: OG_IMAGE_URL,
  width: 1200,
  height: 630,
  alt: "Radix Guild — task marketplace for the Radix community, funded in on-chain escrow",
}

type PageMeta = Metadata & { title: string; description: string }

/** `meta` plus the openGraph/twitter/canonical block that matches it, for `path`. */
export function withPageOg(path: string, meta: PageMeta): Metadata {
  return {
    ...meta,
    alternates: { canonical: path, ...meta.alternates },
    openGraph: {
      type: "website",
      siteName: "Radix Guild",
      title: meta.title,
      description: meta.description,
      url: path,
      images: [OG_IMAGE],
      ...meta.openGraph,
    },
    twitter: {
      card: "summary_large_image",
      title: meta.title,
      description: meta.description,
      images: [OG_IMAGE.url],
      ...meta.twitter,
    },
  }
}
