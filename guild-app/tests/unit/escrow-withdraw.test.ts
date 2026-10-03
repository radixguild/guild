import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  resolveWithdrawAffordance,
  outstandingLanes,
  explainWithdrawBlocker,
  type WithdrawResources,
} from '@/lib/escrow-withdraw'
import type { OnChainTaskInfo } from '@/lib/gateway'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const WORKER = 'account_rdx1worker'
const POSTER = 'account_rdx1poster'
const STRANGER = 'account_rdx1stranger'

const RESOURCES: WithdrawResources = {
  memberBadge: 'resource_rdx1member',
  agentBadge: 'resource_rdx1agent',
  taskReceipt: 'resource_rdx1receipt',
}
/** The LIVE deployment: the dedicated agent badge is dormant, so unset. */
const RESOURCES_AGENT_DORMANT: WithdrawResources = { ...RESOURCES, agentBadge: '' }

function info(over: Partial<OnChainTaskInfo> = {}): OnChainTaskInfo {
  return {
    state: 'Released',
    claimDeadline: null,
    disputeRaisedBy: null,
    entitlements: {
      workerReward: '0',
      posterReward: '0',
      workerBond: '0',
      posterBond: '0',
    },
    entitlementsPresent: true,
    workerAccount: WORKER,
    posterAccount: POSTER,
    claimerBadgeId: '<guild_member_alice>',
    claimerIsAgent: false,
    ...over,
  }
}

const owed = (lanes: Partial<OnChainTaskInfo['entitlements']>, over: Partial<OnChainTaskInfo> = {}) =>
  info({ entitlements: { ...info().entitlements, ...lanes }, ...over })

// ── The D trap: absent fields are not zero ───────────────────────────────────

describe('resolveWithdrawAffordance — the pre-pull component', () => {
  /**
   * The single most important test in this chunk.
   *
   * Against the DEPLOYED escrow every entitlement reads "0" because the fields
   * do not exist, which is byte-identical to a task that settled and was fully
   * collected. If this branch inverted, every settled task on the live site
   * would grow a Collect button calling a `withdraw_worker` method the deployed
   * component does not have — a guaranteed revert, for every user, costing a
   * network fee each time, and looking like the feature simply does not work.
   */
  it('renders NOTHING against a component with no entitlement fields', () => {
    const a = resolveWithdrawAffordance(
      info({ entitlementsPresent: false }),
      WORKER,
      RESOURCES,
    )
    expect(a).toEqual({ kind: 'none', reason: 'no-entitlement-fields' })
  })

  /**
   * ...and the suppression reason is NOT collapsed with `nothing-owed`, because
   * the two are indistinguishable on the wire and mean opposite things. Chunk E
   * makes the same distinction (`unassessable` vs `settled`) and its alerting
   * depends on it; a caller that treats "cannot say" as "nothing owed" is
   * exactly the permanently-silent watcher D warned about.
   */
  it('distinguishes "cannot say" from "nothing owed" — same amounts, different reason', () => {
    const cannotSay = resolveWithdrawAffordance(
      info({ entitlementsPresent: false }),
      WORKER,
      RESOURCES,
    )
    const nothingOwed = resolveWithdrawAffordance(
      info({ entitlementsPresent: true }),
      WORKER,
      RESOURCES,
    )
    expect(cannotSay).toEqual({ kind: 'none', reason: 'no-entitlement-fields' })
    expect(nothingOwed).toEqual({ kind: 'none', reason: 'nothing-owed' })
    expect(cannotSay).not.toEqual(nothingOwed)
  })

  /**
   * The capability of the COMPONENT is settled before anything about the
   * VIEWER — and this is the only externally-visible consequence of the
   * entitlementsPresent gate, so it is the only thing that can pin it.
   *
   * ⚠️ Worth stating plainly, because a mutation found it: that gate is
   * REDUNDANT for suppression. Deleting it entirely still hides the button,
   * twice over — `outstandingForParty` returns null on exactly this condition
   * (D's fix), and a pre-pull component's amounts all read "0" anyway. So a
   * mutation removing it leaves every behavioural test green, which makes the
   * gate look like decoration. It is not: it decides the REASON, and the reason
   * is what stops a later change from rendering an affirmative "all collected"
   * against a component that never collected anything. This test and the one
   * above are what hold that line — asserting the precedence here, the
   * distinction there.
   */
  it('decides component capability BEFORE viewer identity', () => {
    expect(
      resolveWithdrawAffordance(info({ entitlementsPresent: false }), STRANGER, RESOURCES),
    ).toEqual({ kind: 'none', reason: 'no-entitlement-fields' })
    // Same viewer, a component that DOES do pull: now identity decides.
    expect(
      resolveWithdrawAffordance(info({ entitlementsPresent: true }), STRANGER, RESOURCES),
    ).toEqual({ kind: 'none', reason: 'not-a-payee' })
  })
})

