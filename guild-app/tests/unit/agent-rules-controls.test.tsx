import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor, act, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * The owner's rules controls (A2.4b): Start / Pause and the rules form. Both
 * are offered only when the server's `actions` admit an edit, state only the
 * server's numbers (`limits`), always submit and show the server's answer,
 * and never write back a stale copy of rules the owner has since changed.
 */

const H = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock("@/lib/api-fetch", () => ({ apiFetch: (...a: unknown[]) => H.fetch(...a) }))

import { StartPause } from "@/components/agents/start-pause"
import { RulesDialog } from "@/components/agents/rules-dialog"
import { ownerRequest, NO_ANSWER } from "@/components/agents/owner-request"
import type { AgentCardData } from "@/components/agents/status"
import { cardLimits, ownerActions } from "@/db/queries/agents"
import { defaultAgentRules, GUILD_POSTERS } from "@/lib/agent-rules"

const STRANGER = "account_rdx128k4ew7te5n3aetfkraejs90eunx8zs4uuwlh90ayq3w8uratgkqt8"
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
const refused = (status: number, code: string, message: string, issues?: { path: string; message: string }[]) =>
  res(status, { ok: false, error: { code, message, ...(issues ? { detail: { issues } } : {}) } })
const sentBody = (n = 0) => JSON.parse((H.fetch.mock.calls[n][1] as { body: string }).body)

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  H.fetch.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function mountStart(agent: AgentCardData) {
  const onUpdated = vi.fn()
  const onChanged = vi.fn()
  const ui = render(<StartPause agent={agent} onUpdated={onUpdated} onChanged={onChanged} />)
  return { ui, onUpdated, onChanged }
}
function mountRules(agent: AgentCardData) {
  const onUpdated = vi.fn()
  const onChanged = vi.fn()
  const ui = render(<RulesDialog agent={agent} onUpdated={onUpdated} onChanged={onChanged} />)
  return { ui, onUpdated, onChanged }
}

