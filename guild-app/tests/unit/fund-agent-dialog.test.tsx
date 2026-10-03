import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * Fund & activate (A2.3): the money leg of Bring Your Agent, owner side.
 * apiFetch, the wallet, the halt state and the balance are mocked; the
 * manifest the "server" returns is the REAL pairAgentManifest output, so the
 * cross-check is exercised against what the route actually builds.
 */

const OWNER = "account_rdx12yepj6wme9ehcnmffk9fvelhumrfskzqyxdy6zde8ltn5zxy42mrcz"
const AGENT = "account_rdx128m9cmv5gyrdzeqh4r3sp8x3rymkz8wflznqxmyagrcrfsrsf9jwfx"
const OTHER = "account_rdx12xezaw0gn9yhld6kqsez3ldsyf7gvqxxuvlkqq2h7dgp0jfrqzpgqj"
const TX = "txid_rdx1funding00000000000000000000000000000000000000000000000"

const H = vi.hoisted(() => ({
  fetch: vi.fn(),
  send: vi.fn(),
  ensureSession: vi.fn(async () => true),
  wallet: { sessionMismatch: false, userId: "" as string | null },
  halt: { halted: false as boolean | null, operatorHalt: false },
  balance: 1000 as number | null,
}))

vi.mock("@/lib/api-fetch", () => ({ apiFetch: (...a: unknown[]) => H.fetch(...a) }))
vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    rdt: { walletApi: { sendTransaction: H.send } },
    user: H.wallet.userId ? { id: H.wallet.userId } : null,
    ensureSession: H.ensureSession,
    sessionMismatch: H.wallet.sessionMismatch,
  }),
}))
vi.mock("@/hooks/useNetworkHalt", () => ({ useNetworkHalt: () => ({ ...H.halt, stale: false, ageSeconds: null, stateVersion: null }) }))
vi.mock("@/hooks/useXrdBalance", () => ({ useXrdBalance: () => ({ balance: H.balance, checked: true, recheck: () => {} }) }))

import { FundAgentDialog, sendPairTx } from "@/components/agents/fund-agent-dialog"
import { pairAgentManifest } from "@/lib/manifests"
import { MANAGER } from "@/lib/config"
import { defaultAgentRules } from "@/lib/agent-rules"
import type { AgentCardData } from "@/components/agents/status"
import { cardLimits, ownerActions } from "@/db/queries/agents"

const agent: AgentCardData = {
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
  createdAt: new Date().toISOString(),
  activatedAt: null,
  suspendedAt: null,
  retiredAt: null,
  actions: ownerActions("pending"),
  limits: cardLimits("200"),
}

const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body, headers: new Headers(headers) }) as unknown as Response
const refused = (status: number, code: string, message = code) => res(status, { ok: false, error: { code, message } })
const manifestOk = (over: Partial<{ agentAccount: string; floatXrd: string; manifest: string }> = {}) =>
  res(200, {
    ok: true,
    data: {
      manifest: over.manifest ?? pairAgentManifest(MANAGER, OWNER, AGENT, "scout", "200"),
      agentAccount: over.agentAccount ?? AGENT,
      labelNorm: "scout",
      badgeId: "<guild_member_scout>",
      floatXrd: over.floatXrd ?? "200",
    },
  })
const walletOk = (hash = TX) => ({ isOk: () => true, value: { transactionIntentHash: hash } })
const walletErr = (hash?: string) => ({ isOk: () => false, error: { error: "rejectedByUser", ...(hash ? { transactionIntentHash: hash } : {}) } })

/** Route every call by URL + body, in order, like the real server would answer. */
function server(answers: { funded: Response[]; manifest?: Response[] }) {
  const funded = [...answers.funded]
  const manifest = [...(answers.manifest ?? [])]
  H.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith("/funded")) return funded.shift() ?? refused(409, "FUNDING_PENDING")
    if (url.endsWith("/manifest")) return manifest.shift() ?? refused(500, "UNEXPECTED")
    throw new Error(`unexpected ${url}`)
  })
}
const fundedCalls = () => H.fetch.mock.calls.filter(([u]) => String(u).endsWith("/funded"))
const manifestCalls = () => H.fetch.mock.calls.filter(([u]) => String(u).endsWith("/manifest"))

