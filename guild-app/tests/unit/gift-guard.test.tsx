import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The gift guard, as a tripwire: NOTHING sendable may render until bigdev
 * supplies a destination that validates. The failure modes are not symmetric —
 * a dark rail collects no gifts, a wrong rail eats them — so every assertion
 * here is written from the "wrong rail" side.
 *
 * As in escrow-dispute-gate.test.tsx, the live cases are asserted too: without
 * them the dark cases could pass vacuously against a module that is simply
 * broken and rejects everything.
 *
 * The values below are TEST FIXTURES ONLY. No real gift destination exists in
 * this repo, and none may ever be committed as a default — the whole point of
 * lib/gift.ts is that the address comes from env or the rail stays off.
 * VALID_XRD is the repo's already-public dApp-definition account, reused only
 * because it is a real bech32m string that must pass.
 */

const VALID_XRD = "account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw";
const VALID_BTC = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";
const VALID_STRIPE = "https://buy.stripe.com/8wMbJe0Zq2Sw6JydQQ";
const VALID_PAYPAL = "https://paypal.me/exampleguildhandle";

const ENV = {
  xrd: "NEXT_PUBLIC_GIFT_XRD_ADDRESS",
  btc: "NEXT_PUBLIC_GIFT_BTC_ADDRESS",
  stripe: "NEXT_PUBLIC_GIFT_STRIPE_URL",
  paypal: "NEXT_PUBLIC_GIFT_PAYPAL_URL",
} as const;

/** Load a FRESH lib/gift with exactly this env — it resolves rails at module load. */
async function loadGift(env: Partial<Record<keyof typeof ENV, string>> = {}) {
  vi.resetModules();
  for (const [rail, name] of Object.entries(ENV)) {
    vi.stubEnv(name, env[rail as keyof typeof ENV] ?? "");
  }
  return import("@/lib/gift");
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  warn.mockRestore();
});

