/**
 * Reconciler heal-path parity — the RECONCILER actor of applyEscrowConfirm run
 * against real Postgres (pglite), healing a DB that fell behind a chain driven
 * by the real manifests (wallet-mock VM).
 *
 * escrow-confirm-parity.pg.test.ts proves the USER-actor confirm path keeps the
 * DB in lockstep when clients behave. This file proves the recovery WRITE PATH:
 * the reconciler actor of the shared confirm core — the same core
 * scripts/reconcile-escrow.mjs and the per-task resync route call — applies
 * chain-verified heals through the real SQL gates (CAS lifecycle WHERE, unique
 * ledger index, atomic status+ledger+award writes) and cannot use its
 * authz-skip to regress a lifecycle or double-pay an award.
 *
 * SCOPE — what this file does NOT cover (adversarial review 2026-07-16):
 *   • the reconcile-escrow.mjs event LOOP itself: gateway paging + cursor math,
 *     CommittedSuccess/emitter-pin event extraction, EVENT_TO_KIND dispatch,
 *     row lookup via findTaskByOnChainIdOnComponent, the live-state claim
 *     triage (decideClaimHeal — tests/unit/reconcile-claim.test.ts), exit
 *     codes, cursor persistence, TG alerting;
 *   • the resync route's CLAIM leg — escrow-resync.ts applies claim as a USER
 *     actor (receipt-holder proof), not this reconciler path (its own tests);
 *   • the real gateway readers' emitter-pin PARSING (gateway.ts's own tests) —
 *     the mocks here honor the pin's contract (wrong component → null/false)
 *     and decimalField's format gate, but not the JSON traversal.
 *
 * CLOSED BOUNDARY (design/reconciler-claim-heal-boundary-2026-07-16.md): the
 * cron's claim triage (decideClaimHeal) heals from EVERY worker-retaining
 * on-chain state — the blueprint clears worker_account only on expire_claim /
 * cancel-after-claim — so a client-vanished backlog ≥2 steps past claim in one
 * cursor window now auto-heals in stream order (the BOUNDARY test below proves
 * it end-to-end). Residuals that still surface instead of healing: a worker
 * with no guild `users` row, and shapes the triage flags inconsistent.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { eq } from "drizzle-orm"
import * as schema from "@/db/schema"

const A = vi.hoisted(() => ({
  COMPONENT: "component_rdx1cr690hkrk2kv933cw3qdr6amkaphdlu2whjhhh8wppus922yx335r2",
  RECEIPT: "resource_rdx1n2rurpe2efyur5xqvz256yyhecpfjw8ed9v8xxcfxp5mtj9qld9ssq",
  CLAIM_RECEIPT: "resource_rdx1n2x2epej0dyahwjga5rrwnx893rq4f7dxvs9psh74kqak5e9delc4w",
  MEMBER_BADGE: "resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl",
  BOND: 10,
  XRD: "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd",
  ledger: null as import("../support/mock-ledger").MockLedger | null,
  db: null as ReturnType<typeof drizzle> | null,
}))

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

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  isEscrowDeployed: () => true,
  ESCROW_COMPONENT: A.COMPONENT,
  ESCROW_RECEIPT_RESOURCE: A.RECEIPT,
  ESCROW_CLAIM_RECEIPT_RESOURCE: A.CLAIM_RECEIPT,
  ESCROW_CLAIM_BOND_XRD: A.BOND,
  BADGE_NFT: A.MEMBER_BADGE,
}))

// The on-chain consensus time the dispute confirm must PERSIST (not merely
// fall back from) — the mock returns it, the test asserts it round-trips.
const DISPUTED_AT_ONCHAIN = new Date("2026-07-16T04:05:06Z")

// Same format gate as gateway.ts decimalField: a non-decimal string is null,
// so a VM value that wouldn't survive the real parser can't leak through.
const DEC = /^\d+(\.\d+)?$/
const dec = (s: string | null | undefined) => (s != null && DEC.test(s) ? s : null)

// Mocks honor the same fail-closed component pin the real gateway.ts readers
// enforce: a reader queried for the wrong emitter returns null/false, exactly
// as findEventFields' emitter check would.
vi.mock("@/lib/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gateway")>()),
  // Wave B claim-bond reads. `sendClaimTx` derives the bond from LIVE chain
  // state and fails closed when it cannot — correct behaviour, but it means
  // this VM suite must supply the state a real component would, or every claim
  // refuses before a manifest is built. The values mirror the mock ledger's
  // flat bond (A.BOND) via a pct/floor/cap that clamps to it, so the amounts
  // this suite asserts elsewhere do not move.
  readClaimBondParams: async (component: string) =>
    component === A.COMPONENT
      ? { pct: "0", floor: String(A.BOND), cap: String(A.BOND) }
      : null,
  readTaskRewardInfo: async (_taskId: number, component: string) =>
    component === A.COMPONENT ? { rewardToken: A.XRD, rewardAmount: "100" } : null,
  readTokenDivisibility: async () => 18,
  readEscrowTaskCreated: async (intentHash: string, component: string) => {
    if (component !== A.COMPONENT) return null
    const e = A.ledger?.taskCreatedEvent(intentHash)
    return e
      ? { taskId: e.taskId, rewardAmount: dec(e.rewardAmount), rewardToken: e.rewardToken, insuranceAmount: dec(e.insuranceAmount) }
      : null
  },
  // Without this the finalize path would reach the REAL Gateway over the network
  // (A.COMPONENT is the live mainnet address), making this suite depend on mainnet.
  readDisputeAutoResolveDefault: async () => A.ledger?.autoResolveDefault() ?? null,
  readDisputeRaised: async (intentHash: string, component: string, expectedTaskId: number) => {
    if (component !== A.COMPONENT) return null
    const e = A.ledger?.disputeRaisedEvent(intentHash)
    return e && e.taskId === expectedTaskId
      ? { raisedBy: e.raisedBy, confirmedAt: DISPUTED_AT_ONCHAIN }
      : null
  },
  readDisputeAutoResolved: async (intentHash: string, component: string, expectedTaskId: number) => {
    if (component !== A.COMPONENT) return null
    const e = A.ledger?.disputeAutoResolvedEvent(intentHash)
    if (!e || e.taskId !== expectedTaskId) return null
    const workerAmount = dec(e.workerAmount)
    const posterAmount = dec(e.posterAmount)
    // Real reader is fail-closed: either amount unparsable → null.
    return workerAmount !== null && posterAmount !== null ? { workerAmount, posterAmount } : null
  },
  verifyEscrowEvent: async (intentHash: string, eventName: string, component: string, expectedTaskId: number) =>
    component === A.COMPONENT &&
    (A.ledger?.eventsOf(intentHash).some((ev) => ev.name === eventName && ev.taskId === expectedTaskId) ?? false),
}))

import { MockLedger, type OnChainTaskState } from "../support/mock-ledger"
import {
  sendDepositTx,
  sendClaimTx,
  sendSubmitTx,
  sendApproveTx,
  sendCancelTx,
  sendRaiseDisputeTx,
  sendAutoResolveTx,
} from "@/lib/escrow-utils"
import { applyEscrowConfirm, classifyEscrowEvent, type EscrowActor } from "@/lib/escrow-confirm"
import { decideClaimHeal } from "@/lib/reconcile-claim"
import { tasks, escrowTransactions, users } from "@/db/schema"

// DDL mirrors src/db/schema exactly — same block as escrow-confirm-parity.pg.test.ts.
const DDL = `
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
CREATE TABLE tasks (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  hidden_at timestamptz,
  reward_xrd numeric(38,18) NOT NULL DEFAULT '0',
  reward_resource text,
  creator_id text NOT NULL,
  assignee_id text,
  required_tier text DEFAULT 'member',
  xp_reward integer NOT NULL DEFAULT 0,
  on_chain_task_id integer,
  escrow_component text,
  project_id integer,
  working_group_id integer,
  deadline timestamptz,
  disputed_at timestamptz,
  dispute_evidence text,
  dispute_evidence_hash text,
  terms jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tasks_dispute_evidence_paired
    CHECK ((dispute_evidence IS NULL) = (dispute_evidence_hash IS NULL))
);
CREATE UNIQUE INDEX tasks_onchain_component_unique
  ON tasks (on_chain_task_id, escrow_component) WHERE on_chain_task_id IS NOT NULL;
CREATE TABLE escrow_transactions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id integer NOT NULL REFERENCES tasks(id),
  from_user_id text NOT NULL REFERENCES users(id),
  to_user_id text REFERENCES users(id),
  amount_xrd numeric(38,18) NOT NULL,
  reward_resource text,
  tx_type text NOT NULL,
  party text,
  lane text,
  destination text,
  status text NOT NULL DEFAULT 'pending',
  tx_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT escrow_entitlement_fields_present CHECK (
    tx_type NOT IN ('settle', 'withdraw')
    OR (tx_hash IS NOT NULL AND party IS NOT NULL AND lane IS NOT NULL)),
  CONSTRAINT escrow_legacy_rows_have_no_entitlement_fields CHECK (
    tx_type IN ('settle', 'withdraw')
    OR (party IS NULL AND lane IS NULL AND destination IS NULL))
);
CREATE UNIQUE INDEX escrow_legacy_task_tx_type_unique ON escrow_transactions (task_id, tx_type)
  WHERE tx_type IN ('fund', 'release', 'refund', 'dispute');
CREATE UNIQUE INDEX escrow_entitlement_unique ON escrow_transactions (tx_hash, task_id, tx_type, party, lane)
  WHERE tx_type IN ('settle', 'withdraw');`

const POSTER = "account_rdx12ynlx369poster000000000000000000000000000000000000000000"
const WORKER = "account_rdx12890803worker000000000000000000000000000000000000000000"
const KEEPER = "account_rdx12keeper00000000000000000000000000000000000000000000000000"
// Funds one throwaway chain task per test so on-chain ids never align with DB
// row ids (see beforeEach) — no test asserts this account's balances.
const DECOY = "account_rdx12decoy000000000000000000000000000000000000000000000000"

const REWARD = 100
const XP_REWARD = 250
const RECONCILER: EscrowActor = { kind: "reconciler" }
const RECONCILER_WITH_ASSIGNEE: EscrowActor = { kind: "reconciler", resolvedAssignee: WORKER }
const rdt = (signer: string) => A.ledger!.makeRdt(signer) as never

const CHAIN_TO_DB: Record<OnChainTaskState, string[]> = {
  Open: ["open"],
  Claimed: ["assigned"],
  Submitted: ["submitted"],
  Released: ["paid"],
  Refunded: ["cancelled", "refunded"],
  Disputed: ["disputed"],
}

let pg: PGlite

function assertParity(chainTaskId: number, dbStatus: string, note?: string) {
  const chain = A.ledger!.taskState(chainTaskId)
  expect(chain, "on-chain task must exist").not.toBeNull()
  expect(
    CHAIN_TO_DB[chain!],
    `DB status '${dbStatus}' must be in parity with on-chain '${chain}'${note ? ` (${note})` : ""}`,
  ).toContain(dbStatus)
}

async function seedUser(id: string) {
  await A.db!.insert(users).values({ id }).onConflictDoNothing()
}

async function seedDbTask(overrides: Partial<typeof tasks.$inferInsert> = {}) {
  const [row] = await A.db!
    .insert(tasks)
    .values({
      title: "Port the docs widget",
      description: "Port the widget to the new stack",
      creatorId: POSTER,
      rewardXrd: String(REWARD),
      xpReward: XP_REWARD,
      ...overrides,
    })
    .returning()
  return row
}

const refetch = (id: number) => A.db!.select().from(tasks).where(eq(tasks.id, id)).then((r) => r[0])
const ledgerRows = (taskId: number) =>
  A.db!.select().from(escrowTransactions).where(eq(escrowTransactions.taskId, taskId))
const getUser = (id: string) => A.db!.select().from(users).where(eq(users.id, id)).then((r) => r[0])

// ── VM drivers (real manifests) ───────────────────────────────────────────────
async function fundVM() {
  const res = await sendDepositTx({
    rewardXrd: REWARD,
    title: "Port the docs widget",
    description: "Port the widget",
    account: POSTER,
    rdt: rdt(POSTER),
  })
  expect(res.ok, res.error).toBe(true)
  return { fundTxHash: res.txId!, chainTaskId: A.ledger!.taskCreatedEvent(res.txId!)!.taskId }
}
async function claimVM(chainTaskId: number) {
  const res = await sendClaimTx({ escrowComponent: A.COMPONENT, account: WORKER, badgeId: "#1#", taskId: chainTaskId, rdt: rdt(WORKER) })
  expect(res.ok, res.error).toBe(true)
  return res.txId!
}
async function submitVM(chainTaskId: number) {
  const claimReceiptId = A.ledger!.taskRecord(chainTaskId)!.claimReceiptId!
  // SAME title/description fundVM() funded this task with — submit_task now
  // checks a brief_hash arg against the task's committed work_brief_hash.
  const res = await sendSubmitTx({ escrowComponent: A.COMPONENT, account: WORKER, claimReceiptId, taskId: chainTaskId, content: "PR #42", title: "Port the docs widget", description: "Port the widget", rdt: rdt(WORKER) })
  expect(res.ok, res.error).toBe(true)
  return res.txId!
}
async function approveVM(chainTaskId: number, fundTxHash: string) {
  const res = await sendApproveTx({
    escrowComponent: A.COMPONENT,
    account: POSTER,
    receiptId: String(chainTaskId),
    workerAddress: WORKER,
    rewardXrd: REWARD,
    fundTxHash,
    rdt: rdt(POSTER),
  })
  expect(res.ok, res.error).toBe(true)
  return res.txId!
}
async function disputeVM(chainTaskId: number, by: "poster" | "worker" = "worker") {
  const res = await sendRaiseDisputeTx({
    escrowComponent: A.COMPONENT,
    account: by === "worker" ? WORKER : POSTER,
    taskId: chainTaskId,
    proofResource: by === "worker" ? A.MEMBER_BADGE : A.RECEIPT,
    proofLocalId: by === "worker" ? "#1#" : `#${chainTaskId}#`,
    rdt: rdt(POSTER),
  })
  expect(res.ok, res.error).toBe(true)
  return res.txId!
}
async function resolveVM(chainTaskId: number, _fundTxHash: string, _disputeTxHash: string) {
  // PULL: the app's real finalize is a BARE trigger — no routing, no amounts,
  // no accounts. The component credits both entitlements internally, so this
  // suite now drives the same manifest production signs.
  //
  // It used to drive tests/support/push-finalize.ts, a hand-written copy of the
  // pre-cutover routing kept alive only because MockLedger still modelled the
  // push component. That file set its own exit condition — "when the cutover
  // lands AND the mock is re-modelled for pull, this file and its callers retire
  // together" — and both halves are now true, so it is deleted.
  const res = await sendAutoResolveTx({ escrowComponent: A.COMPONENT, taskId: chainTaskId, rdt: rdt(KEEPER) })
  expect(res.ok, res.error).toBe(true)
  return res.txId!
}

/**
 * The reconciler's starting point: a DB row whose CREATE was confirmed (the
 * one kind the reconciler can never heal — it needs the poster's intent to
 * bind a chain id to a row), after which the client vanished.
 */
