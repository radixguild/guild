/**
 * Confirm-route DB↔chain PARITY — the real applyEscrowConfirm executed against a
 * real Postgres (pglite), fed real on-chain events by the wallet-mock VM.
 *
 * WHAT WAS MISSING
 * ----------------
 * The confirm core (src/lib/escrow-confirm.ts) is the single writer that keeps
 * the DB in step with the escrow chain. Its two existing test seams each mock
 * away half of what it actually does:
 *   • escrow-confirm.test.ts (unit) mocks `@/db` AND every query helper — it
 *     proves the CONTROL FLOW but never the SQL: the CAS `WHERE status IN (...)`
 *     lifecycle gate, `captureEscrowIdIfUnset`'s partial-unique-index CAS +
 *     23505 handling, `recordConfirmedEscrowTx`'s `onConflictDoNothing` against
 *     the real `escrow_legacy_task_tx_type_unique` index, and the atomic
 *     status+ledger+award transaction.
 *   • api-lifecycle.test.ts seeds a FAKE in-memory store with "what the confirm
 *     would have written" and mocks `@/db/queries/escrow` entirely.
 *   • escrow-settlement.e2e / escrow-dispute.e2e drive the real chain VM but
 *     never touch the DB.
 *
 * So nothing proved the confirm route's SQL keeps the DB in PARITY with the
 * chain across a real lifecycle. This does: it runs the REAL applyEscrowConfirm
 * against a REAL Postgres, driving each on-chain transition through the same
 * wallet-mock VM the settlement/dispute e2e use, and after every confirm asserts
 * the DB row is in lockstep with the LIVE on-chain TaskState — the exact drift
 * the escrow-drift-watch cron exists to catch, here proven never to open.
 *
 * Only three edges are mocked, all the same way the e2e harnesses mock them:
 * `@/db` → the pglite drizzle; `@/lib/config` → deployed + pinned addresses;
 * `@/lib/gateway`'s chain readers → delegated to the VM that executed the
 * manifests (so the "on-chain" event a confirm verifies is genuinely what
 * happened). Everything in escrow-confirm.ts — the real query helpers, real
 * transactions, real indexes — runs untouched.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { eq } from "drizzle-orm"
import * as schema from "@/db/schema"

// Pinned addresses + the per-test VM ledger + the pglite drizzle — hoisted so the
// vi.mock factories (hoisted above imports) can reference them.
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

// Point `@/db` at the pglite-backed drizzle. The Proxy binds methods to the real
// instance so drizzle's `this` (and db.transaction) is preserved — same shape as
// task-pagination.pg.test.ts.
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

// Same format gate as gateway.ts decimalField (fail-closed on non-decimals).
const DEC = /^\d+(\.\d+)?$/
const dec = (s: string | null | undefined) => (s != null && DEC.test(s) ? s : null)

// Every chain reader the confirm core (and the VM senders' own re-reads) use is
// delegated to the ledger that executed the manifests — so the event a confirm
// verifies is genuinely the one the tx emitted, task_id-pinned AND
// component-pinned exactly as the real gateway pins it (wrong component →
// null/false, mirroring findEventFields' fail-closed emitter check).
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
      ? { taskId: e.taskId, rewardAmount: dec(e.rewardAmount), rewardToken: e.rewardToken, insuranceAmount: dec(e.insuranceAmount), poster: e.poster, workBriefHash: e.workBriefHash }
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
    return workerAmount !== null && posterAmount !== null ? { workerAmount, posterAmount } : null
  },
  verifyEscrowEvent: async (intentHash: string, eventName: string, component: string, expectedTaskId: number) =>
    component === A.COMPONENT &&
    (A.ledger?.eventsOf(intentHash).some((ev) => ev.name === eventName && ev.taskId === expectedTaskId) ?? false),
  // The user-actor claim confirm proves the caller holds the task's LIVE claim
  // receipt: read current_claim_receipt_id from the task record (the VM's
  // equivalent of the tasks KV entry), then check the caller's actual VM
  // holdings for exactly that NFT — same two-step the real gateway performs.
  readOnChainClaimInfo: async (onChainTaskId: number, component: string) => {
    if (component !== A.COMPONENT) {
      throw new Error(`readOnChainClaimInfo: wrong component ${component}`)
    }
    const rec = A.ledger?.taskRecord(onChainTaskId)
    if (!rec) return { state: null, workerAccount: null, currentClaimReceiptId: null }
    return {
      state: A.ledger!.taskState(onChainTaskId),
      workerAccount: rec.worker,
      currentClaimReceiptId: A.ledger!.taskState(onChainTaskId) === "Claimed" ? rec.claimReceiptId : null,
    }
  },
  holdsClaimReceipt: async (account: string, res: string, receiptId: number) =>
    A.ledger?.nftsOf(account).some((n) => n.resource === res && n.id === `#${receiptId}#`) ?? false,
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
import { applyEscrowConfirm } from "@/lib/escrow-confirm"
import { tasks, escrowTransactions, users } from "@/db/schema"

// DDL mirrors src/db/schema exactly (FK constraints omitted — drizzle builds SQL
// from schema metadata, PG only enforces FKs at insert, and we seed parents
// first anyway). The two unique indexes ARE included — they are the whole point:
// escrow_legacy_task_tx_type_unique gates the once-only ledger write, and the partial
// tasks_onchain_component_unique gates the old→vNext on-chain-id collision.
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

// Accounts double as DB user ids (schema: users.id = Radix account address).
const POSTER = "account_rdx12ynlx369poster000000000000000000000000000000000000000000"
const WORKER = "account_rdx12890803worker000000000000000000000000000000000000000000"
const KEEPER = "account_rdx12keeper00000000000000000000000000000000000000000000000000"
// Funds one throwaway chain task per test so on-chain ids never align with DB
// row ids (see beforeEach) — no test asserts this account's balances.
const DECOY = "account_rdx12decoy000000000000000000000000000000000000000000000000"

const REWARD = 100
const INSURANCE = Math.ceil(REWARD * 0.05) // 5
const XP_REWARD = 250 // task's stored xpReward → the exact XP a payout must credit
const rdt = (signer: string) => A.ledger!.makeRdt(signer) as never

// The canonical map the confirm route is supposed to maintain: each LIVE on-chain
// TaskState and the DB status(es) that are in parity with it. Refunded is two-way
// (cancel → cancelled; poster-favoured resolve → refunded).
const CHAIN_TO_DB: Record<OnChainTaskState, string[]> = {
  Open: ["open"],
  Claimed: ["assigned"],
  Submitted: ["submitted"],
  Released: ["paid"],
  Refunded: ["cancelled", "refunded"],
  Disputed: ["disputed"],
}

let pg: PGlite

/** Assert the DB status is in parity with the task's LIVE on-chain state. */
function assertParity(chainTaskId: number, dbStatus: string, note?: string) {
  const chain = A.ledger!.taskState(chainTaskId)
  expect(chain, "on-chain task must exist").not.toBeNull()
  expect(
    CHAIN_TO_DB[chain!],
    `DB status '${dbStatus}' must be in parity with on-chain '${chain}'${note ? ` (${note})` : ""}`,
  ).toContain(dbStatus)
}

