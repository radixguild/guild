import { describe, expect, it } from "vitest";
import { verifyBech32 } from "@/lib/bech32";
import { validateBtcMainnetAddress } from "@/lib/btc-address";
import { BADGE_NFT, DAPP_DEF, ESCROW_COMPONENT } from "@/lib/config";
import { XRD_ADDRESS } from "@/lib/radix";

/**
 * Vectors are transcribed from the BIP-350 spec itself
 * (github.com/bitcoin/bips/blob/master/bip-0350.mediawiki, "Test vectors"),
 * NOT from memory — an earlier hand-typed set had two silently-wrong strings.
 * If these ever need editing, re-read them from the spec.
 *
 * This suite is the reason the BTC gift rail is allowed to render an address
 * at all: gift.ts treats "invalid" as "unset", so a verifier that wrongly
 * ACCEPTS is what loses someone's money, and a verifier that wrongly REJECTS
 * silently darkens the rail. Both directions are asserted here.
 */

describe("verifyBech32 — BIP-350 §Test vectors for Bech32m", () => {
  const VALID_BECH32M = [
    "A1LQFN3A",
    "a1lqfn3a",
    "an83characterlonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11sg7hg6",
    "abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx",
    "11llllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllludsr8",
    "split1checkupstagehandshakeupstreamerranterredcaperredlc445v",
    "?1v759aa",
  ];

  it.each(VALID_BECH32M)("accepts %s as bech32m", (s) => {
    expect(verifyBech32(s)?.encoding).toBe("bech32m");
  });

  // BIP-350: "No string can be simultaneously valid Bech32 and Bech32m."
  it.each(VALID_BECH32M)("does not also report %s as bech32", (s) => {
    expect(verifyBech32(s)?.encoding).not.toBe("bech32");
  });

  const VALID_BECH32 = [
    "A12UEL5L",
    "a12uel5l",
    "abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw",
    "split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w",
    "?1ezyfcl",
  ];

  it.each(VALID_BECH32)("accepts %s as bech32", (s) => {
    expect(verifyBech32(s)?.encoding).toBe("bech32");
  });

  it.each([
    ["\x201xj0phk", "HRP character out of range"],
    ["\x7F1g6xzxy", "HRP character out of range"],
    ["\x801vctc34", "HRP character out of range"],
    ["qyrz8wqd2c9m", "no separator"],
    ["1qyrz8wqd2c9m", "empty HRP"],
    ["y1b0jsk6g", "invalid data character"],
    ["lt1igcx5c0", "invalid data character"],
    ["in1muywd", "too short checksum"],
    ["mm1crxm3i", "invalid character in checksum"],
    ["au1s5cgom", "invalid character in checksum"],
    ["M1VUXWEZ", "checksum calculated with uppercase form of HRP"],
    ["16plkw9", "empty HRP"],
    ["1p2gdwpf", "empty HRP"],
  ])("rejects %j (%s)", (s) => {
    expect(verifyBech32(s)).toBeNull();
  });

  it("rejects mixed case", () => {
    expect(verifyBech32("A1LQFN3a")).toBeNull();
  });
});

describe("verifyBech32 — live mainnet addresses from config.ts", () => {
  // Radix Babylon addresses are bech32m too. If this block ever fails, the
  // gift XRD rail has gone dark for a reason that has nothing to do with the
  // configured address — fix the verifier, don't relax the guard.
  it.each([
    ["dApp definition account", DAPP_DEF],
    ["escrow component", ESCROW_COMPONENT],
    ["badge resource", BADGE_NFT],
    ["XRD resource", XRD_ADDRESS],
  ])("accepts the live %s as bech32m", (_label, addr) => {
    expect(verifyBech32(addr)?.encoding).toBe("bech32m");
  });

  it("rejects a one-character typo in a real Radix address", () => {
    // The whole point of checksumming rather than shape-matching: this string
    // passes any /^account_rdx1[a-z0-9]{54}$/ check.
    const typo = DAPP_DEF.slice(0, 20) + (DAPP_DEF[20] === "q" ? "p" : "q") + DAPP_DEF.slice(21);
    expect(typo).toHaveLength(DAPP_DEF.length);
    expect(typo).not.toBe(DAPP_DEF);
    expect(verifyBech32(typo)).toBeNull();
  });
});

