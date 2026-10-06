"use strict";
// verify.js — /verify (is this person on the Guild team?) and /link (prove a wallet).
//
// WHY (2026-09-27). Scammers DM new members pretending to be Guild staff, usually
// behind a lookalike username. Pinning "we never DM first" helps; letting anyone
// check a sender in one command helps more. /verify answers from two sources:
//   - the team: ADMIN_TG_IDS, the same list the bot authorises admin commands by;
//   - a wallet the person PROVED with a signature on radixguild.com (/link).
//
// It deliberately does NOT trust `users` rows. /register stores whatever address
// anyone types, so a scammer can /register an admin's wallet. /verify reports such
// a row as "claimed, never proven" and never shows its address or badge.
//
// ── The /link token format (shared with guild-saas's /link-telegram page) ──
//   token   = "gl1." + b64url(JSON payload) + "." + b64url(HMAC-SHA256(TG_LINK_SECRET, "gl1." + b64url(payload)))
//   ticket  = { k: "t", tg, exp }             bot → web: "this TG id asked to link"
//   code    = { k: "c", tg, a, exp, n }       web → bot: "this TG id proved wallet a"
// `k` separates the two kinds so a ticket can never be redeemed as a code. The web
// page issues a code only after a wallet sign-in (ROLA) for address `a`, and only
// for the `tg` inside a ticket it has verified. The bot redeems a code only from
// that same TG id, only in a DM, and only once (`n` → link_code_nonces).
//
// Everything stateful sits behind createVerify(options) so tests inject
// { db, getBadgeResult, now, env } — the same factory style as support-ai.js.

const crypto = require("node:crypto");
const copy = require("./copy");

const PREFIX = "gl1";
const TICKET_TTL_S = 15 * 60;
const CODE_TTL_MAX_S = 15 * 60; // a code claiming a longer life came from a broken issuer
const MIN_SECRET_LEN = 32;
const TEAM_CACHE_MS = 10 * 60 * 1000;
const RATE = { windowMs: 60 * 1000, perUser: 5, perChat: 20 };
const ACCOUNT_RE = /^account_rdx1[a-z0-9]{40,60}$/;

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function sign(secret, body) {
  return b64url(crypto.createHmac("sha256", secret).update(body).digest());
}

function encodeToken(secret, payload) {
  const body = PREFIX + "." + b64url(JSON.stringify(payload));
  return body + "." + sign(secret, body);
}

/** @returns {{ ok: true, payload: object } | { ok: false, reason: string }} */
function decodeToken(secret, token) {
  const parts = String(token || "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: "malformed" };
  const body = parts[0] + "." + parts[1];
  const want = Buffer.from(sign(secret, body));
  const got = Buffer.from(parts[2]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, reason: "bad-signature" };
  try {
    return { ok: true, payload: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) };
  } catch (_) {
    return { ok: false, reason: "malformed" };
  }
}

function last8(address) {
  return "…" + String(address).slice(-8);
}

function displayName(user) {
  if (user.username) return "@" + user.username;
  return String(user.first_name || "someone").slice(0, 64);
}

