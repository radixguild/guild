// /swaps/[id] must stay a thin page (guild#56 review follow-up).
//
// The route file builds its title and its small "Listing #n" label from the URL
// parameter alone and hands the rest to <SwapDetail/>, which reads the listing
// in the browser from GET /api/v1/swaps/{id}. NFT names are a stranger's text,
// so no chain read may happen on the server for this page: a chain or ledger
// import in the route file would be the first step to rendering an NFT's name
// into the prerendered HTML and the metadata, where the deploy-time copy gate
// (launch-check CHECK 4) scans every sentence. The sibling test
// swaps-listing-page-server.test.tsx pins what the server SENDS; this one pins
// what the file may IMPORT, by reading its source, so a regression fails even
// before anything renders. Comments are not scanned, as in swaps-no-task-links.
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const FILE = join(__dirname, "..", "..", "src", "app", "swaps", "[id]", "page.tsx")

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

/** Every module the file pulls in: static imports (incl. `import type` and
 *  side-effect imports), dynamic `import("…")` and `require("…")`. */
function specifiers(src: string): string[] {
  const out: string[] = []
  const patterns = [
    /\bimport\s+(?:[\w*${}\s,]+?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:[\w*${}\s,]+?\s+)?from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]
  for (const re of patterns) for (const m of src.matchAll(re)) out.push(m[1])
  return out
}

/** A module that reads the chain, the ledger, or the database, or builds what
 *  goes to the ledger. Matched on the last path segment (or the package scope),
 *  so "@/lib/gateway" and "../../lib/gateway" are the same thing. */
const CHAIN_OR_LEDGER =
  /(^|\/)(gateway|ledger[\w-]*|radix|manifests|rola|nft-swap-gateway|nft-swap-service|escrow[\w-]*|chain[\w-]*)$|^@radixdlt\/|^@\/db(\/|$)|(^|\/)db\/|^(postgres|drizzle-orm)(\/|$)/

describe("/swaps/[id]/page.tsx stays a thin page", () => {
  const src = stripComments(readFileSync(FILE, "utf8"))
  const imports = specifiers(src)

  it("finds the imports it is meant to check (the scan cannot pass by seeing nothing)", () => {
    expect(imports).toEqual(
      expect.arrayContaining(["next/link", "@/components/app-shell", "@/components/swaps/swap-detail", "@/lib/page-metadata"]),
    )
    expect(imports.length).toBeGreaterThanOrEqual(4)
  })

  it("imports no chain, ledger, Gateway or database module", () => {
    const bad = imports.filter((m) => CHAIN_OR_LEDGER.test(m))
    expect(bad, `chain/ledger imports in swaps/[id]/page.tsx: ${bad.join(", ")}`).toEqual([])
  })

  it("does not reach the swap service or the Gateway reader by any spelling", () => {
    for (const re of [/nft-swap-gateway/, /nft-swap-service/, /@\/lib\/gateway/, /@radixdlt\//, /GATEWAY\b/]) {
      expect(src, String(re)).not.toMatch(re)
    }
  })

  it("is a server page that hands the read to the client component", () => {
    expect(src).not.toMatch(/^\s*["']use client["']/m)
    expect(src).toMatch(/<SwapDetail\b/)
  })

  it("the matcher itself recognises what it is meant to catch", () => {
    const caught = [
      "@/lib/gateway",
      "../../../lib/gateway",
      "@/lib/nft-swap-gateway",
      "@/lib/nft-swap-service",
      "@/lib/radix",
      "@/lib/manifests",
      "@/lib/ledger-internal",
      "@/lib/escrow-utils",
      "@radixdlt/radix-engine-toolkit",
      "@/db/queries/tasks",
      "postgres",
      "drizzle-orm/pg-core",
    ]
    for (const m of caught) expect(CHAIN_OR_LEDGER.test(m), m).toBe(true)
    for (const m of ["next", "next/link", "lucide-react", "@/components/swaps/swap-detail", "@/lib/page-metadata", "@/lib/nft-swap-usd"]) {
      expect(CHAIN_OR_LEDGER.test(m), m).toBe(false)
    }
    expect(specifiers(`import { a } from "x/gateway"\nconst m = await import("y/ledger")\nexport * from "z/radix"`)).toEqual([
      "x/gateway",
      "z/radix",
      "y/ledger",
    ])
  })
})
