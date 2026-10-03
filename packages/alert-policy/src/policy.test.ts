/**
 * The policy — pure decision function.
 *
 * The first test is THE NAMED DEFECT: the 2026-09-07 storm on the Guild rail,
 * four identical pages at 05:40 / 05:50 / 06:01 / 06:12 for one unchanged
 * condition. Under a 10-minute cooldown every evaluation sent. Under this
 * policy exactly one does. Re-introducing level triggering fails it.
 */
import { describe, expect, it } from "bun:test";
import {
  decide,
  freshAlertState,
  nextReminderDue,
  reminderIntervalAfter,
  FLAP_WINDOW_MS,
  REMINDER_SCHEDULE_MS,
  REMINDER_STEADY_STATE_MS,
  type AlertState,
} from "./policy";

const H = 60 * 60_000;
const T0 = Date.parse("2026-09-07T05:40:00Z");

function run(steps: Array<[number, boolean, string | null]>, start: AlertState | null = null) {
  let state = start;
  const actions: string[] = [];
  for (const [dt, condition, inhibitor] of steps) {
    const d = decide(state, "k", condition, T0 + dt, inhibitor);
    actions.push(d.action);
    if (d.changed) state = d.next;
  }
  return { actions, state: state! };
}

describe("the named defect: a sustained condition pages once, not every 10 minutes", () => {
  it("05:40 / 05:50 / 06:01 / 06:12 unchanged → exactly one raise", () => {
    const { actions } = run([
      [0, true, null],
      [10 * 60_000, true, null],
      [21 * 60_000, true, null],
      [32 * 60_000, true, null],
    ]);
    expect(actions).toEqual(["raise", "none", "none", "none"]);
  });

  it("32 halted hours evaluated every minute → raise + reminders at +1h, +6h, +24h; nothing else", () => {
    const steps: Array<[number, boolean, string | null]> = [];
    for (let m = 0; m <= 32 * 60; m++) steps.push([m * 60_000, true, null]);
    const { actions } = run(steps);
    const sent = actions
      .map((a, i) => [a, i] as const)
      .filter(([a]) => a === "raise" || a === "remind")
      .map(([a, i]) => `${a}@${i}m`);
    expect(sent).toEqual(["raise@0m", "remind@60m", "remind@420m", "remind@1860m"]);
    expect(actions.length).toBe(1921);
  });

  it("after the schedule, reminders settle to every 24h", () => {
    expect(reminderIntervalAfter(1)).toBe(REMINDER_SCHEDULE_MS[0]);
    expect(reminderIntervalAfter(3)).toBe(REMINDER_SCHEDULE_MS[2]);
    expect(reminderIntervalAfter(4)).toBe(REMINDER_STEADY_STATE_MS);
    expect(reminderIntervalAfter(99)).toBe(REMINDER_STEADY_STATE_MS);
  });
});

