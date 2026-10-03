import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DAPP_DEF } from "@/lib/config"

// /.well-known/radix.json is the site's half of the Radix Wallet's two-way
// dApp verification: an account listed here AND claiming radixguild.com is
// treated as this site's dApp definition. Until 2026-09-24 it still listed
// RX-10 · Radix Guild dApp definition (old) · …8y78z9sq, whose key is on the
// compromised old seed — whoever holds that seed could have made it claim a
// component of their own and had the wallet present it as verified for
// radixguild.com. The site only ever connects with DAPP_DEF.
describe("/.well-known/radix.json", () => {
  const json = JSON.parse(readFileSync(join(process.cwd(), "public/.well-known/radix.json"), "utf8"))

  it("vouches for exactly the dApp definition the site connects with", () => {
    expect(json).toEqual({ dApps: [{ dAppDefinitionAddress: DAPP_DEF }] })
  })

  it("never re-lists RX-10, the retired dApp definition on the compromised seed", () => {
    expect(JSON.stringify(json)).not.toContain("8y78z9sq")
  })
})
