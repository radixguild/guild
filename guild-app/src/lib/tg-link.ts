// Telegram wallet linking — the web half of the bot's /link (guild-public
// bot/services/verify.js, which documents the same format; keep them identical).
//
// The bot's /verify tells a group whether someone is on the Guild team and
// whether their wallet is PROVEN. "Proven" means this app vouched for it: the
// person opened the bot's link, signed in here with their wallet (ROLA), and
// carried a code back to the bot. The bot never trusts /register for this —
// anyone can type anyone's address there.
//
//   token  = "gl1." + b64url(JSON payload) + "." + b64url(HMAC-SHA256(TG_LINK_SECRET, "gl1." + b64url(payload)))
//   ticket = { k: "t", tg, exp }         bot → web: "this TG id asked to link"
//   code   = { k: "c", tg, a, exp, n }   web → bot: "this TG id proved wallet a"
//
// `k` keeps the kinds apart, so a ticket is never accepted as a code or the
// reverse. The bot redeems a code only from the same TG id, only in a DM, and
// only once (by `n`).

import "server-only"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

const PREFIX = "gl1"
const MIN_SECRET_LEN = 32
export const CODE_TTL_S = 10 * 60
const TICKET_TTL_MAX_S = 15 * 60 // the bot issues 15-minute tickets; longer means a broken issuer

export function tgLinkSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const s = env.TG_LINK_SECRET ?? ""
  return s.length >= MIN_SECRET_LEN ? s : null
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url")
}

function encode(secret: string, payload: object): string {
  const body = PREFIX + "." + Buffer.from(JSON.stringify(payload)).toString("base64url")
  return body + "." + sign(secret, body)
}

export type TicketResult =
  | { ok: true; tgId: number }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" }

export function verifyTicket(secret: string, ticket: string, nowS: number): TicketResult {
  const parts = String(ticket).trim().split(".")
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: "malformed" }
  const want = Buffer.from(sign(secret, parts[0] + "." + parts[1]))
  const got = Buffer.from(parts[2])
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: "bad-signature" }
  let p: { k?: unknown; tg?: unknown; exp?: unknown }
  try {
    p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  } catch {
    return { ok: false, reason: "malformed" }
  }
  if (p?.k !== "t" || !Number.isSafeInteger(p.tg) || (p.tg as number) <= 0) return { ok: false, reason: "malformed" }
  if (typeof p.exp !== "number" || p.exp <= nowS || p.exp > nowS + TICKET_TTL_MAX_S) return { ok: false, reason: "expired" }
  return { ok: true, tgId: p.tg as number }
}

/** Only call with an address a verified session proved (ROLA), never one from a request body. */
export function issueCode(
  secret: string,
  { tgId, address, nowS, nonce = randomBytes(16).toString("base64url") }: { tgId: number; address: string; nowS: number; nonce?: string },
): { code: string; expiresAt: number } {
  const exp = nowS + CODE_TTL_S
  // Key order is part of the format: the bot test pins a vector built in this order.
  return { code: encode(secret, { k: "c", tg: tgId, a: address, exp, n: nonce }), expiresAt: exp }
}
