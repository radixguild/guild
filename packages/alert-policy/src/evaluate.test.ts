/**
 * The evaluator against the memory store and a recording transport, plus the
 * SQLite store against an in-memory better-sqlite3-shaped fake.
 */
import { describe, expect, it } from "bun:test";
import { createAlertEvaluator, type AlertInput } from "./evaluate";
import { MemoryAlertStore, SqliteAlertStore, type AlertStore, type SqliteLike } from "./store";
import { humanDuration } from "./format";

const T0 = Date.parse("2026-09-07T05:40:00Z");
const H = 60 * 60_000;

function harness(store: AlertStore = new MemoryAlertStore()) {
  const sent: Array<{ text: string; silent: boolean }> = [];
  const evaluate = createAlertEvaluator({
    store,
    send: async (text, { silent }) => {
      sent.push({ text, silent });
      return true;
    },
    onError: () => {},
  });
  const frozen = (condition: boolean, now: number, inhibitedBy?: string) =>
    evaluate({
      key: "quote-xrd-usd-frozen",
      condition,
      title: "Price feed: Astrolescent frozen — serving CoinGecko",
      detail: "Unchanged rate for over 15 min.",
      inhibitedBy,
      now,
    });
  const halt = (condition: boolean, now: number) =>
    evaluate({ key: "network-halt", condition, title: "Radix mainnet halted", now });
  return { evaluate, sent, frozen, halt, store };
}

describe("the storm, end to end", () => {
  it("four evaluations at 05:40/05:50/06:01/06:12 → one message", async () => {
    const h = harness();
    expect(await h.frozen(true, T0)).toBe("raise");
    expect(await h.frozen(true, T0 + 10 * 60_000)).toBe("none");
    expect(await h.frozen(true, T0 + 21 * 60_000)).toBe("none");
    expect(await h.frozen(true, T0 + 32 * 60_000)).toBe("none");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text.startsWith("🔴 Price feed: Astrolescent frozen")).toBe(true);
    expect(h.sent[0].text).toContain("since 2026-09-07T05:40:00Z");
  });

  it("the 1h reminder is silent and counts swallowed checks; the clear is loud", async () => {
    const h = harness();
    await h.frozen(true, T0);
    await h.frozen(true, T0 + 20 * 60_000);
    await h.frozen(true, T0 + 40 * 60_000);
    expect(await h.frozen(true, T0 + H)).toBe("remind");
    expect(await h.frozen(false, T0 + 2 * H)).toBe("clear");
    expect(h.sent).toHaveLength(3);
    expect(h.sent[1].silent).toBe(true);
    expect(h.sent[1].text.startsWith("🟠 STILL OPEN 1h 0m")).toBe(true);
    expect(h.sent[1].text).toContain("2 checks confirmed it since the last message");
    expect(h.sent[2].silent).toBe(false);
    expect(h.sent[2].text).toContain("was open 2h 0m");
  });

  it("false with nothing open writes nothing", async () => {
    const h = harness();
    expect(await h.frozen(false, T0)).toBe("none");
    expect(await h.store.get("quote-xrd-usd-frozen")).toBeNull();
  });
});

describe("concurrency", () => {
  it("two simultaneous first evaluations → one message", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.frozen(true, T0), h.frozen(true, T0)]);
    expect([a, b].sort()).toEqual(["lost-race", "raise"]);
    expect(h.sent).toHaveLength(1);
  });
});

describe("inhibition", () => {
  it("a frozen feed during a halt is swallowed; the halt reminder lists it", async () => {
    const h = harness();
    expect(await h.halt(true, T0)).toBe("raise");
    expect(await h.frozen(true, T0 + 60_000, "network-halt")).toBe("suppress");
    expect(await h.frozen(true, T0 + 30 * 60_000, "network-halt")).toBe("suppress");
    expect(await h.halt(true, T0 + H)).toBe("remind");
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].text).toContain("Inhibited by this incident (1):");
    expect(h.sent[1].text).toContain("quote-xrd-usd-frozen — open 59m, 2 checks swallowed");
  });

  it("when the halt clears and the feed is still frozen, it is raised once with its true start", async () => {
    const h = harness();
    await h.halt(true, T0);
    await h.frozen(true, T0 + 60_000, "network-halt");
    expect(await h.halt(false, T0 + 3 * H)).toBe("clear");
    expect(await h.frozen(true, T0 + 3 * H + 60_000, "network-halt")).toBe("raise");
    expect(h.sent.at(-1)!.text).toContain("already open 3h 0m — was inhibited by a parent incident");
  });
});

