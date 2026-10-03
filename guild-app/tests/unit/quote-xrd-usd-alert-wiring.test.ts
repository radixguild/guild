/**
 * Route-level proof for the 2026-09-07 alert storm.
 *
 * Drives GET /api/v1/quote/xrd-usd through the real policy + memory store with
 * Astrolescent answering the SAME rate on every pass (the halt signature) and
 * asserts what reaches Telegram: one 🔴 when the freeze is detected, nothing on
 * the next uncached passes, one 🟢 when the rate moves again. Under the old
 * per-process cooldown the same drive produced a message every ten minutes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetAlertStoresForTests } from "@/lib/alert-store";

const FROZEN_RATE = 0.000616181090623589;

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

describe("quote route × alert policy — a frozen primary pages once, then recovers once", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    _resetAlertStoresForTests();
    vi.useFakeTimers();
    vi.stubEnv("KEEPER_ALERT_TG_TOKEN", "t");
    vi.stubEnv("KEEPER_ALERT_TG_CHAT", "c");
    vi.stubEnv("DATABASE_URL", ""); // memory store
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /** Astrolescent answers `rate`; CoinGecko answers; Telegram accepts; the Gateway is down (no tip → no halt incident). */
  function feeds(rate: number) {
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("astrolescent")) return Promise.resolve(jsonResponse({ tokenPriceUSD: rate }));
      if (u.includes("coingecko")) return Promise.resolve(jsonResponse({ radix: { usd: 0.00055, last_updated_at: 1 } }));
      if (u.includes("telegram.org")) return Promise.resolve(jsonResponse({ ok: true }));
      return Promise.resolve(jsonResponse(null, false)); // gateway-status → stale/null tip
    });
  }

  const telegram = () =>
    fetchMock.mock.calls
      .filter(([u]) => String(u).includes("telegram.org"))
      .map(([, init]) => JSON.parse((init as { body: string }).body) as { text: string; disable_notification: boolean });

  it("05:40 first sighting · 05:56 frozen (🔴) · 06:06 / 06:17 / 06:28 silent · 06:40 rate moves (🟢)", async () => {
    vi.setSystemTime(new Date("2026-09-07T05:40:00Z"));
    const { GET } = await import("@/app/api/v1/quote/xrd-usd/route");
    feeds(FROZEN_RATE);

    // First sighting: no history, cannot be called frozen.
    let body = await (await GET()).json();
    expect(body.primary_frozen).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(telegram()).toHaveLength(0);

    // 16 min later, still the same byte-identical rate → frozen → ONE raise.
    vi.setSystemTime(new Date("2026-09-07T05:56:00Z"));
    body = await (await GET()).json();
    expect(body.primary_frozen).toBe(true);
    expect(body.source).toBe("coingecko");
    await vi.advanceTimersByTimeAsync(1);
    expect(telegram()).toHaveLength(1);
    expect(telegram()[0].text).toMatch(/^🔴 Price feed: Astrolescent frozen/);
    expect(telegram()[0].disable_notification).toBe(false);

    // The storm: three more uncached passes inside the hour. Nothing sent.
    for (const t of ["06:06", "06:17", "06:28"]) {
      vi.setSystemTime(new Date(`2026-09-07T${t}:00Z`));
      body = await (await GET()).json();
      expect(body.primary_frozen).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(telegram()).toHaveLength(1);
    }

    // The rate moves: healthy path → ONE recovery notice, loud.
    vi.setSystemTime(new Date("2026-09-07T06:40:00Z"));
    feeds(FROZEN_RATE * 1.01);
    body = await (await GET()).json();
    expect(body.primary_frozen).toBe(false);
    expect(body.source).toBe("astrolescent");
    await vi.advanceTimersByTimeAsync(1);
    expect(telegram()).toHaveLength(2);
    expect(telegram()[1].text).toMatch(/^🟢 RESOLVED — Price feed: Astrolescent frozen/);
    expect(telegram()[1].text).toContain("was open 44m");
    expect(telegram()[1].disable_notification).toBe(false);

    // And healthy passes afterwards stay silent.
    vi.setSystemTime(new Date("2026-09-07T06:50:00Z"));
    await GET();
    await vi.advanceTimersByTimeAsync(1);
    expect(telegram()).toHaveLength(2);
  });
});
