/**
 * Route-level proof for the 2026-09-07 alert storm, and for the 2026-11-19
 * 🔴/🟢 flap.
 *
 * Drives GET /api/v1/quote/xrd-usd through the real policy + memory store and
 * asserts what reaches Telegram.
 *
 *   1. Storm (2026-09-07): Astrolescent answers the SAME rate on every pass
 *      (the halt signature). One 🔴 once the freeze has held past the
 *      debounce, nothing on the next uncached passes, one 🟢 when the rate
 *      moves again. Under the old per-process cooldown the same drive produced
 *      a message every ten minutes.
 *   2. Flap (2026-11-19): Astrolescent updates about every 16 minutes, just
 *      past the 15-minute frozen detector, so the detector trips and clears
 *      once per update. Without the debounce each cycle sent a loud 🔴 and a
 *      🟢; with it the cycle closes silently, and only a rate that stays
 *      unchanged for 30+ minutes (detector 15 + debounce 15) pages.
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

  it("05:40 first sighting · 05:56 frozen (held) · 06:06 held · 06:17 🔴 · 06:28 silent · 06:40 rate moves (🟢)", async () => {
    vi.setSystemTime(new Date("2026-09-07T05:40:00Z"));
    const { GET } = await import("@/app/api/v1/quote/xrd-usd/route");
    feeds(FROZEN_RATE);

    // First sighting: no history, cannot be called frozen.
    let body = await (await GET()).json();
    expect(body.primary_frozen).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(telegram()).toHaveLength(0);

    // 16 min later, still the same byte-identical rate → frozen, and serving
    // switches to CoinGecko at once. The ALERT is held: the freeze has not
    // yet lasted the 15-minute debounce.
    vi.setSystemTime(new Date("2026-09-07T05:56:00Z"));
    body = await (await GET()).json();
    expect(body.primary_frozen).toBe(true);
    expect(body.source).toBe("coingecko");
    await vi.advanceTimersByTimeAsync(1);
    expect(telegram()).toHaveLength(0);

    // 10 min into the freeze: still held.
    vi.setSystemTime(new Date("2026-09-07T06:06:00Z"));
    body = await (await GET()).json();
    expect(body.primary_frozen).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(telegram()).toHaveLength(0);

    // 21 min into the freeze (37 min unchanged) → past the debounce → ONE raise.
    vi.setSystemTime(new Date("2026-09-07T06:17:00Z"));
    body = await (await GET()).json();
    expect(body.primary_frozen).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(telegram()).toHaveLength(1);
    expect(telegram()[0].text).toMatch(/^🔴 Price feed: Astrolescent frozen/);
    expect(telegram()[0].text).toContain("held to confirm it was not a blip");
    expect(telegram()[0].disable_notification).toBe(false);

    // The storm: another uncached pass inside the hour. Nothing sent.
    vi.setSystemTime(new Date("2026-09-07T06:28:00Z"));
    body = await (await GET()).json();
    expect(body.primary_frozen).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(telegram()).toHaveLength(1);

    // The rate moves: healthy path → ONE recovery notice, loud. "was open"
    // counts from the TRUE start of the freeze (05:56), not from the raise.
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

  const MIN = 60_000;

  /** One uncached pass per minute (the cache TTL is 60s), `minutes` times. */
  async function passEveryMinute(GET: () => Promise<Response>, start: number, minutes: number) {
    const sources: string[] = [];
    for (let m = 0; m < minutes; m++) {
      vi.setSystemTime(start + m * MIN);
      sources.push((await (await GET()).json()).source);
      await vi.advanceTimersByTimeAsync(1);
    }
    return sources;
  }

  it("a rate that changes every 16 min for six cycles sends ZERO messages (the 2026-11-19 flap)", async () => {
    const t0 = Date.parse("2026-11-18T12:00:00Z");
    vi.setSystemTime(t0);
    const { GET } = await import("@/app/api/v1/quote/xrd-usd/route");

    const sources: string[] = [];
    for (let cycle = 0; cycle < 6; cycle++) {
      // A distinct rate per cycle, held for 16 minutes, then the next one.
      feeds(FROZEN_RATE * (1 + 0.001 * cycle));
      sources.push(...(await passEveryMinute(GET, t0 + cycle * 16 * MIN, 16)));
    }

    // The detector still trips at minute 15 of each cycle, and serving still
    // switches to CoinGecko for that pass: the debounce touches only the alert.
    expect(sources.filter((s) => s === "coingecko")).toHaveLength(6);
    expect(telegram()).toHaveLength(0);
  });

  it("a rate unchanged for 30+ min sends exactly one 🔴, then one 🟢 when it moves", async () => {
    const t0 = Date.parse("2026-11-18T12:00:00Z");
    vi.setSystemTime(t0);
    const { GET } = await import("@/app/api/v1/quote/xrd-usd/route");
    feeds(FROZEN_RATE);

    // Minutes 0..29: frozen from minute 15, held by the debounce through 29.
    await passEveryMinute(GET, t0, 30);
    expect(telegram()).toHaveLength(0);

    // Minutes 30..39: the freeze has now held 15 min → ONE loud raise, then quiet.
    await passEveryMinute(GET, t0 + 30 * MIN, 10);
    expect(telegram()).toHaveLength(1);
    expect(telegram()[0].text).toMatch(/^🔴 Price feed: Astrolescent frozen/);
    expect(telegram()[0].disable_notification).toBe(false);

    // Minute 40: the rate moves → ONE recovery, then healthy passes stay silent.
    feeds(FROZEN_RATE * 1.01);
    await passEveryMinute(GET, t0 + 40 * MIN, 5);
    expect(telegram()).toHaveLength(2);
    expect(telegram()[1].text).toMatch(/^🟢 RESOLVED — Price feed: Astrolescent frozen/);
  });
});