// ── Who is a payee ───────────────────────────────────────────────────────────

describe('resolveWithdrawAffordance — payee identity', () => {
  it('offers nothing to an account that is neither pinned payee', () => {
    expect(
      resolveWithdrawAffordance(owed({ workerReward: '100' }), STRANGER, RESOURCES),
    ).toEqual({ kind: 'none', reason: 'not-a-payee' })
  })

  it('offers nothing when disconnected', () => {
    expect(resolveWithdrawAffordance(owed({ workerReward: '100' }), null, RESOURCES)).toEqual({
      kind: 'none',
      reason: 'not-on-chain',
    })
  })

  it('treats an unreadable TaskInfo as unknown, never as nothing-owed', () => {
    expect(resolveWithdrawAffordance(null, WORKER, RESOURCES)).toEqual({
      kind: 'none',
      reason: 'unknown',
    })
  })

  /**
   * Identity comes from the CHAIN PINS, not from the DB's creatorId/assigneeId.
   * The pins are where the blueprint actually deposits, so they are the only
   * definition of "your money" that agrees with where the money goes. Moving
   * the pin moves the affordance — asserted here so a later refactor cannot
   * quietly swap in a DB column that merely usually matches.
   */
  it('follows the pin: the SAME viewer loses the affordance when the pin moves', () => {
    const owedToWorker = owed({ workerReward: '100' })
    expect(resolveWithdrawAffordance(owedToWorker, WORKER, RESOURCES).kind).toBe('collect')

    const repinned = owed({ workerReward: '100' }, { workerAccount: STRANGER })
    expect(resolveWithdrawAffordance(repinned, WORKER, RESOURCES)).toEqual({
      kind: 'none',
      reason: 'not-a-payee',
    })
  })
})

// ── Which lanes count ────────────────────────────────────────────────────────

