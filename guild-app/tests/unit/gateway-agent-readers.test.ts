/**
 * The Gateway readers Bring Your Agent's funding check stands on
 * (src/lib/gateway.ts): tx status, balance changes (fungible AND non-fungible),
 * where a non-fungible is, and an exact fungible total. Response shapes are the
 * ones read off mainnet on 2026-09-24. Every reader answers null — "unknown" —
 * on transport failure, a non-2xx, or a shape it does not recognise.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  fetchTxBalanceChanges,
  fetchTxFungibleChanges,
  readFungibleVaultTotal,
  readNonFungibleHolder,
  readTxIntentStatus,
} from "@/lib/gateway"
import { GATEWAY } from "@/lib/constants"

const XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"
const BADGE = "resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl"
const AGENT = "account_rdx1299rtllydz2vz6rrs4zafu2htkndwm2g5ksd27rrw9mhrechcm7tlr"
const TX = "txid_rdx1funding00000000000000000000000000000000000000000000000"

let fetchSpy: ReturnType<typeof vi.spyOn>
const ok = (body: unknown) => ({ ok: true, json: () => Promise.resolve(body) }) as Response
const notOk = () => ({ ok: false, json: () => Promise.resolve({}) }) as Response

beforeEach(() => {
  fetchSpy = vi.spyOn(global, "fetch")
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe("readTxIntentStatus", () => {
  it("returns the Gateway's intent_status", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ status: "CommittedSuccess", intent_status: "CommittedSuccess" }))
    expect(await readTxIntentStatus(TX)).toBe("CommittedSuccess")
    expect(fetchSpy.mock.calls[0][0]).toBe(`${GATEWAY}/transaction/status`)
    expect(JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body))).toEqual({ intent_hash: TX })
  })
  it("null on non-2xx, a throw, or no intent_status", async () => {
    fetchSpy.mockResolvedValueOnce(notOk())
    expect(await readTxIntentStatus(TX)).toBeNull()
    fetchSpy.mockRejectedValueOnce(new Error("down"))
    expect(await readTxIntentStatus(TX)).toBeNull()
    fetchSpy.mockResolvedValueOnce(ok({ status: "CommittedSuccess" }))
    expect(await readTxIntentStatus(TX)).toBeNull()
  })
})

describe("fetchTxBalanceChanges — both kinds of change", () => {
  const body = {
    transaction: {
      transaction_status: "CommittedSuccess",
      balance_changes: {
        fungible_fee_balance_changes: [],
        fungible_balance_changes: [{ entity_address: AGENT, resource_address: XRD, balance_change: "200" }],
        non_fungible_balance_changes: [
          { entity_address: AGENT, resource_address: BADGE, added: ["<guild_member_myagent>", 7], removed: [] },
        ],
      },
    },
  }

  it("maps the mainnet shape; drops a non-string id rather than trusting it", async () => {
    fetchSpy.mockResolvedValueOnce(ok(body))
    expect(await fetchTxBalanceChanges(TX)).toEqual({
      status: "CommittedSuccess",
      fungible: [{ entity: AGENT, resource: XRD, change: "200" }],
      nonFungible: [{ entity: AGENT, resource: BADGE, added: ["<guild_member_myagent>"], removed: [] }],
    })
    const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body))
    expect(sent).toEqual({ intent_hash: TX, opt_ins: { balance_changes: true } })
  })

  it("fetchTxFungibleChanges is the fungible half of the same read (the x402 facilitator's contract is unchanged)", async () => {
    fetchSpy.mockResolvedValueOnce(ok(body))
    expect(await fetchTxFungibleChanges(TX)).toEqual({
      status: "CommittedSuccess",
      changes: [{ entity: AGENT, resource: XRD, change: "200" }],
    })
  })

  it("missing sections read as empty; transport failure / non-2xx as null", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ transaction: { transaction_status: "CommittedSuccess" } }))
    expect(await fetchTxBalanceChanges(TX)).toEqual({ status: "CommittedSuccess", fungible: [], nonFungible: [] })
    fetchSpy.mockResolvedValueOnce(notOk())
    expect(await fetchTxBalanceChanges(TX)).toBeNull()
    fetchSpy.mockRejectedValueOnce(new Error("down"))
    expect(await fetchTxBalanceChanges(TX)).toBeNull()
  })
})

describe("readNonFungibleHolder", () => {
  it("an OMITTED id is a confirmed 'never minted' (the Gateway's answer for a free name)", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ non_fungible_ids: [] }))
    expect(await readNonFungibleHolder(BADGE, "<guild_member_free>")).toEqual({ minted: false })
    expect(fetchSpy.mock.calls[0][0]).toBe(`${GATEWAY}/state/non-fungible/location`)
  })
  it("a present id reports its holder (the owning vault's global ancestor) and burned-ness", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({
        non_fungible_ids: [
          { non_fungible_id: "<guild_member_myagent>", owning_vault_global_ancestor_address: AGENT, is_burned: false },
        ],
      }),
    )
    expect(await readNonFungibleHolder(BADGE, "<guild_member_myagent>")).toEqual({ minted: true, burned: false, holder: AGENT })
  })
  it("null on non-2xx, a throw, or a shape without the id list", async () => {
    fetchSpy.mockResolvedValueOnce(notOk())
    expect(await readNonFungibleHolder(BADGE, "<x>")).toBeNull()
    fetchSpy.mockRejectedValueOnce(new Error("down"))
    expect(await readNonFungibleHolder(BADGE, "<x>")).toBeNull()
    fetchSpy.mockResolvedValueOnce(ok({ items: [] }))
    expect(await readNonFungibleHolder(BADGE, "<x>")).toBeNull()
  })
})

describe("readFungibleVaultTotal — exact, never a JS number", () => {
  it("sums vaults at 18 dp (0.1 + 0.2 is exactly 0.3) and flags a continued list as incomplete", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ items: [{ amount: "0.1" }, { amount: "0.2" }] }))
    expect(await readFungibleVaultTotal(AGENT, XRD)).toEqual({ total: "0.3", complete: true })
    fetchSpy.mockResolvedValueOnce(ok({ items: [{ amount: "5" }], next_cursor: "abc" }))
    expect(await readFungibleVaultTotal(AGENT, XRD)).toEqual({ total: "5", complete: false })
  })
  it("🔴 a non-decimal amount is unknown (null), not zero", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ items: [{ amount: "1e3" }] }))
    expect(await readFungibleVaultTotal(AGENT, XRD)).toBeNull()
  })
})
