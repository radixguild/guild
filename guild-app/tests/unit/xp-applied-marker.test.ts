/**
 * Regression test for the XP faucet's applied-marker (scripts/xp-batch-signer.js).
 *
 * THE BUG: bot/services/xp.js (deleted in the bot/ decommission, recoverable
 * from git history at df77bff, the commit before that removal) exported
 * markXpApplied — the sole writer of the 'applied' status — and NOTHING in
 * the repo called it. The queue is summed by
 * pending status and the signer writes `currentXp + pendingXp` read live off
 * the badge, so with nothing ever flipping rows to 'applied' every run re-paid
 * the whole queue on top of the total the previous run had just raised. Not a
 * one-off double-credit: it compounds per run. (The route the pre-guild-saas
 * signer used, POST /api/xp/mark-applied, was never carried into this repo.)
 *
 * This file pins the CALLER — the half that was missing. The SQL semantics of
 * the marker itself used to be pinned separately in bot/tests/xp-applied.test.js,
 * which needed a real SQLite; that file was removed in the bot/ decommission
 * (recoverable from git history at df77bff, the commit before the removal) and
 * this file is now the only pin for the marker's behavior. guild-app sets
 * ignore-scripts=true, so better-sqlite3 has no native binding here (same
 * reason src/lib/game/migrate-helpers.ts exists) — this test works around that
 * rather than relying on a real SQLite.
 *
 * Note on placement: vitest collects tests/**\/*.test.ts only, and CI runs
 * vitest — a co-located or differently-suffixed file would silently never run.
 *
 * What this does NOT prove: nothing here touches a real ledger. The award leg
 * is a stub; only the bookkeeping around it is exercised. Whether update_xp
 * lands the value we computed is a chain question, unverified by this file.
 */
import { describe, it, expect, beforeEach } from "vitest"
import { createRequire } from "node:module"
import path from "node:path"
import { privateInputs } from "../support/private-input"

const require_ = createRequire(import.meta.url)
const SIGNER = path.resolve(__dirname, "../../../scripts/xp-batch-signer.js")

// scripts/xp-batch-signer.js stays EXCLUDE at the open-source flip (repo-root
// scripts/ is not shipped — only guild-app's canonical copies of a few of
// them are), so this whole file skips in the public export and still runs
// (throwing if the input vanishes for any other reason) in the private tree.
const PRIV = privateInputs("scripts/xp-batch-signer.js")

const ADDR = "account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw"
const BADGE_NFT = "resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl"
const NF_ID = "<guild_member_test>"
const ON_CHAIN_XP = 70

type QueueEntry = { address: string; pendingXp: number; throughId: number }
type Mark = { address: string; throughId: number | null }

