/**
 * Wallet-mock harness — an in-memory fake Radix ledger + a manifest VM + a mock
 * RadixDappToolkit, for battle-testing the escrow settlement seam end-to-end.
 *
 * WHY THIS EXISTS
 * ---------------
 * The off-chain task lifecycle is covered by handler-level integration tests
 * (tests/integration/api-lifecycle.test.ts), but every ON-CHAIN transition there
 * is *seeded* ("what the confirm route would have written"), never *exercised*.
 * The unit tests likewise mock the manifest builders away (escrow-approve-m1.test
 * stubs approveAndReleaseManifest). So the one seam that actually moves money —
 * UI wrapper → real manifest builder → wallet signer → on-chain settlement — had
 * no end-to-end test. That is exactly where the M1 / H1 / BUG-7 class of bugs
 * lives (wrong bucket, wrong amount, wrong recipient).
 *
 * This harness closes it. `MockLedger` EXECUTES the real manifest text the real
 * builders emit, against a real (if tiny) model of account vaults + the escrow
 * component's held funds, and lets a test assert the money actually lands on the
 * worker. No network, no signer, no XRD.
 *
 * WHAT IT MODELS
 * --------------
 * A minimal Radix transaction VM: a worktop, named buckets, per-account fungible
 * (XRD) balances and non-fungible (badge / receipt NFT) holdings, and the escrow
 * component's task table + held vault. It interprets only the instruction set the
 * escrow manifest builders emit (src/lib/manifests.ts) and throws loudly on
 * anything it does not recognise — so a manifest it silently "passes" is a
 * manifest it genuinely executed, never one it skipped.
 *
 * WHAT IT DOES NOT MODEL
 * ----------------------
 * Blueprint-internal asserts beyond state-machine ordering + fund conservation
 * (dust rounding, fee math, proof-badge *authorisation* rules) — those are the
 * Scrypto blueprint's own cargo tests (run on Linux; Mac can't build the WASM).
 * The harness proves the APP LAYER routes value correctly given an honest chain;
 * it is not a substitute for the money-handling blueprint's security audit.
 */

/** Canonical mainnet XRD — the resource the escrow manifests withdraw/settle in. */
export const XRD =
  "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"

export type OnChainTaskState =
  | "Open"
  | "Claimed"
  | "Submitted"
  | "Disputed"
  | "Released"
  | "Refunded"

/** The component's `dispute_auto_resolve_default` (blueprint AutoResolveDefault). */
export type DisputeAutoResolveDefault = "FavorDisputeRaiser" | "SplitEvenly" | "ReturnToPoster"

export type DisputeParty = "Poster" | "Worker"

export interface LedgerConfig {
  /** Escrow component the manifests target (config.ESCROW_COMPONENT). */
  escrowComponent: string
  /** Task Receipt NFT resource, minted to the poster on create_task. */
  receiptResource: string
  /** Claim Receipt NFT resource, minted to the worker on claim_task. */
  claimReceiptResource: string
  /** XRD resource address (defaults to canonical mainnet XRD). */
  xrd?: string
  /**
   * Exact claim_bond the blueprint requires (lib.rs `claim_task`'s
   * `claim_bond.amount() == required_bond` assert enforces equality).
   * Defaults to 10 XRD — a fixture value for this mock's flat-bond model,
   * independent of config.ESCROW_CLAIM_BOND_XRD (now 76.45, the live Wave B
   * floor of a proportional bond). Nothing ties the two together.
   */
  claimBondXrd?: number
  /**
   * min_insurance_fraction the blueprint enforces on create_task (lib.rs
   * `create_task`'s insurance ≥ reward × fraction assert, an EXACT product —
   * no rounding). Deployed 0.05.
   */
  minInsuranceFraction?: number
  /**
   * The component's `dispute_auto_resolve_default` (lib.rs `auto_resolve_dispute`'s
   * `AutoResolveDefault::SplitEvenly` match arm). Defaults to
   * "SplitEvenly" — the LIVE mainnet component's value (operator-verified
   * 2026-07-16), so the harness reproduces the H1 mismatch by default.
   */
  disputeAutoResolveDefault?: DisputeAutoResolveDefault
}

/** A single emitted event, keyed by the tx that produced it. */
export interface LedgerEvent {
  name: string
  taskId: number
  fields: Record<string, string>
}

/** Thrown when a manifest violates a precondition (a real chain would revert). */
export class LedgerRevert extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LedgerRevert"
  }
}

interface NftRef {
  resource: string
  id: string
}

interface Account {
  fungible: Map<string, number>
  nonFungible: NftRef[]
}

interface TaskRecord {
  state: OnChainTaskState
  poster: string
  worker: string | null
  reward: number
  insurance: number
  bond: number
  claimReceiptId: number | null
  workBriefHash: string
  /** Which party raised the dispute (set on raise_dispute; null otherwise). */
  disputeRaisedBy: DisputeParty | null
  // ── PULL entitlement lanes (lib.rs Task) ─────────────────────────────────
  // Settled but NOT yet collected. Settlement moves value into these; only a
  // withdraw_* moves it out of the component. They are bookkeeping claims
  // against componentVault, not a separate pot — which is what keeps the
  // conservation assertions (poster + worker + vault == total) exact.
  workerEntitled: number
  posterEntitled: number
  workerBondEntitled: number
  posterBondEntitled: number
  /**
   * PAYEE PIN, worker side. The exact badge that claimed — resource AND local
   * id. `withdraw_worker` asserts the presented badge is the SAME non-fungible
   * (lib.rs `withdraw_worker`'s `assert_eq!(Some(badge_id), task.claimer_badge_id, ...)`
   * local-id check), not merely one of the right resource, which matters because
   * the member badge is a public mint: without the local-id check anyone could
   * mint a badge and collect another worker's entitlement.
   */
  claimerBadge: { resource: string; localId: string } | null
}

/** Worktop: transient resources produced/consumed within a single manifest. */
interface Worktop {
  fungible: Map<string, number>
  nonFungible: NftRef[]
}

type BucketContent =
  | { kind: "fungible"; resource: string; amount: number }
  | { kind: "nonFungible"; items: NftRef[] }

