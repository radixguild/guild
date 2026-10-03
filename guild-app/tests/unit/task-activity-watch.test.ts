/**
 * The chain-driven task pager — scripts/task-activity-watch.mjs and its
 * testable core, scripts/lib/task-activity.mjs (`main()` is the whole program).
 *
 * WHAT IS PINNED
 *  - every transition the escrow blueprint allows pages exactly once, as a
 *    push, with the fields the operator acts on (board + chain id, reward +
 *    insurance, badge, agent flag, worker …last8, the clock for that state);
 *  - several transitions between two runs arrive as ONE message naming them,
 *    and a re-claim by the SAME badge after an expiry is still two events;
 *  - review reminders: 24h and 2h once each; "lapsed" every run for 24h past
 *    the deadline, then every 6h, until the task leaves Submitted; a refused
 *    reminder is retried, never recorded as sent;
 *  - the first run seeds WITHOUT paging transitions — only a Submitted task's
 *    clock (the chain-14 case) is paged;
 *  - losing the state file is a loud RECOVERY from its backup; losing both is a
 *    loud re-seed; neither is ever silent once the pager has run before;
 *  - the state_version lock-up has a recovery that is not deletion
 *    (--accept-older-ledger);
 *  - a halted network still gets pinned reads, reminders and the blind-pager
 *    check;
 *  - "could not look" is never "nothing happened" (exit codes, no writes).
 *  The refuter's 17 mutants (PR #761 review) and this change's own are killed
 *  by named tests below; the mutation script lives outside the repo.
 *
 * 🔒 NO TEST HERE CAN SEND A REAL TELEGRAM. Three independent guards:
 *  1. the core module never imports the transport or reads KEEPER_ALERT_TG_*
 *     (source-scraped below) — every sender is injected, and main() under
 *     --dry-run is run with a sender that FAILS the test if it is touched;
 *  2. KEEPER_ALERT_TG_* are stubbed EMPTY for every test, so even a regression
 *     that reached src/lib/tg-alert.ts would no-op;
 *  3. global fetch is replaced by a trap that FAILS the test on any call — the
 *     core must use its injected fetch, so an escaped call is a bug, and one
 *     aimed at api.telegram.org can never leave the process.
 *  The subprocess tests run the real entry script with `bun --no-env-file` (so
 *  a developer's guild-app/.env.local cannot load a real token — the
 *  poster-env-preflight precedent), with KEEPER_ALERT_TG_* deleted, and with the
 *  Gateway pointed at a closed local port.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { execFile } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAlertEvaluator, MemoryAlertStore } from "@/lib/alert-core"
import { XRD_ADDRESS } from "@/lib/radix"
import { privateInputs } from "../support/private-input"

// scripts/lib/task-activity.mjs and scripts/task-activity-watch.mjs stay
// private at the open-source flip (not guild-app/scripts/** carve-outs) — the
// whole suite below skips in the public export and names the input; a missing
// input throws in the private tree (tests/support/private-input.ts).
const PRIV = privateInputs("guild-app/scripts/lib/task-activity.mjs", "guild-app/scripts/task-activity-watch.mjs")
const TASK_ACTIVITY_PATH = "../../scripts/lib/task-activity.mjs"
const taskActivityMod = PRIV.skip ? null : await import(TASK_ACTIVITY_PATH)
const {
  EXIT,
  HEALTH_ALERT,
  LAPSED_REPEAT,
  REVIEW_STAGES,
  TELEGRAM_MAX_CHARS,
  ChainReadError,
  UsageError,
  parseCliArgs,
  parseTaskEntry,
  readChainSnapshot,
  checkHaltVia,
  fetchBoardIds,
  loadState,
  inferEvents,
  memoFor,
  fitTelegram,
  runWatch,
  main,
  backupPathFor,
  readLastRun,
  LAST_RUN_KEY,
  DEFAULT_STATE_PATH,
  DEFAULT_HEALTH_PATH,
} = taskActivityMod ?? ({} as NonNullable<typeof taskActivityMod>)

// ── Hermetic guards ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubEnv("KEEPER_ALERT_TG_TOKEN", "")
  vi.stubEnv("KEEPER_ALERT_TG_CHAT", "")
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      throw new Error(`global fetch called (${String(url)}) — the pager must only use its injected fetch`)
    }),
  )
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const SCRIPT_DIR = join(process.cwd(), "scripts")

describe.skipIf(PRIV.skip)("hermetic by construction", () => {
  it("the core module never imports the Telegram transport and never reads its env", () => {
    const src = readFileSync(join(SCRIPT_DIR, "lib/task-activity.mjs"), "utf8")
    expect(src).not.toMatch(/from\s+["'][^"']*tg-alert["']/)
    expect(src).not.toContain("sendTelegramMessage")
    expect(src).not.toContain("api.telegram.org")
    expect(src).not.toMatch(/env\.KEEPER_ALERT_TG/)
  })

  it("the entry script hands the transport to main() once, and never calls it itself", () => {
    const src = readFileSync(join(SCRIPT_DIR, "task-activity-watch.mjs"), "utf8")
    expect(src.match(/sendTelegramMessage/g)).toHaveLength(2) // the import + `realSend: sendTelegramMessage`
    expect(src).toContain("realSend: sendTelegramMessage,")
    expect(src).not.toMatch(/sendTelegramMessage\(/)
  })

  it("the Gateway override is this pager's own variable — a harness RADIX_GATEWAY_URL in .env.local cannot move it", () => {
    const src = readFileSync(join(SCRIPT_DIR, "task-activity-watch.mjs"), "utf8")
    expect(src).toContain("gateway: process.env.GUILD_TASK_ACTIVITY_GATEWAY || GATEWAY,")
    expect(src).not.toMatch(/process\.env\.RADIX_GATEWAY_URL/)
  })
})

// ── Fixtures: a fake Gateway + board API with a mutable escrow ──────────────

const GW = "https://gateway.test"
const SITE = "https://guild.test"
// Deliberately not address-shaped: fixtures must never read as a real account.
const COMPONENT = "component_rdx1_test_escrow"
const KV = "internal_keyvaluestore_rdx1_test_tasks"
const WORKER = "account_rdx1_test_worker_4d2b9c7e"
const WORKER_LAST8 = "…4d2b9c7e"
const POSTER = "account_rdx1_test_poster_99990000"

const T0 = Date.parse("2026-09-23T00:00:00Z") / 1000 // seconds
const HOUR = 3600
const REVIEW = 259_200
const DUE = T0 + HOUR + REVIEW // the review deadline of `submitted()`
const iso = (secs: number) => new Date(secs * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
const isoMs = (ms: number) => new Date(ms).toISOString()

interface TaskSpec {
  state: string
  reward?: string
  insurance?: string
  token?: string
  badge?: string | null
  claimDeadline?: number | null
  bond?: string | null
  agent?: boolean
  submittedAt?: number | null
  reviewDeadline?: number | null
  worker?: string | null
  disputedAt?: number | null
  raisedBy?: "Poster" | "Worker" | null
  pinSecs?: number | null
  pinDefault?: string | null
  ent?: { w?: string; p?: string; wb?: string; pb?: string }
  /** Drop the four entitlement fields entirely (an unreadable shape, not zeros). */
  noEnt?: boolean
}

const open = (o: Partial<TaskSpec> = {}): TaskSpec => ({ state: "Open", ...o })
const claimed = (o: Partial<TaskSpec> = {}): TaskSpec => ({
  state: "Claimed",
  badge: "<worker_badge_7>",
  claimDeadline: T0 + 24 * HOUR,
  bond: "76.45",
  agent: true,
  worker: WORKER,
  ...o,
})
const submitted = (o: Partial<TaskSpec> = {}): TaskSpec => ({
  ...claimed(),
  state: "Submitted",
  submittedAt: T0 + HOUR,
  reviewDeadline: DUE,
  ...o,
})
const disputed = (o: Partial<TaskSpec> = {}): TaskSpec => ({
  ...submitted(),
  state: "Disputed",
  disputedAt: T0 + 2 * HOUR,
  raisedBy: "Poster",
  pinSecs: REVIEW,
  pinDefault: "SplitEvenly",
  ...o,
})
const lapsedLongAgo = () => submitted({ submittedAt: T0 - 8 * 24 * HOUR, reviewDeadline: T0 - 5 * 24 * HOUR })

function option(field_name: string, inner: Record<string, unknown> | null) {
  return inner === null
    ? { kind: "Enum", type_name: "Option", field_name, variant_id: "0", variant_name: "None", fields: [] }
    : { kind: "Enum", type_name: "Option", field_name, variant_id: "1", variant_name: "Some", fields: [inner] }
}

/** The programmatic_json field list the live Gateway returns for one TaskInfo (shape measured 2026-09-23). */
function fieldsOf(t: TaskSpec) {
  const instant = (v: number | null | undefined) => (v == null ? null : { kind: "I64", type_name: "Instant", value: String(v) })
  return [
    { kind: "Reference", field_name: "poster", value: POSTER },
    { kind: "Reference", field_name: "reward_token", value: t.token ?? XRD_ADDRESS },
    { kind: "Decimal", field_name: "reward_amount", value: t.reward ?? "5" },
    { kind: "Decimal", field_name: "insurance_amount", value: t.insurance ?? "1" },
    { kind: "Decimal", field_name: "arbiter_fee_pct", value: "0" },
    { kind: "I64", field_name: "created_at", value: String(T0 - 10 * HOUR) },
    { kind: "Enum", type_name: "TaskState", field_name: "state", variant_name: t.state, fields: [] },
    option("claimer_badge_id", t.badge == null ? null : { kind: "NonFungibleLocalId", value: t.badge }),
    option("claim_deadline", instant(t.claimDeadline)),
    option("claim_bond_amount", t.bond == null ? null : { kind: "Decimal", value: t.bond }),
    { kind: "Bool", field_name: "claimer_is_agent", value: t.agent ?? false },
    option("submit_evidence_hash", null),
    option("submitted_at", instant(t.submittedAt)),
    option("review_deadline", instant(t.reviewDeadline)),
    option("current_claim_receipt_id", null),
    option("worker_account", t.worker == null ? null : { kind: "Reference", value: t.worker }),
    option("disputed_at", instant(t.disputedAt)),
    option("dispute_raised_by", t.raisedBy ? { kind: "Enum", variant_name: t.raisedBy, fields: [] } : null),
    option("dispute_evidence_hash", null),
    option("dispute_auto_resolve_secs", t.pinSecs == null ? null : { kind: "U64", value: String(t.pinSecs) }),
    option("dispute_auto_resolve_default", t.pinDefault ? { kind: "Enum", variant_name: t.pinDefault, fields: [] } : null),
    ...(t.noEnt
      ? []
      : [
          { kind: "Decimal", field_name: "worker_entitled", value: t.ent?.w ?? "0" },
          { kind: "Decimal", field_name: "poster_entitled", value: t.ent?.p ?? "0" },
          { kind: "Decimal", field_name: "worker_bond_entitled", value: t.ent?.wb ?? "0" },
          { kind: "Decimal", field_name: "poster_bond_entitled", value: t.ent?.pb ?? "0" },
        ]),
  ]
}

const entry = (id: number, t: TaskSpec) => ({
  key: { programmatic_json: { kind: "U64", value: String(id) } },
  value: { programmatic_json: { kind: "Tuple", fields: fieldsOf(t) } },
})

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> }
const reply = (body: unknown, status = 200): Reply => ({ ok: status >= 200 && status < 300, status, json: async () => body })