describe('resolveWithdrawAffordance — lanes', () => {
  it('offers the worker their reward', () => {
    expect(resolveWithdrawAffordance(owed({ workerReward: '100' }), WORKER, RESOURCES)).toEqual({
      kind: 'collect',
      party: 'worker',
      outstanding: { reward: '100', bondXrd: '0' },
      badgeResource: RESOURCES.memberBadge,
      badgeLocalId: '<guild_member_alice>',
    })
  })

  /**
   * A worker can be owed the BOND alone — cancel_task_by_poster_after_claim
   * returns it without any reward ever being due. `withdraw_worker` collects
   * both lanes in one call (deposit_both_lanes), so a reward-only check would
   * strand the bond with no affordance anywhere in the product.
   */
  it('offers the worker a bond-only entitlement (no reward ever due)', () => {
    const a = resolveWithdrawAffordance(owed({ workerBond: '5' }), WORKER, RESOURCES)
    expect(a).toMatchObject({
      kind: 'collect',
      party: 'worker',
      outstanding: { reward: '0', bondXrd: '5' },
    })
  })

  /** Poster side of the same: a forfeited claim bond after an expire (D-P4). */
  it('offers the poster a bond-only entitlement', () => {
    const a = resolveWithdrawAffordance(owed({ posterBond: '5' }), POSTER, RESOURCES)
    expect(a).toMatchObject({
      kind: 'collect',
      party: 'poster',
      outstanding: { reward: '0', bondXrd: '5' },
    })
  })

  /**
   * ⚠️ This test was called "sums both lanes" and asserted '105'. The sum WAS the
   * defect: the reward lane is the task's reward token and the bond lane is
   * always XRD, so 100 + 5 is a number in no currency, and both the UI and the
   * TG alert then printed it with "XRD" attached. The blueprint keeps these in
   * two separate view methods precisely so no caller can add them.
   *
   * One button still collects both — `withdraw_*` takes both lanes in one call
   * (deposit_both_lanes). What changed is that the AMOUNTS stay distinct.
   */
  it('carries both lanes separately — one button, two amounts, never a total', () => {
    const a = resolveWithdrawAffordance(
      owed({ workerReward: '100', workerBond: '5' }),
      WORKER,
      RESOURCES,
    )
    expect(a).toMatchObject({ outstanding: { reward: '100', bondXrd: '5' } })
    expect(JSON.stringify(a)).not.toContain('105')
  })

  it('outstandingLanes names exactly the lanes that owe something', () => {
    expect(outstandingLanes({ reward: '100', bondXrd: '5' })).toEqual(['reward', 'bond'])
    expect(outstandingLanes({ reward: '0', bondXrd: '5' })).toEqual(['bond'])
    expect(outstandingLanes({ reward: '100', bondXrd: '0' })).toEqual(['reward'])
    expect(outstandingLanes({ reward: '0', bondXrd: '0' })).toEqual([])
  })

  it('outstandingLanes uses Decimal precision, not the float\'s', () => {
    // 19dp truncates to zero on chain, so it is not an owed lane.
    expect(outstandingLanes({ reward: '0.0000000000000000001', bondXrd: '0' })).toEqual([])
    expect(outstandingLanes({ reward: '0.000000000000000001', bondXrd: '0' })).toEqual(['reward'])
  })

  it("does not offer the worker the POSTER's entitlement", () => {
    expect(resolveWithdrawAffordance(owed({ posterReward: '5' }), WORKER, RESOURCES)).toEqual({
      kind: 'none',
      reason: 'nothing-owed',
    })
  })

  it('treats a full-precision 18dp amount as owed', () => {
    const exact = '0.000000000000000001' // exactly one atom
    const a = resolveWithdrawAffordance(owed({ workerReward: exact }), WORKER, RESOURCES)
    expect(a).toMatchObject({ kind: 'collect', outstanding: { reward: exact, bondXrd: '0' } })
  })

  /**
   * A 19-dp amount truncates to zero at Decimal's scale, and "nothing owed" is
   * the CORRECT answer: the chain cannot hold it, so no withdrawal can move it
   * and a Collect button would revert on `nothing to withdraw for this party`.
   *
   * ⚠️ This test does NOT prove exact-vs-float arithmetic, and an earlier
   * version of it claimed to. `Number('0.0000000000000000001')` is 1e-19,
   * comfortably positive as a double — the truncation happens upstream in
   * gateway's addExactDecimalStrings, not in the `> 0` comparison. Swapping
   * isPositiveDecimal for `Number(v) > 0` leaves this green, which is how the
   * false claim was found. Fourth test this phase to assert precision it did
   * not exercise; the reflexive "smallest value" example keeps not being the
   * discriminating one.
   */
  it('treats a sub-atomic (19dp) amount as nothing to collect', () => {
    const tiny = '0.0000000000000000001'
    expect(Number(tiny)).toBeGreaterThan(0) // a float sees it — hence not the discriminator
    expect(resolveWithdrawAffordance(owed({ workerReward: tiny }), WORKER, RESOURCES)).toEqual({
      kind: 'none',
      reason: 'nothing-owed',
    })
  })

  /**
   * What the money path IS guarded by: format validation. `addExactDecimalStrings`
   * accepts only plain `\d+(\.\d+)?`, so anything else scales to zero and the
   * button stays hidden. These are the values that actually discriminate — each
   * one is positive under a naive `Number(...)` and must not become a Collect
   * offer for an amount no withdrawal can move.
   */
  it.each([
    ['scientific notation', '1e-5'],
    ['a leading plus', '+5'],
    ['leading whitespace', ' 5'],
    ['a thousands separator', '1,000'],
    ['not a number at all', 'NaN'],
  ])('refuses to treat a malformed amount as owed (%s)', (_label, amount) => {
    expect(
      resolveWithdrawAffordance(owed({ workerReward: amount }), WORKER, RESOURCES),
    ).toEqual({ kind: 'none', reason: 'nothing-owed' })
  })
})

