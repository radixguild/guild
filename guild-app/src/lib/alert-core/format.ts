/**
 * Message formatting for the three things an operator ever receives:
 * a 🔴 raise, a 🟠 silent reminder, a 🟢 recovery. Plain text (no Telegram
 * parse_mode) so a title with an ampersand or angle bracket can never break
 * delivery.
 */

import { nextReminderDue, type AlertAction, type AlertState } from "./policy";

export interface AlertText {
  /** Stable incident key, e.g. "quote-xrd-usd-frozen". */
  key: string;
  /** One line, no key or timestamp — the formatter adds those. */
  title: string;
  /** Optional detail lines for the raise/reminder body. */
  detail?: string;
}

export function humanDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function iso(ms: number | null): string {
  return ms === null ? "?" : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function formatAlert(
  action: Exclude<AlertAction, "none" | "suppress" | "pend">,
  input: AlertText,
  next: AlertState,
  now: number,
  extra: {
    flapping: boolean;
    /** Why the raise is later than `since` — see AlertDecision.heldBy. */
    heldBy?: "debounce" | "inhibited" | null;
    reminderNumber: number | null;
    suppressedBeforeThis: number;
    /** When the incident opened — from the PREVIOUS state on a clear, since decide() nulls it. */
    openedAt: number;
    inhibited: AlertState[];
  },
): string {
  const lines: string[] = [];
  const since = extra.openedAt;
  if (action === "raise") {
    lines.push(`🔴 ${input.title}`);
    if (input.detail) lines.push(input.detail);
    lines.push(`since ${iso(since)} · key ${input.key}`);
    if (extra.flapping) {
      lines.push(
        `⚠️ re-opened ${humanDuration(now - (next.lastClearedAt ?? now))} after clearing — flapping?`,
      );
    }
    if (next.sentCount === 1 && now - since > 60_000) {
      // Raised late. Say how long it has really been going AND why the message
      // is only arriving now — "already open 5m" with no reason reads like the
      // alerting was asleep.
      const why =
        extra.heldBy === "debounce"
          ? "held to confirm it was not a blip"
          : extra.heldBy === "inhibited"
            ? "was inhibited by a parent incident"
            : "raised late";
      lines.push(`(already open ${humanDuration(now - since)} — ${why})`);
    }
    lines.push("Reminders at 1h, 6h, 24h, then daily (silent). You will get a 🟢 when it clears.");
  } else if (action === "remind") {
    lines.push(`🟠 STILL OPEN ${humanDuration(now - since)} — ${input.title}`);
    if (input.detail) lines.push(input.detail);
    lines.push(
      `since ${iso(since)} · reminder #${extra.reminderNumber ?? "?"} · ${extra.suppressedBeforeThis} checks confirmed it since the last message · key ${input.key}`,
    );
    const due = nextReminderDue(next);
    if (due !== null) lines.push(`next reminder in ${humanDuration(due - now)}`);
  } else {
    lines.push(`🟢 RESOLVED — ${input.title}`);
    lines.push(`was open ${humanDuration(now - since)} · key ${input.key}`);
  }
  if (extra.inhibited.length > 0) {
    lines.push("");
    lines.push(`Inhibited by this incident (${extra.inhibited.length}):`);
    for (const child of extra.inhibited) {
      lines.push(
        `  • ${child.key} — open ${humanDuration(now - (child.since ?? now))}, ${child.suppressedCount} checks swallowed`,
      );
    }
  }
  return lines.join("\n");
}
