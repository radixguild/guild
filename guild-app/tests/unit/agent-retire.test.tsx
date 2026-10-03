import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor, act, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Retire (A2.4c, design §3.7). Irreversible, so it asks first; it states what
 * the agent's account holds from a LIVE Gateway read (never the funded float,
 * never 0 on a failed read); it gives the exact kit line that returns the
 * money; and a retired card keeps both in view.
 */

const H = vi.hoisted(() => ({ fetch: vi.fn(), vault: vi.fn() }))
vi.mock("@/lib/api-fetch", () => ({ apiFetch: (...a: unknown[]) => H.fetch(...a) }))
vi.mock("@/lib/gateway", async () => {
  const real = await vi.importActual<typeof import("@/lib/gateway")>("@/lib/gateway")
  return { ...real, readFungibleVaultTotal: (...a: unknown[]) => H.vault(...a) }
})
vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({ rdt: null, user: { id: "account_rdx1owner" }, ensureSession: async () => true, sessionMismatch: false }),
}))
vi.mock("@/hooks/useNetworkHalt", () => ({ useNetworkHalt: () => ({ halted: false, operatorHalt: false }) }))
vi.mock("@/hooks/useXrdBalance", () => ({ useXrdBalance: () => ({ balance: 1000, checked: true, recheck: () => {} }) }))

import { RetireDialog, RetiredSweep, SWEEP_ALL_LINE } from "@/components/agents/retire-dialog"
import { AgentCard } from "@/components/agents/agent-card"
import { NO_ANSWER } from "@/components/agents/owner-request"
import type { AgentCardData } from "@/components/agents/status"
import { cardLimits, ownerActions } from "@/db/queries/agents"
import { defaultAgentRules } from "@/lib/agent-rules"
import { XRD_ADDRESS } from "@/lib/radix"

const AGENT = "account_rdx128m9cmv5gyrdzeqh4r3sp8x3rymkz8wflznqxmyagrcrfsrsf9jwfx"
const card = (over: Partial<AgentCardData> = {}): AgentCardData => ({
  id: 7,
  label: "Scout",
  labelNorm: "scout",
  agentAccount: AGENT,
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
const retired = (over: Partial<AgentCardData> = {}) => card({ status: "retired", retiredAt: "2026-09-27T10:00:00.000Z", ...over })
const res = (status: number, body: unknown) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body, headers: new Headers() }) as unknown as Response

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  H.fetch.mockReset()
  H.vault.mockReset().mockResolvedValue({ total: "37.5", complete: true })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function mount(agent: AgentCardData) {
  const onUpdated = vi.fn()
  const onChanged = vi.fn()
  render(<RetireDialog agent={agent} onUpdated={onUpdated} onChanged={onChanged} />)
  return { onUpdated, onChanged }
}
const openDialog = async () => {
  fireEvent.click(screen.getByTestId("agent-retire"))
  return screen.findByRole("dialog")
}

describe("Retire asks first", () => {
  it("🔴 offered from the server's `actions`, not from `status`", () => {
    mount(card({ status: "active", actions: { ...ownerActions("active"), retire: false } }))
    expect(screen.queryByTestId("agent-retire")).toBeNull()
  })

  it("🔴 opening it retires nothing; only the confirm does, with ONE request, and the server's card is applied", async () => {
    const after = retired()
    H.fetch.mockResolvedValue(res(200, { ok: true, data: after }))
    const { onUpdated } = mount(card())
    const d = await openDialog()
    expect(d).toHaveTextContent("This is permanent")
    expect(d).toHaveTextContent("can never be paired again")
    expect(d).toHaveTextContent("Retiring moves no funds")
    expect(H.fetch).not.toHaveBeenCalled()
    const confirm = screen.getByTestId("agent-retire-confirm")
    act(() => {
      confirm.click()
      confirm.click()
    })
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(after))
    expect(H.fetch).toHaveBeenCalledTimes(1)
    expect(H.fetch).toHaveBeenCalledWith("/api/v1/agents/7/retire", { method: "POST" })
  })

  it("Cancel retires nothing", async () => {
    mount(card())
    await openDialog()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(H.fetch).not.toHaveBeenCalled()
  })

  it("a refusal is the server's words, and a 'behind' one re-reads the list", async () => {
    H.fetch.mockResolvedValue(res(409, { ok: false, error: { code: "AGENT_WRONG_STATE", message: "Cannot retire an agent that is retired." } }))
    const { onChanged, onUpdated } = mount(card())
    await openDialog()
    fireEvent.click(screen.getByTestId("agent-retire-confirm"))
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot retire an agent that is retired.")
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(onUpdated).not.toHaveBeenCalled()
  })

  it("🔴 no answer: never 'nothing changed' — the list is re-read", async () => {
    H.fetch.mockRejectedValue(new TypeError("Failed to fetch"))
    const { onChanged } = mount(card())
    await openDialog()
    fireEvent.click(screen.getByTestId("agent-retire-confirm"))
    expect(await screen.findByRole("alert")).toHaveTextContent(NO_ANSWER)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })
})

