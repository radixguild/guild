/**
 * Structural pre-screen — driven by REAL notarized transactions.
 *
 * ⚠️ THIS FILE DELIBERATELY DOES NOT MOCK THE TOOLKIT, and that is the whole
 * point of it existing separately from x402-facilitator.test.ts. That suite
 * mocks `@radixdlt/radix-engine-toolkit` so it can say what arbitrary bytes
 * derive to — necessary there, fatal here: a screen validated against a fake
 * decoder proves the fake, not the screen. Its own §5 note asked for exactly
 * this ("drive settle() through the real toolkit... that needs a real notarized
 * transaction fixture").
 *
 * The fixtures are BUILT, not committed. Building them costs local Ed25519 work
 * and no network, and it means there is no opaque hex blob in the tree that
 * nobody can regenerate or check. A committed fixture drifts from its generator;
 * one built in beforeAll cannot.
 */
import { describe, it, expect, beforeAll } from "vitest"
import {
  TransactionBuilder,
  PrivateKey,
  RadixEngineToolkit,
} from "@radixdlt/radix-engine-toolkit"
import { screenPayment } from "@/lib/x402/decode"
import type { PaymentAccept } from "@/lib/x402/types"

const XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"
const PAY_TO = "account_rdx128y6j78mt0aqv6372evz28hrxp8mn06ccddkr7xppc88hyvynvjdwr"
const STRANGER = "account_rdx12yy8n09a0w907vrjyj4hws2yptrm3rdjv84l9sr24e3w7pk7nuxst8"

// A throwaway signing key, COMPUTED rather than written down. It signs nothing
// that exists on any ledger: every transaction here is built and discarded
// in-process and none is ever submitted.
//
// 🔴 IT IS COMPUTED FOR A CONCRETE REASON, not for elegance. As a 64-hex
// literal named KEY_HEX it tripped gitleaks' `generic-api-key` rule, and
// because `gitleaks git` scans every commit reachable in the checkout while CI
// fetches all refs, that finding failed the secret scan on EVERY open PR in the
// repo — including ones that never touch x402. It was allowlisted as an exact
// literal to unblock them; generating it here removes the finding at source so
// that entry can come out.
//
// The general point, which outlives this fixture: an allowlist that accumulates
// key-shaped literals is how a real key eventually slips in behind them. A test
// vector that cannot look like a credential needs no exemption at all.
//
// Deterministic on purpose — a random key per run would make a signature
// failure unreproducible. `(i * 17 + 0x4f) & 0xff` is an arithmetic walk with
// no entropy: reading the code tells you every byte, which is the property that
// makes it obviously not a credential.
const KEY_HEX = Array.from({ length: 32 }, (_, i) =>
  ((i * 17 + 0x4f) & 0xff).toString(16).padStart(2, "0"),
).join("")

const accept = (over: Partial<PaymentAccept> = {}): PaymentAccept => ({
  scheme: "exact",
  network: "radix:1",
  amount: "50000000000000000",
  asset: XRD,
  payTo: PAY_TO,
  maxTimeoutSeconds: 120,
  extra: { name: "XRD" },
  ...over,
})

let payer: string
let goodHex: string
let strangerHex: string
let noDepositHex: string

async function buildHex(opts: { payTo?: string; omitDeposit?: boolean; nonce: number }) {
  const key = new PrivateKey.Ed25519(KEY_HEX)
  const to = opts.payTo ?? PAY_TO
  const body = opts.omitDeposit
    ? `CALL_METHOD Address("${payer}") "lock_fee" Decimal("5");`
    : `
CALL_METHOD Address("${payer}") "lock_fee" Decimal("5");
CALL_METHOD Address("${payer}") "withdraw" Address("${XRD}") Decimal("0.05");
TAKE_FROM_WORKTOP Address("${XRD}") Decimal("0.05") Bucket("b");
CALL_METHOD Address("${to}") "try_deposit_or_abort" Bucket("b") Enum<0u8>();`

  const notarized = await (await TransactionBuilder.new())
    .header({
      networkId: 1,
      startEpochInclusive: 1000,
      endEpochExclusive: 1010,
      nonce: opts.nonce,
      notaryPublicKey: key.publicKey(),
      notaryIsSignatory: true,
      tipPercentage: 0,
    })
    .manifest({ instructions: { kind: "String", value: body }, blobs: [] })
    .notarize(key)

  const compiled = await RadixEngineToolkit.NotarizedTransaction.compile(notarized)
  return Buffer.from(compiled).toString("hex")
}

