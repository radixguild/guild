import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, waitFor, fireEvent, act, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * "My agents" on /agents (A2 PR-1, design §3.6): what a signed-in owner sees
 * for each answer GET /api/v1/agents/mine can give. The fetch is mocked at
 * apiFetch; useWallet supplies the connection.
 */

const W = vi.hoisted(() => ({
  connected: true,
  account: "account_rdx1owner" as string | null,
  signIn: vi.fn(async () => true),
  signInDetailed: vi.fn(async () => ({ ok: true })),
  fetch: vi.fn(),
}))

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({ connected: W.connected, account: W.account, signIn: W.signIn, signInDetailed: W.signInDetailed }),
}))
vi.mock("@/lib/api-fetch", () => ({ apiFetch: (...a: unknown[]) => W.fetch(...a) }))
// A retired card reads its agent's balance from the Gateway (A2.4c): never the network in a unit test.
vi.mock("@/lib/gateway", async () => {
  const real = await vi.importActual<typeof import("@/lib/gateway")>("@/lib/gateway")
  return { ...real, readFungibleVaultTotal: async () => ({ total: "12", complete: true }) }
})

import { MyAgentsSection } from "@/components/agents/my-agents-section"
import { defaultAgentRules } from "@/lib/agent-rules"
import { cardLimits, ownerActions } from "@/db/queries/agents"
import type { AgentStatus } from "@/db/schema/agents"
import type { AgentActions } from "@/components/agents/status"

const json = (status: number, body: unknown) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response

const agent = (over: Record<string, unknown> = {}) => {
  const c = {
    id: 7,
    label: "Scout",
    labelNorm: "scout",
    agentAccount: "account_rdx1agentaddress0000000000000000000000000000000000000",
    status: "active",
    floatXrd: "200",
    badgeId: "<guild_member_scout>",
    pairTx: null,
    rules: { ...defaultAgentRules("200"), dryRun: false },
    lastSeenAt: new Date().toISOString(),
    lastCycle: null,
    createdAt: new Date(Date.now() - 86_400_000 * 2).toISOString(),
    activatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    suspendedAt: null,
    retiredAt: null,
    ...over,
  }
  // What the server sends: `actions` from its own table, for the final status.
  return {
    ...c,
    actions: (over.actions as AgentActions | undefined) ?? ownerActions(c.status as AgentStatus),
    limits: cardLimits(c.floatXrd),
  }
}

beforeEach(() => {
  W.connected = true
  W.account = "account_rdx1owner"
  W.fetch.mockReset()
})
afterEach(cleanup)