interface World {
  tasks: Map<number, TaskSpec>
  stateVersion: number
  /** The box clock (ms). */
  nowMs: number
  /** The ledger's clock (ms) — the tip's proposer timestamp. null = keeps pace with nowMs. */
  tipMs: number | null
  /** A real network halt: the Gateway refuses UNPINNED reads and answers pinned ones. */
  halted: boolean
  /** /status/gateway-status unreachable (the halt probe cannot tell). */
  tipFail: boolean
  boardRows: Array<Record<string, unknown>>
  /** Per-path override: return a Reply, or throw to simulate a transport failure. */
  fail: Record<string, () => Reply>
  boardFail: boolean
  calls: Array<{ path: string; body: any }>
  fetchImpl: (url: string, init?: { body?: string }) => Promise<Reply>
}

const STALENESS_REFUSAL = {
  message:
    "The Gateway API cannot return current results as its database is not sufficiently up to date with the Network's Ledger",
}

function makeWorld(tasks: Array<[number, TaskSpec]>, boards: Array<[number, number]> = []): World {
  const world: World = {
    tasks: new Map(tasks),
    stateVersion: 1000,
    nowMs: T0 * 1000,
    tipMs: null,
    halted: false,
    tipFail: false,
    boardRows: boards.map(([chain, board]) => ({ id: board, onChainTaskId: chain, escrowComponent: COMPONENT })),
    fail: {},
    boardFail: false,
    calls: [],
    fetchImpl: async () => reply({}),
  }
  const ledgerState = (sv: number) => ({ state_version: sv, proposer_round_timestamp: isoMs(world.tipMs ?? world.nowMs) })
  world.fetchImpl = async (url: string, init?: { body?: string }) => {
    const u = String(url)
    if (u.startsWith(SITE)) {
      world.calls.push({ path: "board", body: null })
      if (world.boardFail) return reply({}, 500)
      return reply({ ok: true, data: world.boardRows, cursor: null, hasMore: false })
    }
    if (!u.startsWith(GW)) throw new Error(`unexpected url ${u}`)
    const path = u.slice(GW.length)
    const body = init?.body ? JSON.parse(init.body) : null
    world.calls.push({ path, body })
    if (world.fail[path]) return world.fail[path]()
    if (path === "/status/gateway-status") {
      return world.tipFail ? reply({}, 500) : reply({ ledger_state: ledgerState(world.stateVersion) })
    }
    const pinned = body?.at_ledger_state?.state_version
    if (world.halted && pinned === undefined) return reply(STALENESS_REFUSAL, 500)
    const sv = pinned ?? world.stateVersion
    const ids = [...world.tasks.keys()].sort((a, b) => a - b)
    if (path === "/state/entity/details") {
      return reply({
        ledger_state: ledgerState(sv),
        items: [
          {
            address: COMPONENT,
            details: {
              state: {
                fields: [
                  { field_name: "tasks", kind: "Own", value: KV },
                  { field_name: "next_task_id", kind: "U64", value: String(ids.length + 1) },
                  { field_name: "review_window_secs", kind: "U64", value: String(REVIEW) },
                  { field_name: "dispute_auto_resolve_secs", kind: "U64", value: String(REVIEW) },
                  { field_name: "dispute_auto_resolve_default", kind: "Enum", variant_name: "SplitEvenly" },
                  { field_name: "expire_grace_secs", kind: "U64", value: "3600" },
                ],
              },
            },
          },
        ],
      })
    }
    if (path === "/state/key-value-store/keys") {
      const start = body.cursor ? Number(body.cursor) : 0
      const limit = body.limit_per_page ?? 100
      const page = [...ids].reverse().slice(start, start + limit)
      const next = start + limit < ids.length ? String(start + limit) : undefined
      return reply({
        ledger_state: ledgerState(sv),
        total_count: ids.length,
        next_cursor: next,
        items: page.map((id) => ({ key: { programmatic_json: { kind: "U64", value: String(id) } } })),
      })
    }
    if (path === "/state/key-value-store/data") {
      if (body.keys.length > 100) return reply({ message: "'Keys Count' must be less than or equal to '100'." }, 400)
      const entries = body.keys
        .map((k: any) => Number(k.key_json.value))
        .filter((id: number) => world.tasks.has(id))
        .map((id: number) => entry(id, world.tasks.get(id)!))
      return reply({ ledger_state: ledgerState(sv), entries })
    }
    throw new Error(`unexpected Gateway path ${path}`)
  }
  return world
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "task-activity-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const statePathIn = () => join(dir, "state.json")
const healthPathIn = () => join(dir, "health.json")

interface RunOpts {
  dryRun?: boolean
  acceptOlderLedger?: boolean
  sendOk?: boolean | ((text: string) => boolean)
  sendThrowsOn?: (text: string) => boolean
  evaluateHealth?: (input: any) => Promise<string>
  /** Override the halt probe entirely (default: the real checkHaltVia over the fake Gateway). */
  checkHalt?: () => Promise<any>
  lever?: boolean
  statePath?: string
  healthPath?: string
}

async function run(world: World, opts: RunOpts = {}) {
  const sent: string[] = []
  const sendOpts: Array<{ silent?: boolean }> = []
  const logs: string[] = []
  const health: any[] = []
  const statePath = opts.statePath ?? statePathIn()
  const code = await runWatch({
    component: COMPONENT,
    gateway: GW,
    siteUrl: SITE,
    statePath,
    healthPath: opts.healthPath ?? healthPathIn(),
    dryRun: opts.dryRun ?? false,
    acceptOlderLedger: opts.acceptOlderLedger ?? false,
    fetchImpl: world.fetchImpl,
    send: async (text: string, o: { silent?: boolean }) => {
      if (opts.sendThrowsOn?.(text)) throw new Error("socket hang up")
      const ok = typeof opts.sendOk === "function" ? opts.sendOk(text) : opts.sendOk ?? true
      if (ok) {
        sent.push(text)
        sendOpts.push(o)
      }
      return ok
    },
    checkHalt:
      opts.checkHalt ??
      (() =>
        checkHaltVia({ gateway: GW, fetchImpl: world.fetchImpl, nowMs: world.nowMs, operatorHalt: opts.lever ?? false, haltAfterSeconds: 600 })),
    evaluateHealth:
      opts.evaluateHealth ??
      (async (input: any) => {
        health.push(input)
        return "none"
      }),
    now: () => world.nowMs,
    log: (...args: unknown[]) => logs.push(args.join(" ")),
    sleep: async () => {},
    sendGapMs: 0,
  })
  return { code, sent, sendOpts, logs, health, statePath }
}

const readState = (path: string = statePathIn()) => JSON.parse(readFileSync(path, "utf8"))
const writeState = (state: unknown, path: string = statePathIn()) => writeFileSync(path, JSON.stringify(state))

/** Seed quietly, then return the world for the scenario under test. */
async function seeded(tasks: Array<[number, TaskSpec]>, boards: Array<[number, number]> = []) {
  const world = makeWorld(tasks, boards)
  const r = await run(world)
  expect(r.code).toBe(EXIT.CLEAN)
  world.stateVersion++
  world.calls = []
  return world
}

/** Advance the box clock (and a live ledger with it) and run once. */
async function tick(world: World, secs: number, opts: RunOpts = {}) {
  world.nowMs = secs * 1000
  if (!world.halted) world.stateVersion++
  return run(world, opts)
}

// ── CLI ──────────────────────────────────────────────────────────────────────

describe.skipIf(PRIV.skip)("parseCliArgs", () => {
  it("defaults to a real run on the /var/lib files", () => {
    expect(parseCliArgs([], {})).toEqual({
      dryRun: false, help: false, acceptOlderLedger: false, statePath: DEFAULT_STATE_PATH, healthPath: DEFAULT_HEALTH_PATH,
    })
  })
  it("--dry-run, --accept-older-ledger and --help are flags, and both paths are env-overridable", () => {
    const s = parseCliArgs(["--dry-run", "--accept-older-ledger", "--help"], {
      GUILD_TASK_ACTIVITY_STATE: "/tmp/a.json",
      GUILD_TASK_ACTIVITY_HEALTH_STAMP: "/tmp/b.json",
    })
    expect(s).toEqual({ dryRun: true, help: true, acceptOlderLedger: true, statePath: "/tmp/a.json", healthPath: "/tmp/b.json" })
  })
  it("rejects an unknown argument, and a health stamp that would clobber the state file or its backup", () => {
    expect(() => parseCliArgs(["--live"], {})).toThrow(UsageError)
    expect(() => parseCliArgs([], { GUILD_TASK_ACTIVITY_STATE: "/tmp/x", GUILD_TASK_ACTIVITY_HEALTH_STAMP: "/tmp/x" })).toThrow(/must be different/)
    expect(() => parseCliArgs([], { GUILD_TASK_ACTIVITY_STATE: "/tmp/x", GUILD_TASK_ACTIVITY_HEALTH_STAMP: "/tmp/x.bak" })).toThrow(/must be different/)
  })
})

// ── Strict chain read ────────────────────────────────────────────────────────

describe.skipIf(PRIV.skip)("readChainSnapshot — strict", () => {
  it("pins every read to one ledger state, pages the keys, and batches /data at the Gateway's 100-key limit", async () => {
    const tasks: Array<[number, TaskSpec]> = Array.from({ length: 150 }, (_, i) => [i + 1, open()])
    const world = makeWorld(tasks)
    const snap = await readChainSnapshot({ gateway: GW, component: COMPONENT, fetchImpl: world.fetchImpl })
    expect(snap.ids).toHaveLength(150)
    expect(snap.tasks.size).toBe(150)
    expect(snap.ledgerTimeMs).toBe(world.nowMs)
    const keys = world.calls.filter((c) => c.path === "/state/key-value-store/keys")
    const data = world.calls.filter((c) => c.path === "/state/key-value-store/data")
    expect(keys).toHaveLength(2)
    expect(data.map((c) => c.body.keys.length)).toEqual([100, 50])
    for (const c of [...keys, ...data]) expect(c.body.at_ledger_state).toEqual({ state_version: 1000 })
    expect(snap.config).toEqual({ reviewWindowSecs: REVIEW, disputeAutoResolveSecs: REVIEW, disputeAutoResolveDefault: "SplitEvenly", expireGraceSecs: 3600 })
  })

  it("with pinStateVersion, the FIRST read is pinned too — which is what a halted Gateway requires", async () => {
    const world = makeWorld([[1, open()]])
    world.halted = true
    await expect(readChainSnapshot({ gateway: GW, component: COMPONENT, fetchImpl: world.fetchImpl })).rejects.toThrow(/HTTP 500/)
    const snap = await readChainSnapshot({ gateway: GW, component: COMPONENT, fetchImpl: world.fetchImpl, pinStateVersion: 1000 })
    expect(snap.stateVersion).toBe(1000)
    const details = world.calls.filter((c) => c.path === "/state/entity/details").at(-1)
    expect(details!.body.at_ledger_state).toEqual({ state_version: 1000 })
  })

  it("enumerates terminal tasks but does not re-read them", async () => {
    const world = makeWorld([[1, open()], [2, { ...submitted(), state: "Released" }], [3, claimed()]])
    const snap = await readChainSnapshot({ gateway: GW, component: COMPONENT, fetchImpl: world.fetchImpl, skipIds: new Set([2]) })
    expect(snap.ids).toEqual([1, 2, 3])
    expect([...snap.tasks.keys()]).toEqual([1, 3])
    const asked = world.calls.filter((c) => c.path === "/state/key-value-store/data").flatMap((c) => c.body.keys.map((k: any) => k.key_json.value))
    expect(asked).toEqual(["1", "3"])
  })

  it.each([
    ["an HTTP error", (w: World) => { w.fail["/state/entity/details"] = () => reply({}, 503) }, /HTTP 503/],
    ["a transport failure", (w: World) => { w.fail["/state/key-value-store/keys"] = () => { throw new Error("ECONNRESET") } }, /network error: ECONNRESET/],
    ["a body that is not JSON", (w: World) => { w.fail["/state/key-value-store/data"] = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("x") } }) }, /not JSON/],
    ["a key count that disagrees with next_task_id", (w: World) => {
      const real = w.fetchImpl
      w.fetchImpl = async (url, init) => {
        const r = await real(url, init)
        if (String(url).endsWith("/keys")) {
          const body: any = await r.json()
          return reply({ ...body, items: body.items.slice(1) })
        }
        return r
      }
    }, /refusing a partial enumeration/],
    ["a listed key missing from /data", (w: World) => {
      const real = w.fetchImpl
      w.fetchImpl = async (url, init) => {
        const r = await real(url, init)
        if (String(url).endsWith("/data")) {
          const body: any = await r.json()
          return reply({ ...body, entries: body.entries.slice(1) })
        }
        return r
      }
    }, /absent from \/data/],
    ["a pinned read answered at another state_version", (w: World) => {
      const real = w.fetchImpl
      w.fetchImpl = async (url, init) => {
        const r = await real(url, init)
        if (String(url).endsWith("/entity/details")) {
          const body: any = await r.json()
          return reply({ ...body, ledger_state: { ...body.ledger_state, state_version: 999 } })
        }
        return r
      }
    }, /asked for state_version 1000, the Gateway answered 999/],
  ])("throws ChainReadError on %s — never an empty result", async (_name, breakIt, message) => {
    const world = makeWorld([[1, open()], [2, claimed()]])
    breakIt(world)
    const pin = String(message).includes("asked for") ? 1000 : null
    const err = await readChainSnapshot({ gateway: GW, component: COMPONENT, fetchImpl: world.fetchImpl, pinStateVersion: pin }).catch((e) => e)
    expect(err).toBeInstanceOf(ChainReadError)
    expect(err.message).toMatch(message)
  })
})

