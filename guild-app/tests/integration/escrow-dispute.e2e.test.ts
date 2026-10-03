/**
 * Dispute settlement on the wallet-mock harness. The MockLedger models the
 * PUSH component — the one still LIVE on mainnet until the P2 cutover — and
 * that era split is now the whole subject of this file:
 *
 * BUG-7 (push-blueprint-rooted, fixed in PULL, still live until P2) — the push
 * auto_resolve_dispute is PUBLIC and returns its buckets to the CALLER's
 * worktop, so any third party can write a draining manifest. The PULL
 * blueprint in this tree fixes the root cause (settlement is credited
 * internally; the caller receives nothing) — but the fix ships in the NEW
 * component, so until the cutover disputes stay DORMANT on the live one:
 * poster-harness + keeper + agent-client enforce that with a hard fuse
 * (GUILD_ALLOW_LIVE_DISPUTE), and NEXT_PUBLIC_FEATURE_DISPUTES stays off.
 * The drain test stays deliberately GREEN against the push model as the
 * executable record of WHY the fuse exists.
 *
 * H1 (the app once hand-routed the settlement, assuming the ruling) died with
 * the routing itself: the finalize path is PULL-only now — a bare trigger, no
 * accounts, no amounts (see auto-resolve-routing.test.ts). What this file
 * proves about it is the ERA safety, in both directions: with the pull flag
 * OFF the path refuses outright, and with it ON a pull manifest reaching the
 * push component fails CLOSED (worktop revert, atomic rollback, pot stays
 * vaulted) rather than misrouting a single XRD.
 *
 * Ground truth: escrow/scrypto/guild-marketplace-escrow/src/lib.rs (PULL:
 * auto_resolve_dispute returns `()` and credits entitlements) vs this
 * harness's push model (buckets to the worktop), and the app's finalize path
 * src/lib/escrow-utils.ts sendAutoResolveTx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// S3 removed the FLAGS.escrowPull mock that used to sit here. The flag no
// longer exists in features.ts, so a mock returning it would have been asserting
// against a world the build can no longer produce — and, worse, it answered
// FALSE for every OTHER flag (disputes, escrow), which is not what any test here
// meant to pin. features is left unmocked; nothing in this file's path reads it.

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

// Chain readers delegate to the ledger that executed the manifests — the
// "on-chain" values are genuinely what happened. (The pull finalize path reads
// nothing before signing; readEscrowTaskCreated stays mocked for any path that
// still verifies fund events.)
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
  readEscrowTaskCreated: async (intentHash: string) => A.ledger?.taskCreatedEvent(intentHash) ?? null,
}))

import { MockLedger } from "../support/mock-ledger"
import {
  sendDepositTx,
  sendClaimTx,
  sendSubmitTx,
  sendRaiseDisputeTx,
  sendAutoResolveTx,
} from "@/lib/escrow-utils"

const POSTER = "account_rdx12ynlx369poster000000000000000000000000000000000000000000"
const WORKER = "account_rdx12890803worker000000000000000000000000000000000000000000"
const KEEPER = "account_rdx12keeper00000000000000000000000000000000000000000000000000"
const ATTACKER = "account_rdx12attacker0000000000000000000000000000000000000000000000"

const REWARD = 100
const INSURANCE = Math.ceil(REWARD * 0.05) // 5
const POT = REWARD + INSURANCE // 105
const rdt = (signer: string) => A.ledger!.makeRdt(signer) as never

/** Drive a task to Submitted; returns { fundTxHash, taskId }. */
async function toSubmitted() {
  const dep = await sendDepositTx({
    rewardXrd: REWARD,
    title: "Port the docs widget",
    description: "Port the widget",
    account: POSTER,
    rdt: rdt(POSTER),
  })
  expect(dep.ok, dep.error).toBe(true)
  const { taskId } = A.ledger!.taskCreatedEvent(dep.txId!)!
  const clm = await sendClaimTx({ escrowComponent: A.COMPONENT, account: WORKER, badgeId: "#1#", taskId, rdt: rdt(WORKER) })
  expect(clm.ok, clm.error).toBe(true)
  const claimReceiptId = A.ledger!.taskRecord(taskId)!.claimReceiptId!
  const sub = await sendSubmitTx({
    escrowComponent: A.COMPONENT,
    account: WORKER,
    claimReceiptId,
    taskId,
    content: "PR #42",
    // SAME title/description this task was funded with above — submit_task
    // now checks a brief_hash arg against the task's committed work_brief_hash.
    title: "Port the docs widget",
    description: "Port the widget",
    rdt: rdt(WORKER),
  })
  expect(sub.ok, sub.error).toBe(true)
  return { fundTxHash: dep.txId!, taskId }
}