async function openDialog(onChanged = vi.fn()) {
  render(<FundAgentDialog agent={agent} onChanged={onChanged} />)
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Fund & activate/ }))
  })
  return onChanged
}
async function pressFund() {
  const buttons = screen.getAllByRole("button", { name: "Fund & activate" })
  await act(async () => {
    fireEvent.click(buttons[buttons.length - 1])
  })
}
const flush = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  window.localStorage.clear()
  H.fetch.mockReset()
  H.send.mockReset()
  H.ensureSession.mockReset().mockResolvedValue(true)
  H.wallet.sessionMismatch = false
  H.wallet.userId = OWNER
  H.halt.halted = false
  H.halt.operatorHalt = false
  H.balance = 1000
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("opening: has funding already landed? (a closed tab must not lead to a second signature)", () => {
  it("nothing on-chain → the address to compare, the disclosure, and the button", async () => {
    server({ funded: [refused(409, "FUNDING_NOT_FOUND")] })
    await openDialog()
    expect(fundedCalls()[0][1]).toMatchObject({ method: "POST", body: "{}" })
    expect(screen.getByTestId("agent-address")).toHaveTextContent(AGENT)
    expect(screen.getByTestId("fund-disclosure")).toHaveTextContent(
      `Your wallet will show 200 XRD and a Guild badge going to ${AGENT} — an address you have not seen before.`,
    )
    expect(screen.getAllByRole("button", { name: "Fund & activate" }).at(-1)).toBeEnabled()
  })

  it("already funded → activated, and no transaction is offered", async () => {
    server({ funded: [res(200, { ok: true, data: {} })] })
    const onChanged = await openDialog()
    expect(screen.getByRole("status")).toHaveTextContent("Scout is active")
    expect(onChanged).toHaveBeenCalled()
    expect(manifestCalls()).toHaveLength(0)
  })

  it("🔴 badge there but float short → a plain transfer for the rest; the full transaction is NOT offered again", async () => {
    server({ funded: [refused(409, "FUNDING_FLOAT_SHORT")] })
    await openDialog()
    expect(screen.getByRole("alert")).toHaveTextContent("less than its 200 XRD float")
    // the open modal hides the trigger, so any accessible "Fund & activate" would be an offer inside the dialog
    expect(screen.queryAllByRole("button", { name: "Fund & activate" })).toHaveLength(0)
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument()
  })

  it("🔴 rate limited (429) → never 'couldn't check the chain': it waits the server's Retry-After and checks again by itself", async () => {
    H.fetch
      .mockResolvedValueOnce(res(429, { ok: false, error: { code: "RATE_LIMITED", message: "Too many requests" } }, { "Retry-After": "7" }))
      .mockResolvedValueOnce(refused(409, "FUNDING_NOT_FOUND"))
    await openDialog()
    expect(screen.getByRole("status")).toHaveTextContent("Checking too often — checking again in 7 seconds")
    expect(screen.queryByText(/couldn't check the chain/)).toBeNull()
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull()
    await flush(6_000)
    expect(fundedCalls()).toHaveLength(1) // not before the server said
    await flush(1_500)
    expect(fundedCalls()).toHaveLength(2)
    expect(screen.getAllByRole("button", { name: "Fund & activate" }).at(-1)).toBeEnabled()
  })

  it("…and a scheduled re-check never runs once the dialog is closed", async () => {
    H.fetch.mockResolvedValueOnce(res(429, { ok: false }, { "Retry-After": "5" }))
    await openDialog()
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    await flush(6_000)
    expect(fundedCalls()).toHaveLength(1)
  })

  it("chain unreadable → the form, with an honest note (a second transaction can only fail and cost its fee)", async () => {
    server({ funded: [refused(503, "GATEWAY_UNAVAILABLE")] })
    await openDialog()
    expect(screen.getByText(/it can never send a second float/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument()
  })
})

describe("funding", () => {
  it("happy path: manifest → cross-check → wallet → confirmed by the transaction → active", async () => {
    server({
      funded: [refused(409, "FUNDING_NOT_FOUND"), refused(409, "FUNDING_PENDING"), res(200, { ok: true, data: {} })],
      manifest: [manifestOk()],
    })
    H.send.mockResolvedValue(walletOk())
    const onChanged = await openDialog()
    await pressFund()
    expect(H.ensureSession).toHaveBeenCalled()
    expect(H.send).toHaveBeenCalledWith({ transactionManifest: pairAgentManifest(MANAGER, OWNER, AGENT, "scout", "200"), version: 1 })
    expect(screen.getByRole("status")).toHaveTextContent("no need to sign again")
    await flush(0)
    expect(fundedCalls()[1][1]).toMatchObject({ body: JSON.stringify({ intentHash: TX }) })
    await flush(4_000)
    expect(screen.getByRole("status")).toHaveTextContent("Scout is active")
    expect(onChanged).toHaveBeenCalled()
  })

  it.each([
    ["delivers to a different account", manifestOk({ manifest: pairAgentManifest(MANAGER, OWNER, OTHER, "scout", "200") })],
    ["moves a different amount", manifestOk({ manifest: pairAgentManifest(MANAGER, OWNER, AGENT, "scout", "2000") })],
    ["takes XRD from another account", manifestOk({ manifest: pairAgentManifest(MANAGER, OTHER, AGENT, "scout", "200") })],
    ["answers for a different amount than the card", manifestOk({ floatXrd: "250" })],
    ["answers for a different agent than the card", manifestOk({ agentAccount: OTHER })],
    [
      "calls a badge minter that is not the Guild's",
      manifestOk({ manifest: pairAgentManifest("component_rdx1cz0000000000000000000000000000000000000000000000000000", OWNER, AGENT, "scout", "200") }),
    ],
    ["answers with an amount no XRD can have", manifestOk({ floatXrd: "200.1234567890123456789" })],
  ])("🔴 a transaction that %s is never sent to the wallet", async (_what, answer) => {
    server({ funded: [refused(409, "FUNDING_NOT_FOUND")], manifest: [answer] })
    await openDialog()
    await pressFund()
    expect(screen.getByRole("alert")).toHaveTextContent("Don't sign anything")
    expect(H.send).not.toHaveBeenCalled()
  })

  it("the wallet declines with no transaction → nothing moved, and nothing is polled", async () => {
    server({ funded: [refused(409, "FUNDING_NOT_FOUND")], manifest: [manifestOk()] })
    H.send.mockResolvedValue(walletErr())
    await openDialog()
    await pressFund()
    expect(screen.getByRole("alert")).toHaveTextContent("did not send it, so nothing moved")
    await flush(5_000)
    expect(fundedCalls()).toHaveLength(1)
  })

  it("🔴 a wallet error that still carries a transaction is confirmed, never reported as 'nothing moved'", async () => {
    server({ funded: [refused(409, "FUNDING_NOT_FOUND"), res(200, { ok: true, data: {} })], manifest: [manifestOk()] })
    H.send.mockResolvedValue(walletErr(TX))
    await openDialog()
    await pressFund()
    expect(screen.queryByText(/nothing moved/)).toBeNull()
    await flush(0)
    expect(fundedCalls()[1][1]).toMatchObject({ body: JSON.stringify({ intentHash: TX }) })
    expect(screen.getByRole("status")).toHaveTextContent("Scout is active")
  })

  it("a failed transaction says what did and did not move, and offers funding again", async () => {
    server({ funded: [refused(409, "FUNDING_NOT_FOUND"), refused(409, "FUNDING_TX_FAILED")], manifest: [manifestOk()] })
    H.send.mockResolvedValue(walletOk())
    await openDialog()
    await pressFund()
    await flush(0)
    expect(screen.getByRole("alert")).toHaveTextContent("did not go through, so the float and the badge did not move")
    expect(screen.getByRole("alert")).not.toHaveTextContent(/fee is spent/)
    expect(screen.getAllByRole("button", { name: "Fund & activate" }).at(-1)).toBeEnabled()
  })

  it("ALREADY_FUNDED from the manifest route → confirmed from the chain, no wallet", async () => {
    server({ funded: [refused(409, "FUNDING_NOT_FOUND"), res(200, { ok: true, data: {} })], manifest: [refused(409, "ALREADY_FUNDED")] })
    await openDialog()
    await pressFund()
    await flush(0)
    expect(screen.getByRole("status")).toHaveTextContent("Scout is active")
    expect(H.send).not.toHaveBeenCalled()
    expect(fundedCalls()[1][1]).toMatchObject({ body: "{}" })
  })

  it("🔴 LABEL_TAKEN from the manifest route: the name is taken — rename it on its card (A2.4d), then fund", async () => {
    server({ funded: [refused(409, "FUNDING_NOT_FOUND")], manifest: [refused(409, "LABEL_TAKEN", "The badge name was minted by someone else. Rename the agent, then fund it.")] })
    await openDialog()
    await pressFund()
    expect(screen.getByRole("alert")).toHaveTextContent("now held by another account")
    expect(screen.getByRole("alert")).toHaveTextContent("rename it on its card, then fund it")
    expect(screen.getByRole("alert")).not.toHaveTextContent(/isn't on this page/)
    expect(H.send).not.toHaveBeenCalled()
  })

  it("🔴 PAIRING_EXPIRED: the line follows the release rule and never says to retire (a retired key can never pair again)", async () => {
    server({ funded: [refused(409, "FUNDING_NOT_FOUND")], manifest: [refused(410, "PAIRING_EXPIRED", "Retire it and pair the agent again.")] })
    await openDialog()
    await pressFund()
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("has just passed its 24-hour window")
    expect(alert).toHaveTextContent("pair the agent again with a new code") // no manifest ever handed out → released at once
    expect(alert).not.toHaveTextContent(/Retire/)
    expect(H.send).not.toHaveBeenCalled()
  })

  it("PAIRING_EXPIRED while the server still holds it (a transaction prepared hours ago) → pair again only once it is released", async () => {
    server({ funded: [refused(409, "FUNDING_NOT_FOUND")], manifest: [refused(410, "PAIRING_EXPIRED")] })
    render(<FundAgentDialog agent={{ ...agent, manifestIssuedAt: new Date(Date.now() - 2 * 3600_000).toISOString() }} onChanged={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Fund & activate/ }))
    })
    await pressFund()
    expect(screen.getByRole("alert")).toHaveTextContent("once the Guild releases this pairing, in about 22 hours, pair the agent again")
  })

  it("a declined sign-in writes nothing", async () => {
    H.ensureSession.mockResolvedValue(false)
    server({ funded: [refused(409, "FUNDING_NOT_FOUND")] })
    await openDialog()
    await pressFund()
    expect(screen.getByRole("alert")).toHaveTextContent("Approve the wallet signature")
    expect(manifestCalls()).toHaveLength(0)
  })

  it("🔴 a double click prepares ONE transaction", async () => {
    server({ funded: [refused(409, "FUNDING_NOT_FOUND")], manifest: [manifestOk(), manifestOk()] })
    let release: (v: unknown) => void = () => {}
    H.send.mockReturnValue(new Promise((r) => (release = r)))
    await openDialog()
    const button = screen.getAllByRole("button", { name: "Fund & activate" }).at(-1)!
    await act(async () => {
      fireEvent.click(button)
      fireEvent.click(button)
    })
    expect(manifestCalls()).toHaveLength(1)
    release(walletErr())
  })

  it("past 3 minutes unconfirmed → 'check again', never a verdict of failure", async () => {
    server({ funded: [refused(409, "FUNDING_NOT_FOUND")], manifest: [manifestOk()] })
    H.send.mockResolvedValue(walletOk())
    await openDialog()
    await pressFund()
    await flush(185_000)
    expect(screen.getByRole("status")).toHaveTextContent("Not confirmed after 3 minutes")
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument()
    expect(screen.queryByText(/failed/)).toBeNull()
  })
})

describe("blocked before the wallet opens", () => {
  it.each([
    ["the network is halted", () => (H.halt.halted = true), "stopped producing blocks"],
    ["the operator paused funding", () => (H.halt.operatorHalt = true), "paused by the operator"],
    ["the balance cannot cover the float", () => (H.balance = 150), "not enough for a 200 XRD float"],
    ["the wallet's account is not the signed-in one", () => (H.wallet.sessionMismatch = true), "not the one you signed in with"],
  ])("%s", async (_what, arrange, text) => {
    arrange()
    server({ funded: [refused(409, "FUNDING_NOT_FOUND")] })
    await openDialog()
    expect(screen.getByRole("alert")).toHaveTextContent(text)
    expect(screen.getAllByRole("button", { name: "Fund & activate" }).at(-1)).toBeDisabled()
  })

  it("an unknown balance never blocks on its own", async () => {
    H.balance = null
    server({ funded: [refused(409, "FUNDING_NOT_FOUND")] })
    await openDialog()
    expect(screen.getAllByRole("button", { name: "Fund & activate" }).at(-1)).toBeEnabled()
  })
})

describe("sendPairTx", () => {
  it("a thrown wallet call is 'nothing submitted'", async () => {
    const rdt = { walletApi: { sendTransaction: vi.fn().mockRejectedValue(new Error("boom")) } }
    expect(await sendPairTx(rdt as never, "m")).toEqual({ intentHash: null })
  })
})

describe("🔴 a signed transaction is never forgotten (review round 1)", () => {
  it("closing and reopening mid-confirmation keeps confirming THAT transaction — no second signature offered", async () => {
    server({ funded: [refused(409, "FUNDING_NOT_FOUND"), refused(409, "FUNDING_PENDING")], manifest: [manifestOk()] })
    H.send.mockResolvedValue(walletOk())
    await openDialog()
    await pressFund()
    await flush(0)
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Fund & activate/ }))
    })
    expect(screen.getByRole("status")).toHaveTextContent("no need to sign again")
    expect(screen.queryAllByRole("button", { name: "Fund & activate" })).toHaveLength(0)
    await flush(4_000)
    for (const [, init] of fundedCalls().slice(1)) expect(init).toMatchObject({ body: JSON.stringify({ intentHash: TX }) })
  })

  it("…even where storage is unavailable: the open dialog's own state keeps the hash", async () => {
    // a browser that blocks site data throws on the accessor itself
    const blocked = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("blocked")
    })
    server({ funded: [refused(409, "FUNDING_NOT_FOUND"), refused(409, "FUNDING_PENDING")], manifest: [manifestOk()] })
    H.send.mockResolvedValue(walletOk())
    await openDialog()
    await pressFund()
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Fund & activate/ }))
    })
    expect(screen.getByRole("status")).toHaveTextContent("no need to sign again")
    expect(screen.queryAllByRole("button", { name: "Fund & activate" })).toHaveLength(0)
    blocked.mockRestore()
    expect(window.localStorage.getItem("guild:agent-fund:7")).toBeNull() // nothing could be stored
  })

  it("a reload (fresh component) resumes the transaction this browser signed", async () => {
    window.localStorage.setItem("guild:agent-fund:7", JSON.stringify({ intentHash: TX, at: Date.now() }))
    server({ funded: [res(200, { ok: true, data: {} })] })
    await openDialog()
    await flush(0)
    expect(fundedCalls()[0][1]).toMatchObject({ body: JSON.stringify({ intentHash: TX }) })
    expect(screen.getByRole("status")).toHaveTextContent("Scout is active")
    expect(window.localStorage.getItem("guild:agent-fund:7")).toBeNull() // settled → forgotten
  })

  it("signing remembers the hash until the transaction settles", async () => {
    server({ funded: [refused(409, "FUNDING_NOT_FOUND"), refused(409, "FUNDING_PENDING")], manifest: [manifestOk()] })
    H.send.mockResolvedValue(walletOk())
    await openDialog()
    await pressFund()
    expect(JSON.parse(window.localStorage.getItem("guild:agent-fund:7")!)).toMatchObject({ intentHash: TX })
  })

  it("signed elsewhere (no record here) but a transaction was prepared minutes ago → warned before a second one", async () => {
    const recent = { ...agent, manifestIssuedAt: new Date(Date.now() - 5 * 60_000).toISOString() }
    server({ funded: [refused(409, "FUNDING_NOT_FOUND")] })
    render(<FundAgentDialog agent={recent} onChanged={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Fund & activate/ }))
    })
    expect(screen.getByRole("status")).toHaveTextContent("prepared 5m ago")
    expect(screen.getByRole("status")).toHaveTextContent("cannot send a second float")
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument()
  })

  it("🔴 an older open-time answer arriving FIRST, while the newer check is pending, is ignored too", async () => {
    let first: (r: Response) => void = () => {}
    let second: (r: Response) => void = () => {}
    H.fetch.mockReturnValueOnce(new Promise<Response>((r) => (first = r))).mockReturnValueOnce(new Promise<Response>((r) => (second = r)))
    render(<FundAgentDialog agent={agent} onChanged={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Fund & activate/ }))
    })
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Fund & activate/ }))
    })
    await act(async () => {
      first(refused(409, "FUNDING_NOT_FOUND")) // stale, and it lands while the new check is still out
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByRole("status")).toHaveTextContent("Checking whether this agent is already funded")
    await act(async () => {
      second(res(200, { ok: true, data: {} }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByRole("status")).toHaveTextContent("Scout is active")
  })

  it("an older open-time answer never lands on a newer one", async () => {
    let first: (r: Response) => void = () => {}
    H.fetch.mockReturnValueOnce(new Promise<Response>((r) => (first = r))).mockResolvedValueOnce(res(200, { ok: true, data: {} }))
    render(<FundAgentDialog agent={agent} onChanged={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Fund & activate/ }))
    })
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Fund & activate/ }))
    })
    expect(screen.getByRole("status")).toHaveTextContent("Scout is active")
    await act(async () => {
      first(refused(409, "FUNDING_NOT_FOUND")) // the first open's check answers last
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByRole("status")).toHaveTextContent("Scout is active")
  })
})
