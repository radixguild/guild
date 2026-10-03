/**
 * "Has this agent been funded?" (src/lib/agent-funding.ts) — the decision, with
 * the Gateway doubled. Both halves must hold: the float AND the badge reached
 * the agent's account. Unknown is never "no" and never "yes".
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const G = vi.hoisted(() => ({
  readTxIntentStatus: vi.fn(),
  fetchTxBalanceChanges: vi.fn(),
  readNonFungibleHolder: vi.fn(),
  readFungibleVaultTotal: vi.fn(),
}))
vi.mock("@/lib/gateway", () => G)

import { readFundingState, readNameOnChain, verifyFundingTx } from "@/lib/agent-funding"
import { BADGE_NFT } from "@/lib/config"
import { XRD_ADDRESS } from "@/lib/radix"

const AGENT = "account_rdx1299rtllydz2vz6rrs4zafu2htkndwm2g5ksd27rrw9mhrechcm7tlr"
const OWNER = "account_rdx12y5senkxfxg38swfv4tg88lx73jqnkdvcnzv8kwwdmg0efl40r2p7u"
const STRANGER = "account_rdx128k4ew7te5n3aetfkraejs90eunx8zs4uuwlh90ayq3w8uratgkqt8"
const TX = "txid_rdx1funding00000000000000000000000000000000000000000000000"
const BADGE = "<guild_member_myagent>"
const args = { agentAccount: AGENT, labelNorm: "myagent", floatXrd: "200.000000000000000000", intentHash: TX }

const goodTx = () => ({
  status: "CommittedSuccess",
  fungible: [
    { entity: OWNER, resource: XRD_ADDRESS, change: "-200" },
    { entity: AGENT, resource: XRD_ADDRESS, change: "200" },
  ],
  nonFungible: [{ entity: AGENT, resource: BADGE_NFT, added: [BADGE], removed: [] }],
})

beforeEach(() => {
  for (const f of Object.values(G)) f.mockReset()
  G.readTxIntentStatus.mockResolvedValue("CommittedSuccess")
  G.fetchTxBalanceChanges.mockResolvedValue(goodTx())
})

describe("verifyFundingTx — by the committed transaction", () => {
  it("funded when the float AND the badge reached the agent; carries the intent hash for pair_tx", async () => {
    expect(await verifyFundingTx(args)).toEqual({ funded: true, via: "tx", intentHash: TX, badgeId: BADGE })
  })

  it.each([
    ["Pending", "tx_pending"],
    ["CommitPendingOutcomeUnknown", "tx_pending"],
    ["Unknown", "tx_pending"],
    // "likely but not certain": it may still commit — never tell the owner to fund again
    ["LikelyButNotCertainRejection", "tx_pending"],
    ["CommittedFailure", "tx_failed"],
    ["PermanentlyRejected", "tx_failed"],
  ])("status %s → %s (nothing is read further)", async (status, gap) => {
    G.readTxIntentStatus.mockResolvedValue(status)
    expect(await verifyFundingTx(args)).toEqual({ funded: false, gap })
    expect(G.fetchTxBalanceChanges).not.toHaveBeenCalled()
  })

  it("🔴 less than the float to the agent → float_short (199.999… is not 200)", async () => {
    const tx = goodTx()
    tx.fungible[1].change = "199.999999999999999999"
    G.fetchTxBalanceChanges.mockResolvedValue(tx)
    expect(await verifyFundingTx(args)).toEqual({ funded: false, gap: "float_short" })
  })

  it("🔴 XRD to a DIFFERENT account does not count, however much", async () => {
    const tx = goodTx()
    tx.fungible[1].entity = STRANGER
    tx.fungible[1].change = "5000"
    G.fetchTxBalanceChanges.mockResolvedValue(tx)
    expect(await verifyFundingTx(args)).toEqual({ funded: false, gap: "float_short" })
  })

  it("🔴 the badge must be THIS name, THIS resource, into THIS account", async () => {
    for (const bad of [
      { entity: STRANGER, resource: BADGE_NFT, added: [BADGE], removed: [] },
      { entity: AGENT, resource: "resource_rdx1other0000000000000000000000000000000000000000000000", added: [BADGE], removed: [] },
      { entity: AGENT, resource: BADGE_NFT, added: ["<guild_member_other>"], removed: [] },
      { entity: AGENT, resource: BADGE_NFT, added: [], removed: [BADGE] },
    ]) {
      G.fetchTxBalanceChanges.mockResolvedValue({ ...goodTx(), nonFungible: [bad] })
      expect(await verifyFundingTx(args)).toEqual({ funded: false, gap: "badge_missing" })
    }
  })

  it("🔴 an unreadable Gateway is UNKNOWN (null) — never 'not funded', never 'funded'", async () => {
    G.readTxIntentStatus.mockResolvedValue(null)
    expect(await verifyFundingTx(args)).toBeNull()
    G.readTxIntentStatus.mockResolvedValue("CommittedSuccess")
    G.fetchTxBalanceChanges.mockResolvedValue(null)
    expect(await verifyFundingTx(args)).toBeNull()
    // the two endpoints disagreeing is also unknown
    G.fetchTxBalanceChanges.mockResolvedValue({ ...goodTx(), status: "Pending" })
    expect(await verifyFundingTx(args)).toBeNull()
    // a non-decimal amount from the Gateway is unknown, not zero
    const tx = goodTx()
    tx.fungible[1].change = "undefined"
    G.fetchTxBalanceChanges.mockResolvedValue(tx)
    expect(await verifyFundingTx(args)).toBeNull()
  })
})

describe("readFundingState — by where the badge is now, and the agent's balance", () => {
  const state = { agentAccount: AGENT, labelNorm: "myagent", floatXrd: "200" }

  it("funded when the badge is in the agent's account and it holds at least the float", async () => {
    G.readNonFungibleHolder.mockResolvedValue({ minted: true, burned: false, holder: AGENT })
    G.readFungibleVaultTotal.mockResolvedValue({ total: "200.5", complete: true })
    expect(await readFundingState(state)).toEqual({ funded: true, via: "state", badgeId: BADGE })
    expect(G.readNonFungibleHolder).toHaveBeenCalledWith(BADGE_NFT, BADGE)
    expect(G.readFungibleVaultTotal).toHaveBeenCalledWith(AGENT, XRD_ADDRESS)
  })

  it("never minted → not_minted; minted to someone else (or burned) → badge_elsewhere", async () => {
    G.readNonFungibleHolder.mockResolvedValue({ minted: false })
    expect(await readFundingState(state)).toEqual({ funded: false, gap: "not_minted" })
    G.readNonFungibleHolder.mockResolvedValue({ minted: true, burned: false, holder: STRANGER })
    expect(await readFundingState(state)).toEqual({ funded: false, gap: "badge_elsewhere" })
    G.readNonFungibleHolder.mockResolvedValue({ minted: true, burned: true, holder: AGENT })
    expect(await readFundingState(state)).toEqual({ funded: false, gap: "badge_elsewhere" })
    expect(G.readFungibleVaultTotal).not.toHaveBeenCalled()
  })

  it("🔴 badge here but balance below the float: float_short only on a COMPLETE vault list — a partial one is unknown", async () => {
    G.readNonFungibleHolder.mockResolvedValue({ minted: true, burned: false, holder: AGENT })
    G.readFungibleVaultTotal.mockResolvedValue({ total: "150", complete: true })
    expect(await readFundingState(state)).toEqual({ funded: false, gap: "float_short" })
    G.readFungibleVaultTotal.mockResolvedValue({ total: "150", complete: false })
    expect(await readFundingState(state)).toBeNull()
  })

  it("🔴 a present, unburned badge with NO reported holder is unknown (null) — never 'elsewhere', which would release the row", async () => {
    G.readNonFungibleHolder.mockResolvedValue({ minted: true, burned: false, holder: null })
    expect(await readFundingState(state)).toBeNull()
    expect(G.readFungibleVaultTotal).not.toHaveBeenCalled()
  })

  it("🔴 either read failing is unknown (null)", async () => {
    G.readNonFungibleHolder.mockResolvedValue(null)
    expect(await readFundingState(state)).toBeNull()
    G.readNonFungibleHolder.mockResolvedValue({ minted: true, burned: false, holder: AGENT })
    G.readFungibleVaultTotal.mockResolvedValue(null)
    expect(await readFundingState(state)).toBeNull()
  })
})

describe("readNameOnChain — the ONE place a Gateway answer about a name becomes a verdict", () => {
  it.each([
    ["the Gateway could not be asked", null, "unknown"],
    ["never minted (the id is omitted)", { minted: false }, "free"],
    ["minted into this agent's account", { minted: true, burned: false, holder: AGENT }, "this_agent"],
    ["minted into another account", { minted: true, burned: false, holder: STRANGER }, "elsewhere"],
    ["burned", { minted: true, burned: true, holder: null }, "elsewhere"],
    ["🔴 minted, holder NOT reported", { minted: true, burned: false, holder: null }, "unknown"],
  ] as const)("%s → %s", async (_why, gateway, verdict) => {
    G.readNonFungibleHolder.mockResolvedValue(gateway)
    expect(await readNameOnChain("myagent", AGENT)).toBe(verdict)
    expect(G.readNonFungibleHolder).toHaveBeenCalledWith(BADGE_NFT, BADGE)
  })
})