describe.skipIf(PRIV.skip)("parseTaskEntry", () => {
  it("reads the live shape: state, amounts, claim, clocks, pinned dispute terms", () => {
    const s = parseTaskEntry(9, entry(9, disputed({ agent: false })))
    expect(s).toMatchObject({
      id: 9,
      state: "Disputed",
      rewardAmount: "5",
      insuranceAmount: "1",
      claimerBadgeId: "<worker_badge_7>",
      claimDeadline: T0 + 24 * HOUR,
      claimBondAmount: "76.45",
      claimerIsAgent: false,
      submittedAt: T0 + HOUR,
      reviewDeadline: DUE,
      workerAccount: WORKER,
      disputedAt: T0 + 2 * HOUR,
      disputeRaisedBy: "poster",
      disputeAutoResolveSecs: REVIEW,
      disputeAutoResolveDefault: "SplitEvenly",
    })
  })

  it.each([
    ["an unknown TaskState", entry(1, { state: "Frozen" }), /unknown TaskState 'Frozen'/],
    ["Submitted with no review_deadline", entry(1, submitted({ reviewDeadline: null })), /review_deadline is None/],
    ["Open while a claim is still recorded", entry(1, { ...claimed(), state: "Open" }), /a claim is still recorded/],
    ["Claimed with no claim", entry(1, { state: "Claimed" }), /no claim is recorded/],
    ["a missing clock field", (() => {
      const e = entry(1, open())
      e.value.programmatic_json.fields = e.value.programmatic_json.fields.filter((f: any) => f.field_name !== "submitted_at")
      return e
    })(), /'submitted_at' is missing/],
  ])("refuses %s rather than guessing", (_name, e, message) => {
    expect(() => parseTaskEntry(1, e)).toThrow(message)
  })
})

// ── The halt probe ───────────────────────────────────────────────────────────

describe.skipIf(PRIV.skip)("checkHaltVia — the shared halt rule over the pager's own Gateway", () => {
  const probe = (world: World, operatorHalt = false) =>
    checkHaltVia({ gateway: GW, fetchImpl: world.fetchImpl, nowMs: world.nowMs, operatorHalt, haltAfterSeconds: 600 })

  it("a fresh tip is not halted", async () => {
    expect(await probe(makeWorld([]))).toMatchObject({ halted: false, reason: "fresh", stateVersion: 1000 })
  })
  it("a tip older than the threshold is halted, with the frozen state_version to pin at", async () => {
    const world = makeWorld([])
    world.tipMs = world.nowMs - 3 * 3600_000
    expect(await probe(world)).toMatchObject({ halted: true, reason: "stale-tip", stateVersion: 1000, ageSeconds: 10_800 })
  })
  it("the GUILD_HALT lever halts even on a fresh tip", async () => {
    expect(await probe(makeWorld([]), true)).toMatchObject({ halted: true, reason: "operator-lever" })
  })
  it("an unreadable tip is unknown (null) — never a halt, never a throw", async () => {
    const world = makeWorld([])
    world.tipFail = true
    expect(await probe(world)).toMatchObject({ halted: null })
  })
})

// ── Transitions ──────────────────────────────────────────────────────────────

