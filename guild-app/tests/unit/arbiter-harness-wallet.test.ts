// arbiter-harness-wallet.test.ts — the two read/print modes added to
// arbiter-harness.mjs for an arbiter badge held in a PHONE wallet:
//
//   resolve --print-manifest  prints the manifest for the Radix Wallet's Send Raw
//                             Transaction, and only after a keyless preview of that
//                             exact text Succeeded;
//   disputes                  lists every Disputed task with its PINNED window.
//
// The Gateway is mocked at `fetch`: every route either answers from a fixture or
// throws, so these tests make no network call — an unexpected request fails the
// test instead of reaching mainnet.
//
// What --print-manifest must guarantee, each pinned below:
//   • no `lock_fee` — Send Raw adds and pays its own fee; a manifest that also
//     locks one double-pays or fails;
//   • the badge proof is created from the account the CHAIN names as holder;
//   • nothing is printed unless the preview Succeeded (REVERTED, INCONCLUSIVE and
//     a non-Disputed task are all refusals with no manifest in the result).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  assertWalletManifest,
  buildResolveManifest,
  disputeRow,
  listDisputes,
  prepareWalletResolve,
} from "../../scripts/arbiter-harness.mjs"

const COMPONENT = "component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly"
const KV = "internal_keyvaluestore_rdx1krtestwalletpathtasksxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
const ARBITER_BADGE = "resource_rdx1nf229dxvw72cqzrrkgqvn6zxxjmjpf3hx0zhulsfz4tka5kgnvakn3"
const HOLDER = "account_rdx12ynlx369jmpfg23n709g0w7fuk0wwe0lft6h5r0m8sksdjpg858g0z"
const OTHER = "account_rdx128lggtfnpqedz3vrjpxsq3w9zhwwpekklnm8vnzcfvp35cd8cx00gqmf"
const WORKER = "account_rdx12890803ct999t5ss4qatjyktay82gfy295rr6p4qmhks8twekeqgp9"
const POSTER = "account_rdx1283xglqdjv6w8jreccxwp7d0u55a8ejrkpegc3uunqedsyqt4mtg5q"
const XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"
const LOCAL_ID = "<arbiter_bigdev>"

// ── Gateway fixtures, shaped like the real answers ──────────────────────────
const someU64 = (field_name: string, value: string) => ({
  field_name, kind: "Enum", type_name: "Option", variant_id: "1", variant_name: "Some",
  fields: [{ kind: "U64", value }],
})
const someInstant = (field_name: string, secs: number) => ({
  field_name, kind: "Enum", type_name: "Option", variant_id: "1", variant_name: "Some",
  fields: [{ kind: "I64", type_name: "Instant", value: String(secs) }],
})
const someEnum = (field_name: string, type_name: string, variant: string) => ({
  field_name, kind: "Enum", type_name: "Option", variant_id: "1", variant_name: "Some",
  fields: [{ kind: "Enum", type_name, variant_id: "0", variant_name: variant, fields: [] }],
})
const someRef = (field_name: string, value: string) => ({
  field_name, kind: "Enum", type_name: "Option", variant_id: "1", variant_name: "Some",
  fields: [{ kind: "Reference", type_name: "ComponentAddress", value }],
})
const state = (variant: string) =>
  ({ field_name: "state", kind: "Enum", type_name: "TaskState", variant_name: variant, fields: [] })

/** A task's KV value fields. `pin` false = no pin fields at all (disputed before the pin shipped). */
function taskFields(
  variant: string,
  { disputedAt, raisedBy = "Worker", pinSecs, pinDefault = "SplitEvenly", pin = true, reward = "500" }:
    { disputedAt?: number; raisedBy?: string; pinSecs?: string; pinDefault?: string; pin?: boolean; reward?: string } = {},
) {
  const f: unknown[] = [
    { field_name: "poster", kind: "Reference", type_name: "ComponentAddress", value: POSTER },
    { field_name: "reward_token", kind: "Reference", type_name: "ResourceAddress", value: XRD },
    { field_name: "reward_amount", kind: "Decimal", value: reward },
    state(variant),
    someRef("worker_account", WORKER),
  ]
  if (disputedAt != null) {
    f.push(someInstant("disputed_at", disputedAt), someEnum("dispute_raised_by", "DisputeParty", raisedBy))
    if (pin && pinSecs != null) {
      f.push(someU64("dispute_auto_resolve_secs", pinSecs), someEnum("dispute_auto_resolve_default", "AutoResolveDefault", pinDefault))
    }
  }
  return f
}

interface Routes {
  holder?: string
  task?: unknown[] | null
  nextTaskId?: string
  liveSecs?: string
  entries?: Array<{ id: number; fields: unknown[] }>
  preview?: unknown
}