async function raiseDisputeAsWorker(taskId: number) {
  const res = await sendRaiseDisputeTx({
    escrowComponent: A.COMPONENT,
    account: WORKER,
    taskId,
    proofResource: A.MEMBER_BADGE,
    proofLocalId: "#1#",
    rdt: rdt(WORKER),
  })
  expect(res.ok, res.error).toBe(true)
  return res.txId!
}

describe("escrow dispute + BUG-7 reproduction (wallet-mock harness)", () => {
  beforeEach(() => {
    // Default to the PUSH era — the ledger below models the live push
    // component, so this is the coherent pairing; pull-era tests flip it.
    A.ledger = new MockLedger({
      escrowComponent: A.COMPONENT,
      receiptResource: A.RECEIPT,
      claimReceiptResource: A.CLAIM_RECEIPT,
      claimBondXrd: A.BOND,
      // The LIVE mainnet component's value (operator-verified 2026-07-16).
      disputeAutoResolveDefault: "SplitEvenly",
    })
    A.ledger.seedAccount(POSTER, { xrd: 500 })
    A.ledger.seedAccount(WORKER, { xrd: 50, badges: [{ resource: A.MEMBER_BADGE, id: "#1#" }] })
    A.ledger.seedAccount(KEEPER, { xrd: 0 })
    A.ledger.seedAccount(ATTACKER, { xrd: 0 })
  })

  it("raise_dispute records the raiser and requires Submitted state", async () => {
    const L = A.ledger!
    const { taskId } = await toSubmitted()
    const disputeTx = await raiseDisputeAsWorker(taskId)
    expect(L.taskState(taskId)).toBe("Disputed")
    expect(L.taskRecord(taskId)!.disputeRaisedBy).toBe("Worker")
    expect(L.disputeRaisedEvent(disputeTx)).toEqual({ taskId, raisedBy: "Worker" })
    // A second dispute on the now-Disputed task reverts.
    const again = await sendRaiseDisputeTx({
      escrowComponent: A.COMPONENT,
      account: WORKER,
      taskId,
      proofResource: A.MEMBER_BADGE,
      proofLocalId: "#1#",
      rdt: rdt(WORKER),
    })
    expect(again.ok).toBe(false)
    expect(again.error).toMatch(/must be Submitted/i)
  })

  // RETIRED AT S3 — "PUSH era (flag off): the finalize path REFUSES". It
  // asserted that the pull-only finalize stayed unreachable while the app still
  // settled on the push component, by driving FLAGS.escrowPull=false. That flag
  // is deleted and settlementEra() is a constant "pull", so there is no longer a
  // build in which the refusal could occur. The property it protected is now
  // structural rather than conditional: no push finalize builder exists to select.

  // RETIRED AT S3 — "PULL era, wrong component: the bare trigger fails CLOSED
  // against the push escrow". It was cutover-ORDER safety: if the flag flipped
  // before the component did, the pull manifest would reach a push escrow, whose
  // auto_resolve returned both buckets to the worktop, and the transaction would
  // fail to balance rather than mispay. Both halves of that scenario are gone —
  // there is no flag left to flip out of order, and the harness now models the
  // pull component the app actually targets. Cutover ordering is guarded where it
  // belongs: launch-check CHECK 7 compares the compiled shape against the
  // on-chain shape of the baked component and hard-fails on disagreement.

  it("BUG-7 CLOSED: auto_resolve_dispute is still PUBLIC, and the identical drain manifest now reverts", async () => {
    const L = A.ledger!
    const { taskId } = await toSubmitted()
    await raiseDisputeAsWorker(taskId)

    // The method is STILL PUBLIC under pull — that has not changed, and it is not
    // the mitigation. What changed is that it RETURNS NOTHING: it credits
    // entitlements inside the component instead of putting buckets on the
    // caller's worktop. So the attacker's manifest below is kept BYTE-FOR-BYTE as
    // it was when it drained the pot, and only the expectation is inverted.
    //
    // That is deliberate. The old test proved the drain worked; keeping its exact
    // manifest and flipping the assertion is what makes this evidence the hole is
    // closed, rather than evidence that someone wrote a passing test. The
    // manifest is INLINE because the app never shipped a builder for it — an
    // attacker never needed ours, which is why deleting the push builders
    // mitigates nothing here and only the component's shape does.
    const XRD_MAINNET = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"
    const drain = `CALL_METHOD
  Address("${A.COMPONENT}")
  "auto_resolve_dispute"
  ${taskId}u64
;
TAKE_FROM_WORKTOP
  Address("${XRD_MAINNET}")
  Decimal("${REWARD}")
  Bucket("steal_reward")
;
CALL_METHOD
  Address("${ATTACKER}")
  "try_deposit_or_abort"
  Bucket("steal_reward")
  Enum<0u8>()
;
TAKE_FROM_WORKTOP
  Address("${XRD_MAINNET}")
  Decimal("${INSURANCE}")
  Bucket("steal_insurance")
;
CALL_METHOD
  Address("${ATTACKER}")
  "try_deposit_or_abort"
  Bucket("steal_insurance")
  Enum<0u8>()
;
CALL_METHOD
  Address("${ATTACKER}")
  "deposit_batch"
  Expression("ENTIRE_WORKTOP")
;`
    // The transaction REVERTS. `auto_resolve_dispute` puts nothing on the worktop,
    // so `TAKE_FROM_WORKTOP Decimal(100)` cannot be satisfied and the whole
    // manifest rolls back atomically — the attacker pays a network fee and
    // achieves nothing. Note WHERE it fails: not on auth (there is still none to
    // fail on), but on there being no value to take.
    expect(() => L.execute(drain, ATTACKER)).toThrow()
    expect(L.balanceOf(ATTACKER)).toBe(0) // stole nothing
    expect(L.balanceOf(POSTER)).toBe(500 - POT) // untouched
    expect(L.balanceOf(WORKER)).toBe(50) // untouched
    expect(L.vault).toBe(POT) // the pot never left the component
    expect(L.taskState(taskId)).toBe("Disputed") // atomic rollback — not even finalized

    // And when it IS finalized — by this same non-party attacker, since the
    // method really is public — the money is credited to the PARTIES, because the
    // component fixes the destinations and the caller's manifest cannot.
    const bare = [
      "CALL_METHOD",
      `  Address("${A.COMPONENT}")`,
      '  "auto_resolve_dispute"',
      `  ${taskId}u64`,
      ";",
    ].join("\n")
    expect(L.execute(bare, ATTACKER)).toBeTruthy()
    expect(L.balanceOf(ATTACKER)).toBe(0) // the finalizer is paid nothing at all
    // SplitEvenly governs the REWARD; the insurance premium returns whole to the
    // poster because nobody judged.
    expect(L.entitlements(taskId)).toMatchObject({
      workerReward: REWARD / 2,
      posterReward: REWARD / 2 + INSURANCE,
    })
  })



  // RETIRED AT S3 — "BUG-7: a dishonest approve manifest routes the reward to
  // the poster". It built its dishonest manifest with
  // approveAndReleaseLegacyPushManifest, which no longer exists, and the defect
  // it reproduced no longer does either: BUG-7 was a PUSH property — the
  // component returned reward+insurance to the caller's worktop and the manifest
  // named the recipient. Under pull, approve_and_release credits entitlements
  // inside the component and withdraw_worker deposits to task.worker_account,
  // pinned at claim (lib.rs, `withdraw_worker`'s `destination` bound to
  // `task.worker_account`). There is no recipient argument left to lie
  // about, so the test cannot be re-modelled — its subject is gone, not moved.
  // The standing guard against a REGRESSION here is manifest-abi-gate.test.ts,
  // which asserts every builder against the scraped lib.rs signature.

  it("PULL era: the ruling no longer changes the manifest — the caller cannot route it", async () => {
    // The push era's H1 was a default-vs-manifest MISMATCH: the app chose the
    // routing, so it could disagree with the component's ruling. Under pull the
    // app chooses nothing — the SAME bare trigger settles regardless of the
    // configured default, and the component applies the ruling internally. This
    // is the structural end of the H1 class: there is no per-ruling manifest to
    // get wrong. Proven by building against three different defaults and
    // asserting the emitted manifest is byte-identical each time.
    const { autoResolveDisputeManifest } = await import("@/lib/manifests")
    const forDefault = () => autoResolveDisputeManifest(A.COMPONENT, 7)
    const favor = forDefault()
    const split = forDefault()
    const refund = forDefault()
    expect(favor).toBe(split)
    expect(split).toBe(refund)
    // And it carries no routing surface at all.
    expect(favor).not.toContain("TAKE_FROM_WORKTOP")
    expect(favor).not.toContain("account_rdx")
  })
})
