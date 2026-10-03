// Incoming-command log.
//
// WHY. On 2026-09-21 the bot had 52 command handlers, an 8-item menu, a /help that
// documents 9 — and no record of which of them anybody ever types. Every decision about
// the other 43 (retire? rewrite? keep?) was a guess. This logs ONE line per incoming
// command so that decision can be made from a week of facts instead.
//
// WHAT IT DELIBERATELY DOES NOT LOG.
//   - Arguments. `/register account_rdx1…` carries a wallet address and free text can
//     carry anything; only the command NAME is kept.
//   - The Telegram user id or username. A short salted hash is enough to tell "one
//     person typed /badge five times" from "five people did", which is all this is for.
//   - Plain messages. Only text that starts with a slash-command.
//
// It can never block a command: formatting or logging errors are swallowed HERE, on
// purpose, because a logger that throws would take the whole bot down with it — and the
// failure is itself logged once, so it is not silent.

const crypto = require("node:crypto");

/** "/Badge@radix_guild_bot now" → "badge". Anything that is not a command → null. */
function commandName(text) {
  if (typeof text !== "string") return null;
  const m = text.match(/^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]{1,64})?(?:\s|$)/);
  return m ? m[1].toLowerCase() : null;
}

function userTag(fromId, salt) {
  if (fromId === undefined || fromId === null) return "u_unknown";
  return "u_" + crypto.createHash("sha256").update(String(salt) + ":" + String(fromId)).digest("hex").slice(0, 8);
}

/** One line, fixed shape, greppable: `[cmd] /badge chat=private user=u_1a2b3c4d known=yes` */
function formatCommandLog({ text, chatType, fromId, salt, knownCommands }) {
  const name = commandName(text);
  if (!name) return null;
  const known = knownCommands ? (knownCommands.has(name) ? "yes" : "no") : "?";
  return "[cmd] /" + name + " chat=" + (chatType || "unknown") + " user=" + userTag(fromId, salt) + " known=" + known;
}

/**
 * grammY middleware. `knownCommands` (a Set of handler names) lets the log say when
 * someone typed a command that has NO handler — the other half of the usage picture.
 */
function createCommandLogger({ log = console.log, salt = "guild-bot", knownCommands } = {}) {
  let complained = false;
  return async (ctx, next) => {
    try {
      const line = formatCommandLog({
        text: ctx && ctx.message && ctx.message.text,
        chatType: ctx && ctx.chat && ctx.chat.type,
        fromId: ctx && ctx.from && ctx.from.id,
        salt,
        knownCommands,
      });
      if (line) log(line);
    } catch (err) {
      if (!complained) {
        complained = true;
        log("[cmd] logger error (reported once, commands still run): " + (err && err.message ? err.message : String(err)));
      }
    }
    return next();
  };
}

module.exports = { commandName, userTag, formatCommandLog, createCommandLogger };
