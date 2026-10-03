import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * The card around Fund & activate (A2.3, review round 2): the dialog must
 * stay mounted while it is open, whatever the list's next refresh says — the
 * agent turning active under a "Done" screen, or the 24 h window closing while
 * a signed transaction is still landing.
 */

const OWNER = "account_rdx12yepj6wme9ehcnmffk9fvelhumrfskzqyxdy6zde8ltn5zxy42mrcz"
const AGENT = "account_rdx128m9cmv5gyrdzeqh4r3sp8x3rymkz8wflznqxmyagrcrfsrsf9jwfx"
const TX = "txid_rdx1funding00000000000000000000000000000000000000000000000"
const DAY = 24 * 3600_000

const H = vi.hoisted(() => ({ fetch: vi.fn(), send: vi.fn() }))
vi.mock("@/lib/api-fetch", () => ({ apiFetch: (...a: unknown[]) => H.fetch(...a) }))
vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    rdt: { walletApi: { sendTransaction: H.send } },
    user: { id: OWNER },
    ensureSession: async () => true,
    sessionMismatch: false,
  }),
}))
vi.mock("@/hooks/useNetworkHalt", () => ({ useNetworkHalt: () => ({ halted: false, operatorHalt: false }) }))
vi.mock("@/hooks/useXrdBalance", () => ({ useXrdBalance: () => ({ balance: 1000, checked: true, recheck: () => {} }) }))

import { AgentCard } from "@/components/agents/agent-card"
import { pairAgentManifest } from "@/lib/manifests"
import { MANAGER } from "@/lib/config"
import { defaultAgentRules } from "@/lib/agent-rules"
import type { AgentCardData } from "@/components/agents/status"
import { cardLimits, ownerActions } from "@/db/queries/agents"

const T0 = Date.parse("2026-09-26T12:00:00Z")
const card = (over: Partial<AgentCardData> = {}): AgentCardData => ({
  id: 7,
  label: "Scout",
  labelNorm: "scout",
  agentAccount: AGENT,
  status: "pending",
  floatXrd: "200",
  badgeId: null,
  pairTx: null,
  rules: defaultAgentRules("200"),
  lastSeenAt: null,
  lastCycle: null,
  createdAt: new Date(T0 - 2 * 3600_000).toISOString(),
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
const refused = (status: number, code: string) => res(status, { ok: false, error: { code, message: code } })
const manifestOk = () =>
  res(200, { ok: true, data: { manifest: pairAgentManifest(MANAGER, OWNER, AGENT, "scout", "200"), agentAccount: AGENT, labelNorm: "scout", badgeId: "<guild_member_scout>", floatXrd: "200" } })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: T0 })
  window.localStorage.clear()
  H.fetch.mockReset()
  H.send.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function openAndFund(ui: ReturnType<typeof render>, c: AgentCardData) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Fund & activate/ }))
  })
  const buttons = screen.getAllByRole("button", { name: "Fund & activate" })
  await act(async () => {
    fireEvent.click(buttons[buttons.length - 1])
  })
  return ui
}

describe("the card keeps the Fund dialog mounted while it is open", () => {
  it("🔴 activation lands and the list refreshes to 'active' — the 'Done' screen stays until the owner closes it", async () => {
    H.fetch
      .mockResolvedValueOnce(refused(409, "FUNDING_NOT_FOUND"))
      .mockResolvedValueOnce(manifestOk())
      .mockResolvedValueOnce(res(200, { ok: true, data: {} }))
    H.send.mockResolvedValue({ isOk: () => true, value: { transactionIntentHash: TX } })
    const c = card()
    const ui = render(<AgentCard agent={c} now={T0} onChanged={() => {}} onUpdated={() => {}} />)
    await openAndFund(ui, c)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    // the list's refresh: the agent is active now
    ui.rerender(<AgentCard agent={card({ status: "active", activatedAt: new Date(T0).toISOString(), lastSeenAt: new Date(T0).toISOString() })} now={T0} onChanged={() => {}} onUpdated={() => {}} />)
    expect(screen.getByRole("status")).toHaveTextContent("Scout is active")
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    ui.rerender(<AgentCard agent={card({ status: "active", activatedAt: new Date(T0).toISOString(), lastSeenAt: new Date(T0).toISOString() })} now={T0} onChanged={() => {}} onUpdated={() => {}} />)
    expect(screen.queryByRole("button", { name: /Fund & activate|Check funding/ })).toBeNull()
  })

  it("🔴 the 24 h window closes while a signed transaction is still landing — the confirmation keeps running", async () => {
    H.fetch
      .mockResolvedValueOnce(refused(409, "FUNDING_NOT_FOUND"))
      .mockResolvedValueOnce(manifestOk())
      .mockResolvedValue(refused(409, "FUNDING_PENDING"))
    H.send.mockResolvedValue({ isOk: () => true, value: { transactionIntentHash: TX } })
    const c = card({ createdAt: new Date(T0 - DAY + 30_000).toISOString() }) // 30 s of the window left
    const ui = render(<AgentCard agent={c} now={T0} onChanged={() => {}} onUpdated={() => {}} />)
    await openAndFund(ui, c)
    ui.rerender(<AgentCard agent={c} now={T0 + 60_000} onChanged={() => {}} onUpdated={() => {}} />) // the list ticks past the window
    expect(screen.getByRole("status")).toHaveTextContent("no need to sign again")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000)
    })
    const funded = H.fetch.mock.calls.filter(([u]) => String(u).endsWith("/funded"))
    expect(funded.at(-1)![1]).toMatchObject({ body: JSON.stringify({ intentHash: TX }) })
  })
})

