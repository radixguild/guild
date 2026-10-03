import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * "Add an agent" (A2.2, design §1a steps 1–2): name → the line to paste →
 * wait until the agent redeems the code. The waiting step asks
 * GET /agents/codes/{code} about THAT code (review round 3: inferring it from
 * the agent list misfired on retired and sibling rows). apiFetch and
 * useWallet are mocked; the countdown and the polling run on fake timers.
 */

const W = vi.hoisted(() => ({ ensureSession: vi.fn(async () => true), fetch: vi.fn() }))
vi.mock("@/hooks/useWallet", () => ({ useWallet: () => ({ ensureSession: W.ensureSession }) }))
vi.mock("@/lib/api-fetch", () => ({ apiFetch: (...a: unknown[]) => W.fetch(...a) }))

import { AddAgentDialog } from "@/components/agents/add-agent-dialog"

const T0 = Date.parse("2026-09-26T12:00:00Z")
const ISSUED = {
  code: "ABCD-EFGH",
  label: "Scout",
  labelNorm: "scout",
  badgeId: "<guild_member_scout>",
  expiresAt: new Date(T0 + 15 * 60_000).toISOString(),
  oneLiner: "npx -y -p https://radixguild.com/kit/agent.tgz guild-agent join --code ABCD-EFGH",
}
const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body, headers: new Headers(headers) }) as unknown as Response
const codeIs = (status: "open" | "redeemed" | "expired", code = ISSUED.code) =>
  res(200, { ok: true, data: { code, status, expiresAt: ISSUED.expiresAt } })
const hang = () => new Promise<Response>(() => {})
const statusCalls = () => W.fetch.mock.calls.filter(([u]) => String(u).startsWith("/api/v1/agents/codes/"))