describe("gift guard — nothing configured", () => {
  it("every rail is dark and the page is not live", async () => {
    const gift = await loadGift();
    expect(gift.isGiftPageLive()).toBe(false);
    expect(gift.liveGiftRails()).toEqual([]);
    for (const rail of ["xrd", "btc", "stripe", "paypal"] as const) {
      expect(gift.isGiftRailLive(rail)).toBe(false);
      // The anti-placeholder tripwire: unset must yield null, never a
      // stand-in, a default, or an empty-but-truthy string.
      expect(gift.giftDestination(rail)).toBeNull();
    }
  });

  it("says nothing on stderr when simply unconfigured (dark is not an error)", async () => {
    await loadGift();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("gift guard — configured and valid", () => {
  it("lights up exactly the rails that are set (proves the dark cases aren't vacuous)", async () => {
    const gift = await loadGift({ xrd: VALID_XRD, btc: VALID_BTC });
    expect(gift.isGiftPageLive()).toBe(true);
    expect(gift.liveGiftRails()).toEqual(["xrd", "btc"]);
    expect(gift.giftDestination("xrd")).toBe(VALID_XRD);
    expect(gift.giftDestination("btc")).toBe(VALID_BTC);
    // Unset rails stay dark even while others are live — rails are independent.
    expect(gift.giftDestination("stripe")).toBeNull();
    expect(gift.giftDestination("paypal")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts all four rails together", async () => {
    const gift = await loadGift({
      xrd: VALID_XRD,
      btc: VALID_BTC,
      stripe: VALID_STRIPE,
      paypal: VALID_PAYPAL,
    });
    expect(gift.liveGiftRails()).toEqual(["xrd", "btc", "stripe", "paypal"]);
    expect(gift.giftDiagnostics()).toEqual([]);
  });
});

describe("gift guard — set but INVALID is treated as unset", () => {
  const CASES: { rail: keyof typeof ENV; value: string; why: string }[] = [
    { rail: "xrd", value: "account_rdx1YOUR_ADDRESS_HERE", why: "placeholder" },
    { rail: "xrd", value: "account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mv", why: "one-char typo (checksum)" },
    { rail: "xrd", value: "component_rdx1cr690hkrk2kv933cw3qdr6amkaphdlu2whjhhh8wppus922yx335r2", why: "a component, not an account" },
    { rail: "xrd", value: VALID_BTC, why: "a BTC address in the XRD slot" },
    { rail: "xrd", value: ` ${VALID_XRD} `, why: "whitespace-padded" },
    { rail: "btc", value: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5", why: "bad checksum" },
    { rail: "btc", value: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", why: "testnet" },
    { rail: "btc", value: VALID_XRD, why: "an XRD address in the BTC slot" },
    { rail: "stripe", value: "https://buy.stripe.com/test_8wMbJe0Zq2Sw6JydQQ", why: "Stripe test-mode link" },
    { rail: "stripe", value: "https://evil.example.com/pay", why: "host not allowlisted" },
    { rail: "stripe", value: "http://buy.stripe.com/8wMbJe0Zq2Sw6JydQQ", why: "not https" },
    { rail: "stripe", value: "https://buy.stripe.com/", why: "bare host, no link" },
    { rail: "stripe", value: "https://buy.stripe.com/your-link", why: "placeholder path" },
    { rail: "paypal", value: "https://paypal.me/", why: "no handle" },
    { rail: "paypal", value: "https://paypal.com/donate/xyz", why: "paypal.com but not /paypalme/" },
    { rail: "paypal", value: "not-a-url", why: "not a URL" },
  ];

  it.each(CASES)("$rail rejects $why → rail stays OFF", async ({ rail, value }) => {
    const gift = await loadGift({ [rail]: value });
    expect(gift.giftDestination(rail)).toBeNull();
    expect(gift.isGiftRailLive(rail)).toBe(false);
    expect(gift.isGiftPageLive()).toBe(false);
  });

  it.each(CASES)("$rail warns loudly about $why rather than failing silently", async ({ rail, value }) => {
    await loadGift({ [rail]: value });
    // Set-but-rejected is an operator error, and silence here is what turns a
    // typo into "I set the address and the page is still empty".
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain(ENV[rail]);
  });

  it("a bad rail cannot take a good one down with it", async () => {
    const gift = await loadGift({ xrd: VALID_XRD, btc: "bc1qbogus" });
    expect(gift.isGiftRailLive("xrd")).toBe(true);
    expect(gift.isGiftRailLive("btc")).toBe(false);
    expect(gift.giftDiagnostics().map((d) => d.rail)).toEqual(["btc"]);
  });

  it("never echoes the rejected value back into the log", async () => {
    // It is public data, not a secret — but reprinting the broken string
    // invites copying the broken one back out of the build output.
    await loadGift({ xrd: "account_rdx1YOUR_ADDRESS_HERE" });
    expect(String(warn.mock.calls[0][0])).not.toContain("YOUR_ADDRESS_HERE");
  });
});

/**
 * A checksum proves "not a typo". It can never prove "the account you meant".
 *
 * Both addresses below are valid, live, 66-character mainnet accounts that
 * appear throughout the ecosystem's repos and docs — which is precisely what
 * makes them plausible paste errors into NEXT_PUBLIC_GIFT_XRD_ADDRESS. They
 * would sail through every other check in the guard, so they are denied by
 * name. Canonical list: bigdev-console docs/WALLET-MAP.md.
 */
describe("gift guard — forbidden destinations", () => {
  const HOT_SERVER = "account_rdx128lggt503h7m2dhzqnrkkqv4zklxcjmdggr8xxtqy8e47p7fkmd8cx";
  const ORPHANED_DAPP_DEF = "account_rdx128y6j78mt0aqv6372evz28hrxp8mn06ccddkr7xppc88hyvynvjdwr";

  it("rejects the hot server account → rail stays OFF", async () => {
    const gift = await loadGift({ xrd: HOT_SERVER });
    expect(gift.giftDestination("xrd")).toBeNull();
    expect(gift.isGiftRailLive("xrd")).toBe(false);
    expect(gift.isGiftPageLive()).toBe(false);
    expect(gift.giftDiagnostics()[0].reason).toContain("hot server account");
  });

  it("rejects the orphaned old dApp definition — no key exists for it", async () => {
    const gift = await loadGift({ xrd: ORPHANED_DAPP_DEF });
    expect(gift.giftDestination("xrd")).toBeNull();
    expect(gift.isGiftRailLive("xrd")).toBe(false);
    expect(gift.giftDiagnostics()[0].reason).toContain("unrecoverable");
  });

  it("warns loudly about a forbidden address rather than going quietly dark", async () => {
    await loadGift({ xrd: HOT_SERVER });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain(ENV.xrd);
  });

  it("every forbidden address is itself well-formed", async () => {
    // If one were malformed the checksum would reject it anyway, and its
    // denylist entry would be dead weight hiding a stale or mistyped address.
    const { FORBIDDEN_XRD_DESTINATIONS } = await loadGift({});
    const { verifyBech32 } = await import("@/lib/bech32");
    const addrs = Object.keys(FORBIDDEN_XRD_DESTINATIONS);
    expect(addrs).toContain(HOT_SERVER);
    expect(addrs).toContain(ORPHANED_DAPP_DEF);
    for (const addr of addrs) {
      expect(addr, `${addr} is not 66 chars`).toHaveLength(66);
      expect(verifyBech32(addr)?.encoding, `${addr} fails bech32m`).toBe("bech32m");
    }
  });

  it("denies by exact address, not by prefix — a real account still passes", async () => {
    // The guard must not have become "reject anything that looks like ours".
    const gift = await loadGift({ xrd: VALID_XRD });
    expect(gift.giftDestination("xrd")).toBe(VALID_XRD);
  });
});

describe("bip21Uri", () => {
  it("builds a bare URI with no amount", async () => {
    const { bip21Uri } = await loadGift({ btc: VALID_BTC });
    expect(bip21Uri(VALID_BTC)).toBe(`bitcoin:${VALID_BTC}`);
  });

  it("prefills the amount and percent-encodes the label", async () => {
    const { bip21Uri } = await loadGift({ btc: VALID_BTC });
    const uri = bip21Uri(VALID_BTC, "0.001", "Radix Guild");
    expect(uri).toBe(`bitcoin:${VALID_BTC}?amount=0.001&label=Radix+Guild`);
  });

  it("refuses to build a URI for an invalid address", async () => {
    const { bip21Uri } = await loadGift({});
    expect(() => bip21Uri("bc1qbogus")).toThrow(/invalid address/i);
  });

  it("rejects an exponential amount rather than emitting a URI wallets misread", async () => {
    const { bip21Uri } = await loadGift({});
    // String(0.0000001) === "1e-7"; some wallets read that as an empty amount.
    expect(() => bip21Uri(VALID_BTC, String(1e-7))).toThrow(/plain decimal/i);
  });

  it("every shipped BTC preset is a plain decimal that survives round-tripping", async () => {
    const { BTC_PRESETS, bip21Uri } = await loadGift({});
    for (const p of BTC_PRESETS) {
      expect(() => bip21Uri(VALID_BTC, p)).not.toThrow();
      expect(String(Number(p))).toBe(p);
    }
  });

  it("every shipped XRD preset is a clean decimal (no float artifacts in a manifest)", async () => {
    const { XRD_PRESETS } = await loadGift({});
    for (const p of XRD_PRESETS) {
      expect(String(Number(p))).toBe(p);
      expect(Number(p)).toBeGreaterThan(0);
    }
  });
});

describe("/gift route guard", () => {
  // The page's module graph (AppShell, the gift rails, next/*) costs its whole
  // cold load on the FIRST import: 909ms measured 2026-09-30 with this file run
  // alone, against 11ms for the re-import after vi.resetModules() in the next
  // test — every other test here is under 35ms. So it was the import, paid
  // inside "404s when no rail is configured", that this file failed on at
  // vitest's 5000ms default in full-suite runs under peer sessions' concurrent
  // suites (load average up to ~295 on 12 cores). Paid here instead, under the 60s hookTimeout
  // (vitest.config.ts). No testTimeout is raised: each test keeps the default,
  // so a page that genuinely got slow still reddens. The rails are stubbed dark
  // so the warm-up is silent whatever the ambient env holds.
  beforeAll(async () => {
    for (const name of Object.values(ENV)) vi.stubEnv(name, "");
    await import("@/app/gift/page");
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.doMock("next/navigation", () => ({
      notFound: () => {
        throw new Error("NEXT_NOT_FOUND");
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock("next/navigation");
  });

  it("404s when no rail is configured", async () => {
    vi.resetModules();
    for (const name of Object.values(ENV)) vi.stubEnv(name, "");
    const { default: GiftPage } = await import("@/app/gift/page");
    expect(() => GiftPage()).toThrow("NEXT_NOT_FOUND");
  });

  it("renders once a single rail is configured (proves the 404 isn't unconditional)", async () => {
    vi.resetModules();
    for (const name of Object.values(ENV)) vi.stubEnv(name, "");
    vi.stubEnv(ENV.paypal, VALID_PAYPAL);
    const { default: GiftPage } = await import("@/app/gift/page");
    expect(() => GiftPage()).not.toThrow();
  });
});