describe("🔴 the pairing expiring while a signed transaction settles (review round 4)", () => {
  it("a failure that settles after the window never says 'fund again' — the server would refuse it", async () => {
    let settle: (r: Response) => void = () => {}
    H.fetch
      .mockResolvedValueOnce(refused(409, "FUNDING_NOT_FOUND"))
      .mockResolvedValueOnce(manifestOk())
      .mockReturnValueOnce(new Promise<Response>((r) => (settle = r)))
    H.send.mockResolvedValue({ isOk: () => true, value: { transactionIntentHash: TX } })
    const c = card({ createdAt: new Date(T0 - DAY + 30_000).toISOString() }) // 30 s of the window left
    const onChanged = () => {} // stable, like the list's own load()
    const ui = render(<AgentCard agent={c} now={T0} onChanged={onChanged} onUpdated={() => {}} />)
    await openAndFund(ui, c)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0) // the confirm ask goes out and hangs
    })
    ui.rerender(<AgentCard agent={c} now={T0 + 60_000} onChanged={onChanged} onUpdated={() => {}} />) // the window closes
    await act(async () => {
      settle(refused(409, "FUNDING_TX_FAILED"))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByRole("alert")).toHaveTextContent("did not go through")
    expect(screen.getByRole("alert")).toHaveTextContent("once the Guild releases this pairing")
    expect(screen.getByRole("alert")).toHaveTextContent("pair the agent again with a new code")
    expect(screen.getByRole("alert")).not.toHaveTextContent(/fund the agent again/)
    expect(screen.queryAllByRole("button", { name: "Fund & activate" })).toHaveLength(0)
  })
})

