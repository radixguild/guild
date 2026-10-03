// The bot's own @handle, for "DM me" copy.
//
// WHY THIS EXISTS (2026-09-20): index.js defaulted BOT_USERNAME to "@radix_guild"
// and the box never set the env var. @radix_guild is the community GROUP; the bot
// is @radix_guild_bot. So /start in the group told people "DM me to get started:
// @radix_guild" — a link back to the room they were standing in.
//
// Telegram already tells the bot its own username (grammy fills ctx.me from
// getMe at startup), so ask it instead of configuring it: a value read from the
// source cannot drift from it. The env var and the literal are fallbacks for a
// context with no ctx.me (tests, a handler called before init).

const FALLBACK_HANDLE = "@radix_guild_bot";

/** "@name" from "name" or "@name"; null for anything unusable. */
function normalise(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/^@/, "");
  return /^[A-Za-z0-9_]{5,32}$/.test(name) ? "@" + name : null;
}

/** @param {{ me?: { username?: string } }} [ctx] */
function botHandle(ctx, env = process.env) {
  return normalise(ctx && ctx.me && ctx.me.username) || normalise(env.BOT_USERNAME) || FALLBACK_HANDLE;
}

module.exports = { botHandle, FALLBACK_HANDLE };
