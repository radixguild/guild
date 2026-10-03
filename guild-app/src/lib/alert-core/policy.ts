/**
 * Alert policy — the ONE decision function every operator alert goes through.
 *
 * Pure: no I/O, no clock of its own, no env. `decide()` takes the stored state
 * of one alert key, the condition as observed right now, and returns what to
 * do plus the next state. Persistence is `store.ts`; delivery is
 * `evaluate.ts`. Keeping the rule here, side-effect-free, is what lets the
 * storm this replaces be reproduced in a unit test (see policy.test.ts).
 *
 * ── What was wrong before ─────────────────────────────────────────────────
 * The Guild's `sendKeeperAlert(key, text, cooldown=10min)` was LEVEL-triggered:
 * every evaluation that found the condition true re-sent, subject only to a
 * per-process cooldown. A condition that stays true for days (Radix halted →
 * the price feed frozen) therefore paged the operator every ten minutes,
 * ~144 times a day, each message identical, none of them news. That is the
 * Sats alert-flood lesson repeated on the Guild rail, and it is the failure
 * mode that trains an operator to mute the channel — after which the one
 * alert that IS news gets muted with it.
 *
 * ── The rule now ───────────────────────────────────────────────────────────
 * EDGE-triggered with bounded reminders, in the shape Alertmanager / PagerDuty
 * converge on:
 *   raise    condition became true            → one message, loud
 *   remind   still true at 1h, 6h, 24h, then  → one message, SILENT (no push),
 *            every 24h                           carrying "since", the reminder
 *                                                number and how many checks were
 *                                                swallowed since the last one
 *   clear    condition became false           → one recovery message, so the
 *                                                operator never has to ask "is it
 *                                                still going?"
 *   suppress condition true but a PARENT       → nothing sent, counted; the
 *            incident is active (inhibition)     parent's reminder lists it.
 *            e.g. "price feed frozen" while
 *            "network halted" is open
 *   none     nothing changed                  → nothing sent, nothing written
 *                                                unless a counter moved
 *
 * Flap damping: a raise within FLAP_WINDOW_MS of the previous clear is still
 * sent (it is an edge, and hiding edges is how alerts lie) but is labelled as
 * re-opened, so a source that toggles every few minutes reads as flapping
 * rather than as a stream of fresh incidents.
 *
 * ── Debounce (`debounceMs`, added 2026-09-18) ─────────────────────────────
 * Labelling a flap is not the same as not sending it. The Guild escrow
 * watcher polls the Gateway every 60s and observes true/false on EVERY poll;
 * one Cloudflare 502 or one 5s fetch timeout therefore produced a 🔴 and then
 * a 🟢 eight seconds later, three times in a morning. Both messages were
 * accurate and neither was worth a push notification.
 *
 * So a caller may now declare how long a condition must HOLD before it is
 * worth waking someone — Prometheus's `for:`. While the condition is true but
 * has not yet held that long the incident is `pend`: it is open and its
 * `since` is the TRUE start, but nothing has been sent. If it clears while
 * pending, it closes in silence — the existing "a never-announced incident
 * closes silently" rule already covers that case exactly, which is why this
 * needs no new persisted field and no schema migration. `pend` reuses the
 * same (active, sentCount === 0) shape that an inhibited-from-birth incident
 * has always had.
 *
 * debounceMs is a per-CALL argument, not persisted state: it is policy the
 * caller owns and may retune between deploys without migrating any rows.
 * Default 0 = the old behaviour, exactly, for every existing consumer.
 *
 * Optimistic concurrency: every decision bumps `version`. The store persists
 * the next state ONLY if the stored version still matches what was read, so
 * two request handlers evaluating the same key at the same instant produce
 * exactly one message — the successful write IS the permission to send.
 */

