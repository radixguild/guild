/**
 * gift.ts — Gift destinations and the hard guard that keeps them dark.
 *
 * Gifts, not fees: for beta the guild takes 0% and asks for gifts instead. A
 * gift buys nothing — no token, no equity, no priority, no promise. The fee
 * roadmap (D2) is unchanged and still the eventual plan; see /docs.
 *
 * ── THE GUARD ────────────────────────────────────────────────────────────
 * Every destination is supplied by bigdev via env. Nothing sendable renders
 * until one is configured AND validates, per rail, independently.
 *
 * There is deliberately NO separate NEXT_PUBLIC_FEATURE_GIFT flag. config.ts's
 * agent-lane note (the reverted AGENT_BADGE_NFT gate) records the lesson: gate
 * a surface on an env var only when the var's presence genuinely IS the
 * condition the surface depends on. Here it exactly is — no address means
 * there is nowhere to send — so "configured" and "live" are one truth
 * condition that cannot drift. A second flag could only disagree with reality.
 *
 * INVALID IS TREATED AS UNSET. A malformed destination goes dark rather than
 * rendering something sendable, because the failure modes are not symmetric:
 * a dark rail collects no gifts, a wrong rail eats them. Set-but-rejected is
 * loud (see the warning below) so a typo shows up at build time on the VPS
 * instead of looking like "the page just doesn't work".
 *
 * NEVER hard-code a destination here. Nothing in this file may invent an
 * address — an unset rail is dark, full stop, and a placeholder shown as real
 * is the exact bug this module exists to prevent.
 */

import { validateBtcMainnetAddress } from "./btc-address";
import { verifyBech32 } from "./bech32";

export type GiftRail = "xrd" | "btc" | "stripe" | "paypal";

/**
 * Read as static literals, never process.env[key] — Next inlines
 * NEXT_PUBLIC_* at build time only for statically analyzable references, and a
 * dynamic lookup would silently produce undefined in the browser bundle (i.e.
 * a rail that works on the server and is dark on the client).
 */
const RAW: Record<GiftRail, string> = {
  xrd: process.env.NEXT_PUBLIC_GIFT_XRD_ADDRESS || "",
  btc: process.env.NEXT_PUBLIC_GIFT_BTC_ADDRESS || "",
  stripe: process.env.NEXT_PUBLIC_GIFT_STRIPE_URL || "",
  paypal: process.env.NEXT_PUBLIC_GIFT_PAYPAL_URL || "",
};

type Validation = { ok: true; value: string } | { ok: false; reason: string };

/**
 * Addresses that are perfectly well-formed and must never receive a gift.
 *
 * A checksum proves an address is not a typo. It cannot prove it is the
 * account you MEANT — and both of these are valid, live, 66-character mainnet
 * accounts that appear all over the ecosystem's repos, console and docs, which
 * is exactly what makes them plausible copy-paste mistakes into a gift env var.
 * Canonical list: bigdev-console `docs/WALLET-MAP.md`, "Two addresses that
 * must never be used as a gift destination". Keep them in sync.
 *
 * Denying at validation, not in review, is deliberate: the guard already
 * treats invalid as unset, so a mistake here goes dark and loud instead of
 * quietly collecting other people's money into an unspendable account. That
 * matters more here than in the read-only copies — this app's XRD card builds
 * a send manifest from the resolved destination, so a bad address is not just
 * displayed, it is pre-filled into the donor's wallet.
 *
 * This file is UPSTREAM: defi-farmer `frontend/lib/gift/index.ts`,
 * meme-grid-game `src/lib/gift/index.ts` and bigdev-console
 * `lib/gift-address/index.ts` carry the same map. Add an entry in all four or
 * the apps disagree about what is a valid destination.
 */
export const FORBIDDEN_XRD_DESTINATIONS: Record<string, string> = {
  "account_rdx128lggt503h7m2dhzqnrkkqv4zklxcjmdggr8xxtqy8e47p7fkmd8cx":
    "is a retired hot server account: its key was exposed in 2026 and the account was " +
    "emptied on 2026-09-29, so a gift sent there would be unrecoverable",
  "account_rdx128y6j78mt0aqv6372evz28hrxp8mn06ccddkr7xppc88hyvynvjdwr":
    "is the orphaned old dApp definition — NO key exists anywhere, so anything sent " +
    "to it is permanently unrecoverable",
};

/**
 * Radix account address: bech32m-checksummed, so a single mistyped character
 * is caught rather than merely shape-matched. Length is pinned at 66 (the
 * Babylon account form) — the checksum is the real check, the length just
 * rejects a component_/resource_ address pasted into the account slot.
 */