// ── The agent-badge trap (chunk G's own) ─────────────────────────────────────

describe('resolveWithdrawAffordance — which badge the worker presents', () => {
  /**
   * `withdraw_worker` asserts the presented resource equals the CLAIMER's
   * resource, picked on-chain off `claimer_is_agent` (lib.rs's `withdraw_worker`
   * `claimer_resource` if/else and its `assert_eq!` against the presented badge). The
   * manifest has to name one, so the choice is not cosmetic: naming the wrong
   * resource is a guaranteed revert the worker pays a fee to discover.
   */
  it('presents the AGENT badge for an agent-claimed task', () => {
    const a = resolveWithdrawAffordance(
      owed({ workerReward: '100' }, { claimerIsAgent: true, claimerBadgeId: '<agent_7>' }),
      WORKER,
      RESOURCES,
    )
    expect(a).toEqual({
      kind: 'collect',
      party: 'worker',
      outstanding: { reward: '100', bondXrd: '0' },
      badgeResource: RESOURCES.agentBadge,
      badgeLocalId: '<agent_7>',
    })
  })

  it('presents the MEMBER badge for a member-claimed task', () => {
    const a = resolveWithdrawAffordance(
      owed({ workerReward: '100' }, { claimerIsAgent: false }),
      WORKER,
      RESOURCES,
    )
    expect(a).toMatchObject({ badgeResource: RESOURCES.memberBadge })
  })

  /**
   * The live configuration: NEXT_PUBLIC_AGENT_BADGE_NFT is "" (dormant by
   * decision, config.ts:29). An agent-claimed task is then uncollectable FROM
   * THIS PAGE — and must say so, loudly, rather than render nothing. The
   * viewer is owed money; a silently missing button is the only outcome with
   * nothing to send them looking. It must equally never fall back to the member
   * badge, which would build a manifest that cannot succeed.
   */
  it('BLOCKS (does not silently hide, and does not fall back) when the agent badge is unset', () => {
    const a = resolveWithdrawAffordance(
      owed({ workerReward: '100' }, { claimerIsAgent: true }),
      WORKER,
      RESOURCES_AGENT_DORMANT,
    )
    expect(a).toEqual({
      kind: 'blocked',
      party: 'worker',
      outstanding: { reward: '100', bondXrd: '0' },
      reason: 'agent-badge-not-configured',
    })
    expect(JSON.stringify(a)).not.toContain(RESOURCES.memberBadge)
  })

  it('does NOT block a member-claimed task just because the agent badge is unset', () => {
    const a = resolveWithdrawAffordance(
      owed({ workerReward: '100' }, { claimerIsAgent: false }),
      WORKER,
      RESOURCES_AGENT_DORMANT,
    )
    expect(a).toMatchObject({ kind: 'collect', badgeResource: RESOURCES.memberBadge })
  })

  it('blocks when the claiming badge id is unknown — nothing correct can be built', () => {
    const a = resolveWithdrawAffordance(
      owed({ workerReward: '100' }, { claimerBadgeId: null }),
      WORKER,
      RESOURCES,
    )
    expect(a).toEqual({
      kind: 'blocked',
      party: 'worker',
      outstanding: { reward: '100', bondXrd: '0' },
      reason: 'claimer-badge-unknown',
    })
  })

  /** A blocked affordance is useless without a line telling the payee what to do. */
  it('explains every blocker with a non-empty, actionable line', () => {
    for (const reason of ['agent-badge-not-configured', 'claimer-badge-unknown'] as const) {
      expect(explainWithdrawBlocker(reason).length).toBeGreaterThan(20)
    }
  })

  /**
   * The poster's receipt local id is the task id, derived inside
   * withdrawPosterManifest. The poster variant therefore carries NO id field to
   * leave blank — an empty-string sentinel would be a value the type permits
   * and the builder rejects, which is the shape chunk F deliberately made
   * unrepresentable rather than merely validated.
   */
  it('gives the poster a receipt resource and no badge fields at all', () => {
    const a = resolveWithdrawAffordance(owed({ posterReward: '5' }), POSTER, RESOURCES)
    expect(a).toEqual({
      kind: 'collect',
      party: 'poster',
      outstanding: { reward: '5', bondXrd: '0' },
      receiptResource: RESOURCES.taskReceipt,
    })
    expect(Object.keys(a)).not.toContain('badgeLocalId')
    expect(Object.keys(a)).not.toContain('badgeResource')
  })
})

