/**
 * The alert orchestrator (src/lib/alerts.ts) against the memory store and a
 * mocked Telegram transport: what actually reaches the operator's chat.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateAlert,
  evaluateNetworkHalt,
  formatAlert,
  humanDuration,
  NETWORK_HALT_ALERT_KEY,
  GATEWAY_UNREACHABLE_ALERT_KEY,
} from "@/lib/alerts";
import { MemoryAlertStore } from "@/lib/alert-store";
import { NETWORK_HALT_AFTER_SECONDS } from "@/lib/gateway";

const T0 = Date.parse("2026-09-07T05:40:00Z");
const H = 60 * 60_000;

let store: MemoryAlertStore;
let fetchMock: ReturnType<typeof vi.fn>;

function sentTexts(): string[] {
  return fetchMock.mock.calls
    .filter(([u]) => String(u).includes("telegram.org"))
    .map(([, init]) => JSON.parse((init as { body: string }).body).text as string);
}
function sentBodies(): Array<{ text: string; disable_notification: boolean }> {
  return fetchMock.mock.calls
    .filter(([u]) => String(u).includes("telegram.org"))
    .map(([, init]) => JSON.parse((init as { body: string }).body));
}

beforeEach(() => {
  store = new MemoryAlertStore();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("KEEPER_ALERT_TG_TOKEN", "t");
  vi.stubEnv("KEEPER_ALERT_TG_CHAT", "c");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const frozen = (condition: boolean, now: number, inhibitedBy?: string) =>
  evaluateAlert({
    key: "quote-xrd-usd-frozen",
    condition,
    title: "Price feed: Astrolescent frozen — serving CoinGecko",
    detail: "Unchanged rate 0.000616 for over 15 min.",
    inhibitedBy,
    now,
    store,
  });

describe("evaluateAlert — the 2026-09-07 storm, end to end", () => {
  it("four evaluations at 05:40/05:50/06:01/06:12 → ONE Telegram message", async () => {
    expect(await frozen(true, T0)).toBe("raise");
    expect(await frozen(true, T0 + 10 * 60_000)).toBe("none");
    expect(await frozen(true, T0 + 21 * 60_000)).toBe("none");
    expect(await frozen(true, T0 + 32 * 60_000)).toBe("none");
    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toMatch(/^🔴 Price feed: Astrolescent frozen/);
    expect(sentTexts()[0]).toContain("key quote-xrd-usd-frozen");
    expect(sentTexts()[0]).toContain("since 2026-09-07T05:40:00Z");
  });

  it("the 1h reminder is SILENT and says how many checks it swallowed; the clear is loud", async () => {
    await frozen(true, T0);
    await frozen(true, T0 + 20 * 60_000);
    await frozen(true, T0 + 40 * 60_000);
    expect(await frozen(true, T0 + H)).toBe("remind");
    expect(await frozen(false, T0 + 2 * H)).toBe("clear");
    const bodies = sentBodies();
    expect(bodies).toHaveLength(3);
    expect(bodies[0].disable_notification).toBe(false);
    expect(bodies[1].disable_notification).toBe(true);
    expect(bodies[1].text).toMatch(/^🟠 STILL OPEN 1h 0m/);
    expect(bodies[1].text).toContain("reminder #2");
    expect(bodies[1].text).toContain("2 checks confirmed it since the last message");
    expect(bodies[1].text).toContain("next reminder in 6h 0m");
    expect(bodies[2].disable_notification).toBe(false);
    expect(bodies[2].text).toMatch(/^🟢 RESOLVED/);
    expect(bodies[2].text).toContain("was open 2h 0m");
  });

  it("condition false with nothing open sends nothing and writes nothing", async () => {
    expect(await frozen(false, T0)).toBe("none");
    expect(await store.get("quote-xrd-usd-frozen")).toBeNull();
    expect(sentTexts()).toHaveLength(0);
  });
});

describe("evaluateAlert — concurrency: the write is the permission to send", () => {
  it("two simultaneous first evaluations produce exactly one message", async () => {
    const [a, b] = await Promise.all([frozen(true, T0), frozen(true, T0)]);
    expect([a, b].sort()).toEqual(["lost-race", "raise"]);
    expect(sentTexts()).toHaveLength(1);
  });

  it("a state written by another process (higher version) is never overwritten", async () => {
    await frozen(true, T0);
    const mine = (await store.get("quote-xrd-usd-frozen"))!;
    // Someone else moved it on.
    await store.claim({ ...mine, version: mine.version + 1, suppressedCount: 99 }, mine.version);
    // Our stale read must lose.
    expect(await store.claim({ ...mine, version: mine.version + 1 }, mine.version)).toBe(false);
    expect((await store.get("quote-xrd-usd-frozen"))!.suppressedCount).toBe(99);
  });
});

describe("evaluateAlert — inhibition by the network-halt incident", () => {
  const halt = (condition: boolean, now: number) =>
    evaluateAlert({ key: NETWORK_HALT_ALERT_KEY, condition, title: "Radix mainnet halted", now, store });

  it("a frozen feed while the halt is open is swallowed; the halt's reminder lists it", async () => {
    expect(await halt(true, T0)).toBe("raise");
    expect(await frozen(true, T0 + 60_000, NETWORK_HALT_ALERT_KEY)).toBe("suppress");
    expect(await frozen(true, T0 + 30 * 60_000, NETWORK_HALT_ALERT_KEY)).toBe("suppress");
    expect(await halt(true, T0 + H)).toBe("remind");
    const texts = sentTexts();
    expect(texts).toHaveLength(2); // halt raise + halt reminder; nothing for the feed
    expect(texts[1]).toContain("Inhibited by this incident (1):");
    expect(texts[1]).toContain("quote-xrd-usd-frozen — open 59m, 2 checks swallowed");
  });

  it("when the halt clears and the feed is still frozen, the feed is raised once with its true start", async () => {
    await halt(true, T0);
    await frozen(true, T0 + 60_000, NETWORK_HALT_ALERT_KEY);
    expect(await halt(false, T0 + 3 * H)).toBe("clear");
    expect(await frozen(true, T0 + 3 * H + 60_000, NETWORK_HALT_ALERT_KEY)).toBe("raise");
    const last = sentTexts().at(-1)!;
    expect(last).toMatch(/^🔴 Price feed/);
    expect(last).toContain("already open 3h 0m — was inhibited by a parent incident");
  });

  it("a feed that was swallowed for the whole halt and recovers with it clears silently", async () => {
    await halt(true, T0);
    await frozen(true, T0 + 60_000, NETWORK_HALT_ALERT_KEY);
    await halt(false, T0 + H);
    expect(await frozen(false, T0 + H + 60_000, NETWORK_HALT_ALERT_KEY)).toBe("none");
    expect(sentTexts()).toHaveLength(2); // halt raise + halt clear only
  });
});

describe("evaluateNetworkHalt — derived from the ledger tip", () => {
  const tip = (ageSeconds: number, stale = false) => ({
    stateVersion: 557840622,
    tipIso: "2026-08-31T21:19:06Z",
    ageSeconds,
    stale,
  });

  it("raises once when the tip is older than the halt threshold, reminds silently, clears when it moves", async () => {
    const r1 = await evaluateNetworkHalt(tip(NETWORK_HALT_AFTER_SECONDS + 1), false, { now: T0, store });
    expect(r1.halt).toBe("raise");
    const r2 = await evaluateNetworkHalt(tip(NETWORK_HALT_AFTER_SECONDS + 600), false, { now: T0 + 10 * 60_000, store });
    expect(r2.halt).toBe("none");
    const r3 = await evaluateNetworkHalt(tip(5), false, { now: T0 + 20 * 60_000, store });
    expect(r3.halt).toBe("clear");
    const texts = sentTexts();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("Radix mainnet halted");
    expect(texts[0]).toContain("ledger tip 557840622 @ 2026-08-31T21:19:06Z");
    expect(texts[1]).toMatch(/^🟢 RESOLVED — Radix mainnet halted/);
  });

  it("no tip ever read (cold start) raises nothing — unknown is not halted", async () => {
    const r = await evaluateNetworkHalt(null, false, { now: T0, store });
    expect(r.halt).toBe("none");
    expect(r.gateway).toBe("none");
    expect(sentTexts()).toHaveLength(0);
  });

  it("a STALE (remembered) tip raises gateway-unreachable, not network-halt, and leaves an open halt alone", async () => {
    await evaluateNetworkHalt(tip(NETWORK_HALT_AFTER_SECONDS + 1), false, { now: T0, store });
    const r = await evaluateNetworkHalt(tip(NETWORK_HALT_AFTER_SECONDS + 9999, true), false, { now: T0 + H, store });
    expect(r.gateway).toBe("raise");
    expect(r.halt).toBe("none");
    expect((await store.get(NETWORK_HALT_ALERT_KEY))!.active).toBe(true);
    expect((await store.get(GATEWAY_UNREACHABLE_ALERT_KEY))!.active).toBe(true);
    expect(sentTexts().at(-1)).toContain("Gateway unreachable");
  });

  it("the operator lever alone (no tip) raises the halt", async () => {
    const r = await evaluateNetworkHalt(null, true, { now: T0, store });
    expect(r.halt).toBe("raise");
    expect(sentTexts()[0]).toContain("operator halt lever (GUILD_HALT) is ON");
  });
});

describe("failure modes never reach the caller", () => {
  it("unconfigured rail → send-failed, state still advanced (no re-raise storm on the next call)", async () => {
    vi.stubEnv("KEEPER_ALERT_TG_TOKEN", "");
    expect(await frozen(true, T0)).toBe("send-failed");
    expect(await frozen(true, T0 + 60_000)).toBe("none");
  });

  it("a store that throws → store-failed, nothing thrown", async () => {
    const broken = {
      get: async () => {
        throw new Error("pg down");
      },
      claim: async () => true,
      listInhibitedBy: async () => [],
    };
    await expect(
      evaluateAlert({ key: "k", condition: true, title: "t", now: T0, store: broken }),
    ).resolves.toBe("store-failed");
  });
});

describe("formatting helpers", () => {
  it("humanDuration", () => {
    expect(humanDuration(0)).toBe("0s");
    expect(humanDuration(59_000)).toBe("59s");
    expect(humanDuration(5 * 60_000)).toBe("5m");
    expect(humanDuration(H + 5 * 60_000)).toBe("1h 5m");
    expect(humanDuration(26 * H)).toBe("1d 2h");
  });

  it("a raise carries title, detail, since, key and the reminder contract", () => {
    const text = formatAlert(
      "raise",
      { key: "k", condition: true, title: "T", detail: "D" },
      { key: "k", active: true, since: T0, lastSentAt: T0, lastClearedAt: null, sentCount: 1, suppressedCount: 0, inhibitedBy: null, version: 1 },
      T0,
      { flapping: false, reminderNumber: null, suppressedBeforeThis: 0, openedAt: T0, inhibited: [] },
    );
    expect(text.split("\n")).toEqual([
      "🔴 T",
      "D",
      "since 2026-09-07T05:40:00Z · key k",
      "Reminders at 1h, 6h, 24h, then daily (silent). You will get a 🟢 when it clears.",
    ]);
  });
});