describe.skipIf(PRIV.skip)("xp-batch-signer — an award must close out what it paid", () => {
  let awarded: number[]
  let marks: Mark[]
  let queueAuth: (string | undefined)[]

  /** Bot API + gateway stub. Records every mark-applied POST. */
  function stubFetch(opts: { queue: QueueEntry[]; markFails?: boolean; queueStatus?: number }) {
    return async (input: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      const reply = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data })

      if (input.endsWith("/api/xp-queue")) {
        queueAuth.push((init?.headers as Record<string, string> | undefined)?.Authorization)
        if (opts.queueStatus) return { ok: false, status: opts.queueStatus, json: async () => ({ ok: false }) }
        return reply({ ok: true, data: opts.queue })
      }

      if (input.endsWith("/api/xp/mark-applied")) {
        if (opts.markFails) return reply({ ok: false, error: "boom" }, false)
        marks.push({ address: body.address, throughId: body.throughId })
        return reply({ ok: true, data: { address: body.address, marked: 1, xp: 0 } })
      }

      if (input.endsWith("/state/entity/details")) {
        return reply({
          items: [{
            non_fungible_resources: {
              items: [{ resource_address: BADGE_NFT, vaults: { items: [{ items: [NF_ID] }] } }],
            },
          }],
        })
      }

      if (input.endsWith("/state/non-fungible/data")) {
        // Field 6 is xp — the value pendingXp gets added to.
        const fields = Array.from({ length: 7 }, (_, i) => ({ value: i === 6 ? String(ON_CHAIN_XP) : "x" }))
        return reply({ non_fungible_ids: [{ data: { programmatic_json: { fields } } }] })
      }

      throw new Error("unexpected fetch: " + input)
    }
  }

  /** Stub signer; `commit` decides whether the award actually lands. */
  const signer = (commit: boolean) => ({
    signAndSubmit: async (manifest: string) => {
      awarded.push(Number(manifest.match(/"update_xp"[\s\S]*?(\d+)u64/)![1]))
      return { intentHash: "txid_rdx1stub" }
    },
    waitForCommit: async () => ({ success: commit }),
  })

  beforeEach(() => {
    awarded = []
    marks = []
    queueAuth = []
    process.env.BOT_API_URL = "http://bot.test"
    process.env.RADIX_ACCOUNT_ADDRESS = "account_rdx1signer"
    delete process.env.XP_SIGNER_KEY
    delete require_.cache[require_.resolve(SIGNER)]
  })

  it("marks applied after a committed award, bounded by the throughId it was handed", async () => {
    const { main } = require_(SIGNER)
    const queue = [{ address: ADDR, pendingXp: 400, throughId: 22 }]

    const result = await main({ fetch: stubFetch({ queue }), signer: signer(true) })

    expect(awarded).toEqual([ON_CHAIN_XP + 400])

    // THE REGRESSION: marks was [] — those 400 XP stayed pending, so the next
    // run wrote 470 + 400 = 870, the one after 1270, and so on.
    expect(marks).toEqual([{ address: ADDR, throughId: 22 }])
    expect(result).toEqual({ awarded: 1, unmarked: 0 })
  })

  it("passes throughId through, so a reward queued mid-run is not written off unpaid", async () => {
    const { main } = require_(SIGNER)
    const queue = [{ address: ADDR, pendingXp: 400, throughId: 22 }]

    await main({ fetch: stubFetch({ queue }), signer: signer(true) })

    // Not a blanket "mark everything for this address" — the bound is what the
    // signer summed and paid. (bot/tests/xp-applied.test.js used to pin the
    // SQL side; removed in the bot/ decommission, see the file header.)
    expect(marks[0].throughId).toBe(22)
  })

  it("still marks against a bot whose queue has no throughId — the live prod pairing", async () => {
    // pm2 guild-bot runs guild-public's older bot (R1 §Prod context), whose
    // getXpQueue predates throughId and whose route reads only `address`. That
    // is the pairing this signer actually runs against today, so it must not
    // depend on the bound existing — it degrades to "close everything pending",
    // which is the old behaviour and still stops the re-pay.
    const { main } = require_(SIGNER)
    const queue = [{ address: ADDR, pendingXp: 400 }] as unknown as QueueEntry[]

    const result = await main({ fetch: stubFetch({ queue }), signer: signer(true) })

    expect(marks).toHaveLength(1)
    expect(marks[0].address).toBe(ADDR)
    expect(marks[0].throughId).toBeUndefined()
    expect(result).toEqual({ awarded: 1, unmarked: 0 })
  })

  it("does NOT mark when the award never committed — the XP is still owed", async () => {
    const { main } = require_(SIGNER)
    const queue = [{ address: ADDR, pendingXp: 400, throughId: 22 }]

    const result = await main({ fetch: stubFetch({ queue }), signer: signer(false) })

    expect(marks).toEqual([])
    expect(result).toEqual({ awarded: 0, unmarked: 0 })
  })

  it("reports a failed mark as a failed run — paid-but-still-pending must not look clean", async () => {
    const { main } = require_(SIGNER)
    const queue = [{ address: ADDR, pendingXp: 400, throughId: 22 }]

    const result = await main({ fetch: stubFetch({ queue, markFails: true }), signer: signer(true) })

    // XP is on-chain AND still pending — the one state that re-credits. The run
    // has to surface it; the old code exited 0 with the queue silently unpaid.
    expect(result).toEqual({ awarded: 1, unmarked: 1 })
  })

  it("marks each awarded address, not just the last one", async () => {
    const { main } = require_(SIGNER)
    const other = "account_rdx1694ullvfs94thnzrl6dplw3mxw5dyalsdv978t74ycp6zwayecenw5"
    const queue = [
      { address: ADDR, pendingXp: 400, throughId: 22 },
      { address: other, pendingXp: 15, throughId: 19 },
    ]

    const result = await main({ fetch: stubFetch({ queue }), signer: signer(true) })

    expect(marks).toEqual([
      { address: ADDR, throughId: 22 },
      { address: other, throughId: 19 },
    ])
    expect(result).toEqual({ awarded: 2, unmarked: 0 })
  })

  it("sends the signer key when one is configured, so a non-loopback bot still accepts the mark", async () => {
    process.env.XP_SIGNER_KEY = "s3cret"
    const { main } = require_(SIGNER)
    const seen: (string | undefined)[] = []
    const base = stubFetch({ queue: [{ address: ADDR, pendingXp: 400, throughId: 22 }] })

    await main({
      fetch: async (input: string, init?: RequestInit) => {
        if (input.endsWith("/api/xp/mark-applied")) {
          seen.push((init?.headers as Record<string, string>)?.Authorization)
        }
        return base(input, init)
      },
      signer: signer(true),
    })

    expect(seen).toEqual(["Bearer s3cret"])
  })

  // guild-public#164 gated the queue read behind the signer key. The signer used
  // to send the key on mark-applied only, so it could close out awards it could
  // no longer see.
  it("sends the signer key on the queue read, not only on mark-applied", async () => {
    process.env.XP_SIGNER_KEY = "k-test"
    const { main } = require_(SIGNER)

    await main({ fetch: stubFetch({ queue: [] }), signer: signer(true) })

    expect(queueAuth).toEqual(["Bearer k-test"])
  })

  it("fails the run when the bot refuses the queue read — a missing key is not an empty queue", async () => {
    const { main } = require_(SIGNER)

    await expect(main({ fetch: stubFetch({ queue: [], queueStatus: 401 }), signer: signer(true) }))
      .rejects.toThrow(/XP_SIGNER_KEY/)
    expect(awarded).toEqual([])
  })
})
