/**
 * The List form's "Common tokens" shortcut (src/lib/common-tokens.ts).
 *
 * The list pre-fills a token resource address on a money form, so each row is
 * pinned to what the Radix Gateway said about that address on 2026-10-07
 * (tests/fixtures/common-tokens/…, trimmed from /state/entity/details): it is a
 * FUNGIBLE resource, and its symbol and name are the ones the select shows. A
 * typo in an address, or a row added without a Gateway read, fails here.
 *
 * GUILD_LIVE_GATEWAY=1 adds the same comparison against mainnet itself — run
 * it when the list changes; CI stays offline.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { COMMON_TOKENS, commonTokenFor } from "@/lib/common-tokens"
import { XRD_ADDRESS } from "@/lib/radix"
import { isResourceAddress } from "@/lib/nft-swap"

interface Pinned {
  address: string
  type: string
  divisibility: number | null
  symbol: string | null
  name: string | null
}

const FIXTURE = JSON.parse(
  readFileSync(join(process.cwd(), "tests", "fixtures", "common-tokens", "entity-details-mainnet-2026-10-07.json"), "utf8"),
) as { state_version: number; items: Pinned[] }

function compare(read: Map<string, Pinned>): string[] {
  const bad: string[] = []
  for (const t of COMMON_TOKENS) {
    const r = read.get(t.address)
    if (!r) bad.push(`${t.symbol}: the Gateway returned nothing for ${t.address}`)
    else if (r.type !== "FungibleResource") bad.push(`${t.symbol}: ${r.type}, not a fungible token`)
    else if (r.symbol !== t.symbol || r.name !== t.name) bad.push(`${t.symbol}: the chain says ${r.symbol} / ${r.name}`)
  }
  return bad
}

describe("COMMON_TOKENS", () => {
  it("starts with XRD, the form's default, and holds distinct resource addresses and symbols", () => {
    expect(COMMON_TOKENS[0].address).toBe(XRD_ADDRESS)
    for (const t of COMMON_TOKENS) expect(isResourceAddress(t.address), t.symbol).toBe(true)
    expect(new Set(COMMON_TOKENS.map((t) => t.address)).size).toBe(COMMON_TOKENS.length)
    expect(new Set(COMMON_TOKENS.map((t) => t.symbol)).size).toBe(COMMON_TOKENS.length)
  })

  it("matches the Gateway read pinned in the fixture: fungible, same symbol, same name", () => {
    expect(FIXTURE.items.length).toBe(COMMON_TOKENS.length)
    expect(compare(new Map(FIXTURE.items.map((i) => [i.address, i])))).toEqual([])
  })

  it("commonTokenFor finds a listed address and nothing else", () => {
    expect(commonTokenFor(XRD_ADDRESS)?.symbol).toBe("XRD")
    expect(commonTokenFor("")).toBeNull()
    expect(commonTokenFor("resource_rdx1notalistedtokenxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toBeNull()
  })
})

describe.skipIf(!process.env.GUILD_LIVE_GATEWAY)("COMMON_TOKENS against mainnet (GUILD_LIVE_GATEWAY=1)", () => {
  it("every row still reads as the same fungible token", async () => {
    const res = await fetch("https://mainnet.radixdlt.com/state/entity/details", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addresses: COMMON_TOKENS.map((t) => t.address) }),
    })
    expect(res.ok).toBe(true)
    const json = (await res.json()) as { items: any[] }
    const md = (it: any, key: string) => it?.metadata?.items?.find((m: any) => m?.key === key)?.value?.typed?.value ?? null
    const read = new Map<string, Pinned>(
      json.items.map((it) => [
        it.address,
        { address: it.address, type: it.details?.type, divisibility: it.details?.divisibility ?? null, symbol: md(it, "symbol"), name: md(it, "name") },
      ]),
    )
    expect(compare(read)).toEqual([])
  }, 20_000)
})