describe("failure modes never reach the caller", () => {
  it("transport false → send-failed, state still advanced", async () => {
    const store = new MemoryAlertStore();
    const evaluate = createAlertEvaluator({ store, send: async () => false, onError: () => {} });
    const input: AlertInput = { key: "k", condition: true, title: "t", now: T0 };
    expect(await evaluate(input)).toBe("send-failed");
    expect(await evaluate({ ...input, now: T0 + 60_000 })).toBe("none");
  });

  it("a throwing store → store-failed, nothing thrown", async () => {
    const evaluate = createAlertEvaluator({
      store: {
        get: async () => {
          throw new Error("db down");
        },
        claim: async () => true,
        listInhibitedBy: async () => [],
      },
      send: async () => true,
      onError: () => {},
    });
    expect(await evaluate({ key: "k", condition: true, title: "t", now: T0 })).toBe("store-failed");
  });
});

/** A tiny better-sqlite3-shaped fake: enough SQL for the store's four statements. */
function fakeSqlite(): SqliteLike & { rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>();
  const cols = [
    "key", "active", "since", "last_sent_at", "last_cleared_at",
    "sent_count", "suppressed_count", "inhibited_by", "version", "updated_at",
  ];
  return {
    rows,
    exec() {},
    prepare(sql: string) {
      const s = sql.replace(/\s+/g, " ").trim();
      return {
        get(...p: unknown[]) {
          if (!s.startsWith("SELECT")) throw new Error("get on non-select");
          return rows.get(String(p[0]));
        },
        all(...p: unknown[]) {
          return [...rows.values()]
            .filter((r) => r.active === 1 && r.inhibited_by === p[0])
            .sort((a, b) => Number(a.since) - Number(b.since));
        },
        run(...p: unknown[]) {
          if (s.startsWith("INSERT OR IGNORE")) {
            const key = String(p[0]);
            if (rows.has(key)) return { changes: 0 };
            rows.set(key, Object.fromEntries(cols.map((c, i) => [c, p[i]])));
            return { changes: 1 };
          }
          if (s.startsWith("UPDATE")) {
            const key = String(p[9]);
            const expected = p[10];
            const row = rows.get(key);
            if (!row || row.version !== expected) return { changes: 0 };
            const next = Object.fromEntries(cols.slice(1).map((c, i) => [c, p[i]]));
            rows.set(key, { key, ...next });
            return { changes: 1 };
          }
          throw new Error("unexpected sql: " + s);
        },
      };
    },
  };
}

describe("SqliteAlertStore", () => {
  it("round-trips state and enforces the version check on claim", async () => {
    const db = fakeSqlite();
    const store = new SqliteAlertStore(db);
    expect(await store.get("k")).toBeNull();
    const h = harness(store);
    expect(await h.frozen(true, T0)).toBe("raise");
    const s1 = (await store.get("quote-xrd-usd-frozen"))!;
    expect(s1.active).toBe(true);
    expect(s1.since).toBe(T0);
    expect(s1.version).toBe(1);
    // A stale writer (expects version 0) loses.
    expect(await store.claim({ ...s1, version: 2, suppressedCount: 99 }, 0)).toBe(false);
    expect((await store.get("quote-xrd-usd-frozen"))!.suppressedCount).toBe(0);
    // Inhibited children are listable for the parent's reminder.
    await h.halt(true, T0 + 1);
    await h.evaluate({ key: "child", condition: true, title: "c", inhibitedBy: "network-halt", now: T0 + 2 });
    const kids = await store.listInhibitedBy("network-halt");
    expect(kids.map((k) => k.key)).toEqual(["child"]);
  });
});

describe("humanDuration", () => {
  it("formats", () => {
    expect(humanDuration(59_000)).toBe("59s");
    expect(humanDuration(5 * 60_000)).toBe("5m");
    expect(humanDuration(H + 5 * 60_000)).toBe("1h 5m");
    expect(humanDuration(26 * H)).toBe("1d 2h");
  });
});
