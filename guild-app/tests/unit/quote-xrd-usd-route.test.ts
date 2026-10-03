/**
 * Tests for GET /api/v1/quote/xrd-usd — the XRD/USD price quote.
 *
 * Two regressions are pinned here, both of which silently demoted the route to
 * its CoinGecko fallback while still returning 200s:
 *   1. The Astrolescent URL embedded a hand-typed XRD address with an extra `x`
 *      (ten, not nine), which the partner API answers with a 500.
 *   2. The response was read as `data.usd`, but the partner endpoint names the
 *      field `tokenPriceUSD` — so even a 200 parsed to null.
 *
 * The route caches at module scope, so every case re-imports it after
 * vi.resetModules() to start from a cold cache.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { XRD_ADDRESS } from "@/lib/radix";

// Shape captured from the live partner endpoint.
const ASTROLESCENT_BODY = {
  address: XRD_ADDRESS,
  name: "Radix",
  symbol: "XRD",
  tokenPriceXRD: 1,
  tokenPriceUSD: 0.00108139653777838,
  marketCap: 14539967.677145243,
};

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

async function loadRoute() {
  vi.resetModules();
  return (await import("@/app/api/v1/quote/xrd-usd/route")).GET;
}

describe("GET /api/v1/quote/xrd-usd", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("queries Astrolescent with the canonical XRD address", async () => {
    fetchMock.mockResolvedValue(jsonResponse(ASTROLESCENT_BODY));
    const GET = await loadRoute();
    await GET();

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(XRD_ADDRESS);
    // Regression: the ten-`x` transcription made the partner API 500.
    expect(url).not.toContain("tknxxxxxxxxxx");
  });

  it("reads the rate from tokenPriceUSD and reports astrolescent as source", async () => {
    fetchMock.mockResolvedValue(jsonResponse(ASTROLESCENT_BODY));
    const GET = await loadRoute();
    const body = await (await GET()).json();

    expect(body.rate).toBe(ASTROLESCENT_BODY.tokenPriceUSD);
    expect(body.source).toBe("astrolescent");
    expect(body.fallback_active).toBe(false);
    // One call means CoinGecko was never reached.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still falls back to CoinGecko when Astrolescent fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse("Internal Server Error", false))
      .mockResolvedValueOnce(jsonResponse({ radix: { usd: 0.00107869 } }));
    const GET = await loadRoute();
    const body = await (await GET()).json();

    expect(body.rate).toBe(0.00107869);
    expect(body.source).toBe("coingecko");
    expect(body.fallback_active).toBe(true);
  });

  it("fails closed with 503 when both feeds are down and no cache exists", async () => {
    fetchMock.mockResolvedValue(jsonResponse(null, false));
    const GET = await loadRoute();
    const res = await GET();

    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("price_feed_unavailable");
  });
});

/**
 * Frozen-primary detection (added 2026-09-02).
 *
 * THE BUG. `staleness_seconds` measures how long ago WE fetched. It says
 * nothing about how old the PRICE is, and on 2026-08-31 those came apart:
 * Radix halted, Astrolescent prices off Radix DEX pools, the pools stopped
 * trading, and the endpoint kept answering 200 with the last pre-halt number.
 * The route reported `staleness_seconds: 0` and `fallback_active: false` —
 * declaring itself healthy — while serving a dead rate for fifteen-plus hours
 * to every USD figure on the site.
 *
 * These cases pin the distinction the old route could not make: a source that
 * ANSWERS is not the same as a source that is WORKING.
 */
