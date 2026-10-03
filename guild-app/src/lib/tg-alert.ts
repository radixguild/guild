/**
 * Operator Telegram transport (+ the deprecated cooldown helper).
 *
 * Reuses the SAME env vars the keeper/drift-watcher crons already use
 * (KEEPER_ALERT_TG_TOKEN + KEEPER_ALERT_TG_CHAT in guild-app/.env.local),
 * so alerts land on the same rail (@radix_guild_bot → the operator chat).
 *
 * Contract:
 * - No-op (returns false) when the env vars are unset.
 * - NEVER throws into the request path — all failures fail soft.
 *
 * ⚠️ `sendKeeperAlert` below is DEPRECATED for new call sites. Its per-process
 * cooldown is LEVEL-triggered: a condition that stays true for days re-sends
 * every ten minutes (~144 identical pages a day during the 2026-09 mainnet
 * halt). Use `evaluateAlert` in src/lib/alerts.ts, which is edge-triggered,
 * persisted, reminded with backoff and sends a recovery notice. This file now
 * only owns the transport.
 */

/** Send one message on the operator rail. `silent` = no push notification
 *  (Telegram `disable_notification`), used for reminders of an incident the
 *  operator has already been told about. */
export async function sendTelegramMessage(
  text: string,
  opts: { silent?: boolean } = {},
): Promise<boolean> {
  try {
    const token = process.env.KEEPER_ALERT_TG_TOKEN;
    const chat = process.env.KEEPER_ALERT_TG_CHAT;
    if (!token || !chat) return false;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text,
        disable_notification: opts.silent === true,
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const DEFAULT_COOLDOWN_MS = 10 * 60_000; // 10 min

// Per-process last-sent timestamps, keyed by alert key.
const lastSentAt = new Map<string, number>();

/** Test-only: reset cooldown state. */
export function _resetAlertCooldowns(): void {
  lastSentAt.clear();
}

/**
 * @deprecated Level-triggered. Kept only for the cooldown tests and any
 * out-of-tree caller; new alerts go through `evaluateAlert` (src/lib/alerts.ts).
 * Send a keeper-rail Telegram alert, throttled per `key`.
 *
 * @returns true only if a message was actually sent (HTTP OK).
 *          false when unconfigured, cooling down, or on any failure.
 */
export async function sendKeeperAlert(
  key: string,
  text: string,
  cooldownMs: number = DEFAULT_COOLDOWN_MS,
): Promise<boolean> {
  try {
    const token = process.env.KEEPER_ALERT_TG_TOKEN;
    const chat = process.env.KEEPER_ALERT_TG_CHAT;
    if (!token || !chat) return false;

    const now = Date.now();
    const last = lastSentAt.get(key);
    if (last !== undefined && now - last < cooldownMs) return false;
    // Claim the slot before the network call so concurrent requests in the
    // same process don't all fire during the fetch.
    lastSentAt.set(key, now);

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