describe("Start / Pause", () => {
  it("🔴 offered from the server's `actions`, not from `status`", () => {
    mountStart(card({ status: "active", actions: { ...ownerActions("active"), start: false } }))
    expect(screen.queryByRole("button")).toBeNull()
    cleanup()
    mountStart(card({ status: "active", rules: { ...defaultAgentRules("200"), dryRun: false }, actions: { ...ownerActions("active"), edit: false } }))
    expect(screen.queryByRole("button")).toBeNull()
    cleanup()
    mountStart(card({ status: "retired" }))
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("🔴 a pending (unfunded) agent offers no Start — it practises first; it can still be paused", () => {
    mountStart(card({ status: "pending", activatedAt: null }))
    expect(screen.queryByTestId("agent-start")).toBeNull()
    cleanup()
    mountStart(card({ status: "pending", activatedAt: null, rules: { ...defaultAgentRules("200"), dryRun: false } }))
    expect(screen.getByTestId("agent-pause")).toBeInTheDocument()
  })

  it("🔴 Start asks first, showing the rules it will run on — and sends those rules as baseRules", async () => {
    const rules = { ...defaultAgentRules("200"), maxClaimsPerDay: 3 }
    const after = card({ rules: { ...rules, dryRun: false } })
    H.fetch.mockResolvedValue(res(200, { ok: true, data: after }))
    const { onUpdated } = mountStart(card({ rules }))
    fireEvent.click(screen.getByTestId("agent-start"))
    expect(H.fetch).not.toHaveBeenCalled()
    const summary = await screen.findByTestId("start-rules")
    expect(summary).toHaveTextContent("Up to 3 claims a day")
    expect(summary).toHaveTextContent("its 2 trusted posters")
    expect(summary).toHaveTextContent("180")
    fireEvent.click(screen.getByTestId("agent-start-confirm"))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(after))
    expect(H.fetch.mock.calls[0][0]).toBe("/api/v1/agents/7")
    expect(H.fetch.mock.calls[0][1].method).toBe("PATCH")
    expect(sentBody()).toEqual({ dryRun: false, baseRules: rules })
    await waitFor(() => expect(screen.queryByTestId("start-rules")).toBeNull())
  })

  it("says plainly when the rules allow no claims at all", async () => {
    mountStart(card({ rules: { ...defaultAgentRules("200"), trustedPosters: [], maxClaimsPerDay: 0 } }))
    fireEvent.click(screen.getByTestId("agent-start"))
    const summary = await screen.findByTestId("start-rules")
    expect(summary).toHaveTextContent("It trusts no posters, so its rules allow no claims.")
    expect(summary).toHaveTextContent("Up to 0 claims a day — so its rules allow no claims.")
  })

  it("🔴 Pause sends dryRun ALONE — never this page's copy of the other rules, never a baseRules that could refuse it", async () => {
    H.fetch.mockResolvedValue(res(200, { ok: true, data: card() }))
    const { onUpdated } = mountStart(card({ rules: { ...defaultAgentRules("200"), dryRun: false } }))
    fireEvent.click(screen.getByTestId("agent-pause"))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1))
    expect(sentBody()).toEqual({ dryRun: true })
  })

  it("🔴 Start on rules that changed meanwhile: the server's refusal, in the dialog, and the list re-read", async () => {
    H.fetch.mockResolvedValue(refused(409, "RULES_CHANGED", "These rules were changed meanwhile (another tab or device). Reload to see them, then try again."))
    const { onUpdated, onChanged } = mountStart(card())
    fireEvent.click(screen.getByTestId("agent-start"))
    fireEvent.click(await screen.findByTestId("agent-start-confirm"))
    expect(await screen.findByRole("alert")).toHaveTextContent("These rules were changed meanwhile")
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(onUpdated).not.toHaveBeenCalled()
    expect(screen.getByTestId("start-rules")).toBeInTheDocument() // still open, showing the refreshed rules once they land
  })

  it("🔴 Start on rules that changed meanwhile, with the server's current card: that card is applied at once", async () => {
    const now = card({ rules: { ...defaultAgentRules("200"), trustedPosters: [] } })
    H.fetch.mockResolvedValue(res(409, { ok: false, error: { code: "RULES_CHANGED", message: "changed meanwhile", detail: { card: now } } }))
    const { onUpdated, onChanged } = mountStart(card())
    fireEvent.click(screen.getByTestId("agent-start"))
    fireEvent.click(await screen.findByTestId("agent-start-confirm"))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(now))
    expect(onChanged).not.toHaveBeenCalled()
  })

  it("🔴 a double press on Start sends ONE request", async () => {
    let settle: (r: Response) => void = () => {}
    H.fetch.mockReturnValue(new Promise<Response>((r) => (settle = r)))
    const { onUpdated } = mountStart(card())
    fireEvent.click(screen.getByTestId("agent-start"))
    const confirm = await screen.findByTestId("agent-start-confirm")
    act(() => {
      confirm.click()
      confirm.click()
    })
    settle(res(200, { ok: true, data: card({ rules: { ...defaultAgentRules("200"), dryRun: false } }) }))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1))
    expect(H.fetch).toHaveBeenCalledTimes(1)
  })

  it("Pause with no answer: never 'nothing changed' — the list is re-read", async () => {
    H.fetch.mockRejectedValue(new TypeError("Failed to fetch"))
    const { onChanged } = mountStart(card({ rules: { ...defaultAgentRules("200"), dryRun: false } }))
    fireEvent.click(screen.getByTestId("agent-pause"))
    expect(await screen.findByRole("alert")).toHaveTextContent(NO_ANSWER)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })
})

