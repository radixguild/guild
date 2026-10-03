/**
 * Unit tests for the keeper-rail TG alert helper (src/lib/tg-alert.ts)
 * and its wiring into the xrd-usd quote route's two failure branches.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendKeeperAlert, _resetAlertCooldowns } from "@/lib/tg-alert";

const TOKEN = "test-token";
const CHAT = "12345";

function mockFetchOk() {
  const fn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  _resetAlertCooldowns();
  vi.stubEnv("KEEPER_ALERT_TG_TOKEN", TOKEN);
  vi.stubEnv("KEEPER_ALERT_TG_CHAT", CHAT);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("sendKeeperAlert", () => {
  it("sends via the Telegram bot API when configured", async () => {
    const fetchMock = mockFetchOk();
    const sent = await sendKeeperAlert("k1", "hello");
    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(init.body)).toMatchObject({ chat_id: CHAT, text: "hello" });
  });

  it("no-ops when KEEPER_ALERT_TG_* are unset", async () => {
    vi.stubEnv("KEEPER_ALERT_TG_TOKEN", "");
    vi.stubEnv("KEEPER_ALERT_TG_CHAT", "");
    const fetchMock = mockFetchOk();
    expect(await sendKeeperAlert("k1", "hello")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throttles repeat alerts on the same key within the cooldown", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchOk();
    expect(await sendKeeperAlert("k1", "first")).toBe(true);
    expect(await sendKeeperAlert("k1", "second")).toBe(false);
    vi.advanceTimersByTime(9 * 60_000);
    expect(await sendKeeperAlert("k1", "third")).toBe(false);
    vi.advanceTimersByTime(2 * 60_000); // now 11 min after first
    expect(await sendKeeperAlert("k1", "fourth")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("tracks cooldowns per key independently", async () => {
    const fetchMock = mockFetchOk();
    expect(await sendKeeperAlert("stale", "a")).toBe(true);
    expect(await sendKeeperAlert("failclosed", "b")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never throws when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(sendKeeperAlert("k1", "x")).resolves.toBe(false);
  });

  it("returns false on non-OK Telegram responses without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await sendKeeperAlert("k1", "x")).toBe(false);
  });
});

describe("xrd-usd quote route alert wiring", () => {
  // The route holds a module-level cache, so import it fresh per test and
  // drive it through fetch mocks: feeds up first (seeds cache), then down.
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadRoute() {
    return await import("@/app/api/v1/quote/xrd-usd/route");
  }

  function feedResponses(opts: { astro: boolean; cg: boolean }) {
    return vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("telegram.org")) return { ok: true, json: async () => ({}) };
      if (url.includes("astrolescent")) {
        return opts.astro
          ? { ok: true, json: async () => ({ tokenPriceUSD: 0.02 }) }
          : { ok: false };
      }
      if (url.includes("coingecko")) {
        return opts.cg
          ? { ok: true, json: async () => ({ radix: { usd: 0.02 } }) }
          : { ok: false };
      }
      return { ok: false };
    });
  }

  it("stale-serve branch fires the TG alert", async () => {
    vi.useFakeTimers();
    const fetchMock = feedResponses({ astro: true, cg: true });
    vi.stubGlobal("fetch", fetchMock);
    const route = await loadRoute();

    // Seed the cache with a good fetch.
    let res = await route.GET();
    expect(res.status).toBe(200);

    // Jump past cache TTL + outage threshold but inside the 15 min hard cap.
    vi.setSystemTime(Date.now() + 7 * 60_000);
    fetchMock.mockImplementation(feedResponses({ astro: false, cg: false }).getMockImplementation()!);

    res = await route.GET();
    expect(res.status).toBe(200); // stale-served
    const body = await res.json();
    expect(body.staleness_seconds).toBeGreaterThan(300);

    await vi.waitFor(() => {
      const tgCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("telegram.org"));
      expect(tgCalls).toHaveLength(1);
      expect(JSON.parse(tgCalls[0][1].body).text).toContain("STALE");
    });
  });

  it("503 fail-closed branch fires the TG alert", async () => {
    const fetchMock = feedResponses({ astro: false, cg: false });
    vi.stubGlobal("fetch", fetchMock);
    const route = await loadRoute();

    const res = await route.GET(); // no cache at all -> fail closed
    expect(res.status).toBe(503);

    await vi.waitFor(() => {
      const tgCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("telegram.org"));
      expect(tgCalls).toHaveLength(1);
      expect(JSON.parse(tgCalls[0][1].body).text).toContain("fail-closed");
    });
  });
});