function validateXrdAccount(addr: string): Validation {
  if (addr !== addr.trim()) return { ok: false, reason: "has leading or trailing whitespace" };
  if (!addr.startsWith("account_rdx1")) {
    return { ok: false, reason: 'must be a Radix mainnet account address (starts with "account_rdx1")' };
  }
  if (addr.length !== 66) {
    return { ok: false, reason: `is ${addr.length} characters, expected 66` };
  }
  const decoded = verifyBech32(addr);
  if (!decoded || decoded.encoding !== "bech32m") {
    return { ok: false, reason: "failed the bech32m checksum — check for a typo" };
  }
  if (decoded.hrp !== "account_rdx") {
    return { ok: false, reason: `has human-readable part "${decoded.hrp}", expected "account_rdx"` };
  }
  const forbidden = FORBIDDEN_XRD_DESTINATIONS[addr];
  if (forbidden) return { ok: false, reason: forbidden };
  return { ok: true, value: addr };
}

function validateBtc(addr: string): Validation {
  const r = validateBtcMainnetAddress(addr);
  return r.ok ? { ok: true, value: addr } : { ok: false, reason: r.reason };
}

/**
 * Exact first-path-segment matches only — never a substring test. A donation
 * handle can legitimately contain any of these as a substring (paypal.me/theresa
 * contains "here"), and a guard that eats a real destination is its own outage.
 */
const PLACEHOLDER_SEGMENTS = new Set([
  "your-link", "your-handle", "yourname", "your-name", "username", "handle",
  "example", "changeme", "todo", "tbd", "placeholder", "xxx",
]);

/**
 * Link-out URL guard. Host is allowlisted rather than merely required to be
 * https: an env var that can point anywhere is a phishing surface if it is
 * ever wrong, and "we send donors wherever this string says" is not a property
 * worth having. Strict and loud beats permissive and silent — if a legitimate
 * link is rejected here (e.g. a Stripe custom domain), the fix is to widen the
 * allowlist deliberately, not to drop it.
 */
