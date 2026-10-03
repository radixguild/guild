import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * Rename (A2.4d). Offered only when the server's `actions` admit it; the only
 * check made here is the shared badge-name format; everything else (the
 * chain, the 24 h hold, the name being free) is the server's answer, shown in
 * its own words.
 */

const H = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock("@/lib/api-fetch", () => ({ apiFetch: (...a: unknown[]) => H.fetch(...a) }))
vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({ rdt: null, user: { id: "account_rdx1owner" }, ensureSession: async () => true, sessionMismatch: false }),
}))
vi.mock("@/hooks/useNetworkHalt", () => ({ useNetworkHalt: () => ({ halted: false, operatorHalt: false }) }))
vi.mock("@/hooks/useXrdBalance", () => ({ useXrdBalance: () => ({ balance: 1000, checked: true, recheck: () => {} }) }))

import { RenameDialog } from "@/components/agents/rename-dialog"
import { AgentCard } from "@/components/agents/agent-card"
import { NO_ANSWER } from "@/components/agents/owner-request"
import type { AgentCardData } from "@/components/agents/status"
import { cardLimits, ownerActions } from "@/db/queries/agents"
import { AGENT_LABEL_RULE } from "@/lib/agent-label"
import { defaultAgentRules } from "@/lib/agent-rules"

const card = (over: Partial<AgentCardData> = {}): AgentCardData => ({
  id: 7,
  label: "Scout",
  labelNorm: "scout",
  agentAccount: "account_rdx128m9cmv5gyrdzeqh4r3sp8x3rymkz8wflznqxmyagrcrfsrsf9jwfx",
  status: "pending",
  floatXrd: "200",
  badgeId: null,
  pairTx: null,
  rules: defaultAgentRules("200"),
  lastSeenAt: null,
  lastCycle: null,
  createdAt: new Date().toISOString(),
  activatedAt: null,
  suspendedAt: null,
  retiredAt: null,
  manifestIssuedAt: null,
  ...over,
  actions: over.actions ?? ownerActions(over.status ?? "pending"),
  limits: over.limits ?? cardLimits(over.floatXrd ?? "200"),
})
const res = (status: number, body: unknown) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body, headers: new Headers() }) as unknown as Response
const refused = (status: number, code: string, message: string) => res(status, { ok: false, error: { code, message } })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  H.fetch.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function mount(agent: AgentCardData = card()) {
  const onUpdated = vi.fn()
  const onChanged = vi.fn()
  render(<RenameDialog agent={agent} onUpdated={onUpdated} onChanged={onChanged} />)
  return { onUpdated, onChanged }
}
const open = async () => {
  fireEvent.click(screen.getByTestId("agent-rename"))
  return screen.findByRole("dialog")
}
const typeName = (v: string) => fireEvent.change(screen.getByLabelText("New name"), { target: { value: v } })

describe("Rename", () => {
  it("🔴 offered from the server's `actions`, not from `status`", () => {
    mount(card({ actions: { ...ownerActions("pending"), rename: false } }))
    expect(screen.queryByTestId("agent-rename")).toBeNull()
    cleanup()
    mount(card({ status: "active", activatedAt: new Date().toISOString() }))
    expect(screen.queryByTestId("agent-rename")).toBeNull()
  })

  it("opens on the current name; Rename is off until it changes", async () => {
    mount()
    await open()
    expect(screen.getByLabelText("New name")).toHaveValue("Scout")
    expect(screen.getByTestId("rename-save")).toBeDisabled()
    typeName("Scout_2")
    expect(screen.getByTestId("rename-save")).toBeEnabled()
  })

  it("a name the badge cannot carry is refused here with the shared rule, before asking the server", async () => {
    mount()
    await open()
    typeName("bad-name")
    fireEvent.click(screen.getByTestId("rename-save"))
    expect(screen.getByRole("alert")).toHaveTextContent(AGENT_LABEL_RULE)
    expect(H.fetch).not.toHaveBeenCalled()
  })

  it("🔴 PATCHes the label alone and applies the server's card", async () => {
    const after = card({ label: "Scout_2", labelNorm: "scout_2" })
    H.fetch.mockResolvedValue(res(200, { ok: true, data: after }))
    const { onUpdated } = mount()
    await open()
    typeName("  Scout_2 ")
    fireEvent.click(screen.getByTestId("rename-save"))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(after))
    expect(H.fetch.mock.calls[0][0]).toBe("/api/v1/agents/7")
    expect(H.fetch.mock.calls[0][1].method).toBe("PATCH")
    expect(JSON.parse(H.fetch.mock.calls[0][1].body)).toEqual({ label: "Scout_2" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it.each([
    [409, "NAME_LOCKED", false],
    [409, "ALREADY_FUNDED", false],
    [409, "LABEL_IN_USE", false],
    [409, "LABEL_TAKEN", false],
    [503, "GATEWAY_UNAVAILABLE", false],
    [409, "AGENT_CHANGED", true],
    [409, "AGENT_WRONG_STATE", true],
  ] as const)("🔴 %s %s: the server's own words; re-read the list: %s", async (status, code, reread) => {
    const words = `the server says ${code} in its own words`
    H.fetch.mockResolvedValue(refused(status, code, words))
    const { onChanged, onUpdated } = mount()
    await open()
    typeName("Other")
    fireEvent.click(screen.getByTestId("rename-save"))
    expect(await screen.findByRole("alert")).toHaveTextContent(words)
    expect(onChanged).toHaveBeenCalledTimes(reread ? 1 : 0)
    expect(onUpdated).not.toHaveBeenCalled()
  })

  it("🔴 a double submit sends ONE request", async () => {
    let settle: (r: Response) => void = () => {}
    H.fetch.mockReturnValue(new Promise<Response>((r) => (settle = r)))
    const { onUpdated } = mount()
    await open()
    typeName("Other")
    const save = screen.getByTestId("rename-save")
    act(() => {
      save.click()
      save.click()
    })
    settle(res(200, { ok: true, data: card({ label: "Other", labelNorm: "other" }) }))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1))
    expect(H.fetch).toHaveBeenCalledTimes(1)
  })

  it("no answer: never 'nothing changed' — the list is re-read", async () => {
    H.fetch.mockRejectedValue(new TypeError("Failed to fetch"))
    const { onChanged } = mount()
    await open()
    typeName("Other")
    fireEvent.click(screen.getByTestId("rename-save"))
    expect(await screen.findByRole("alert")).toHaveTextContent(NO_ANSWER)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it("the card offers Rename on a pending agent only", () => {
    const ui = render(<AgentCard agent={card()} now={Date.now()} onChanged={() => {}} onUpdated={() => {}} />)
    expect(screen.getByTestId("agent-rename")).toBeInTheDocument()
    ui.unmount()
    render(
      <AgentCard
        agent={card({ status: "active", activatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() })}
        now={Date.now()}
        onChanged={() => {}}
        onUpdated={() => {}}
      />,
    )
    expect(screen.queryByTestId("agent-rename")).toBeNull()
  })
})
