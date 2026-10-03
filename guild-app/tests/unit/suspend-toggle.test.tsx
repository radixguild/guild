import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * Suspend / Resume on the owner's card (A2.4). The control is offered only
 * when the server's `actions` admit it, sends exactly one request per press,
 * and the card becomes what the server answered — a refusal is the server's
 * own message, never a state this page assumed.
 */

const H = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock("@/lib/api-fetch", () => ({ apiFetch: (...a: unknown[]) => H.fetch(...a) }))

import { SuspendToggle } from "@/components/agents/suspend-toggle"
import { cardFromResponse, type AgentCardData } from "@/components/agents/status"
import { cardLimits, ownerActions } from "@/db/queries/agents"
import { AGENT_STATUSES } from "@/db/schema/agents"
import { defaultAgentRules } from "@/lib/agent-rules"

const card = (over: Partial<AgentCardData> = {}): AgentCardData => ({
  id: 7,
  label: "Scout",
  labelNorm: "scout",
  agentAccount: "account_rdx128m9cmv5gyrdzeqh4r3sp8x3rymkz8wflznqxmyagrcrfsrsf9jwfx",
  status: "active",
  floatXrd: "200",
  badgeId: "<guild_member_scout>",
  pairTx: null,
  rules: defaultAgentRules("200"),
  lastSeenAt: null,
  lastCycle: null,
  createdAt: "2026-09-25T12:00:00.000Z",
  activatedAt: "2026-09-25T13:00:00.000Z",
  suspendedAt: null,
  retiredAt: null,
  manifestIssuedAt: null,
  ...over,
  actions: over.actions ?? ownerActions(over.status ?? "active"),
  limits: over.limits ?? cardLimits(over.floatXrd ?? "200"),
})
const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body, headers: new Headers(headers) }) as unknown as Response
const refused = (status: number, code: string, message: string) => res(status, { ok: false, error: { code, message } })

function mount(agent: AgentCardData) {
  const onUpdated = vi.fn()
  const onChanged = vi.fn()
  const ui = render(<SuspendToggle agent={agent} onUpdated={onUpdated} onChanged={onChanged} />)
  return { ui, onUpdated, onChanged }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  H.fetch.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("which control the card offers comes from the server's actions", () => {
  it.each(AGENT_STATUSES)("status %s: exactly the control the server admits", (status) => {
    const a = card({ status })
    mount(a)
    expect(screen.queryByTestId("agent-suspend") !== null).toBe(a.actions.suspend)
    expect(screen.queryByTestId("agent-resume") !== null).toBe(a.actions.resume)
  })

  it("🔴 follows `actions`, not `status`: an active card the server says cannot be suspended shows nothing", () => {
    mount(card({ status: "active", actions: { ...ownerActions("active"), suspend: false } }))
    expect(screen.queryByRole("button")).toBeNull()
  })
})

describe("pressing it", () => {
  it("🔴 POSTs the action once and applies the card the server answered with", async () => {
    const after = card({ status: "suspended", suspendedAt: "2026-09-27T10:00:00.000Z" })
    H.fetch.mockResolvedValue(res(200, { ok: true, data: after }))
    const { onUpdated, onChanged } = mount(card())
    fireEvent.click(screen.getByTestId("agent-suspend"))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(after))
    expect(H.fetch).toHaveBeenCalledTimes(1)
    expect(H.fetch).toHaveBeenCalledWith("/api/v1/agents/7/suspend", { method: "POST" })
    expect(onChanged).not.toHaveBeenCalled()
  })

  it("resume posts to /resume", async () => {
    H.fetch.mockResolvedValue(res(200, { ok: true, data: card() }))
    mount(card({ status: "suspended" }))
    fireEvent.click(screen.getByTestId("agent-resume"))
    await waitFor(() => expect(H.fetch).toHaveBeenCalledWith("/api/v1/agents/7/resume", { method: "POST" }))
  })

  it("🔴 a double press sends ONE request", async () => {
    let settle: (r: Response) => void = () => {}
    H.fetch.mockReturnValue(new Promise<Response>((r) => (settle = r)))
    const { onUpdated } = mount(card())
    const button = screen.getByTestId("agent-suspend")
    // Both presses land in ONE render batch, before `disabled` can reach the
    // DOM — only the in-flight guard can stop the second.
    act(() => {
      button.click()
      button.click()
    })
    fireEvent.click(button)
    settle(res(200, { ok: true, data: card({ status: "suspended" }) }))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1))
    expect(H.fetch).toHaveBeenCalledTimes(1)
  })

  it("🔴 a card for ANOTHER agent is never applied — the list is re-read instead", async () => {
    H.fetch.mockResolvedValue(res(200, { ok: true, data: card({ id: 99, status: "suspended" }) }))
    const { onUpdated, onChanged } = mount(card())
    fireEvent.click(screen.getByTestId("agent-suspend"))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(onUpdated).not.toHaveBeenCalled()
  })
})

describe("a refusal is the server's own words", () => {
  it("🔴 wrong state: its message is shown AND the list is re-read (the card was behind)", async () => {
    H.fetch.mockResolvedValue(refused(409, "AGENT_WRONG_STATE", "Cannot suspend an agent that is retired."))
    const { onUpdated, onChanged } = mount(card())
    fireEvent.click(screen.getByTestId("agent-suspend"))
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot suspend an agent that is retired.")
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(onUpdated).not.toHaveBeenCalled()
  })

  it("not found: shown, list re-read", async () => {
    H.fetch.mockResolvedValue(refused(404, "AGENT_NOT_FOUND", "No such agent on your account."))
    const { onChanged } = mount(card())
    fireEvent.click(screen.getByTestId("agent-suspend"))
    expect(await screen.findByRole("alert")).toHaveTextContent("No such agent on your account.")
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it("rate limited: the wait the server asked for", async () => {
    H.fetch.mockResolvedValue(res(429, null, { "Retry-After": "42" }))
    const { onChanged } = mount(card())
    fireEvent.click(screen.getByTestId("agent-suspend"))
    expect(await screen.findByRole("alert")).toHaveTextContent("Wait 42 seconds")
    expect(onChanged).not.toHaveBeenCalled()
  })

  it("🔴 no answer at all: never 'nothing changed' — the list is re-read to show where it stands", async () => {
    H.fetch.mockRejectedValue(new TypeError("Failed to fetch"))
    const { onChanged } = mount(card())
    fireEvent.click(screen.getByTestId("agent-suspend"))
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("No answer from the Guild")
    expect(alert).not.toHaveTextContent(/nothing changed/i)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it("the button is usable again after a refusal", async () => {
    H.fetch.mockResolvedValue(refused(409, "AGENT_WRONG_STATE", "Cannot suspend an agent that is pending."))
    mount(card())
    fireEvent.click(screen.getByTestId("agent-suspend"))
    await screen.findByRole("alert")
    expect(screen.getByTestId("agent-suspend")).toBeEnabled()
  })
})

describe("cardFromResponse", () => {
  it("accepts only an ok body carrying a card for THIS agent", () => {
    const c = card()
    expect(cardFromResponse({ ok: true, data: c }, 7)).toBe(c)
    expect(cardFromResponse({ ok: true, data: c }, 8)).toBeNull()
    expect(cardFromResponse({ ok: false, data: c }, 7)).toBeNull()
    expect(cardFromResponse({ ok: true, data: { ...c, actions: undefined } }, 7)).toBeNull()
    expect(cardFromResponse({ ok: true, data: { ...c, limits: undefined } }, 7)).toBeNull()
    expect(cardFromResponse(null, 7)).toBeNull()
  })
})
