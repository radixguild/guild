/**
 * session-outcome.ts — the sentences the escrow buttons show when sign-in does
 * not complete (2026-10-06, the money-buttons lane).
 *
 * Pure mapping tests (the toolkit's own codes → a reason and a sentence), plus
 * the one rule every new sentence here has to pass: the real honest-copy rule
 * table, because these lines are what a person reads when money did not move.
 */
import { describe, it, expect } from "vitest"
import { BANNED, PULL_BANNED, violation } from "../../scripts/honest-copy.mjs"
import {
  SESSION_FAILURE_MESSAGES,
  explainSignInRequestError,
  explainSignInThrow,
  explainVerifyRefusal,
  sessionFailure,
  signInDidNotComplete,
  walletErrorCode,
  type SessionFailureReason,
} from "@/lib/session-outcome"
import {
  TX_BACKSTOP,
  SIGN_IN_LEAD,
  WAIT_CLOSING,
  CANCEL_NOT_CANCELLABLE,
  CANCEL_SIGN_IN_INCOMPLETE,
  CANCEL_WALLET_WAIT_HINT,
  signInIncomplete,
  walletWaitHint,
} from "@/components/tasks/escrow-actions"

/** What walletApi.sendOneTimeRequest resolves err() with (SdkError, @radixdlt/radix-dapp-toolkit 2.2.1). */
const sdkError = (error: string, message = "") => ({ error, interactionId: "c0ffee00-0000-4000-8000-000000000006", message })

describe("explainSignInRequestError — the toolkit's own code decides the reason", () => {
  it.each<[string, SessionFailureReason, RegExp]>([
    ["missingExtension", "wallet-undelivered", /never received the sign-in request/i],
    ["SupportedTransportNotFound", "wallet-undelivered", /no way to reach the Radix Wallet/i],
    ["FailedToSendDappRequest", "wallet-undelivered", /could not open the Radix Wallet app/i],
    ["canceledByUser", "wallet-cancelled", /cancelled before your wallet answered/i],
    ["rejectedByUser", "wallet-declined", /declined the sign-in request in your wallet/i],
    ["wrongNetwork", "wallet-error", /did not complete the sign-in request/i],
  ])("%s → %s", (code, reason, re) => {
    const f = explainSignInRequestError(sdkError(code, "x"))
    expect(f.ok).toBe(false)
    expect(f.reason).toBe(reason)
    expect(f.message).toMatch(re)
    // The raw payload stays for the details expando — it carries the interactionId.
    expect(f.detail).toContain("c0ffee00-0000-4000-8000-000000000006")
    expect(f.detail).toContain(code)
  })

  it("reads the code from the payload's own `error` field only", () => {
    expect(walletErrorCode(sdkError("canceledByUser"))).toBe("canceledByUser")
    expect(walletErrorCode("canceledByUser")).toBeNull()
    expect(walletErrorCode({ error: 7 })).toBeNull()
    expect(walletErrorCode(null)).toBeNull()
    expect(explainSignInRequestError("something stringy").reason).toBe("wallet-error")
    expect(explainSignInRequestError("something stringy").detail).toBe("something stringy")
  })
})

describe("explainSignInThrow / explainVerifyRefusal", () => {
  it("a thrown challenge fetch is 'challenge-unavailable', any other throw is a wallet error with the text kept", () => {
    const c = explainSignInThrow(new Error("Failed to fetch ROLA challenge"))
    expect(c.reason).toBe("challenge-unavailable")
    expect(c.message).toMatch(/could not get a sign-in challenge/i)
    expect(c.detail).toBe("Failed to fetch ROLA challenge")
    const o = explainSignInThrow(new TypeError("Failed to fetch"))
    expect(o.reason).toBe("wallet-error")
    expect(o.detail).toBe("Failed to fetch")
  })

  it("/verify refusing keeps the status and the server's own message in the detail", () => {
    const r = explainVerifyRefusal(401, { code: "INVALID_PROOF", message: "signature does not verify" })
    expect(r.reason).toBe("unverified")
    expect(r.message).toMatch(/could not verify the signature/i)
    expect(r.detail).toBe("HTTP 401: signature does not verify")
    expect(explainVerifyRefusal(500, undefined).detail).toBe("HTTP 500")
    expect(explainVerifyRefusal(403, "blocked").detail).toBe("HTTP 403: blocked")
  })

  it("sessionFailure carries the detail only when there is one", () => {
    expect(sessionFailure("no-wallet")).toEqual({ ok: false, reason: "no-wallet", message: SESSION_FAILURE_MESSAGES["no-wallet"] })
    expect(sessionFailure("unreachable", "x").detail).toBe("x")
  })
})

