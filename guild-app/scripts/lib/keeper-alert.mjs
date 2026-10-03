/**
 * Keeper alert addressing — extracted so it can be unit-tested.
 *
 * `keeper.mjs` validates DATABASE_URL at import, so nothing in it is reachable
 * from a unit test. This module has no DB import and no side effects, mirroring
 * the precedent set by `src/lib/escrow-drift.ts` ("kept side-effect-free so it
 * can be unit tested"). The keeper imports it; the test imports it directly.
 *
 * 🔑 ALERTS ARE ADDRESSED TO A ROLE, NOT A PERSON — operator ruling 2026-08-29:
 * "dispute-lifecycle notifications must reach the affected users and the
 * arbiter — NOT admin. The operator is paged only for functional breakage."
 *
 * The keeper's only alert was the lapsed-dispute page and it went to the
 * operator's chat. That is the alert the operator was being pinged by every 30
 * minutes; it was never an operator concern — it was the arbiter's job
 * arriving. Nothing was broken, so nothing needed an admin.
 */

// Telegram nudge to a ROLE — the watch-mode action. Fails soft: alerting must
// never break detection logging.
//
// `audience` is required and has no default ON PURPOSE. A default would let the
// next alert added here inherit whichever addressee happened to be convenient,
// which is exactly how every dispute page ended up going to admin.
//   'arbiter'  → KEEPER_ALERT_TG_CHAT_ARBITER, falling back to the operator
//                chat with the message saying so.
//   'operator' → KEEPER_ALERT_TG_CHAT. Functional breakage only: drift,
//                parity failure, a cron that cannot run. NOT lifecycle events.
export async function sendAlert(text, audience) {
  if (audience !== "arbiter" && audience !== "operator") {
    throw new Error(
      `sendAlert needs an explicit audience ("arbiter" | "operator"), got ${JSON.stringify(audience)}. ` +
        "Alerts are addressed to a role; there is deliberately no default.",
    )
  }
  const token = process.env.KEEPER_ALERT_TG_TOKEN
  const operatorChat = process.env.KEEPER_ALERT_TG_CHAT
  const arbiterChat = process.env.KEEPER_ALERT_TG_CHAT_ARBITER
  const chat = audience === "arbiter" ? (arbiterChat || operatorChat) : operatorChat
  if (audience === "arbiter" && !arbiterChat && operatorChat) {
    text =
      text +
      "\n\n(Sent to the operator channel because KEEPER_ALERT_TG_CHAT_ARBITER is unset. " +
      "This is addressed to the ARBITER role — set that variable to route it where the arbiter reads.)"
  }
  if (!token || !chat) return false
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
    })
    return res.ok
  } catch {
    return false
  }
}