describe("what the agent holds is read live — never the funded float, never 0 on a failed read", () => {
  it("🔴 reads the agent's own XRD vaults when the dialog opens and shows THAT, not the 200 XRD float", async () => {
    mount(card({ floatXrd: "200" }))
    await openDialog()
    const line = await screen.findByTestId("agent-balance")
    expect(H.vault).toHaveBeenCalledWith(AGENT, XRD_ADDRESS)
    expect(line).toHaveTextContent("37.5")
    expect(line).not.toHaveTextContent("200")
  })

  it("a vault list past one page is a lower bound", async () => {
    H.vault.mockResolvedValue({ total: "37.5", complete: false })
    mount(card())
    await openDialog()
    expect(await screen.findByTestId("agent-balance")).toHaveTextContent("at least")
  })

  it("🔴 an unreadable Gateway is 'couldn't read', never 0 XRD", async () => {
    H.vault.mockResolvedValue(null)
    mount(card())
    await openDialog()
    const line = await screen.findByTestId("agent-balance")
    expect(line).toHaveTextContent("couldn't read")
    expect(line).not.toHaveTextContent(/\b0 XRD/)
  })
})

describe("the way the money comes back", () => {
  it("🔴 the exact kit line — and the kit really has `sweep` with --all and --live", async () => {
    mount(card())
    await openDialog()
    expect(within(screen.getByTestId("sweep-instructions")).getByText(SWEEP_ALL_LINE)).toBeInTheDocument()
    expect(SWEEP_ALL_LINE).toBe("guild-agent sweep --all --live")
    const kit = readFileSync(join(import.meta.dirname, "../../../packages/agent-client/src/guild-agent.ts"), "utf8")
    expect(kit).toMatch(/case 'sweep':\s*\n\s*return sweep\(\{ live: args\.flags\.has\('live'\), all: args\.flags\.has\('all'\)/)
  })

  it("🔴 a never-activated agent is told plainly that the sweep will refuse — and why checking funding first matters", async () => {
    mount(card({ status: "pending", activatedAt: null, badgeId: null }))
    await openDialog()
    expect(screen.getByTestId("never-activated")).toHaveTextContent("never activated")
    expect(screen.getByTestId("never-activated")).toHaveTextContent("check funding first")
  })

  it("…and an activated one is not", async () => {
    mount(card())
    await openDialog()
    expect(screen.queryByTestId("never-activated")).toBeNull()
  })
})

describe("a retired card keeps the balance and the sweep line in view", () => {
  it("reads once on mount, re-reads on demand, and shows the sweep line", async () => {
    render(<RetiredSweep agent={retired()} />)
    expect(await screen.findByTestId("agent-balance")).toHaveTextContent("37.5")
    expect(H.vault).toHaveBeenCalledTimes(1)
    H.vault.mockResolvedValue({ total: "0.8", complete: true })
    fireEvent.click(screen.getByRole("button", { name: "Check again" }))
    await waitFor(() => expect(screen.getByTestId("agent-balance")).toHaveTextContent("0.8"))
    expect(H.vault).toHaveBeenCalledTimes(2)
    expect(screen.getByText(SWEEP_ALL_LINE)).toBeInTheDocument()
  })

  it("🔴 the card: a retired agent shows the sweep block and no Retire; a live one shows Retire and no sweep block", async () => {
    const ui = render(<AgentCard agent={retired()} now={Date.parse("2026-09-27T12:00:00Z")} onChanged={() => {}} onUpdated={() => {}} />)
    expect(await screen.findByTestId("retired-sweep")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-retire")).toBeNull()
    ui.unmount()
    render(<AgentCard agent={card()} now={Date.parse("2026-09-27T12:00:00Z")} onChanged={() => {}} onUpdated={() => {}} />)
    expect(screen.getByTestId("agent-retire")).toBeInTheDocument()
    expect(screen.queryByTestId("retired-sweep")).toBeNull()
  })
})