async function fundedDbRow() {
  const dbTask = await seedDbTask()
  const { fundTxHash, chainTaskId } = await fundVM()
  const created = await applyEscrowConfirm(dbTask, "create", fundTxHash, { kind: "user", userId: POSTER })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  return { row: (created as { task: typeof dbTask }).task, fundTxHash, chainTaskId }
}

describe("reconciler heal-path parity (pglite + wallet-mock VM)", () => {
  // 60s: see escrow-confirm-parity.pg.test.ts — concurrent WASM-Postgres init
  // under a full-suite run exceeds the 10s default hook timeout.
  beforeAll(async () => {
    pg = new PGlite()
    A.db = drizzle(pg, { schema })
    await pg.exec(DDL)
  }, 60_000)

  beforeEach(async () => {
    await pg.exec("TRUNCATE tasks, escrow_transactions, users RESTART IDENTITY")
    A.ledger = new MockLedger({
      escrowComponent: A.COMPONENT,
      receiptResource: A.RECEIPT,
      claimReceiptResource: A.CLAIM_RECEIPT,
      claimBondXrd: A.BOND,
      disputeAutoResolveDefault: "SplitEvenly", // the LIVE component's value
    })
    A.ledger.seedAccount(POSTER, { xrd: 500 })
    A.ledger.seedAccount(WORKER, { xrd: 50, badges: [{ resource: A.MEMBER_BADGE, id: "#1#" }] })
    A.ledger.seedAccount(KEEPER, { xrd: 0 })
    await seedUser(POSTER)
    await seedUser(WORKER)

    // DE-ALIGN ids (review HIGH: with row id == chain id == 1 everywhere, an
    // id-transposition mutant in escrow-confirm.ts passed the whole file).
    // Burn chain task #1 on a decoy account and DB rows #1-2, so the real
    // test rows sit at DB id ≥ 3 vs chain id ≥ 2 — any task.id ↔
    // onChainTaskId swap now fails event verification or the ledger FK.
    A.ledger.seedAccount(DECOY, { xrd: 200 })
    const burn = await sendDepositTx({
      rewardXrd: 50, title: "decoy", description: "decoy", account: DECOY, rdt: rdt(DECOY),
    })
    expect(burn.ok, burn.error).toBe(true)
    await seedDbTask({ title: "decoy-row-1" })
    await seedDbTask({ title: "decoy-row-2" })
  })

  it("cron-realistic heal: each lost confirm healed in the window the cron can act, ending in full parity with XP exactly once", async () => {
    // The common cadence: each event lands in its own cursor window, so every
    // heal runs while the chain is one step ahead at most. (The BOUNDARY test
    // below covers the whole-lifecycle-in-one-window backlog.)
    const { row, fundTxHash, chainTaskId } = await fundedDbRow()

    const claimTx = await claimVM(chainTaskId)
    expect(A.ledger!.taskState(chainTaskId)).toBe("Claimed") // the heal window
    expect(classifyEscrowEvent("claim", await refetch(row.id))).toBe("healable")
    let r = await applyEscrowConfirm(await refetch(row.id), "claim", claimTx, RECONCILER_WITH_ASSIGNEE)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    let cur = await refetch(row.id)
    expect(cur.status).toBe("assigned")
    expect(cur.assigneeId).toBe(WORKER) // bound from the RESOLVED assignee, not a caller claim
    assertParity(chainTaskId, cur.status, "after claim heal")

    const submitTx = await submitVM(chainTaskId)
    r = await applyEscrowConfirm(await refetch(row.id), "submit", submitTx, RECONCILER)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    assertParity(chainTaskId, (await refetch(row.id)).status, "after submit heal")

    const approveTx = await approveVM(chainTaskId, fundTxHash)
    r = await applyEscrowConfirm(await refetch(row.id), "approve", approveTx, RECONCILER)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    cur = await refetch(row.id)
    expect(cur.status).toBe("paid")
    assertParity(chainTaskId, cur.status, "after approve heal")

    // Money ledger rebuilt from chain truth; worker credited exactly once.
    const rows = await ledgerRows(row.id)
    const release = rows.find((t) => t.txType === "release")
    expect(Number(release!.amountXrd)).toBe(REWARD)
    expect(release!.toUserId).toBe(WORKER)
    expect(release!.txHash).toBe(approveTx)
    expect((await getUser(WORKER)).xp).toBe(XP_REWARD)

    // A cron re-run replays the same approve — the unique ledger index makes it
    // a no-op: no duplicate row, no second award.
    const replay = await applyEscrowConfirm(cur, "approve", approveTx, RECONCILER)
    expect(replay.ok).toBe(true)
    expect((await ledgerRows(row.id)).filter((t) => t.txType === "release")).toHaveLength(1)
    expect((await getUser(WORKER)).xp).toBe(XP_REWARD)
  })

  it("BOUNDARY (closed): a whole client-vanished lifecycle in one cursor window auto-heals in stream order off the retained worker_account", async () => {
    const { row, fundTxHash, chainTaskId } = await fundedDbRow()

    // The whole lifecycle completes ON-CHAIN before any heal runs — the case
    // that used to surface as unreconcilable (heal gated on live state ==
    // Claimed) and forfeit on cursor advance.
    const claimTx = await claimVM(chainTaskId)
    const submitTx = await submitVM(chainTaskId)
    const approveTx = await approveVM(chainTaskId, fundTxHash)
    expect(A.ledger!.taskState(chainTaskId)).toBe("Released")
    expect((await refetch(row.id)).status).toBe("open") // DB is 3 transitions behind

    // The classifier triage on the stale row, pinned exactly: submit/approve
    // history is SUPERSEDED against 'open' (they cannot start the replay), but
    // claim is keyed on the NULL ASSIGNEE — the mainnet-smoke stuck-claim
    // finding — so the claim event is what unlocks the backlog.
    expect(classifyEscrowEvent("submit", await refetch(row.id))).toBe("superseded")
    // The distinguishing case a status-based classifier gets WRONG (it would
    // say superseded — paid ∉ ALLOWED_FROM.claim ∪ REFLECTED_IN.claim):
    expect(classifyEscrowEvent("claim", { status: "paid", assigneeId: null })).toBe("healable")

    // The cron's claim triage (decideClaimHeal — the exact decision fn
    // reconcile-escrow.mjs runs): the live state is Released, no longer
    // Claimed, but the blueprint RETAINS worker_account through
    // submit/approve (lib.rs clears it only on expire/cancel-after-claim) —
    // so the worker resolves from chain truth and the verdict is HEAL.
    const live = A.ledger!.taskRecord(chainTaskId)!
    expect(live.worker).toBe(WORKER) // retained on-chain after settlement
    const decision = decideClaimHeal({
      dbStatus: (await refetch(row.id)).status,
      onChainState: A.ledger!.taskState(chainTaskId),
      workerAccount: live.worker,
    })
    expect(decision).toEqual({ action: "heal", assignee: WORKER })

    // The cron then replays the window's events in stream order, re-fetching
    // the row per event (reconcile-escrow.mjs handleEvent) — each verdict
    // flips to healable as the previous heal lands, ending in full parity
    // with the award exactly once.
    for (const [kind, tx, actor] of [
      ["claim", claimTx, { kind: "reconciler", resolvedAssignee: decision.assignee } as EscrowActor],
      ["submit", submitTx, RECONCILER],
      ["approve", approveTx, RECONCILER],
    ] as const) {
      expect(classifyEscrowEvent(kind, await refetch(row.id)), `${kind} should be healable in order`).toBe(
        "healable",
      )
      const r = await applyEscrowConfirm(await refetch(row.id), kind, tx, actor)
      expect(r.ok, `${kind}: ${JSON.stringify(r)}`).toBe(true)
    }
    const cur = await refetch(row.id)
    expect(cur.status).toBe("paid")
    expect(cur.assigneeId).toBe(WORKER)
    assertParity(chainTaskId, cur.status, "after in-order auto-heal")
    expect((await getUser(WORKER)).xp).toBe(XP_REWARD)
  })

  it("claim without a resolved assignee is NOT_RECONCILABLE — never guessed, DB untouched", async () => {
    const { row, chainTaskId } = await fundedDbRow()
    const claimTx = await claimVM(chainTaskId)

    const r = await applyEscrowConfirm(row, "claim", claimTx, RECONCILER)
    expect(r.ok).toBe(false)
    expect((r as { code: string }).code).toBe("NOT_RECONCILABLE")
    expect((r as { httpStatus: number }).httpStatus).toBe(501)
    const after = await refetch(row.id)
    expect(after.status).toBe("open")
    expect(after.assigneeId).toBeNull()
  })

  it("create is NOT_RECONCILABLE for the reconciler — binding a chain id needs the poster's intent", async () => {
    const dbTask = await seedDbTask()
    const { fundTxHash } = await fundVM()
    const r = await applyEscrowConfirm(dbTask, "create", fundTxHash, RECONCILER)
    expect(r.ok).toBe(false)
    expect((r as { code: string }).code).toBe("NOT_RECONCILABLE")
    expect((await refetch(dbTask.id)).onChainTaskId).toBeNull()
  })

  it("the authz-skip cannot regress a lifecycle: a stale claim event on a paid task is refused", async () => {
    const { row, fundTxHash, chainTaskId } = await fundedDbRow()
    const claimTx = await claimVM(chainTaskId)
    const submitTx = await submitVM(chainTaskId)
    const approveTx = await approveVM(chainTaskId, fundTxHash)

    await applyEscrowConfirm(await refetch(row.id), "claim", claimTx, RECONCILER_WITH_ASSIGNEE)

    // Event pinning holds for the reconciler too: healing 'submit' with the
    // CLAIM tx (a real, committed tx — but carrying no WorkSubmittedEvent for
    // this task) fails verification. The authz skip never skips event checks.
    let r = await applyEscrowConfirm(await refetch(row.id), "submit", claimTx, RECONCILER)
    expect(r.ok).toBe(false)
    expect((r as { code: string }).code).toBe("EVENT_NOT_VERIFIED")

    // Heal properly to the terminal state.
    r = await applyEscrowConfirm(await refetch(row.id), "submit", submitTx, RECONCILER)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    r = await applyEscrowConfirm(await refetch(row.id), "approve", approveTx, RECONCILER)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect((await refetch(row.id)).status).toBe("paid")

    // THE regression case: the chain-verified claim event is now STALE history.
    // classify keys claim on the assignee (set → reflected, so the cron would
    // skip it), and even a direct confirm hits the lifecycle gate in the SQL.
    expect(classifyEscrowEvent("claim", await refetch(row.id))).toBe("reflected")
    const stale = await applyEscrowConfirm(await refetch(row.id), "claim", claimTx, RECONCILER_WITH_ASSIGNEE)
    expect(stale.ok).toBe(false)
    expect((stale as { code: string }).code).toBe("INVALID_STATE")
    expect((await refetch(row.id)).status).toBe("paid") // not regressed
  })

  /** Drive a task to Submitted with both heals applied; returns the row id + chain id. */
  async function healedToSubmitted() {
    const { row, fundTxHash, chainTaskId } = await fundedDbRow()
    const claimTx = await claimVM(chainTaskId)
    const submitTx = await submitVM(chainTaskId)
    await applyEscrowConfirm(await refetch(row.id), "claim", claimTx, RECONCILER_WITH_ASSIGNEE)
    await applyEscrowConfirm(await refetch(row.id), "submit", submitTx, RECONCILER)
    return { row, fundTxHash, chainTaskId }
  }

  it("dispute heal attributes the marker to the WORKER when raised_by=Worker, and persists the on-chain disputed_at", async () => {
    const { row, chainTaskId } = await healedToSubmitted()

    const disputeTx = await disputeVM(chainTaskId, "worker")
    const r = await applyEscrowConfirm(await refetch(row.id), "dispute", disputeTx, RECONCILER)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const cur = await refetch(row.id)
    expect(cur.status).toBe("disputed")
    // The CONSENSUS time round-trips — not the new Date() confirm-time fallback
    // (the value the 72h finalize countdown displays).
    expect(cur.disputedAt).toEqual(DISPUTED_AT_ONCHAIN)
    assertParity(chainTaskId, cur.status, "after dispute heal")

    // raised_by=Worker on-chain → the 0-amount marker row is attributed to the
    // ASSIGNEE (the worker), not the creator and not some caller identity.
    const marker = (await ledgerRows(row.id)).find((t) => t.txType === "dispute")
    expect(marker!.fromUserId).toBe(WORKER)
    expect(Number(marker!.amountXrd)).toBe(0)
  })

  it("dispute heal attributes the marker to the POSTER when raised_by=Poster — even though an assignee exists", async () => {
    // Kills the always-attribute-the-assignee mutant the review proved
    // invisible: the assignee IS set here, so only reading the verified
    // raised_by from the event can pick the poster.
    const { row, chainTaskId } = await healedToSubmitted()
    expect((await refetch(row.id)).assigneeId).toBe(WORKER)

    const disputeTx = await disputeVM(chainTaskId, "poster")
    const r = await applyEscrowConfirm(await refetch(row.id), "dispute", disputeTx, RECONCILER)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const marker = (await ledgerRows(row.id)).find((t) => t.txType === "dispute")
    expect(marker!.fromUserId).toBe(POSTER)
  })

  it("cancel heal: an on-chain cancel_task is mirrored to cancelled + a refund row to the poster", async () => {
    const { row, chainTaskId } = await fundedDbRow()
    const res = await sendCancelTx({
      escrowComponent: A.COMPONENT,
      account: POSTER,
      taskId: chainTaskId,
      phase: "open",
      rdt: rdt(POSTER),
    })
    expect(res.ok, res.error).toBe(true)
    expect(A.ledger!.taskState(chainTaskId)).toBe("Refunded")

    const r = await applyEscrowConfirm(await refetch(row.id), "cancel", res.txId!, RECONCILER)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const cur = await refetch(row.id)
    expect(cur.status).toBe("cancelled")
    assertParity(chainTaskId, cur.status, "after cancel heal")
    const refund = (await ledgerRows(row.id)).find((t) => t.txType === "refund")
    expect(refund!.toUserId).toBe(POSTER)
    expect(Number(refund!.amountXrd)).toBe(REWARD)
  })

  it("resolve heal writes BOTH legs from the verified SplitEvenly event amounts and lands in parity", async () => {
    const { row, fundTxHash, chainTaskId } = await fundedDbRow()
    const claimTx = await claimVM(chainTaskId)
    const submitTx = await submitVM(chainTaskId)
    await applyEscrowConfirm(await refetch(row.id), "claim", claimTx, RECONCILER_WITH_ASSIGNEE)
    await applyEscrowConfirm(await refetch(row.id), "submit", submitTx, RECONCILER)
    const disputeTx = await disputeVM(chainTaskId, "worker")
    await applyEscrowConfirm(await refetch(row.id), "dispute", disputeTx, RECONCILER)

    const resolveTx = await resolveVM(chainTaskId, fundTxHash, disputeTx)
    const r = await applyEscrowConfirm(await refetch(row.id), "resolve", resolveTx, RECONCILER)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const cur = await refetch(row.id)
    expect(cur.status).toBe("paid") // worker share > 0
    assertParity(chainTaskId, cur.status, "after resolve heal")

    // 50 / 55, not 52.5 / 52.5 — SplitEvenly governs the REWARD only; the
    // insurance premium returns whole to the poster because nobody judged
    // (lib.rs's auto-resolve `credit_split_for_parties` call, hardcoded to
    // `&DisputeRuling::RefundPoster` for the insurance leg). The heal reads both amounts off the verified event, so this
    // asserts it copies the CHAIN's arithmetic rather than recomputing a split.
    const rows = await ledgerRows(row.id)
    expect(Number(rows.find((t) => t.txType === "release")!.amountXrd)).toBe(50)
    expect(rows.find((t) => t.txType === "release")!.toUserId).toBe(WORKER)
    expect(Number(rows.find((t) => t.txType === "refund")!.amountXrd)).toBe(55)
    expect(rows.find((t) => t.txType === "refund")!.toUserId).toBe(POSTER)
    expect((await getUser(WORKER)).xp).toBe(XP_REWARD) // exactly once
  })
})
