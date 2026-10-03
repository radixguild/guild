/**
 * The owner's view of an agent (A2, design §3.6): which state a card shows.
 * Pure — every boundary is pinned with an explicit clock.
 */
import { describe, it, expect } from "vitest"
import {
  deriveAgentStatus,
  OFFLINE_AFTER_MS,
  PENDING_TTL_MS,
  STATUS_DETAIL,
  STATUS_LABEL,
  STATUS_TONE,
  pairAgainLine,
  pairingReleaseAt,
  type AgentCardData,
  type DerivedAgentStatus,
} from "@/components/agents/status"
import { PENDING_AGENT_TTL_MS } from "@/db/schema/agents"
import { defaultAgentRules } from "@/lib/agent-rules"
import { cardLimits, ownerActions } from "@/db/queries/agents"

const NOW = Date.parse("2026-09-26T12:00:00Z")
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

/** What the server sends: `actions` from its own table, for the fixture's final status. */
const withActions = (
  c: Omit<AgentCardData, "actions" | "limits"> & Partial<Pick<AgentCardData, "actions" | "limits">>,
): AgentCardData => ({
  ...c,
  actions: c.actions ?? ownerActions(c.status),
  limits: c.limits ?? cardLimits(c.floatXrd),
})
const agent = (over: Partial<AgentCardData> = {}): AgentCardData => withActions({
  id: 1,
  label: "MyAgent",
  labelNorm: "myagent",
  agentAccount: "account_rdx1agent",
  status: "active",
  floatXrd: "200",
  badgeId: "<guild_member_myagent>",
  pairTx: null,
  rules: { ...defaultAgentRules("200"), dryRun: false },
  lastSeenAt: iso(10_000),
  lastCycle: null,
  createdAt: iso(3 * 24 * 3600_000),
  activatedAt: iso(2 * 24 * 3600_000),
  suspendedAt: null,
  retiredAt: null,
  ...over,
})

describe("deriveAgentStatus", () => {
  it("the client's 24 h pairing window is the server's (PENDING_AGENT_TTL_MS)", () => {
    expect(PENDING_TTL_MS).toBe(PENDING_AGENT_TTL_MS)
  })

  it("pending: unfunded until exactly 24 h after pairing, expired from then on", () => {
    expect(deriveAgentStatus(agent({ status: "pending", createdAt: iso(PENDING_TTL_MS - 1) }), NOW)).toBe("unfunded")
    expect(deriveAgentStatus(agent({ status: "pending", createdAt: iso(PENDING_TTL_MS) }), NOW)).toBe("expired")
  })

  it("active: online within 3 missed beats of the last check-in, offline from then on", () => {
    expect(deriveAgentStatus(agent({ lastSeenAt: iso(OFFLINE_AFTER_MS - 1) }), NOW)).toBe("online")
    expect(deriveAgentStatus(agent({ lastSeenAt: iso(OFFLINE_AFTER_MS) }), NOW)).toBe("offline")
  })

  it("🔴 an active agent that never checked in, or whose check-in is unreadable, is offline — never online by default", () => {
    expect(deriveAgentStatus(agent({ lastSeenAt: null }), NOW)).toBe("offline")
    expect(deriveAgentStatus(agent({ lastSeenAt: "not a date" }), NOW)).toBe("offline")
  })

  it("practice mode shows only while the agent is checking in; an offline practice agent is offline", () => {
    const practice = { ...defaultAgentRules("200"), dryRun: true }
    expect(deriveAgentStatus(agent({ rules: practice }), NOW)).toBe("practice")
    expect(deriveAgentStatus(agent({ rules: practice, lastSeenAt: null }), NOW)).toBe("offline")
  })

  it("suspended and retired win over any check-in", () => {
    expect(deriveAgentStatus(agent({ status: "suspended" }), NOW)).toBe("suspended")
    expect(deriveAgentStatus(agent({ status: "retired", lastSeenAt: iso(1) }), NOW)).toBe("retired")
  })
})

describe("the copy for each state", () => {
  const ALL: DerivedAgentStatus[] = ["unfunded", "expired", "practice", "online", "offline", "suspended", "retired"]

  it("every state has a label, a tone and a sentence", () => {
    for (const s of ALL) {
      expect(STATUS_LABEL[s].length).toBeGreaterThan(0)
      expect(STATUS_TONE[s]).toMatch(/\btext-/)
      expect(STATUS_DETAIL[s].length).toBeGreaterThan(10)
    }
  })

  it("🔴 retiring and suspending never claim to move funds (design §3.7: retire does not sweep)", () => {
    for (const s of ["suspended", "retired"] as const) {
      expect(STATUS_DETAIL[s]).not.toMatch(/sweep|sent to you|returned|refund/i)
      expect(STATUS_DETAIL[s]).toMatch(/stays in its own account/)
    }
  })

  it("🔴 a suspension blocks the Guild's API, not the chain — the copy never says it cannot claim at all", () => {
    // The agent's key can still sign on-ledger (bounded by its float; design §3.5).
    expect(STATUS_DETAIL.suspended).toMatch(/through the Guild/)
    expect(STATUS_DETAIL.suspended).not.toMatch(/it cannot sign in or claim\b/)
    // K2-D's `run` exits on a refused sign-in; resuming does not restart it.
    expect(STATUS_DETAIL.suspended).toMatch(/start it again on its machine/)
  })
})

describe("the one pair-again rule (mirrors the server's manifestMayStillLand)", () => {
  it("released 24 h after the last funding transaction was handed out; never held when none was", () => {
    expect(pairingReleaseAt(null)).toBeNull()
    expect(pairingReleaseAt(NOW)).toBe(NOW + PENDING_AGENT_TTL_MS)
  })

  it("says 'once released, in about N hours' only while held; otherwise pair again now", () => {
    expect(pairAgainLine(null, NOW)).toBe("pair the agent again with a new code")
    expect(pairAgainLine(NOW - 1, NOW)).toBe("pair the agent again with a new code")
    expect(pairAgainLine(NOW + 90 * 60_000, NOW)).toBe("once the Guild releases this pairing, in about 2 hours, pair the agent again with a new code")
    expect(pairAgainLine(NOW + 10 * 60_000, NOW)).toContain("in about 1 hour,")
  })
})