// ── Manifest instruction parsing ────────────────────────────────────────────
// The builders emit a very regular, machine-generated manifest text: one
// instruction per `;`, typed args as Address("…") / Decimal("…") / Bucket("…") /
// Bytes("…") / NonFungibleLocalId("…") / <n>u64. We keyword-dispatch on the head
// token and pull typed args by role, rather than positionally.

const reAll = (src: string, re: RegExp): string[] => {
  const out: string[] = []
  let m: RegExpExecArray | null
  const g = new RegExp(re.source, "g")
  while ((m = g.exec(src))) out.push(m[1])
  return out
}

const addresses = (s: string) => reAll(s, /Address\("([^"]+)"\)/)
const decimals = (s: string) => reAll(s, /Decimal\("([^"]+)"\)/)
const bucketNames = (s: string) => reAll(s, /Bucket\("([^"]+)"\)/)
const bytesArgs = (s: string) => reAll(s, /Bytes\("([^"]+)"\)/)
const nfLocalIds = (s: string) => reAll(s, /NonFungibleLocalId\("([^"]+)"\)/)
const u64s = (s: string) => reAll(s, /\b(\d+)u64\b/).map(Number)
const proofNames = (s: string) => reAll(s, /Proof\("([^"]+)"\)/)

/** For a CALL_METHOD chunk: [targetAddress, methodName]. */
function callTarget(chunk: string): { target: string; method: string } | null {
  const m = chunk.match(/Address\("([^"]+)"\)\s+"([^"]+)"/)
  return m ? { target: m[1], method: m[2] } : null
}

/** `#7#` → "7". */
function intLocalId(id: string): string {
  const m = id.match(/^#(\d+)#$/)
  if (!m) throw new LedgerRevert(`unexpected local id form: ${id}`)
  return m[1]
}

export class MockLedger {
  readonly cfg: Required<LedgerConfig>
  private accounts = new Map<string, Account>()
  private tasks = new Map<number, TaskRecord>()
  private componentVault = 0
  private nextTaskId = 1
  private nextClaimReceiptId = 1
  private txCounter = 0
  private txLog = new Map<string, LedgerEvent[]>()
  // Transient per-tx proof tracking (reset each execute): create_proof pushes a
  // {resource, account} onto the auth zone; POP_FROM_AUTH_ZONE binds it to a
  // named Proof; a method call (raise_dispute) reads the named proof's resource.
  private txAuthZone: { resource: string; account: string; localId: string | null }[] = []
  // Who signed the manifest currently executing, when the test declared it via
  // makeRdt(signer). Gates the owner-restricted deposit_batch; null = undeclared.
  private txSigner: string | null = null
  private txProofs = new Map<string, { resource: string; account: string; localId: string | null }>()

  constructor(cfg: LedgerConfig) {
    this.cfg = {
      xrd: XRD,
      claimBondXrd: 10, // fixture default, independent of config.ESCROW_CLAIM_BOND_XRD
      minInsuranceFraction: 0.05,
      disputeAutoResolveDefault: "SplitEvenly",
      ...cfg,
    }
  }

  // ── Seeding + inspection (for tests) ──────────────────────────────────────

  /** Ensure an account exists; optionally seed XRD and badge NFTs. */
  seedAccount(
    address: string,
    opts: { xrd?: number; badges?: NftRef[] } = {},
  ): this {
    const acct = this.account(address)
    if (opts.xrd) acct.fungible.set(this.cfg.xrd, (acct.fungible.get(this.cfg.xrd) ?? 0) + opts.xrd)
    if (opts.badges) acct.nonFungible.push(...opts.badges)
    return this
  }

  balanceOf(address: string, resource = this.cfg.xrd): number {
    return this.accounts.get(address)?.fungible.get(resource) ?? 0
  }

  nftsOf(address: string): readonly NftRef[] {
    return this.accounts.get(address)?.nonFungible ?? []
  }

  taskState(taskId: number): OnChainTaskState | null {
    return this.tasks.get(taskId)?.state ?? null
  }

  taskRecord(taskId: number): Readonly<TaskRecord> | null {
    return this.tasks.get(taskId) ?? null
  }

  /** Total XRD the escrow component currently holds across all tasks. */
  get vault(): number {
    return this.componentVault
  }

  /**
   * PULL: what each party is OWED but has not collected, per lane.
   *
   * Read this wherever a push-era test read a balance straight after approve.
   * Settlement no longer moves money — it moves a CLAIM — so a task can be
   * Released with the full reward still inside the component and the worker's
   * account untouched. That gap is not a harness artefact; it is the product
   * behaviour the worker sees, and the reason "paid" needs the entitlement
   * ledger to stay honest.
   */
  entitlements(taskId: number): {
    workerReward: number
    posterReward: number
    workerBond: number
    posterBond: number
  } | null {
    const t = this.tasks.get(taskId)
    if (!t) return null
    return {
      workerReward: t.workerEntitled,
      posterReward: t.posterEntitled,
      workerBond: t.workerBondEntitled,
      posterBond: t.posterBondEntitled,
    }
  }

  /** Everything still owed across both lanes for one party. */
  owed(taskId: number, party: "Worker" | "Poster"): number {
    const e = this.entitlements(taskId)
    if (!e) return 0
    return party === "Worker" ? e.workerReward + e.workerBond : e.posterReward + e.posterBond
  }

  /** The TaskCreatedEvent a given fund tx emitted — feeds readEscrowTaskCreated. */
  taskCreatedEvent(
    intentHash: string,
  ): {
    taskId: number
    rewardAmount: string
    rewardToken: string
    insuranceAmount: string
    poster: string
    workBriefHash: string
  } | null {
    const ev = (this.txLog.get(intentHash) ?? []).find((e) => e.name === "TaskCreatedEvent")
    if (!ev) return null
    return {
      taskId: ev.taskId,
      rewardAmount: ev.fields.reward_amount,
      rewardToken: ev.fields.reward_token,
      insuranceAmount: ev.fields.insurance_amount,
      poster: ev.fields.poster,
      workBriefHash: ev.fields.work_brief_hash,
    }
  }

  eventsOf(intentHash: string): readonly LedgerEvent[] {
    return this.txLog.get(intentHash) ?? []
  }

  /** The DisputeRaisedEvent a raise_dispute tx emitted — feeds readDisputeRaised. */
  disputeRaisedEvent(intentHash: string): { taskId: number; raisedBy: DisputeParty } | null {
    const ev = (this.txLog.get(intentHash) ?? []).find((e) => e.name === "DisputeRaisedEvent")
    if (!ev) return null
    return { taskId: ev.taskId, raisedBy: ev.fields.raised_by as DisputeParty }
  }

  /**
   * This component's configured auto-resolve ruling — what `get_config` /
   * `dispute_auto_resolve_default` serves on chain. The finalize path reads it
   * to route its legs, so the harness must answer with the same value its own
   * settlement applies.
   */
  autoResolveDefault(): DisputeAutoResolveDefault {
    return this.cfg.disputeAutoResolveDefault ?? "SplitEvenly"
  }

  /**
   * The DisputeAutoResolvedEvent an auto_resolve tx emitted — the INTENDED split
   * per the component default (feeds readDisputeAutoResolved / the confirm route).
   * Under H1 this diverged from what the finalize manifest actually moved.
   */
  disputeAutoResolvedEvent(intentHash: string): { taskId: number; workerAmount: string; posterAmount: string } | null {
    const ev = (this.txLog.get(intentHash) ?? []).find((e) => e.name === "DisputeAutoResolvedEvent")
    if (!ev) return null
    return { taskId: ev.taskId, workerAmount: ev.fields.worker_amount, posterAmount: ev.fields.poster_amount }
  }

  /**
   * A mock RadixDappToolkit: `walletApi.sendTransaction` executes the manifest
   * against this ledger and returns the neverthrow-shaped Result the real SDK
   * returns (isOk()/value.transactionIntentHash, or isOk()===false/error).
   */
  makeRdt(signer?: string): { walletApi: { sendTransaction: (req: { transactionManifest: string }) => Promise<unknown> } } {
    return {
      walletApi: {
        sendTransaction: async ({ transactionManifest }: { transactionManifest: string }) => {
          try {
            const intentHash = this.execute(transactionManifest, signer)
            return {
              isOk: () => true,
              isErr: () => false,
              value: { transactionIntentHash: intentHash },
            }
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            // Match the real SDK's structured err value ({ error, message }) —
            // send() JSON.stringify's result.error, and humanizeTxError keys off
            // that JSON shape (see escrow-errors.test.ts). A revert models a
            // committed-failure the wallet surfaced as a rejected transaction.
            return { isOk: () => false, isErr: () => true, error: { error: "transactionRejected", message } }
          }
        },
      },
    }
  }

  // ── The VM ────────────────────────────────────────────────────────────────

  /**
   * Execute a manifest atomically. Returns the intent hash on success; throws
   * LedgerRevert on a precondition violation (which the mock rdt turns into a
   * failed-tx Result, exactly as a wallet rejection would surface). All state
   * mutations are applied to a scratch copy and only committed if the whole
   * manifest succeeds — a revert leaves the ledger untouched.
   */
  execute(manifest: string, signer?: string): string {
    // Who signs decides which owner-gated methods are callable (deposit_batch).
    // Always reset it, so a signer never leaks in from a previous transaction.
    this.txSigner = signer ?? null
    // Snapshot for atomic rollback on revert.
    const snapshot = this.snapshot()
    const worktop: Worktop = { fungible: new Map(), nonFungible: [] }
    const buckets = new Map<string, BucketContent>()
    const events: LedgerEvent[] = []
    this.txAuthZone = []
    this.txProofs.clear()

    try {
      const chunks = manifest
        .split(";")
        .map((c) => c.trim())
        .filter(Boolean)
      for (const chunk of chunks) {
        this.step(chunk, worktop, buckets, events)
      }
      // Worktop must be empty at commit — every builder ends with a
      // deposit_batch ENTIRE_WORKTOP, so leftover value is a routing bug.
      if (worktop.fungible.size > 0 || worktop.nonFungible.length > 0) {
        const leftover =
          [...worktop.fungible].map(([r, a]) => `${a} ${r.slice(-6)}`).join(", ") +
          worktop.nonFungible.map((n) => ` nft ${n.resource.slice(-6)}:${n.id}`).join("")
        throw new LedgerRevert(`worktop not empty at commit — dropped value: ${leftover}`)
      }
      // Every bucket must be consumed too — a resource taken into a named bucket
      // that no CALL_METHOD spends is value dropped just as surely as leftover
      // worktop (the engine holds it in the intent and the tx fails to balance).
      if (buckets.size > 0) {
        throw new LedgerRevert(`unconsumed bucket(s) at commit: ${[...buckets.keys()].join(", ")}`)
      }
      const intentHash = `txid_${++this.txCounter}`
      this.txLog.set(intentHash, events)
      return intentHash
    } catch (e) {
      this.restore(snapshot)
      throw e
    }
  }

  private step(
    chunk: string,
    worktop: Worktop,
    buckets: Map<string, BucketContent>,
    events: LedgerEvent[],
  ): void {
    const head = chunk.split(/\s/)[0]

    if (head === "TAKE_FROM_WORKTOP") {
      const res = addresses(chunk)[0]
      const amount = Number(decimals(chunk)[0])
      const name = bucketNames(chunk)[0]
      this.worktopTakeFungible(worktop, res, amount)
      buckets.set(name, { kind: "fungible", resource: res, amount })
      return
    }
    if (head === "TAKE_ALL_FROM_WORKTOP") {
      const res = addresses(chunk)[0]
      const name = bucketNames(chunk)[0]
      const items = worktop.nonFungible.filter((n) => n.resource === res)
      if (items.length === 0) throw new LedgerRevert(`TAKE_ALL: nothing of ${res} on worktop`)
      worktop.nonFungible = worktop.nonFungible.filter((n) => n.resource !== res)
      buckets.set(name, { kind: "nonFungible", items })
      return
    }
    if (head === "POP_FROM_AUTH_ZONE") {
      // Bind the most-recently created proof to its named handle so a later
      // method call (raise_dispute) can read which resource authorised it.
      const name = proofNames(chunk)[0]
      const p = this.txAuthZone.pop()
      if (name && p) this.txProofs.set(name, p)
      return
    }
    if (head === "CALL_METHOD") {
      const call = callTarget(chunk)
      if (!call) throw new LedgerRevert(`unparseable CALL_METHOD: ${chunk.slice(0, 40)}…`)
      this.callMethod(call.target, call.method, chunk, worktop, buckets, events)
      return
    }
    throw new LedgerRevert(`unsupported instruction: ${head}`)
  }

  private callMethod(
    target: string,
    method: string,
    chunk: string,
    worktop: Worktop,
    buckets: Map<string, BucketContent>,
    events: LedgerEvent[],
  ): void {
    switch (method) {
      case "withdraw": {
        // target=account; args: Address(resource), Decimal(amount)
        const res = addresses(chunk)[1]
        const amount = Number(decimals(chunk)[0])
        this.accountWithdrawFungible(target, res, amount)
        worktop.fungible.set(res, (worktop.fungible.get(res) ?? 0) + amount)
        return
      }
      case "withdraw_non_fungibles": {
        const res = addresses(chunk)[1]
        const id = nfLocalIds(chunk)[0]
        this.accountWithdrawNft(target, res, id)
        worktop.nonFungible.push({ resource: res, id })
        return
      }
      case "create_proof_of_non_fungibles":
      case "create_proof_of_amount": {
        // A badge proof: the account must HOLD the resource. We assert presence
        // A badge proof: the account must HOLD the resource. We assert presence
        // only — not the blueprint's authorisation semantics. Presence gates
        // nothing beyond the network fee: the member badge is a public mint
        // (src/lib/manifests.ts:26-44) with no supply bound.
        const res = addresses(chunk)[1]
        const acct = this.accounts.get(target)
        const holds =
          method === "create_proof_of_amount"
            ? (acct?.fungible.get(res) ?? 0) > 0 || (acct?.nonFungible.some((n) => n.resource === res) ?? false)
            : acct?.nonFungible.some((n) => n.resource === res) ?? false
        if (!holds) throw new LedgerRevert(`proof failed: ${target} holds no ${res}`)
        // Record the proof's resource + holder so a POP + method call can read it.
        // The LOCAL ID matters under pull: approve_and_release, cancel_task and
        // withdraw_poster all derive task_id from the receipt proof's id rather
        // than from an argument, so a receipt for the wrong task must revert.
        // Recording only the resource would let the harness green exactly that.
        this.txAuthZone.push({ resource: res, account: target, localId: nfLocalIds(chunk)[0] ?? null })
        return
      }
      case "try_deposit_or_abort": {
        const name = bucketNames(chunk)[0]
        this.depositBucket(target, this.takeBucket(buckets, name))
        return
      }
      // The public batch variant — callable by anyone, so no signer check.
      case "try_deposit_batch_or_abort": {
        this.depositWorktop(target, worktop)
        return
      }
      case "deposit_batch": {
        // Expression("ENTIRE_WORKTOP") — deposit everything remaining, clear worktop.
        // `Account::deposit_batch` is `_owner_`-restricted: only the signer's own
        // account accepts it. Aiming it at a counterparty reverts on mainnet with
        // an AuthError, so a manifest that does so must not settle here either —
        // otherwise the harness greens a transaction the chain would reject. The
        // public variant is try_deposit_batch_or_abort. Enforced only when the
        // test declared a signer (makeRdt(signer)); unattributed manifests keep
        // the older permissive behaviour.
        // No `this.txSigner &&` short-circuit: an undeclared signer must not
        // silently skip the check, or a suite that forgets to declare one goes
        // back to certifying manifests the chain rejects. Declaring the signer is
        // the contract — makeRdt(signer) / execute(manifest, signer).
        if (target !== this.txSigner) {
          throw new LedgerRevert(
            `deposit_batch: ${target} is not the signer (${this.txSigner ?? "undeclared"}) — ` +
              "Account::deposit_batch is owner-restricted; use try_deposit_batch_or_abort",
          )
        }
        this.depositWorktop(target, worktop)
        return
      }
      case "create_task":
        return this.doCreateTask(target, chunk, worktop, buckets, events)
      case "claim_task":
        return this.doClaimTask(target, chunk, worktop, buckets, events)
      case "submit_task":
        return this.doSubmitTask(target, chunk, worktop, buckets, events)
      case "approve_and_release":
        return this.doApproveAndRelease(target, chunk, events)
      case "cancel_task":
        return this.doCancelTask(target, chunk, events)
      case "cancel_task_by_poster_after_claim":
        return this.doCancelAfterClaim(target, chunk, events)
      case "raise_dispute":
        return this.doRaiseDispute(target, chunk, events)
      case "auto_resolve_dispute":
        return this.doAutoResolveDispute(target, chunk, events)
      case "withdraw_worker":
        return this.doWithdrawWorker(target, chunk, events)
      case "withdraw_poster":
        return this.doWithdrawPoster(target, chunk, events)
      default:
        throw new LedgerRevert(`unsupported escrow method: ${method}`)
    }
  }

  // ── Escrow component methods ──────────────────────────────────────────────

  private doCreateTask(
    component: string,
    chunk: string,
    worktop: Worktop,
    buckets: Map<string, BucketContent>,
    events: LedgerEvent[],
  ): void {
    this.assertComponent(component)
    const poster = addresses(chunk)[1]
    const names = bucketNames(chunk)
    const reward = this.takeFungibleBucket(buckets, names[0])
    const insurance = this.takeFungibleBucket(buckets, names[1])
    const workBriefHash = bytesArgs(chunk)[0] ?? ""
    if (!(reward.amount > 0)) throw new LedgerRevert("create_task: reward must be positive")
    // Blueprint invariant (lib.rs `create_task`'s insurance assert): insurance ≥ reward × min_insurance_fraction,
    // an EXACT product (no rounding) — the mock must not be stricter than the chain.
    if (insurance.amount < reward.amount * this.cfg.minInsuranceFraction - 1e-9) {
      throw new LedgerRevert("create_task: insurance below min_insurance_fraction")
    }
    this.componentVault += reward.amount + insurance.amount
    const taskId = this.nextTaskId++
    this.tasks.set(taskId, {
      state: "Open",
      poster,
      worker: null,
      reward: reward.amount,
      insurance: insurance.amount,
      bond: 0,
      claimReceiptId: null,
      workBriefHash,
      disputeRaisedBy: null,
      workerEntitled: 0,
      posterEntitled: 0,
      workerBondEntitled: 0,
      posterBondEntitled: 0,
      claimerBadge: null,
    })
    // Return the Task Receipt NFT (local id = task_id) to the worktop.
    worktop.nonFungible.push({ resource: this.cfg.receiptResource, id: `#${taskId}#` })
    events.push({
      name: "TaskCreatedEvent",
      taskId,
      fields: {
        task_id: String(taskId),
        reward_token: reward.resource,
        reward_amount: this.dec(reward.amount),
        insurance_amount: this.dec(insurance.amount),
        // Carried by the real event too (lib.rs TaskCreatedEvent): the create
        // confirm binds the row to its poster and its committed brief.
        poster,
        work_brief_hash: workBriefHash,
      },
    })
  }

  private doClaimTask(
    component: string,
    chunk: string,
    worktop: Worktop,
    buckets: Map<string, BucketContent>,
    events: LedgerEvent[],
  ): void {
    this.assertComponent(component)
    const taskId = u64s(chunk)[0]
    const worker = addresses(chunk)[1]
    const task = this.requireTask(taskId)
    const names = bucketNames(chunk)
    const bond = this.takeFungibleBucket(buckets, names[0])
    // Mirror the blueprint's assert order in lib.rs `claim_task` — its
    // claim_bond-resource assert, then its claim_bond-amount assert, then its
    // `task.state == Open` assert — so the mock
    // surfaces the same revert reason the chain would on the first failing check.
    if (bond.resource !== this.cfg.xrd) throw new LedgerRevert("claim_task: claim_bond must be XRD")
    if (Math.abs(bond.amount - this.cfg.claimBondXrd) > 1e-9) {
      throw new LedgerRevert(`claim_task: claim_bond amount does not match required (${this.cfg.claimBondXrd})`)
    }
    if (task.state !== "Open") throw new LedgerRevert(`claim_task: task ${taskId} must be Open (is ${task.state})`)
    // Self-claim gate (lib.rs `claim_task`'s `worker != task.poster` assert,
    // "self-claim not allowed: worker account must differ from poster"): the
    // worker account must differ from the poster. This kills the NAIVE
    // one-account poster→worker loop and nothing more. Per the correction
    // block right above that assert in lib.rs it is an honest-mistake
    // guard: the Guild badge is a public mint anyone can call for the network
    // fee, and `poster` is a free parameter of create_task, so a decoy poster
    // address disables this check at zero cost (M5, Wave-B).
    if (worker === task.poster) {
      throw new LedgerRevert("claim_task: self-claim not allowed: worker account must differ from poster")
    }
    this.componentVault += bond.amount
    task.state = "Claimed"
    // PIN both payee facts here, where the chain pins them: the destination
    // account and the badge entitled to trigger the withdrawal.
    task.worker = worker
    const badgeProof = this.txProofs.get(proofNames(chunk)[0])
    task.claimerBadge =
      badgeProof && badgeProof.localId
        ? { resource: badgeProof.resource, localId: badgeProof.localId }
        : null
    task.bond = bond.amount
    const claimReceiptId = this.nextClaimReceiptId++
    task.claimReceiptId = claimReceiptId
    worktop.nonFungible.push({ resource: this.cfg.claimReceiptResource, id: `#${claimReceiptId}#` })
    events.push({ name: "TaskClaimedEvent", taskId, fields: { task_id: String(taskId) } })
  }

  private doSubmitTask(
    component: string,
    chunk: string,
    worktop: Worktop,
    buckets: Map<string, BucketContent>,
    events: LedgerEvent[],
  ): void {
    this.assertComponent(component)
    const taskId = u64s(chunk)[0]
    const task = this.requireTask(taskId)
    if (task.state !== "Claimed") throw new LedgerRevert(`submit_task: task ${taskId} must be Claimed to submit (is ${task.state})`)
    const names = bucketNames(chunk)
    const receipt = this.takeBucket(buckets, names[0])
    if (receipt.kind !== "nonFungible" || receipt.items[0]?.resource !== this.cfg.claimReceiptResource) {
      throw new LedgerRevert("submit_task: claim receipt bucket missing/wrong resource")
    }
    if (intLocalId(receipt.items[0].id) !== String(task.claimReceiptId)) {
      throw new LedgerRevert("submit_task: claim_receipt is not the active one")
    }
    // Claim receipt burned; the claim_bond leaves the component vault back onto
    // the WORKTOP — the submit manifest's trailing deposit_batch sweeps it to the
    // worker (bond is net-zero across claim+submit for an honest worker).
    task.state = "Submitted"
    if (task.bond > 0) {
      if (this.componentVault < task.bond - 1e-9) throw new LedgerRevert("submit_task: vault underfunded on bond return")
      this.componentVault -= task.bond
      worktop.fungible.set(this.cfg.xrd, (worktop.fungible.get(this.cfg.xrd) ?? 0) + task.bond)
      task.bond = 0 // bond no longer held by the component (prevents a later double-return)
    }
    // Blueprint emits WorkSubmittedEvent (lib.rs's `WorkSubmittedEvent` struct) — not "TaskSubmittedEvent";
    // the confirm route + resync key off the exact name (escrow-confirm.ts:498).
    const evidenceHash = bytesArgs(chunk)[0] ?? ""
    events.push({ name: "WorkSubmittedEvent", taskId, fields: { task_id: String(taskId), evidence_hash: evidenceHash } })
  }

  private doApproveAndRelease(
    component: string,
    chunk: string,
    events: LedgerEvent[],
  ): void {
    this.assertComponent(component)
    // PULL: the receipt arrives as a PROOF and is NOT burned (lib.rs
    // `approve_and_release`'s doc comment: "NO LONGER BURNED"). The
    // task id is derived from the proof's local id, exactly as the blueprint
    // does — never from an argument the caller could disagree with.
    const proof = this.requireReceiptProof(chunk, "approve_and_release")
    const taskId = proof.taskId
    const task = this.requireTask(taskId)
    if (task.state !== "Submitted") throw new LedgerRevert(`approve_and_release: task ${taskId} must be Submitted (is ${task.state})`)
    if (this.componentVault < task.reward + task.insurance - 1e-9) {
      throw new LedgerRevert("approve_and_release: vault underfunded")
    }
    // ⚠️ THE PULL PROPERTY, and the reason this harness was re-modelled: NOTHING
    // reaches the worktop. The vaults drain into per-party entitlements held
    // inside the component (lib.rs `approve_and_release`'s vault-drain-into-
    // entitlements step), so the caller's manifest has no
    // routing surface and cannot name a recipient. Under push this method put
    // reward+insurance on the caller's worktop and the manifest split it — which
    // is what made BUG-7 and the H1 class possible at all.
    task.workerEntitled += task.reward
    task.posterEntitled += task.insurance
    task.state = "Released"
    events.push({
      name: "TaskReleasedEvent",
      taskId,
      fields: { task_id: String(taskId), ruling: "PayWorker", arbiter_fee: "0" },
    })
    this.emitSettlementCredited(task, taskId, events)
  }

  private doCancelTask(
    component: string,
    chunk: string,
    events: LedgerEvent[],
  ): void {
    this.assertComponent(component)
    // PULL: Proof-presented receipt, credits BOTH reward and insurance to the
    // poster's entitlement (lib.rs `cancel_task`'s two
    // `credit_entitlement(task_id, EntitledParty::Poster, ...)` calls). The "insurance is forfeited on
    // cancel" line that used to sit in the docs was measured false on 08-09.
    const proof = this.requireReceiptProof(chunk, "cancel_task")
    const taskId = proof.taskId
    const task = this.requireTask(taskId)
    if (task.state !== "Open") throw new LedgerRevert(`cancel_task: task ${taskId} must be Open (is ${task.state})`)
    if (this.componentVault < task.reward + task.insurance - 1e-9) {
      throw new LedgerRevert("cancel_task: vault underfunded")
    }
    task.posterEntitled += task.reward + task.insurance
    task.state = "Refunded"
    events.push({ name: "TaskCancelledEvent", taskId, fields: { task_id: String(taskId) } })
    this.emitSettlementCredited(task, taskId, events)
  }

  private doCancelAfterClaim(
    component: string,
    chunk: string,
    events: LedgerEvent[],
  ): void {
    this.assertComponent(component)
    const proof = this.requireReceiptProof(chunk, "cancel_task_by_poster_after_claim")
    const taskId = proof.taskId
    const task = this.requireTask(taskId)
    // Blueprint asserts state == Claimed — a poster CANNOT claw back a Submitted
    // task (they must approve or dispute delivered work). Admitting Submitted
    // here would bless a post-delivery poster rug AND — since the bond has
    // already returned to the worker on submit — double-credit the bond.
    if (task.state !== "Claimed") {
      throw new LedgerRevert(`cancel_task_by_poster_after_claim: task ${taskId} must be Claimed (is ${task.state})`)
    }
    const total = task.reward + task.insurance + task.bond
    if (this.componentVault < total - 1e-9) throw new LedgerRevert("cancel_task_by_poster_after_claim: vault underfunded")
    // TWO parties, TWO lanes (lib.rs `cancel_task_by_poster_after_claim`'s
    // `credit_bond_entitlement(task_id, EntitledParty::Worker, bond)` call). The bond is credited to the
    // WORKER's BOND lane, not handed to the cancelling poster to forward — which
    // is the whole point: the poster's manifest never touches the worker's money.
    task.posterEntitled += task.reward + task.insurance
    task.workerBondEntitled += task.bond
    const bondCredited = task.bond
    task.state = "Refunded"
    events.push({
      name: "TaskCancelledAfterClaimEvent",
      taskId,
      fields: { task_id: String(taskId), bond_returned_to: task.worker ?? "", bond_amount: this.dec(bondCredited) },
    })
    this.emitSettlementCredited(task, taskId, events)
  }

  // ── Disputes ──────────────────────────────────────────────────────────────
  //
  // Modelled to reproduce the two confirmed LIVE money bugs (see the dispute
  // e2e). NOTE the harness omits the blueprint's 72h auto-resolve window assert
  // (lib.rs `auto_resolve_dispute`'s "dispute auto-resolve window has not
  // elapsed" assert) — it models no clock; the app builds the finalize manifest
  // with no time arg, so the window is orthogonal to the routing bugs under test.

  private doRaiseDispute(component: string, chunk: string, events: LedgerEvent[]): void {
    this.assertComponent(component)
    const taskId = u64s(chunk)[0]
    const task = this.requireTask(taskId)
    if (task.state !== "Submitted") throw new LedgerRevert(`raise_dispute: task ${taskId} must be Submitted (is ${task.state})`)
    // The raiser is read from the presented proof's resource (lib.rs
    // `raise_dispute`'s check against `self.task_receipt_manager.address()`): the
    // Task Receipt ⇒ Poster; any other badge (the claimer's) ⇒ Worker.
    const proof = this.txProofs.get(proofNames(chunk)[0])
    if (!proof) throw new LedgerRevert("raise_dispute: no party_proof presented")
    const raisedBy: DisputeParty = proof.resource === this.cfg.receiptResource ? "Poster" : "Worker"
    task.state = "Disputed"
    task.disputeRaisedBy = raisedBy
    events.push({ name: "DisputeRaisedEvent", taskId, fields: { task_id: String(taskId), raised_by: raisedBy } })
  }

  /**
   * auto_resolve_dispute (lib.rs's own doc comment: "Public, time-gated. No
   * auth"). Computes the ruling from the component's dispute_auto_resolve_default
   * + who raised, then RETURNS
   * `(worker_bucket, poster_bucket)` — unhandled method returns land on the
   * caller's worktop, where XRD COMMINGLES into one pile. That commingling is the
   * H1 trap: the finalize manifest takes fixed amounts off the pile regardless of
   * the intended split, so a winner-take-all manifest sweeps the whole pot even
   * when the default was SplitEvenly. The emitted event still reports the INTENDED
   * split — a DB-vs-chain divergence a confirm-route test would surface.
   */
  private doAutoResolveDispute(component: string, chunk: string, events: LedgerEvent[]): void {
    this.assertComponent(component)
    const taskId = u64s(chunk)[0]
    const task = this.requireTask(taskId)
    if (task.state !== "Disputed") throw new LedgerRevert(`auto_resolve_dispute: task ${taskId} must be Disputed (is ${task.state})`)
    const raisedBy = task.disputeRaisedBy
    if (!raisedBy) throw new LedgerRevert("auto_resolve_dispute: Disputed task has no dispute_raised_by")

    // Resolve the ruling exactly as lib.rs `auto_resolve_dispute`'s `AutoResolveDefault` match block does.
    let workerPct: number
    let refunded: boolean // RefundPoster → Refunded; else Released
    switch (this.cfg.disputeAutoResolveDefault) {
      case "FavorDisputeRaiser":
        workerPct = raisedBy === "Worker" ? 1 : 0
        refunded = raisedBy === "Poster"
        break
      case "ReturnToPoster":
        workerPct = 0
        refunded = true
        break
      case "SplitEvenly":
      default:
        workerPct = 0.5
        refunded = false
        break
    }
    // ⚠️ TWO RULINGS, not one — and this is a real fidelity fix, not a port.
    // The push model here split the WHOLE pot (reward + insurance) by the
    // ruling. The blueprint does not: `auto_resolve_dispute` passes the computed
    // ruling for the REWARD leg and a hard `RefundPoster` for the INSURANCE leg
    // (lib.rs `auto_resolve_dispute`'s hard-coded `&DisputeRuling::RefundPoster`
    // insurance leg passed to `credit_split_for_parties`). Nobody judged, so the poster's premium is returned, never
    // won. That is precisely what stops disputing from out-earning honest
    // completion — with a single ruling, a `PayWorker` outcome paid the worker
    // reward AND insurance, i.e. MORE than being approved.
    const workerAmount = task.reward * workerPct
    const posterAmount = task.reward - workerAmount + task.insurance
    const pot = task.reward + task.insurance

    // PULL: credited, not paid. Nothing reaches the caller's worktop, so the
    // finalize manifest has no amounts to get wrong — the structural end of the
    // H1 class, which existed only because the two buckets commingled on the
    // worktop and the manifest took fixed amounts off the pile.
    if (this.componentVault < pot - 1e-9) throw new LedgerRevert("auto_resolve_dispute: vault underfunded")
    task.workerEntitled += workerAmount
    task.posterEntitled += posterAmount
    task.state = refunded ? "Refunded" : "Released"

    events.push({
      name: refunded ? "TaskRefundedEvent" : "TaskReleasedEvent",
      taskId,
      fields: refunded ? { task_id: String(taskId), arbiter_fee: "0" } : { task_id: String(taskId), ruling: "AutoResolved", arbiter_fee: "0" },
    })
    this.emitSettlementCredited(task, taskId, events)
    events.push({
      name: "DisputeAutoResolvedEvent",
      taskId,
      fields: { task_id: String(taskId), worker_amount: this.dec(workerAmount), poster_amount: this.dec(posterAmount) },
    })
  }

  // ── PULL withdrawals ──────────────────────────────────────────────────────
  //
  // The ONLY way value leaves the component on the settlement path. Both are
  // PUBLIC on the blueprint — the auth IS the Proof, checked inside — and
  // neither takes a destination: the component deposits into an account it
  // pinned earlier. That is why the withdraw manifests carry no deposit leg,
  // and why this harness deposits directly to the pinned account rather than
  // to the worktop. A manifest cannot redirect what it never receives.

  private doWithdrawWorker(component: string, chunk: string, events: LedgerEvent[]): void {
    this.assertComponent(component)
    const taskId = u64s(chunk)[0]
    const task = this.requireTask(taskId)
    const proof = this.txProofs.get(proofNames(chunk)[0])
    if (!proof) throw new LedgerRevert("withdraw_worker: no badge proof presented")
    if (!task.claimerBadge) throw new LedgerRevert(`withdraw_worker: task ${taskId} has no pinned claimer badge`)
    if (proof.resource !== task.claimerBadge.resource) {
      throw new LedgerRevert("withdraw_worker: badge must be the claimer's worker or agent badge")
    }
    // The local-id assert is the one that matters (lib.rs `withdraw_worker`'s
    // `assert_eq!(Some(badge_id), task.claimer_badge_id, ...)`). Resource alone
    // is not auth here: the member badge is a public mint, so anyone could hold
    // one of the right resource.
    if (proof.localId !== task.claimerBadge.localId) {
      throw new LedgerRevert("withdraw_worker: you are not the worker who claimed this task")
    }
    const destination = task.worker
    if (!destination) throw new LedgerRevert("withdraw_worker: no pinned worker account for this task")
    this.payLanes(taskId, task, "Worker", destination, events)
  }

  private doWithdrawPoster(component: string, chunk: string, events: LedgerEvent[]): void {
    this.assertComponent(component)
    const taskId = u64s(chunk)[0]
    const proof = this.requireReceiptProof(chunk, "withdraw_poster")
    if (proof.taskId !== taskId) {
      throw new LedgerRevert("withdraw_poster: task_receipt is for a different task")
    }
    const task = this.requireTask(taskId)
    this.payLanes(taskId, task, "Poster", task.poster, events)
  }

  /**
   * `deposit_both_lanes` — collect reward + bond for one party into the PINNED
   * account. Asserts BEFORE moving anything that something is owed, so a
   * "nothing to withdraw" call reverts without a partial deposit; and zeroes the
   * lane before paying it, which is what makes a double-withdraw impossible.
   */
  private payLanes(
    taskId: number,
    task: TaskRecord,
    party: "Worker" | "Poster",
    destination: string,
    events: LedgerEvent[],
  ): void {
    const reward = party === "Worker" ? task.workerEntitled : task.posterEntitled
    const bond = party === "Worker" ? task.workerBondEntitled : task.posterBondEntitled
    if (reward <= 1e-9 && bond <= 1e-9) {
      throw new LedgerRevert("nothing to withdraw for this party on this task")
    }
    const total = reward + bond
    if (this.componentVault < total - 1e-9) {
      throw new LedgerRevert(`withdraw_${party.toLowerCase()}: vault underfunded`)
    }
    // Zero first, then pay — the ordering the blueprint calls out.
    if (party === "Worker") {
      task.workerEntitled = 0
      task.workerBondEntitled = 0
    } else {
      task.posterEntitled = 0
      task.posterBondEntitled = 0
    }
    this.componentVault -= total
    const acct = this.account(destination)
    acct.fungible.set(this.cfg.xrd, (acct.fungible.get(this.cfg.xrd) ?? 0) + total)
    // One event PER NON-ZERO LANE, never a guaranteed pair — the off-chain
    // reader keys on (tx, task, party, lane), so emitting a merged row here
    // would hide exactly the second-leg drop that shape exists to prevent.
    for (const [lane, amount] of [["Reward", reward], ["Bond", bond]] as const) {
      if (amount <= 1e-9) continue
      events.push({
        name: "WithdrawalEvent",
        taskId,
        fields: {
          task_id: String(taskId),
          party,
          lane,
          resource: this.cfg.xrd,
          amount: this.dec(amount),
          destination,
        },
      })
    }
  }

  /**
   * Resolve the task-receipt Proof a pull method was called with, and derive the
   * task id from its LOCAL ID — the blueprint takes no task_id argument on
   * approve/cancel precisely so the caller cannot present a receipt for one task
   * against another.
   */
  private requireReceiptProof(chunk: string, method: string): { taskId: number } {
    const proof = this.txProofs.get(proofNames(chunk)[0])
    if (!proof) throw new LedgerRevert(`${method}: no task receipt proof presented`)
    if (proof.resource !== this.cfg.receiptResource) {
      throw new LedgerRevert(`${method}: wrong receipt resource`)
    }
    if (!proof.localId) throw new LedgerRevert(`${method}: receipt proof carries no local id`)
    return { taskId: Number(intLocalId(proof.localId)) }
  }

  /** SettlementCreditedEvent — always all four lanes, zeros included. */
  private emitSettlementCredited(task: TaskRecord, taskId: number, events: LedgerEvent[]): void {
    events.push({
      name: "SettlementCreditedEvent",
      taskId,
      fields: {
        task_id: String(taskId),
        worker_entitled: this.dec(task.workerEntitled),
        poster_entitled: this.dec(task.posterEntitled),
        worker_bond_entitled: this.dec(task.workerBondEntitled),
        poster_bond_entitled: this.dec(task.posterBondEntitled),
      },
    })
  }

  // ── Primitive movements ───────────────────────────────────────────────────

  private account(address: string): Account {
    let a = this.accounts.get(address)
    if (!a) {
      a = { fungible: new Map(), nonFungible: [] }
      this.accounts.set(address, a)
    }
    return a
  }

  private accountWithdrawFungible(address: string, resource: string, amount: number): void {
    const acct = this.account(address)
    const bal = acct.fungible.get(resource) ?? 0
    if (bal < amount - 1e-9) {
      throw new LedgerRevert(`insufficient ${resource.slice(-6)}: ${address} has ${bal}, needs ${amount}`)
    }
    acct.fungible.set(resource, bal - amount)
  }

  private accountWithdrawNft(address: string, resource: string, id: string): void {
    const acct = this.account(address)
    const idx = acct.nonFungible.findIndex((n) => n.resource === resource && n.id === id)
    if (idx < 0) {
      // Matches humanizeTxError's "MissingNonFungible" signature.
      throw new LedgerRevert(`MissingNonFungible: ${address} does not hold ${resource.slice(-6)}:${id}`)
    }
    acct.nonFungible.splice(idx, 1)
  }

  private worktopTakeFungible(worktop: Worktop, resource: string, amount: number): void {
    const have = worktop.fungible.get(resource) ?? 0
    if (have < amount - 1e-9) throw new LedgerRevert(`TAKE_FROM_WORKTOP: only ${have} of ${resource.slice(-6)}, need ${amount}`)
    const rest = have - amount
    if (rest <= 1e-9) worktop.fungible.delete(resource)
    else worktop.fungible.set(resource, rest)
  }

  private depositBucket(address: string, content: BucketContent): void {
    const acct = this.account(address)
    if (content.kind === "fungible") {
      acct.fungible.set(content.resource, (acct.fungible.get(content.resource) ?? 0) + content.amount)
    } else {
      acct.nonFungible.push(...content.items)
    }
  }

  private depositWorktop(address: string, worktop: Worktop): void {
    const acct = this.account(address)
    for (const [res, amt] of worktop.fungible) {
      acct.fungible.set(res, (acct.fungible.get(res) ?? 0) + amt)
    }
    acct.nonFungible.push(...worktop.nonFungible)
    worktop.fungible.clear()
    worktop.nonFungible = []
  }

  private takeBucket(buckets: Map<string, BucketContent>, name: string): BucketContent {
    const b = buckets.get(name)
    if (!b) throw new LedgerRevert(`bucket "${name}" not found`)
    buckets.delete(name)
    return b
  }

  private takeFungibleBucket(buckets: Map<string, BucketContent>, name: string): { resource: string; amount: number } {
    const b = this.takeBucket(buckets, name)
    if (b.kind !== "fungible") throw new LedgerRevert(`bucket "${name}" is not fungible`)
    return { resource: b.resource, amount: b.amount }
  }

  private takeNonFungibleBucket(buckets: Map<string, BucketContent>, name: string): { items: NftRef[] } {
    const b = this.takeBucket(buckets, name)
    if (b.kind !== "nonFungible") throw new LedgerRevert(`bucket "${name}" is not non-fungible`)
    return { items: b.items }
  }

  private assertComponent(address: string): void {
    if (address !== this.cfg.escrowComponent) {
      throw new LedgerRevert(`unknown component ${address} (expected ${this.cfg.escrowComponent})`)
    }
  }

  private requireTask(taskId: number): TaskRecord {
    const t = this.tasks.get(taskId)
    if (!t) throw new LedgerRevert(`no such task ${taskId} on this component`)
    return t
  }

  private dec(n: number): string {
    return String(n)
  }

  // ── Atomic rollback ───────────────────────────────────────────────────────

  private snapshot() {
    return {
      accounts: new Map(
        [...this.accounts].map(([k, v]) => [
          k,
          { fungible: new Map(v.fungible), nonFungible: v.nonFungible.map((n) => ({ ...n })) },
        ]),
      ),
      tasks: new Map([...this.tasks].map(([k, v]) => [k, { ...v }])),
      componentVault: this.componentVault,
      nextTaskId: this.nextTaskId,
      nextClaimReceiptId: this.nextClaimReceiptId,
    }
  }

  private restore(s: ReturnType<MockLedger["snapshot"]>): void {
    this.accounts = s.accounts
    this.tasks = s.tasks
    this.componentVault = s.componentVault
    this.nextTaskId = s.nextTaskId
    this.nextClaimReceiptId = s.nextClaimReceiptId
  }
}
