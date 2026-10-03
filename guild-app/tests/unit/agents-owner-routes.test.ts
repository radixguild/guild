/**
 * The owner's agent routes (A1b): manifest, funded, PATCH, suspend/resume/retire
 * — the real handlers with auth, rate limits, the chain-halt gate, the Gateway,
 * the funding checks and the query layer doubled. The SQL is proven in
 * tests/integration/agents-pairing.pg.test.ts and the funding decision in
 * agent-funding.test.ts; this file proves the HTTP contract the owner's page
 * (A2) is written against.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const S = vi.hoisted(() => ({ userId: "account_rdx12y5senkxfxg38swfv4tg88lx73jqnkdvcnzv8kwwdmg0efl40r2p7u" }))
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
}))
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => () => ({ ok: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}))

const M = vi.hoisted(() => ({
  chainWriteGate: vi.fn(),
  findOwnedAgent: vi.fn(),
  markManifestIssued: vi.fn(),
  activateAgent: vi.fn(),
  updateAgentSettings: vi.fn(),
  ownerHasAgentNamed: vi.fn(),
  labelHeldByAnotherOwner: vi.fn(),
  suspendAgent: vi.fn(),
  resumeAgent: vi.fn(),
  retireAgent: vi.fn(),
  readNonFungibleHolder: vi.fn(),
  isBadgeLocalIdMinted: vi.fn(),
  readClaimBondParams: vi.fn(),
  verifyFundingTx: vi.fn(),
  readFundingState: vi.fn(),
}))
vi.mock("@/lib/chain-halt-gate", () => ({ chainWriteGate: M.chainWriteGate }))
vi.mock("@/db/queries/agents", async () => {
  const real = await vi.importActual<typeof import("@/db/queries/agents")>("@/db/queries/agents")
  return {
    ...real,
    findOwnedAgent: M.findOwnedAgent,
    markManifestIssued: M.markManifestIssued,
    activateAgent: M.activateAgent,
    updateAgentSettings: M.updateAgentSettings,
    ownerHasAgentNamed: M.ownerHasAgentNamed,
    labelHeldByAnotherOwner: M.labelHeldByAnotherOwner,
    suspendAgent: M.suspendAgent,
    resumeAgent: M.resumeAgent,
    retireAgent: M.retireAgent,
  }
})
vi.mock("@/lib/gateway", () => ({
  readNonFungibleHolder: M.readNonFungibleHolder,
  isBadgeLocalIdMinted: M.isBadgeLocalIdMinted,
  readClaimBondParams: M.readClaimBondParams,
}))
// The name classifier runs FOR REAL over the doubled Gateway, so these tests
// exercise the actual Gateway-answer → verdict mapping the routes depend on.
vi.mock("@/lib/agent-funding", async () => {
  const real = await vi.importActual<typeof import("@/lib/agent-funding")>("@/lib/agent-funding")
  return { ...real, verifyFundingTx: M.verifyFundingTx, readFundingState: M.readFundingState }
})

import { POST as MANIFEST } from "@/app/api/v1/agents/[id]/manifest/route"
import { POST as FUNDED } from "@/app/api/v1/agents/[id]/funded/route"
import { PATCH } from "@/app/api/v1/agents/[id]/route"
import { POST as SUSPEND } from "@/app/api/v1/agents/[id]/suspend/route"
import { POST as RESUME } from "@/app/api/v1/agents/[id]/resume/route"
import { POST as RETIRE } from "@/app/api/v1/agents/[id]/retire/route"
import { defaultAgentRules } from "@/lib/agent-rules"
import type { AgentRow } from "@/db/queries/agents"

const OWNER = S.userId
const AGENT = "account_rdx1299rtllydz2vz6rrs4zafu2htkndwm2g5ksd27rrw9mhrechcm7tlr"
const STRANGER = "account_rdx128k4ew7te5n3aetfkraejs90eunx8zs4uuwlh90ayq3w8uratgkqt8"
const TX = "txid_rdx1funding00000000000000000000000000000000000000000000000"

const row = (over: Partial<AgentRow> = {}): AgentRow => ({
  id: 7,
  ownerId: OWNER,
  agentId: AGENT,
  label: "MyAgent",
  labelNorm: "myagent",
  status: "pending",
  floatXrd: "200.000000000000000000",
  rules: defaultAgentRules("200"),
  pairTx: null,
  badgeId: null,
  lastSeenAt: null,
  lastCycle: null,
  createdAt: new Date(),
  activatedAt: null,
  suspendedAt: null,
  retiredAt: null,
  manifestIssuedAt: null,
  ...over,
})
const req = (body: unknown) => ({ json: async () => body, headers: new Headers() }) as never
const ctx = (id = "7") => ({ params: Promise.resolve({ id }) }) as never

beforeEach(() => {
  for (const f of Object.values(M)) f.mockReset()
  M.chainWriteGate.mockResolvedValue(null)
  M.findOwnedAgent.mockResolvedValue(row())
  M.markManifestIssued.mockResolvedValue(true)
})

describe("POST /agents/{id}/manifest — the owner's funding tx", () => {
  it("200: the manifest for THIS row's agent account and badge name, float as a plain decimal", async () => {
    M.readNonFungibleHolder.mockResolvedValue({ minted: false })
    const res = await MANIFEST(req(null), ctx())
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toMatchObject({ agentAccount: AGENT, labelNorm: "myagent", badgeId: "<guild_member_myagent>", floatXrd: "200" })
    expect(data.manifest).toContain(`Address("${OWNER}")\n  "withdraw"`)
    expect(data.manifest).toContain(`"public_mint"\n  "myagent"`)
    expect(data.manifest).toContain(`Address("${AGENT}")\n  "try_deposit_batch_or_abort"`)
    expect(M.findOwnedAgent).toHaveBeenCalledWith(7, OWNER)
    expect(M.markManifestIssued).toHaveBeenCalledWith(7, OWNER, "myagent")
  })

  it("🔴 the issuance is recorded BEFORE the manifest leaves — if the row moved on meanwhile, no manifest", async () => {
    M.readNonFungibleHolder.mockResolvedValue({ minted: false })
    M.markManifestIssued.mockResolvedValue(false)
    M.findOwnedAgent.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ status: "retired", retiredAt: new Date() }))
    const res = await MANIFEST(req(null), ctx())
    expect(res.status).toBe(409)
    expect((await res.json()).data).toBeUndefined()
  })

  it("🔴 gated on the chain halt: a halted chain answers the gate's 503 and nothing is read", async () => {
    M.chainWriteGate.mockResolvedValue(new Response(null, { status: 503 }))
    const res = await MANIFEST(req(null), ctx())
    expect(res.status).toBe(503)
    expect(M.findOwnedAgent).not.toHaveBeenCalled()
  })

  it("🔴 the name is re-checked: in this agent's account → ALREADY_FUNDED; anywhere else → LABEL_TAKEN; unreadable → 503", async () => {
    M.readNonFungibleHolder.mockResolvedValue({ minted: true, burned: false, holder: AGENT })
    expect((await (await MANIFEST(req(null), ctx())).json()).error.code).toBe("ALREADY_FUNDED")
    M.readNonFungibleHolder.mockResolvedValue({ minted: true, burned: false, holder: STRANGER })
    const taken = await MANIFEST(req(null), ctx())
    expect(taken.status).toBe(409)
    expect((await taken.json()).error.code).toBe("LABEL_TAKEN")
    M.readNonFungibleHolder.mockResolvedValue(null)
    expect((await MANIFEST(req(null), ctx())).status).toBe(503)
  })

  it("🔴 a minted id the Gateway names NO holder for is UNKNOWN → 503 — never 'taken by someone else, rename it'", async () => {
    M.readNonFungibleHolder.mockResolvedValue({ minted: true, burned: false, holder: null })
    const res = await MANIFEST(req(null), ctx())
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe("GATEWAY_UNAVAILABLE")
    expect(M.markManifestIssued).not.toHaveBeenCalled()
  })

  it("only a pending, fresh, owned row: active → 409 AGENT_WRONG_STATE, stale → 410, someone else's → 404, junk id → 400", async () => {
    M.findOwnedAgent.mockResolvedValue(row({ status: "active", activatedAt: new Date() }))
    expect((await (await MANIFEST(req(null), ctx())).json()).error.code).toBe("AGENT_WRONG_STATE")
    M.findOwnedAgent.mockResolvedValue(row({ createdAt: new Date(Date.now() - 25 * 3600_000) }))
    const stale = await MANIFEST(req(null), ctx())
    expect(stale.status).toBe(410)
    // a retired key can never pair again, so the way out is never "retire it" (A2.4c)
    expect((await stale.json()).error.message).not.toMatch(/^Retire|\. Retire/)
    M.findOwnedAgent.mockResolvedValue(null)
    expect((await MANIFEST(req(null), ctx())).status).toBe(404)
    for (const id of ["12abc", "0", "-1", "99999999999"]) expect((await MANIFEST(req(null), ctx(id))).status).toBe(400)
    expect(M.readNonFungibleHolder).not.toHaveBeenCalled()
  })
})

describe("POST /agents/{id}/funded — confirm, then activate", () => {
  it("{intentHash} → verified by the tx; activates with pair_tx", async () => {
    M.verifyFundingTx.mockResolvedValue({ funded: true, via: "tx", intentHash: TX, badgeId: "<guild_member_myagent>" })
    M.activateAgent.mockResolvedValue(row({ status: "active", pairTx: TX, badgeId: "<guild_member_myagent>", activatedAt: new Date() }))
    const res = await FUNDED(req({ intentHash: TX }), ctx())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ status: "active", pairTx: TX })
    expect(M.verifyFundingTx).toHaveBeenCalledWith({ agentAccount: AGENT, labelNorm: "myagent", floatXrd: "200.000000000000000000", intentHash: TX })
    expect(M.activateAgent).toHaveBeenCalledWith({ id: 7, ownerId: OWNER, badgeId: "<guild_member_myagent>", pairTx: TX })
  })

  it("{} (the tab closed after signing) → verified by chain state; activates with no pair_tx", async () => {
    M.readFundingState.mockResolvedValue({ funded: true, via: "state", badgeId: "<guild_member_myagent>" })
    M.activateAgent.mockResolvedValue(row({ status: "active", badgeId: "<guild_member_myagent>", activatedAt: new Date() }))
    expect((await FUNDED(req({}), ctx())).status).toBe(200)
    expect(M.verifyFundingTx).not.toHaveBeenCalled()
    expect(M.activateAgent).toHaveBeenCalledWith(expect.objectContaining({ pairTx: null }))
  })

  it.each([
    ["tx_pending", "FUNDING_PENDING"],
    ["tx_failed", "FUNDING_TX_FAILED"],
    ["float_short", "FUNDING_FLOAT_SHORT"],
    ["badge_missing", "FUNDING_BADGE_MISSING"],
    ["badge_elsewhere", "LABEL_TAKEN"],
    ["not_minted", "FUNDING_NOT_FOUND"],
  ])("🔴 gap %s → 409 %s, row untouched", async (gap, code) => {
    M.verifyFundingTx.mockResolvedValue({ funded: false, gap })
    const res = await FUNDED(req({ intentHash: TX }), ctx())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe(code)
    expect(body.error.detail.gap).toBe(gap)
    expect(M.activateAgent).not.toHaveBeenCalled()
  })

  it("🔴 an unreadable chain is 503 and the agent stays pending — never activated on a guess", async () => {
    M.verifyFundingTx.mockResolvedValue(null)
    expect((await FUNDED(req({ intentHash: TX }), ctx())).status).toBe(503)
    expect(M.activateAgent).not.toHaveBeenCalled()
  })

  it("idempotent: an already-active agent answers 200 without reading the chain", async () => {
    M.findOwnedAgent.mockResolvedValue(row({ status: "active", activatedAt: new Date(), badgeId: "<guild_member_myagent>" }))
    expect((await FUNDED(req({ intentHash: TX }), ctx())).status).toBe(200)
    expect(M.verifyFundingTx).not.toHaveBeenCalled()
  })

  it("a malformed intentHash or an unknown field is 400; a retired agent is 409", async () => {
    expect((await FUNDED(req({ intentHash: "not-a-tx" }), ctx())).status).toBe(400)
    expect((await FUNDED(req({ intentHash: TX, extra: 1 }), ctx())).status).toBe(400)
    M.findOwnedAgent.mockResolvedValue(row({ status: "retired", activatedAt: new Date(), retiredAt: new Date() }))
    expect((await FUNDED(req({}), ctx())).status).toBe(409)
  })

  it("the row moved on between read and write (e.g. retired) → 409, not a false success", async () => {
    M.verifyFundingTx.mockResolvedValue({ funded: true, via: "tx", intentHash: TX, badgeId: "<guild_member_myagent>" })
    M.activateAgent.mockResolvedValue(null)
    M.findOwnedAgent.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ status: "retired", activatedAt: new Date() }))
    const res = await FUNDED(req({ intentHash: TX }), ctx())
    expect(res.status).toBe(409)
  })
})

describe("PATCH /agents/{id} — rename, float, rules", () => {
  beforeEach(() => {
    M.ownerHasAgentNamed.mockResolvedValue(false)
    M.labelHeldByAnotherOwner.mockResolvedValue(false)
    // every name — the current one and the new one — never minted, by default
    M.readNonFungibleHolder.mockResolvedValue({ minted: false })
    M.readClaimBondParams.mockResolvedValue({ pct: "0.1", floor: "76.45", cap: "152894" })
    M.updateAgentSettings.mockImplementation(async (a) => row({ ...(a.label ? { label: a.label.label, labelNorm: a.label.labelNorm } : {}) }))
  })

  it("🔴 a rename ALWAYS asks the chain about the current name — even with no manifest handed out (the kit can self-mint the badge)", async () => {
    // badge already in this agent's account under its current name, no manifest recorded here
    M.readNonFungibleHolder.mockResolvedValueOnce({ minted: true, burned: false, holder: AGENT })
    const funded = await PATCH(req({ label: "Other" }), ctx())
    expect(funded.status).toBe(409)
    expect((await funded.json()).error.code).toBe("ALREADY_FUNDED")
    // unknown holder → refuse, never treat as unusable
    M.readNonFungibleHolder.mockResolvedValueOnce({ minted: true, burned: false, holder: null })
    expect((await PATCH(req({ label: "Other" }), ctx())).status).toBe(503)
    expect(M.updateAgentSettings).not.toHaveBeenCalled()
  })

  it("renames a pending agent after the same three checks as a new code", async () => {
    const res = await PATCH(req({ label: "Better_Name" }), ctx())
    expect(res.status).toBe(200)
    expect(M.ownerHasAgentNamed).toHaveBeenCalledWith(OWNER, "better_name")
    expect(M.labelHeldByAnotherOwner).toHaveBeenCalledWith(OWNER, "better_name")
    expect(M.readNonFungibleHolder).toHaveBeenCalledWith(expect.any(String), "<guild_member_better_name>")
    expect(M.updateAgentSettings).toHaveBeenCalledWith(
      expect.objectContaining({ label: { label: "Better_Name", labelNorm: "better_name", from: "myagent", oldNameUnusable: false } }),
    )
  })

  it("🔴 renaming ONTO a badge already minted to this agent is accepted — it re-attaches funding that landed after the row moved off that name", async () => {
    // current name "myagent" free; "landed" is this agent's badge (an untracked mint that committed late)
    M.readNonFungibleHolder.mockImplementation(async (_r: string, id: string) =>
      id === "<guild_member_landed>" ? { minted: true, burned: false, holder: AGENT } : { minted: false },
    )
    const res = await PATCH(req({ label: "Landed" }), ctx())
    expect(res.status).toBe(200)
    expect(M.updateAgentSettings).toHaveBeenCalledWith(
      expect.objectContaining({ label: { label: "Landed", labelNorm: "landed", from: "myagent", oldNameUnusable: false } }),
    )
    // …but the same name held by ANY other account is taken, and a holder the Gateway does not name is unknown
    M.readNonFungibleHolder.mockImplementation(async (_r: string, id: string) =>
      id === "<guild_member_landed>" ? { minted: true, burned: false, holder: STRANGER } : { minted: false },
    )
    expect((await (await PATCH(req({ label: "Landed" }), ctx())).json()).error.code).toBe("LABEL_TAKEN")
    M.readNonFungibleHolder.mockImplementation(async (_r: string, id: string) =>
      id === "<guild_member_landed>" ? { minted: true, burned: false, holder: null } : { minted: false },
    )
    expect((await PATCH(req({ label: "Landed" }), ctx())).status).toBe(503)
    expect(M.updateAgentSettings).toHaveBeenCalledOnce()
  })

  it("🔴 no rename after funding (the badge is minted); a dash or 52 chars is refused; a taken name is 409", async () => {
    M.findOwnedAgent.mockResolvedValue(row({ status: "active", activatedAt: new Date() }))
    expect((await PATCH(req({ label: "Other" }), ctx())).status).toBe(409)
    M.findOwnedAgent.mockResolvedValue(row())
    expect((await PATCH(req({ label: "my-agent" }), ctx())).status).toBe(400)
    expect((await PATCH(req({ label: "a".repeat(52) }), ctx())).status).toBe(400)
    const newName = (answer: unknown) =>
      M.readNonFungibleHolder.mockImplementation(async (_r: string, id: string) =>
        id === "<guild_member_myagent>" ? { minted: false } : answer,
      )
    newName({ minted: true, burned: false, holder: STRANGER })
    expect((await (await PATCH(req({ label: "Taken" }), ctx())).json()).error.code).toBe("LABEL_TAKEN")
    newName({ minted: true, burned: true, holder: null })
    expect((await (await PATCH(req({ label: "Burned" }), ctx())).json()).error.code).toBe("LABEL_TAKEN")
    newName(null)
    expect((await PATCH(req({ label: "Unknown" }), ctx())).status).toBe(503)
  })

  it("🔴 after the funding tx was handed out, the name is FROZEN — unless the chain proves that tx can never land", async () => {
    const issued = row({ manifestIssuedAt: new Date() })
    M.findOwnedAgent.mockResolvedValue(issued)
    // not minted: a signed tx may still land under it
    M.readNonFungibleHolder.mockResolvedValue({ minted: false })
    const locked = await PATCH(req({ label: "Other" }), ctx())
    expect(locked.status).toBe(409)
    const lockedError = (await locked.json()).error
    expect(lockedError.code).toBe("NAME_LOCKED")
    // the owner is told when the hold ends, and that retiring costs the key (A2.4d)
    expect(lockedError.message).toMatch(/24 hours/)
    expect(lockedError.message).toMatch(/new key/)
    expect(M.updateAgentSettings).not.toHaveBeenCalled()
    // already in this agent's account: confirm instead
    M.readNonFungibleHolder.mockResolvedValue({ minted: true, burned: false, holder: AGENT })
    expect((await (await PATCH(req({ label: "Other" }), ctx())).json()).error.code).toBe("ALREADY_FUNDED")
    // unreadable: refuse
    M.readNonFungibleHolder.mockResolvedValue(null)
    expect((await PATCH(req({ label: "Other" }), ctx())).status).toBe(503)
    // current name minted to SOMEONE ELSE: the old tx can never succeed — rename allowed, and the write says so
    M.readNonFungibleHolder.mockImplementation(async (_r: string, id: string) =>
      id === "<guild_member_myagent>" ? { minted: true, burned: false, holder: STRANGER } : { minted: false },
    )
    expect((await PATCH(req({ label: "Other" }), ctx())).status).toBe(200)
    expect(M.updateAgentSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: { label: "Other", labelNorm: "other", from: "myagent", oldNameUnusable: true } }),
    )
    expect(M.readNonFungibleHolder).toHaveBeenCalledWith(expect.any(String), "<guild_member_myagent>")
  })

  it("🔴 the lock ends when the manifest can no longer land: > 24 h after it was handed out, a free name may be renamed", async () => {
    const DAY = 24 * 60 * 60 * 1000
    M.findOwnedAgent.mockResolvedValue(row({ manifestIssuedAt: new Date(Date.now() - DAY - 60_000) }))
    const res = await PATCH(req({ label: "Other" }), ctx())
    expect(res.status).toBe(200)
    // the SQL write gets the same clock, so it applies the same 24 h bound
    expect(M.updateAgentSettings).toHaveBeenCalledWith(expect.objectContaining({ now: expect.any(Date) }))
    // one minute inside the window: still locked
    M.findOwnedAgent.mockResolvedValue(row({ manifestIssuedAt: new Date(Date.now() - DAY + 60_000) }))
    expect((await (await PATCH(req({ label: "Other" }), ctx())).json()).error.code).toBe("NAME_LOCKED")
  })

  it("🔴 a manifest handed out WHILE the rename was being checked wins: the SQL write refuses and the answer is NAME_LOCKED", async () => {
    // read: no manifest yet; by the time the write runs, one was handed out
    M.findOwnedAgent.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ manifestIssuedAt: new Date() }))
    M.updateAgentSettings.mockResolvedValue(null)
    const res = await PATCH(req({ label: "Other" }), ctx())
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe("NAME_LOCKED")
  })

  it("🔴 the manifest route will not hand out a manifest for a name the row no longer has (renamed mid-request)", async () => {
    M.readNonFungibleHolder.mockResolvedValue({ minted: false })
    M.markManifestIssued.mockResolvedValue(false)
    M.findOwnedAgent.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ label: "Other", labelNorm: "other" }))
    const res = await MANIFEST(req(null), ctx())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe("AGENT_CHANGED")
    expect(body.data).toBeUndefined()
  })

  it("a case-only rename is fine even after the funding tx was handed out (same badge id)", async () => {
    M.findOwnedAgent.mockResolvedValue(row({ manifestIssuedAt: new Date() }))
    expect((await PATCH(req({ label: "MyAGENT" }), ctx())).status).toBe(200)
    expect(M.readNonFungibleHolder).not.toHaveBeenCalled()
  })

  it("a case-only rename keeps the badge name and skips the checks", async () => {
    expect((await PATCH(req({ label: "MYAGENT" }), ctx())).status).toBe(200)
    expect(M.readNonFungibleHolder).not.toHaveBeenCalled()
  })

  it("🔴 the float must cover one LIVE bond floor + the fee reserve (76.45 + 20); the floor is never a guessed constant", async () => {
    const low = await PATCH(req({ floatXrd: "96.44" }), ctx())
    expect(low.status).toBe(400)
    expect((await low.json()).error.detail.minimumXrd).toBe("96.45")
    M.updateAgentSettings.mockResolvedValue(row({ floatXrd: "96.45" }))
    // maxBond must also fit: send rules that do
    const rules = { ...defaultAgentRules("200"), maxBondXrd: "76.45" }
    expect((await PATCH(req({ floatXrd: "96.45", rules }), ctx())).status).toBe(200)
    M.readClaimBondParams.mockResolvedValue(null)
    expect((await PATCH(req({ floatXrd: "300" }), ctx())).status).toBe(503)
  })

  it("🔴 maxBondXrd ≤ float − 20 against what the request LEAVES in place (a lower float with the old rules is refused)", async () => {
    // existing rules: maxBond 180 (200 − 20). Dropping the float to 150 alone would break it.
    const res = await PATCH(req({ floatXrd: "150" }), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("MAX_BOND_EXCEEDS_FLOAT")
    const tooBig = { ...defaultAgentRules("200"), maxBondXrd: "181" }
    expect((await (await PATCH(req({ rules: tooBig }), ctx())).json()).error.code).toBe("MAX_BOND_EXCEEDS_FLOAT")
    expect(M.updateAgentSettings).not.toHaveBeenCalled()
  })

  it("rules are the strict v1 document — an unknown key or a bad poster address is 400 with the issues", async () => {
    const res = await PATCH(req({ rules: { ...defaultAgentRules("200"), autoApprove: true } }), ctx())
    expect(res.status).toBe(400)
    const bad = await PATCH(req({ rules: { ...defaultAgentRules("200"), trustedPosters: ["identity_rdx1abc"] } }), ctx())
    expect((await bad.json()).error.detail.issues.length).toBeGreaterThan(0)
  })

  it("an empty body, an unknown field, a retired agent → refused", async () => {
    expect((await PATCH(req({}), ctx())).status).toBe(400)
    expect((await PATCH(req({ status: "active" }), ctx())).status).toBe(400)
    M.findOwnedAgent.mockResolvedValue(row({ status: "retired", activatedAt: new Date() }))
    expect((await PATCH(req({ floatXrd: "300" }), ctx())).status).toBe(409)
  })
})

describe("PATCH /agents/{id} — Start / Pause and the stale-page guard (A2.4b)", () => {
  const active = () => row({ status: "active", activatedAt: new Date() })
  beforeEach(() => {
    M.findOwnedAgent.mockResolvedValue(active())
    M.updateAgentSettings.mockImplementation(async () => active())
  })

  it("dryRun alone reaches the write as dryRun — never as a rules document built from what the page had", async () => {
    expect((await PATCH(req({ dryRun: true }), ctx())).status).toBe(200)
    const call = M.updateAgentSettings.mock.calls[0][0]
    expect(call.dryRun).toBe(true)
    expect(call.rules).toBeUndefined()
    expect(call.baseRules).toBeUndefined()
  })

  it("Start carries baseRules through to the write", async () => {
    const base = defaultAgentRules("200")
    expect((await PATCH(req({ dryRun: false, baseRules: base }), ctx())).status).toBe(200)
    expect(M.updateAgentSettings.mock.calls[0][0]).toMatchObject({ dryRun: false, baseRules: base })
  })

  it("rules or dryRun, not both; baseRules only with one of them; baseRules must itself be a v1 document", async () => {
    const r = defaultAgentRules("200")
    expect((await PATCH(req({ rules: r, dryRun: false }), ctx())).status).toBe(400)
    expect((await PATCH(req({ baseRules: r }), ctx())).status).toBe(400)
    expect((await PATCH(req({ floatXrd: "300", baseRules: r }), ctx())).status).toBe(400)
    expect((await PATCH(req({ dryRun: "no" }), ctx())).status).toBe(400)
    expect((await PATCH(req({ rules: r, baseRules: { ...r, extra: 1 } }), ctx())).status).toBe(400)
    expect(M.updateAgentSettings).not.toHaveBeenCalled()
  })

  it("🔴 the write refused while the agent is still editable and its rules differ from baseRules → 409 RULES_CHANGED, carrying the CURRENT card", async () => {
    const base = defaultAgentRules("200")
    M.updateAgentSettings.mockResolvedValue(null)
    M.findOwnedAgent
      .mockResolvedValueOnce(active())
      .mockResolvedValueOnce(row({ status: "active", activatedAt: new Date(), rules: { ...base, trustedPosters: [] } }))
    const res = await PATCH(req({ rules: { ...base, maxClaimsPerDay: 3 }, baseRules: base }), ctx())
    expect(res.status).toBe(409)
    const error = (await res.json()).error
    expect(error.code).toBe("RULES_CHANGED")
    expect(error.detail.card.id).toBe(7)
    expect(error.detail.card.rules.trustedPosters).toEqual([])
    expect(error.detail.card.actions.edit).toBe(true)
  })

  it("🔴 a PENDING agent cannot leave practice mode — dryRun false refused before the write, however it is sent", async () => {
    M.findOwnedAgent.mockResolvedValue(row({ status: "pending" }))
    for (const body of [{ dryRun: false }, { rules: { ...defaultAgentRules("200"), dryRun: false } }]) {
      const res = await PATCH(req(body), ctx())
      expect(res.status).toBe(409)
      const error = (await res.json()).error
      expect(error.code).toBe("AGENT_WRONG_STATE")
      expect(error.message).toMatch(/practice mode until it is funded/)
    }
    expect(M.updateAgentSettings).not.toHaveBeenCalled()
    // Pause and practice-mode edits are fine while pending
    M.updateAgentSettings.mockResolvedValue(row())
    expect((await PATCH(req({ dryRun: true }), ctx())).status).toBe(200)
    expect((await PATCH(req({ rules: defaultAgentRules("200") }), ctx())).status).toBe(200)
  })

  it("…and a Start whose write missed because the agent was retired meanwhile says so", async () => {
    M.updateAgentSettings.mockResolvedValue(null)
    M.findOwnedAgent.mockResolvedValueOnce(active()).mockResolvedValueOnce(row({ status: "retired", activatedAt: new Date() }))
    const res = await PATCH(req({ dryRun: false }), ctx())
    expect((await res.json()).error.message).toBe("Cannot start an agent that is retired.")
  })

  it("…but a write refused because the agent was RETIRED meanwhile says so (never 'rules changed')", async () => {
    const base = defaultAgentRules("200")
    M.updateAgentSettings.mockResolvedValue(null)
    M.findOwnedAgent
      .mockResolvedValueOnce(active())
      .mockResolvedValueOnce(row({ status: "retired", activatedAt: new Date(), rules: { ...base, trustedPosters: [] } }))
    const res = await PATCH(req({ dryRun: false, baseRules: base }), ctx())
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe("AGENT_WRONG_STATE")
  })

  it("…and rules that still MATCH are not reported as changed", async () => {
    const base = defaultAgentRules("200")
    M.updateAgentSettings.mockResolvedValue(null)
    M.findOwnedAgent.mockResolvedValueOnce(active()).mockResolvedValueOnce(active())
    const res = await PATCH(req({ dryRun: false, baseRules: base }), ctx())
    expect((await res.json()).error.code).not.toBe("RULES_CHANGED")
  })
})

describe("the card's limits come from the server (A2.4b)", () => {
  it("maxBondXrd = float − the fee reserve, with the schema's own bounds", async () => {
    const { toAgentCard } = await vi.importActual<typeof import("@/db/queries/agents")>("@/db/queries/agents")
    expect(toAgentCard(row({ floatXrd: "200.000000000000000000" })).limits).toEqual({
      maxBondXrd: "180",
      feeReserveXrd: "20",
      maxClaimsPerDay: 100,
      maxTrustedPosters: 50,
    })
    expect(toAgentCard(row({ floatXrd: "96.450000000000000000" })).limits.maxBondXrd).toBe("76.45")
    expect(toAgentCard(row({ floatXrd: "10.000000000000000000" })).limits.maxBondXrd).toBe("0")
  })
})

describe("suspend / resume / retire", () => {
  it.each([
    ["suspend", SUSPEND, M.suspendAgent],
    ["resume", RESUME, M.resumeAgent],
    ["retire", RETIRE, M.retireAgent],
  ] as const)("%s: ok → the card; NOT_FOUND → 404; WRONG_STATE → 409 naming the state", async (_n, route, fn) => {
    fn.mockResolvedValue({ ok: true, agent: row({ status: "suspended", activatedAt: new Date(), suspendedAt: new Date() }) })
    const ok = await route(req(null), ctx())
    expect(ok.status).toBe(200)
    expect((await ok.json()).data.status).toBe("suspended")
    expect(fn).toHaveBeenCalledWith(7, OWNER)
    fn.mockResolvedValue({ ok: false, code: "NOT_FOUND", status: null })
    expect((await route(req(null), ctx())).status).toBe(404)
    fn.mockResolvedValue({ ok: false, code: "WRONG_STATE", status: "retired" })
    const wrong = await route(req(null), ctx())
    expect(wrong.status).toBe(409)
    expect((await wrong.json()).error.detail.status).toBe("retired")
  })

  it("retiring a pending agent answers its card, retired (the row is kept)", async () => {
    M.retireAgent.mockResolvedValue({ ok: true, agent: row({ status: "retired", retiredAt: new Date() }) })
    const body = await (await RETIRE(req(null), ctx())).json()
    expect(body.data.status).toBe("retired")
    expect(body.data.activatedAt).toBeNull()
  })
})
