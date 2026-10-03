// Fund & activate, the owner's side (A2.3 — docs/design/bring-your-agent.md
// §1a step 3, §3.4). Pure and client-safe: no React, no fetch, no server
// imports, so every rule below is unit-tested on its own.

import { XRD_ADDRESS } from "@/lib/radix"
import { compareXrd, isPositiveXrd } from "@/lib/xrd-decimal"

// ── the manifest the wallet is about to show ────────────────────────────────

export interface PairManifestFacts {
  from: string
  resource: string
  amountXrd: string
  /** The component whose public_mint is called — must be the Guild's badge manager. */
  manager: string
  labelNorm: string
  to: string
}

/**
 * Read back the one pairing transaction (manifests.ts `pairAgentManifest`):
 * withdraw XRD from the owner → public_mint the badge → deposit everything
 * into the agent. Anything else — a fourth instruction, a different method, a
 * reordered or missing one — is null: this page signs only that exact shape.
 */
export function describePairManifest(manifest: string): PairManifestFacts | null {
  const calls = manifest
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c !== "")
  if (calls.length !== 3) return null

  const withdraw =
    /^CALL_METHOD\s+Address\("(account_rdx1[a-z0-9]+)"\)\s+"withdraw"\s+Address\("(resource_rdx1[a-z0-9]+)"\)\s+Decimal\("([0-9]+(?:\.[0-9]{1,18})?)"\)$/.exec(
      calls[0],
    )
  const mint = /^CALL_METHOD\s+Address\("(component_rdx1[a-z0-9]+)"\)\s+"public_mint"\s+"([a-z0-9_]{1,51})"$/.exec(calls[1])
  const deposit =
    /^CALL_METHOD\s+Address\("(account_rdx1[a-z0-9]+)"\)\s+"try_deposit_batch_or_abort"\s+Expression\("ENTIRE_WORKTOP"\)\s+Enum<0u8>\(\)$/.exec(
      calls[2],
    )
  if (!withdraw || !mint || !deposit) return null
  return { from: withdraw[1], resource: withdraw[2], amountXrd: withdraw[3], manager: mint[1], labelNorm: mint[2], to: deposit[1] }
}

export interface PairExpectation {
  /** The Guild's badge manager (config MANAGER): the only component whose public_mint may be called. */
  manager: string
  /** The signed-in owner: the only account the XRD may come from. */
  owner: string
  agentAccount: string
  labelNorm: string
  floatXrd: string
}

/**
 * The last check before the wallet opens: does the transaction the server
 * built move exactly what this page is about to tell the owner? A mismatch is
 * a bug (or worse) on our side, and the answer is to not sign — never to
 * adjust the copy to match.
 */
export function checkPairManifest(manifest: string, want: PairExpectation): { ok: true } | { ok: false; reason: string } {
  const got = describePairManifest(manifest)
  if (!got) return { ok: false, reason: "the transaction is not the pairing transaction" }
  if (got.from !== want.owner) return { ok: false, reason: "it would take the XRD from a different account" }
  if (got.resource !== XRD_ADDRESS) return { ok: false, reason: "it would move a token that is not XRD" }
  if (!sameXrd(got.amountXrd, want.floatXrd)) return { ok: false, reason: "the amount differs from this agent's float" }
  if (got.manager !== want.manager) return { ok: false, reason: "it would call a badge minter that is not the Guild's" }
  if (got.labelNorm !== want.labelNorm) return { ok: false, reason: "the badge name differs from this agent's" }
  if (got.to !== want.agentAccount) return { ok: false, reason: "it would deliver to a different account" }
  if (got.to === got.from) return { ok: false, reason: "it would deliver back to your own account" }
  return { ok: true }
}

/** Equal as XRD amounts. Anything that is not a valid 18dp positive amount is never "equal" — it never throws. */
export function sameXrd(a: string, b: string): boolean {
  try {
    return isPositiveXrd(a) && isPositiveXrd(b) && compareXrd(a, b) === 0
  } catch {
    return false
  }
}

// ── a signed transaction still landing, remembered across close / reload ─────

