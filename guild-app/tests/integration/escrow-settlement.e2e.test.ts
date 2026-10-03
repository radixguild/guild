/**
 * End-to-end settlement test on the wallet-mock harness (tests/support/mock-ledger).
 *
 * This is the seam that had NO end-to-end coverage: the real UI wrappers
 * (sendDepositTx / sendClaimTx / sendSubmitTx / sendApproveTx) → the real
 * manifest builders (src/lib/manifests.ts) → a signer. Every other escrow test
 * either seeds "what the confirm route would have written" (api-lifecycle) or
 * mocks the manifest builder away (escrow-approve-m1). Here the REAL manifest
 * text is executed against an in-memory ledger, so we can assert the money
 * actually lands on the worker — the exact locus of the M1 / H1 / BUG-7 class.
 *
 * Only two edges are mocked: the escrow config gate (deployed=true, addresses
 * pinned) and readEscrowTaskCreated (delegated to the ledger's own emitted
 * event — the on-chain reward the M1 guard re-reads). Everything else is real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// Pinned addresses + the per-test ledger holder — hoisted so the vi.mock
// factories below can reference them (mocks are hoisted above imports).
const A = vi.hoisted(() => ({
  COMPONENT: "component_rdx1cr690hkrk2kv933cw3qdr6amkaphdlu2whjhhh8wppus922yx335r2",
  RECEIPT: "resource_rdx1n2rurpe2efyur5xqvz256yyhecpfjw8ed9v8xxcfxp5mtj9qld9ssq",
  CLAIM_RECEIPT: "resource_rdx1n2x2epej0dyahwjga5rrwnx893rq4f7dxvs9psh74kqak5e9delc4w",
  MEMBER_BADGE: "resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl",
  BOND: 10,
  XRD: "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd",
  ledger: null as import("../support/mock-ledger").MockLedger | null,
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

// The M1 guard re-reads the funded reward from the fund tx's TaskCreatedEvent.
// Delegate that read to the ledger that actually executed the fund manifest —
// so the "on-chain" amount is genuinely what the create_task manifest funded.
vi.mock("@/lib/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gateway")>()),
  // Wave B claim-bond reads. `sendClaimTx` derives the bond from LIVE chain
  // state and fails closed when it cannot — correct behaviour, but this VM
  // suite must supply what a real component would or every claim refuses
  // before a manifest exists. pct 0 with floor == cap == A.BOND clamps to the
  // mock ledger's flat bond, so nothing this suite asserts about amounts moves.
  readClaimBondParams: async (component: string) =>
    component === A.COMPONENT
      ? { pct: "0", floor: String(A.BOND), cap: String(A.BOND) }
      : null,
  readTaskRewardInfo: async (_taskId: number, component: string) =>
    component === A.COMPONENT ? { rewardToken: A.XRD, rewardAmount: "100" } : null,
  readTokenDivisibility: async () => 18,
  readEscrowTaskCreated: async (intentHash: string) =>
    A.ledger?.taskCreatedEvent(intentHash) ?? null,
}))

import { MockLedger } from "../support/mock-ledger"
import {
  sendDepositTx,
  sendClaimTx,
  sendSubmitTx,
  sendApproveTx,
  sendCancelTx,
  sendWithdrawTx,
} from "@/lib/escrow-utils"

// Valid-form addresses (the real manifest builders validate ^account_rdx[a-z0-9]{20,}).
const POSTER = "account_rdx12ynlx369poster000000000000000000000000000000000000000000"
const WORKER = "account_rdx12890803worker000000000000000000000000000000000000000000"

const REWARD = 100
const INSURANCE = Math.ceil(REWARD * 0.05) // = 5 (INSURANCE_RATE, not mocked)
const rdt = (signer: string) => A.ledger!.makeRdt(signer) as never

/** Fund a task as the poster; returns { fundTxHash, taskId }. */
async function fund(reward = REWARD) {
  const res = await sendDepositTx({
    rewardXrd: reward,
    title: "Port the docs widget",
    description: "Port the widget to the new stack",
    account: POSTER,
    rdt: rdt(POSTER),
  })
  expect(res.ok, res.error).toBe(true)
  const created = A.ledger!.taskCreatedEvent(res.txId!)
  expect(created).not.toBeNull()
  return { fundTxHash: res.txId!, taskId: created!.taskId }
}

