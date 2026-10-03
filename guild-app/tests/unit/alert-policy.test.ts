/**
 * The alert policy (src/lib/alert-policy.ts) — pure decision function.
 *
 * The first test is THE NAMED DEFECT: the 2026-09-07 storm, four identical
 * pages at 05:40 / 05:50 / 06:01 / 06:12 for one unchanged condition. Under
 * the old 10-minute cooldown every one of those evaluations sent. Under this
 * policy exactly one does. A mutation that re-introduces level triggering
 * (e.g. `if (condition) return raise`) fails it.
 */
import { describe, expect, it } from "vitest";
import {
  decide,
  freshAlertState,
  nextReminderDue,
  reminderIntervalAfter,
  FLAP_WINDOW_MS,
  REMINDER_SCHEDULE_MS,
  REMINDER_STEADY_STATE_MS,
  type AlertState,
} from "@/lib/alert-core";

const H = 60 * 60_000;
const T0 = Date.parse("2026-09-07T05:40:00Z");

/** Drive the policy through a series of (offsetMs, condition, inhibitor) observations. */
function run(
  steps: Array<[number, boolean, string | null]>,
  start: AlertState | null = null,
) {
  let state = start;
  const actions: string[] = [];
  for (const [dt, condition, inhibitor] of steps) {
    const d = decide(state, "k", condition, T0 + dt, inhibitor);
    actions.push(d.action);
    if (d.changed) state = d.next;
  }
  return { actions, state: state! };
}

describe("alert policy — the named defect: a sustained condition pages once, not every 10 minutes", () => {
  it("05:40 / 05:50 / 06:01 / 06:12 with the condition unchanged → exactly one raise", () => {
    const { actions } = run([
      [0, true, null],
      [10 * 60_000, true, null],
      [21 * 60_000, true, null],
      [32 * 60_000, true, null],
    ]);
    expect(actions).toEqual(["raise", "none", "none", "none"]);
  });

  it("32 halted hours, evaluated every minute → raise + reminders at +1h, +6h, +24h after each other; nothing else", () => {
    const steps: Array<[number, boolean, string | null]> = [];
    for (let m = 0; m <= 32 * 60; m++) steps.push([m * 60_000, true, null]);
    const { actions } = run(steps);
    const sent = actions
      .map((a, i) => [a, i] as const)
      .filter(([a]) => a === "raise" || a === "remind")
      .map(([a, i]) => `${a}@${i}m`);
    // Each interval is measured from the previous MESSAGE: 0 → +60 → +360 → +1440.
    expect(sent).toEqual(["raise@0m", "remind@60m", "remind@420m", "remind@1860m"]);
    // 1921 evaluations, 4 messages. The old 10-minute cooldown would have sent ~193.
    expect(actions.length).toBe(1921);
  });

  it("after the schedule is exhausted, reminders settle to every 24h", () => {
    expect(reminderIntervalAfter(1)).toBe(REMINDER_SCHEDULE_MS[0]);
    expect(reminderIntervalAfter(2)).toBe(REMINDER_SCHEDULE_MS[1]);
    expect(reminderIntervalAfter(3)).toBe(REMINDER_SCHEDULE_MS[2]);
    expect(reminderIntervalAfter(4)).toBe(REMINDER_STEADY_STATE_MS);
    expect(reminderIntervalAfter(99)).toBe(REMINDER_STEADY_STATE_MS);
  });
});

describe("alert policy — edges", () => {
  it("clears with exactly one recovery message, then stays quiet", () => {
    const { actions } = run([
      [0, true, null],
      [5 * 60_000, true, null],
      [15 * 60_000, false, null],
      [20 * 60_000, false, null],
      [25 * 60_000, false, null],
    ]);
    expect(actions).toEqual(["raise", "none", "clear", "none", "none"]);
  });

  it("condition false with nothing open changes nothing (no write, no message)", () => {
    const d = decide(null, "k", false, T0, null);
    expect(d.action).toBe("none");
    expect(d.changed).toBe(false);
    expect(d.next).toEqual(freshAlertState("k"));
  });

  it("a re-raise within the flap window is still sent, and labelled flapping", () => {
    const { actions, state } = run([
      [0, true, null],
      [2 * 60_000, false, null], // clear at +2m
    ]);
    expect(actions).toEqual(["raise", "clear"]);
    const again = decide(state, "k", true, T0 + 2 * 60_000 + FLAP_WINDOW_MS - 1, null);
    expect(again.action).toBe("raise");
    expect(again.flapping).toBe(true);
    const later = decide(state, "k", true, T0 + 2 * 60_000 + FLAP_WINDOW_MS, null);
    expect(later.action).toBe("raise");
    expect(later.flapping).toBe(false);
  });

  it("every persisted decision bumps the version exactly once (optimistic concurrency)", () => {
    const { state } = run([
      [0, true, null],
      [1 * 60_000, true, null],
      [2 * 60_000, false, null],
    ]);
    expect(state.version).toBe(3);
  });

  it("counts the evaluations it swallowed, and resets the counter on each message", () => {
    const { state: mid } = run([
      [0, true, null],
      [10 * 60_000, true, null],
      [20 * 60_000, true, null],
    ]);
    expect(mid.suppressedCount).toBe(2);
    const reminded = decide(mid, "k", true, T0 + H, null);
    expect(reminded.action).toBe("remind");
    expect(reminded.reminderNumber).toBe(2);
    expect(reminded.next.suppressedCount).toBe(0);
    expect(nextReminderDue(reminded.next)).toBe(T0 + H + REMINDER_SCHEDULE_MS[1]);
  });
});

describe("alert policy — inhibition by a parent incident", () => {
  it("a raise while the parent is open is swallowed and recorded, not sent", () => {
    const d = decide(null, "k", true, T0, "network-halt");
    expect(d.action).toBe("suppress");
    expect(d.next.active).toBe(true);
    expect(d.next.sentCount).toBe(0);
    expect(d.next.inhibitedBy).toBe("network-halt");
    expect(d.next.since).toBe(T0);
  });

  it("stays swallowed for as long as the parent is open — never a reminder either", () => {
    const steps: Array<[number, boolean, string | null]> = [];
    for (let h = 0; h < 48; h++) steps.push([h * H, true, "network-halt"]);
    const { actions, state } = run(steps);
    expect(new Set(actions)).toEqual(new Set(["suppress"]));
    expect(state.suppressedCount).toBe(48);
    expect(state.sentCount).toBe(0);
  });

  it("when the parent clears, the still-open child is RAISED (first message), with its true start", () => {
    const { state } = run([
      [0, true, "network-halt"],
      [H, true, "network-halt"],
    ]);
    const d = decide(state, "k", true, T0 + 2 * H, null);
    expect(d.action).toBe("raise");
    expect(d.next.since).toBe(T0); // not re-stamped to now
    expect(d.next.sentCount).toBe(1);
    expect(d.next.inhibitedBy).toBeNull();
  });

  it("a never-announced child that clears does so silently", () => {
    const { actions } = run([
      [0, true, "network-halt"],
      [H, false, "network-halt"],
    ]);
    expect(actions).toEqual(["suppress", "none"]);
  });

  it("an announced incident that later becomes inhibited is silenced, and clears with a message", () => {
    const { actions } = run([
      [0, true, null], // raise
      [H, true, "network-halt"], // parent opened: suppress
      [2 * H, false, "network-halt"], // clear — it WAS announced
    ]);
    expect(actions).toEqual(["raise", "suppress", "clear"]);
  });
});