/**
 * The one handle on a transaction the owner already signed is its intent hash.
 * It lives in the dialog's state — and here, so that closing the dialog or the
 * tab and coming back resumes confirming THAT transaction instead of offering
 * a new one. Kept for a day (a wallet-signed transaction lands within minutes
 * or not at all). Storage may be unavailable (private mode, blocked): then
 * this simply remembers nothing, and the card's manifestIssuedAt note is the
 * fallback.
 */
/**
 * How long after the Guild handed out a funding transaction it is plausible
 * that one is still landing, when this browser holds no record of signing it.
 * The stamp (manifestIssuedAt) is written BEFORE the wallet opens, so it
 * proves only that a transaction was prepared, not that one was signed; a
 * wallet-signed transaction lands within minutes or not at all. Used only for
 * the dialog's "may still be landing" note. Whether an expired pairing is
 * still HELD is a different question with the server's 24 h answer
 * (manifestMayStillLand) — the card uses that one.
 */
export const RECENT_MANIFEST_MS = 60 * 60 * 1000

const PENDING_KEY = (agentId: number) => `guild:agent-fund:${agentId}`
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000

type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">

/** localStorage, or null where it is unavailable (private mode, blocked, SSR). */
export function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

export function rememberPendingFund(store: KV | null, agentId: number, intentHash: string, now: number): void {
  try {
    store?.setItem(PENDING_KEY(agentId), JSON.stringify({ intentHash, at: now }))
  } catch {
    // storage unavailable: nothing remembered
  }
}

export function readPendingFund(store: KV | null, agentId: number, now: number): string | null {
  try {
    const raw = store?.getItem(PENDING_KEY(agentId))
    if (!raw) return null
    const v = JSON.parse(raw) as { intentHash?: unknown; at?: unknown }
    if (typeof v.intentHash !== "string" || !/^txid_rdx1[a-z0-9]{20,100}$/.test(v.intentHash)) return null
    if (typeof v.at !== "number" || now - v.at > PENDING_MAX_AGE_MS) return null
    return v.intentHash
  } catch {
    return null
  }
}

export function forgetPendingFund(store: KV | null, agentId: number): void {
  try {
    store?.removeItem(PENDING_KEY(agentId))
  } catch {
    // storage unavailable
  }
}

// ── what POST /agents/{id}/funded answered ──────────────────────────────────

export type FundedOutcome =
  | { kind: "active" }
  /** Not landed yet, or the chain could not be read: ask again. */
  | { kind: "retry"; code: string; message: string; retryAfterSec?: number }
  /** A settled answer that another poll will not change. */
  | { kind: "stop"; code: string; message: string }

/**
 * The confirm loop's own predicate. Only "not landed yet" and "could not read
 * the chain" are worth asking again; every other refusal is final for this
 * attempt. There is deliberately no chain-halt branch: the funded route is
 * never halt-gated (a halt is when an owner most needs to see where their
 * money went), so a halt reads as a slow landing, not a stop.
 */
export function classifyFunded(status: number, body: unknown, retryAfter?: string | null): FundedOutcome {
  const b = body as { ok?: boolean; error?: { code?: string; message?: string } } | null
  if (status === 200 && b?.ok) return { kind: "active" }
  const code = b?.error?.code ?? `HTTP_${status}`
  const message = b?.error?.message ?? "The Guild did not answer. Check again in a moment."
  if (code === "FUNDING_PENDING" || code === "GATEWAY_UNAVAILABLE" || status >= 500 || status === 0) {
    return { kind: "retry", code, message }
  }
  if (status === 429) {
    const s = Number(retryAfter)
    return { kind: "retry", code: "RATE_LIMITED", message: "Checking too often; pausing.", retryAfterSec: Number.isFinite(s) && s > 0 ? s : 10 }
  }
  return { kind: "stop", code, message }
}

/**
 * When to ask again, from how long this confirmation has been running: every
 * 4 s for the first 30 s (most transactions land here), then every 10 s, and
 * null after 3 minutes — past that the owner gets a "Check again" button, never
 * a verdict of failure. At most 11 calls in any minute (the first), inside
 * the route's 20/min limit with room for a manual "Check again".
 */
export function fundPollDelay(elapsedMs: number): number | null {
  if (elapsedMs >= 180_000) return null
  return elapsedMs < 30_000 ? 4_000 : 10_000
}