/** Insert a DB user (idempotent within a test via the fresh TRUNCATE). */
async function seedUser(id: string) {
  await A.db!.insert(users).values({ id }).onConflictDoNothing()
}

/** Insert an unfunded DB task row and return the full row applyEscrowConfirm reads. */
async function seedDbTask(overrides: Partial<typeof tasks.$inferInsert> = {}) {
  const [row] = await A.db!
    .insert(tasks)
    .values({
      title: "Port the docs widget",
      // The SAME text fundVM commits on-chain: the create confirm now binds the
      // row to its work_brief_hash (GM-1), as a real poster's row always is.
      description: "Port the widget",
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

// ── VM drivers: execute the REAL manifests, return the intent hash to confirm ──
async function fundVM(reward = REWARD) {
  const res = await sendDepositTx({
    rewardXrd: reward,
    title: "Port the docs widget",
    description: "Port the widget",
    account: POSTER,
    rdt: rdt(POSTER),
  })
  expect(res.ok, res.error).toBe(true)
  return { fundTxHash: res.txId!, chainTaskId: A.ledger!.taskCreatedEvent(res.txId!)!.taskId }
}
async function claimVM(chainTaskId: number) {
  const res = await sendClaimTx({ escrowComponent: A.COMPONENT, account: WORKER, badgeId: "#77#", taskId: chainTaskId, rdt: rdt(WORKER) })
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
async function approveVM(chainTaskId: number, fundTxHash: string, reward = REWARD) {
  const res = await sendApproveTx({
    escrowComponent: A.COMPONENT,
    account: POSTER,
    receiptId: String(chainTaskId),
    workerAddress: WORKER,
    rewardXrd: reward,
    fundTxHash,
    rdt: rdt(POSTER),
  })
  expect(res.ok, res.error).toBe(true)
  return res.txId!
}
async function disputeVM(chainTaskId: number) {
  const res = await sendRaiseDisputeTx({ escrowComponent: A.COMPONENT, account: WORKER, taskId: chainTaskId, proofResource: A.MEMBER_BADGE, proofLocalId: "#77#", rdt: rdt(WORKER) })
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
async function cancelVM(chainTaskId: number) {
  const res = await sendCancelTx({ escrowComponent: A.COMPONENT, account: POSTER, taskId: chainTaskId, phase: "open", rdt: rdt(POSTER) })
  expect(res.ok, res.error).toBe(true)
  return res.txId!
}

/** create → claim → submit, confirming each; returns { row, fundTxHash, chainTaskId }. */
async function driveToSubmitted() {
  const dbTask = await seedDbTask()
  const { fundTxHash, chainTaskId } = await fundVM()
  let r = await applyEscrowConfirm(dbTask, "create", fundTxHash, { kind: "user", userId: POSTER })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  const claimTx = await claimVM(chainTaskId)
  r = await applyEscrowConfirm((r as { task: typeof dbTask }).task, "claim", claimTx, { kind: "user", userId: WORKER })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  const submitTx = await submitVM(chainTaskId)
  r = await applyEscrowConfirm((r as { task: typeof dbTask }).task, "submit", submitTx, { kind: "user", userId: WORKER })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return { row: (r as { task: typeof dbTask }).task, fundTxHash, chainTaskId }
}

describe("confirm-route DB↔chain parity (pglite + wallet-mock VM)", () => {
  // 60s: three pglite files init WASM Postgres concurrently under a full-suite
  // run — contention pushes cold init past vitest's 10s default hook timeout
  // (observed ~10.1s timeouts skipping all tests in the file).
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
      // The LIVE mainnet component's default (operator-verified 2026-07-16).
      disputeAutoResolveDefault: "SplitEvenly",
    })
    A.ledger.seedAccount(POSTER, { xrd: 500 })
    // Badge id deliberately ≠ any claim-receipt id (receipts mint from #1#):
    // with both at #1#, the real-holdings check degenerates — a wrong-resource
    // mutant (badge for receipt) would match the badge and pass (review 2026-07-17).
    A.ledger.seedAccount(WORKER, { xrd: 50, badges: [{ resource: A.MEMBER_BADGE, id: "#77#" }] })
    A.ledger.seedAccount(KEEPER, { xrd: 0 })
    await seedUser(POSTER)
    await seedUser(WORKER)

    // DE-ALIGN ids (review HIGH: with row id == chain id == 1 everywhere, an
    // id-transposition mutant in escrow-confirm.ts passed both parity files).
    // Burn chain task #1 on a decoy account and DB rows #1-2, so real test
    // rows sit at DB id ≥ 3 vs chain id ≥ 2 — a task.id ↔ onChainTaskId swap
    // now fails event verification or the ledger FK instead of passing.
    A.ledger.seedAccount(DECOY, { xrd: 200 })
    const burn = await sendDepositTx({
      rewardXrd: 50, title: "decoy", description: "decoy", account: DECOY, rdt: rdt(DECOY),
    })
    expect(burn.ok, burn.error).toBe(true)
    await seedDbTask({ title: "decoy-row-1" })
    await seedDbTask({ title: "decoy-row-2" })
  })

  it("full lifecycle: every confirm advances the DB in lockstep with on-chain state; the money ledger matches the chain", async () => {
    const dbTask = await seedDbTask()

    // ── create: capture the on-chain id + fund ledger row (status unchanged) ──
    const { fundTxHash, chainTaskId } = await fundVM()
    let res = await applyEscrowConfirm(dbTask, "create", fundTxHash, { kind: "user", userId: POSTER })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    let row = (res as { task: typeof dbTask }).task
    expect(row.onChainTaskId).toBe(chainTaskId)
    expect(row.escrowComponent).toBe(A.COMPONENT)
    assertParity(chainTaskId, row.status, "after create — still Open/open")
    const fundRow = (await ledgerRows(row.id)).find((t) => t.txType === "fund")
    expect(fundRow, "create writes the fund ledger row").toBeTruthy()
    expect(Number(fundRow!.amountXrd)).toBe(REWARD)
    expect(fundRow!.txHash).toBe(fundTxHash)

    // ── claim: worker bound as assignee (proved by holding the claim receipt) ──
    const claimTx = await claimVM(chainTaskId)
    res = await applyEscrowConfirm(row, "claim", claimTx, { kind: "user", userId: WORKER })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    row = (res as { task: typeof dbTask }).task
    expect(row.status).toBe("assigned")
    expect(row.assigneeId).toBe(WORKER)
    assertParity(chainTaskId, row.status, "after claim")

    // ── submit: status-only sync ──
    const submitTx = await submitVM(chainTaskId)
    res = await applyEscrowConfirm(row, "submit", submitTx, { kind: "user", userId: WORKER })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    row = (res as { task: typeof dbTask }).task
    expect(row.status).toBe("submitted")
    assertParity(chainTaskId, row.status, "after submit")

    // ── approve: the money leg — release row + worker XP, terminal `paid` ──
    const approveTx = await approveVM(chainTaskId, fundTxHash)
    res = await applyEscrowConfirm(row, "approve", approveTx, { kind: "user", userId: POSTER })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    row = (res as { task: typeof dbTask }).task
    expect(row.status).toBe("paid")
    assertParity(chainTaskId, row.status, "after approve")

    // The chain SETTLED the reward to the worker; the DB ledger records it.
    //
    // ⚠️ Read the two assertions together — this is the honest gap pull opens.
    // The DB says `paid` and writes a release row, and the worker's account has
    // not moved: the reward is an entitlement inside the component until they
    // sign for it. `paid` here means "the poster's obligation is discharged",
    // not "the money is in the worker's wallet". That distinction is exactly
    // what the entitlement ledger (escrow-entitlements.ts) exists to keep
    // honest, and asserting the old push balance here would have hidden it.
    expect(A.ledger!.taskState(chainTaskId)).toBe("Released")
    expect(A.ledger!.balanceOf(WORKER)).toBe(50) // untouched — settlement is not payment
    expect(A.ledger!.owed(chainTaskId, "Worker")).toBe(REWARD)
    const releaseRow = (await ledgerRows(row.id)).find((t) => t.txType === "release")
    expect(releaseRow, "approve writes the release ledger row").toBeTruthy()
    expect(Number(releaseRow!.amountXrd)).toBe(REWARD)
    expect(releaseRow!.toUserId).toBe(WORKER)
    expect(releaseRow!.txHash).toBe(approveTx)

    // Worker's XP/reputation credited exactly the task's stored reward.
    const worker = await getUser(WORKER)
    expect(worker.xp).toBe(XP_REWARD)
    expect(worker.reputation).toBeGreaterThan(0)
  })

  it("approve is idempotent against the real unique index — a replay never double-awards XP nor duplicates the release row", async () => {
    const { row, fundTxHash, chainTaskId } = await driveToSubmitted()
    const approveTx = await approveVM(chainTaskId, fundTxHash)

    const first = await applyEscrowConfirm(row, "approve", approveTx, { kind: "user", userId: POSTER })
    expect(first.ok, JSON.stringify(first)).toBe(true)
    const paidRow = (first as { task: typeof row }).task
    const workerAfterFirst = await getUser(WORKER)
    expect(workerAfterFirst.xp).toBe(XP_REWARD)
    const repAfterFirst = workerAfterFirst.reputation

    // Replay the SAME approve tx from the terminal `paid` state (ALLOWED_FROM
    // admits paid → paid). The (task_id, 'release') unique index makes the ledger
    // write a no-op (inserted=false), so the XP/reputation award — gated on that
    // first physical insert — must NOT fire again.
    const replay = await applyEscrowConfirm(paidRow, "approve", approveTx, { kind: "user", userId: POSTER })
    expect(replay.ok, JSON.stringify(replay)).toBe(true)
    expect((replay as { task: typeof row }).task.status).toBe("paid")

    const releaseRows = (await ledgerRows(row.id)).filter((t) => t.txType === "release")
    expect(releaseRows).toHaveLength(1) // no duplicate ledger row
    const workerAfterReplay = await getUser(WORKER)
    expect(workerAfterReplay.xp).toBe(XP_REWARD) // unchanged — no double award
    expect(workerAfterReplay.reputation).toBe(repAfterFirst)
  })

  it("NOT_FUNDED: a claim confirm before the create confirm is refused (no on-chain id captured)", async () => {
    const dbTask = await seedDbTask()
    // Fund + claim happen on-chain, but the create confirm is skipped, so the DB
    // row still has no on_chain_task_id.
    const { chainTaskId } = await fundVM()
    const claimTx = await claimVM(chainTaskId)
    const res = await applyEscrowConfirm(dbTask, "claim", claimTx, { kind: "user", userId: WORKER })
    expect(res.ok).toBe(false)
    expect((res as { code: string }).code).toBe("NOT_FUNDED")
    expect((res as { httpStatus: number }).httpStatus).toBe(409)
    expect((await refetch(dbTask.id)).status).toBe("open") // untouched
  })

  it("INVALID_STATE: the lifecycle gate refuses a submit confirm on an already-paid task (before any event read)", async () => {
    const { row, fundTxHash, chainTaskId } = await driveToSubmitted()
    // Advance to the terminal `paid` state.
    const approveTx = await approveVM(chainTaskId, fundTxHash)
    const paid = await applyEscrowConfirm(row, "approve", approveTx, { kind: "user", userId: POSTER })
    expect(paid.ok).toBe(true)
    const paidRow = (paid as { task: typeof row }).task

    // 'submitted' is not in ALLOWED_FROM for a 'paid' task, so the gate refuses on
    // status alone — this branch runs BEFORE verifyEscrowEvent, so even a real
    // WorkSubmittedEvent (or any hash) can't regress the lifecycle.
    const res = await applyEscrowConfirm(paidRow, "submit", "txid_any_submitted_event", { kind: "user", userId: WORKER })
    expect(res.ok).toBe(false)
    expect((res as { code: string }).code).toBe("INVALID_STATE")
    expect((await refetch(row.id)).status).toBe("paid") // unchanged
  })

  it("create CAS: a second create-confirm binding a DIFFERENT on-chain id is refused (per-row compare-and-swap)", async () => {
    const dbTask = await seedDbTask()
    const a = await fundVM() // chain task #1
    const first = await applyEscrowConfirm(dbTask, "create", a.fundTxHash, { kind: "user", userId: POSTER })
    expect(first.ok).toBe(true)
    expect((first as { task: typeof dbTask }).task.onChainTaskId).toBe(a.chainTaskId)

    // A second, genuinely-committed fund (chain task #2) confirmed onto the SAME
    // DB row: the row is already pinned to #1, so the CAS WHERE (unfunded OR same
    // id) misses and the confirm must refuse — never re-peg the row to an id whose
    // fund ledger row it doesn't have.
    const b = await fundVM()
    expect(b.chainTaskId).not.toBe(a.chainTaskId)
    const second = await applyEscrowConfirm(
      (first as { task: typeof dbTask }).task,
      "create",
      b.fundTxHash,
      { kind: "user", userId: POSTER },
    )
    expect(second.ok).toBe(false)
    expect((second as { code: string }).code).toBe("CONFLICT")
    expect((await refetch(dbTask.id)).onChainTaskId).toBe(a.chainTaskId) // still #1
  })

  it("collision guard: two DB rows cannot both bind the same (on-chain id, component) — the partial unique index refuses the second", async () => {
    // The exact defence the escrow_component migration exists for: the escrow
    // blueprint numbers tasks from 1, so on_chain_task_id COLLIDES across
    // components. Here two DB rows try to bind the SAME funded id+component; the
    // partial unique index must reject the second, surfaced as a clean CONFLICT
    // (not a raw 23505/500).
    const rowA = await seedDbTask()
    // Same stored text as rowA, so rowB passes the poster + work-brief binding
    // and it is the partial unique index — not the brief check — that refuses it.
    const rowB = await seedDbTask()
    const { fundTxHash, chainTaskId } = await fundVM()

    const a = await applyEscrowConfirm(rowA, "create", fundTxHash, { kind: "user", userId: POSTER })
    expect(a.ok).toBe(true)
    expect((a as { task: typeof rowA }).task.onChainTaskId).toBe(chainTaskId)

    const b = await applyEscrowConfirm(rowB, "create", fundTxHash, { kind: "user", userId: POSTER })
    expect(b.ok).toBe(false)
    expect((b as { code: string }).code).toBe("CONFLICT")
    // rowB stays unbound — the index protected the (id, component) pair.
    expect((await refetch(rowB.id)).onChainTaskId).toBeNull()
  })

  it("cancel: confirm refunds the poster in the ledger and reaches parity (Refunded ↔ cancelled)", async () => {
    const dbTask = await seedDbTask()
    const { fundTxHash, chainTaskId } = await fundVM()
    const created = await applyEscrowConfirm(dbTask, "create", fundTxHash, { kind: "user", userId: POSTER })
    expect(created.ok).toBe(true)

    const cancelTx = await cancelVM(chainTaskId)
    const res = await applyEscrowConfirm((created as { task: typeof dbTask }).task, "cancel", cancelTx, { kind: "user", userId: POSTER })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    const row = (res as { task: typeof dbTask }).task
    expect(row.status).toBe("cancelled")
    assertParity(chainTaskId, row.status, "after cancel")

    expect(A.ledger!.taskState(chainTaskId)).toBe("Refunded")
    // Refunded credits the poster; collecting is their own second signature.
    expect(A.ledger!.balanceOf(POSTER)).toBe(500 - REWARD - INSURANCE) // not yet moved
    expect(A.ledger!.owed(chainTaskId, "Poster")).toBe(REWARD + INSURANCE)
    const refundRow = (await ledgerRows(row.id)).find((t) => t.txType === "refund")
    expect(refundRow, "cancel writes the refund ledger row").toBeTruthy()
    expect(refundRow!.toUserId).toBe(POSTER)
    expect(Number(refundRow!.amountXrd)).toBe(REWARD)
  })

  it("dispute → resolve: the confirm records the EXACT on-chain split amounts and reaches parity", async () => {
    // NB the H1 blueprint bug means the money that actually MOVES under SplitEvenly
    // is winner-take-all, diverging from the emitted 50/50 event — reproduced +
    // asserted in escrow-dispute.e2e.test.ts, and mitigated by disputes staying
    // DORMANT at launch. This test's scope is narrower and orthogonal: the confirm
    // route's contract is to record what the DisputeAutoResolvedEvent REPORTS, and
    // to do it as one atomic two-leg write against the real ledger. That's what we
    // pin here.
    const { row, fundTxHash, chainTaskId } = await driveToSubmitted()

    // ── dispute: submitted → disputed, disputed_at persisted, 0-amount marker ──
    const disputeTx = await disputeVM(chainTaskId)
    let res = await applyEscrowConfirm(row, "dispute", disputeTx, { kind: "user", userId: WORKER })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    let cur = (res as { task: typeof row }).task
    expect(cur.status).toBe("disputed")
    // The on-chain CONSENSUS time round-trips (not the confirm-time fallback).
    expect(cur.disputedAt).toEqual(DISPUTED_AT_ONCHAIN)
    assertParity(chainTaskId, cur.status, "after dispute")
    const marker = (await ledgerRows(row.id)).find((t) => t.txType === "dispute")
    expect(marker, "dispute writes the 0-amount marker row").toBeTruthy()
    expect(Number(marker!.amountXrd)).toBe(0)
    expect(marker!.txHash).toBe(disputeTx)

    // ── resolve: SplitEvenly = worker 50 (half the REWARD) / poster 55 ────────
    //
    // ⚠️ These numbers changed at S3, and the old ones were wrong about the
    // chain. They read 52.5 / 52.5 — half of reward+insurance each — because the
    // push harness split the whole pot by the ruling. The blueprint splits only
    // the REWARD by the ruling and hands the INSURANCE back to the poster whole
    // (`credit_split_for_parties(.., &ruling, &DisputeRuling::RefundPoster, ..)`
    // in lib.rs's `auto_resolve_dispute`), since nobody judged and a premium is not a prize. So the
    // worker's share of a 100/5 task is 50, not 52.5 — and this test was
    // asserting the DB faithfully recorded an amount the chain never credited.
    const resolveTx = await resolveVM(chainTaskId, fundTxHash, disputeTx)
    expect(A.ledger!.disputeAutoResolvedEvent(resolveTx)).toEqual({
      taskId: chainTaskId,
      workerAmount: "50",
      posterAmount: "55",
    })
    res = await applyEscrowConfirm(cur, "resolve", resolveTx, { kind: "user", userId: POSTER })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    cur = (res as { task: typeof row }).task
    expect(cur.status).toBe("paid") // worker share > 0 ⇒ counts as a payout
    assertParity(chainTaskId, cur.status, "after resolve — chain Released")

    // Both legs written from the VERIFIED event amounts, never DB values.
    const rows = await ledgerRows(row.id)
    const release = rows.find((t) => t.txType === "release")
    const refund = rows.find((t) => t.txType === "refund")
    expect(Number(release!.amountXrd)).toBe(50) // half the reward
    expect(release!.toUserId).toBe(WORKER)
    expect(Number(refund!.amountXrd)).toBe(55) // half the reward + the whole premium
    expect(refund!.toUserId).toBe(POSTER)
    // The worker's payout still credits XP exactly once.
    expect((await getUser(WORKER)).xp).toBe(XP_REWARD)
  })
})