describe("an expired pairing whose funding may still be landing offers 'Check funding'", () => {
  const expired = { createdAt: new Date(T0 - DAY - 60_000).toISOString() }

  it("a transaction this browser signed", () => {
    window.localStorage.setItem("guild:agent-fund:7", JSON.stringify({ intentHash: TX, at: T0 - 120_000 }))
    render(<AgentCard agent={card(expired)} now={T0} onChanged={() => {}} onUpdated={() => {}} />)
    expect(screen.getByRole("button", { name: /Check funding/ })).toBeInTheDocument()
  })

  it("with a transaction prepared minutes ago, the note and the explainer are ONE status, and nothing claims 'no funding landed'", async () => {
    H.fetch.mockResolvedValue(refused(409, "FUNDING_NOT_FOUND"))
    render(<AgentCard agent={card({ ...expired, manifestIssuedAt: new Date(T0 - 10 * 60_000).toISOString() })} now={T0} onChanged={() => {}} onUpdated={() => {}} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Check funding/ }))
    })
    const status = screen.getAllByRole("status")
    expect(status).toHaveLength(1)
    expect(status[0]).toHaveTextContent("prepared 10m ago")
    expect(status[0]).toHaveTextContent("can't be prepared")
    expect(document.body).not.toHaveTextContent(/No funding for this agent has landed/)
  })

  it("a funding transaction handed out within the window", () => {
    render(<AgentCard agent={card({ ...expired, manifestIssuedAt: new Date(T0 - 30 * 60_000).toISOString() })} now={T0} onChanged={() => {}} onUpdated={() => {}} />)
    expect(screen.getByRole("button", { name: /Check funding/ })).toBeInTheDocument()
  })

  it("🔴 while the server HOLDS the pairing (a transaction prepared < 24 h ago) the card never says 'pair again' — and claims nothing was signed", () => {
    render(<AgentCard agent={card({ ...expired, manifestIssuedAt: new Date(T0 - 3 * 3600_000).toISOString() })} now={T0} onChanged={() => {}} onUpdated={() => {}} />)
    expect(screen.getByRole("button", { name: /Check funding/ })).toBeInTheDocument()
    expect(screen.queryByText(/Create a new code and pair the agent again/)).toBeNull()
    expect(screen.getByText(/the Guild holds this pairing for about 21 hours more in case one lands, and it can't be paired again before then/)).toBeInTheDocument()
    expect(screen.queryByText(/may still be landing/)).toBeNull()
  })

  it("🔴 a hash this browser signed a few minutes AFTER the manifest outlives the server's hold → no hold claim, just 'you signed one'", () => {
    const issued = T0 - DAY - 60_000 // the server's 24 h hold ended a minute ago
    window.localStorage.setItem("guild:agent-fund:7", JSON.stringify({ intentHash: TX, at: issued + 5 * 60_000 }))
    render(<AgentCard agent={card({ ...expired, manifestIssuedAt: new Date(issued).toISOString() })} now={T0} onChanged={() => {}} onUpdated={() => {}} />)
    expect(screen.queryByText(/holds this pairing/)).toBeNull()
    expect(screen.getByText(/You signed a funding transaction for it from this browser/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Check funding/ })).toBeInTheDocument()
  })

  it("once the clock hold is over (the transaction was prepared ≥ 24 h ago) → the card still offers the check, and never asserts 'pair again'", () => {
    render(<AgentCard agent={card({ ...expired, manifestIssuedAt: new Date(T0 - DAY - 60_000).toISOString() })} now={T0} onChanged={() => {}} onUpdated={() => {}} />)
    expect(screen.getByRole("button", { name: /Check funding/ })).toBeInTheDocument()
    expect(screen.getByText("Not funded within 24 hours of pairing. Check funding to see where it stands before you pair it again.")).toBeInTheDocument()
  })

  it("🔴 the badge name taken by another account: honest next step, never 'rename, then fund' past the window", async () => {
    H.fetch.mockResolvedValue(refused(409, "LABEL_TAKEN"))
    render(<AgentCard agent={card({ ...expired, manifestIssuedAt: new Date(T0 - 10 * 60_000).toISOString() })} now={T0} onChanged={() => {}} onUpdated={() => {}} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Check funding/ }))
    })
    expect(screen.getByRole("alert")).toHaveTextContent("once the Guild releases this pairing")
    expect(screen.getByRole("alert")).toHaveTextContent("pair the agent again with a new code and a different name")
    expect(screen.getByRole("alert")).not.toHaveTextContent(/then fund it/)
  })

  it("🔴 every expired card offers 'Check funding' — the server may still hold it for reasons the clock can't see", () => {
    render(<AgentCard agent={card(expired)} now={T0} onChanged={() => {}} onUpdated={() => {}} />)
    expect(screen.getByRole("button", { name: /Check funding/ })).toBeInTheDocument()
    expect(screen.queryByText(/Create a new code and pair the agent again/)).toBeNull()
  })

  it("🔴 badge landed out-of-band with a short float, pairing expired, no manifest ever: the check shows the real fix (send the rest)", async () => {
    H.fetch.mockResolvedValue(refused(409, "FUNDING_FLOAT_SHORT"))
    render(<AgentCard agent={card(expired)} now={T0} onChanged={() => {}} onUpdated={() => {}} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Check funding/ }))
    })
    expect(screen.getByRole("alert")).toHaveTextContent("less than its 200 XRD float")
    expect(screen.getByRole("alert")).toHaveTextContent("Send the difference")
    expect(screen.queryByText(/pair the agent again/i)).toBeNull()
  })

  it("🔴 when funding may still be landing, the card does NOT tell the owner to pair again", () => {
    render(<AgentCard agent={card({ ...expired, manifestIssuedAt: new Date(T0 - 30 * 60_000).toISOString() })} now={T0} onChanged={() => {}} onUpdated={() => {}} />)
    expect(screen.queryByText(/Create a new code and pair the agent again/)).toBeNull()
    expect(screen.getByText(/the Guild holds this pairing/)).toBeInTheDocument()
  })

  it("🔴 'Check funding' on an expired pairing only checks — it never offers a new funding transaction (the server would 410 it)", async () => {
    H.fetch.mockResolvedValue(refused(409, "FUNDING_NOT_FOUND"))
    render(<AgentCard agent={card({ ...expired, manifestIssuedAt: new Date(T0 - 40 * 60_000).toISOString() })} now={T0} onChanged={() => {}} onUpdated={() => {}} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Check funding/ }))
    })
    expect(screen.queryAllByRole("button", { name: "Fund & activate" })).toHaveLength(0)
    expect(screen.queryByTestId("fund-disclosure")).toBeNull()
    expect(screen.getByText(/a new funding transaction can't be prepared/)).toBeInTheDocument()
    expect(screen.getAllByRole("status")).toHaveLength(1) // one live region, no contradicting second one
    expect(screen.getByRole("status")).toHaveTextContent("once the Guild releases this pairing") // never a bare "pair it again" while held
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check again" }))
    })
    expect(H.fetch.mock.calls.every(([u]) => String(u).endsWith("/funded"))).toBe(true) // never /manifest
  })
})