let calls: Array<{ path: string; body: any }> = []

function mockGateway(r: Routes) {
  calls = []
  const reply = (payload: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload), text: () => Promise.resolve(JSON.stringify(payload)) } as Response)
  vi.spyOn(globalThis, "fetch").mockImplementation((input: any, init?: any) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const path = new URL(url).pathname
    calls.push({ path, body })
    switch (path) {
      case "/state/entity/details":
        return reply({
          ledger_state: { state_version: 563000000, epoch: 200000 },
          items: [{ address: COMPONENT, details: { state: { fields: [
            { field_name: "arbiter_badge_resource", kind: "Reference", type_name: "ResourceAddress", value: ARBITER_BADGE },
            { field_name: "tasks", kind: "Own", type_name: "KeyValueStore", value: KV },
            { field_name: "next_task_id", kind: "U64", value: r.nextTaskId ?? "9" },
            { field_name: "dispute_auto_resolve_secs", kind: "U64", value: r.liveSecs ?? "604800" },
            { field_name: "dispute_auto_resolve_default", kind: "Enum", type_name: "AutoResolveDefault", variant_name: "SplitEvenly", fields: [] },
          ] } } }],
        })
      case "/state/non-fungible/ids":
        return reply({ non_fungible_ids: { items: [LOCAL_ID] } })
      case "/state/non-fungible/location":
        return reply({ non_fungible_ids: [
          { non_fungible_id: LOCAL_ID, is_burned: false, owning_vault_global_ancestor_address: r.holder ?? HOLDER },
        ] })
      case "/state/key-value-store/data": {
        if (r.entries) {
          const wanted = new Set(body.keys.map((k: any) => Number(k.key_json.value)))
          return reply({ entries: r.entries
            .filter((e) => wanted.has(e.id))
            .map((e) => ({ key: { programmatic_json: { kind: "U64", value: String(e.id) } }, value: { programmatic_json: { kind: "Tuple", type_name: "TaskInfo", fields: e.fields } } })) })
        }
        return reply({ entries: r.task === null ? [] : [{ value: { programmatic_json: { fields: r.task } } }] })
      }
      case "/status/gateway-status":
        return reply({ ledger_state: { epoch: 200000, state_version: 563000000 } })
      case "/transaction/preview":
        return reply(r.preview)
      default:
        return Promise.reject(new Error(`unmocked Gateway route ${path} — tests make no network calls`))
    }
  })
}

const SUCCEEDED = {
  receipt: {
    status: "Succeeded",
    fee_summary: { xrd_total_execution_cost: "0.41", xrd_total_finalization_cost: "0.05", xrd_total_storage_cost: "0.02" },
    events: [
      { type: { name: "TaskRefundedEvent" } },
      { type: { name: "DisputeResolvedEvent" } },
      { type: { name: "DepositEvent" } },
    ],
  },
  resource_changes: [],
}