describe("the rules form", () => {
  const open = async () => {
    fireEvent.click(screen.getByTestId("agent-rules"))
    return screen.findByRole("dialog")
  }

  it("🔴 offered from the server's `actions`, not from `status`", () => {
    mountRules(card({ status: "active", actions: { ...ownerActions("active"), edit: false } }))
    expect(screen.queryByTestId("agent-rules")).toBeNull()
  })

  it("🔴 states the SERVER's bounds (`limits`), never its own arithmetic on the float", async () => {
    mountRules(card({ floatXrd: "200", limits: { maxBondXrd: "123", feeReserveXrd: "7", maxClaimsPerDay: 9, maxTrustedPosters: 4 } }))
    const d = await open()
    expect(d).toHaveTextContent("123")
    expect(d).toHaveTextContent("7")
    expect(d).toHaveTextContent("0 to 9")
    expect(d).toHaveTextContent("At most 4")
    expect(d).not.toHaveTextContent("180")
  })

  it("lists the posters, marks the Guild's own, and says what trusting one means", async () => {
    mountRules(card({ rules: { ...defaultAgentRules("200"), trustedPosters: [GUILD_POSTERS[0], STRANGER] } }))
    const d = await open()
    const items = within(screen.getByTestId("poster-list")).getAllByRole("listitem")
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent("Guild")
    expect(items[1]).not.toHaveTextContent("Guild")
    expect(within(d).getByTestId("poster-disclosure")).toHaveTextContent("read and act on the task text")
  })

  it("🔴 Save sends the whole v1 document with the rules it started from — practice mode kept as the server had it", async () => {
    const rules = { ...defaultAgentRules("200"), dryRun: false }
    const after = card({ rules: { ...rules, trustedPosters: [GUILD_POSTERS[1]] } })
    H.fetch.mockResolvedValue(res(200, { ok: true, data: after }))
    const { onUpdated } = mountRules(card({ rules }))
    await open()
    fireEvent.click(screen.getByRole("button", { name: `Remove ${GUILD_POSTERS[0]}` }))
    fireEvent.click(screen.getByTestId("rules-save"))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(after))
    expect(sentBody()).toEqual({
      rules: { v: 1, trustedPosters: [GUILD_POSTERS[1]], maxBondXrd: "180", maxClaimsPerDay: 1, dryRun: false },
      baseRules: rules,
    })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("Save is off until something changed", async () => {
    mountRules(card())
    await open()
    expect(screen.getByTestId("rules-save")).toBeDisabled()
    fireEvent.change(screen.getByLabelText("Claims a day"), { target: { value: "2" } })
    expect(screen.getByTestId("rules-save")).toBeEnabled()
  })

  it("adding a poster: a non-account is refused with a hint, a duplicate too; an account is added", async () => {
    mountRules(card())
    await open()
    const input = screen.getByLabelText("Poster account to trust")
    fireEvent.change(input, { target: { value: "identity_rdx1abc" } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(screen.getByRole("alert")).toHaveTextContent("not a Radix account address")
    fireEvent.change(input, { target: { value: GUILD_POSTERS[0] } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(screen.getByRole("alert")).toHaveTextContent("already on the list")
    fireEvent.change(input, { target: { value: ` ${STRANGER} ` } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(within(screen.getByTestId("poster-list")).getAllByRole("listitem")).toHaveLength(3)
    expect(input).toHaveValue("")
  })

  it("🔴 a malformed daily limit is sent as typed and the SERVER's issue is shown under that field", async () => {
    H.fetch.mockResolvedValue(
      refused(400, "VALIDATION_ERROR", "rules must be the v1 rules document", [{ path: "maxClaimsPerDay", message: "Invalid input: expected number, received string" }]),
    )
    mountRules(card())
    await open()
    fireEvent.change(screen.getByLabelText("Claims a day"), { target: { value: "lots" } })
    fireEvent.click(screen.getByTestId("rules-save"))
    expect(await screen.findByText("Invalid input: expected number, received string")).toBeInTheDocument()
    expect(screen.getByLabelText("Claims a day")).toHaveAttribute("aria-invalid", "true")
    expect(sentBody().rules.maxClaimsPerDay).toBe("lots")
  })

  it("🔴 a bond over the float's limit: the server's MAX_BOND_EXCEEDS_FLOAT, under the bond field — no client pre-block", async () => {
    H.fetch.mockResolvedValue(refused(400, "MAX_BOND_EXCEEDS_FLOAT", "The largest bond (500 XRD) must leave 20 XRD of the float for fees."))
    mountRules(card())
    await open()
    fireEvent.change(screen.getByLabelText("Largest bond per claim (XRD)"), { target: { value: "500" } })
    fireEvent.click(screen.getByTestId("rules-save"))
    expect(await screen.findByText(/must leave 20 XRD of the float/)).toBeInTheDocument()
    expect(screen.getByLabelText("Largest bond per claim (XRD)")).toHaveAttribute("aria-invalid", "true")
    expect(H.fetch).toHaveBeenCalledTimes(1)
    expect(sentBody().rules.maxBondXrd).toBe("500")
  })

  it("🔴 rules changed meanwhile: refused, the list re-read, Save held until the owner starts again from the current rules", async () => {
    H.fetch.mockResolvedValue(refused(409, "RULES_CHANGED", "These rules were changed meanwhile (another tab or device). Reload to see them, then try again."))
    const agent = card()
    const { ui, onChanged } = mountRules(agent)
    await open()
    fireEvent.change(screen.getByLabelText("Claims a day"), { target: { value: "4" } })
    fireEvent.click(screen.getByTestId("rules-save"))
    expect(await screen.findByText(/changed meanwhile/)).toBeInTheDocument()
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("rules-save")).toBeDisabled()
    // the list's refresh lands with the rules the other device saved
    const current = { ...agent.rules, trustedPosters: [] as string[] }
    ui.rerender(<RulesDialog agent={card({ rules: current })} onUpdated={() => {}} onChanged={onChanged} />)
    fireEvent.click(screen.getByRole("button", { name: "Start again from the current rules" }))
    expect(within(screen.getByTestId("poster-list")).queryAllByRole("listitem")).toHaveLength(0)
    expect(screen.getByLabelText("Claims a day")).toHaveValue("1")
    fireEvent.change(screen.getByLabelText("Claims a day"), { target: { value: "4" } })
    H.fetch.mockResolvedValue(res(200, { ok: true, data: card({ rules: { ...current, maxClaimsPerDay: 4 } }) }))
    fireEvent.click(screen.getByTestId("rules-save"))
    await waitFor(() => expect(H.fetch).toHaveBeenCalledTimes(2))
    expect(sentBody(1).baseRules).toEqual(current)
  })

  it("🔴 the list's refreshes never reset a draft that is open", async () => {
    const { ui } = mountRules(card())
    await open()
    fireEvent.change(screen.getByLabelText("Claims a day"), { target: { value: "7" } })
    ui.rerender(<RulesDialog agent={card({ lastSeenAt: new Date().toISOString(), rules: { ...defaultAgentRules("200"), maxClaimsPerDay: 2 } })} onUpdated={() => {}} onChanged={() => {}} />)
    expect(screen.getByLabelText("Claims a day")).toHaveValue("7")
  })

  it("🔴 a double Save sends ONE request", async () => {
    let settle: (r: Response) => void = () => {}
    H.fetch.mockReturnValue(new Promise<Response>((r) => (settle = r)))
    const { onUpdated } = mountRules(card())
    await open()
    fireEvent.change(screen.getByLabelText("Claims a day"), { target: { value: "2" } })
    const save = screen.getByTestId("rules-save")
    act(() => {
      save.click()
      save.click()
    })
    settle(res(200, { ok: true, data: card() }))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1))
    expect(H.fetch).toHaveBeenCalledTimes(1)
  })
})

describe("ownerRequest — what an answer means", () => {
  it("a card for THIS agent is applied; a card for another, or no card, means re-read", async () => {
    H.fetch.mockResolvedValueOnce(res(200, { ok: true, data: card() }))
    expect((await ownerRequest(7, "/suspend", { method: "POST" })).kind).toBe("card")
    H.fetch.mockResolvedValueOnce(res(200, { ok: true, data: card({ id: 8 }) }))
    expect(await ownerRequest(7, "/suspend", { method: "POST" })).toEqual({ kind: "reload", message: null })
  })

  it("🔴 only the 'card is behind' codes ask for a re-read", async () => {
    for (const code of ["AGENT_WRONG_STATE", "AGENT_NOT_FOUND", "RULES_CHANGED", "AGENT_CHANGED"]) {
      H.fetch.mockResolvedValueOnce(refused(409, code, "x"))
      expect(await ownerRequest(7, "", { method: "PATCH" })).toMatchObject({ kind: "refused", reload: true })
    }
    H.fetch.mockResolvedValueOnce(refused(400, "MAX_BOND_EXCEEDS_FLOAT", "x"))
    expect(await ownerRequest(7, "", { method: "PATCH" })).toMatchObject({ kind: "refused", reload: false })
  })

  it("🔴 a refusal's card is passed on only when it is a card for THIS agent", async () => {
    const mine = card()
    H.fetch.mockResolvedValueOnce(res(409, { ok: false, error: { code: "RULES_CHANGED", message: "x", detail: { card: mine } } }))
    expect(await ownerRequest(7, "", { method: "PATCH" })).toMatchObject({ kind: "refused", card: mine })
    H.fetch.mockResolvedValueOnce(res(409, { ok: false, error: { code: "RULES_CHANGED", message: "x", detail: { card: card({ id: 8 }) } } }))
    const other = await ownerRequest(7, "", { method: "PATCH" })
    expect(other.kind === "refused" && other.card).toBeFalsy()
    H.fetch.mockResolvedValueOnce(res(409, { ok: false, error: { code: "RULES_CHANGED", message: "x", detail: { card: { id: 7 } } } }))
    const partial = await ownerRequest(7, "", { method: "PATCH" })
    expect(partial.kind === "refused" && partial.card).toBeFalsy()
  })

  it("rate limited: the server's wait; a network failure: NO_ANSWER and a re-read", async () => {
    H.fetch.mockResolvedValueOnce(res(429, null, { "Retry-After": "12" }))
    const limited = await ownerRequest(7, "", { method: "PATCH" })
    expect(limited.kind === "refused" && limited.refusal.message).toMatch("Wait 12 seconds")
    H.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    expect(await ownerRequest(7, "", { method: "PATCH" })).toEqual({ kind: "reload", message: NO_ANSWER })
  })
})
