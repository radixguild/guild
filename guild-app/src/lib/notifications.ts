import { createNotification } from "@/db/queries/notifications"
import type { NotificationEvent, NotificationPayload } from "@/db/schema"
import { isEnabled } from "@/lib/features"
import { logger } from "@/lib/hardening/logger"

/**
 * Notification emission — the substrate for #382 ("no push notification is
 * wired", src/app/api/v1/tasks/route.ts). This module is deliberately narrow:
 * it writes ONE in-app record per lifecycle event and defines the seam a real
 * delivery channel (Telegram, email) plugs into later. It does not send
 * anything anywhere today — see NotificationChannel below.
 *
 * ── Contract for every call site ────────────────────────────────────────────
 * emitNotification NEVER throws and NEVER blocks the transition it observes.
 * Call it AFTER the state transition's own transaction has committed, not
 * from inside it — a notification write is a side effect of a fact that
 * already happened, not a precondition for it. Mirrors the reasoning in
 * src/app/api/v1/tasks/[id]/dispute-evidence/route.ts's module doc ("if it
 * fails, the dispute still stands") and the operator Telegram transport
 * (src/lib/tg-alert.ts: "NEVER throws into the request path"). The difference
 * from tg-alert.ts: a failure here is NOT swallowed silently — it is logged
 * loudly via `logger.error`, because an in-app notification is the ONLY
 * record of the event for a user with no other channel, so losing one without
 * a trace is a real gap, not a cosmetic one.
 *
 * ── The adapter seam ─────────────────────────────────────────────────────────
 * NotificationChannel is the interface a delivery mechanism implements.
 * `inAppChannel` (below) is the first and, for now, only implementation:
 * it writes the notifications row read/list/mark-read APIs serve. A future
 * Telegram or email channel implements the same interface (deliver() sends
 * the message instead of / in addition to writing a row) and gets appended to
 * CHANNELS — nothing else in this module, or at any call site, changes.
 * NOT implemented here on purpose (out of scope for this PR): the guild bot
 * is stopped and its restart is gated on a separate operator sequence.
 */

export interface NotificationDeliveryInput {
  recipientId: string
  event: NotificationEvent
  taskId?: number | null
  payload?: NotificationPayload | null
}

export interface NotificationChannel {
  /** Short, log-friendly identifier — appears in the loud failure log line. */
  readonly name: string
  deliver(input: NotificationDeliveryInput): Promise<void>
}

/**
 * The in-app store, as a channel: "deliver" means "row exists for the inbox
 * to read". Throws on a DB failure like any other query-layer call — it is
 * emitNotification's job (below), not this channel's, to catch that and keep
 * it from reaching the caller's transition.
 */
export const inAppChannel: NotificationChannel = {
  name: "in-app",
  async deliver(input) {
    await createNotification({
      recipientId: input.recipientId,
      event: input.event,
      taskId: input.taskId ?? null,
      payload: input.payload ?? null,
    })
  },
}

// Ordered list of active channels. Appending a real Telegram/email channel
// here is the entire integration point once one exists.
const CHANNELS: readonly NotificationChannel[] = [inAppChannel]

export interface EmitNotificationResult {
  /** false if the feature flag is off (see features.ts's `notifications`) —
   *  the expected, silent case for a dark-launched feature; not an error. */
  enabled: boolean
  /** false if ANY channel failed to deliver (see the per-channel log line for
   *  which). Callers are not expected to act on this — it exists for tests. */
  ok: boolean
}

/**
 * Fire the notification for one lifecycle event across every active channel.
 * Safe to call unconditionally from a hot path: no-ops (cheaply) while the
 * `notifications` flag is off, and never rejects.
 */
export async function emitNotification(
  input: NotificationDeliveryInput,
): Promise<EmitNotificationResult> {
  if (!isEnabled("notifications")) return { enabled: false, ok: true }

  let ok = true
  for (const channel of CHANNELS) {
    try {
      await channel.deliver(input)
    } catch (err) {
      ok = false
      // Loud, never silent: this codebase's standard for a caught failure
      // that must not propagate is to log it at error level with enough
      // context to find the missed event, not to swallow it — see
      // silent-failure-hunter's charter and api-response.ts's own
      // logger.error use in apiFromError.
      logger.error(
        `notification channel '${channel.name}' failed to deliver — the triggering transition already committed and is NOT affected`,
        {
          channel: channel.name,
          event: input.event,
          recipientId: input.recipientId,
          taskId: input.taskId ?? undefined,
          error: err instanceof Error ? err.message : String(err),
        },
      )
    }
  }
  return { enabled: true, ok }
}