// ── Status-independence, mechanically ────────────────────────────────────────

describe('the withdraw decision is status-independent', () => {
  /**
   * Chunk E's lesson, enforced rather than described. Under pull an entitlement
   * outlives the lifecycle: the worker's reward is owed while the task reads
   * `paid`, the poster's refund while it reads `cancelled`, the poster's
   * forfeited bond while it reads `open` again after an expire. Any DB-status
   * gate would hide the money on exactly the rows that owe it.
   *
   * A prose comment saying so is what E's row calls decoration, so this reads
   * the source: the module must take no status input and consult none. Planting
   * `if (status === 'paid')` in escrow-withdraw.ts turns this red.
   */
  const SOURCE = readFileSync(
    join(process.cwd(), 'src/lib/escrow-withdraw.ts'),
    'utf8',
  )
  // Comments legitimately discuss statuses by name; code must not branch on them.
  const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it.each(['paid', 'settled', 'refunded', 'cancelled', 'submitted', 'assigned', 'disputed'])(
    'never branches on the DB task status %s',
    (status) => {
      expect(CODE).not.toContain(`'${status}'`)
      expect(CODE).not.toContain(`"${status}"`)
    },
  )

  it('takes no status parameter at all', () => {
    expect(CODE).not.toMatch(/\bstatus\b/)
    // Signature is (info, account, resources) — three arguments, no fourth for
    // a caller to start threading a status through.
    expect(resolveWithdrawAffordance.length).toBe(3)
  })

  /**
   * The behavioural half of the same claim: the on-chain TaskState is likewise
   * not consulted. A Released task and a Cancelled one with the same lanes owe
   * the same money, and both must offer it.
   */
  it.each(['Open', 'Claimed', 'Submitted', 'Released', 'Cancelled', 'Refunded', 'Disputed'])(
    'offers the same collection whatever the on-chain state is (%s)',
    (state) => {
      const a = resolveWithdrawAffordance(
        owed({ workerReward: '100' }, { state: state as OnChainTaskInfo['state'] }),
        WORKER,
        RESOURCES,
      )
      expect(a).toMatchObject({ kind: 'collect', outstanding: { reward: '100', bondXrd: '0' } })
    },
  )
})