function validateLinkOut(raw: string, hosts: string[], label: string): Validation {
  if (raw !== raw.trim()) return { ok: false, reason: "has leading or trailing whitespace" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "is not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "must be https" };
  if (!hosts.includes(url.hostname.toLowerCase())) {
    return { ok: false, reason: `host "${url.hostname}" is not one of ${hosts.join(", ")} (${label})` };
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return { ok: false, reason: "has no path — it is a bare host, not a payment link" };
  if (segments.some((s) => PLACEHOLDER_SEGMENTS.has(s.toLowerCase()))) {
    return { ok: false, reason: "still contains a placeholder path segment" };
  }
  return { ok: true, value: url.toString() };
}

function validateStripe(raw: string): Validation {
  const r = validateLinkOut(raw, ["buy.stripe.com", "donate.stripe.com"], "Stripe Payment Link");
  if (!r.ok) return r;
  // Stripe test-mode links live under /test_… and take play money. Shipping one
  // looks exactly like a working rail while collecting nothing.
  if (new URL(r.value).pathname.startsWith("/test_")) {
    return { ok: false, reason: "is a Stripe TEST-mode link — use the live-mode link" };
  }
  return r;
}

function validatePaypal(raw: string): Validation {
  const r = validateLinkOut(
    raw,
    ["paypal.me", "www.paypal.me", "paypal.com", "www.paypal.com"],
    "PayPal.me link",
  );
  if (!r.ok) return r;
  const url = new URL(r.value);
  if (url.hostname.endsWith("paypal.com") && !url.pathname.toLowerCase().startsWith("/paypalme/")) {
    return { ok: false, reason: "must be a paypal.me link or a paypal.com/paypalme/… link" };
  }
  return r;
}

const VALIDATORS: Record<GiftRail, (v: string) => Validation> = {
  xrd: validateXrdAccount,
  btc: validateBtc,
  stripe: validateStripe,
  paypal: validatePaypal,
};

const ENV_NAMES: Record<GiftRail, string> = {
  xrd: "NEXT_PUBLIC_GIFT_XRD_ADDRESS",
  btc: "NEXT_PUBLIC_GIFT_BTC_ADDRESS",
  stripe: "NEXT_PUBLIC_GIFT_STRIPE_URL",
  paypal: "NEXT_PUBLIC_GIFT_PAYPAL_URL",
};

const RAILS: GiftRail[] = ["xrd", "btc", "stripe", "paypal"];

/** Destinations that are set AND valid. Anything absent here must not render. */
const RESOLVED: Partial<Record<GiftRail, string>> = {};
/** Set-but-rejected rails, kept so the failure can be reported, never rendered. */
const REJECTED: { rail: GiftRail; env: string; reason: string }[] = [];

for (const rail of RAILS) {
  const raw = RAW[rail];
  if (!raw) continue;
  const result = VALIDATORS[rail](raw);
  if (result.ok) RESOLVED[rail] = result.value;
  else REJECTED.push({ rail, env: ENV_NAMES[rail], reason: result.reason });
}

// Fail loudly, once, at module load — which for a NEXT_PUBLIC_* var means at
// `next build` on the VPS, where bigdev will actually see it. Silence here
// would turn a typo into "I set the address and the page is still empty".
// The value is never logged back: it is public by design, but echoing a
// rejected string invites copying the broken one out of the log.
if (REJECTED.length > 0) {
  for (const r of REJECTED) {
    console.warn(`[gift] ${r.env} is set but ${r.reason} — the ${r.rail.toUpperCase()} gift rail stays OFF.`);
  }
}

/** The destination for a rail, or null when it is unset/invalid (i.e. dark). */
export function giftDestination(rail: GiftRail): string | null {
  return RESOLVED[rail] ?? null;
}

export function isGiftRailLive(rail: GiftRail): boolean {
  return RESOLVED[rail] !== undefined;
}

/** True only if at least one rail has a real destination. Gates the whole route. */
export function isGiftPageLive(): boolean {
  return RAILS.some(isGiftRailLive);
}

export function liveGiftRails(): GiftRail[] {
  return RAILS.filter(isGiftRailLive);
}

/** Set-but-rejected rails. For operator surfaces and tests — never for donors. */
export function giftDiagnostics(): readonly { rail: GiftRail; env: string; reason: string }[] {
  return REJECTED;
}

/**
 * Preset amounts. Round numbers, deliberately NOT pegged to a price feed: a
 * donation page should not depend on a market endpoint to render, and a stale
 * "≈ $50" is a worse lie than no dollar figure at all. Strings, not numbers,
 * so no float artifact can reach a manifest or a BIP21 amount.
 */
export const XRD_PRESETS = ["100", "500", "1000", "5000"] as const;
export const BTC_PRESETS = ["0.0005", "0.001", "0.005"] as const;

/**
 * True iff `s` is an XRD amount the gift manifest can actually BUILD AND SEND.
 *
 * "Valid" must mean "sendable", or the Send button enables on an amount that
 * then throws on click. giftXrdManifest → decimalArg (manifests.ts) rejects
 * non-positive values AND anything whose String(n) is exponential (e.g.
 * Number("0.0000001") === 1e-7 → "1e-7"), so this mirrors those exact bounds.
 * The ≤ 1e9 cap keeps the value well inside the decimal range and is a sane
 * ceiling for a donation. The 18-dp regex matches XRD's on-ledger precision.
 */
export function isSendableXrdAmount(s: string): boolean {
  if (!/^\d+(\.\d{1,18})?$/.test(s)) return false;
  const n = Number(s);
  if (!(n > 0) || n > 1e9) return false;
  return !/[eE]/.test(String(n));
}

/**
 * Format an XRD amount for the send control so the figure SHOWN is exactly the
 * figure SENT. It groups the integer part for readability but preserves every
 * fractional digit — `Number(s).toLocaleString()` silently rounds to 3 dp,
 * which made the button announce "Send 0 XRD" while the manifest withdrew
 * 0.0001. `String(Number(s))` is precisely what decimalArg puts in the
 * manifest's `Decimal("…")`, so display and transaction can never disagree.
 * Caller must pass an isSendableXrdAmount() value (guarantees no exponential).
 */
export function formatXrdAmountForDisplay(s: string): string {
  const canonical = String(Number(s)); // identical to the manifest's Decimal body
  const [intPart, fracPart] = canonical.split(".");
  const grouped = Number(intPart).toLocaleString("en-US");
  return fracPart ? `${grouped}.${fracPart}` : grouped;
}

/**
 * BIP-21 payment URI. The address is embedded verbatim after validation; label
 * and message are percent-encoded via URLSearchParams.
 *
 * `amount` is in BTC and MUST be a plain decimal string — BIP-21 requires it,
 * and wallets differ in how they handle exponential notation (some silently
 * read 1e-4 as an empty amount). Callers pass BTC_PRESETS values; anything
 * that is not a plain decimal throws rather than producing a URI a wallet
 * might misread.
 */
export function bip21Uri(address: string, amount?: string, label?: string): string {
  if (validateBtcMainnetAddress(address).ok === false) {
    throw new Error("bip21Uri: refusing to build a URI for an invalid address");
  }
  const params = new URLSearchParams();
  if (amount !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(amount)) {
      throw new Error(`bip21Uri: amount must be a plain decimal string, got "${amount}"`);
    }
    params.set("amount", amount);
  }
  if (label) params.set("label", label);
  const query = params.toString();
  return `bitcoin:${address}${query ? `?${query}` : ""}`;
}