describe("the button-side composition", () => {
  it("signInIncomplete leads with the button's certain fact, then the gate's cause and fix", () => {
    const f = sessionFailure("wallet-declined")
    const s = signInIncomplete(SIGN_IN_LEAD.claim, f)
    expect(s.startsWith(SIGN_IN_LEAD.claim)).toBe(true)
    expect(s).toContain(f.message)
    // Without a reported cause, the generic check for the one silent case.
    const g = signInIncomplete(SIGN_IN_LEAD.claim)
    expect(g.startsWith(SIGN_IN_LEAD.claim)).toBe(true)
    expect(g).toMatch(/didn't get through/i)
    expect(CANCEL_SIGN_IN_INCOMPLETE).toBe(signInIncomplete(SIGN_IN_LEAD.cancel))
    expect(CANCEL_WALLET_WAIT_HINT).toBe(walletWaitHint(WAIT_CLOSING.cancel))
  })

  it("signInDidNotComplete is the page-side shape: the page's own fact, then the gate's cause", () => {
    const s = signInDidNotComplete("no task was posted", sessionFailure("unreachable"))
    expect(s.startsWith("Sign-in didn't complete, so no task was posted.")).toBe(true)
    expect(s).toMatch(/could not reach the site/i)
  })

  it("every lead but resync's states that no transaction was sent", () => {
    for (const [key, lead] of Object.entries(SIGN_IN_LEAD)) {
      if (key === "resync") expect(lead).toMatch(/nothing was re-synced/i)
      else expect(lead).toMatch(/no [a-z-]+ transaction was sent to your wallet/i)
    }
  })

  it("every wait hint ends with its button's own closing", () => {
    for (const closing of Object.values(WAIT_CLOSING)) {
      expect(walletWaitHint(closing).endsWith(closing)).toBe(true)
      expect(closing).toMatch(/until you approve/i)
    }
  })
})

describe("every sentence clears the real honest-copy rule table", () => {
  const ALL_RULES = [...BANNED, ...PULL_BANNED]
  const texts: string[] = [
    ...Object.values(SESSION_FAILURE_MESSAGES),
    explainSignInRequestError(sdkError("SupportedTransportNotFound")).message,
    explainSignInRequestError(sdkError("FailedToSendDappRequest")).message,
    TX_BACKSTOP,
    CANCEL_NOT_CANCELLABLE,
    ...Object.values(SIGN_IN_LEAD),
    ...Object.values(WAIT_CLOSING).map(walletWaitHint),
    ...Object.values(SIGN_IN_LEAD).map((lead) => signInIncomplete(lead)),
    ...Object.values(SIGN_IN_LEAD).map((lead) => signInIncomplete(lead, sessionFailure("account-mismatch"))),
    ...["nothing was changed", "no pool was opened", "no group was proposed", "you did not join", "no project was created", "your work was not submitted", "no task was posted", "no agent code was created", "nothing was funded", "your review was not submitted"].map((c) => signInDidNotComplete(c, sessionFailure("wallet-declined"))),
  ]
  it.each(texts)("no BANNED or PULL_BANNED rule fires on: %s", (text) => {
    expect(text.length).toBeGreaterThan(30) // vacuous-pass guard
    const hits = ALL_RULES.map((r: unknown) => violation(text, r)).filter(Boolean)
    expect(hits, `banned claim(s): ${hits.join(" | ")}`).toEqual([])
  })
})
