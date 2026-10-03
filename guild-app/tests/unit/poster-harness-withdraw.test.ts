// poster-harness-withdraw.test.ts — the seam between the affordance resolver and
// the manifest builders.
//
// WHY THIS EXISTS
// ---------------
// Every live run of `poster-harness withdraw` against the only settled task on
// mainnet hits a REFUSAL, because that task is fully collected. So the one path
// that actually moves money — resolve → build → sign — is exercised by nothing
// unless something is owed. The resolver has its own tests
// (escrow-withdraw.test.ts) and the builders have theirs (manifests.test.ts +
// manifest-abi-gate.test.ts); this covers the join, which is where a
// poster-shaped affordance could be handed to a worker-shaped builder.

import { describe, it, expect } from "vitest"
import { buildWithdrawManifest } from "../../scripts/poster-harness.mjs"

const COMPONENT = "component_rdx1cz468eqyr0fklyrlcsznadrwfnqnesw37vlm9j0xmq2s7427akd82f"
const POSTER = "account_rdx1283xglqdjv6w8jreccxwp7d0u55a8ejrkpegc3uunqedsyqt4mtg5q"
const WORKER = "account_rdx12890803ct999t5ss4qatjyktay82gfy295rr6p4qmhks8twekeqgp9"
const RECEIPT = "resource_rdx1nf57tptrl0ar5vhqzl5ln763ktzg86rcwwxyqh3t7esmd38t5qws7w"
const MEMBER = "resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl"
const AGENT = "resource_rdx1nf3zadak8vdywgx3gdx5xq3svu6tf7x9dsjllvtfh97d6freptcxeh"

const posterCollect = {
  kind: "collect",
  party: "poster",
  outstanding: { reward: "0", bondXrd: "0" },
  receiptResource: RECEIPT,
} as const

const workerCollect = {
  kind: "collect",
  party: "worker",
  outstanding: { reward: "1500", bondXrd: "0" },
  badgeResource: MEMBER,
  badgeLocalId: "<guild_member_poster>",
} as const

describe("buildWithdrawManifest — poster side", () => {
  it("calls withdraw_poster and presents the task receipt", () => {
    const m = buildWithdrawManifest(posterCollect, {
      component: COMPONENT,
      account: POSTER,
      taskId: 1,
    })
    expect(m).toContain('"withdraw_poster"')
    expect(m).toContain(RECEIPT)
    expect(m).toContain("1u64")
  })

  it("passes NO destination — the payee is pinned on chain", () => {
    const m = buildWithdrawManifest(posterCollect, { component: COMPONENT, account: POSTER, taskId: 1 })
    // withdraw_poster takes (task_id, receipt). A deposit_batch or a second
    // account reference would mean a destination crept in — which the blueprint
    // rejects, and which would misrepresent the design to whoever read it.
    expect(m).not.toContain("deposit_batch")
    expect((m.match(/account_rdx/g) ?? []).length).toBe(1)
  })
})

describe("buildWithdrawManifest — worker side", () => {
  it("calls withdraw_worker with the chain-recorded badge", () => {
    const m = buildWithdrawManifest(workerCollect, {
      component: COMPONENT,
      account: WORKER,
      taskId: 1,
    })
    expect(m).toContain('"withdraw_worker"')
    expect(m).toContain(MEMBER)
    expect(m).toContain("<guild_member_poster>")
  })

  it("uses the AGENT badge when the claim was made with one", () => {
    // The resource comes from the affordance, which derives it from the chain's
    // claimer_is_agent — never from local config. A config-sourced resource is
    // exactly the bug that shipped in the agent-client CLI and was caught in
    // review: it agrees by luck on a member-claimed task and is wrong on an
    // agent-claimed one.
    const m = buildWithdrawManifest(
      { ...workerCollect, badgeResource: AGENT, badgeLocalId: "#1#" },
      { component: COMPONENT, account: WORKER, taskId: 7 },
    )
    expect(m).toContain(AGENT)
    expect(m).not.toContain(MEMBER)
    expect(m).toContain("#1#")
    expect(m).toContain("7u64")
  })

  it("passes NO destination either", () => {
    const m = buildWithdrawManifest(workerCollect, { component: COMPONENT, account: WORKER, taskId: 1 })
    expect(m).not.toContain("deposit_batch")
    expect((m.match(/account_rdx/g) ?? []).length).toBe(1)
  })
})

describe("buildWithdrawManifest — the seam refuses what it cannot build", () => {
  it("throws on a non-collect affordance rather than emitting a manifest", () => {
    // A `none` or `blocked` affordance reaching a builder would mean the caller
    // skipped a refusal. Better to throw than to sign something.
    for (const kind of ["none", "blocked"] as const) {
      expect(() =>
        buildWithdrawManifest({ kind, reason: "nothing-owed" } as never, {
          component: COMPONENT,
          account: POSTER,
          taskId: 1,
        }),
      ).toThrow(/collect affordance/)
    }
  })

  it("never builds a poster manifest from a worker affordance", () => {
    // The party is chain-derived and switches the builder, so the two cannot be
    // crossed by a caller passing the wrong role flag.
    const m = buildWithdrawManifest(workerCollect, { component: COMPONENT, account: WORKER, taskId: 1 })
    expect(m).not.toContain('"withdraw_poster"')
    expect(m).not.toContain(RECEIPT)
  })
})