function createVerify(options = {}) {
  const env = options.env || process.env;
  const db = options.db;
  const getBadgeResult = options.getBadgeResult;
  const isAdmin = options.isAdmin || (() => false);
  const adminIds = options.adminIds || [];
  const now = options.now || Date.now;
  const portal = env.PORTAL_URL || "https://radixguild.com";
  const secret = env.TG_LINK_SECRET || "";
  const linkEnabled = env.WALLET_LINK_ENABLED === "true" && secret.length >= MIN_SECRET_LEN;

  const nowS = () => Math.floor(now() / 1000);

  // ── tokens ──

  function makeTicket(tgId) {
    return encodeToken(secret, { k: "t", tg: Number(tgId), exp: nowS() + TICKET_TTL_S });
  }

  /** @returns {{ ok: true, address: string, nonce: string } | { ok: false, reason: string }} */
  function checkCode(code, tgId) {
    const dec = decodeToken(secret, code);
    if (!dec.ok) return dec;
    const p = dec.payload;
    if (!p || p.k !== "c" || typeof p.n !== "string" || p.n.length < 16) return { ok: false, reason: "malformed" };
    const t = nowS();
    if (!Number.isFinite(p.exp) || p.exp <= t || p.exp > t + CODE_TTL_MAX_S) return { ok: false, reason: "expired" };
    if (Number(p.tg) !== Number(tgId)) return { ok: false, reason: "wrong-user" };
    if (!ACCOUNT_RE.test(String(p.a))) return { ok: false, reason: "malformed" };
    return { ok: true, address: p.a, nonce: p.n };
  }

  // ── rate limit: per user and per chat, silently dropped over the limit ──

  const hits = new Map(); // key -> [timestamps]
  function allow(key, max) {
    const t = now();
    if (hits.size > 5000) {
      // Keys are every user and chat that ever typed /verify; drop the idle ones.
      for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] >= RATE.windowMs) hits.delete(k);
    }
    const recent = (hits.get(key) || []).filter((x) => t - x < RATE.windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(t);
    hits.set(key, recent);
    return true;
  }

  // ── the team, with live usernames (a cached name can be one the member dropped) ──

  const teamCache = new Map(); // tgId -> { at, member }
  async function teamMembers(api) {
    const out = [];
    for (const id of adminIds) {
      const hit = teamCache.get(id);
      if (hit && now() - hit.at < TEAM_CACHE_MS) { out.push(hit.member); continue; }
      let member = { tgId: id, username: null, name: "TG id " + id };
      try {
        const chat = await api.getChat(id);
        member = { tgId: id, username: chat.username || null, name: displayName(chat) };
        teamCache.set(id, { at: now(), member });
      } catch (e) {
        console.error("[Verify] getChat failed for a team id:", e.message);
      }
      out.push(member);
    }
    return out;
  }

  // ── what we can say about one Telegram user ──

  async function describe(user) {
    const team = isAdmin(user.id);
    const link = db.getWalletLink(user.id);
    let wallet = { kind: "none" };
    if (link) {
      const badge = await getBadgeResult(link.radix_address).catch(() => ({ error: true }));
      wallet = {
        kind: "proven",
        last8: last8(link.radix_address),
        badgeError: !!badge.error,
        badgeTier: badge.data ? badge.data.tier : null,
      };
    } else if (db.getUser(user.id)) {
      wallet = { kind: "claimed" };
    }
    return copy.verifyResult({ name: displayName(user), tgId: user.id, team, wallet });
  }

  async function handleVerify(ctx) {
    const chatId = ctx.chat && ctx.chat.id;
    if (!allow("u:" + ctx.from.id, RATE.perUser) || !allow("c:" + chatId, RATE.perChat)) return;
    const reply = (text) => ctx.reply(text, { reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true } });

    // In a forum topic every message "replies" to the topic's opening service message.
    const r = ctx.message.reply_to_message;
    const target = r && !r.forum_topic_created ? r : null;

    if (target) {
      if (target.sender_chat) return reply(copy.verifyNoPerson());
      const who = target.from;
      if (!who) return reply(copy.verifyNoPerson());
      if (ctx.me && who.id === ctx.me.id) return reply(copy.verifySelfBot());
      if (who.is_bot) return reply(copy.verifyOtherBot({ name: displayName(who), tgId: who.id, ourBot: ctx.me && ctx.me.username }));
      return reply(await describe(who));
    }

    const arg = (ctx.match || "").trim().split(/\s+/)[0] || "";
    const members = await teamMembers(ctx.api);
    if (!arg) return reply(copy.verifyTeamList({ members }));

    const wanted = arg.replace(/^@/, "").toLowerCase();
    const match = members.find((m) => m.username && m.username.toLowerCase() === wanted);
    if (match) return reply(await describe({ id: match.tgId, username: match.username }));
    return reply(copy.verifyUsernameNotTeam({ username: arg.replace(/^@/, ""), members }));
  }

  // ── which wallet speaks for a Telegram user at the badge gates (2026-10-06) ──
  // requireBadge (/propose, /temp, /poll, bounties, milestones) and the vote buttons
  // used to trust the `users` row, so anyone could /register a badge holder's wallet and
  // propose or vote with that badge. With /link on, only a PROVEN wallet counts. With
  // /link off there is nothing to prove a wallet with, so the claimed address still
  // answers (today's behaviour) — switching /link on is what closes the gap.
  /** @returns {{ ok: true, address: string, proven: boolean } | { ok: false, reason: "unlinked" | "unregistered" }} */
  function memberAddress(tgId) {
    if (linkEnabled) {
      const link = db.getWalletLink(tgId);
      return link ? { ok: true, address: link.radix_address, proven: true } : { ok: false, reason: "unlinked" };
    }
    const user = db.getUser(tgId);
    return user ? { ok: true, address: user.radix_address, proven: false } : { ok: false, reason: "unregistered" };
  }

  // /register while /link is on (2026-10-06): a claim no longer opens any gate, so the reply
  // has to say so, and a claim must never overwrite the wallet a member proved (the users
  // row feeds /wallet, /badge and attribution).
  // It also refuses a wallet another Telegram account has proven: the users row routes
  // task DMs (escrow watcher), so a claim on someone else's proven wallet is impersonation.
  /** @returns {{ ok: true, mustLink: boolean } | { ok: false, reason: "proven", last8: string } | { ok: false, reason: "taken" }} */
  function checkClaim(tgId, address) {
    if (!linkEnabled) return { ok: true, mustLink: false };
    const link = db.getWalletLink(tgId);
    if (link && link.radix_address !== address) return { ok: false, reason: "proven", last8: last8(link.radix_address) };
    if (!link && db.getOtherWalletLink(address, tgId)) return { ok: false, reason: "taken" };
    return { ok: true, mustLink: !link };
  }

  async function handleLink(ctx) {
    const arg = (ctx.match || "").trim();
    if (ctx.chat.type !== "private") {
      // A code pasted in a group is bound to its owner's TG id, so nobody else can
      // redeem it — but refuse anyway and take it down, so pasting codes in public
      // never becomes a habit.
      if (arg) await ctx.deleteMessage().catch(() => {});
      return ctx.reply(copy.linkInGroup());
    }
    if (!linkEnabled) return ctx.reply(copy.linkDisabled());
    if (!arg) {
      const url = portal + "/link-telegram?t=" + makeTicket(ctx.from.id);
      return ctx.reply(copy.linkStart({ url, tgId: ctx.from.id }));
    }
    const res = checkCode(arg, ctx.from.id);
    if (!res.ok) return ctx.reply(copy.linkFailed({ reason: res.reason }));
    if (!db.recordWalletLink(ctx.from.id, res.address, res.nonce)) return ctx.reply(copy.linkFailed({ reason: "used" }));
    // Point the `users` row at the proven wallet too, so bounty claims and XP
    // (which read users.radix_address) credit the same wallet the gates now trust.
    db.registerUser(ctx.from.id, res.address, ctx.from.username || ctx.from.first_name || null);
    return ctx.reply(copy.linkDone({ last8: last8(res.address) }));
  }

  return { handleVerify, handleLink, makeTicket, checkCode, linkEnabled, memberAddress, checkClaim };
}

module.exports = { createVerify, encodeToken, decodeToken };