describe("MyAgentsSection", () => {
  it("renders nothing, and fetches nothing, without a connected wallet — the cold page is unchanged", () => {
    W.connected = false
    const { container } = render(<MyAgentsSection />)
    expect(container).toBeEmptyDOMElement()
    expect(W.fetch).not.toHaveBeenCalled()
  })

  it("lists the owner's agents with their state, full account and float", async () => {
    W.fetch.mockResolvedValue(
      json(200, { ok: true, data: { agents: [agent(), agent({ id: 8, label: "Idle", lastSeenAt: null })], pendingCodes: [] } }),
    )
    render(<MyAgentsSection />)
    const cards = await screen.findAllByTestId("agent-card")
    expect(cards.map((c) => c.getAttribute("data-status"))).toEqual(["online", "offline"])
    expect(screen.getByRole("heading", { name: "My agents" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Scout", level: 3 })).toBeInTheDocument()
    expect(screen.getAllByText("account_rdx1agentaddress0000000000000000000000000000000000000")).toHaveLength(2)
    expect(W.fetch).toHaveBeenCalledWith("/api/v1/agents/mine")
  })

  it("shows a code still waiting for its agent, with no one-liner before the kit is published", async () => {
    W.fetch.mockResolvedValue(
      json(200, {
        ok: true,
        data: {
          agents: [],
          pendingCodes: [
            {
              code: "ABCD-EFGH",
              label: "Scout",
              labelNorm: "scout",
              expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
              oneLiner: "npx -y -p https://radixguild.com/kit/x.tgz guild-agent join --code ABCD-EFGH",
            },
          ],
        },
      }),
    )
    render(<MyAgentsSection />)
    const row = await screen.findByTestId("pending-code")
    expect(row).toHaveTextContent("ABCD-EFGH")
    expect(row).toHaveTextContent("expires in 10 min")
    expect(document.body).not.toHaveTextContent("npx")
  })

  it("an empty list says so without offering an action this page cannot take yet", async () => {
    W.fetch.mockResolvedValue(json(200, { ok: true, data: { agents: [], pendingCodes: [] } }))
    render(<MyAgentsSection />)
    expect(await screen.findByText("No agents yet")).toBeInTheDocument()
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("with the agentsAdd flag off (the default), no Add an agent — in an empty list OR beside existing agents", async () => {
    W.fetch.mockResolvedValue(json(200, { ok: true, data: { agents: [agent()], pendingCodes: [] } }))
    render(<MyAgentsSection />)
    await screen.findByTestId("agent-card")
    expect(screen.queryByRole("button", { name: /Add an agent/ })).toBeNull()
    expect(document.body).not.toHaveTextContent("Add an agent")
  })

  it("401 → the sign-in prompt, which reloads the list once signed in", async () => {
    W.fetch.mockResolvedValueOnce(json(401, { ok: false })).mockResolvedValueOnce(
      json(200, { ok: true, data: { agents: [agent()], pendingCodes: [] } }),
    )
    render(<MyAgentsSection />)
    const button = await screen.findByRole("button", { name: "Sign in" })
    button.click()
    expect(await screen.findByTestId("agent-card")).toBeInTheDocument()
    expect(W.signInDetailed).toHaveBeenCalledOnce()
  })

  it("403 ACCOUNT_SUSPENDED → the server's own message, not a generic failure", async () => {
    W.fetch.mockResolvedValue(
      json(403, { ok: false, error: { code: "ACCOUNT_SUSPENDED", message: "This account is suspended." } }),
    )
    render(<MyAgentsSection />)
    expect(await screen.findByRole("alert")).toHaveTextContent("This account is suspended.")
  })

  it("🔴 a failed load is LoadFailed — never 'No agents yet'", async () => {
    W.fetch.mockResolvedValue(json(500, { ok: false }))
    render(<MyAgentsSection />)
    expect(await screen.findByText(/Couldn.t load your agents/)).toBeInTheDocument()
    expect(screen.queryByText("No agents yet")).toBeNull()
  })

  it("🔴 switching accounts starts from a blank list — one account's agents never show under another", async () => {
    W.fetch.mockResolvedValue(json(200, { ok: true, data: { agents: [agent()], pendingCodes: [] } }))
    const { rerender } = render(<MyAgentsSection />)
    await screen.findByTestId("agent-card")
    W.account = "account_rdx1someoneelse"
    W.fetch.mockReturnValue(new Promise(() => {})) // the new account's list never arrives
    rerender(<MyAgentsSection />)
    await waitFor(() => expect(screen.queryByTestId("agent-card")).toBeNull())
    expect(screen.getByText("Loading your agents…")).toBeInTheDocument()
  })
})

describe("an owner action's answer (A2.4)", () => {
  // Suspend / Resume answer with the server's card. The list shows it at once,
  // and a list read that left BEFORE the action can never put the card back.
  const deferred = () => {
    let resolve: (r: Response) => void = () => {}
    const promise = new Promise<Response>((r) => (resolve = r))
    return { promise, resolve }
  }
  const list = (...agents: unknown[]) => json(200, { ok: true, data: { agents, pendingCodes: [] } })

  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => vi.useRealTimers())

  it("an active card offers Rules, Pause and Suspend; a retired one offers none of them", async () => {
    W.fetch.mockResolvedValue(list(agent(), agent({ id: 8, label: "Gone", status: "retired", retiredAt: new Date().toISOString() })))
    render(<MyAgentsSection />)
    const [live, gone] = await screen.findAllByTestId("agent-card")
    expect(within(live).getByTestId("agent-rules")).toBeInTheDocument()
    expect(within(live).getByTestId("agent-pause")).toBeInTheDocument()
    expect(within(live).getByTestId("agent-suspend")).toBeInTheDocument()
    for (const id of ["agent-rules", "agent-start", "agent-pause", "agent-suspend", "agent-resume"]) {
      expect(within(gone).queryByTestId(id)).toBeNull()
    }
  })

  it("🔴 rules changed meanwhile: the refusal's current card is applied at once — 'Start again' never reloads the stale copy", async () => {
    const current = { ...defaultAgentRules("200"), dryRun: false, trustedPosters: [] as string[], maxClaimsPerDay: 5 }
    let reads = 0
    W.fetch.mockImplementation((_url: string, init?: { method?: string }) => {
      if (init?.method === "PATCH") {
        return Promise.resolve(
          json(409, { ok: false, error: { code: "RULES_CHANGED", message: "changed meanwhile", detail: { card: agent({ rules: current }) } } }),
        )
      }
      reads++
      // the first list read lands; every later one (the re-read after the refusal) is still out
      return reads === 1 ? Promise.resolve(list(agent())) : new Promise(() => {})
    })
    render(<MyAgentsSection />)
    const trigger = await screen.findByTestId("agent-rules")
    // The list lands outside act(), so the new card's effects have not run
    // yet, and the dialog registers its trigger in one: a press this early is
    // dropped. Flush them first (the test failed whenever it ran first in its
    // file — `-t`, or beside the PGlite suite).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    fireEvent.click(trigger)
    await screen.findByRole("dialog")
    fireEvent.change(screen.getByLabelText("Claims a day"), { target: { value: "3" } })
    fireEvent.click(screen.getByTestId("rules-save"))
    fireEvent.click(await screen.findByRole("button", { name: "Start again from the current rules" }))
    expect(within(screen.getByTestId("poster-list")).queryAllByRole("listitem")).toHaveLength(0)
    expect(screen.getByLabelText("Claims a day")).toHaveValue("5")
  })

  it("🔴 the server's card is applied at once, and a stale read that was already out cannot undo it", async () => {
    const reads: ReturnType<typeof deferred>[] = []
    let posts = 0
    W.fetch.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        posts++
        return Promise.resolve(json(200, { ok: true, data: agent({ status: "suspended", suspendedAt: new Date().toISOString() }) }))
      }
      const d = deferred()
      reads.push(d)
      return d.promise
    })
    render(<MyAgentsSection />)
    reads[0].resolve(list(agent()))
    expect((await screen.findByTestId("agent-card")).getAttribute("data-status")).toBe("online")

    // A poll leaves (the 30 s interval) and is still out when the owner acts.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(reads).toHaveLength(2)

    fireEvent.click(screen.getByTestId("agent-suspend"))
    await waitFor(() => expect(screen.getByTestId("agent-card").getAttribute("data-status")).toBe("suspended"))
    expect(posts).toBe(1)
    expect(reads).toHaveLength(3) // the list is re-read after the action

    // The poll that left before the action lands late, with the old state: ignored.
    await act(async () => {
      reads[1].resolve(list(agent()))
    })
    expect(screen.getByTestId("agent-card").getAttribute("data-status")).toBe("suspended")
    expect(screen.getByTestId("agent-resume")).toBeInTheDocument()

    // The re-read after the action is the one that lands.
    await act(async () => {
      reads[2].resolve(list(agent({ status: "suspended", suspendedAt: new Date().toISOString() })))
    })
    expect(screen.getByTestId("agent-card").getAttribute("data-status")).toBe("suspended")
  })
})