describe("edges", () => {
  it("clears with exactly one recovery, then stays quiet", () => {
    const { actions } = run([
      [0, true, null],
      [5 * 60_000, true, null],
      [15 * 60_000, false, null],
      [20 * 60_000, false, null],
    ]);
    expect(actions).toEqual(["raise", "none", "clear", "none"]);
  });

  it("false with nothing open changes nothing", () => {
    const d = decide(null, "k", false, T0, null);
    expect(d.action).toBe("none");
    expect(d.changed).toBe(false);
    expect(d.next).toEqual(freshAlertState("k"));
  });

  it("a re-raise inside the flap window is sent and labelled", () => {
    const { state } = run([
      [0, true, null],
      [2 * 60_000, false, null],
    ]);
    const again = decide(state, "k", true, T0 + 2 * 60_000 + FLAP_WINDOW_MS - 1, null);
    expect(again.action).toBe("raise");
    expect(again.flapping).toBe(true);
    const later = decide(state, "k", true, T0 + 2 * 60_000 + FLAP_WINDOW_MS, null);
    expect(later.flapping).toBe(false);
  });

  it("every persisted decision bumps version once", () => {
    const { state } = run([
      [0, true, null],
      [60_000, true, null],
      [120_000, false, null],
    ]);
    expect(state.version).toBe(3);
  });

  it("counts swallowed evaluations and resets on each message", () => {
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

describe("inhibition", () => {
  it("a raise while the parent is open is swallowed and recorded", () => {
    const d = decide(null, "k", true, T0, "network-halt");
    expect(d.action).toBe("suppress");
    expect(d.next.active).toBe(true);
    expect(d.next.sentCount).toBe(0);
    expect(d.next.inhibitedBy).toBe("network-halt");
  });

  it("stays swallowed while the parent is open — never a reminder", () => {
    const steps: Array<[number, boolean, string | null]> = [];
    for (let h = 0; h < 48; h++) steps.push([h * H, true, "network-halt"]);
    const { actions, state } = run(steps);
    expect(new Set(actions)).toEqual(new Set(["suppress"]));
    expect(state.suppressedCount).toBe(48);
  });

  it("when the parent clears, the still-open child is raised with its true start", () => {
    const { state } = run([
      [0, true, "network-halt"],
      [H, true, "network-halt"],
    ]);
    const d = decide(state, "k", true, T0 + 2 * H, null);
    expect(d.action).toBe("raise");
    expect(d.next.since).toBe(T0);
    expect(d.next.sentCount).toBe(1);
  });

  it("a never-announced child clears silently", () => {
    const { actions } = run([
      [0, true, "network-halt"],
      [H, false, "network-halt"],
    ]);
    expect(actions).toEqual(["suppress", "none"]);
  });
});

/**
 * THE SECOND NAMED DEFECT: the 2026-09-17 escrow-watcher flap on the Guild
 * rail. The watcher polls the Gateway every 60s and observes the condition on
 * every poll. One Cloudflare 502, or one 5s fetch timeout, produced a 🔴 and
 * then a 🟢 five to fifty-seven seconds later — three pairs in one morning,
 * six push notifications, nothing for the operator to do about any of them.
 *
 * Both halves of the pair have to go. Suppressing only the raise would leave
 * an orphan recovery; suppressing only the recovery would leave a 🔴 that
 * never closes. The debounce does both, because an incident that never
 * announced itself already closes silently.
 */
describe("debounce: a condition must hold before it is worth waking someone", () => {
  const POLL = 60_000;
  const DEBOUNCE = 5 * 60_000;

  function runD(
    steps: Array<[number, boolean]>,
    debounceMs = DEBOUNCE,
    start: AlertState | null = null,
  ) {
    let state = start;
    const actions: string[] = [];
    for (const [dt, condition] of steps) {
      const d = decide(state, "escrow-watcher-gateway", condition, T0 + dt, null, debounceMs);
      actions.push(d.action);
      if (d.changed) state = d.next;
    }
    return { actions, state: state! };
  }

  it("the real flap: one bad poll then a good one sends NOTHING at all", () => {
    const { actions } = runD([
      [0, true],
      [8_000, false],
    ]);
    expect(actions).toEqual(["pend", "none"]);
  });

  it("three such flaps in a morning still send nothing", () => {
    const { actions } = runD([
      [0, true],
      [57_000, false],
      [3 * 3600_000, true],
      [3 * 3600_000 + 5_000, false],
      [6 * 3600_000, true],
      [6 * 3600_000 + 8_000, false],
    ]);
    expect(actions.filter((a) => a === "raise" || a === "clear")).toEqual([]);
  });

  it("a genuine outage still pages — once — after the hold, and recovers", () => {
    const steps: Array<[number, boolean]> = [];
    for (let i = 0; i <= 10; i++) steps.push([i * POLL, true]);
    steps.push([11 * POLL, false]);
    const { actions } = runD(steps);
    expect(actions.filter((a) => a === "raise")).toHaveLength(1);
    expect(actions.filter((a) => a === "clear")).toHaveLength(1);
    // Held for the first five polls (0..4 min), raised on the sixth (5 min).
    expect(actions.indexOf("raise")).toBe(5);
  });

  it("the raise reports the TRUE start, not the moment it was released", () => {
    const steps: Array<[number, boolean]> = [];
    for (let i = 0; i <= 5; i++) steps.push([i * POLL, true]);
    const { state } = runD(steps);
    expect(state.since).toBe(T0);
    expect(state.sentCount).toBe(1);
    expect(state.lastSentAt).toBe(T0 + 5 * POLL);
  });

  it("says WHY it arrived late, so 'already open 5m' does not read as a stuck alerter", () => {
    let state: AlertState | null = null;
    let last = decide(null, "k", true, T0, null, DEBOUNCE);
    state = last.next;
    for (let i = 1; i <= 5; i++) {
      last = decide(state, "k", true, T0 + i * POLL, null, DEBOUNCE);
      if (last.changed) state = last.next;
    }
    expect(last.action).toBe("raise");
    expect(last.heldBy).toBe("debounce");
  });

  it("an inhibited-from-birth raise is still labelled 'inhibited', not 'debounce'", () => {
    // Parent open for the first observation, gone by the second.
    const a = decide(null, "k", true, T0, "parent", DEBOUNCE);
    expect(a.action).toBe("suppress");
    const b = decide(a.next, "k", true, T0 + 30 * 60_000, null, DEBOUNCE);
    expect(b.action).toBe("raise");
    expect(b.heldBy).toBe("inhibited");
  });

  it("debounceMs 0 is byte-for-byte the old behaviour", () => {
    const withZero = decide(null, "k", true, T0, null, 0);
    const withNone = decide(null, "k", true, T0, null);
    expect(withZero).toEqual(withNone);
    expect(withZero.action).toBe("raise");
  });

  it("a flap that finally holds is still labelled as flapping", () => {
    // Raise, clear, then re-open and hold past the debounce, all inside the
    // 10-minute flap window: the operator must still see it is toggling.
    const first = decide(null, "k", true, T0, null, 0);
    const cleared = decide(first.next, "k", false, T0 + 60_000, null, 0);
    const steps: Array<[number, boolean]> = [];
    for (let i = 0; i <= 5; i++) steps.push([2 * 60_000 + i * POLL, true]);
    let state: AlertState | null = cleared.next;
    let last = null as ReturnType<typeof decide> | null;
    for (const [dt, cond] of steps) {
      last = decide(state, "k", cond, T0 + dt, null, DEBOUNCE);
      if (last.changed) state = last.next;
    }
    expect(last!.action).toBe("raise");
    expect(last!.flapping).toBe(true);
  });

  it("a pending incident counts its swallowed observations", () => {
    const steps: Array<[number, boolean]> = [];
    for (let i = 0; i <= 3; i++) steps.push([i * POLL, true]);
    const { state } = runD(steps);
    expect(state.sentCount).toBe(0);
    expect(state.suppressedCount).toBe(4);
    expect(state.active).toBe(true);
  });
});
