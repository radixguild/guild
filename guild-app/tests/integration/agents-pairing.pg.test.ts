/**
 * Bring Your Agent pairing — the REAL queries against a REAL Postgres (PGlite).
 *
 * The route tests prove control flow against doubled queries; this file proves
 * the SQL: that redeeming a code is one bounded UPDATE inside the same
 * transaction as the agents INSERT (first writer wins, a second agent is
 * refused, an already-paired agent cannot consume a code), that a pending row
 * expires lazily at 24 h, and that the schema's CHECKs hold.
 *
 * ⚠️ As in x402-settlement-dedup.pg.test.ts: PGlite serialises statements
 * behind one connection, so the `Promise.all` case is "the second attempt meets
 * a row the first committed", not two backends racing. The assertion — exactly
 * one paired — is still the one a check-then-act implementation cannot satisfy.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { eq } from "drizzle-orm"

const A = vi.hoisted(() => ({ db: null as ReturnType<typeof drizzle> | null }))
const F = vi.hoisted(() => ({ readFundingState: vi.fn() }))
// The chain read is the one seam: every SQL statement below is real.
vi.mock("@/lib/agent-funding", () => ({ readFundingState: F.readFundingState }))

vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get(_t, prop) {
        const target = A.db as unknown as Record<string | symbol, unknown>
        const v = target?.[prop]
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(A.db) : v
      },
    },
  ),
}))

import {
  issuePairingCode,
  redeemPairingCode,
  findAgentByAgentId,
  listAgentsForOwner,
  listOpenCodesForOwner,
  findOwnedPairingCode,
  ownerHasAgentNamed,
  labelHeldByAnotherOwner,
  recordHeartbeat,
  toAgentMe,
  activateAgent,
  deleteStalePendingAgent,
  updateAgentSettings,
  suspendAgent,
  resumeAgent,
  retireAgent,
  AGENT_SUSPENDED_BY_OWNER,
  AGENT_RETIRED_BY_OWNER,
  markManifestIssued,
  toAgentCard,
  type OwnerAction,
} from "@/db/queries/agents"
import { loadAgentForSession, STALE_RECHECK_MS, __resetStaleRecheckForTests } from "@/lib/agent-lifecycle"
import { agents, pairingCodes, users, AGENT_STATUSES, type AgentStatus } from "@/db/schema"
import { GUILD_POSTERS } from "@/lib/agent-rules"

const OWNER = "account_rdx12y5senkxfxg38swfv4tg88lx73jqnkdvcnzv8kwwdmg0efl40r2p7u"
const AGENT = "account_rdx1agent000000000000000000000000000000000000000000001"
const AGENT2 = "account_rdx1agent000000000000000000000000000000000000000000002"
const OTHER_OWNER = "account_rdx1299rtllydz2vz6rrs4zafu2htkndwm2g5ksd27rrw9mhrechcm7tlr"

let client: PGlite

beforeAll(async () => {
  client = new PGlite()
  A.db = drizzle(client)
  // Written UNQUOTED, two-space indented, `timestamptz` — the shape
  // tests/unit/schema-ddl-drift.test.ts parses to prove this block has not
  // drifted from src/db/schema/agents.ts (both tables are in GUARDED_TABLES).
  await client.exec(`
CREATE TABLE pairing_codes (
  code text PRIMARY KEY NOT NULL,
  owner_id text NOT NULL,
  label text NOT NULL,
  label_norm text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  redeemed_by text,
  CONSTRAINT pairing_codes_redeemed_pair_check CHECK ((redeemed_at IS NULL) = (redeemed_by IS NULL))
);
CREATE INDEX pairing_codes_expires_at_idx ON pairing_codes (expires_at);
CREATE INDEX pairing_codes_owner_id_idx ON pairing_codes (owner_id);
CREATE TABLE agents (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
  owner_id text NOT NULL,
  agent_id text NOT NULL,
  label text NOT NULL,
  label_norm text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  float_xrd numeric(38, 18) NOT NULL,
  rules jsonb NOT NULL,
  pair_tx text,
  badge_id text,
  last_seen_at timestamptz,
  last_cycle jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  suspended_at timestamptz,
  retired_at timestamptz,
  manifest_issued_at timestamptz,
  CONSTRAINT agents_owner_is_not_agent_check CHECK (owner_id <> agent_id),
  CONSTRAINT agents_activated_at_check CHECK (
    (status = 'pending' AND activated_at IS NULL) OR
    (status IN ('active', 'suspended') AND activated_at IS NOT NULL) OR
    (status = 'retired')
  )
);
CREATE UNIQUE INDEX agents_agent_id_unique ON agents (agent_id);
CREATE INDEX agents_owner_id_idx ON agents (owner_id);
CREATE INDEX agents_status_created_idx ON agents (status, created_at);
CREATE TABLE users (
  id text PRIMARY KEY,
  display_name text,
  badge_id text,
  badge_tier text DEFAULT 'member',
  xp integer NOT NULL DEFAULT 0,
  reputation integer NOT NULL DEFAULT 0,
  is_agent boolean NOT NULL DEFAULT false,
  suspended_at timestamptz,
  suspended_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
  `)
})

beforeEach(async () => {
  await client.exec(`DELETE FROM agents; DELETE FROM pairing_codes; DELETE FROM users;`)
  F.readFundingState.mockReset()
  __resetStaleRecheckForTests()
})

const issue = (over: Partial<Parameters<typeof issuePairingCode>[0]> = {}) =>
  issuePairingCode({ ownerId: OWNER, label: "MyAgent", labelNorm: "myagent", ...over })

describe("findOwnedPairingCode — the owner's per-code status read", () => {
  it("finds the owner's own code, open then redeemed; never another owner's", async () => {
    const { code } = await issue()
    expect((await findOwnedPairingCode(code, OWNER))?.redeemedAt).toBeNull()
    expect(await findOwnedPairingCode(code, OTHER_OWNER)).toBeNull()
    await redeemPairingCode({ code, agentId: AGENT })
    expect((await findOwnedPairingCode(code, OWNER))?.redeemedAt).not.toBeNull()
    expect(await findOwnedPairingCode("ZZZZZZZZ", OWNER)).toBeNull()
  })
})

describe("issue → redeem", () => {
  it("a redeemed code creates ONE pending agent bound to the code's owner, with the default float and rules", async () => {
    const { code, expiresAt } = await issue()
    expect(code).toMatch(/^[0-9A-Z]{8}$/)
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000)

    const r = await redeemPairingCode({ code, agentId: AGENT })
    expect(r.outcome).toBe("paired")
    if (r.outcome !== "paired") throw new Error("unreachable")
    expect(r.agent).toMatchObject({ ownerId: OWNER, agentId: AGENT, label: "MyAgent", labelNorm: "myagent", status: "pending", badgeId: null, activatedAt: null })
    expect(r.agent.rules).toEqual({ v: 1, trustedPosters: [...GUILD_POSTERS], maxBondXrd: "180", maxClaimsPerDay: 1, dryRun: true })

    // The wire shape the kit parses: floatXrd trimmed, never "200.000000000000000000".
    expect(toAgentMe(r.agent)).toEqual({
      label: "MyAgent",
      status: "pending",
      ownerAccount: OWNER,
      floatXrd: "200",
      badgeId: null,
      rules: r.agent.rules,
    })

    const [c] = await A.db!.select().from(pairingCodes).where(eq(pairingCodes.code, code))
    expect(c.redeemedBy).toBe(AGENT)
    expect(c.redeemedAt).not.toBeNull()
  })

  it("🔴 the same code cannot be redeemed twice, and the second agent is told 'invalid' (not 'expired')", async () => {
    const { code } = await issue()
    expect((await redeemPairingCode({ code, agentId: AGENT })).outcome).toBe("paired")
    expect((await redeemPairingCode({ code, agentId: AGENT2 })).outcome).toBe("invalid")
    expect(await A.db!.select().from(agents)).toHaveLength(1)
  })

  it("🔴 exactly one of N simultaneous redemptions pairs — the UPDATE is the gate", async () => {
    const { code } = await issue()
    const ids = Array.from({ length: 4 }, (_, i) => `account_rdx1race0000000000000000000000000000000000000000000000${i}`)
    const results = await Promise.all(ids.map((agentId) => redeemPairingCode({ code, agentId })))
    expect(results.filter((r) => r.outcome === "paired")).toHaveLength(1)
    expect(results.filter((r) => r.outcome === "invalid")).toHaveLength(3)
    expect(await A.db!.select().from(agents)).toHaveLength(1)
  })

  it("an unknown code is 'invalid'; an expired one says so", async () => {
    expect((await redeemPairingCode({ code: "ZZZZZZZZ", agentId: AGENT })).outcome).toBe("invalid")
    const { code } = await issue({ ttlMs: -1 })
    expect((await redeemPairingCode({ code, agentId: AGENT })).outcome).toBe("expired")
    // and it was NOT consumed
    const [c] = await A.db!.select().from(pairingCodes).where(eq(pairingCodes.code, code))
    expect(c.redeemedAt).toBeNull()
  })

  it("🔴 an already-paired agent cannot consume a second code: refused, code left redeemable", async () => {
    const first = await issue()
    expect((await redeemPairingCode({ code: first.code, agentId: AGENT })).outcome).toBe("paired")
    const second = await issue({ label: "Other", labelNorm: "other" })
    const r = await redeemPairingCode({ code: second.code, agentId: AGENT })
    expect(r.outcome).toBe("already_paired")
    const [c] = await A.db!.select().from(pairingCodes).where(eq(pairingCodes.code, second.code))
    expect(c.redeemedAt).toBeNull()
    expect(await A.db!.select().from(agents)).toHaveLength(1)
  })

  it("🔴 one agent redeeming TWO different codes at once: one pairs, the other is told already_paired — never a raw constraint error", async () => {
    // Both calls pass the pre-check before either transaction runs (PGlite
    // queues the two SELECTs ahead of both BEGINs), so the second INSERT meets
    // the first one's row: the path the pre-check alone cannot cover.
    const a = await issue()
    const b = await issue({ label: "Second", labelNorm: "second" })
    const results = await Promise.all([
      redeemPairingCode({ code: a.code, agentId: AGENT }),
      redeemPairingCode({ code: b.code, agentId: AGENT }),
    ])
    expect(results.map((r) => r.outcome).sort()).toEqual(["already_paired", "paired"])
    expect(await A.db!.select().from(agents)).toHaveLength(1)
    // the loser's transaction rolled back: exactly one code consumed, the other still open for its owner
    const codes = await A.db!.select().from(pairingCodes)
    expect(codes.filter((c) => c.redeemedAt !== null)).toHaveLength(1)
    expect(codes.filter((c) => c.redeemedAt === null)).toHaveLength(1)
  })

  it("🔴 an owner redeeming its own code is classified (self_pair), not a raw error — and the code stays open for the real agent", async () => {
    const { code } = await issue()
    expect((await redeemPairingCode({ code, agentId: OWNER })).outcome).toBe("self_pair")
    const [c] = await A.db!.select().from(pairingCodes).where(eq(pairingCodes.code, code))
    expect(c.redeemedAt).toBeNull()
    expect(await A.db!.select().from(agents)).toHaveLength(0)
    expect((await redeemPairingCode({ code, agentId: AGENT })).outcome).toBe("paired")
  })
})

const age = (hours: number) =>
  client.exec(`UPDATE agents SET created_at = now() - interval '${hours} hours' WHERE agent_id = '${AGENT}';`)
const paired = async () => {
  const { code } = await issue()
  const r = await redeemPairingCode({ code, agentId: AGENT })
  if (r.outcome !== "paired") throw new Error("setup: expected paired")
  return r.agent
}

describe("the 24 h pending expiry asks the chain before it deletes (A1b)", () => {
  it("findAgentByAgentId is a plain read now — it returns a stale pending row untouched", async () => {
    await paired()
    await age(25)
    expect((await findAgentByAgentId(AGENT))?.status).toBe("pending")
    expect(await A.db!.select().from(agents)).toHaveLength(1)
  })

  it("🔴 stale + never minted → deleted, and the key may pair again", async () => {
    await paired()
    await age(25)
    F.readFundingState.mockResolvedValue({ funded: false, gap: "not_minted" })
    expect(await loadAgentForSession(AGENT)).toBeNull()
    expect(await A.db!.select().from(agents)).toHaveLength(0)
    const again = await issue({ label: "Again", labelNorm: "again" })
    expect((await redeemPairingCode({ code: again.code, agentId: AGENT })).outcome).toBe("paired")
  })

  it("🔴 stale + FUNDED on-chain (the confirm never came) → activated, never deleted", async () => {
    await paired()
    await age(25)
    F.readFundingState.mockResolvedValue({ funded: true, via: "state", badgeId: "<guild_member_myagent>" })
    const row = await loadAgentForSession(AGENT)
    expect(row?.status).toBe("active")
    expect(row?.badgeId).toBe("<guild_member_myagent>")
    expect(row?.pairTx).toBeNull()
    expect(row?.activatedAt).not.toBeNull()
  })

  it("🔴 stale + badge here but float short → kept pending; stale + chain unreadable → kept pending", async () => {
    await paired()
    await age(25)
    F.readFundingState.mockResolvedValue({ funded: false, gap: "float_short" })
    expect((await loadAgentForSession(AGENT))?.status).toBe("pending")
    F.readFundingState.mockResolvedValue(null)
    expect((await loadAgentForSession(AGENT))?.status).toBe("pending")
    expect(await A.db!.select().from(agents)).toHaveLength(1)
  })

  it("🔴 a stale row the chain cannot settle is re-checked at most once per cooldown — not on every poll", async () => {
    await paired()
    await age(25)
    F.readFundingState.mockResolvedValue({ funded: false, gap: "float_short" })
    const t0 = new Date()
    for (let i = 0; i < 5; i++) await loadAgentForSession(AGENT, new Date(t0.getTime() + i * 1000))
    expect(F.readFundingState).toHaveBeenCalledTimes(1)
    // an unreadable Gateway is held the same way
    F.readFundingState.mockResolvedValue(null)
    await loadAgentForSession(AGENT, new Date(t0.getTime() + STALE_RECHECK_MS - 1))
    expect(F.readFundingState).toHaveBeenCalledTimes(1)
    // after the cooldown it is asked again — and a settled answer takes effect at once
    F.readFundingState.mockResolvedValue({ funded: true, via: "state", badgeId: "<guild_member_myagent>" })
    const row = await loadAgentForSession(AGENT, new Date(t0.getTime() + STALE_RECHECK_MS + 1))
    expect(F.readFundingState).toHaveBeenCalledTimes(2)
    expect(row?.status).toBe("active")
  })

  it("🔴 concurrent polls of the same stale row share ONE chain read (the claim is taken before the Gateway is awaited)", async () => {
    await paired()
    await age(25)
    let release: (v: unknown) => void = () => {}
    F.readFundingState.mockImplementation(() => new Promise((r) => (release = r)))
    const t = new Date()
    const a = loadAgentForSession(AGENT, t)
    const b = loadAgentForSession(AGENT, new Date(t.getTime() + 5))
    await new Promise((r) => setTimeout(r, 20))
    release({ funded: false, gap: "float_short" })
    await Promise.all([a, b])
    expect(F.readFundingState).toHaveBeenCalledTimes(1)
  })

  it("🔴 a present badge whose holder the Gateway did not report is UNKNOWN — the stale row is kept, never released", async () => {
    await paired()
    await age(25)
    F.readFundingState.mockResolvedValue(null) // what readFundingState now returns for holder: null
    expect((await loadAgentForSession(AGENT))?.status).toBe("pending")
    expect(await A.db!.select().from(agents)).toHaveLength(1)
  })

  it("a FRESH pending row never costs a chain read", async () => {
    await paired()
    expect((await loadAgentForSession(AGENT))?.status).toBe("pending")
    expect(F.readFundingState).not.toHaveBeenCalled()
  })

  it("🔴 a stale row whose funding tx was handed out < 24 h ago is KEPT even when the chain says 'not minted' (it may be in flight)", async () => {
    const row = await paired()
    await age(25)
    await client.exec(`UPDATE agents SET manifest_issued_at = now() - interval '1 hour' WHERE agent_id = '${AGENT}';`)
    F.readFundingState.mockResolvedValue({ funded: false, gap: "not_minted" })
    expect((await loadAgentForSession(AGENT))?.status).toBe("pending")
    // and the SQL guard holds on its own, whatever a caller decides
    expect(await deleteStalePendingAgent(row.id)).toBe(false)
    expect(await A.db!.select().from(agents)).toHaveLength(1)
  })

  it("…and released once that manifest is > 24 h old and still nothing landed", async () => {
    await paired()
    await age(50)
    await client.exec(`UPDATE agents SET manifest_issued_at = now() - interval '25 hours' WHERE agent_id = '${AGENT}';`)
    F.readFundingState.mockResolvedValue({ funded: false, gap: "not_minted" })
    expect(await loadAgentForSession(AGENT)).toBeNull()
    expect(await A.db!.select().from(agents)).toHaveLength(0)
  })

  it("deleteStalePendingAgent agrees with isStalePending at exactly 24 h, and never touches a fresh or active row", async () => {
    const row = await paired()
    const atBoundary = new Date(row.createdAt.getTime() + 24 * 60 * 60 * 1000)
    expect(await deleteStalePendingAgent(row.id, new Date(atBoundary.getTime() - 1))).toBe(false)
    expect(await deleteStalePendingAgent(row.id, atBoundary)).toBe(true)
    const again = await paired()
    await client.exec(`UPDATE agents SET status = 'active', activated_at = now(), created_at = now() - interval '30 days';`)
    expect(await deleteStalePendingAgent(again.id)).toBe(false)
  })

  it("🔴 a row the bounded DELETE could not remove (activated in between) is reported as it now is", async () => {
    await paired()
    await age(25)
    F.readFundingState.mockResolvedValue({ funded: false, gap: "not_minted" })
    await client.exec(`
CREATE FUNCTION activate_instead() RETURNS trigger AS $$
BEGIN
  UPDATE agents SET status = 'active', activated_at = now() WHERE id = OLD.id;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER activate_instead BEFORE DELETE ON agents FOR EACH ROW EXECUTE FUNCTION activate_instead();
    `)
    try {
      expect((await loadAgentForSession(AGENT))?.status).toBe("active")
    } finally {
      await client.exec(`DROP TRIGGER activate_instead ON agents; DROP FUNCTION activate_instead();`)
    }
  })
})

describe("activation (A1b)", () => {
  it("pending → active with badge + pair_tx; a second call is idempotent; someone else's id is null", async () => {
    const row = await paired()
    const tx = "txid_rdx1funding00000000000000000000000000000000000000000000000"
    const a = await activateAgent({ id: row.id, ownerId: OWNER, badgeId: "<guild_member_myagent>", pairTx: tx })
    expect(a?.status).toBe("active")
    expect(a?.pairTx).toBe(tx)
    const again = await activateAgent({ id: row.id, ownerId: OWNER, badgeId: "<guild_member_myagent>", pairTx: tx })
    expect(again?.id).toBe(row.id)
    expect(await activateAgent({ id: row.id, ownerId: OTHER_OWNER, badgeId: "<guild_member_myagent>", pairTx: tx })).toBeNull()
  })

  it("a retired row is never re-activated", async () => {
    const row = await paired()
    await client.exec(`UPDATE agents SET status = 'retired', activated_at = now(), retired_at = now();`)
    expect(await activateAgent({ id: row.id, ownerId: OWNER, badgeId: "<guild_member_myagent>", pairTx: null })).toBeNull()
  })
})

describe("owner edits (A1b)", () => {
  it("🔴 a rename lands only while pending; after activation the same write is refused (the badge is minted)", async () => {
    const row = await paired()
    const renamed = await updateAgentSettings({
      id: row.id,
      ownerId: OWNER,
      label: { label: "Other_1", labelNorm: "other_1", from: "myagent", oldNameUnusable: false },
    })
    expect(renamed?.labelNorm).toBe("other_1")
    await activateAgent({ id: row.id, ownerId: OWNER, badgeId: "<guild_member_other_1>", pairTx: null })
    expect(
      await updateAgentSettings({ id: row.id, ownerId: OWNER, label: { label: "Third", labelNorm: "third", from: "other_1", oldNameUnusable: false } }),
    ).toBeNull()
    expect((await findAgentByAgentId(AGENT))?.labelNorm).toBe("other_1")
  })

  it("🔴 a manifest handed out between a rename's read and its write WINS — the rename is refused in SQL, the name stays", async () => {
    const row = await paired()
    // the rename was checked while manifest_issued_at was null…
    expect(row.manifestIssuedAt).toBeNull()
    // …then the manifest route stamped it before the rename's write landed
    expect(await markManifestIssued(row.id, OWNER, "myagent")).toBe(true)
    const r = await updateAgentSettings({ id: row.id, ownerId: OWNER, label: { label: "Other", labelNorm: "other", from: "myagent", oldNameUnusable: false } })
    expect(r).toBeNull()
    expect((await findAgentByAgentId(AGENT))?.labelNorm).toBe("myagent")
  })

  it("🔴 the SQL name lock has the same 24 h bound as the release: a manifest > 24 h old no longer freezes the name", async () => {
    const row = await paired()
    await client.exec(`UPDATE agents SET manifest_issued_at = now() - interval '23 hours' WHERE agent_id = '${AGENT}';`)
    const rename = (labelNorm: string, from: string) =>
      updateAgentSettings({ id: row.id, ownerId: OWNER, label: { label: labelNorm, labelNorm, from, oldNameUnusable: false } })
    expect(await rename("other", "myagent")).toBeNull()
    await client.exec(`UPDATE agents SET manifest_issued_at = now() - interval '25 hours' WHERE agent_id = '${AGENT}';`)
    const r = await rename("other", "myagent")
    expect(r?.labelNorm).toBe("other")
    expect(r?.manifestIssuedAt).toBeNull()
  })

  it("a rename whose `from` is no longer the row's name is refused (renamed meanwhile)", async () => {
    const row = await paired()
    await updateAgentSettings({ id: row.id, ownerId: OWNER, label: { label: "Second", labelNorm: "second", from: "myagent", oldNameUnusable: false } })
    expect(
      await updateAgentSettings({ id: row.id, ownerId: OWNER, label: { label: "Third", labelNorm: "third", from: "myagent", oldNameUnusable: false } }),
    ).toBeNull()
    expect((await findAgentByAgentId(AGENT))?.labelNorm).toBe("second")
  })

  it("🔴 the proven-unusable escape renames past a manifest AND clears the stamp — so a later rename is not falsely locked", async () => {
    const row = await paired()
    await markManifestIssued(row.id, OWNER, "myagent")
    const r1 = await updateAgentSettings({ id: row.id, ownerId: OWNER, label: { label: "Second", labelNorm: "second", from: "myagent", oldNameUnusable: true } })
    expect(r1?.labelNorm).toBe("second")
    expect(r1?.manifestIssuedAt).toBeNull()
    const r2 = await updateAgentSettings({ id: row.id, ownerId: OWNER, label: { label: "Third", labelNorm: "third", from: "second", oldNameUnusable: false } })
    expect(r2?.labelNorm).toBe("third")
  })

  it("a case-only rename keeps the stamp (same badge id) and is allowed after a manifest", async () => {
    const row = await paired()
    await markManifestIssued(row.id, OWNER, "myagent")
    const r = await updateAgentSettings({ id: row.id, ownerId: OWNER, label: { label: "MYAGENT", labelNorm: "myagent", from: "myagent", oldNameUnusable: false } })
    expect(r?.label).toBe("MYAGENT")
    expect(r?.manifestIssuedAt).not.toBeNull()
  })

  it("rules and float change on an active agent; never on a retired one or someone else's", async () => {
    const row = await paired()
    await activateAgent({ id: row.id, ownerId: OWNER, badgeId: "<guild_member_myagent>", pairTx: null })
    const rules = { v: 1 as const, trustedPosters: [], maxBondXrd: "100", maxClaimsPerDay: 3, dryRun: false }
    const r = await updateAgentSettings({ id: row.id, ownerId: OWNER, rules, floatXrd: "150" })
    expect(r?.rules).toEqual(rules)
    expect(toAgentMe(r!).floatXrd).toBe("150")
    expect(await updateAgentSettings({ id: row.id, ownerId: OTHER_OWNER, floatXrd: "1" })).toBeNull()
    await client.exec(`UPDATE agents SET status = 'retired', retired_at = now();`)
    expect(await updateAgentSettings({ id: row.id, ownerId: OWNER, floatXrd: "300" })).toBeNull()
  })
})

describe("rules edits from a page a poll behind (A2.4b)", () => {
  const activeAgent = async () => {
    const row = await paired()
    await activateAgent({ id: row.id, ownerId: OWNER, badgeId: "<guild_member_myagent>", pairTx: null })
    return row
  }
  const edited = { v: 1 as const, trustedPosters: [GUILD_POSTERS[0]], maxBondXrd: "50", maxClaimsPerDay: 2, dryRun: true }

  it("🔴 baseRules that match land — key order does not matter (jsonb equality)", async () => {
    const row = await activeAgent()
    const current = row.rules
    const reordered = {
      dryRun: current.dryRun,
      maxClaimsPerDay: current.maxClaimsPerDay,
      maxBondXrd: current.maxBondXrd,
      trustedPosters: current.trustedPosters,
      v: current.v,
    }
    const r = await updateAgentSettings({ id: row.id, ownerId: OWNER, rules: edited, baseRules: reordered })
    expect(r?.rules).toEqual(edited)
  })

  it("🔴 baseRules that no longer match are refused — a stale page cannot restore a poster the owner removed", async () => {
    const row = await activeAgent()
    // the owner narrows the posters on another device…
    await updateAgentSettings({ id: row.id, ownerId: OWNER, rules: { ...row.rules, trustedPosters: [] } })
    // …and this page, still holding the old rules, saves an edit based on them
    const stale = await updateAgentSettings({ id: row.id, ownerId: OWNER, rules: { ...row.rules, maxClaimsPerDay: 5 }, baseRules: row.rules })
    expect(stale).toBeNull()
    expect((await findAgentByAgentId(AGENT))?.rules.trustedPosters).toEqual([])
  })

  it("🔴 dryRun alone changes ONLY dryRun — every other rule stays as the row has it", async () => {
    const row = await activeAgent()
    await updateAgentSettings({ id: row.id, ownerId: OWNER, rules: edited })
    const started = await updateAgentSettings({ id: row.id, ownerId: OWNER, dryRun: false })
    expect(started?.rules).toEqual({ ...edited, dryRun: false })
    const paused = await updateAgentSettings({ id: row.id, ownerId: OWNER, dryRun: true })
    expect(paused?.rules).toEqual(edited)
  })

  it("🔴 a PENDING agent stays in practice: dryRun false is refused however it is sent; practice-mode edits land", async () => {
    const row = await paired()
    expect(await updateAgentSettings({ id: row.id, ownerId: OWNER, dryRun: false })).toBeNull()
    expect(await updateAgentSettings({ id: row.id, ownerId: OWNER, rules: { ...edited, dryRun: false } })).toBeNull()
    expect((await findAgentByAgentId(AGENT))?.rules.dryRun).toBe(true)
    expect((await updateAgentSettings({ id: row.id, ownerId: OWNER, rules: edited }))?.rules).toEqual(edited)
    expect((await updateAgentSettings({ id: row.id, ownerId: OWNER, dryRun: true }))?.rules.dryRun).toBe(true)
    // once funded, Start lands
    await activateAgent({ id: row.id, ownerId: OWNER, badgeId: "<guild_member_myagent>", pairTx: null })
    expect((await updateAgentSettings({ id: row.id, ownerId: OWNER, dryRun: false }))?.rules.dryRun).toBe(false)
  })

  it("🔴 Start with stale baseRules is refused; Pause (no baseRules) always lands", async () => {
    const row = await activeAgent()
    await updateAgentSettings({ id: row.id, ownerId: OWNER, rules: edited })
    expect(await updateAgentSettings({ id: row.id, ownerId: OWNER, dryRun: false, baseRules: row.rules })).toBeNull()
    expect((await findAgentByAgentId(AGENT))?.rules.dryRun).toBe(true)
    expect(await updateAgentSettings({ id: row.id, ownerId: OWNER, dryRun: false, baseRules: edited })).not.toBeNull()
    expect((await updateAgentSettings({ id: row.id, ownerId: OWNER, dryRun: true }))?.rules.dryRun).toBe(true)
  })
})

describe("suspend / resume / retire (A1b) — the agent's own account is locked, an operator's lock is never touched", () => {
  const userRow = async () => (await A.db!.select().from(users).where(eq(users.id, AGENT)))[0]
  const activeAgent = async () => {
    const row = await paired()
    await activateAgent({ id: row.id, ownerId: OWNER, badgeId: "<guild_member_myagent>", pairTx: null })
    return row
  }

  it("🔴 suspend locks the agent's account (upserting a missing users row); resume lifts exactly that lock", async () => {
    const row = await activeAgent()
    const s1 = await suspendAgent(row.id, OWNER)
    expect(s1.ok && s1.agent?.status).toBe("suspended")
    expect((await userRow())?.suspendedReason).toBe(AGENT_SUSPENDED_BY_OWNER)
    expect((await userRow())?.suspendedAt).not.toBeNull()
    const r1 = await resumeAgent(row.id, OWNER)
    expect(r1.ok && r1.agent?.status).toBe("active")
    expect((await userRow())?.suspendedAt).toBeNull()
  })

  it("🔴 an OPERATOR suspension is neither overwritten by the owner's suspend nor lifted by the owner's resume", async () => {
    const row = await activeAgent()
    await A.db!.insert(users).values({ id: AGENT, suspendedAt: new Date(), suspendedReason: "operator: abuse report 12" })
    await suspendAgent(row.id, OWNER)
    expect((await userRow())?.suspendedReason).toBe("operator: abuse report 12")
    await resumeAgent(row.id, OWNER)
    expect((await findAgentByAgentId(AGENT))?.status).toBe("active")
    const u = await userRow()
    expect(u?.suspendedReason).toBe("operator: abuse report 12")
    expect(u?.suspendedAt).not.toBeNull()
  })

  it("wrong state and wrong owner are classified, not thrown", async () => {
    const row = await paired()
    expect(await suspendAgent(row.id, OWNER)).toEqual({ ok: false, code: "WRONG_STATE", status: "pending" })
    expect(await resumeAgent(row.id, OWNER)).toEqual({ ok: false, code: "WRONG_STATE", status: "pending" })
    expect(await suspendAgent(row.id, OTHER_OWNER)).toEqual({ ok: false, code: "NOT_FOUND", status: null })
  })

  it("🔴 retiring a PENDING agent KEEPS the row (a float may already have landed) — retired, never activated, account locked", async () => {
    const row = await paired()
    const r = await retireAgent(row.id, OWNER)
    expect(r.ok && r.agent.status).toBe("retired")
    expect(r.ok && r.agent.activatedAt).toBeNull()
    expect(r.ok && r.agent.retiredAt).not.toBeNull()
    const kept = await A.db!.select().from(agents)
    expect(kept).toHaveLength(1)
    expect(kept[0].agentId).toBe(AGENT)
    expect((await userRow())?.suspendedReason).toBe(AGENT_RETIRED_BY_OWNER)
    // one key, one owner, for life: the key does not pair again — a new agent means a new key
    const again = await issue({ label: "Again", labelNorm: "again" })
    expect((await redeemPairingCode({ code: again.code, agentId: AGENT })).outcome).toBe("already_paired")
  })

  it("🔴 retiring an active or suspended agent keeps the row, locks the account for good, and resume cannot undo it", async () => {
    const row = await activeAgent()
    await suspendAgent(row.id, OWNER)
    const r = await retireAgent(row.id, OWNER)
    expect(r.ok && r.agent?.status).toBe("retired")
    expect(r.ok && r.agent?.retiredAt).not.toBeNull()
    // the earlier owner lock stays in place (never overwritten)…
    expect((await userRow())?.suspendedAt).not.toBeNull()
    // …and resume refuses a retired agent
    expect(await resumeAgent(row.id, OWNER)).toEqual({ ok: false, code: "WRONG_STATE", status: "retired" })
    expect(await retireAgent(row.id, OWNER)).toEqual({ ok: false, code: "WRONG_STATE", status: "retired" })
  })

  it("retiring an active agent with no prior lock records the retire reason", async () => {
    const row = await activeAgent()
    await retireAgent(row.id, OWNER)
    expect((await userRow())?.suspendedReason).toBe(AGENT_RETIRED_BY_OWNER)
  })
})

describe("the card's `actions` are what the server's writes accept (A2.4)", () => {
  // The owner's page offers a control only when the card's `actions` says so,
  // and never re-derives the rule. This proves the flag against the REAL write
  // for every status × action, so a table edit that drifts from the SQL bound
  // (or the reverse) fails here.
  const inStatus = async (status: AgentStatus) => {
    const row = await paired()
    if (status === "pending") return row
    if (status === "retired") {
      await retireAgent(row.id, OWNER)
    } else {
      await activateAgent({ id: row.id, ownerId: OWNER, badgeId: "<guild_member_myagent>", pairTx: null })
      if (status === "suspended") await suspendAgent(row.id, OWNER)
    }
    const [now] = await A.db!.select().from(agents).where(eq(agents.id, row.id))
    expect(now.status).toBe(status)
    return now
  }
  const attempt: Record<OwnerAction, (id: number) => Promise<boolean>> = {
    rename: async (id) =>
      (await updateAgentSettings({
        id,
        ownerId: OWNER,
        label: { label: "Renamed", labelNorm: "renamed", from: "myagent", oldNameUnusable: false },
      })) !== null,
    edit: async (id) =>
      (await updateAgentSettings({
        id,
        ownerId: OWNER,
        rules: { v: 1, trustedPosters: [], maxBondXrd: "10", maxClaimsPerDay: 2, dryRun: true },
      })) !== null,
    start: async (id) => (await updateAgentSettings({ id, ownerId: OWNER, dryRun: false })) !== null,
    suspend: async (id) => (await suspendAgent(id, OWNER)).ok,
    resume: async (id) => (await resumeAgent(id, OWNER)).ok,
    retire: async (id) => (await retireAgent(id, OWNER)).ok,
  }

  const cases = AGENT_STATUSES.flatMap((status) =>
    (Object.keys(attempt) as OwnerAction[]).map((action) => [status, action] as const),
  )
  it.each(cases)("🔴 %s × %s: the card's flag equals the write's outcome", async (status, action) => {
    const row = await inStatus(status)
    const offered = toAgentCard(row).actions[action]
    expect(await attempt[action](row.id)).toBe(offered)
  })

  it("every status offers at least one way out but a retired card offers nothing", async () => {
    for (const status of AGENT_STATUSES) {
      await client.exec(`DELETE FROM agents; DELETE FROM pairing_codes; DELETE FROM users;`)
      const actions = toAgentCard(await inStatus(status)).actions
      expect(Object.values(actions).some(Boolean)).toBe(status !== "retired")
    }
  })
})

describe("owner views", () => {
  it("lists an owner's agents and open codes; a redeemed or expired code drops out of the open list", async () => {
    const open = await issue()
    const used = await issue({ label: "Used", labelNorm: "used" })
    await redeemPairingCode({ code: used.code, agentId: AGENT })
    await issue({ label: "Old", labelNorm: "old", ttlMs: -1 })

    const codes = await listOpenCodesForOwner(OWNER)
    expect(codes.map((c) => c.code)).toEqual([open.code])
    const mine = await listAgentsForOwner(OWNER)
    expect(mine.map((a) => a.labelNorm)).toEqual(["used"])
    expect(await listAgentsForOwner(AGENT)).toEqual([])
  })

  it("ownerHasAgentNamed sees pending and active rows, not retired ones", async () => {
    const { code } = await issue()
    await redeemPairingCode({ code, agentId: AGENT })
    expect(await ownerHasAgentNamed(OWNER, "myagent")).toBe(true)
    expect(await ownerHasAgentNamed(OWNER, "other")).toBe(false)
    await client.exec(`UPDATE agents SET status = 'retired', activated_at = now(), retired_at = now() WHERE agent_id = '${AGENT}';`)
    expect(await ownerHasAgentNamed(OWNER, "myagent")).toBe(false)
  })
})

describe("a name is held Guild-wide while it is live", () => {
  const OTHER_AGENT = "account_rdx1agent000000000000000000000000000000000000000000003"

  it("🔴 another owner's fresh pending agent or open code holds the name; my own never blocks me", async () => {
    expect(await labelHeldByAnotherOwner(OTHER_OWNER, "myagent")).toBe(false)
    const { code } = await issue()
    // an open code of mine holds it against others, not against me
    expect(await labelHeldByAnotherOwner(OTHER_OWNER, "myagent")).toBe(true)
    expect(await labelHeldByAnotherOwner(OWNER, "myagent")).toBe(false)
    await redeemPairingCode({ code, agentId: AGENT })
    // now the pending agent row holds it
    expect(await labelHeldByAnotherOwner(OTHER_OWNER, "myagent")).toBe(true)
    expect(await labelHeldByAnotherOwner(OTHER_OWNER, "other")).toBe(false)
  })

  it("an expired code, a stale pending row and a retired row release the name", async () => {
    await issue({ ttlMs: -1 })
    expect(await labelHeldByAnotherOwner(OTHER_OWNER, "myagent")).toBe(false)

    const { code } = await issue({ label: "Stale", labelNorm: "stale" })
    await redeemPairingCode({ code, agentId: AGENT })
    await client.exec(`UPDATE agents SET created_at = now() - interval '25 hours' WHERE agent_id = '${AGENT}';`)
    expect(await labelHeldByAnotherOwner(OTHER_OWNER, "stale")).toBe(false)
    expect(await ownerHasAgentNamed(OWNER, "stale")).toBe(false)

    const again = await issuePairingCode({ ownerId: OTHER_OWNER, label: "Gone", labelNorm: "gone" })
    await redeemPairingCode({ code: again.code, agentId: OTHER_AGENT })
    await client.exec(`UPDATE agents SET status = 'retired', activated_at = now(), retired_at = now() WHERE agent_id = '${OTHER_AGENT}';`)
    expect(await labelHeldByAnotherOwner(OWNER, "gone")).toBe(false)
  })

  it("an active or suspended agent holds its name however old", async () => {
    const { code } = await issue()
    await redeemPairingCode({ code, agentId: AGENT })
    await client.exec(
      `UPDATE agents SET status = 'suspended', activated_at = now(), suspended_at = now(), created_at = now() - interval '30 days' WHERE agent_id = '${AGENT}';`,
    )
    expect(await labelHeldByAnotherOwner(OTHER_OWNER, "myagent")).toBe(true)
    expect(await ownerHasAgentNamed(OWNER, "myagent")).toBe(true)
  })
})

describe("heartbeat", () => {
  it("records last seen + the cycle for a paired agent; false for a stranger", async () => {
    const { code } = await issue()
    await redeemPairingCode({ code, agentId: AGENT })
    expect(await recordHeartbeat(AGENT, { wouldClaim: [99] })).toBe(true)
    const row = await findAgentByAgentId(AGENT)
    expect(row?.lastSeenAt).not.toBeNull()
    expect(row?.lastCycle).toEqual({ wouldClaim: [99] })
    expect(await recordHeartbeat(AGENT2, {})).toBe(false)
  })
})

describe("schema invariants the DB enforces", () => {
  it("a redeemed_at without redeemed_by (or vice versa) is unrepresentable", async () => {
    const { code } = await issue()
    await expect(client.exec(`UPDATE pairing_codes SET redeemed_at = now() WHERE code = '${code}';`)).rejects.toThrow()
  })

  it("an active or suspended row must carry activated_at; a pending row must not; a retired row may be either", async () => {
    const { code } = await issue()
    await redeemPairingCode({ code, agentId: AGENT })
    await expect(client.exec(`UPDATE agents SET status = 'active' WHERE agent_id = '${AGENT}';`)).rejects.toThrow()
    await expect(client.exec(`UPDATE agents SET status = 'suspended' WHERE agent_id = '${AGENT}';`)).rejects.toThrow()
    await expect(client.exec(`UPDATE agents SET activated_at = now() WHERE agent_id = '${AGENT}';`)).rejects.toThrow()
    await client.exec(`UPDATE agents SET status = 'retired', retired_at = now() WHERE agent_id = '${AGENT}';`)
    await client.exec(`UPDATE agents SET activated_at = now() WHERE agent_id = '${AGENT}';`)
  })

  it("markManifestIssued stamps a pending row only — an active one, or someone else's, is refused", async () => {
    const { code } = await issue()
    const r = await redeemPairingCode({ code, agentId: AGENT })
    if (r.outcome !== "paired") throw new Error("setup")
    expect(await markManifestIssued(r.agent.id, OTHER_OWNER, "myagent")).toBe(false)
    // 🔴 bounded on the name the manifest embeds: a manifest for a name the row no longer has is never stamped
    expect(await markManifestIssued(r.agent.id, OWNER, "oldname")).toBe(false)
    expect(await markManifestIssued(r.agent.id, OWNER, "myagent")).toBe(true)
    expect((await findAgentByAgentId(AGENT))?.manifestIssuedAt).not.toBeNull()
    await client.exec(`UPDATE agents SET status = 'active', activated_at = now() WHERE agent_id = '${AGENT}';`)
    expect(await markManifestIssued(r.agent.id, OWNER, "myagent")).toBe(false)
  })

  it("one key, one owner: a second row for the same agent account is refused by the unique index", async () => {
    const { code } = await issue()
    await redeemPairingCode({ code, agentId: AGENT })
    await expect(
      client.exec(
        `INSERT INTO agents (owner_id, agent_id, label, label_norm, float_xrd, rules) VALUES ('${AGENT2}', '${AGENT}', 'x', 'x', 200, '{}');`,
      ),
    ).rejects.toThrow()
  })
})