describe.skipIf(PRIV.skip)("transitions page exactly once, as a push, with what the operator acts on", () => {
  it("Open → Claimed: badge, agent flag, worker …last8, claim deadline (UTC)", async () => {
    const world = await seeded([[1, open()]], [[1, 41]])
    world.tasks.set(1, claimed())
    const r = await tick(world, T0)
    expect(r.code).toBe(EXIT.CLEAN)
    expect(r.sent).toHaveLength(1)
    const m = r.sent[0]
    expect(m).toMatch(/^🟡 CLAIMED — board #41 · chain 1\n/)
    expect(m).toContain("reward 5 XRD + insurance 1 XRD · claim bond 76.45 XRD")
    expect(m).toContain(`claimer badge <worker_badge_7> · agent: yes · worker ${WORKER_LAST8}`)
    expect(m).toContain(`claim deadline ${iso(T0 + 24 * HOUR)} (in 1d 0h)`)
    expect(m).toContain("+1h 0m grace")
    expect(m).toContain(`${SITE}/tasks/41`)
    // Every page is a push — never `silent` (the refuter's M17).
    expect(r.sendOpts).toEqual([{ silent: false }])
    // Exactly once: the next run with nothing new sends nothing.
    expect((await tick(world, T0 + 1800)).sent).toEqual([])
  })

  it("the recorded state_version follows the ledger (the lag guard compares against the LAST read, not the seed)", async () => {
    const world = await seeded([[1, open()]])
    await tick(world, T0 + 1800)
    await tick(world, T0 + 3600)
    expect(readState().stateVersion).toBe(world.stateVersion)
    expect(readState(backupPathFor(statePathIn())).stateVersion).toBe(world.stateVersion)
  })

  it("Claimed → Submitted: the review deadline and the sentence that says who gets paid", async () => {
    const world = await seeded([[1, claimed()]], [[1, 41]])
    world.tasks.set(1, submitted())
    const r = await tick(world, T0 + 1.5 * HOUR)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toMatch(/^🟠 SUBMITTED — review clock running — board #41 · chain 1\n/)
    expect(r.sent[0]).toContain(`review deadline ${iso(DUE)} (in 2d 23h)`)
    expect(r.sent[0]).toContain(`If unanswered by ${iso(DUE)} the submitter is paid.`)
    expect(r.sent[0]).not.toContain("since the last check")
  })

  it("Open → Submitted inside one window: ONE message that names both steps", async () => {
    const world = await seeded([[1, open()]], [[1, 41]])
    world.tasks.set(1, submitted())
    const r = await tick(world, T0 + 1.5 * HOUR)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toMatch(/^🟠 SUBMITTED/)
    expect(r.sent[0]).toContain("since the last check: claimed → submitted")
    expect(r.sent[0]).toContain("claimer badge <worker_badge_7>")
  })

  it("Claimed → Submitted → Released inside one window: ONE message naming both", async () => {
    const world = await seeded([[1, claimed()]], [[1, 41]])
    world.tasks.set(1, { ...submitted(), state: "Released", ent: { w: "5", wb: "76.45", p: "1" } })
    const r = await tick(world, T0 + 5 * HOUR)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toContain("since the last check: submitted → released")
  })

  it("Open → … → Disputed → Refunded inside one window: ONE message naming all four steps", async () => {
    const world = await seeded([[1, open()]], [[1, 41]])
    world.tasks.set(1, { ...disputed(), state: "Refunded" })
    const r = await tick(world, T0 + 3 * HOUR)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toContain("since the last check: claimed → submitted → dispute raised → dispute settled")
  })

  it("Claimed → Open: the claim expired and its bond was forfeited", async () => {
    const world = await seeded([[1, claimed()]], [[1, 41]])
    world.tasks.set(1, open({ bond: "76.45" })) // expire_claim leaves claim_bond_amount set
    const r = await tick(world, T0 + 26 * HOUR)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toMatch(/^⌛ CLAIM EXPIRED — bond forfeited, task is Open again — board #41 · chain 1\n/)
    expect(r.sent[0]).toContain(`expired claim: claimer badge <worker_badge_7> · agent: yes · worker ${WORKER_LAST8}`)
    expect(r.sent[0]).toContain(`its deadline was ${iso(T0 + 24 * HOUR)}; the 76.45 XRD bond went to whoever called expire_claim`)
  })

  it("Claimed → Claimed by someone else: the expiry AND the new claim, in one message", async () => {
    const world = await seeded([[1, claimed()]], [[1, 41]])
    world.tasks.set(1, claimed({ badge: "<other_badge>", agent: false, claimDeadline: T0 + 200 * HOUR }))
    const r = await tick(world, T0 + 30 * HOUR)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toMatch(/^🟡 CLAIMED/)
    expect(r.sent[0]).toContain("since the last check: claim expired → claimed")
    expect(r.sent[0]).toContain("expired claim: claimer badge <worker_badge_7>")
    expect(r.sent[0]).toContain("claimer badge <other_badge> · agent: no")
  })

  it("the SAME badge re-claiming after its own claim expired is still an expiry AND a claim", async () => {
    // Identity is badge + deadline: the same worker's second claim has a later deadline.
    const world = await seeded([[1, claimed()]], [[1, 41]])
    world.tasks.set(1, claimed({ claimDeadline: T0 + 54 * HOUR }))
    const r = await tick(world, T0 + 30 * HOUR)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toContain("since the last check: claim expired → claimed")
    expect(r.sent[0]).toContain(`claim deadline ${iso(T0 + 54 * HOUR)}`)
  })

  it("Claimed → Refunded: cancelled after the claim — the worker's bond goes back to them", async () => {
    const world = await seeded([[1, claimed()]], [[1, 41]])
    world.tasks.set(1, { ...claimed(), state: "Refunded", ent: { p: "6", wb: "76.45" } })
    const r = await tick(world, T0 + HOUR)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toMatch(/^↩️ CANCELLED after claim/)
    expect(r.sent[0]).toContain("credited, not yet withdrawn: worker bond 76.45 XRD · poster 6 XRD")
  })

  it("Open → Refunded: cancelled while open", async () => {
    const world = await seeded([[1, open()]], [[1, 41]])
    world.tasks.set(1, open({ state: "Refunded", ent: { p: "6" } }))
    const r = await tick(world, T0 + HOUR)
    expect(r.sent).toEqual([expect.stringMatching(/^↩️ CANCELLED while Open — refunded to the poster — board #41 · chain 1\n/)])
  })

  it("Submitted → Disputed: the auto-resolve time and what the pinned default pays", async () => {
    const world = await seeded([[1, submitted()]], [[1, 41]])
    world.tasks.set(1, disputed())
    const r = await tick(world, T0 + 2.5 * HOUR)
    expect(r.sent).toHaveLength(1)
    const m = r.sent[0]
    expect(m).toMatch(/^⚖️ DISPUTED — board #41 · chain 1\n/)
    expect(m).toContain(`raised by poster at ${iso(T0 + 2 * HOUR)} · auto-resolves from ${iso(T0 + 2 * HOUR + REVIEW)}`)
    // SplitEvenly governs the reward only; insurance comes home (src/lib/dispute-outcome.ts).
    expect(m).toContain("SplitEvenly → worker 2.5 XRD, poster 3.5 XRD (insurance returns to the poster) [terms pinned at raise]")
  })

  it("Submitted → Released before the deadline can only have been the poster's approval", async () => {
    const world = await seeded([[1, submitted()]], [[1, 41]])
    world.tasks.set(1, { ...submitted(), state: "Released", ent: { w: "5", wb: "76.45", p: "1" } })
    const r = await tick(world, T0 + 5 * HOUR)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toMatch(/^✅ RELEASED — worker paid/)
    expect(r.sent[0]).toContain("released before the review deadline — the poster approved")
    expect(r.sent[0]).toContain("credited, not yet withdrawn: worker 5 XRD · worker bond 76.45 XRD · poster 1 XRD")
  })

  it("Submitted → Released after the deadline says it may have been the public timeout release", async () => {
    const world = await seeded([[1, submitted()]], [[1, 41]])
    world.tasks.set(1, { ...submitted(), state: "Released" })
    const r = await tick(world, DUE + HOUR)
    // The lapsed reminder is superseded by the transition itself — one message.
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toContain("release_after_review_timeout was fired")
    expect(r.sent[0]).toContain("nothing left to withdraw")
  })

  it("attribution uses the LEDGER's clock: frozen before the deadline, box clock after it → still 'approved'", async () => {
    const world = await seeded([[1, submitted()]], [[1, 41]])
    world.tasks.set(1, { ...submitted(), state: "Released" })
    world.tipMs = (DUE - HOUR) * 1000 // the release is visible at a ledger time before the deadline
    const r = await tick(world, DUE + 2 * HOUR, { checkHalt: async () => ({ halted: false }) })
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toContain("released before the review deadline — the poster approved")
  })

  it("unreadable withdrawable balances are said to be unreadable — never 'nothing left'", async () => {
    const world = await seeded([[1, submitted()]], [[1, 41]])
    world.tasks.set(1, { ...submitted(), state: "Released", noEnt: true })
    const r = await tick(world, T0 + 2 * HOUR)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toContain("withdrawable balances unreadable")
    expect(r.sent[0]).not.toContain("nothing left to withdraw")
  })

  it.each([
    ["Released", /DISPUTE SETTLED → Released/],
    ["Refunded", /DISPUTE SETTLED → Refunded to the poster/],
  ])("Disputed → %s: settled, and an early settlement can only have been an arbiter", async (to, head) => {
    const world = await seeded([[1, disputed()]], [[1, 41]])
    world.tasks.set(1, { ...disputed(), state: to })
    const r = await tick(world, T0 + 10 * HOUR)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toMatch(head)
    expect(r.sent[0]).toContain("settled before the auto-resolve window closed — an arbiter ruled")
  })

  it("a task first seen already claimed pages the claim; a new Open task is logged, not paged", async () => {
    const world = await seeded([[1, open()]], [[1, 41], [2, 42], [3, 43]])
    world.tasks.set(2, open())
    world.tasks.set(3, claimed())
    const r = await tick(world, T0 + HOUR)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toMatch(/^🟡 CLAIMED — board #43 · chain 3/)
    expect(r.logs.some((l) => l.includes("NEW task board #42 · chain 2 posted"))).toBe(true)
  })

  it("terminal tasks are never re-read once recorded — and the run is CLEAN, not a refusal", async () => {
    const world = await seeded([[1, { ...submitted(), state: "Released" }], [2, open()]])
    const r = await tick(world, T0 + HOUR)
    expect(r.code).toBe(EXIT.CLEAN)
    expect(r.sent).toEqual([])
    const asked = world.calls.filter((c) => c.path === "/state/key-value-store/data").flatMap((c) => c.body.keys.map((k: any) => k.key_json.value))
    expect(asked).toEqual(["2"])
  })

  it("inferEvents: a state change no rule explains is still paged, never dropped", () => {
    const prev = { ...memoFor(parseTaskEntry(1, entry(1, open()))) }
    const weird = { ...parseTaskEntry(1, entry(1, open())), state: "Claimed" }
    expect(inferEvents(prev, weird)).toEqual([{ kind: "state-changed", from: "Open", to: "Claimed" }])
  })

  it("never puts a full account address in an alert or a log line — only …last8", async () => {
    const world = await seeded([[1, open()]], [[1, 41]])
    world.tasks.set(1, submitted())
    const r = await tick(world, T0 + 2 * HOUR)
    expect(r.sent).toHaveLength(1)
    for (const text of [...r.sent, ...r.logs]) {
      expect(text).not.toContain(WORKER)
      expect(text).not.toContain(POSTER)
    }
  })
})

// ── Reminders ────────────────────────────────────────────────────────────────

describe.skipIf(PRIV.skip)("review-deadline reminders", () => {
  it("24h and 2h page once each; nothing between them", async () => {
    const world = await seeded([[1, claimed()]], [[1, 41]])
    world.tasks.set(1, submitted())
    expect((await tick(world, T0 + 1.5 * HOUR)).sent).toEqual([expect.stringMatching(/^🟠 SUBMITTED/)])
    expect((await tick(world, DUE - 30 * HOUR)).sent).toEqual([])
    expect((await tick(world, DUE - 23.5 * HOUR)).sent).toEqual([expect.stringMatching(/^⏰ REVIEW DEADLINE in 23h 30m — board #41 · chain 1\n/)])
    expect((await tick(world, DUE - 20 * HOUR)).sent).toEqual([])
    expect((await tick(world, DUE - 1.5 * HOUR)).sent).toEqual([expect.stringMatching(/^🔴 REVIEW DEADLINE in 1h 30m/)])
    expect((await tick(world, DUE - HOUR)).sent).toEqual([])
    expect(readState().tasks["1"].sent).toEqual(["24h", "2h"])
  })

  it("'lapsed' pages the first run after the deadline — not up to a cron slot later", async () => {
    const world = await seeded([[1, submitted()]], [[1, 41]])
    await tick(world, DUE - HOUR) // 2h reminder
    const r = await tick(world, DUE + 60)
    expect(r.sent).toEqual([expect.stringMatching(/^🔴 REVIEW WINDOW LAPSED 1m ago — board #41 · chain 1\n/)])
    expect(r.sent[0]).toContain("anyone can call release_after_review_timeout now and the submitter is paid")
  })

  it("'lapsed' repeats every run for 24h past the deadline, then every 6h, and stops when the task leaves Submitted", async () => {
    const world = await seeded([[1, submitted()]], [[1, 41]])
    await tick(world, DUE - HOUR)
    const pages: number[] = []
    for (let k = 0; k <= 59; k++) {
      const r = await tick(world, DUE + 60 + k * 1800)
      pages.push(r.sent.length)
      if (k === 1) expect(r.sent[0]).toMatch(/LAPSED .* \(repeat\)/)
    }
    // k = 0..47: t < DUE + 24h → every run. k = 48..58: 6h not yet up since k = 47. k = 59: 6h since k = 47.
    expect(pages.slice(0, 48)).toEqual(Array(48).fill(1))
    expect(pages.slice(48, 59)).toEqual(Array(11).fill(0))
    expect(pages[59]).toBe(1)
    // A manual re-run inside the same slot does not double-page (25-min floor).
    expect((await tick(world, DUE + 60 + 59 * 1800 + 600)).sent).toEqual([])
    // Settled: the transition is paged once, and the lapsed repeats stop.
    world.tasks.set(1, { ...submitted(), state: "Released" })
    expect((await tick(world, DUE + 31 * HOUR)).sent).toEqual([expect.stringMatching(/^✅ RELEASED/)])
    expect((await tick(world, DUE + 40 * HOUR)).sent).toEqual([])
    expect(LAPSED_REPEAT).toEqual({ hotWindowMs: 24 * 3600_000, hotEveryMs: 25 * 60_000, coldEveryMs: 6 * 3600_000 - 5 * 60_000 })
  })

  it("the 6-hourly repeat lands on its slot even when this run started later into its slot than the last one", async () => {
    // Runs start 0–40 s into a */30 slot. An exact 6h interval measured from a
    // run that started 40 s in would skip the slot 6h later if that run started 5 s in.
    const world = makeWorld([[1, lapsedLongAgo()]], [[1, 41]])
    world.nowMs = (T0 + 40) * 1000
    expect((await run(world)).sent).toHaveLength(1) // seed page, lapsedAt = T0 + 40 s
    const r = await tick(world, T0 + 6 * HOUR + 5)
    expect(r.sent).toEqual([expect.stringMatching(/LAPSED .* \(repeat\)/)])
  })

  it("a stage skipped over (the pager was down) is not sent late — only the most urgent one", async () => {
    const world = await seeded([[1, submitted()]], [[1, 41]])
    const r = await tick(world, DUE - HOUR)
    expect(r.sent).toEqual([expect.stringMatching(/^🔴 REVIEW DEADLINE in 1h 0m/)])
    expect(readState().tasks["1"].sent).toEqual(["24h", "2h"])
  })

  it("a submission first seen inside the 24h window: the transition message stands in for the reminder", async () => {
    const world = await seeded([[1, claimed()]], [[1, 41]])
    world.tasks.set(1, submitted())
    expect((await tick(world, DUE - 10 * HOUR)).sent).toEqual([expect.stringMatching(/^🟠 SUBMITTED/)])
    expect((await tick(world, DUE - 9 * HOUR)).sent).toEqual([])
    expect((await tick(world, DUE - HOUR)).sent).toEqual([expect.stringMatching(/^🔴 REVIEW DEADLINE in 1h 0m/)])
  })

  it("a reminder Telegram refused is retried next run — never recorded as sent", async () => {
    const world = await seeded([[1, submitted()]], [[1, 41]])
    const refused = await tick(world, DUE - 1.5 * HOUR, { sendOk: false })
    expect(refused.code).toBe(EXIT.UNDELIVERED)
    expect(readState().tasks["1"].sent).toEqual([])
    expect((await tick(world, DUE - HOUR)).sent).toEqual([expect.stringMatching(/^🔴 REVIEW DEADLINE in 1h 0m/)])
  })

  it("a seed-time 'lapsed' page Telegram refused is retried next run — not six hours later", async () => {
    const world = makeWorld([[1, lapsedLongAgo()]], [[1, 78]])
    const refused = await run(world, { sendOk: false })
    expect(refused.code).toBe(EXIT.UNDELIVERED)
    expect(readState().tasks["1"]).toMatchObject({ sent: [], lapsedAt: null })
    const retried = await tick(world, T0 + 1800)
    expect(retried.sent).toEqual([expect.stringMatching(/^🔴 REVIEW WINDOW LAPSED 5d 0h ago/)])
  })
})

// ── Seed ─────────────────────────────────────────────────────────────────────

describe.skipIf(PRIV.skip)("first run", () => {
  it("seeds every task and pages NO transition", async () => {
    const world = makeWorld(
      [[1, open()], [2, claimed()], [3, disputed()], [4, { ...submitted(), state: "Released" }], [5, submitted()]],
      [[1, 11], [2, 12], [3, 13], [5, 15]],
    )
    const r = await run(world)
    expect(r.code).toBe(EXIT.CLEAN)
    expect(r.sent).toEqual([])
    const state = readState()
    expect(Object.keys(state.tasks)).toEqual(["1", "2", "3", "4", "5"])
    expect(state).toMatchObject({ schema: 1, component: COMPONENT, stateVersion: 1000 })
    expect(state.tasks["2"]).toMatchObject({ state: "Claimed", boardId: 12, claim: { badge: "<worker_badge_7>", worker: WORKER_LAST8 } })
    // …and its backup is written too.
    expect(readState(backupPathFor(statePathIn()))).toEqual(state)
  })

  it("the chain-14 case: a Submitted task already past its review deadline gets ONE 'already lapsed' message, then the 6h cadence", async () => {
    const world = makeWorld([[1, open()], [2, lapsedLongAgo()]], [[2, 78]])
    const r = await run(world)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toMatch(/^🔴 REVIEW WINDOW LAPSED 5d 0h ago — board #78 · chain 2\n/)
    expect(r.sent[0]).toContain("(first seen when this pager was seeded — the submission itself was not observed live)")
    expect(r.sent[0]).toContain("Repeats every 6h — it stops when the task is approved, disputed or released.")
    expect((await tick(world, T0 + 1800)).sent).toEqual([])
    expect((await tick(world, T0 + 6 * HOUR)).sent).toEqual([expect.stringMatching(/LAPSED .* \(repeat\)/)])
  })

  it("a Submitted task inside the 24h window at seed gets one message for that stage, then the next stage later", async () => {
    const world = makeWorld([[1, submitted()]], [[1, 41]])
    world.nowMs = (DUE - 5 * HOUR) * 1000
    expect((await run(world)).sent).toEqual([expect.stringMatching(/^⏰ REVIEW DEADLINE in 5h 0m/)])
    expect((await tick(world, DUE - 1.5 * HOUR)).sent).toEqual([expect.stringMatching(/^🔴 REVIEW DEADLINE in 1h 30m/)])
  })

  it("an escrow cutover (state for another component) re-seeds quietly instead of diffing colliding ids", async () => {
    const world = await seeded([[1, open()]])
    writeState({ ...readState(), component: "component_rdx1_test_retired" })
    world.tasks.set(1, claimed())
    const r = await tick(world, T0 + HOUR)
    expect(r.sent).toEqual([])
    expect(r.logs.some((l) => l.includes("re-seeds"))).toBe(true)
    expect(readState().component).toBe(COMPONENT)
  })
})

// ── Losing the state file ────────────────────────────────────────────────────

describe.skipIf(PRIV.skip)("losing the state file is never silent once the pager has run", () => {
  it("state file deleted → recovered from its backup, the gap's release IS paged, plus one notice", async () => {
    const world = await seeded([[1, submitted()]], [[1, 41]])
    rmSync(statePathIn())
    world.tasks.set(1, { ...submitted(), state: "Released", ent: { w: "5", wb: "76.45", p: "1" } })
    const r = await tick(world, T0 + 5 * HOUR)
    expect(r.code).toBe(EXIT.STATE_PROBLEM)
    expect(r.sent).toHaveLength(2)
    expect(r.sent[0]).toMatch(/^⚠️ Task-activity pager: the state file was missing — recovered from its backup/)
    expect(r.sent[0]).toContain("state_version 1000")
    expect(r.sent[1]).toMatch(/^✅ RELEASED/)
    expect(existsSync(statePathIn())).toBe(true)
    expect((await tick(world, T0 + 5.5 * HOUR)).code).toBe(EXIT.CLEAN)
  })

  it("state file corrupt → recovered from the backup; the bad file is kept under a content-derived name the notice names", async () => {
    const world = await seeded([[1, claimed()]], [[1, 41]])
    writeFileSync(statePathIn(), "{ this is not json")
    world.tasks.set(1, submitted())
    const r = await tick(world, T0 + 2 * HOUR)
    expect(r.code).toBe(EXIT.STATE_PROBLEM)
    const kept = readdirSync(dir).filter((f) => f.startsWith("state.json.corrupt-"))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(dir, kept[0]), "utf8")).toBe("{ this is not json")
    expect(r.sent[0]).toContain("unreadable (not valid JSON) — recovered from its backup")
    expect(r.sent[0]).toContain(`The unreadable state file was kept as ${join(dir, kept[0])}.`)
    expect(r.sent[1]).toMatch(/^🟠 SUBMITTED/)
  })

  it("state AND backup unusable → re-seeded, ONE loud notice listing what is live; each corruption kept separately", async () => {
    const world = await seeded([[1, open()], [2, submitted()], [3, claimed()]], [[2, 52], [3, 53]])
    writeFileSync(statePathIn(), "{ first")
    writeFileSync(backupPathFor(statePathIn()), "{ backup")
    const r = await tick(world, T0 + 3 * HOUR)
    expect(r.code).toBe(EXIT.STATE_PROBLEM)
    expect(r.sent).toHaveLength(1)
    const m = r.sent[0]
    expect(m).toMatch(/^⚠️ Task-activity pager: the state file is unreadable \(not valid JSON\) and its backup is unreadable \(not valid JSON\) — RE-SEEDED/)
    // The run record says where the record stopped, even when both files are unreadable.
    expect(m).toContain(`Transitions between the last recorded run (${isoMs(T0 * 1000)}) and now were NOT paged — check the board.`)
    expect(m).toContain(`• board #52 · chain 2 Submitted — review deadline ${iso(DUE)}`)
    expect(m).toContain("• board #53 · chain 3 Claimed")
    expect(m).toContain("• 1 open task(s)")
    // A second corruption later must not overwrite the first kept copy.
    writeFileSync(statePathIn(), "{ second")
    writeFileSync(backupPathFor(statePathIn()), "{ second backup")
    await tick(world, T0 + 4 * HOUR)
    const kept = readdirSync(dir).filter((f) => f.includes(".corrupt-")).sort()
    expect(kept).toHaveLength(4)
    const contents = kept.map((f) => readFileSync(join(dir, f), "utf8")).sort()
    expect(contents).toEqual(["{ backup", "{ first", "{ second", "{ second backup"])
  })

  it("every non-dry run records itself — clean, failed or halted — with the last state_version it RECORDED", async () => {
    const world = await seeded([[1, open()]])
    expect(readLastRun(healthPathIn())).toMatchObject({ exit: EXIT.CLEAN, stateVersion: 1000, recordedStateVersion: 1000 })
    world.fail["/state/entity/details"] = () => reply({}, 503)
    await tick(world, T0 + HOUR)
    // A failed run is recorded too, and carries the last RECORDED version forward.
    expect(readLastRun(healthPathIn())).toMatchObject({ exit: EXIT.CHAIN_READ_FAILED, recordedStateVersion: 1000 })
    expect(JSON.parse(readFileSync(healthPathIn(), "utf8"))).toHaveProperty(LAST_RUN_KEY)
  })

  it("state AND backup deleted after a failed re-seed attempt: still loud — a failed run cannot erase the evidence", async () => {
    const world = await seeded([[1, open()]], [[1, 41]])
    rmSync(statePathIn())
    rmSync(backupPathFor(statePathIn()))
    world.fail["/state/entity/details"] = () => reply({}, 503)
    expect((await tick(world, T0 + HOUR)).code).toBe(EXIT.CHAIN_READ_FAILED)
    delete world.fail["/state/entity/details"]
    const r = await tick(world, T0 + 1.5 * HOUR)
    expect(r.sent).toEqual([expect.stringMatching(/both missing, yet this pager recorded state_version 1000 at .* — RE-SEEDED/)])
  })

  it("a run record that cannot be written is loud (exit 4): without it, a later state loss would be silent", async () => {
    const world = makeWorld([[1, open()]])
    const r = await run(world, { healthPath: join(dir, "no-such-dir", "health.json") })
    expect(r.code).toBe(EXIT.STATE_PROBLEM)
    expect(r.logs.join("\n")).toMatch(/could not record this run .* could not tell that it had run before/)
  })

  it("a first install whose first runs FAILED is still a first run — a quiet seed, not a false alarm", async () => {
    const world = makeWorld([[1, open()]])
    world.fail["/state/entity/details"] = () => reply({}, 503)
    expect((await run(world)).code).toBe(EXIT.CHAIN_READ_FAILED)
    expect(readLastRun(healthPathIn())).toMatchObject({ recordedStateVersion: null })
    delete world.fail["/state/entity/details"]
    const r = await tick(world, T0 + 1800)
    expect(r.sent).toEqual([])
    expect(r.logs.join("\n")).toMatch(/FIRST RUN/)
  })

  it("state AND backup AND the stamp file gone is a deliberate fresh start — a quiet seed, as the header documents", async () => {
    const world = await seeded([[1, open()]])
    rmSync(statePathIn())
    rmSync(backupPathFor(statePathIn()))
    rmSync(healthPathIn())
    world.tasks.set(1, claimed())
    const r = await tick(world, T0 + HOUR)
    expect(r.sent).toEqual([])
    expect(r.logs.join("\n")).toMatch(/FIRST RUN/)
  })

  it("repeated failed runs over the same unreadable file keep ONE copy of it, not one per run", async () => {
    const world = await seeded([[1, open()]])
    writeFileSync(statePathIn(), "{ broken")
    writeFileSync(backupPathFor(statePathIn()), "{ broken backup")
    world.fail["/state/entity/details"] = () => reply({}, 503)
    for (let i = 1; i <= 6; i++) expect((await tick(world, T0 + i * 1800)).code).toBe(EXIT.CHAIN_READ_FAILED)
    const kept = readdirSync(dir).filter((f) => f.includes(".corrupt-")).sort()
    expect(kept).toHaveLength(2)
    delete world.fail["/state/entity/details"]
    const r = await tick(world, T0 + 4 * HOUR)
    expect(r.sent[0]).toContain("(same content, kept on an earlier run)")
  })

  it("a state file from the first head (no lapsedAt yet) is read, not treated as corrupt", async () => {
    const world = await seeded([[1, submitted()]], [[1, 41]])
    const s = readState()
    for (const m of Object.values<any>(s.tasks)) delete m.lapsedAt
    writeState(s)
    const r = await tick(world, T0 + 2 * HOUR)
    expect(r.code).toBe(EXIT.CLEAN)
    expect(r.sent).toEqual([])
    expect(readState().tasks["1"].lapsedAt).toBeNull()
  })

  it("a notice Telegram refuses is kept in the state and retried next run — the state heals either way", async () => {
    const world = await seeded([[1, open()]], [[1, 41]])
    writeFileSync(statePathIn(), "garbage")
    writeFileSync(backupPathFor(statePathIn()), "garbage")
    const refused = await tick(world, T0 + HOUR, { sendOk: false })
    expect(refused.code).toBe(EXIT.UNDELIVERED)
    const state = readState()
    expect(state.pendingNotices).toHaveLength(1)
    expect(state.pendingNotices[0].text).toMatch(/RE-SEEDED/)
    const retried = await tick(world, T0 + 1.5 * HOUR)
    expect(retried.sent).toEqual([expect.stringMatching(/RE-SEEDED[\s\S]*\(re-sent: this notice could not be delivered at /)])
    expect(readState().pendingNotices).toBeUndefined()
    expect((await tick(world, T0 + 2 * HOUR)).sent).toEqual([])
  })

  it("the re-seed notice never exceeds Telegram's limit, so it cannot loop: 200 live tasks, a sender that refuses > 4096", async () => {
    const tasks: Array<[number, TaskSpec]> = Array.from({ length: 200 }, (_, i) => [i + 1, claimed()])
    tasks.push([201, lapsedLongAgo()])
    const world = await seeded(tasks, tasks.map(([id]) => [id, 1000 + id] as [number, number]))
    writeFileSync(statePathIn(), "{")
    writeFileSync(backupPathFor(statePathIn()), "{")
    const rejectLong = (t: string) => t.length <= 4096
    const r = await tick(world, T0 + 1800, { sendOk: rejectLong })
    expect(r.code).toBe(EXIT.STATE_PROBLEM)
    expect(r.sent[0]).toMatch(/RE-SEEDED/)
    expect(r.sent[0].length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS)
    expect(r.sent[0]).toContain("… and 176 more (full list in the cron log)")
    expect(readState().schema).toBe(1)
    const next = await tick(world, T0 + 3600, { sendOk: rejectLong })
    expect(next.code).toBe(EXIT.CLEAN)
  })

  it("the send loop cuts any over-long page to Telegram's limit and logs the full text", async () => {
    const world = await seeded([[1, open()]])
    const long = Array.from({ length: 300 }, (_, i) => `notice line ${i} ${"y".repeat(20)}`).join("\n")
    writeState({ ...readState(), pendingNotices: [{ text: long, since: "2026-09-22T00:00:00.000Z" }] })
    const r = await tick(world, T0 + HOUR, { sendOk: (t) => t.length <= 4096 })
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0].length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS)
    expect(r.sent[0]).toMatch(/\n… \[truncated — the full message is in the cron log\]$/)
    expect(r.logs.join("\n")).toContain("notice line 299")
    expect(readState().pendingNotices).toBeUndefined()
  })

  it("undelivered notices are all kept for retry — up to the latest ten", async () => {
    const world = await seeded([[1, open()]])
    const notice = (n: number) => ({ text: `notice ${n}`, since: `2026-09-2${n % 10}T00:00:00.000Z` })
    writeState({ ...readState(), pendingNotices: [1, 2, 3].map(notice) })
    await tick(world, T0 + HOUR, { sendOk: false })
    expect(readState().pendingNotices.map((n: any) => n.text)).toEqual(["notice 1", "notice 2", "notice 3"])
    writeState({ ...readState(), pendingNotices: Array.from({ length: 12 }, (_, i) => notice(i + 1)) })
    await tick(world, T0 + 2 * HOUR, { sendOk: false })
    expect(readState().pendingNotices.map((n: any) => n.text)).toEqual(Array.from({ length: 10 }, (_, i) => `notice ${i + 3}`))
  })

  it("fitTelegram: any over-long page is cut at a line boundary, and says so", () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n")
    const cut = fitTelegram(long)
    expect(cut.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS)
    expect(cut).toMatch(/\n… \[truncated — the full message is in the cron log\]$/)
    expect(fitTelegram("short")).toBe("short")
  })

  it("a malformed memo counts as unreadable (one recovery), not as a contradiction every run", () => {
    writeState({ schema: 1, component: COMPONENT, stateVersion: 5, tasks: { "1": { state: "Open" } } })
    expect(loadState(statePathIn(), COMPONENT)).toMatchObject({ kind: "corrupt" })
  })
})

// ── The state_version lock-up and its recovery ──────────────────────────────

describe.skipIf(PRIV.skip)("--accept-older-ledger: the recovery from a record ahead of the Gateway (not deletion)", () => {
  it("a wedged record refuses every run and says how to recover; --accept-older-ledger pages what moved and re-pins", async () => {
    const world = await seeded(
      [[1, open()], [2, submitted()], [3, claimed()], [4, submitted()], [5, { ...submitted(), state: "Released" }]],
      [[1, 41], [2, 42], [3, 43], [4, 44], [5, 45]],
    )
    // The record runs ahead of any ledger this Gateway will ever serve: it holds
    // a terminal task the ledger calls live (2), a submission the ledger never
    // saw (3), a dispute the ledger never saw (4), and a task it no longer lists (6).
    const s = readState()
    const t = s.tasks
    writeState({
      ...s,
      stateVersion: 9_999_999,
      tasks: {
        ...t,
        "2": { ...t["2"], state: "Released", sent: [], lapsedAt: null },
        "3": { ...memoFor(parseTaskEntry(3, entry(3, submitted()))), boardId: 43 },
        "4": { ...memoFor(parseTaskEntry(4, entry(4, disputed()))), boardId: 44 },
        "6": t["1"],
      },
    })
    world.tasks.set(1, submitted()) // claimed + submitted while the pager was wedged
    const wedged = await tick(world, T0 + 2 * HOUR)
    expect(wedged.code).toBe(EXIT.CHAIN_READ_FAILED)
    expect(wedged.sent).toEqual([])
    expect(wedged.logs.join("\n")).toMatch(/older than the 9999999 already recorded[\s\S]*--accept-older-ledger[\s\S]*do NOT delete/)
    expect(wedged.health.at(-1)).toMatchObject({ condition: true })

    const recovery = await tick(world, T0 + 2.5 * HOUR, { acceptOlderLedger: true })
    expect(recovery.code).toBe(EXIT.STATE_PROBLEM)
    expect(recovery.sent).toHaveLength(2)
    const notice = recovery.sent[0]
    expect(notice).toMatch(/^⚠️ Task-activity pager: accepted an OLDER ledger \(--accept-older-ledger\)/)
    expect(notice).toContain("• board #42 · chain 2: recorded Released, the ledger says Submitted")
    expect(notice).toContain("• board #43 · chain 3: recorded Submitted, the ledger says Claimed")
    expect(notice).toContain("• board #44 · chain 4: recorded Disputed, the ledger says Submitted")
    expect(notice).toContain("No longer on the ledger (dropped from the record): chain 6")
    expect(notice).toContain("treat a 'claimed', 'expired' or 'cancelled' page from this run with suspicion")
    expect(notice).toContain("never leave it in the crontab")
    expect(recovery.sent[1]).toMatch(/^🟠 SUBMITTED — review clock running — board #41 · chain 1/)
    expect(recovery.sent[1]).toContain("since the last check: claimed → submitted")
    expect(recovery.sent[1]).toContain("paged from an OLDER ledger")
    // Every task was re-read, terminal ones included: a rollback can un-settle one.
    const asked = world.calls.filter((c) => c.path === "/state/key-value-store/data").flatMap((c) => c.body.keys.map((k: any) => k.key_json.value))
    expect(asked).toContain("5")
    expect(readState().stateVersion).toBe(world.stateVersion)
    expect(Object.keys(readState().tasks)).toEqual(["1", "2", "3", "4", "5"])
    expect(readState().tasks["3"]).toMatchObject({ state: "Claimed", submittedAt: null })

    // The cron's next run is normal.
    const after = await tick(world, T0 + 3 * HOUR)
    expect(after.code).toBe(EXIT.CLEAN)
    expect(after.sent).toEqual([])
  })

  it("a task rewound onto a live clock (Submitted, past its deadline) gets its lapsed page in the recovery run itself", async () => {
    const world = await seeded([[1, lapsedLongAgo()]], [[1, 41]])
    const s = readState()
    writeState({ ...s, stateVersion: 9_999_999, tasks: { "1": { ...s.tasks["1"], state: "Released", sent: [], lapsedAt: null } } })
    const r = await tick(world, T0 + HOUR, { acceptOlderLedger: true })
    expect(r.sent).toHaveLength(2)
    expect(r.sent[0]).toContain("• board #41 · chain 1: recorded Released, the ledger says Submitted")
    expect(r.sent[1]).toMatch(/^🔴 REVIEW WINDOW LAPSED 5d 1h ago — board #41 · chain 1/)
    expect(readState().tasks["1"]).toMatchObject({ state: "Submitted", sent: REVIEW_STAGES, lapsedAt: world.nowMs })
  })

  it("against a Gateway that is NOT behind, --accept-older-ledger is an ordinary run", async () => {
    const world = await seeded([[1, open()]], [[1, 41]])
    world.tasks.set(1, claimed())
    const r = await tick(world, T0 + HOUR, { acceptOlderLedger: true })
    expect(r.code).toBe(EXIT.CLEAN)
    expect(r.sent).toEqual([expect.stringMatching(/^🟡 CLAIMED/)])
    expect(r.logs.join("\n")).toMatch(/nothing to accept; a normal run/)
  })

  it("--dry-run --accept-older-ledger previews and writes nothing", async () => {
    const world = await seeded([[1, open()]])
    writeState({ ...readState(), stateVersion: 9_999_999 })
    const before = readFileSync(statePathIn(), "utf8")
    const r = await tick(world, T0 + HOUR, { acceptOlderLedger: true, dryRun: true })
    expect(r.sent[0]).toMatch(/accepted an OLDER ledger/)
    expect(readFileSync(statePathIn(), "utf8")).toBe(before)
  })
})

// ── A halted network ─────────────────────────────────────────────────────────

describe.skipIf(PRIV.skip)("a halted network: pinned reads, reminders and the blind-pager check all still run", () => {
  it("halted runs at T-30h, T-23.5h, T-12h, T-1.5h send the 24h and 2h reminders, each saying 'halted', and exit 8", async () => {
    const world = await seeded([[1, submitted()]], [[1, 41]])
    world.halted = true
    world.tipMs = world.nowMs // the ledger froze now
    const out: Array<{ code: number; sent: string[] }> = []
    for (const hoursLeft of [30, 23.5, 12, 1.5]) {
      const r = await tick(world, DUE - hoursLeft * HOUR)
      out.push({ code: r.code, sent: r.sent })
      expect(r.health.at(-1)).toMatchObject({ key: HEALTH_ALERT.key, condition: false })
    }
    expect(out.map((o) => o.code)).toEqual(Array(4).fill(EXIT.NETWORK_HALTED))
    expect(out.map((o) => o.sent.length)).toEqual([0, 1, 0, 1])
    expect(out[1].sent[0]).toMatch(/^⏰ REVIEW DEADLINE in 23h 30m/)
    expect(out[3].sent[0]).toMatch(/^🔴 REVIEW DEADLINE in 1h 30m/)
    for (const m of [out[1].sent[0], out[3].sent[0]]) {
      // A stale tip cannot tell a halted network from a lagging Gateway — the note says both.
      expect(m).toContain(`⛔ The Gateway's ledger tip is`)
      expect(m).toContain(`(state_version ${world.stateVersion},`)
      expect(m).toContain("the network is halted, or this Gateway is behind a live chain")
      expect(m).toContain("releases can still land")
    }
    // Every Gateway read of a halted run was pinned.
    const reads = world.calls.filter((c) => c.path.startsWith("/state/"))
    expect(reads.length).toBeGreaterThan(0)
    for (const c of reads) expect(c.body.at_ledger_state).toBeDefined()
  })

  it("a transition that landed just before the freeze is still paged on a halted run", async () => {
    const world = await seeded([[1, open()]], [[1, 41]])
    world.tasks.set(1, claimed())
    world.stateVersion++
    world.halted = true
    world.tipMs = world.nowMs
    const r = await tick(world, T0 + 3 * HOUR)
    expect(r.code).toBe(EXIT.NETWORK_HALTED)
    expect(r.sent).toEqual([expect.stringMatching(/^🟡 CLAIMED[\s\S]*⛔ The Gateway's ledger tip is/)])
  })

  it("the GUILD_HALT lever with the tip unreadable, on a LIVE chain: a claim and a submission over six runs are all paged", async () => {
    // The lever halts the site, not the network. With no tip to pin to, the
    // run must read the current ledger — pinning to the record froze the pager
    // on the past while reporting healthy.
    const world = await seeded([[1, open()]], [[1, 41]])
    world.tipFail = true
    const pages: string[] = []
    for (let i = 1; i <= 6; i++) {
      if (i === 2) world.tasks.set(1, claimed())
      if (i === 5) world.tasks.set(1, submitted())
      const r = await tick(world, T0 + i * 1800, { lever: true })
      expect(r.code).toBe(EXIT.NETWORK_HALTED)
      expect(r.health.at(-1)).toMatchObject({ condition: false })
      pages.push(...r.sent)
    }
    expect(pages).toEqual([expect.stringMatching(/^🟡 CLAIMED/), expect.stringMatching(/^🟠 SUBMITTED/)])
  })

  it("the lever with the tip unreadable AND unpinned reads refused: pinned at the record, DEGRADED — exit 3 and blind", async () => {
    const world = await seeded([[1, submitted()]], [[1, 41]])
    world.tipFail = true
    world.halted = true
    const r = await tick(world, DUE - 1.5 * HOUR, { lever: true })
    expect(r.code).toBe(EXIT.CHAIN_READ_FAILED)
    expect(r.health.at(-1)).toMatchObject({ condition: true })
    expect(r.sent).toEqual([expect.stringMatching(/^🔴 REVIEW DEADLINE in 1h 30m[\s\S]*Read pinned at the last recorded state_version 1000/)])
  })

  it("a halted run that cannot read even pinned trips the blind-pager check (exit 3)", async () => {
    const world = await seeded([[1, submitted()]])
    world.halted = true
    world.tipMs = world.nowMs
    world.fail["/state/entity/details"] = () => reply({}, 503)
    const r = await tick(world, T0 + 3 * HOUR)
    expect(r.code).toBe(EXIT.CHAIN_READ_FAILED)
    expect(r.health.at(-1)).toMatchObject({ key: HEALTH_ALERT.key, condition: true })
  })

  it("the GUILD_HALT lever: on-chain methods stay live, so pages go out, marked, and exit 8", async () => {
    const world = await seeded([[1, open()]], [[1, 41]])
    world.tasks.set(1, claimed())
    const r = await tick(world, T0 + HOUR, { lever: true })
    expect(r.code).toBe(EXIT.NETWORK_HALTED)
    expect(r.sent).toEqual([expect.stringMatching(/^🟡 CLAIMED[\s\S]*GUILD_HALT lever is engaged/)])
  })

  it("probe blind but unpinned reads refused: retried pinned at the last recorded version — reminders still go out, exit 3, blind", async () => {
    const world = await seeded([[1, submitted()]], [[1, 41]])
    world.halted = true
    world.tipFail = true
    const r = await tick(world, DUE - 1.5 * HOUR)
    expect(r.code).toBe(EXIT.CHAIN_READ_FAILED)
    expect(r.sent).toEqual([expect.stringMatching(/^🔴 REVIEW DEADLINE in 1h 30m[\s\S]*Read pinned at the last recorded state_version 1000/)])
    expect(r.health.at(-1)).toMatchObject({ condition: true })
    expect(readState().tasks["1"].sent).toEqual(["24h", "2h"])
    expect(readState().stateVersion).toBe(1000)
  })

  it("a halt check that throws fails OPEN (the strict chain read still guards the run)", async () => {
    const world = makeWorld([[1, open()]])
    const r = await run(world, {
      checkHalt: async () => {
        throw new Error("tip read exploded")
      },
    })
    expect(r.code).toBe(EXIT.CLEAN)
    expect(r.logs[0]).toMatch(/WARN halt check failed \(tip read exploded\) — treated as unknown/)
    expect(existsSync(statePathIn())).toBe(true)
  })
})

// ── Failure semantics ────────────────────────────────────────────────────────

describe.skipIf(PRIV.skip)("could not look ≠ nothing happened", () => {
  it("a Gateway failure exits non-zero, sends nothing, and leaves the state byte-identical", async () => {
    const world = await seeded([[1, open()]])
    const before = readFileSync(statePathIn(), "utf8")
    world.tasks.set(1, claimed())
    world.fail["/state/key-value-store/data"] = () => reply({}, 502)
    const r = await tick(world, T0 + HOUR)
    expect(r.code).toBe(EXIT.CHAIN_READ_FAILED)
    expect(r.sent).toEqual([])
    expect(readFileSync(statePathIn(), "utf8")).toBe(before)
    expect(r.logs.join("\n")).toMatch(/chain read FAILED — nothing was checked this run, which is NOT the same as nothing happening/)
    expect(r.health.at(-1)).toMatchObject({ key: HEALTH_ALERT.key, condition: true, debounceMs: HEALTH_ALERT.debounceMs })

    // The claim is still paged once the Gateway answers again.
    delete world.fail["/state/key-value-store/data"]
    const again = await tick(world, T0 + 1.5 * HOUR)
    expect(again.code).toBe(EXIT.CLEAN)
    expect(again.sent).toEqual([expect.stringMatching(/^🟡 CLAIMED/)])
    expect(again.health.at(-1)).toMatchObject({ condition: false })
  })

  it("a failure on the very first run creates no state file (the next run is still a seed)", async () => {
    const world = makeWorld([[1, open()]])
    world.fail["/state/entity/details"] = () => {
      throw new Error("getaddrinfo ENOTFOUND")
    }
    const r = await run(world)
    expect(r.code).toBe(EXIT.CHAIN_READ_FAILED)
    expect(existsSync(r.statePath)).toBe(false)
  })

  it("a lagging replica (older state_version than recorded) is refused, not diffed", async () => {
    // The dangerous shape: an older ledger shows the claimed task as still Open.
    // Nothing about that contradicts a marker (a claim CAN vanish — expire_claim),
    // so without the state_version guard this pages a CLAIM EXPIRED that never happened.
    const world = await seeded([[1, claimed()]])
    world.stateVersion = 900
    world.tasks.set(1, open())
    const r = await run(world)
    expect(r.code).toBe(EXIT.CHAIN_READ_FAILED)
    expect(r.sent).toEqual([])
    expect(r.logs.join("\n")).toMatch(/older than the 1000 already recorded/)
  })

  it("a read that has lost tasks the state file already knows is refused", async () => {
    const world = await seeded([[1, open()], [2, open()], [3, claimed()]])
    world.tasks.delete(3)
    const r = await tick(world, T0 + HOUR)
    expect(r.code).toBe(EXIT.CHAIN_READ_FAILED)
    expect(r.sent).toEqual([])
    expect(r.logs.join("\n")).toMatch(/knows task 3 but the component lists 2/)
  })

  it("a read that un-happens a submission is refused even at a newer state_version", async () => {
    const world = await seeded([[1, submitted()]])
    world.tasks.set(1, claimed())
    const r = await tick(world, T0 + 2 * HOUR)
    expect(r.code).toBe(EXIT.CHAIN_READ_FAILED)
    expect(r.logs.join("\n")).toMatch(/submitted_at moved/)
  })

  it("a read that un-happens a dispute is refused, not paged as a 'state change'", async () => {
    const world = await seeded([[1, disputed()]])
    world.tasks.set(1, submitted())
    const r = await tick(world, T0 + 3 * HOUR)
    expect(r.code).toBe(EXIT.CHAIN_READ_FAILED)
    expect(r.sent).toEqual([])
    expect(r.logs.join("\n")).toMatch(/disputed_at moved/)
  })

  it("an undelivered message leaves its task un-advanced; the next run delivers it once", async () => {
    const world = await seeded([[1, open()], [2, open()]], [[1, 41], [2, 42]])
    world.tasks.set(1, claimed())
    world.tasks.set(3, claimed({ badge: "<new_badge>" })) // a NEW id, first seen claimed
    const fail = await tick(world, T0 + HOUR, { sendOk: false })
    expect(fail.code).toBe(EXIT.UNDELIVERED)
    const state = readState()
    expect(state.tasks["1"].state).toBe("Open") // not advanced
    expect(state.tasks["3"]).toBeUndefined() // never recorded, so re-derived as new
    expect(fail.logs.join("\n")).toMatch(/NOT DELIVERED .*kept pending/)

    const ok = await tick(world, T0 + 1.5 * HOUR)
    expect(ok.code).toBe(EXIT.CLEAN)
    expect(ok.sent).toHaveLength(2)
    expect((await tick(world, T0 + 2 * HOUR)).sent).toEqual([])
  })

  it("a send that THROWS is one undelivered page: the others still go out, and nothing is sent twice", async () => {
    const world = await seeded([[1, open()], [2, open()]], [[1, 41], [2, 42]])
    world.tasks.set(1, claimed())
    world.tasks.set(2, claimed({ badge: "<b2>" }))
    const r = await tick(world, T0 + HOUR, { sendThrowsOn: (t) => t.includes("chain 2") })
    expect(r.code).toBe(EXIT.UNDELIVERED)
    expect(r.sent).toEqual([expect.stringMatching(/chain 1/)])
    expect(r.logs.join("\n")).toMatch(/send threw \(socket hang up\)/)
    const again = await tick(world, T0 + 1.5 * HOUR)
    expect(again.sent).toEqual([expect.stringMatching(/chain 2/)])
  })

  it("an unwritable state path is loud (exit 4), never silent", async () => {
    const world = makeWorld([[1, open()]])
    const r = await run(world, { statePath: join(dir, "no-such-dir", "state.json") })
    expect(r.code).toBe(EXIT.STATE_PROBLEM)
    expect(r.logs.join("\n")).toMatch(/could not write .* WILL REPEAT/)
  })

  it("a crash is loud, exits 5, trips the blind-pager alert, and writes nothing", async () => {
    const world = makeWorld([[1, open()]])
    world.fail["/state/entity/details"] = () =>
      ({
        get ok(): boolean {
          throw new TypeError("clock broke")
        },
        status: 200,
        json: async () => ({}),
      }) as unknown as Reply
    const r = await run(world)
    expect(r.code).toBe(EXIT.CRASHED)
    expect(r.logs.join("\n")).toMatch(/CRASH TypeError: clock broke/)
    expect(r.health.at(-1)).toMatchObject({ condition: true, detail: "crashed: clock broke" })
    expect(existsSync(r.statePath)).toBe(false)
  })

  it("--dry-run sends through the injected printer only and writes NO state", async () => {
    const world = makeWorld([[1, lapsedLongAgo()]], [[1, 41]])
    const r = await run(world, { dryRun: true })
    expect(r.code).toBe(EXIT.CLEAN)
    expect(r.sent).toHaveLength(1)
    expect(existsSync(r.statePath)).toBe(false)
    expect(existsSync(backupPathFor(r.statePath))).toBe(false)
    expect(r.logs.join("\n")).toMatch(/DRY-RUN: state NOT written/)
  })
})

describe.skipIf(PRIV.skip)("the blind-pager alert (shared edge-triggered policy, debounced)", () => {
  it("one Gateway blip never pages", async () => {
    const world = await seeded([[1, open()]])
    const messages: string[] = []
    const evaluate = createAlertEvaluator({
      store: new MemoryAlertStore(),
      send: async (text: string) => (messages.push(text), true),
      now: () => world.nowMs,
    })
    world.fail["/state/entity/details"] = () => reply({}, 503)
    expect((await tick(world, T0 + HOUR, { evaluateHealth: evaluate })).code).toBe(EXIT.CHAIN_READ_FAILED)
    delete world.fail["/state/entity/details"]
    expect((await tick(world, T0 + 1.5 * HOUR, { evaluateHealth: evaluate })).code).toBe(EXIT.CLEAN)
    expect(messages).toEqual([])
  })

  it("the third consecutive failed run pages BLIND once; the first good read sends one recovery", async () => {
    const world = await seeded([[1, open()]])
    const messages: string[] = []
    const evaluate = createAlertEvaluator({
      store: new MemoryAlertStore(),
      send: async (text: string) => (messages.push(text), true),
      now: () => world.nowMs,
    })
    world.fail["/state/entity/details"] = () => reply({}, 503)
    for (let i = 0; i < 3; i++) {
      expect((await tick(world, T0 + HOUR + i * 1800, { evaluateHealth: evaluate })).code).toBe(EXIT.CHAIN_READ_FAILED)
    }
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(HEALTH_ALERT.title)
    expect(messages[0]).toContain("HTTP 503")
    delete world.fail["/state/entity/details"]
    expect((await tick(world, T0 + 2.5 * HOUR, { evaluateHealth: evaluate })).code).toBe(EXIT.CLEAN)
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatch(/^🟢/)
  })
})

// ── Board ids ────────────────────────────────────────────────────────────────

describe.skipIf(PRIV.skip)("board-id lookup — enrichment, never a dependency", () => {
  it("maps only the current component's rows and follows the cursor", async () => {
    const pages = [
      { data: [{ id: 70, onChainTaskId: 6, escrowComponent: COMPONENT }, { id: 9, onChainTaskId: 6, escrowComponent: "component_rdx1_test_retired" }], hasMore: true, cursor: "c2" },
      { data: [{ id: 78, onChainTaskId: 14, escrowComponent: COMPONENT }, { id: 5, onChainTaskId: null, escrowComponent: COMPONENT }], hasMore: false, cursor: null },
    ]
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      return reply({ ok: true, ...pages[urls.length - 1] })
    })
    const map = await fetchBoardIds({ siteUrl: SITE, component: COMPONENT, fetchImpl })
    expect([...map.entries()]).toEqual([[6, 70], [14, 78]])
    expect(urls[1]).toContain("cursor=c2")
  })

  it("a lookup failure degrades to the chain id alone — the alert still goes out", async () => {
    const world = await seeded([[1, open()]])
    world.boardFail = true
    world.tasks.set(1, claimed())
    const r = await tick(world, T0 + HOUR)
    expect(r.code).toBe(EXIT.CLEAN)
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toMatch(/^🟡 CLAIMED — chain 1 \(board id unresolved\)\n/)
    expect(r.sent[0]).toContain(`${SITE}/tasks — find on-chain task 1`)
    expect(r.logs.join("\n")).toMatch(/WARN board-id lookup failed/)
  })

  it("board ids are cached in the state file — no lookup once known", async () => {
    const world = await seeded([[1, open()]], [[1, 41]])
    world.tasks.set(1, claimed())
    const r = await tick(world, T0 + HOUR)
    expect(r.sent[0]).toContain("board #41")
    expect(world.calls.some((c) => c.path === "board")).toBe(false)
  })
})

// ── main(): the whole program, as the entry script runs it ───────────────────

describe.skipIf(PRIV.skip)("main()", () => {
  const trapSend = () =>
    vi.fn(async () => {
      throw new Error("main() reached the REAL sender")
    })
  async function runMain(world: World, argv: string[], realSend: (...a: any[]) => Promise<boolean>) {
    const out: string[] = []
    const code = await main({
      argv,
      env: { GUILD_TASK_ACTIVITY_STATE: statePathIn(), GUILD_TASK_ACTIVITY_HEALTH_STAMP: healthPathIn() },
      config: { component: COMPONENT, gateway: GW, siteUrl: SITE },
      realSend,
      fetchImpl: world.fetchImpl,
      now: () => world.nowMs,
      sleep: async () => {},
      sendGapMs: 0,
      write: (l: string) => out.push(l),
      writeErr: (l: string) => out.push(l),
    })
    return { code, out }
  }

  it("--dry-run never touches the real sender and never writes the blind-pager stamp, even while blind", async () => {
    const world = makeWorld([[1, lapsedLongAgo()]])
    world.fail["/state/entity/details"] = () => reply({}, 503)
    const realSend = trapSend()
    for (let i = 0; i < 4; i++) {
      world.nowMs = (T0 + i * 1800) * 1000
      expect((await runMain(world, ["--dry-run"], realSend)).code).toBe(EXIT.CHAIN_READ_FAILED)
    }
    expect(realSend).not.toHaveBeenCalled()
    expect(existsSync(healthPathIn())).toBe(false)
    expect(existsSync(statePathIn())).toBe(false)
  })

  it("--dry-run with a page due prints it and still never touches the real sender", async () => {
    const world = makeWorld([[1, lapsedLongAgo()]])
    const realSend = trapSend()
    const r = await runMain(world, ["--dry-run"], realSend)
    expect(r.code).toBe(EXIT.CLEAN)
    expect(realSend).not.toHaveBeenCalled()
    expect(r.out.join("\n")).toMatch(/DRY-RUN would send:\n🔴 REVIEW WINDOW LAPSED/)
  })

  it("a live run pages through the real sender as a push, reads a fresh tip as NOT halted, and exits 0", async () => {
    const world = makeWorld([[1, lapsedLongAgo()]])
    const realSend = vi.fn(async (_t: string, _o: { silent?: boolean }) => true)
    const r = await runMain(world, [], realSend)
    expect(r.code).toBe(EXIT.CLEAN)
    expect(realSend).toHaveBeenCalledTimes(1)
    expect(realSend.mock.calls[0][1]).toEqual({ silent: false })
    expect(realSend.mock.calls[0][0]).not.toContain("halted")
  })

  it("clean runs through main() with the REAL file stores, then state + .bak deleted and a release in the gap → a LOUD notice", async () => {
    // Nothing here writes the stamp file by hand: after clean runs the alert
    // evaluator has never written it (its state never changed), so only the
    // per-run record can prove the pager ran before.
    const world = makeWorld([[1, submitted()]], [[1, 41]])
    const realSend = vi.fn(async (_t: string, _o: { silent?: boolean }) => true)
    for (let i = 0; i < 3; i++) {
      world.nowMs = (T0 + i * 1800) * 1000
      world.stateVersion++
      expect((await runMain(world, [], realSend)).code).toBe(EXIT.CLEAN)
    }
    expect(realSend).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(healthPathIn(), "utf8"))).toEqual({ [LAST_RUN_KEY]: expect.objectContaining({ exit: 0 }) })
    rmSync(statePathIn())
    rmSync(backupPathFor(statePathIn()))
    world.tasks.set(1, { ...submitted(), state: "Released" }) // money moves in the gap
    world.nowMs = (T0 + 2 * HOUR) * 1000
    world.stateVersion++
    const r = await runMain(world, [], realSend)
    expect(r.code).toBe(EXIT.STATE_PROBLEM)
    expect(realSend).toHaveBeenCalledTimes(1)
    expect(realSend.mock.calls[0][0]).toMatch(/both missing, yet this pager recorded state_version 1003 at .* — RE-SEEDED from chain at state_version 1004/)
    expect(realSend.mock.calls[0][0]).toContain(`Transitions between the last recorded run (${isoMs((T0 + 3600) * 1000)}) and now were NOT paged — check the board.`)
  })

  it("stamps every log line with an ISO time and ends with the exit code and its meaning", async () => {
    const world = makeWorld([[1, open()]])
    const r = await runMain(world, [], vi.fn(async () => true))
    const firstLines = r.out.map((l) => l.split("\n")[0])
    for (const l of firstLines) expect(l).toMatch(/^\[task-activity\] \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /)
    expect(firstLines.at(-1)).toMatch(/exit 0 — clean$/)
  })

  it("a bad argument prints usage and exits 1; --help exits 0", async () => {
    const world = makeWorld([])
    const bad = await runMain(world, ["--live"], trapSend())
    expect(bad.code).toBe(EXIT.USAGE)
    expect(bad.out.join("\n")).toContain("unrecognized argument: --live")
    const help = await runMain(world, ["--help"], trapSend())
    expect(help.code).toBe(EXIT.CLEAN)
    expect(help.out.join("\n")).toContain("--accept-older-ledger")
  })
})

// ── The real entry script under bun ─────────────────────────────────────────

// Three bun cold-starts; each child is bounded at 20s so it — not vitest's 5s
// default — is the timeout that governs on a loaded runner.
vi.setConfig({ testTimeout: 30_000 })

const DEAD = "http://127.0.0.1:9" // closed port: connection refused, instantly

function runEntry(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; output: string }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.KEEPER_ALERT_TG_TOKEN
  delete env.KEEPER_ALERT_TG_CHAT
  Object.assign(env, { GUILD_TASK_ACTIVITY_GATEWAY: DEAD, NEXT_PUBLIC_SITE_URL: DEAD }, extraEnv)
  return new Promise((resolve) => {
    execFile(
      "bun",
      ["--no-env-file", join("scripts", "task-activity-watch.mjs"), ...args],
      { cwd: process.cwd(), env, timeout: 20_000, encoding: "utf8" },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null
        resolve({ code: e ? (typeof e.code === "number" ? e.code : -1) : 0, output: `${stdout}${stderr}` })
      },
    )
  })
}

describe.skipIf(PRIV.skip)("scripts/task-activity-watch.mjs under bun", () => {
  it("loads, and refuses an unknown argument with usage before touching the network", async () => {
    const r = await runEntry(["--live"])
    expect(r.code).toBe(EXIT.USAGE)
    expect(r.output).toContain("unrecognized argument: --live")
    expect(r.output).toContain("Usage: bun scripts/task-activity-watch.mjs [--dry-run] [--accept-older-ledger]")
  })

  it("--help prints usage and exits 0", async () => {
    const r = await runEntry(["--help"])
    expect(r.code).toBe(EXIT.CLEAN)
    expect(r.output).toContain("GUILD_TASK_ACTIVITY_STATE")
  })

  it("passes the run's exit code to the shell: a dead Gateway is exit 3, timestamped, and a dry run writes nothing", async () => {
    const r = await runEntry(["--dry-run"], {
      GUILD_TASK_ACTIVITY_STATE: statePathIn(),
      GUILD_TASK_ACTIVITY_HEALTH_STAMP: healthPathIn(),
    })
    expect(r.code).toBe(EXIT.CHAIN_READ_FAILED)
    expect(r.output).toMatch(/^\[task-activity\] \d{4}-\d\d-\d\dT[\d:.]+Z .*chain read FAILED/m)
    expect(r.output).toMatch(/exit 3 — the current ledger could not be read/)
    expect(readdirSync(dir)).toEqual([])
  })
})

// REVIEW_STAGES is part of the persisted format; pin it so a reorder is a deliberate diff.
it.skipIf(PRIV.skip)("review stages are persisted by name, least urgent first", () => {
  expect(REVIEW_STAGES).toEqual(["24h", "2h", "lapsed"])
})