export interface AlertState {
  key: string;
  /** The condition is currently true (an incident is open). */
  active: boolean;
  /** ms epoch when the open incident began; null when inactive. */
  since: number | null;
  /** ms epoch of the last message actually sent for the open incident. */
  lastSentAt: number | null;
  /** ms epoch of the most recent clear (recovery), for flap labelling. */
  lastClearedAt: number | null;
  /** Messages sent for the open incident (raise + reminders). */
  sentCount: number;
  /** Evaluations during the open incident that sent nothing (throttled or inhibited). */
  suppressedCount: number;
  /** Parent incident key whose being open swallowed this one's raise, if any. */
  inhibitedBy: string | null;
  /** Optimistic-concurrency counter; incremented on every persisted decision. */
  version: number;
}

export type AlertAction = "raise" | "remind" | "clear" | "suppress" | "pend" | "none";

export interface AlertDecision {
  action: AlertAction;
  next: AlertState;
  /** raise only: the incident re-opened within FLAP_WINDOW_MS of its last clear. */
  flapping: boolean;
  /**
   * raise only: why this raise is later than `since`, so the message can say so
   * honestly. "debounce" = it was held to see whether it would hold; "inhibited"
   * = a parent incident swallowed it and has since cleared; null = raised on the
   * first observation, the ordinary case.
   */
  heldBy: "debounce" | "inhibited" | null;
  /** remind only: 1-based reminder number (the raise is message #1, first reminder is #2). */
  reminderNumber: number | null;
  /** True when `next` differs from the stored state and must be persisted. */
  changed: boolean;
}

/** Reminder cadence after the raise: 1h, 6h, 24h — then every 24h. */
export const REMINDER_SCHEDULE_MS: readonly number[] = [
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
];
export const REMINDER_STEADY_STATE_MS = 24 * 60 * 60_000;

/** A raise this soon after a clear is labelled as re-opened / flapping. */
export const FLAP_WINDOW_MS = 10 * 60_000;

/**
 * Suggested `debounceMs` for a condition read from a remote service on a
 * short poll (a Gateway, an exchange, an HTTP health endpoint). Sized so a
 * single bad response, or one slow one, cannot page: at a 60s poll that is
 * five consecutive failures. Not a default — a caller must opt in, because a
 * condition that is expensive to observe, or observed once an hour, wants a
 * different number or none at all.
 */
export const SUGGESTED_REMOTE_READ_DEBOUNCE_MS = 5 * 60_000;

export function freshAlertState(key: string): AlertState {
  return {
    key,
    active: false,
    since: null,
    lastSentAt: null,
    lastClearedAt: null,
    sentCount: 0,
    suppressedCount: 0,
    inhibitedBy: null,
    version: 0,
  };
}

/** Interval to wait after the n-th message (n ≥ 1) before the next reminder. */
export function reminderIntervalAfter(sentCount: number): number {
  return REMINDER_SCHEDULE_MS[sentCount - 1] ?? REMINDER_STEADY_STATE_MS;
}

/** When the next reminder is due for an open, announced incident; null if none is announced yet. */
export function nextReminderDue(state: AlertState): number | null {
  if (!state.active || state.lastSentAt === null || state.sentCount === 0) return null;
  return state.lastSentAt + reminderIntervalAfter(state.sentCount);
}

