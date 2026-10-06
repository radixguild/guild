'use strict';
// Abuse guards for the bot: ban gate + per-user flood throttle.
// Extracted from index.js so they are unit-testable (bot/test/guards.test.js).
// Both are grammy-style middleware: (ctx, next) => ...

// Drop every update from a banned user. Admins are exempt so a typo'd /ban
// can never lock the operator out of their own bot.
function createBanGuard({ isBanned, adminIds = [] }) {
  return async (ctx, next) => {
    const uid = ctx.from?.id;
    if (uid && !adminIds.includes(uid) && isBanned(uid)) {
      // Answer callbacks even when dropping, or Telegram shows a stuck spinner.
      if (ctx.callbackQuery) { try { await ctx.answerCallbackQuery(); } catch (_) {} }
      return; // silently drop
    }
    return next();
  };
}

// Fixed-window per-user throttle. Defaults sized so a legitimate voter
// tapping through a long proposal list (~1 tap/2s) fits inside one window.
function createThrottleGuard({ max = 60, windowMs = 60000 } = {}) {
  const windows = new Map(); // tg_id -> { count, windowStart, warned }
  const guard = async (ctx, next) => {
    const uid = ctx.from?.id;
    if (!uid) return next();
    const now = Date.now();
    // Bounded memory: sweep stale windows once the map grows past a burst-size cap.
    if (windows.size > 5000) {
      for (const [k, v] of windows) {
        if (now - v.windowStart >= 2 * windowMs) windows.delete(k);
      }
    }
    let r = windows.get(uid);
    if (!r || now - r.windowStart >= windowMs) {
      r = { count: 0, windowStart: now, warned: false };
      windows.set(uid, r);
    }
    r.count++;
    if (r.count > max) {
      const msg = "You're going a bit fast — give it a few seconds and try again.";
      try {
        if (ctx.callbackQuery) {
          // ALWAYS answer dropped callbacks (first one carries the reason) —
          // an unanswered callback leaves the user staring at a spinner.
          await ctx.answerCallbackQuery(r.warned ? {} : { text: msg });
        } else if (ctx.message && !r.warned) {
          await ctx.reply(msg); // one nudge per window so the throttle can't be spammed
        }
      } catch (_) {}
      r.warned = true;
      return; // drop the excess update
    }
    return next();
  };
  guard._windows = windows; // exposed for tests
  return guard;
}

// Admin commands whose replies must never land in a group (2026-10-06): /agent create
// printed a raw API key in whatever chat it was typed, /signer names the signing account
// and prints its audit, and /adminfeedback and /banned list members. Outside a private
// chat this takes the command message down (best effort: the bot may not be allowed to
// delete in that group), answers with `text`, and returns true so the handler stops.
async function refuseOutsidePrivate(ctx, text) {
  if (ctx.chat && ctx.chat.type === "private") return false;
  try { await ctx.deleteMessage(); } catch (_) { /* best effort */ }
  try { await ctx.reply(text); } catch (_) { /* nothing more to do in a group we cannot write to */ }
  return true;
}

module.exports = { createBanGuard, createThrottleGuard, refuseOutsidePrivate };
