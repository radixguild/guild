/**
 * /api/v1/agents/* (A1a: codes, pair, me, heartbeat, mine) — the real route
 * handlers with auth, rate limits, the Gateway and the query layer doubled.
 * The SQL is proven in tests/integration/agents-pairing.pg.test.ts; this file
 * proves the HTTP contract packages/agent-client's `join` and `status` are
 * written against (status codes, error codes, wire shapes).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const S = vi.hoisted(() => ({ userId: "account_rdx1owner00000000000000000000000000000000000000000000001" }))

// Every /api/v1/agents/* route sits behind the agentsAdd flag (behindAgentsFlag,
// src/lib/agent-api.ts); these tests exercise the routes as they behave with it
// on. The off side is tests/unit/agents-api-flag-gate.test.ts.
vi.mock("@/lib/features", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/features")>()
  return { ...actual, isEnabled: (f: Parameters<typeof actual.isEnabled>[0]) => f === "agentsAdd" || actual.isEnabled(f) }
})

vi.mock("@/lib/auth", () => ({
  withAuth:
    (handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown, ctx: Record<string, unknown>) =>
      handler(req, { ...ctx, user: { userId: S.userId } }),
  getSessionUser: vi.fn(),
}))

const Q = vi.hoisted(() => ({
  issuePairingCode: vi.fn(),
  ownerHasAgentNamed: vi.fn(),
  labelHeldByAnotherOwner: vi.fn(),
  redeemPairingCode: vi.fn(),
  loadAgentForSession: vi.fn(),
  recordHeartbeat: vi.fn(),
  listAgentsForOwner: vi.fn(),
  listOpenCodesForOwner: vi.fn(),
  isBadgeLocalIdMinted: vi.fn(),
}))

vi.mock("@/db/queries/agents", async () => {
  const real = await vi.importActual<typeof import("@/db/queries/agents")>("@/db/queries/agents")
  return {
    issuePairingCode: Q.issuePairingCode,
    ownerHasAgentNamed: Q.ownerHasAgentNamed,
    labelHeldByAnotherOwner: Q.labelHeldByAnotherOwner,
    redeemPairingCode: Q.redeemPairingCode,
    recordHeartbeat: Q.recordHeartbeat,
    listAgentsForOwner: Q.listAgentsForOwner,
    listOpenCodesForOwner: Q.listOpenCodesForOwner,
    toAgentMe: real.toAgentMe,
    toAgentCard: real.toAgentCard,
    trimDecimal: real.trimDecimal,
  }
})
// The chain-aware 24 h expiry is proven in agents-lifecycle tests; here it is a seam.
vi.mock("@/lib/agent-lifecycle", () => ({ loadAgentForSession: Q.loadAgentForSession }))
vi.mock("@/lib/gateway", () => ({ isBadgeLocalIdMinted: Q.isBadgeLocalIdMinted }))
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => () => ({ ok: true }),
  getClientIp: () => "203.0.113.9",
  rateLimitResponse: () => new Response(null, { status: 429 }),
}))

// Import AFTER mocks are registered.
import { POST as CODES } from "@/app/api/v1/agents/codes/route"
import { POST as PAIR } from "@/app/api/v1/agents/pair/route"
import { GET as ME } from "@/app/api/v1/agents/me/route"
import { POST as HEARTBEAT } from "@/app/api/v1/agents/me/heartbeat/route"
import { GET as MINE } from "@/app/api/v1/agents/mine/route"
import { GUILD_POSTERS } from "@/lib/agent-rules"

const req = (body: unknown) => ({ json: async () => body, headers: new Headers() }) as never
const noCtx = {} as never
const OWNER = "account_rdx1owner00000000000000000000000000000000000000000000001"
const AGENT = "account_rdx1agent00000000000000000000000000000000000000000000001"
const PERSONA = "identity_rdx12persona000000000000000000000000000000000000000001"

const agentRow = (over: Record<string, unknown> = {}) => ({
  id: 7,
  ownerId: OWNER,
  agentId: AGENT,
  label: "MyAgent",
  labelNorm: "myagent",
  status: "pending",
  floatXrd: "200.000000000000000000",
  rules: { v: 1, trustedPosters: [...GUILD_POSTERS], maxBondXrd: "180", maxClaimsPerDay: 1, dryRun: true },
  pairTx: null,
  badgeId: null,
  lastSeenAt: null,
  lastCycle: null,
  createdAt: new Date("2026-09-24T10:00:00Z"),
  activatedAt: null,
  suspendedAt: null,
  retiredAt: null,
  ...over,
})

beforeEach(() => {
  S.userId = OWNER
  for (const fn of Object.values(Q)) fn.mockReset()
  Q.ownerHasAgentNamed.mockResolvedValue(false)
  Q.labelHeldByAnotherOwner.mockResolvedValue(false)
  Q.isBadgeLocalIdMinted.mockResolvedValue(false)
  Q.issuePairingCode.mockResolvedValue({ code: "7KQ4M2XZ", expiresAt: new Date("2026-09-24T10:15:00Z") })
})

describe("POST /agents/codes (owner)", () => {
  it("201: the normalised badge id, the code as XXXX-XXXX and the exact one-liner", async () => {
    const res = await CODES(req({ label: "MyAgent" }), noCtx)
    expect(res.status).toBe(201)
    const { data } = await res.json()
    expect(data).toEqual({
      code: "7KQ4-M2XZ",
      label: "MyAgent",
      labelNorm: "myagent",
      badgeId: "<guild_member_myagent>",
      expiresAt: "2026-09-24T10:15:00.000Z",
      oneLiner: "npx -y -p https://radixguild.com/kit/agent.tgz guild-agent join --code 7KQ4-M2XZ",
    })
    expect(Q.isBadgeLocalIdMinted).toHaveBeenCalledWith("<guild_member_myagent>")
    expect(Q.issuePairingCode).toHaveBeenCalledWith({ ownerId: OWNER, label: "MyAgent", labelNorm: "myagent" })
  })

  it.each([[""], ["my agent"], ["agént"], ["my-agent"], ["a".repeat(52)], [42]])("400 VALIDATION_ERROR on label %p, nothing issued", async (label) => {
    const res = await CODES(req({ label }), noCtx)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
    expect(Q.issuePairingCode).not.toHaveBeenCalled()
  })

  it("409 LABEL_IN_USE when this owner already has an agent by that (normalised) name", async () => {
    Q.ownerHasAgentNamed.mockResolvedValue(true)
    const res = await CODES(req({ label: "MYAGENT" }), noCtx)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe("LABEL_IN_USE")
    expect(Q.ownerHasAgentNamed).toHaveBeenCalledWith(OWNER, "myagent")
  })

  it("🔴 409 LABEL_TAKEN when another owner is already pairing an agent by that name — before the chain is asked", async () => {
    Q.labelHeldByAnotherOwner.mockResolvedValue(true)
    const res = await CODES(req({ label: "MyAgent" }), noCtx)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe("LABEL_TAKEN")
    expect(body.error.message).toMatch(/another guild member/i)
    expect(Q.labelHeldByAnotherOwner).toHaveBeenCalledWith(OWNER, "myagent")
    expect(Q.isBadgeLocalIdMinted).not.toHaveBeenCalled()
    expect(Q.issuePairingCode).not.toHaveBeenCalled()
  })

  it("🔴 409 LABEL_TAKEN when the badge id is already minted on-chain", async () => {
    Q.isBadgeLocalIdMinted.mockResolvedValue(true)
    const res = await CODES(req({ label: "bigdevxrd" }), noCtx)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe("LABEL_TAKEN")
    expect(Q.issuePairingCode).not.toHaveBeenCalled()
  })

  it("🔴 403 ACCOUNT_REQUIRED for a persona session — a persona cannot fund an agent; nothing checked, nothing issued", async () => {
    S.userId = PERSONA
    const res = await CODES(req({ label: "MyAgent" }), noCtx)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe("ACCOUNT_REQUIRED")
    expect(Q.isBadgeLocalIdMinted).not.toHaveBeenCalled()
    expect(Q.issuePairingCode).not.toHaveBeenCalled()
  })

  it("🔴 503 GATEWAY_UNAVAILABLE when the chain could not be asked — fails closed, no code issued", async () => {
    Q.isBadgeLocalIdMinted.mockResolvedValue(null)
    const res = await CODES(req({ label: "myagent" }), noCtx)
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe("GATEWAY_UNAVAILABLE")
    expect(Q.issuePairingCode).not.toHaveBeenCalled()
  })
})

describe("POST /agents/pair (agent)", () => {
  beforeEach(() => {
    S.userId = AGENT
  })

  it("201 with the parseAgentPairResult shape; the code is normalised before the query", async () => {
    Q.redeemPairingCode.mockResolvedValue({ outcome: "paired", agent: agentRow() })
    const res = await PAIR(req({ code: " 7kq4-m2xz " }), noCtx)
    expect(res.status).toBe(201)
    expect((await res.json()).data).toEqual({ label: "MyAgent", ownerAccount: OWNER, status: "pending" })
    expect(Q.redeemPairingCode).toHaveBeenCalledWith({ code: "7KQ4M2XZ", agentId: AGENT })
  })

  it("🔴 resolves this key's existing row against the chain BEFORE redeeming (a stale pending row is released or activated first)", async () => {
    Q.redeemPairingCode.mockResolvedValue({ outcome: "paired", agent: agentRow() })
    await PAIR(req({ code: "7KQ4-M2XZ" }), noCtx)
    expect(Q.loadAgentForSession).toHaveBeenCalledWith(AGENT)
    expect(Q.loadAgentForSession.mock.invocationCallOrder[0]).toBeLessThan(Q.redeemPairingCode.mock.invocationCallOrder[0])
  })

  it.each([
    ["already_paired", 409, "AGENT_ALREADY_PAIRED"],
    ["expired", 410, "PAIRING_CODE_EXPIRED"],
    ["invalid", 404, "PAIRING_CODE_INVALID"],
    ["self_pair", 409, "AGENT_IS_OWNER"],
  ])("outcome %s → %i %s (the codes the kit distinguishes)", async (outcome, status, code) => {
    Q.redeemPairingCode.mockResolvedValue(outcome === "already_paired" ? { outcome, agent: agentRow() } : { outcome })
    const res = await PAIR(req({ code: "7KQ4-M2XZ" }), noCtx)
    expect(res.status).toBe(status)
    expect((await res.json()).error.code).toBe(code)
  })

  it("🔴 403 ACCOUNT_REQUIRED for a persona session — the kit's parser refuses a non-account address; no code consumed", async () => {
    S.userId = PERSONA
    const res = await PAIR(req({ code: "7KQ4-M2XZ" }), noCtx)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe("ACCOUNT_REQUIRED")
    expect(Q.redeemPairingCode).not.toHaveBeenCalled()
  })

  it.each([["7KQ4"], [""], [42], ["7KQ4_M2XZ"]])("400 on a malformed code %p, no query", async (code) => {
    const res = await PAIR(req({ code }), noCtx)
    expect(res.status).toBe(400)
    expect(Q.redeemPairingCode).not.toHaveBeenCalled()
  })
})

describe("GET /agents/me (agent)", () => {
  beforeEach(() => {
    S.userId = AGENT
  })

  it("404 AGENT_NOT_PAIRED — the one 404 that means 'no row'", async () => {
    Q.loadAgentForSession.mockResolvedValue(null)
    const res = await ME(req(null), noCtx)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe("AGENT_NOT_PAIRED")
  })

  it("200 with exactly the parseAgentMe shape, floatXrd trimmed", async () => {
    Q.loadAgentForSession.mockResolvedValue(agentRow({ status: "active", badgeId: "<guild_member_myagent>", activatedAt: new Date() }))
    const res = await ME(req(null), noCtx)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      label: "MyAgent",
      status: "active",
      ownerAccount: OWNER,
      floatXrd: "200",
      badgeId: "<guild_member_myagent>",
      rules: { v: 1, trustedPosters: [...GUILD_POSTERS], maxBondXrd: "180", maxClaimsPerDay: 1, dryRun: true },
    })
  })
})

describe("POST /agents/me/heartbeat (agent)", () => {
  beforeEach(() => {
    S.userId = AGENT
  })

  it("200 and records the cycle; 404 AGENT_NOT_PAIRED for a stranger", async () => {
    Q.recordHeartbeat.mockResolvedValue(true)
    expect((await HEARTBEAT(req({ cycle: { wouldClaim: [99] } }), noCtx)).status).toBe(200)
    expect(Q.recordHeartbeat).toHaveBeenCalledWith(AGENT, { wouldClaim: [99] })
    Q.recordHeartbeat.mockResolvedValue(false)
    const res = await HEARTBEAT(req({ cycle: {} }), noCtx)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe("AGENT_NOT_PAIRED")
  })

  it("400 on a cycle over 8 KB or a non-object", async () => {
    expect((await HEARTBEAT(req({ cycle: { big: "x".repeat(9000) } }), noCtx)).status).toBe(400)
    expect((await HEARTBEAT(req({ cycle: "nope" }), noCtx)).status).toBe(400)
    expect(Q.recordHeartbeat).not.toHaveBeenCalled()
  })
})

describe("GET /agents/mine (owner)", () => {
  it("returns this owner's agents and open codes with the one-liner", async () => {
    Q.listAgentsForOwner.mockResolvedValue([agentRow()])
    Q.listOpenCodesForOwner.mockResolvedValue([
      { code: "AAAABBBB", ownerId: OWNER, label: "Second", labelNorm: "second", createdAt: new Date(), expiresAt: new Date("2026-09-24T10:15:00Z"), redeemedAt: null, redeemedBy: null },
    ])
    const res = await MINE(req(null), noCtx)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.agents[0]).toMatchObject({ id: 7, label: "MyAgent", agentAccount: AGENT, status: "pending", floatXrd: "200", badgeId: null })
    expect(data.pendingCodes[0]).toEqual({
      code: "AAAA-BBBB",
      label: "Second",
      labelNorm: "second",
      expiresAt: "2026-09-24T10:15:00.000Z",
      oneLiner: "npx -y -p https://radixguild.com/kit/agent.tgz guild-agent join --code AAAA-BBBB",
    })
    expect(Q.listAgentsForOwner).toHaveBeenCalledWith(OWNER)
  })
})