beforeAll(async () => {
  const key = new PrivateKey.Ed25519(KEY_HEX)
  payer = await RadixEngineToolkit.Derive.virtualAccountAddressFromPublicKey(key.publicKey(), 1)
  goodHex = await buildHex({ nonce: 1 })
  strangerHex = await buildHex({ payTo: STRANGER, nonce: 2 })
  noDepositHex = await buildHex({ omitDeposit: true, nonce: 3 })
}, 60_000)

describe("screenPayment — accepts a well-formed payment", () => {
  it("passes a real notarized payment and returns the derived intent hash", async () => {
    const result = await screenPayment(goodHex, accept())
    expect(result.ok).toBe(true)
    // The hash must be the one the toolkit derives from these very bytes, not
    // anything the caller could have supplied.
    if (result.ok) expect(result.intentHash).toMatch(/^txid_rdx1[0-9a-z]+$/)
  })

  it("tolerates a 0x prefix and surrounding whitespace", async () => {
    const result = await screenPayment(`  0x${goodHex}\n`, accept())
    expect(result.ok).toBe(true)
  })
})

describe("screenPayment — rejects what cannot succeed", () => {
  it("🔴 rejects a TAMPERED transaction, which decompiles cleanly but is unsigned", async () => {
    // THE CASE THAT MOTIVATED THIS SCREEN. Flipping the final byte leaves bytes
    // that still decompile — so the old code, which only decompiled to derive a
    // hash, would have SUBMITTED this. Only signature validation catches it.
    const last = goodHex.slice(-2)
    const tampered = goodHex.slice(0, -2) + (last === "ff" ? "ee" : "ff")
    const result = await screenPayment(tampered, accept())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("failed_static_validation")
      expect(result.detail).toContain("Signature")
    }
  })

  it("rejects a payment to a STRANGER — it never claims to pay us", async () => {
    const result = await screenPayment(strangerHex, accept())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("no_payment_to_payto")
  })

  it("rejects a manifest with no deposit instruction at all", async () => {
    const result = await screenPayment(noDepositHex, accept())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("no_payment_to_payto")
  })

  it("rejects a transaction built for a DIFFERENT network", async () => {
    // The payment is a real, correctly-signed mainnet transaction; the screen is
    // told to expect network 2. Driving it from this side needs no testnet
    // address anywhere in the tree, and exercises the same comparison.
    const result = await screenPayment(goodHex, accept({ network: "radix:2" }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // staticallyValidate reaches this first and names it precisely.
      expect(result.reason).toBe("failed_static_validation")
      expect(result.detail).toContain("InvalidNetwork")
    }
  })

  it("rejects an unparseable network string rather than defaulting to mainnet", async () => {
    // A screen that fell back to network 1 on a malformed config would validate
    // against a chain the payment never claimed.
    const result = await screenPayment(goodHex, accept({ network: "ethereum:1" }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("wrong_network")
  })

  it.each([
    ["empty", ""],
    ["odd length", "abc"],
    ["not hex", "zzzz"],
    ["decodable hex that is not a transaction", "deadbeef"],
  ])("rejects %s bytes as an invalid payload", async (_label, bytes) => {
    const result = await screenPayment(bytes, accept())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("invalid_payload")
  })
})

describe("what the screen does NOT claim", () => {
  it("passes a manifest that deposits to us but withdraws NOTHING — value is settle()'s job", async () => {
    // Deliberate, and asserted so nobody later reads a pass as proof of payment.
    // This manifest deposits an empty bucket: structurally it pays us, and it
    // would settle for zero. The receipt check in settle() is what rejects it,
    // which is why this screen is a necessary condition and never a sufficient
    // one.
    const key = new PrivateKey.Ed25519(KEY_HEX)
    const notarized = await (await TransactionBuilder.new())
      .header({
        networkId: 1,
        startEpochInclusive: 1000,
        endEpochExclusive: 1010,
        nonce: 4,
        notaryPublicKey: key.publicKey(),
        notaryIsSignatory: true,
        tipPercentage: 0,
      })
      .manifest({
        instructions: {
          kind: "String",
          value: `
CALL_METHOD Address("${payer}") "lock_fee" Decimal("5");
TAKE_ALL_FROM_WORKTOP Address("${XRD}") Bucket("empty");
CALL_METHOD Address("${PAY_TO}") "try_deposit_or_abort" Bucket("empty") Enum<0u8>();`,
        },
        blobs: [],
      })
      .notarize(key)
    const compiled = await RadixEngineToolkit.NotarizedTransaction.compile(notarized)
    const result = await screenPayment(Buffer.from(compiled).toString("hex"), accept())

    expect(result.ok).toBe(true) // structurally fine, economically worthless
  })
})