beforeEach(() => {
  calls = []
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("resolve --print-manifest — the wallet path", () => {
  it("prints the previewed manifest: no lock_fee, proof from the CHAIN-named holder, fee, events, one instruction", async () => {
    mockGateway({ task: taskFields("Disputed", { disputedAt: 1791763200, pinSecs: "259200" }), preview: SUCCEEDED })
    const r = await prepareWalletResolve({
      taskId: 7, ruling: { kind: "RefundPoster" }, component: COMPONENT,
      now: () => new Date("2026-10-11T08:00:00Z"),
    })
    expect(r.ok).toBe(true)
    expect(r.verdict).toBe("PROVEN")
    expect(r.manifest).not.toMatch(/lock_fee/)
    expect(r.manifest).toMatch(new RegExp(`Address\\("${HOLDER}"\\)\\s+"create_proof_of_non_fungibles"`))
    expect(new Set(r.manifest.match(/account_rdx1[a-z0-9]+/g))).toEqual(new Set([HOLDER]))
    expect(r.manifest).toContain('"resolve_dispute"')
    expect(r.manifest).toContain("7u64")
    expect(r.manifest).toContain("Enum<1u8>()")
    // The text the operator copies: readout, manifest, the one line of what to do.
    expect(r.text).toContain("status   Succeeded")
    expect(r.text).toMatch(/fee\s+~0\.480000 XRD/)
    expect(r.text).toContain("TaskRefundedEvent → DisputeResolvedEvent")
    expect(r.text).toContain(r.manifest)
    expect(r.text).toContain(`Radix Wallet → Send Raw Transaction, connect ${HOLDER}, paste`)
    expect(r.text).not.toMatch(/lock_fee\s*"?\s*\n/)
    // What was previewed is byte-for-byte what is printed — and the preview is keyless.
    const previews = calls.filter((c) => c.path === "/transaction/preview")
    expect(previews).toHaveLength(1)
    expect(previews[0].body.manifest).toBe(r.manifest)
    expect(previews[0].body.signer_public_keys).toEqual([])
    expect(previews[0].body.flags.assume_all_signature_proofs).toBe(true)
  })

  it("takes the proof account from the chain, not from anything the caller typed", async () => {
    mockGateway({ holder: OTHER, task: taskFields("Disputed", { disputedAt: 1791763200, pinSecs: "604800" }), preview: SUCCEEDED })
    const r = await prepareWalletResolve({ taskId: 7, ruling: { kind: "PayWorker" }, component: COMPONENT })
    expect(r.ok).toBe(true)
    expect(r.holderAccount).toBe(OTHER)
    expect(r.manifest).toMatch(new RegExp(`Address\\("${OTHER}"\\)\\s+"create_proof_of_non_fungibles"`))
    expect(r.manifest).not.toContain(HOLDER)
    expect(r.text).toContain(`connect ${OTHER}`)
  })

  it("prints NOTHING when the preview reverts", async () => {
    mockGateway({
      task: taskFields("Disputed", { disputedAt: 1791763200, pinSecs: "604800" }),
      preview: { receipt: { status: "Failed", error_message: "ApplicationError(PanicMessage(\"arbiter is a party\"))" } },
    })
    const r = await prepareWalletResolve({ taskId: 7, ruling: { kind: "PayWorker" }, component: COMPONENT })
    expect(r.ok).toBe(false)
    expect(r.verdict).toBe("REVERTED")
    expect(r.reason).toContain("arbiter is a party")
    expect(r).not.toHaveProperty("manifest")
    expect(r).not.toHaveProperty("text")
  })

  it("prints NOTHING when the preview gives no verdict (INCONCLUSIVE)", async () => {
    mockGateway({ task: taskFields("Disputed", { disputedAt: 1791763200, pinSecs: "604800" }), preview: { message: "upstream timeout" } })
    const r = await prepareWalletResolve({ taskId: 7, ruling: { kind: "PayWorker" }, component: COMPONENT })
    expect(r.ok).toBe(false)
    expect(r.verdict).toBe("INCONCLUSIVE")
    expect(r).not.toHaveProperty("manifest")
  })

  it("refuses before previewing when the task is not Disputed on chain", async () => {
    mockGateway({ task: taskFields("Released"), preview: SUCCEEDED })
    const r = await prepareWalletResolve({ taskId: 7, ruling: { kind: "PayWorker" }, component: COMPONENT })
    expect(r.ok).toBe(false)
    expect(r.verdict).toBe("REFUSED")
    expect(r.reason).toMatch(/Released on-chain, not Disputed/)
    expect(r).not.toHaveProperty("manifest")
    expect(calls.some((c) => c.path === "/transaction/preview")).toBe(false)
  })

  it("refuses when the task cannot be read", async () => {
    mockGateway({ task: null, preview: SUCCEEDED })
    const r = await prepareWalletResolve({ taskId: 7, ruling: { kind: "PayWorker" }, component: COMPONENT })
    expect(r.ok).toBe(false)
    expect(r.verdict).toBe("REFUSED")
    expect(calls.some((c) => c.path === "/transaction/preview")).toBe(false)
  })
})

describe("assertWalletManifest — the tripwire on what reaches Send Raw", () => {
  const built = buildResolveManifest(
    { arbiterBadgeResource: ARBITER_BADGE, arbiterBadgeLocalId: LOCAL_ID, arbiterAccount: HOLDER },
    { component: COMPONENT, taskId: 3, ruling: { kind: "PayWorker" } },
  )

  it("passes the builder's own output unchanged", () => {
    expect(assertWalletManifest(built, HOLDER)).toBe(built)
  })

  it("refuses a manifest carrying lock_fee — it does not strip it silently", () => {
    const withFee = `CALL_METHOD\n  Address("${HOLDER}")\n  "lock_fee"\n  Decimal("2")\n;\n\n` + built
    expect(() => assertWalletManifest(withFee, HOLDER)).toThrow(/lock_fee/)
  })

  it("refuses a proof from any account but the holder", () => {
    expect(() => assertWalletManifest(built, OTHER)).toThrow(/not the chain-derived holder/)
  })

  it("refuses a manifest that names a second account anywhere", () => {
    const routed = built + `\nCALL_METHOD\n  Address("${WORKER}")\n  "try_deposit_or_abort"\n;`
    expect(() => assertWalletManifest(routed, HOLDER)).toThrow(new RegExp(WORKER))
  })
})

describe("disputes — every Disputed task with its PINNED window", () => {
  const NOW = Date.parse("2026-10-11T12:00:00Z")
  const H = 3600

  it("lists only Disputed tasks, pinned window first, live value only for a task with no pin; soonest first", async () => {
    mockGateway({
      nextTaskId: "5",
      entries: [
        { id: 1, fields: taskFields("Released") },
        // Raised 60h ago under the OLD 72h window → 12h left, though the live value is 7 days.
        { id: 2, fields: taskFields("Disputed", { disputedAt: NOW / 1000 - 60 * H, pinSecs: "259200", reward: "500" }) },
        // Raised 1h ago under the 7-day window.
        { id: 3, fields: taskFields("Disputed", { disputedAt: NOW / 1000 - 1 * H, pinSecs: "604800", raisedBy: "Poster", reward: "80" }) },
        // Disputed before the pin shipped: no pin fields → the chain itself falls back to the live value.
        { id: 4, fields: taskFields("Disputed", { disputedAt: NOW / 1000 - 200 * H, pin: false }) },
      ],
    })
    const out = await listDisputes({ component: COMPONENT, nowMs: NOW })
    expect(out.scanned).toBe(4)
    expect(out.liveWindowSecs).toBe(604800)
    expect(out.unreadable).toEqual([])
    expect(out.missing).toEqual([])
    expect(out.rows.map((r: { taskId: number }) => r.taskId)).toEqual([4, 2, 3])

    const [t4, t2, t3] = out.rows
    expect(t2).toMatchObject({
      reward: "500", rewardToken: XRD, raisedBy: "worker", raiserAccount: WORKER,
      windowSecs: 259200, windowSource: "pinned", defaultRuling: "SplitEvenly", defaultSource: "pinned",
      disputedAt: new Date(NOW - 60 * H * 1000).toISOString(),
      endsAt: new Date(NOW + 12 * H * 1000).toISOString(),
      remaining: "12h left",
    })
    expect(t3).toMatchObject({ raisedBy: "poster", raiserAccount: POSTER, windowSecs: 604800, remaining: "6d 23h left" })
    expect(t4).toMatchObject({ windowSecs: 604800, windowSource: "live (task has no pin)", defaultSource: "live (task has no pin)" })
    expect(t4.remaining).toMatch(/^LAPSED 1d 8h ago/)

    // One consistent snapshot: every KV read pinned to the entity read's state_version.
    const kvReads = calls.filter((c) => c.path === "/state/key-value-store/data")
    expect(kvReads).toHaveLength(1)
    expect(kvReads[0].body.at_ledger_state).toEqual({ state_version: 563000000 })
    expect(kvReads[0].body.keys.map((k: any) => k.key_json.value)).toEqual(["1", "2", "3", "4"])
  })

  it("batches the KV reads at 100 keys and reports ids it could not see", async () => {
    mockGateway({
      nextTaskId: "151",
      entries: [
        ...Array.from({ length: 148 }, (_, i) => ({ id: i + 1, fields: taskFields("Released") })),
        { id: 149, fields: [{ field_name: "state", variant_name: "NotAState" }] },
        // 150 has no entry at all.
      ],
    })
    const out = await listDisputes({ component: COMPONENT, nowMs: NOW })
    const kvReads = calls.filter((c) => c.path === "/state/key-value-store/data")
    expect(kvReads.map((c) => c.body.keys.length)).toEqual([100, 50])
    expect(out.rows).toEqual([])
    expect(out.unreadable).toEqual([149])
    expect(out.missing).toEqual([150])
  })

  it("a pin that is present but unreadable is UNKNOWN — never replaced by the live value", () => {
    const info = {
      state: "Disputed", disputedAt: new Date(NOW - H * 1000), disputeRaisedBy: "worker",
      disputeAutoResolveSecs: null, disputeAutoResolveDefault: null,
      workerAccount: WORKER, posterAccount: POSTER, rewardAmount: "10", rewardToken: XRD,
    }
    const cfg = { liveWindowSecs: 604800, liveDefault: "SplitEvenly" }
    const unknown = disputeRow(9, info, cfg, { pinFieldPresent: true }, NOW)
    expect(unknown.windowSecs).toBeNull()
    expect(unknown.windowSource).toBe("UNKNOWN")
    expect(unknown.remaining).toMatch(/^UNKNOWN/)
    const fallback = disputeRow(9, info, cfg, { pinFieldPresent: false }, NOW)
    expect(fallback.windowSecs).toBe(604800)
  })
})