export function decide(
  prev: AlertState | null,
  key: string,
  condition: boolean,
  now: number,
  /** Key of an OPEN parent incident that should swallow this raise, else null. */
  inhibitor: string | null,
  /**
   * How long the condition must hold before it is worth a message. 0 (the
   * default) reproduces the pre-2026-09-18 behaviour exactly: raise on the
   * first true observation.
   */
  debounceMs = 0,
): AlertDecision {
  const inhibited = inhibitor !== null;
  const base = prev ?? freshAlertState(key);
  const bump = (patch: Partial<AlertState>): AlertState => ({
    ...base,
    ...patch,
    key,
    version: base.version + 1,
  });
  // Computed against the PREVIOUS clear, so it is equally meaningful whether
  // the raise happens on the first observation or after a debounce hold.
  const flapping =
    base.lastClearedAt !== null && now - base.lastClearedAt < FLAP_WINDOW_MS;

  if (condition) {
    if (!base.active) {
      if (inhibited) {
        return {
          action: "suppress",
          next: bump({
            active: true,
            since: now,
            lastSentAt: null,
            sentCount: 0,
            suppressedCount: 1,
            inhibitedBy: inhibitor,
          }),
          flapping,
          heldBy: null,
          reminderNumber: null,
          changed: true,
        };
      }
      if (debounceMs > 0) {
        // Open, but not yet worth anyone's attention. `since` is the true
        // start; sentCount 0 is what makes a clear from here silent.
        return {
          action: "pend",
          next: bump({
            active: true,
            since: now,
            lastSentAt: null,
            sentCount: 0,
            suppressedCount: 1,
            inhibitedBy: null,
          }),
          flapping,
          heldBy: null,
          reminderNumber: null,
          changed: true,
        };
      }
      return {
        action: "raise",
        next: bump({
          active: true,
          since: now,
          lastSentAt: now,
          sentCount: 1,
          suppressedCount: 0,
          inhibitedBy: null,
        }),
        flapping,
        heldBy: null,
        reminderNumber: null,
        changed: true,
      };
    }

    // Already open.
    if (inhibited) {
      return {
        action: "suppress",
        next: bump({
          suppressedCount: base.suppressedCount + 1,
          inhibitedBy: inhibitor,
        }),
        flapping: false,
        heldBy: null,
        reminderNumber: null,
        changed: true,
      };
    }
    if (base.sentCount === 0) {
      // Nothing has been said about this incident yet — it is either pending a
      // debounce, or it was inhibited from birth and the parent has since
      // cleared. Either way `since` stays at the TRUE start, so the message
      // says how long it has really been going.
      const openFor = now - (base.since ?? now);
      if (debounceMs > 0 && openFor < debounceMs) {
        return {
          action: "pend",
          next: bump({ suppressedCount: base.suppressedCount + 1 }),
          flapping: false,
          heldBy: null,
          reminderNumber: null,
          changed: true,
        };
      }
      return {
        action: "raise",
        next: bump({ lastSentAt: now, sentCount: 1, inhibitedBy: null }),
        flapping,
        // `inhibitedBy` on the stored row is what distinguishes the two ways
        // an incident can arrive here; a debounce hold never sets it.
        heldBy: base.inhibitedBy !== null ? "inhibited" : debounceMs > 0 ? "debounce" : null,
        reminderNumber: null,
        changed: true,
      };
    }
    const due = nextReminderDue(base);
    if (due !== null && now >= due) {
      return {
        action: "remind",
        next: bump({
          lastSentAt: now,
          sentCount: base.sentCount + 1,
          suppressedCount: 0,
          inhibitedBy: null,
        }),
        flapping: false,
        heldBy: null,
        reminderNumber: base.sentCount + 1,
        changed: true,
      };
    }
    return {
      action: "none",
      next: bump({ suppressedCount: base.suppressedCount + 1 }),
      flapping: false,
      heldBy: null,
      reminderNumber: null,
      changed: true,
    };
  }

  // Condition false.
  if (base.active) {
    const announced = base.sentCount > 0;
    return {
      // A never-announced incident closes silently — one that was fully
      // inhibited by a parent, or one that cleared inside its debounce window.
      // A recovery notice for something the operator never heard about is
      // noise, and it is exactly half of the 🔴/🟢 flap pair.
      action: announced ? "clear" : "none",
      next: bump({
        active: false,
        since: null,
        lastSentAt: null,
        lastClearedAt: now,
        sentCount: 0,
        suppressedCount: 0,
        inhibitedBy: null,
      }),
      flapping: false,
      heldBy: null,
      reminderNumber: null,
      changed: true,
    };
  }
  return {
    action: "none",
    next: base,
    flapping: false,
    heldBy: null,
    reminderNumber: null,
    changed: false,
  };
}