async function openAndName(name: string) {
  fireEvent.click(screen.getByRole("button", { name: /Add an agent/ }))
  const input = await screen.findByLabelText("Name")
  fireEvent.change(input, { target: { value: name } })
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create pairing code" }))
  })
}
const flush = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: T0 })
  W.ensureSession.mockReset().mockResolvedValue(true)
  W.fetch.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("the name step", () => {
  it("refuses a name the badge cannot carry before asking the server (no dash, ≤ 51)", async () => {
    render(<AddAgentDialog onChanged={() => {}} />)
    await openAndName("my-agent")
    expect(screen.getByRole("alert")).toHaveTextContent("Letters, numbers and underscores only, up to 51")
    expect(W.fetch).not.toHaveBeenCalled()
    expect(W.ensureSession).not.toHaveBeenCalled()
  })

  it("a declined sign-in writes nothing", async () => {
    W.ensureSession.mockResolvedValue(false)
    render(<AddAgentDialog onChanged={() => {}} />)
    await openAndName("Scout")
    expect(screen.getByRole("alert")).toHaveTextContent("Approve the wallet signature")
    expect(W.fetch).not.toHaveBeenCalled()
  })

  it("shows the server's own reason (e.g. LABEL_TAKEN) and a 429's wait", async () => {
    W.fetch.mockResolvedValueOnce(
      res(409, { ok: false, error: { code: "LABEL_TAKEN", message: 'The badge name "scout" is already minted. Pick another.' } }),
    )
    render(<AddAgentDialog onChanged={() => {}} />)
    await openAndName("Scout")
    expect(screen.getByRole("alert")).toHaveTextContent("already minted")
    W.fetch.mockResolvedValueOnce(res(429, { ok: false }, { "Retry-After": "42" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create pairing code" }))
    })
    expect(screen.getByRole("alert")).toHaveTextContent("Wait 42 seconds")
  })
})

describe("waiting on THIS code", () => {
  it("201 → the line, the code and a countdown; the server says the code was redeemed → paired", async () => {
    const onChanged = vi.fn()
    W.fetch.mockResolvedValueOnce(res(201, { ok: true, data: ISSUED }))
    render(<AddAgentDialog onChanged={onChanged} />)
    await openAndName("Scout")
    expect(W.fetch).toHaveBeenCalledWith("/api/v1/agents/codes", expect.objectContaining({ method: "POST", body: JSON.stringify({ label: "Scout" }) }))
    expect(screen.getByText(ISSUED.oneLiner)).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for Scout to check in")
    // the countdown sits OUTSIDE the live region: it changes every second
    expect(screen.getByRole("status")).not.toHaveTextContent("expires")
    expect(screen.getByTestId("code-expiry")).toHaveTextContent("ABCD-EFGH expires in 15:00")

    W.fetch.mockResolvedValueOnce(codeIs("open"))
    await flush(5_000)
    expect(screen.getByTestId("code-expiry")).toHaveTextContent("expires in 14:55")
    W.fetch.mockResolvedValueOnce(codeIs("redeemed"))
    await flush(5_000)
    expect(screen.getByRole("status")).toHaveTextContent("Scout checked in")
    expect(onChanged).toHaveBeenCalled()
    // it only ever asked about its own code — never inferred from the agent list
    expect(statusCalls().map(([u]) => u)).toEqual(["/api/v1/agents/codes/ABCD-EFGH", "/api/v1/agents/codes/ABCD-EFGH"])
    expect(W.fetch.mock.calls.some(([u]) => String(u).includes("/agents/mine"))).toBe(false)
  })

  it("the server says expired (its clock may run ahead of this one) → expired, and a fresh code is offered", async () => {
    W.fetch.mockResolvedValueOnce(res(201, { ok: true, data: ISSUED }))
    W.fetch.mockResolvedValue(codeIs("expired"))
    render(<AddAgentDialog onChanged={() => {}} />)
    await openAndName("Scout")
    await flush(5_000)
    expect(screen.getByRole("alert")).toHaveTextContent("That code expired before your agent used it")
    fireEvent.click(screen.getByRole("button", { name: "Create a new code" }))
    expect(screen.getByLabelText("Name")).toBeInTheDocument()
  })

  it("🔴 this clock reaching the expiry is not a verdict: while the server says 'open' it keeps asking, and a redemption then counts", async () => {
    W.fetch.mockResolvedValueOnce(res(201, { ok: true, data: ISSUED }))
    W.fetch.mockResolvedValue(codeIs("open"))
    render(<AddAgentDialog onChanged={() => {}} />)
    await openAndName("Scout")
    await flush(15 * 60_000 + 10_000)
    expect(screen.getByRole("status")).toHaveTextContent("checking one last time")
    expect(screen.queryByText(/Nothing was paired/)).toBeNull()
    W.fetch.mockResolvedValue(codeIs("redeemed"))
    await flush(5_000)
    expect(screen.getByRole("status")).toHaveTextContent("Scout checked in")
  })

  it("🔴 an answer sent before the expiry and arriving after it still counts", async () => {
    W.fetch.mockResolvedValueOnce(res(201, { ok: true, data: ISSUED }))
    W.fetch.mockResolvedValue(codeIs("open"))
    render(<AddAgentDialog onChanged={() => {}} />)
    await openAndName("Scout")
    await flush(15 * 60_000 - 3_000)
    let answer: (r: Response) => void = () => {}
    W.fetch.mockReturnValueOnce(new Promise<Response>((r) => (answer = r)))
    W.fetch.mockImplementation(hang) // every later ask hangs, so only the earlier answer can decide
    await flush(4_000)
    expect(screen.getByRole("status")).toHaveTextContent("checking one last time")
    await act(async () => {
      answer(codeIs("redeemed"))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByRole("status")).toHaveTextContent("Scout checked in")
  })

  it("no answer at all past the expiry → 'couldn't confirm', never a false 'nothing was paired'", async () => {
    W.fetch.mockResolvedValueOnce(res(201, { ok: true, data: ISSUED }))
    W.fetch.mockRejectedValue(new Error("offline"))
    render(<AddAgentDialog onChanged={() => {}} />)
    await openAndName("Scout")
    await flush(15 * 60_000 + 62_000)
    expect(screen.getByRole("alert")).toHaveTextContent("couldn't confirm whether your agent used the code")
    expect(screen.queryByText(/Nothing was paired/)).toBeNull()
  })
})

describe("after 'couldn't confirm'", () => {
  it("🔴 it keeps asking: a slow 'redeemed' still turns it into paired", async () => {
    W.fetch.mockResolvedValueOnce(res(201, { ok: true, data: ISSUED }))
    W.fetch.mockRejectedValue(new Error("offline"))
    render(<AddAgentDialog onChanged={() => {}} />)
    await openAndName("Scout")
    await flush(15 * 60_000 + 62_000)
    expect(screen.getByRole("alert")).toHaveTextContent("couldn't confirm")
    W.fetch.mockResolvedValue(codeIs("redeemed"))
    await flush(5_000)
    expect(screen.getByRole("status")).toHaveTextContent("Scout checked in and is on your list")
    // no claim about its status — it may have been retired from another tab meanwhile
    expect(screen.getByRole("status")).not.toHaveTextContent("Not funded")
  })
})

describe("every way out resets", () => {
  it("🔴 closing resets: reopening never shows the previous code", async () => {
    W.fetch.mockResolvedValueOnce(res(201, { ok: true, data: ISSUED }))
    W.fetch.mockResolvedValue(codeIs("open"))
    render(<AddAgentDialog onChanged={() => {}} />)
    await openAndName("Scout")
    expect(screen.getByText(ISSUED.oneLiner)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    fireEvent.click(await screen.findByRole("button", { name: /Add an agent/ }))
    expect(await screen.findByLabelText("Name")).toHaveValue("")
    expect(screen.queryByText(ISSUED.oneLiner)).toBeNull()
  })

  it("🔴 an answer that arrives AFTER the dialog closed does not resurrect the old code as paired", async () => {
    W.fetch.mockResolvedValueOnce(res(201, { ok: true, data: ISSUED }))
    let answer: (r: Response) => void = () => {}
    W.fetch.mockReturnValueOnce(new Promise<Response>((r) => (answer = r)))
    render(<AddAgentDialog onChanged={() => {}} />)
    await openAndName("Scout")
    await flush(5_000)
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    await act(async () => {
      answer(codeIs("redeemed"))
      await vi.advanceTimersByTimeAsync(0)
    })
    fireEvent.click(await screen.findByRole("button", { name: /Add an agent/ }))
    expect(await screen.findByLabelText("Name")).toBeInTheDocument()
    expect(screen.queryByText(/checked in/)).toBeNull()
  })

  it("🔴 a late answer about an OLD code does not replace the wait for a NEW one", async () => {
    const SECOND = { ...ISSUED, code: "WXYZ-2345", expiresAt: new Date(T0 + 20 * 60_000).toISOString() }
    W.fetch.mockResolvedValueOnce(res(201, { ok: true, data: ISSUED }))
    let answer: (r: Response) => void = () => {}
    W.fetch.mockReturnValueOnce(new Promise<Response>((r) => (answer = r)))
    render(<AddAgentDialog onChanged={() => {}} />)
    await openAndName("Scout")
    await flush(5_000)
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    W.fetch.mockResolvedValueOnce(res(201, { ok: true, data: SECOND }))
    W.fetch.mockResolvedValue(codeIs("open", SECOND.code))
    await openAndName("Scout")
    expect(screen.getByTestId("code-expiry")).toHaveTextContent("WXYZ-2345")
    await act(async () => {
      answer(codeIs("redeemed")) // the first code's ask finally answers
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for Scout to check in")
    expect(screen.getByTestId("code-expiry")).toHaveTextContent("WXYZ-2345")
  })

  it("🔴 closing while the code is still being made never reopens into that code", async () => {
    let signed: (v: boolean) => void = () => {}
    W.ensureSession.mockReturnValueOnce(new Promise<boolean>((r) => (signed = r)))
    W.fetch.mockResolvedValueOnce(res(201, { ok: true, data: ISSUED }))
    render(<AddAgentDialog onChanged={() => {}} />)
    await openAndName("Scout") // waiting on the wallet signature
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    await act(async () => {
      signed(true)
      await vi.advanceTimersByTimeAsync(0)
    })
    fireEvent.click(await screen.findByRole("button", { name: /Add an agent/ }))
    expect(await screen.findByLabelText("Name")).toHaveValue("")
    expect(screen.queryByText(ISSUED.oneLiner)).toBeNull()
  })

  it("🔴 closing mid-request never leaves the reopened form stuck on 'Creating…', and the abandoned request cannot re-enable a newer one", async () => {
    let firstSigned: (v: boolean) => void = () => {}
    W.ensureSession.mockReturnValueOnce(new Promise<boolean>((r) => (firstSigned = r)))
    render(<AddAgentDialog onChanged={() => {}} />)
    await openAndName("Scout") // the first attempt hangs on the wallet
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    fireEvent.click(await screen.findByRole("button", { name: /Add an agent/ }))
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Scout" } })
    expect(screen.getByRole("button", { name: "Create pairing code" })).toBeEnabled()
    // a second attempt starts and hangs too
    W.ensureSession.mockReturnValueOnce(new Promise<boolean>(() => {}))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create pairing code" }))
    })
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled()
    // the FIRST, abandoned attempt settles — it must not re-enable the second's button
    await act(async () => {
      firstSigned(false)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled()
  })
})