async function claim(taskId: number) {
  const res = await sendClaimTx({
    escrowComponent: A.COMPONENT,
    account: WORKER,
    badgeId: "#1#",
    taskId,
    rdt: rdt(WORKER),
  })
  expect(res.ok, res.error).toBe(true)
  return res
}

async function submit(taskId: number) {
  const claimReceiptId = A.ledger!.taskRecord(taskId)!.claimReceiptId!
  const res = await sendSubmitTx({
    escrowComponent: A.COMPONENT,
    account: WORKER,
    claimReceiptId,
    taskId,
    content: "PR #42: done",
    // SAME title/description fund() funded this task with — submit_task now
    // checks a brief_hash arg against the task's committed work_brief_hash.
    title: "Port the docs widget",
    description: "Port the widget to the new stack",
    rdt: rdt(WORKER),
  })
  expect(res.ok, res.error).toBe(true)
  return res
}

async function approve(taskId: number, fundTxHash: string, rewardXrd = REWARD) {
  return sendApproveTx({
    escrowComponent: A.COMPONENT,
    account: POSTER,
    receiptId: String(taskId),
    workerAddress: WORKER,
    rewardXrd,
    fundTxHash,
    rdt: rdt(POSTER),
  })
}

/**
 * PULL collection. Settlement credits an entitlement; this is the second signed
 * transaction that actually moves it, and it goes through the real app path
 * (sendWithdrawTx → withdraw*Manifest → the VM) rather than a hand-built
 * manifest, so a builder that regressed would fail here too.
 */
async function collectWorker(taskId: number) {
  return sendWithdrawTx({
    escrowComponent: A.COMPONENT,
    party: "worker",
    account: WORKER,
    badgeResource: A.MEMBER_BADGE,
    badgeLocalId: "#1#",
    receiptResource: A.RECEIPT,
    taskId,
    rdt: rdt(WORKER),
  })
}

async function collectPoster(taskId: number) {
  return sendWithdrawTx({
    escrowComponent: A.COMPONENT,
    party: "poster",
    account: POSTER,
    badgeResource: A.MEMBER_BADGE,
    badgeLocalId: "#1#",
    receiptResource: A.RECEIPT,
    taskId,
    rdt: rdt(POSTER),
  })
}

