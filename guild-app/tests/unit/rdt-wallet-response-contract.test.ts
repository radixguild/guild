// @vitest-environment node
/**
 * Wallet-response contract: the REAL Radix dApp Toolkit parse, under this
 * app's valibot / uuid overrides (package.json "overrides").
 *
 * Sign-in is the path every new member takes, and every other test of it
 * mocks RDT or useWallet (the e2e suite swaps RDT out entirely). So nothing
 * proved that the toolkit's own response validator still runs under the
 * pinned valibot, or that what it hands useWallet is the shape useWallet
 * reads and the server's verifyAuthSchema accepts. This file does, with no
 * mocks: the fixture goes through validateWalletResponse and
 * transformWalletResponseToRdtWalletData exactly as the toolkit runs them.
 *
 * The fixture is schema-shaped (built from the toolkit's src/schemas), NOT a
 * capture from a wallet. A real wallet login on the candidate build is still
 * the smoke test before a deploy; this file catches the override drift that
 * would make that smoke test fail for a reason nobody can see in a diff.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  validateWalletResponse,
  transformWalletResponseToRdtWalletData,
  type WalletDataRequestResponse,
  type WalletInteractionSuccessResponse,
} from "@radixdlt/radix-dapp-toolkit"
import * as valibot from "valibot"
import { verifyAuthSchema } from "@/lib/validation"

const FIX = join(__dirname, "..", "fixtures", "rdt")
// The app's own node_modules — resolved by path, not require.resolve: valibot
// and uuid export no "./package.json" subpath, and Vitest resolves the toolkit
// to its CJS build while Next ships the ESM one that the app actually runs.
const NM = (...rest: string[]) => join(__dirname, "..", "..", "node_modules", ...rest)
const fixture = JSON.parse(
  readFileSync(join(FIX, "one-time-accounts-with-proof.json"), "utf8"),
) as WalletInteractionSuccessResponse & { _note: string }

type Mut = (r: WalletInteractionSuccessResponse) => void
const mutated = (mut: Mut) => {
  const copy = structuredClone(fixture) as WalletInteractionSuccessResponse
  mut(copy)
  return copy
}
const accountsOf = (r: WalletInteractionSuccessResponse) => {
  const items = r.items as Extract<typeof r.items, { discriminator: "unauthorizedRequest" }>
  return items.oneTimeAccounts!
}

describe("RDT wallet response — real parse under the overrides", () => {
  it("accepts the schema-shaped one-time-accounts-with-proof response", () => {
    const res = validateWalletResponse(fixture)
    expect(res.isOk()).toBe(true)
  })

  it("transforms it into the proof useWallet reads, and verifyAuthSchema accepts that proof", async () => {
    const parsed = validateWalletResponse(fixture)
    if (parsed.isErr()) throw parsed.error
    const data = await transformWalletResponseToRdtWalletData(
      parsed.value.items as WalletDataRequestResponse,
    )
    if (data.isErr()) throw data.error
    const proof = data.value.proofs?.[0]
    // useWallet.tsx requestProof: proofs[0].type === "account", then it ships
    // { address, type, challenge, proof } as signed_challenge.
    expect(proof?.type).toBe("account")
    const signed = {
      address: proof!.address,
      type: "account" as const,
      challenge: proof!.challenge,
      proof: proof!.proof,
    }
    const acc = accountsOf(fixture)
    expect(signed.address).toBe(acc.proofs![0].accountAddress)
    expect(signed.challenge).toBe(acc.challenge)
    expect(verifyAuthSchema.safeParse({ signed_challenge: signed }).success).toBe(true)
    expect(data.value.accounts).toEqual(acc.accounts)
  })

  it("rejects a curve the toolkit does not know (ed25519 is not a valibot literal here)", () => {
    const bad = mutated((r) => {
      ;(accountsOf(r).proofs![0].proof as { curve: string }).curve = "ed25519"
    })
    expect(validateWalletResponse(bad).isErr()).toBe(true)
  })

  it("rejects a proof with no signature", () => {
    const bad = mutated((r) => {
      delete (accountsOf(r).proofs![0].proof as { signature?: string }).signature
    })
    expect(validateWalletResponse(bad).isErr()).toBe(true)
  })

  it("rejects a challenge with proofs missing (the AccountsRequestResponseItem check)", () => {
    const bad = mutated((r) => {
      delete (accountsOf(r) as { proofs?: unknown }).proofs
    })
    expect(validateWalletResponse(bad).isErr()).toBe(true)
  })

  it("rejects a misspelt top-level discriminator", () => {
    const bad = mutated((r) => {
      ;(r as { discriminator: string }).discriminator = "succes"
    })
    expect(validateWalletResponse(bad).isErr()).toBe(true)
  })

  it("verifyAuthSchema refuses the same curve the toolkit refuses (both halves agree)", () => {
    const signed = {
      address: accountsOf(fixture).proofs![0].accountAddress,
      type: "account",
      challenge: accountsOf(fixture).challenge,
      proof: { ...accountsOf(fixture).proofs![0].proof, curve: "ed25519" },
    }
    expect(verifyAuthSchema.safeParse({ signed_challenge: signed }).success).toBe(false)
  })
})

describe("RDT ↔ valibot import surface", () => {
  const distPath = NM("@radixdlt", "radix-dapp-toolkit", "dist", "index.js")
  const dist = readFileSync(distPath, "utf8")
  // Every `import { a, b as c } from "valibot"` in the toolkit's ESM bundle,
  // including multi-line ones. If the pinned valibot ever drops or renames one
  // of these, the toolkit fails at import time — before any test that mocks
  // it would notice.
  const names = [...dist.matchAll(/import\s*\{([^}]*)\}\s*from\s*"valibot"/g)]
    .flatMap((m) => m[1].split(","))
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean)
  const unique = [...new Set(names)].sort()

  it("finds the imports it expects to check", () => {
    expect(dist.length).toBeGreaterThan(10_000)
    expect(unique.length).toBeGreaterThanOrEqual(10)
    expect(unique).toEqual(
      expect.arrayContaining(["object", "string", "literal", "union", "parse", "safeParse", "pipe", "check"]),
    )
  })

  it("every one of them is a function exported by the installed valibot", () => {
    const missing = unique.filter((n) => typeof (valibot as Record<string, unknown>)[n] !== "function")
    expect(missing).toEqual([])
  })

  it("installed valibot and uuid are the versions package.json overrides pin", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
      overrides: Record<string, unknown>
    }
    const installed = (name: string) =>
      (JSON.parse(readFileSync(NM(name, "package.json"), "utf8")) as { version: string }).version
    expect(installed("valibot")).toBe(pkg.overrides.valibot)
    expect(installed("uuid")).toBe(pkg.overrides.uuid)
  })
})