describe("GET /api/v1/quote/xrd-usd — frozen primary", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Astrolescent always answers with `rate`; CoinGecko with `cg`. */
  function feeds(rate: number, cg: number | null) {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("astrolescent")) {
        return Promise.resolve(jsonResponse({ ...ASTROLESCENT_BODY, tokenPriceUSD: rate }));
      }
      return cg === null
        ? Promise.resolve(jsonResponse({}, false))
        : Promise.resolve(jsonResponse({ radix: { usd: cg } }));
    });
  }

  it("an unchanged rate INSIDE the window is normal, not frozen", async () => {
    // A price API that caches for a few minutes must not be called frozen.
    vi.setSystemTime(new Date("2026-09-02T00:00:00Z"));
    const GET = await loadRoute();
    feeds(0.000616181090623589, 0.00064639);

    let body = await (await GET()).json();
    expect(body.primary_frozen).toBe(false);
    expect(body.source).toBe("astrolescent");

    // 10 minutes later, same value, past the 60s cache but inside the window.
    vi.setSystemTime(new Date("2026-09-02T00:10:00Z"));
    body = await (await GET()).json();
    expect(body.primary_frozen).toBe(false);
    expect(body.source).toBe("astrolescent");
  });

  it("the SAME rate past the window is frozen, and CoinGecko takes over", async () => {
    vi.setSystemTime(new Date("2026-09-02T00:00:00Z"));
    const GET = await loadRoute();
    feeds(0.000616181090623589, 0.00064639);
    await GET();

    // 16 minutes on, byte-identical — the real halt signature.
    vi.setSystemTime(new Date("2026-09-02T00:16:00Z"));
    const body = await (await GET()).json();

    expect(body.primary_frozen).toBe(true);
    expect(body.source).toBe("coingecko");
    expect(body.rate).toBe(0.00064639);
    // The old route said false here while serving the dead number.
    expect(body.fallback_active).toBe(true);
  });

  it("a rate that MOVES resets the clock, however slightly", async () => {
    // Guards against a detector that trips on any long-lived session rather
    // than on an actually-stuck value.
    vi.setSystemTime(new Date("2026-09-02T00:00:00Z"));
    const GET = await loadRoute();
    feeds(0.000616181090623589, 0.00064639);
    await GET();

    vi.setSystemTime(new Date("2026-09-02T00:10:00Z"));
    feeds(0.000616181090623590, 0.00064639); // last digit only
    await GET();

    vi.setSystemTime(new Date("2026-09-02T00:20:00Z"));
    const body = await (await GET()).json();
    expect(body.primary_frozen).toBe(false);
    expect(body.source).toBe("astrolescent");
  });

  it("serves the frozen rate when the fallback is ALSO down — but says so", async () => {
    // A stale number still beats a blank price on every display surface. What
    // is not acceptable is serving it while claiming health, which is exactly
    // what the route used to do.
    vi.setSystemTime(new Date("2026-09-02T00:00:00Z"));
    const GET = await loadRoute();
    feeds(0.000616181090623589, null);
    await GET();

    vi.setSystemTime(new Date("2026-09-02T00:16:00Z"));
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.rate).toBe(0.000616181090623589);
    expect(body.primary_frozen).toBe(true);
    expect(body.fallback_active).toBe(true);
  });

  it("never reports frozen on a first sighting, including after a restart", async () => {
    // With no history we cannot know. Declaring a freeze we have not observed
    // swaps one wrong answer for another.
    vi.setSystemTime(new Date("2026-09-02T09:00:00Z"));
    const GET = await loadRoute();
    feeds(0.000616181090623589, 0.00064639);
    const body = await (await GET()).json();
    expect(body.primary_frozen).toBe(false);
  });
});

/**
 * `stale` / `age_seconds` (added 2026-09-03, board note M5 / ruling R1).
 *
 * THE BUG THIS CLOSES. `use-xrd-usd.tsx` used to derive `stale` from
 * `staleness_seconds` — how long ago WE polled — against a 5-minute bar. The
 * route caches for only 60s, so that bar was essentially always false,
 * INCLUDING while `primary_frozen` said the served Astrolescent price had not
 * moved since before the halt: the route reported itself fresh by the only
 * signal the client was reading. `age_seconds` is the fix — it measures the
 * PRICE's own age, not our fetch clock — and `stale` is `age_seconds >= 30
 * min`, independent of `primary_frozen` (see the cases below for why they
 * must NOT be conflated).
 */
