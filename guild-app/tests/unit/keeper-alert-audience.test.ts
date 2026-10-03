import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { sendAlert } from "../../scripts/lib/keeper-alert.mjs"

/**
 * Operator ruling 2026-08-29: "dispute-lifecycle notifications must reach the
 * affected users and the arbiter — NOT admin. The operator is paged only for
 * functional breakage."
 *
 * The keeper's ONLY alert was the lapsed-dispute page, and it went to the
 * operator's chat. That is the alert bigdev was being pinged by every 30
 * minutes; it was never an operator concern, it was the arbiter's job arriving.
 *
 * These tests pin the ADDRESSING, which is the part the ruling is about. The
 * destination chat may currently be the same phone — the arbiter badge sits in
 * the operator's wallet — and that is fine and explicitly expected. What must
 * not regress is the wiring silently going back to naming admin.
 */
const ORIGINAL = { ...process.env }
let calls: { chat: string; text: string }[] = []

beforeEach(() => {
  calls = []
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body)
    calls.push({ chat: body.chat_id, text: body.text })
    return { ok: true } as Response
  })
  process.env.KEEPER_ALERT_TG_TOKEN = "test-token"
  process.env.KEEPER_ALERT_TG_CHAT = "OPERATOR_CHAT"
  delete process.env.KEEPER_ALERT_TG_CHAT_ARBITER
})
afterEach(() => {
  process.env = { ...ORIGINAL }
  vi.unstubAllGlobals()
})

describe("keeper alerts are addressed to a ROLE", () => {
  it("refuses to send without an explicit audience", async () => {
    // No default, deliberately: a default is how every dispute page ended up
    // going to admin in the first place — whoever added the next alert would
    // inherit whichever addressee was convenient.
    // @ts-expect-error — the point of the test is the missing argument
    await expect(sendAlert("hello")).rejects.toThrow(/explicit audience/)
    expect(calls).toHaveLength(0)
  })

  it("routes an arbiter alert to the arbiter chat when one is configured", async () => {
    process.env.KEEPER_ALERT_TG_CHAT_ARBITER = "ARBITER_CHAT"
    await sendAlert("dispute lapsed", "arbiter")
    expect(calls).toHaveLength(1)
    expect(calls[0].chat).toBe("ARBITER_CHAT")
    // No stand-in disclaimer when it really reached the arbiter's channel.
    expect(calls[0].text).not.toMatch(/because KEEPER_ALERT_TG_CHAT_ARBITER is unset/)
  })

  it("falls back to the operator chat but SAYS the message is for the arbiter", async () => {
    // The honest half. Today the badge is in the operator's wallet, so the
    // fallback is correct — but a page that looks identical to an admin page
    // is how the addressing got lost before. The disclaimer is what keeps a
    // stand-in from being mistaken for a real arbiter channel.
    await sendAlert("dispute lapsed", "arbiter")
    expect(calls).toHaveLength(1)
    expect(calls[0].chat).toBe("OPERATOR_CHAT")
    expect(calls[0].text).toMatch(/addressed to the ARBITER role/)
  })

  it("sends an operator alert to the operator chat, undecorated", async () => {
    // Functional breakage still pages the operator, unchanged and unadorned.
    process.env.KEEPER_ALERT_TG_CHAT_ARBITER = "ARBITER_CHAT"
    await sendAlert("drift detected", "operator")
    expect(calls).toHaveLength(1)
    expect(calls[0].chat).toBe("OPERATOR_CHAT")
    expect(calls[0].text).toBe("drift detected")
  })

  it("fails soft when no chat is configured at all", async () => {
    // Alerting must never break detection logging.
    delete process.env.KEEPER_ALERT_TG_CHAT
    await expect(sendAlert("dispute lapsed", "arbiter")).resolves.toBe(false)
    expect(calls).toHaveLength(0)
  })
})