describe("escrow settlement e2e (wallet-mock harness)", () => {
  beforeEach(() => {
    A.ledger = new MockLedger({
      escrowComponent: A.COMPONENT,
      receiptResource: A.RECEIPT,
      claimReceiptResource: A.CLAIM_RECEIPT,
      claimBondXrd: A.BOND, // the VM asserts the bond is exactly this (lib.rs's claim_task `claim_bond amount does not match required` assert)
    })
    // Poster can fund; worker holds the member badge + bond capital.
    A.ledger.seedAccount(POSTER, { xrd: 500 })
    A.ledger.seedAccount(WORKER, { xrd: 50, badges: [{ resource: A.MEMBER_BADGE, id: "#1#" }] })
  })

  it("post → fund → claim → submit → approve routes the reward to the WORKER", async () => {
    const L = A.ledger!
    // 1. Fund: poster pays reward + insurance into escrow; state Open.
    const { fundTxHash, taskId } = await fund()
    expect(L.taskState(taskId)).toBe("Open")
    expect(L.balanceOf(POSTER)).toBe(500 - REWARD - INSURANCE) // 395
    expect(L.vault).toBe(REWARD + INSURANCE) // 105
    // Poster holds the Task Receipt; the funded amount is on-chain.
    expect(L.nftsOf(POSTER)).toContainEqual({ resource: A.RECEIPT, id: `#${taskId}#` })
    expect(L.taskCreatedEvent(fundTxHash)).toMatchObject({ taskId, rewardAmount: "100", insuranceAmount: "5" })

    // 2. Claim: worker posts the bond; state Claimed.
    await claim(taskId)
    expect(L.taskState(taskId)).toBe("Claimed")
    expect(L.balanceOf(WORKER)).toBe(50 - A.BOND) // 40
    expect(L.vault).toBe(REWARD + INSURANCE + A.BOND) // 115
    expect(L.nftsOf(WORKER)).toContainEqual({ resource: A.CLAIM_RECEIPT, id: "#1#" })

    // 3. Submit: claim receipt burned, bond returned; state Submitted.
    await submit(taskId)
    expect(L.taskState(taskId)).toBe("Submitted")
    expect(L.balanceOf(WORKER)).toBe(50) // bond back
    expect(L.nftsOf(WORKER).some((n) => n.resource === A.CLAIM_RECEIPT)).toBe(false)
    expect(L.vault).toBe(REWARD + INSURANCE) // 105

    // 4. Approve: settlement is TWO-PHASE under pull. This leg moves NO money.
    const res = await approve(taskId, fundTxHash)
    expect(res.ok, res.error).toBe(true)
    expect(L.taskState(taskId)).toBe("Released")

    // ⚠️ The property this whole harness was re-modelled to hold. Released, and
    // the worker has not been paid: the vault still holds everything, and what
    // changed is a CLAIM. A push-era assertion here (balanceOf(WORKER) === 150)
    // would now be asserting a world the deployed component cannot produce.
    expect(L.balanceOf(WORKER)).toBe(50) // unchanged — approval is not payment
    expect(L.balanceOf(POSTER)).toBe(500 - REWARD - INSURANCE) // 395, also unchanged
    expect(L.vault).toBe(REWARD + INSURANCE) // 105 — still inside the component
    expect(L.entitlements(taskId)).toMatchObject({
      workerReward: REWARD,
      posterReward: INSURANCE,
      workerBond: 0,
      posterBond: 0,
    })
    // The task receipt is NOT burned at approval — under pull it is a persistent
    // entitlement key the poster still needs to collect with.
    expect(L.nftsOf(POSTER).some((n) => n.resource === A.RECEIPT)).toBe(true)

    // 5. Collect: each party signs for THEMSELVES. This is the leg that pays.
    expect((await collectWorker(taskId)).ok).toBe(true)
    expect(L.balanceOf(WORKER)).toBe(50 + REWARD) // 150 — paid, one tx later
    expect(L.owed(taskId, "Worker")).toBe(0)
    expect(L.vault).toBe(INSURANCE) // the poster's premium is still owed

    expect((await collectPoster(taskId)).ok).toBe(true)
    expect(L.balanceOf(POSTER)).toBe(500 - REWARD) // 400 (insurance round-tripped)
    expect(L.vault).toBe(0) // escrow fully drained, two signatures later
    expect(L.owed(taskId, "Poster")).toBe(0)
  })

  it("the payee is PINNED: a stolen badge collects, and the money still lands on the worker", async () => {
    // The worker badge is a public mint and transferable (withdrawer=AllowAll),
    // so holding one is not authorisation to be paid — the destination was fixed
    // at claim_task and the caller never names it. This is the property the
    // auditor guide points at, and it is worth an executable proof rather than a
    // sentence: seed a thief with an identical-resource badge and let them call.
    const L = A.ledger!
    const THIEF = "account_rdx12thief00000000000000000000000000000000000000000000000000"
    const { fundTxHash, taskId } = await fund()
    await claim(taskId)
    await submit(taskId)
    expect((await approve(taskId, fundTxHash)).ok).toBe(true)

    L.seedAccount(THIEF, { xrd: 0, badges: [{ resource: A.MEMBER_BADGE, id: "#99#" }] })
    const stolen = await sendWithdrawTx({
      escrowComponent: A.COMPONENT,
      party: "worker",
      account: THIEF,
      badgeResource: A.MEMBER_BADGE,
      badgeLocalId: "#99#", // right resource, WRONG non-fungible
      receiptResource: A.RECEIPT,
      taskId,
      rdt: rdt(THIEF),
    })
    // Rejected on the local-id assert — resource alone is not auth here.
    expect(stolen.ok).toBe(false)
    expect(stolen.error).toMatch(/not the worker who claimed/i)
    expect(L.balanceOf(THIEF)).toBe(0)
    expect(L.owed(taskId, "Worker")).toBe(REWARD) // still owed, still uncollected
  })

  it("conserves value across the full lifecycle — no XRD created or destroyed", async () => {
    const L = A.ledger!
    const before = L.balanceOf(POSTER) + L.balanceOf(WORKER) + L.vault
    const { fundTxHash, taskId } = await fund()
    await claim(taskId)
    await submit(taskId)
    await approve(taskId, fundTxHash)
    // Conservation holds at EVERY step, including the one where money is settled
    // but uncollected — that is the state pull adds, and the one an off-chain
    // ledger gets wrong if it treats "Released" as "paid".
    expect(L.balanceOf(POSTER) + L.balanceOf(WORKER) + L.vault).toBe(before)
    expect(L.vault).toBe(REWARD + INSURANCE) // settled, still held
    expect(L.owed(taskId, "Worker") + L.owed(taskId, "Poster")).toBe(L.vault)

    await collectWorker(taskId)
    await collectPoster(taskId)
    const after = L.balanceOf(POSTER) + L.balanceOf(WORKER) + L.vault
    expect(after).toBe(before) // 550 in, 550 out
    expect(L.vault).toBe(0)
  })

  // RETIRED AT S3 — the two "M1 end-to-end" tests. They drove the push-era
  // guard: under push, approve_and_release returned reward+insurance to the
  // caller's worktop and the MANIFEST named the amount to split off for the
  // worker, so a stale DB reward silently mispaid. The app defended that by
  // re-reading the funded amount off the fund tx and refusing on mismatch, and
  // those tests proved the refusal.
  //
  // Under pull there is no amount to get wrong. approve_and_release takes a
  // Proof and nothing else; the component moves value to entitlements by its own
  // arithmetic and the caller supplies no figure. The M1 CLASS is closed
  // structurally rather than defended, so a test of the defence would now be
  // testing deleted code. What replaces it is the assertion below — that the
  // manifest carries no amount and no recipient at all, which is the property
  // that makes the guard unnecessary. (Its unit-level twin,
  // escrow-approve-m1.test.ts, was deleted in the same change.)
  it("the approve manifest has NO amount and NO recipient — the M1/BUG-7 class is closed by shape", async () => {
    const L = A.ledger!
    const { fundTxHash, taskId } = await fund()
    await claim(taskId)
    await submit(taskId)

    const { approveAndReleaseManifest } = await import("@/lib/manifests")
    const manifest = approveAndReleaseManifest(A.COMPONENT, POSTER, A.RECEIPT, taskId)
    // No worktop routing, no second account, no decimal: there is no surface on
    // which a stale DB value or a dishonest poster could redirect a payment.
    expect(manifest).not.toContain("TAKE_FROM_WORKTOP")
    expect(manifest).not.toContain("Decimal(")
    expect(manifest).not.toContain(WORKER)
    // And it settles correctly regardless of what the client believed the reward
    // was — the drift that used to mispay is now simply not an input.
    const res = await approve(taskId, fundTxHash, 50) // client thinks 50, funded 100
    expect(res.ok, res.error).toBe(true)
    expect(L.entitlements(taskId)).toMatchObject({ workerReward: REWARD }) // 100, not 50
  })

  it("refuses to approve a task that has not been submitted (state guard, real chain revert)", async () => {
    const L = A.ledger!
    const { fundTxHash, taskId } = await fund()
    await claim(taskId) // Claimed, not Submitted
    const res = await approve(taskId, fundTxHash)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/must be Submitted/i)
    expect(L.taskState(taskId)).toBe("Claimed")
    expect(L.balanceOf(WORKER)).toBe(40) // bond still posted, no payout
  })

  it("refuses a double-claim — the second claimer's tx reverts (must be Open)", async () => {
    const L = A.ledger!
    const { taskId } = await fund()
    await claim(taskId)
    // A second claim on the now-Claimed task reverts; nothing moves.
    const res = await sendClaimTx({
      escrowComponent: A.COMPONENT,
      account: WORKER,
      badgeId: "#1#",
      taskId,
      rdt: rdt(WORKER),
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/must be Open/i)
    expect(L.balanceOf(WORKER)).toBe(40) // only one bond posted
    expect(L.vault).toBe(REWARD + INSURANCE + A.BOND)
  })

  it("cancel before claim refunds the poster in full and drains the escrow", async () => {
    const L = A.ledger!
    const { taskId } = await fund()
    expect(L.balanceOf(POSTER)).toBe(500 - REWARD - INSURANCE)
    const res = await sendCancelTx({
      escrowComponent: A.COMPONENT,
      account: POSTER,
      taskId,
      phase: "open",
      rdt: rdt(POSTER),
    })
    expect(res.ok, res.error).toBe(true)
    expect(L.taskState(taskId)).toBe("Refunded")
    // Refunded CREDITS the poster; it does not pay them. Both legs come back —
    // the "insurance is forfeited on cancel" line that used to sit in the docs
    // was measured false on 2026-08-09 — but they come back as an entitlement.
    expect(L.balanceOf(POSTER)).toBe(500 - REWARD - INSURANCE) // unchanged
    expect(L.entitlements(taskId)).toMatchObject({ posterReward: REWARD + INSURANCE })
    expect(L.vault).toBe(REWARD + INSURANCE)

    expect((await collectPoster(taskId)).ok).toBe(true)
    expect(L.balanceOf(POSTER)).toBe(500) // reward + insurance both back
    expect(L.vault).toBe(0)
  })

  it("a reverted manifest leaves the ledger completely untouched (atomicity)", async () => {
    const L = A.ledger!
    const { taskId } = await fund()
    const snapshot = {
      poster: L.balanceOf(POSTER),
      worker: L.balanceOf(WORKER),
      vault: L.vault,
      state: L.taskState(taskId),
    }
    // Submit without ever claiming → the withdraw_non_fungibles of a claim
    // receipt the worker doesn't hold reverts mid-manifest; nothing commits.
    const res = await sendSubmitTx({
      escrowComponent: A.COMPONENT,
      account: WORKER,
      claimReceiptId: 999, // worker holds no such claim receipt
      taskId,
      content: "premature",
      title: "Port the docs widget",
      description: "Port the widget to the new stack",
      rdt: rdt(WORKER),
    })
    expect(res.ok).toBe(false)
    expect({
      poster: L.balanceOf(POSTER),
      worker: L.balanceOf(WORKER),
      vault: L.vault,
      state: L.taskState(taskId),
    }).toEqual(snapshot)
  })

  it("cancel AFTER claim refunds reward+insurance to poster AND the bond to the worker", async () => {
    const L = A.ledger!
    const { taskId } = await fund()
    await claim(taskId) // worker posted the bond; task Claimed
    expect(L.balanceOf(WORKER)).toBe(50 - A.BOND) // 40
    expect(L.vault).toBe(REWARD + INSURANCE + A.BOND) // 115

    const res = await sendCancelTx({
      escrowComponent: A.COMPONENT,
      account: POSTER,
      taskId,
      phase: "claimed",
      workerAccount: WORKER,
      rdt: rdt(POSTER),
    })
    expect(res.ok, res.error).toBe(true)
    expect(L.taskState(taskId)).toBe("Refunded")
    // The loser-of-nothing invariant, now expressed in LANES — and this is where
    // pull is strictly safer than push. Under push the component handed the whole
    // pot INCLUDING the worker's bond to the cancelling poster's worktop, and the
    // poster's own manifest was trusted to forward the bond back. Under pull the
    // bond is credited to the WORKER's bond lane directly (lib.rs's
    // cancel-after-claim `credit_bond_entitlement(task_id, EntitledParty::Worker, bond)` call): the
    // poster's transaction never touches the worker's money, so a poster who
    // writes a manifest keeping it has nothing to keep.
    expect(L.entitlements(taskId)).toMatchObject({
      posterReward: REWARD + INSURANCE,
      workerBond: A.BOND,
      workerReward: 0,
      posterBond: 0,
    })
    expect(L.balanceOf(WORKER)).toBe(50 - A.BOND) // still out the bond until they collect
    expect(L.vault).toBe(REWARD + INSURANCE + A.BOND)

    // Each party collects their own lane, with their own signature.
    expect((await collectWorker(taskId)).ok).toBe(true)
    expect((await collectPoster(taskId)).ok).toBe(true)
    expect(L.balanceOf(WORKER)).toBe(50) // bond returned, nothing more
    expect(L.balanceOf(POSTER)).toBe(500) // reward + insurance returned, nothing more
    expect(L.vault).toBe(0)
  })

  it("REGRESSION: a poster CANNOT cancel-after-claim a SUBMITTED task (no post-delivery rug / no bond double-pay)", async () => {
    // Guards the exact false-green the harness review caught: admitting Submitted
    // into cancel-after-claim both blesses a poster clawing back delivered work
    // and — since submit already returned the bond — double-pays the bond and
    // drives the vault negative. The chain reverts (lib.rs's cancel-after-claim
    // `task must be Claimed to cancel-after-claim` assert); so must the VM.
    const L = A.ledger!
    const { taskId } = await fund()
    await claim(taskId)
    await submit(taskId) // task is now Submitted; bond already back with the worker
    const before = { poster: L.balanceOf(POSTER), worker: L.balanceOf(WORKER), vault: L.vault }

    const res = await sendCancelTx({
      escrowComponent: A.COMPONENT,
      account: POSTER,
      taskId,
      phase: "claimed",
      workerAccount: WORKER,
      rdt: rdt(POSTER),
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/must be Claimed/i)
    // Nothing moved, vault never went negative, task stays Submitted.
    expect(L.taskState(taskId)).toBe("Submitted")
    expect({ poster: L.balanceOf(POSTER), worker: L.balanceOf(WORKER), vault: L.vault }).toEqual(before)
    expect(L.vault).toBeGreaterThanOrEqual(0)
  })

  it("REGRESSION: the poster cannot claim their OWN task (self-claim gate, lib.rs's `worker != task.poster` assert in claim_task)", async () => {
    const L = A.ledger!
    const { taskId } = await fund()
    // Seed the poster with bond capital + the member badge, then have them try to
    // claim their own task. The chain's self-claim assert must revert in the VM.
    L.seedAccount(POSTER, { xrd: 50, badges: [{ resource: A.MEMBER_BADGE, id: "#9#" }] })
    const res = await sendClaimTx({
      escrowComponent: A.COMPONENT,
      account: POSTER,
      badgeId: "#9#",
      taskId,
      rdt: rdt(POSTER),
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/self-claim/i)
    expect(L.taskState(taskId)).toBe("Open") // unclaimed
  })

  it("REGRESSION: claim reverts when the bond is not the exact required amount (lib.rs's claim_task `claim_bond amount does not match required` assert)", async () => {
    // Drive the real claim wrapper but with the ledger configured to require a
    // DIFFERENT bond than the manifest posts → the VM's exact-amount assert fires.
    const L = new MockLedger({
      escrowComponent: A.COMPONENT,
      receiptResource: A.RECEIPT,
      claimReceiptResource: A.CLAIM_RECEIPT,
      claimBondXrd: A.BOND + 5, // require 15, but the wrapper posts 10 (config bond)
    })
    L.seedAccount(POSTER, { xrd: 500 })
    L.seedAccount(WORKER, { xrd: 50, badges: [{ resource: A.MEMBER_BADGE, id: "#1#" }] })
    A.ledger = L
    const { taskId } = await fund()
    const res = await sendClaimTx({
      escrowComponent: A.COMPONENT,
      account: WORKER,
      badgeId: "#1#",
      taskId,
      rdt: rdt(WORKER),
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/claim_bond amount/i)
    expect(L.taskState(taskId)).toBe("Open")
  })
})
