/**
 * rolling-window.ts — the volume-threshold rule.
 *
 * Three things this file has to prove, per the mint-volume-watch consumer
 * (guild-app/scripts/mint-volume-watch.mjs, catalogue P1-15): window
 * arithmetic (which timestamps count), threshold crossing (when the count
 * becomes an alert condition), and that composing the two with `decide()`
 * from policy.ts produces the same raise → remind → clear lifecycle every
 * other consumer of this package gets, driven by real (synthetic) volume
 * data rather than a hand-toggled boolean.
 */
import { describe, expect, it } from "bun:test";
import { countInWindow, crossesThreshold, rollingThresholdCondition } from "./rolling-window";
import { decide, type AlertState } from "./policy";

const H = 60 * 60_000;
const NOW = Date.parse("2026-09-15T12:00:00Z");

describe("countInWindow", () => {
  it("is 0 for an empty list", () => {
    expect(countInWindow([], 24 * H, NOW)).toBe(0);
  });

  it("counts every timestamp strictly inside the window", () => {
    const ts = [NOW - H, NOW - 2 * H, NOW - 23 * H];
    expect(countInWindow(ts, 24 * H, NOW)).toBe(3);
  });

  it("excludes a timestamp older than the window by 1ms", () => {
    const ts = [NOW - 24 * H - 1];
    expect(countInWindow(ts, 24 * H, NOW)).toBe(0);
  });

  it("includes a timestamp exactly `windowMs` old — inclusive lower bound", () => {
    const ts = [NOW - 24 * H];
    expect(countInWindow(ts, 24 * H, NOW)).toBe(1);
  });

  it("includes a timestamp exactly `now` — inclusive upper bound", () => {
    expect(countInWindow([NOW], 24 * H, NOW)).toBe(1);
  });

  it("excludes a timestamp after `now` (clock skew never counts as recent)", () => {
    expect(countInWindow([NOW + 1], 24 * H, NOW)).toBe(0);
  });

  it("counts a duplicate timestamp once per occurrence in the array (the caller controls de-duplication)", () => {
    const ts = [NOW - H, NOW - H, NOW - H];
    expect(countInWindow(ts, 24 * H, NOW)).toBe(3);
  });

  it("mixes in- and out-of-window timestamps correctly", () => {
    const ts = [NOW - H, NOW - 25 * H, NOW - 10 * H, NOW - 100 * H];
    expect(countInWindow(ts, 24 * H, NOW)).toBe(2);
  });
});

describe("crossesThreshold", () => {
  it("is false one below the threshold", () => {
    expect(crossesThreshold(19, 20)).toBe(false);
  });

  it("is true exactly at the threshold — inclusive", () => {
    expect(crossesThreshold(20, 20)).toBe(true);
  });

  it("is true above the threshold", () => {
    expect(crossesThreshold(21, 20)).toBe(true);
  });

  it("a threshold of 0 always crosses, even at zero volume", () => {
    expect(crossesThreshold(0, 0)).toBe(true);
  });
});

describe("rollingThresholdCondition", () => {
  it("composes count + threshold into one decision", () => {
    const ts = [NOW - H, NOW - 2 * H, NOW - 3 * H];
    const under = rollingThresholdCondition({ timestampsMs: ts, windowMs: 24 * H, threshold: 4, now: NOW });
    expect(under).toEqual({ count: 3, condition: false });

    const over = rollingThresholdCondition({ timestampsMs: ts, windowMs: 24 * H, threshold: 3, now: NOW });
    expect(over).toEqual({ count: 3, condition: true });
  });

  it("ignores timestamps outside the window when counting toward the threshold", () => {
    const ts = [NOW - H, NOW - 30 * H, NOW - 40 * H];
    const r = rollingThresholdCondition({ timestampsMs: ts, windowMs: 24 * H, threshold: 2, now: NOW });
    expect(r.count).toBe(1);
    expect(r.condition).toBe(false);
  });
});

describe("composed with decide(): the mint-volume rule's raise/remind/clear lifecycle", () => {
  it("raises once volume crosses the threshold, reminds on the standard schedule, and clears once the mints age out of the window", () => {
    const THRESHOLD = 3;
    const WINDOW = 2 * H;
    // Three mints, all within the 2h window as of T0.
    const mints = [NOW - 30 * 60_000, NOW - 20 * 60_000, NOW - 10 * 60_000];
    let state: AlertState | null = null;

    // T0: 3 mints in the last 2h >= threshold 3 → RAISE.
    let r = rollingThresholdCondition({ timestampsMs: mints, windowMs: WINDOW, threshold: THRESHOLD, now: NOW });
    expect(r).toEqual({ count: 3, condition: true });
    let d = decide(state, "mint-volume", r.condition, NOW, null);
    expect(d.action).toBe("raise");
    state = d.next;

    // T0 + 1h: same 3 mints still fall inside the 2h window → still over
    // threshold, and the 1h reminder is due → REMIND (silent).
    const t1 = NOW + H;
    r = rollingThresholdCondition({ timestampsMs: mints, windowMs: WINDOW, threshold: THRESHOLD, now: t1 });
    expect(r.condition).toBe(true);
    d = decide(state, "mint-volume", r.condition, t1, null);
    expect(d.action).toBe("remind");
    expect(d.reminderNumber).toBe(2);
    state = d.next;

    // T0 + 3h: the 2h window has rolled past all three mints (the oldest was
    // 30min before T0, so it ages out at T0+1h30m) → count drops to 0,
    // condition false → CLEAR.
    const t2 = NOW + 3 * H;
    r = rollingThresholdCondition({ timestampsMs: mints, windowMs: WINDOW, threshold: THRESHOLD, now: t2 });
    expect(r).toEqual({ count: 0, condition: false });
    d = decide(state, "mint-volume", r.condition, t2, null);
    expect(d.action).toBe("clear");
  });

  it("a burst that never reaches the threshold never raises, at any tick", () => {
    const mints = [NOW - H, NOW - 90 * 60_000];
    const r = rollingThresholdCondition({ timestampsMs: mints, windowMs: 24 * H, threshold: 20, now: NOW });
    expect(r.condition).toBe(false);
    const d = decide(null, "mint-volume", r.condition, NOW, null);
    expect(d.action).toBe("none");
    expect(d.changed).toBe(false);
  });
});
