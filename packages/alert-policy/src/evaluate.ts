/**
 * The evaluator — policy + store + transport, wired once per consumer:
 *
 *   const evaluate = createAlertEvaluator({ store, send });
 *   await evaluate({ key, condition, title, detail, inhibitedBy });
 *
 * Call it with the condition as observed RIGHT NOW, every time you observe it
 * (true or false). The false call is what produces the 🟢 recovery, so do not
 * skip it; while nothing is open it costs one store read and no write.
 *
 * Never throws — alerting must never break the request or the job that
 * observed the condition. Returns what happened so tests can assert on it.
 */

import { decide, type AlertAction } from "./policy";
import type { AlertStore } from "./store";
import { formatAlert } from "./format";

export interface AlertInput {
  /** Stable incident key, e.g. "quote-xrd-usd-frozen". */
  key: string;
  /** The condition as observed now. */
  condition: boolean;
  /** One line, no key or timestamp — the formatter adds those. */
  title: string;
  /** Optional detail lines for the raise/reminder body. */
  detail?: string;
  /** Parent incident key. While that incident is open, this one is inhibited. */
  inhibitedBy?: string;
  /**
   * How long the condition must hold before this is worth a message
   * (Prometheus's `for:`). Omit or 0 to raise on the first true observation.
   * Use it for anything read from a remote service on a short poll, where a
   * single bad response would otherwise produce a 🔴 and a 🟢 seconds apart —
   * see SUGGESTED_REMOTE_READ_DEBOUNCE_MS.
   *
   * 🔴 This only delays the RAISE. A clear is never delayed, so a real
   * incident's recovery is still immediate — and an incident that never
   * raised never sends a recovery at all.
   */
  debounceMs?: number;
  /** Override the clock (tests). */
  now?: number;
}

export type AlertOutcome = AlertAction | "lost-race" | "send-failed" | "store-failed";

export interface AlertEvaluatorOptions {
  store: AlertStore;
  /** Deliver one message. `silent` = reminder; deliver without a push notification if the rail supports it. */
  send: (text: string, opts: { silent: boolean }) => Promise<boolean>;
  /** Clock; defaults to Date.now. */
  now?: () => number;
  /** Where store failures are reported; defaults to console.error. */
  onError?: (err: unknown, key: string) => void;
}

export type AlertEvaluator = (input: AlertInput) => Promise<AlertOutcome>;

export function createAlertEvaluator(opts: AlertEvaluatorOptions): AlertEvaluator {
  const clock = opts.now ?? (() => Date.now());
  const onError =
    opts.onError ??
    ((err: unknown, key: string) =>
      console.error("[alert-policy] store failure — alert not evaluated", { key, err }));

  return async function evaluate(input: AlertInput): Promise<AlertOutcome> {
    const now = input.now ?? clock();
    const store = opts.store;
    try {
      const prev = await store.get(input.key);
      let inhibitor: string | null = null;
      if (input.inhibitedBy) {
        const parent = await store.get(input.inhibitedBy);
        if (parent?.active) inhibitor = input.inhibitedBy;
      }
      const d = decide(prev, input.key, input.condition, now, inhibitor, input.debounceMs ?? 0);
      if (!d.changed) return "none";
      const won = await store.claim(d.next, prev?.version ?? null);
      if (!won) return "lost-race";
      if (d.action === "none" || d.action === "suppress" || d.action === "pend") return d.action;

      const text = formatAlert(d.action, input, d.next, now, {
        flapping: d.flapping,
        heldBy: d.heldBy,
        reminderNumber: d.reminderNumber,
        suppressedBeforeThis: prev?.suppressedCount ?? 0,
        openedAt: prev?.since ?? d.next.since ?? now,
        inhibited:
          d.action === "raise" || d.action === "remind"
            ? await store.listInhibitedBy(input.key)
            : [],
      });
      const sent = await opts.send(text, { silent: d.action === "remind" });
      return sent ? d.action : "send-failed";
    } catch (err) {
      onError(err, input.key);
      return "store-failed";
    }
  };
}
