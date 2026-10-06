/**
 * What a sign-in attempt reports back (2026-10-06, the money-buttons lane).
 *
 * Every escrow button presses through one gate, ensureSession(), before it
 * hands a transaction to the wallet. Until this file that gate answered a
 * bare boolean — and signIn's /verify fetch could throw straight through it —
 * so a button could not say WHY the wallet showed nothing: the ROLA request
 * never delivered, declined in the wallet, cancelled from the Connect button,
 * the challenge not fetched, /verify refusing, the network down, or a proof
 * signed with an account the wallet does not share. Each of those now comes
 * back as a `SessionFailure` with a sentence the button shows under one
 * certain fact it adds itself: no transaction was sent.
 *
 * Pure: no React, no toolkit import — the mapping is unit-tested against the
 * toolkit's own error codes and the honest-copy rule table.
 */

export type SessionFailureReason =
  /** No RadixDappToolkit instance yet (the wallet is not connected). */
  | "no-wallet"
  /** The site did not issue a ROLA challenge, so no request reached the wallet. */
  | "challenge-unavailable"
  /** The dApp toolkit could not hand the sign-in request to the wallet. */
  | "wallet-undelivered"
  /** The pending request was cancelled from the Connect button / by disconnecting. */
  | "wallet-cancelled"
  /** The user declined the request in the wallet. */
  | "wallet-declined"
  /** The wallet answered with an error this file has no sentence for (code in `detail`). */
  | "wallet-error"
  /** The wallet signed; POST /api/v1/auth/verify refused (status + body in `detail`). */
  | "unverified"
  /** The wallet signed; the /verify fetch itself threw (network). */
  | "unreachable"
  /** The wallet signed with an account it does not currently share with this site. */
  | "account-mismatch"

export interface SessionFailure {
  ok: false
  reason: SessionFailureReason
  /** One or two sentences: what happened and what to do. Never says what was sent — the button adds that. */
  message: string
  /** The raw cause (toolkit code + message, HTTP status + body, the thrown text) for a details expando. */
  detail?: string
}

export type SessionOutcome = { ok: true } | SessionFailure

export const SESSION_OK: SessionOutcome = { ok: true }

/** The sentence for each reason. Each one clears the honest-copy rule table (session-outcome.test.ts). */
export const SESSION_FAILURE_MESSAGES: Record<SessionFailureReason, string> = {
  "no-wallet":
    "No wallet is connected to this page. Connect with the Connect button at the top, then try again.",
  "challenge-unavailable":
    "This page could not get a sign-in challenge from the site, so no sign-in request reached your wallet. Check your connection and try again.",
  "wallet-undelivered":
    "Your wallet never received the sign-in request. Reload the page, or disconnect and reconnect with the Connect button at the top, then try again.",
  "wallet-cancelled":
    "The sign-in request was cancelled before your wallet answered (from the Connect button, or by disconnecting). Press the button again and approve the sign-in in your wallet.",
  "wallet-declined":
    "You declined the sign-in request in your wallet. Press the button again and approve the sign-in to continue.",
  "wallet-error":
    "Your wallet did not complete the sign-in request. Try again; if it repeats, disconnect and reconnect with the Connect button at the top.",
  unverified:
    "Your wallet signed, but this site could not verify the signature. Try again; if it repeats, disconnect and reconnect with the Connect button at the top.",
  unreachable:
    "Your wallet signed, but this page could not reach the site to verify it. Check your connection and try again.",
  "account-mismatch":
    "You signed in with an account this page is not connected to. When the wallet asks, sign with the connected account, or share that account with this site in your wallet.",
}

/**
 * dApp toolkit codes for a sign-in (one-time data) request, and the reason
 * each one means. The codes are the toolkit's own `error` field on the
 * SdkError that walletApi.sendOneTimeRequest resolves err() with
 * (@radixdlt/radix-dapp-toolkit 2.2.1, dist/index.js): the first three are
 * the request not getting through at all, the fourth the page giving up on it,
 * the fifth the person saying no in the wallet.
 */
const WALLET_CODE_REASON: Record<string, SessionFailureReason> = {
  missingExtension: "wallet-undelivered",
  SupportedTransportNotFound: "wallet-undelivered",
  FailedToSendDappRequest: "wallet-undelivered",
  canceledByUser: "wallet-cancelled",
  rejectedByUser: "wallet-declined",
}

/** Where the generic "wallet-undelivered" line would hide the specific fix. */
const WALLET_CODE_MESSAGE: Record<string, string> = {
  SupportedTransportNotFound:
    "This browser has no way to reach the Radix Wallet, so the sign-in request was never sent. Use a desktop browser with the Radix Connector extension, or a browser the Radix mobile flow supports.",
  FailedToSendDappRequest:
    "This page could not open the Radix Wallet app for the sign-in request. Open the wallet, reconnect with the Connect button at the top, then try again.",
}

export function sessionFailure(reason: SessionFailureReason, detail?: string): SessionFailure {
  return detail ? { ok: false, reason, message: SESSION_FAILURE_MESSAGES[reason], detail } : { ok: false, reason, message: SESSION_FAILURE_MESSAGES[reason] }
}

/** The toolkit's own code from the err() payload of a wallet request — `{ error, interactionId, message }` — or null. */
export function walletErrorCode(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null
  const code = (raw as { error?: unknown }).error
  return typeof code === "string" ? code : null
}

function describe(raw: unknown): string {
  if (typeof raw === "string") return raw
  if (raw instanceof Error) return raw.message
  try {
    return JSON.stringify(raw)
  } catch {
    return String(raw)
  }
}

/** The wallet (via the toolkit) answered the sign-in request with an error. */
export function explainSignInRequestError(raw: unknown): SessionFailure {
  const code = walletErrorCode(raw)
  const reason = (code && WALLET_CODE_REASON[code]) || "wallet-error"
  const failure = sessionFailure(reason, describe(raw))
  const specific = code ? WALLET_CODE_MESSAGE[code] : undefined
  return specific ? { ...failure, message: specific } : failure
}

/** The sign-in request itself threw before the wallet answered (the toolkit rejects when its challenge generator throws). */
export function explainSignInThrow(e: unknown): SessionFailure {
  const text = describe(e)
  if (/ROLA challenge/i.test(text)) return sessionFailure("challenge-unavailable", text)
  return sessionFailure("wallet-error", text)
}

/** POST /api/v1/auth/verify answered, and said no. */
export function explainVerifyRefusal(status: number, error: unknown): SessionFailure {
  let text = ""
  if (typeof error === "string") text = error
  else if (error && typeof error === "object" && "message" in error) text = String((error as { message: unknown }).message)
  else if (error) text = describe(error)
  return sessionFailure("unverified", text ? `HTTP ${status}: ${text}` : `HTTP ${status}`)
}