describe("validateBtcMainnetAddress — BIP-350 valid mainnet addresses", () => {
  it.each([
    ["BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", "segwit-v0"],
    ["bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y", "taproot-v1"],
    ["BC1SW50QGDZ25J", "segwit-v16"],
    ["bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs", "segwit-v2"],
    ["bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", "taproot-v1"],
  ])("accepts %s as %s", (addr, kind) => {
    const r = validateBtcMainnetAddress(addr);
    expect(r).toMatchObject({ ok: true, kind, checksumVerified: true });
  });
});

describe("validateBtcMainnetAddress — BIP-350 invalid addresses", () => {
  it.each([
    ["tc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq5zuyut", "invalid HRP"],
    ["bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd", "bech32 instead of bech32m"],
    ["BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL", "bech32 instead of bech32m"],
    ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh", "bech32m instead of bech32"],
    ["bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4", "invalid char in checksum"],
    ["BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R", "invalid witness version"],
    ["bc1pw5dgrnzv", "1-byte program"],
    ["bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav253zgeav", "41-byte program"],
    ["BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P", "bad program length for v0"],
    ["bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf", "zero padding > 4 bits"],
    ["bc1gmk9yu", "empty data section"],
  ])("rejects %s (%s)", (addr) => {
    expect(validateBtcMainnetAddress(addr).ok).toBe(false);
  });

  it("rejects a mixed-case mainnet address", () => {
    expect(validateBtcMainnetAddress("bc1P0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0").ok).toBe(false);
  });
});

describe("validateBtcMainnetAddress — network and shape guards", () => {
  it.each([
    ["tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7", "segwit testnet"],
    ["tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "segwit testnet v0"],
    ["bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080", "regtest"],
    ["mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", "legacy testnet P2PKH"],
    ["2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc", "legacy testnet P2SH"],
  ])("rejects %s (%s) as testnet", (addr) => {
    const r = validateBtcMainnetAddress(addr);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("testnet");
  });

  it.each([
    "",
    "   ",
    "not-an-address",
    "account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw", // wrong asset in the BTC slot
    "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", // an ETH address
    "1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf0a", // legacy shape but an illegal base58 char (0)
    "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNaXXXXXXXXX", // legacy charset but too long
    "1A1zP1eP", // legacy charset but too short
    "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4extra",
  ])("rejects %j", (addr) => {
    expect(validateBtcMainnetAddress(addr).ok).toBe(false);
  });

  it("rejects an address with surrounding whitespace rather than trimming it", () => {
    const r = validateBtcMainnetAddress(" bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0 ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("whitespace");
  });

  it("accepts legacy mainnet forms but reports the checksum as unverified", () => {
    // Documented gap — see the btc-address.ts header. These are well-formed
    // real addresses (Satoshi's genesis P2PKH, and a P2SH), and the assertion
    // that checksumVerified is FALSE is the point: it must never claim more
    // protection than it delivers.
    for (const addr of ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"]) {
      expect(validateBtcMainnetAddress(addr)).toEqual({
        ok: true,
        kind: "legacy",
        checksumVerified: false,
      });
    }
  });

  it("ACKNOWLEDGED GAP: a typo'd legacy address still passes", () => {
    // Not a wish — a fact, pinned so nobody later reads "validated" as
    // "checksummed" for legacy. Last character changed; charset and length are
    // still legal, so this sails through and would send BTC into the void.
    // bc1… does not have this hole (see the typo test above). If this ever
    // starts failing, base58check landed and btc-address.ts's header plus
    // .env.example's operator note must both be corrected.
    const typo = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb";
    expect(validateBtcMainnetAddress(typo)).toMatchObject({ ok: true, checksumVerified: false });
  });
});
