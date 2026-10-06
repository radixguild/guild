import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * The `agentsAdd` flag (A2.2): "Add an agent" exists only while it is on. It
 * stays off until the kit is served (S1) and Fund & activate (A2.3) is live —
 * the off side is pinned in my-agents-section.test.tsx ("no button").
 */

const W = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({ connected: true, account: "account_rdx1owner", signIn: vi.fn(), signInDetailed: vi.fn(async () => ({ ok: true })), ensureSession: vi.fn(), ensureSessionDetailed: vi.fn(async () => ({ ok: true })) }),
}))
vi.mock("@/lib/api-fetch", () => ({ apiFetch: (...a: unknown[]) => W.fetch(...a) }))
vi.mock("@/lib/features", () => ({ isEnabled: (f: string) => f === "agentsAdd" }))

import { MyAgentsSection } from "@/components/agents/my-agents-section"

afterEach(cleanup)

describe("MyAgentsSection with agentsAdd on", () => {
  it("offers Add an agent, and the empty state stops saying adding is not open yet", async () => {
    W.fetch.mockResolvedValue({ status: 200, ok: true, json: async () => ({ ok: true, data: { agents: [], pendingCodes: [] } }) })
    render(<MyAgentsSection />)
    expect(await screen.findByText("No agents yet")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Add an agent/ })).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent("opens when the agent kit is published")
  })

  it("only once the list has loaded — not beside the sign-in prompt, a lock or a failure", async () => {
    W.fetch.mockResolvedValue({ status: 401, ok: false, json: async () => ({ ok: false }) })
    render(<MyAgentsSection />)
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Add an agent/ })).toBeNull()
  })
})
