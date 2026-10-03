import { describe, it, expect, vi } from "vitest"
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, relative, dirname } from "node:path"
import { createHash } from "node:crypto"
import { OG_IMAGE_URL, OG_IMAGE_VERSION, withPageOg } from "@/lib/page-metadata"
import sitemap from "@/app/sitemap"

/**
 * Next.js does not merge a child's metadata into the parent's `openGraph`
 * object, so until 2026-09-20 every page except /guide unfurled on Telegram,
 * Discord and X as the HOMEPAGE (og:title, og:description and og:url "/"), and
 * 11 client-rendered routes — /tasks and /projects among them — carried the
 * homepage's <title> as well. Nothing could see it: the pages rendered fine.
 * This pins that every public route declares its own card.
 */

const APP = join(process.cwd(), "src", "app")

const pages = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return ["api", "admin", "(auth)"].includes(name) ? [] : pages(p)
    return name === "page.tsx" ? [p] : []
  })

// Pure redirects (no card of their own) and the root, whose card IS the default.
const EXEMPT = new Set(["/", "/start", "/how-it-works"])

const routeOf = (file: string) => "/" + relative(APP, dirname(file)).split("\\").join("/")
const declaresCard = (src: string) => /withPageOg\(|openGraph\s*:/.test(src)

describe("every public route declares its own Open Graph card", () => {
  const files = pages(APP)

  it("walks a real tree (vacuous-pass guard)", () => {
    expect(files.length).toBeGreaterThan(25)
  })

  it("via the page's metadata, or a sibling layout.tsx for client components", () => {
    const missing = files
      .map((f) => ({ route: routeOf(f) === "/." ? "/" : routeOf(f), f }))
      .filter(({ route }) => !EXEMPT.has(route) && route !== "/deploy-escrow")
      .filter(({ f }) => {
        if (declaresCard(readFileSync(f, "utf8"))) return false
        // Nearest layout wins, so walk UP — but stop before the root layout, whose
        // card is the homepage's and is exactly what must not be inherited.
        for (let d = dirname(f); d !== APP; d = dirname(d)) {
          const layout = join(d, "layout.tsx")
          if (existsSync(layout) && declaresCard(readFileSync(layout, "utf8"))) return false
        }
        return true
      })
      .map(({ route }) => route)
    expect(missing).toEqual([])
  })

  it("a static route's card names ITS OWN path, not another route's", () => {
    const wrong: string[] = []
    for (const f of files) {
      const route = routeOf(f)
      if (route.includes("[")) continue
      for (const candidate of [f, join(dirname(f), "layout.tsx")]) {
        if (!existsSync(candidate)) continue
        const m = readFileSync(candidate, "utf8").match(/withPageOg\("([^"]+)"/)
        if (m && m[1] !== route) wrong.push(`${route} declares ${m[1]}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it("the operator page is titled but never indexed", () => {
    expect(readFileSync(join(APP, "deploy-escrow", "layout.tsx"), "utf8")).toMatch(/index:\s*false/)
  })
})

describe("withPageOg", () => {
  const meta = withPageOg("/disputes", { title: "Disputes — Radix Guild", description: "How disputes resolve." })

  it("copies the page's own title, description and path into the card", () => {
    expect(meta.openGraph).toMatchObject({ title: "Disputes — Radix Guild", description: "How disputes resolve.", url: "/disputes" })
    expect(meta.twitter).toMatchObject({ title: "Disputes — Radix Guild", card: "summary_large_image" })
    expect(meta.alternates).toMatchObject({ canonical: "/disputes" })
  })

  it("keeps the image — a child openGraph REPLACES the parent's, so omitting it would drop the card image", () => {
    expect(JSON.stringify(meta.openGraph)).toContain("/og-image.png")
  })
})

describe("sitemap lists the live public pages the 2026-09-20 audit found missing", () => {
  const paths = sitemap().map((e) => new URL(e.url).pathname)
  it.each(["/swaps", "/groups", "/lights-on"])("%s", (p) => {
    expect(paths).toContain(p)
  })
})

describe("sitemap lists /fund only while community funding is switched on (2026-09-24)", () => {
  // bigdev switched crowdfunding off for launch. Every /fund page notFound()s
  // behind NEXT_PUBLIC_FEATURE_CROWDFUND, so an unconditional entry advertised a
  // 404. The unit env leaves the flag unset — the production-off state.
  it("flag unset: /fund is absent", () => {
    const paths = sitemap().map((e) => new URL(e.url).pathname)
    expect(paths).not.toContain("/fund")
  })

  it("flag=true: /fund is listed (fresh module import)", async () => {
    vi.resetModules()
    vi.stubEnv("NEXT_PUBLIC_FEATURE_CROWDFUND", "true")
    try {
      const fresh = (await import("@/app/sitemap")).default
      const paths = fresh().map((e) => new URL(e.url).pathname)
      expect(paths).toContain("/fund")
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})

describe("the card image URL changes whenever the image does", () => {
  // Telegram caches a preview image BY URL. Fixing og-image.png in place left Telegram
  // serving the old blank one for weeks; only a new URL makes it fetch again.
  it("carries the first 10 hex of the committed PNG's SHA-256", () => {
    const png = readFileSync(join(process.cwd(), "public", "og-image.png"))
    expect(OG_IMAGE_VERSION).toBe(createHash("sha256").update(png).digest("hex").slice(0, 10))
    expect(OG_IMAGE_URL).toBe(`/og-image.png?v=${OG_IMAGE_VERSION}`)
  })

  it("no page declares the bare, unversioned image URL", () => {
    const bare: string[] = []
    const walkAll = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n)
      return statSync(p).isDirectory() ? walkAll(p) : /\.tsx?$/.test(n) ? [p] : []
    })
    for (const f of walkAll(join(process.cwd(), "src"))) {
      if (f.endsWith(join("lib", "page-metadata.ts"))) continue
      if (/["\x27`]\/og-image\.png["\x27`]/.test(readFileSync(f, "utf8"))) bare.push(relative(process.cwd(), f))
    }
    expect(bare).toEqual([])
  })
})