describe("GET /api/v1/quote/xrd-usd — stale / age_seconds", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Astrolescent answers `rate`; CoinGecko answers `cg` with the given
   *  `last_updated_at` (Unix seconds), or is down when `cg` is null. */
  function feedsWithTimestamp(
    rate: number,
    cg: number | null,
    cgLastUpdatedAt: number | null,
  ) {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("astrolescent")) {
        return Promise.resolve(jsonResponse({ ...ASTROLESCENT_BODY, tokenPriceUSD: rate }));
      }
      return cg === null
        ? Promise.resolve(jsonResponse({}, false))
        : Promise.resolve(
            jsonResponse({ radix: { usd: cg, last_updated_at: cgLastUpdatedAt } }),
          );
    });
  }

  it("a fresh Astrolescent rate on first sighting is not stale", async () => {
    vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
    const GET = await loadRoute();
    feedsWithTimestamp(0.000616181090623589, 0.00064639, null);

    const body = await (await GET()).json();
    expect(body.source).toBe("astrolescent");
    expect(body.stale).toBe(false);
    expect(body.age_seconds).toBe(0);
  });

  it("requests CoinGecko with include_last_updated_at=true", async () => {
    vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
    const GET = await loadRoute();
    // Astrolescent down -> CoinGecko is reached.
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("astrolescent")) return Promise.resolve(jsonResponse(null, false));
      return Promise.resolve(jsonResponse({ radix: { usd: 0.0006, last_updated_at: 1 } }));
    });
    await GET();

    const cgCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("coingecko"));
    expect(String(cgCall?.[0])).toContain("include_last_updated_at=true");
  });

  it("a CoinGecko rate whose own last_updated_at is > 30 min old is stale", async () => {
    const nowIso = "2026-09-03T01:00:00Z";
    vi.setSystemTime(new Date(nowIso));
    const nowSeconds = Math.floor(new Date(nowIso).getTime() / 1000);
    const GET = await loadRoute();
    // Astrolescent down outright -> CoinGecko is primary for this call.
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("astrolescent")) return Promise.resolve(jsonResponse(null, false));
      return Promise.resolve(
        jsonResponse({ radix: { usd: 0.00064639, last_updated_at: nowSeconds - 2400 } }),
      );
    });

    const body = await (await GET()).json();
    expect(body.source).toBe("coingecko");
    expect(body.age_seconds).toBe(2400);
    expect(body.stale).toBe(true);
  });

  it("a CoinGecko rate updated moments ago is not stale", async () => {
    const nowIso = "2026-09-03T01:00:00Z";
    vi.setSystemTime(new Date(nowIso));
    const nowSeconds = Math.floor(new Date(nowIso).getTime() / 1000);
    const GET = await loadRoute();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("astrolescent")) return Promise.resolve(jsonResponse(null, false));
      return Promise.resolve(
        jsonResponse({ radix: { usd: 0.00064639, last_updated_at: nowSeconds - 30 } }),
      );
    });

    const body = await (await GET()).json();
    expect(body.age_seconds).toBe(30);
    expect(body.stale).toBe(false);
  });

  it("primary_frozen true but CoinGecko covering it fresh -> NOT stale (decoupled from primary_frozen)", async () => {
    // This is the exact halt scenario: Astrolescent stops moving, CoinGecko
    // takes over and is itself fresh. The SERVED number is fine even though
    // the primary upstream is untrustworthy — conflating the two would hide
    // a working fallback behind an unrelated upstream-health signal.
    vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
    const GET = await loadRoute();
    feedsWithTimestamp(0.000616181090623589, 0.00064639, null);
    await GET();

    const t2 = new Date("2026-09-03T00:16:00Z"); // past the 15-min frozen window
    vi.setSystemTime(t2);
    const nowSeconds = Math.floor(t2.getTime() / 1000);
    feedsWithTimestamp(0.000616181090623589, 0.00064639, nowSeconds - 10);
    const body = await (await GET()).json();

    expect(body.source).toBe("coingecko");
    expect(body.primary_frozen).toBe(true);
    expect(body.age_seconds).toBe(10);
    expect(body.stale).toBe(false);
  });

  it("both feeds down and a frozen Astrolescent rate served past 30 min IS stale", async () => {
    vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
    const GET = await loadRoute();
    feedsWithTimestamp(0.000616181090623589, null, null); // CoinGecko down from the start
    await GET();

    // 31 minutes on, still the same Astrolescent rate, CoinGecko still down.
    vi.setSystemTime(new Date("2026-09-03T00:31:00Z"));
    const body = await (await GET()).json();

    expect(body.source).toBe("astrolescent");
    expect(body.primary_frozen).toBe(true);
    expect(body.age_seconds).toBe(31 * 60);
    expect(body.stale).toBe(true);
  });

  it("age_seconds keeps growing across the 60s cache TTL instead of resetting", async () => {
    // A price does not get younger just because it is being re-served from
    // cache — the elapsed wall-clock time must accumulate on top.
    vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
    const GET = await loadRoute();
    const nowSeconds = Math.floor(new Date("2026-09-03T00:00:00Z").getTime() / 1000);
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("astrolescent")) return Promise.resolve(jsonResponse(null, false));
      return Promise.resolve(
        jsonResponse({ radix: { usd: 0.0006, last_updated_at: nowSeconds - 100 } }),
      );
    });
    const first = await (await GET()).json();
    expect(first.age_seconds).toBe(100);

    // 30s later — inside the 60s cache TTL, so this is served from cache.
    vi.setSystemTime(new Date("2026-09-03T00:00:30Z"));
    const second = await (await GET()).json();
    expect(second.age_seconds).toBe(130);
    expect(fetchMock).toHaveBeenCalledTimes(2); // no new fetch on the cached read
  });
});
