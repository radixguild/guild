// escrow_task.qnt — the guild-marketplace-escrow task + dispute lifecycle.
//
// GROUNDED IN THE CODE, NOT THE DOCS.
// Every transition names the method and line it models, read from
// escrow/scrypto/guild-marketplace-escrow/src/lib.rs. Where PROJECT-STATE.md and
// lib.rs disagreed, lib.rs won — and it disagreed in one load-bearing place: the
// 2026-07-31 "auto_resolve returns both buckets to the caller / 100% drain" entry
// describes the PRE-PULL blueprint and is superseded (PROJECT-STATE.md:5346).
// The current source is PULL: settlement CREDITS entitlements, and value leaves
// only via withdraw_* into an account pinned at create/claim time.
//
// RE-GROUNDED 2026-08-30 against Wave B stages 1–5b (the bond overhaul):
//  - the bond is denominated in the task's REWARD token (W4-mech), sized
//    clamp(pct * reward, floor, cap) — modelled as the constant BOND;
//  - submit_task MOVES NO MONEY (5b): the bond is held to settlement;
//  - approve_and_release credits the bond to the pinned worker;
//  - both dispute paths split the bond proportionally to the REWARD ruling
//    (W5), inside the shared helper, so the two paths cannot diverge;
//  - expire_claim's bounty is a SHARE of the bond (expire_bounty_pct), the
//    remainder to a per-resource house KVS;
//  - AutoResolveDefault gained FavorNonRaiser (stage 3, appended);
//  - dispute terms are PINNED at raise (stage: "the setters WERE retroactive")
//    — which is why modelling them as constants is faithful, not a shortcut;
//  - stage 6 (W2 + P4-3): submit_task pins a review_deadline, and PUBLIC
//    time-gated release_after_review_timeout settles exactly like approve
//    once it lapses — modelled as releaseAfterTimeout with settledBy Clock.
//
// ASSUMPTIONS AND ABSTRACTIONS (read before believing anything below):
//  - ONE task. No concurrency between tasks; the component's per-task KVS makes
//    tasks independent, so single-task safety is the useful unit — but a shared
//    house vault does couple them, and that coupling is NOT modelled.
//  - Amounts are small integers, not Decimal. Truncation/rounding is out of scope.
//  - The arbiter badge carries an assigned_account (L3(b)) and resolve_dispute
//    refuses one assigned to the task's WORKER (the L6(c) guard, shipped
//    2026-08-30). The POSTER side is open by design — poster is a payout
//    destination, not an identity — and stays modelled as a visible exposure
//    (the escrow_arbiter_is_poster twin), never assumed away.
//  - Crypto/proof checks are idealised: holding the credential == passing the check.
//
// The one type the instance modules must name to bind AUTO_DEFAULT, hoisted out
// of escrow_task so they can. `AutoResolveDefault` in lib.rs: owner-settable
// since Wave B (stage 1/3), but PINNED onto the task at raise_dispute — a setter
// cannot move a dispute already in flight, which is what licenses modelling it
// as a constant per instance. FavorNonRaiser appended at stage 3 (SBOR order is
// load-bearing in the source; here only the arm's meaning matters: the raiser
// LOSES).
module escrow_types {
  type AutoDefault = FavorDisputeRaiser | SplitEvenly | ReturnToPoster | FavorNonRaiser
}

module escrow_task {
  import escrow_types.*

  // Is the arbiter badge ASSIGNED to a party of the task? Split into the two
  // sides at L6(c), because the code now treats them differently:
  //  - WORKER side: resolve_dispute asserts the badge's assigned_account
  //    differs from task.worker_account — modelled as the not(arbiterIsWorker)
  //    guard on resolveDispute. The SELF-DEALING-GUARD-DELETED mutation
  //    patches the MAIN module (guard stripped + badge re-assigned to the
  //    worker) and must violate invNoWorkerArbiterRuling — deliberately NOT a
  //    twin mutation, because the harness runs twin mutations unpatched. The
  //    guard's positive direction lives at the ledger level
  //    (test_resolve_rejects_an_arbiter_badge_assigned_to_the_worker), against
  //    the real code.
  //  - POSTER side: OPEN BY DESIGN (poster is a caller-supplied payout
  //    destination, not an identity — a decoy defeats any check). The
  //    escrow_arbiter_is_poster twin's counterexample IS the recorded
  //    exposure; if it stops appearing, the model stopped representing it.
  const ARBITER_IS_WORKER: bool
  const ARBITER_IS_POSTER: bool

  // The owner-selected auto-resolve default, a CONST since 2026-09-01 — see
  // the instance modules at the bottom for why the other three arms are not
  // decoration.
  const AUTO_DEFAULT: AutoDefault

  // ── Actors ────────────────────────────────────────────────────────────────
  // `Anyone` is a first-class adversary the step relation may always pick. A
  // transition that does not name its caller is reachable by Anyone BY OMISSION,
  // which is the shape of every ambiguous-authority bug.
  type Actor = Poster | Worker | Arbiter | Anyone | Nobody | Clock

  // lib.rs:18-26
  type State = Open | Claimed | Submitted | Disputed | Released | Refunded

  type Party = PosterP | WorkerP

  // AutoDefault lives in escrow_types (above) rather than here, because the
  // instance modules at the bottom must NAME its arms to bind AUTO_DEFAULT.
  // A constructor defined inside escrow_task cannot be used as an argument to
  // an instantiation OF escrow_task — quint calls that a cyclic declaration.

  // ── Money. Two entitlement lanes per party-side, never summed in asserts. ──
  // Since stage 5a the bond is the SAME resource as the reward (W4-mech), so
  // resource identity can no longer separate the lanes anywhere — the split
  // views (what a party is owed vs what they staked) are the only distinction
  // left, and the model keeps them split for exactly that reason.
  var state: State

  var rewardVault: int        // reward escrowed at create_task
  var insuranceVault: int     // insurance escrowed at create_task
  var bondVault: int          // claim bond escrowed at claim_task, HELD to settlement (5b)
  var houseVault: int         // forfeited_claim_bonds_vaults[reward_token]

  var workerEntitled: int     // credit_entitlement → withdraw_worker
  var posterEntitled: int
  var workerBondEntitled: int // credit_bond_entitlement(Worker)
  var posterBondEntitled: int // credit_bond_entitlement(Poster) — NEW at 5b:
                              // rulings can forfeit bond (whole or split) to the poster

  var workerPaid: int         // left the component to the PINNED worker_account
  var posterPaid: int
  var arbiterPaid: int        // arbiter fee, returned to the arbiter caller
  var bountyPaid: int         // expire_claim caller bounty (a SHARE of the bond since 5a)

  var disputeRaisedBy: Party
  var elapsedSinceDispute: int
  var elapsedSinceClaim: int
  var elapsedSinceSubmit: int // W2 (stage 6): drives the review deadline the
                              // way elapsedSinceDispute drives auto-resolve

  // ── Ghosts. Not state the blueprint has — state the PROPERTIES need. ───────
  // An authority guard is only checkable if something records who passed it.
  var settledBy: Actor        // who drove the task to a terminal state
  var arbiterIsWorker: bool   // is the arbiter badge assigned to the worker's account?
  var arbiterIsPoster: bool   // …to the poster's account? (unguarded, by L6(c))
  var totalIn: int            // everything ever escrowed (conservation reference)
  var forfeited: int          // every unit ever forfeited by expire_claim (DB-4
                              // reference: forfeiture pays caller + house ONLY,
                              // and this ghost is what makes that checkable now
                              // that rulings legitimately credit poster bond)

  // EXTENSION (this pass, DESIGN-REVIEW-2027.md §19.7 gap 2 row 1): who called
  // submit_task (Nobody until it happens). Needed as its own ghost, separate from
  // settledBy, because Submitted is NOT a terminal state — invOnlyAuthorisedSettled
  // only fires on isTerminal(state) and so cannot see this transition at all.
  var submittedBy: Actor

  pure val REWARD: int = 100
  pure val INSURANCE: int = 10
  pure val BOND: int = 10                // clamp(pct*reward, floor, cap) — a constant
                                         // here because it is fixed per task at claim
  pure val ARBITER_FEE: int = 2          // insurance * arbiter_fee_pct
  pure val EXPIRE_BOUNTY: int = 1        // expire_bounty_pct * BOND (0.1 * 10) — the
                                         // flat min(1 XRD, bond) died at stage 5a
  pure val AUTO_RESOLVE_DEADLINE: int = 3
  pure val CLAIM_DEADLINE: int = 3
  pure val REVIEW_WINDOW: int = 3        // review_window_secs (stage 6, W2) —
                                         // pinned per task at submit in lib.rs;
                                         // constant here for the same reason as
                                         // the dispute terms (non-retroactive)

  // AUTO_DEFAULT was a `pure val` pinned to SplitEvenly here until 2026-09-01,
  // which meant Apalache had only ever checked the DEPLOYED default. The other
  // three arms are not hypothetical — `dispute_auto_resolve_default` is pinned
  // per task on TaskInfo and settable by the owner, and lib.rs says
  // FavorNonRaiser becomes coherent to select once stage 6 ships (it has). So
  // the branch that made FavorNonRaiser selectable never verified it. It is a
  // const now, and every arm gets its own instance below.

  // ── Authority, stated rather than implied ─────────────────────────────────
  pure def mayApprove(a: Actor): bool = a == Poster       // Proof of task_receipt
  pure def mayCancel(a: Actor): bool  = a == Poster       // Proof of task_receipt
  pure def mayRaise(a: Actor): bool   = a == Poster or a == Worker
  pure def mayResolve(a: Actor): bool = a == Arbiter      // Proof of arbiter_badge
  // maySubmit — the same credential idealisation as mayApprove/mayCancel:
  // "holds the active claim_receipt" is collapsed to the Worker actor. The
  // receipt is a permanently transferable BEARER instrument, so this
  // idealisation hides real theft-of-credential scenarios — but since 5b that
  // hiding has no MONEY consequence at this transition, because submit_task
  // moves no money at all (see submitTask). What a stolen receipt still buys
  // is a state change with an attacker's evidence hash: griefing, not theft.
  // NOTE this guard is still not a literal lib.rs check (submit_task never
  // reads task.worker_account); 5b closed the bond-theft class by removing
  // the payout, not by authenticating the caller.
  pure def maySubmit(a: Actor): bool = a == Worker
  // auto_resolve_dispute and expire_claim take NO auth at all — deliberately.
  // Under PULL that is safe because neither returns anyone else's money.

  pure def isTerminal(s: State): bool = s == Released or s == Refunded

  action init = all {
    state' = Open,
    rewardVault' = REWARD, insuranceVault' = INSURANCE, bondVault' = 0, houseVault' = 0,
    workerEntitled' = 0, posterEntitled' = 0,
    workerBondEntitled' = 0, posterBondEntitled' = 0,
    workerPaid' = 0, posterPaid' = 0, arbiterPaid' = 0, bountyPaid' = 0,
    disputeRaisedBy' = PosterP,
    elapsedSinceDispute' = 0, elapsedSinceClaim' = 0, elapsedSinceSubmit' = 0,
    settledBy' = Nobody,
    arbiterIsWorker' = ARBITER_IS_WORKER, arbiterIsPoster' = ARBITER_IS_POSTER,
    totalIn' = REWARD + INSURANCE,
    forfeited' = 0,
    submittedBy' = Nobody,
  }

  // ── Frames. Quint has no "unchanged except"; spell them out. ──────────────
  action moneyUnchanged = all {
    rewardVault' = rewardVault, insuranceVault' = insuranceVault,
    bondVault' = bondVault, houseVault' = houseVault,
    workerEntitled' = workerEntitled, posterEntitled' = posterEntitled,
    workerBondEntitled' = workerBondEntitled, posterBondEntitled' = posterBondEntitled,
    workerPaid' = workerPaid, posterPaid' = posterPaid,
    arbiterPaid' = arbiterPaid, bountyPaid' = bountyPaid,
  }
  action ghostsUnchanged = all {
    settledBy' = settledBy, arbiterIsWorker' = arbiterIsWorker, arbiterIsPoster' = arbiterIsPoster, totalIn' = totalIn,
    forfeited' = forfeited,
    submittedBy' = submittedBy,
  }
  action clocksUnchanged = all {
    elapsedSinceDispute' = elapsedSinceDispute, elapsedSinceClaim' = elapsedSinceClaim,
    elapsedSinceSubmit' = elapsedSinceSubmit,
  }

  // ── Transitions ───────────────────────────────────────────────────────────

  // cancel_task — Open only. CREDITS poster reward+insurance.
  action cancelTask(caller: Actor): bool = all {
    state == Open,
    mayCancel(caller),
    state' = Refunded,
    posterEntitled' = posterEntitled + rewardVault + insuranceVault,
    rewardVault' = 0, insuranceVault' = 0,
    settledBy' = caller,
    bondVault' = bondVault, houseVault' = houseVault,
    workerEntitled' = workerEntitled,
    workerBondEntitled' = workerBondEntitled, posterBondEntitled' = posterBondEntitled,
    workerPaid' = workerPaid, posterPaid' = posterPaid,
    arbiterPaid' = arbiterPaid, bountyPaid' = bountyPaid,
    arbiterIsWorker' = arbiterIsWorker, arbiterIsPoster' = arbiterIsPoster, totalIn' = totalIn, forfeited' = forfeited,
    submittedBy' = submittedBy,
    clocksUnchanged,
    disputeRaisedBy' = disputeRaisedBy,
  }

  // claim_task — takes the bond into escrow, in the task's REWARD token,
  // sized clamp(pct * reward, floor, cap) and pinned onto the task.
  action claimTask: bool = all {
    state == Open,
    state' = Claimed,
    bondVault' = bondVault + BOND,
    totalIn' = totalIn + BOND,
    elapsedSinceClaim' = 0,
    rewardVault' = rewardVault, insuranceVault' = insuranceVault, houseVault' = houseVault,
    workerEntitled' = workerEntitled, posterEntitled' = posterEntitled,
    workerBondEntitled' = workerBondEntitled, posterBondEntitled' = posterBondEntitled,
    workerPaid' = workerPaid, posterPaid' = posterPaid,
    arbiterPaid' = arbiterPaid, bountyPaid' = bountyPaid,
    settledBy' = settledBy, arbiterIsWorker' = arbiterIsWorker, arbiterIsPoster' = arbiterIsPoster, forfeited' = forfeited,
    submittedBy' = submittedBy,
    elapsedSinceDispute' = elapsedSinceDispute,
    elapsedSinceSubmit' = elapsedSinceSubmit,
    disputeRaisedBy' = disputeRaisedBy,
  }

  // expire_claim — PUBLIC, ZERO AUTH, time-gated. Ruling DB-4 + stage 5a:
  // a PROPORTIONAL bounty (expire_bounty_pct * bond) to WHOEVER CALLS, the
  // remainder to the house. NEVER to the poster — a poster-credited forfeit
  // would pay for authoring unsatisfiable briefs at volume.
  // invForfeitureIsCallerAndHouseOnly pins that, via the `forfeited` ghost.
  action expireClaim: bool = all {
    state == Claimed,
    elapsedSinceClaim >= CLAIM_DEADLINE,
    state' = Open,
    bountyPaid' = bountyPaid + EXPIRE_BOUNTY,
    houseVault' = houseVault + (bondVault - EXPIRE_BOUNTY),
    forfeited' = forfeited + bondVault,
    bondVault' = 0,
    elapsedSinceClaim' = 0,
    rewardVault' = rewardVault, insuranceVault' = insuranceVault,
    workerEntitled' = workerEntitled, posterEntitled' = posterEntitled,
    workerBondEntitled' = workerBondEntitled, posterBondEntitled' = posterBondEntitled,
    workerPaid' = workerPaid, posterPaid' = posterPaid, arbiterPaid' = arbiterPaid,
    settledBy' = settledBy, arbiterIsWorker' = arbiterIsWorker, arbiterIsPoster' = arbiterIsPoster, totalIn' = totalIn,
    submittedBy' = submittedBy,
    elapsedSinceDispute' = elapsedSinceDispute,
    elapsedSinceSubmit' = elapsedSinceSubmit,
    disputeRaisedBy' = disputeRaisedBy,
  }

  // cancel_task_by_poster_after_claim — worker did nothing wrong,
  // so their bond is CREDITED (not returned): they must withdraw_worker for it.
  action cancelAfterClaim(caller: Actor): bool = all {
    state == Claimed,
    mayCancel(caller),
    state' = Refunded,
    posterEntitled' = posterEntitled + rewardVault + insuranceVault,
    workerBondEntitled' = workerBondEntitled + bondVault,
    rewardVault' = 0, insuranceVault' = 0, bondVault' = 0,
    settledBy' = caller,
    houseVault' = houseVault, workerEntitled' = workerEntitled,
    posterBondEntitled' = posterBondEntitled,
    workerPaid' = workerPaid, posterPaid' = posterPaid,
    arbiterPaid' = arbiterPaid, bountyPaid' = bountyPaid,
    arbiterIsWorker' = arbiterIsWorker, arbiterIsPoster' = arbiterIsPoster, totalIn' = totalIn, forfeited' = forfeited,
    submittedBy' = submittedBy,
    clocksUnchanged, disputeRaisedBy' = disputeRaisedBy,
  }

  // submit_task — RE-GROUNDED AT 5b: MOVES NO MONEY. It used to end
  // `-> Bucket` and hand the bond to whoever called (the bearer-credential
  // hole); the shipped fix REMOVED the payout rather than authenticating the
  // caller, so the bond simply stays in its vault until a settlement path
  // credits it to a pinned account. The old GAPS note about this action's
  // "payout mechanic" being a pre-implementation sketch is thereby resolved.
  //
  // The `maySubmit(caller)` guard is the credential idealisation (see its
  // def): it lets invSubmitOnlyByWorker catch a MODEL regression that makes
  // submit Anyone-reachable, but it is not a lib.rs check. The class it once
  // stood in for — bond theft via a stolen receipt — is gated at SOURCE
  // (test_submit_task_returns_nothing), because a parallel session MEASURED
  // that invConservation cannot see it: the sums balance whoever gets paid.
  // Conservation proves no value appears or vanishes, never who received it.
  action submitTask(caller: Actor): bool = all {
    state == Claimed,
    maySubmit(caller),
    state' = Submitted,
    submittedBy' = caller,
    settledBy' = settledBy, arbiterIsWorker' = arbiterIsWorker, arbiterIsPoster' = arbiterIsPoster, totalIn' = totalIn,
    forfeited' = forfeited,
    moneyUnchanged,
    // W2: the review clock starts at submit (lib.rs pins review_deadline here).
    elapsedSinceSubmit' = 0,
    elapsedSinceDispute' = elapsedSinceDispute, elapsedSinceClaim' = elapsedSinceClaim,
    disputeRaisedBy' = disputeRaisedBy,
  }

  // approve_and_release — THE HONEST BASELINE: worker gets the whole reward
  // AND their bond back (5b — the bond is held to settlement, and the happy
  // path is where an honest worker recovers it), poster gets the insurance.
  // Every dispute outcome is measured against this by invNoUnilateralDominance.
  action approveAndRelease(caller: Actor): bool = all {
    state == Submitted,
    mayApprove(caller),
    state' = Released,
    workerEntitled' = workerEntitled + rewardVault,
    posterEntitled' = posterEntitled + insuranceVault,
    workerBondEntitled' = workerBondEntitled + bondVault,
    rewardVault' = 0, insuranceVault' = 0, bondVault' = 0,
    settledBy' = caller,
    houseVault' = houseVault,
    posterBondEntitled' = posterBondEntitled,
    workerPaid' = workerPaid, posterPaid' = posterPaid,
    arbiterPaid' = arbiterPaid, bountyPaid' = bountyPaid,
    arbiterIsWorker' = arbiterIsWorker, arbiterIsPoster' = arbiterIsPoster, totalIn' = totalIn, forfeited' = forfeited,
    submittedBy' = submittedBy,
    clocksUnchanged, disputeRaisedBy' = disputeRaisedBy,
  }

  // release_after_review_timeout — W2 (stage 6). PUBLIC, zero auth,
  // time-gated: the mirror of auto_resolve_dispute on the SUBMITTED state.
  // Settles EXACTLY like approveAndRelease and attributes to the Clock —
  // silence is approval, never a judgement, so a timeout must never pay the
  // worker more than approval does (that would resurrect the dominance bug on
  // a path the worker reaches alone: submit, then wait). The dispute keeps
  // priority past the deadline by first-to-commit: raiseDispute needs
  // Submitted and this leaves Released, so whichever fires first wins.
  action releaseAfterTimeout: bool = all {
    state == Submitted,
    elapsedSinceSubmit >= REVIEW_WINDOW,
    state' = Released,
    workerEntitled' = workerEntitled + rewardVault,
    posterEntitled' = posterEntitled + insuranceVault,
    workerBondEntitled' = workerBondEntitled + bondVault,
    rewardVault' = 0, insuranceVault' = 0, bondVault' = 0,
    settledBy' = Clock,
    houseVault' = houseVault,
    posterBondEntitled' = posterBondEntitled,
    workerPaid' = workerPaid, posterPaid' = posterPaid,
    arbiterPaid' = arbiterPaid, bountyPaid' = bountyPaid,
    arbiterIsWorker' = arbiterIsWorker, arbiterIsPoster' = arbiterIsPoster, totalIn' = totalIn, forfeited' = forfeited,
    submittedBy' = submittedBy,
    clocksUnchanged, disputeRaisedBy' = disputeRaisedBy,
  }

  // raise_dispute — lib.rs:1424.
  action raiseDispute(caller: Actor, who: Party): bool = all {
    state == Submitted,
    mayRaise(caller),
    // the raiser must be the party they claim to be — the Proof binds it
    (who == PosterP) iff (caller == Poster),
    state' = Disputed,
    disputeRaisedBy' = who,
    elapsedSinceDispute' = 0,
    elapsedSinceClaim' = elapsedSinceClaim,
    elapsedSinceSubmit' = elapsedSinceSubmit,
    moneyUnchanged, ghostsUnchanged,
  }

  // resolve_dispute — the arbiter takes their fee off INSURANCE and it is
  // returned to them as a bucket (caller-is-payee). The ruling then governs
  // reward AND the remaining insurance identically — and, since 5b, the BOND
  // follows the REWARD ruling too (W5, proportional; binary here because this
  // model's ruling is binary): PayWorker returns it whole, RefundPoster
  // forfeits it whole to the poster. Implemented in the shared
  // credit_split_for_parties so this path and auto_resolve cannot diverge.
  action resolveDispute(caller: Actor, payWorker: bool): bool = all {
    state == Disputed,
    mayResolve(caller),
    // The L6(c) self-dealing guard, shipped 2026-08-30: the badge's
    // assigned_account must differ from task.worker_account. NOTE the poster
    // side is deliberately absent — see the const block at the top.
    not(arbiterIsWorker), // the L6(c) self-dealing guard
    state' = if (payWorker) Released else Refunded,
    arbiterPaid' = arbiterPaid + ARBITER_FEE,
    workerEntitled' = if (payWorker) workerEntitled + rewardVault + (insuranceVault - ARBITER_FEE) else workerEntitled,
    posterEntitled' = if (payWorker) posterEntitled else posterEntitled + rewardVault + (insuranceVault - ARBITER_FEE),
    workerBondEntitled' = if (payWorker) workerBondEntitled + bondVault else workerBondEntitled,
    posterBondEntitled' = if (payWorker) posterBondEntitled else posterBondEntitled + bondVault,
    rewardVault' = 0, insuranceVault' = 0, bondVault' = 0,
    settledBy' = caller,
    houseVault' = houseVault,
    workerPaid' = workerPaid, posterPaid' = posterPaid, bountyPaid' = bountyPaid,
    arbiterIsWorker' = arbiterIsWorker, arbiterIsPoster' = arbiterIsPoster, totalIn' = totalIn, forfeited' = forfeited,
    submittedBy' = submittedBy,
    clocksUnchanged, disputeRaisedBy' = disputeRaisedBy,
  }

  // auto_resolve_dispute — PUBLIC, zero auth, task_id only.
  // THE ASYMMETRY THAT MATTERS: the configured default governs the REWARD only.
  // Insurance is hard-coded RefundPoster regardless — an explicit
  // anti-strict-dominance fix, because a prior version paid the worker MORE
  // than honest approval. invNoUnilateralDominance is that fix made checkable.
  // The BOND (5b/W5) follows the same worker-share as the reward ruling.
  pure def autoWorkerShare(amount: int, raisedBy: Party): int =
    if (AUTO_DEFAULT == SplitEvenly) amount / 2
    else if (AUTO_DEFAULT == ReturnToPoster) 0
    else if (AUTO_DEFAULT == FavorNonRaiser)
      (if (raisedBy == WorkerP) 0 else amount)
    else if (raisedBy == WorkerP) amount else 0

  action autoResolve: bool = all {
    state == Disputed,
    elapsedSinceDispute >= AUTO_RESOLVE_DEADLINE,
    val wShare = autoWorkerShare(rewardVault, disputeRaisedBy)
    val wBond = autoWorkerShare(bondVault, disputeRaisedBy)
    all {
      state' = if (wShare > 0) Released else Refunded,
      workerEntitled' = workerEntitled + wShare,
      // reward remainder to the poster, PLUS the whole insurance, always
      posterEntitled' = posterEntitled + (rewardVault - wShare) + insuranceVault,
      workerBondEntitled' = workerBondEntitled + wBond,
      posterBondEntitled' = posterBondEntitled + (bondVault - wBond),
      rewardVault' = 0, insuranceVault' = 0, bondVault' = 0,
      settledBy' = Clock,
      houseVault' = houseVault,
      workerPaid' = workerPaid, posterPaid' = posterPaid,
      arbiterPaid' = arbiterPaid, bountyPaid' = bountyPaid,
      arbiterIsWorker' = arbiterIsWorker, arbiterIsPoster' = arbiterIsPoster, totalIn' = totalIn, forfeited' = forfeited,
      submittedBy' = submittedBy,
      clocksUnchanged, disputeRaisedBy' = disputeRaisedBy,
    }
  }

  // withdraw_worker / withdraw_poster — deposit BOTH lanes to an account
  // PINNED at claim_task/create_task, never a caller-chosen destination. That
  // pinning is what closed BUG-7. push_entitlement (stage 4, PUBLIC, zero
  // auth) is money-equivalent to these in this model: same two-lane payout to
  // the same pinned account, only the fee-payer differs — which is exactly
  // why a public push is safe, and why it needs no separate action here.
  action withdrawWorker: bool = all {
    workerEntitled + workerBondEntitled > 0,
    workerPaid' = workerPaid + workerEntitled + workerBondEntitled,
    workerEntitled' = 0, workerBondEntitled' = 0,
    state' = state,
    rewardVault' = rewardVault, insuranceVault' = insuranceVault,
    bondVault' = bondVault, houseVault' = houseVault,
    posterEntitled' = posterEntitled, posterBondEntitled' = posterBondEntitled,
    posterPaid' = posterPaid,
    arbiterPaid' = arbiterPaid, bountyPaid' = bountyPaid,
    ghostsUnchanged, clocksUnchanged, disputeRaisedBy' = disputeRaisedBy,
  }

  action withdrawPoster: bool = all {
    posterEntitled + posterBondEntitled > 0,
    posterPaid' = posterPaid + posterEntitled + posterBondEntitled,
    posterEntitled' = 0, posterBondEntitled' = 0,
    state' = state,
    rewardVault' = rewardVault, insuranceVault' = insuranceVault,
    bondVault' = bondVault, houseVault' = houseVault,
    workerEntitled' = workerEntitled, workerBondEntitled' = workerBondEntitled,
    workerPaid' = workerPaid, arbiterPaid' = arbiterPaid, bountyPaid' = bountyPaid,
    ghostsUnchanged, clocksUnchanged, disputeRaisedBy' = disputeRaisedBy,
  }

  action tick: bool = all {
    elapsedSinceDispute' = elapsedSinceDispute + 1,
    elapsedSinceClaim' = elapsedSinceClaim + 1,
    elapsedSinceSubmit' = elapsedSinceSubmit + 1,
    state' = state, disputeRaisedBy' = disputeRaisedBy,
    moneyUnchanged, ghostsUnchanged,
  }

  // The adversary picks the caller every time, Anyone included.
  action step = any {
    nondet a = oneOf(Set(Poster, Worker, Arbiter, Anyone)) cancelTask(a),
    claimTask,
    expireClaim,
    nondet a = oneOf(Set(Poster, Worker, Arbiter, Anyone)) cancelAfterClaim(a),
    nondet a = oneOf(Set(Poster, Worker, Arbiter, Anyone)) submitTask(a),
    nondet a = oneOf(Set(Poster, Worker, Arbiter, Anyone)) approveAndRelease(a),
    releaseAfterTimeout,
    nondet a = oneOf(Set(Poster, Worker, Arbiter, Anyone))
      nondet w = oneOf(Set(PosterP, WorkerP)) raiseDispute(a, w),
    nondet a = oneOf(Set(Poster, Worker, Arbiter, Anyone))
      nondet f = oneOf(Set(true, false)) resolveDispute(a, f),
    autoResolve,
    withdrawWorker,
    withdrawPoster,
    tick,
  }

  // ══ SAFETY PROPERTIES ═════════════════════════════════════════════════════

  // 1. CONSERVATION. Every unit escrowed is in a vault, credited, or paid out.
  //    The house vault and the expiry bounty are IN the sum — leaving them out
  //    is how a "conservation" invariant silently stops covering forfeiture.
  val invConservation: bool =
    rewardVault + insuranceVault + bondVault + houseVault
      + workerEntitled + posterEntitled + workerBondEntitled + posterBondEntitled
      + workerPaid + posterPaid + arbiterPaid + bountyPaid
    == totalIn

  // 2. NON-NEGATIVITY — catches sign errors in every split.
  val invNonNegative: bool =
    rewardVault >= 0 and insuranceVault >= 0 and bondVault >= 0 and houseVault >= 0
      and workerEntitled >= 0 and posterEntitled >= 0
      and workerBondEntitled >= 0 and posterBondEntitled >= 0
      and workerPaid >= 0 and posterPaid >= 0

  // 3. NO AMBIGUOUS AUTHORITY. A terminal state was reached by a NAMED authority
  //    — a party with a credential, or the clock. Never by Anyone.
  //    This is BUG-7's property. BUG-7 is closed under PULL; this keeps it closed.
  val invOnlyAuthorisedSettled: bool =
    isTerminal(state) implies
      (settledBy == Poster or settledBy == Arbiter or settledBy == Clock)

  // 4. NO UNILATERAL DOMINANCE. The property that matters is not "no outcome
  //    ever pays more than approval" — an arbiter is *supposed* to be able to move
  //    the insurance. It is that no outcome the worker can reach WITHOUT a
  //    favourable third-party ruling beats honest delivery. The worker can reach
  //    auto-resolve unilaterally: raise a dispute, wait out the clock. So the
  //    bound applies to exactly that path.
  //    lib.rs's credit_split_for_parties comment block records a prior version
  //    where it did NOT hold — auto-resolve paid MORE than honest approval, so
  //    disputing dominated delivering. The fix (insurance hard-coded
  //    RefundPoster on the auto path) is what makes this true.
  //    Honest delivery pays REWARD + the bond back (5b), so the bound is
  //    REWARD + BOND — reached with equality by FavorDisputeRaiser, never
  //    exceeded. The bond following the reward ruling (W5) keeps it tight:
  //    a self-disputing worker's bond share can never beat "bond back whole".
  val invNoUnilateralDominance: bool =
    (settledBy == Clock) implies
      (workerEntitled + workerBondEntitled + workerPaid <= REWARD + BOND)

  // 4b. THE ARBITER'S REACH IS BOUNDED. An arbiter can move the reward, the
  //     insurance remainder AND (since W5) the bond between the parties, and
  //     takes a fee — but never more than was escrowed on this task.
  val invArbiterRulingBounded: bool =
    (settledBy == Arbiter) implies
      (workerEntitled + workerBondEntitled + workerPaid
          <= REWARD + INSURANCE - ARBITER_FEE + BOND
        and arbiterPaid <= ARBITER_FEE)

  // 5. FORFEITURE PAYS CALLER + HOUSE, NOBODY ELSE (ruling DB-4). A
  //    poster-credited forfeit pays for authoring unsatisfiable briefs at
  //    volume. The old form bounded the poster's TOTAL take, which W5 broke
  //    legitimately (rulings now credit poster bond); the `forfeited` ghost
  //    states the property directly instead: every unit expire_claim ever
  //    forfeited is in the house vault or paid out as caller bounty.
  val invForfeitureIsCallerAndHouseOnly: bool =
    houseVault + bountyPaid == forfeited

  // 6. NO OVER-WITHDRAW — nothing leaves that was never escrowed.
  val invNoOverWithdraw: bool =
    workerPaid + posterPaid + arbiterPaid + bountyPaid <= totalIn

  // 7. NO STRANDED FUNDS. In a terminal state with the vaults drained, the money
  //    is owed to someone or already gone. Nothing evaporates.
  val invNoStrandedFunds: bool =
    (isTerminal(state) and rewardVault + insuranceVault == 0) implies
      (workerEntitled + posterEntitled + workerBondEntitled + posterBondEntitled
        + workerPaid + posterPaid + arbiterPaid + bountyPaid > 0)

  // 7b. THE BOND VAULT DRAINS AT SETTLEMENT (5b). Held-to-settlement means
  //     held TO settlement, not past it: every terminal transition takes the
  //     whole bond vault into a lane. A path that forgets the bond leg would
  //     conserve (the money just sits) and strand the worker's stake forever.
  val invNoBondLeftBehindAtSettlement: bool =
    isTerminal(state) implies bondVault == 0

  // 8a. NO WORKER-ARBITER EVER RULES. The L6(c) guard, made checkable.
  //     Vacuous in the healthy instance (the const is false) BY DESIGN — the
  //     SELF-DEALING-GUARD-DELETED mutation is what arms it: it re-assigns
  //     the healthy instance's badge to the worker AND strips the guard, and
  //     this invariant must then produce the worker-arbiter-rules
  //     counterexample. A vacuous invariant with a mutation that arms it is
  //     the harness's contract; a vacuous invariant WITHOUT one is the
  //     vacuous-pass trap.
  val invNoWorkerArbiterRuling: bool =
    (settledBy == Arbiter) implies not(arbiterIsWorker)

  // 8b. THE POSTER-SIDE EXPOSURE, KEPT VISIBLE. Deliberately violated in the
  //     escrow_arbiter_is_poster twin: an arbiter assigned to the poster's
  //     account CAN rule (L6 ruled (c) — poster is a payout destination, not
  //     an identity; a poster-side check would be decoy-defeatable). If the
  //     twin stops producing a counterexample, the model stopped representing
  //     the exposure and the healthy run means less than it appears to.
  //
  //     ⚠️ GATED ON settledBy, and it was NOT until 2026-09-01. It read
  //     `not(arbiterIsPoster)` — an unguarded read of a const the twin sets
  //     at init — so the counterexample was [State 0], `state: Open`,
  //     `settledBy: Nobody`: no transition ever fired. It "detected" the
  //     mutation the way a thermometer detects a fire it is standing next to.
  //     The exposure is real, but the proof of it was not: the mutation's own
  //     description promises a trace in which the arbiter-poster RULES, and
  //     only the gated form produces one. Same shape as its sibling at 8, and
  //     the same lesson this repo keeps re-learning — a verification that
  //     cannot fail over the part that matters.
  val invArbiterNotPoster: bool =
    (settledBy == Arbiter) implies not(arbiterIsPoster)

  // 9. SUBMIT IS NEVER ENTERED BY A NON-WORKER CALLER. Kept after 5b, with a
  //    narrower claim than it was born with: submit no longer moves money, so
  //    what this now pins is the model-level authority abstraction (a submit
  //    reachable by Anyone would be a griefing surface — an attacker-chosen
  //    evidence hash — not theft). It needs its own invariant rather than
  //    reusing invOnlyAuthorisedSettled because Submitted is NOT a terminal
  //    state, so that invariant's settledBy check cannot see this transition
  //    at all — hence the separate submittedBy ghost. The bond-theft class
  //    this once stood in for is gated at SOURCE
  //    (test_submit_task_returns_nothing): a parallel session measured that
  //    invConservation cannot see who a balanced payout went to.
  val invSubmitOnlyByWorker: bool =
    (submittedBy != Nobody) implies (submittedBy == Worker)

  val allSafety: bool =
    invConservation and invNonNegative and invOnlyAuthorisedSettled
      and invNoUnilateralDominance and invArbiterRulingBounded
      and invForfeitureIsCallerAndHouseOnly
      and invNoOverWithdraw and invNoStrandedFunds
      and invNoBondLeftBehindAtSettlement
      and invSubmitOnlyByWorker

  // ══ GAPS — stated so a green run cannot be mistaken for coverage ══════════
  //  - ONE task. The house vault is shared across tasks in the real component;
  //    cross-task coupling through it is NOT modelled.
  //  - Decimal arithmetic, truncation and per-side rounding are abstracted to
  //    ints. That includes ALL of stage 5's rounding discipline (bond split,
  //    bounty, required_bond) — gated by the 6dp ledger tests, not here. The
  //    integer division in autoWorkerShare (amount / 2) happens to mirror
  //    round-down-remainder-to-poster, but do not cite it as proving it.
  //  - The bond SIZE is a constant. clamp(pct * reward, floor, cap) and the
  //    setters that move pct/floor/cap are not modelled; faithful because the
  //    bond is pinned onto the task at claim (`task.claim_bond_amount`), so
  //    no later tune changes an in-flight task.
  //  - Owner setters generally: out of scope. Dispute terms are pinned at
  //    raise (the retroactive-setter fix), which is what makes the constant
  //    abstraction sound for the dispute lifecycle too.
  //  - burn_task_receipt, withdraw_forfeited_bonds (OWNER) and the agent-badge
  //    controller are out of scope. push_entitlement is NOT modelled as its
  //    own action — in this model it is money-identical to withdraw_* (both
  //    lanes, pinned destination, caller irrelevant); see the comment there.
  //  - Re-claim after expire_claim returns the task to Open, but the model does
  //    not bound how many times that can happen; --max-steps does.
  //  - Liveness ("money owed is always eventually collectable") is not checked;
  //    it needs fairness assumptions.
  //  - `maySubmit` remains a model-side idealisation, not a lib.rs check —
  //    submit_task still never reads task.worker_account. Since 5b that
  //    mismatch is griefing-shaped, not money-shaped: submit moves no money,
  //    and the bond-theft class is gated at source
  //    (test_submit_task_returns_nothing), where a conservation invariant
  //    provably cannot hold it (measured: the sums balance whoever is paid).
  //  - The bearer-credential angle (a worker who transfers or loses the
  //    claim_receipt NFT) is still not modelled: there is no Actor for "holds
  //    the receipt but isn't the true worker". What such a holder can do
  //    post-5b is submit with their own evidence hash — a state change, no
  //    money. DESIGN-REVIEW-2027.md §19.7 gap 2 rows 2/3 name this.
  //  - Stage 6's submission validation (non-zero evidence hash; brief_hash
  //    must equal the committed work_brief_hash) is HASH-level and out of
  //    scope — this model has no hashes. Gated by the ledger tests
  //    (test_submit_rejects_zero_evidence_hash / _wrong_brief_hash). What IS
  //    modelled is what those asserts license: the timed release itself.
}

// ── The healthy instance ────────────────────────────────────────────────────
// The arbiter badge is assigned to a neutral third party — the ceremony's
// intended mint.
module escrow_honest_arbiter {
  import escrow_types.*
  import escrow_task(ARBITER_IS_WORKER = false, ARBITER_IS_POSTER = false,
                     AUTO_DEFAULT = SplitEvenly).*
}

// ── TWIN: the badge assigned to the POSTER ──────────────────────────────────
// The side L6(c) leaves OPEN BY DESIGN. `invArbiterNotPoster` must produce a
// counterexample here — an arbiter-poster ruling on a dispute they funded is
// reachable, honestly, and the honesty copy states it. If the counterexample
// disappears, either someone built the decoy-defeatable poster check (see the
// ledger test that pins against that) or the model stopped representing the
// exposure.
module escrow_arbiter_is_poster {
  import escrow_types.*
  import escrow_task(ARBITER_IS_WORKER = false, ARBITER_IS_POSTER = true,
                     AUTO_DEFAULT = SplitEvenly).*
}

// ── THE THREE UNVERIFIED DEFAULTS ───────────────────────────────────────────
// Not twins — these are HEALTHY instances that differ only in the owner-selected
// auto-resolve default. Every invariant must hold in all of them; a violation
// here is a real finding about a configuration the operator can select today,
// not a deliberately-broken model.
//
// Added 2026-09-01. Before this, `verify` ran against SplitEvenly alone, so the
// strongest claim the harness could license was "safe at the deployed default"
// — while `dispute_auto_resolve_default` sat pinned per-task and settable, and
// this very branch shipped the stage-6 work that makes FavorNonRaiser coherent
// to choose. The gap was in the one direction that mattered.
module escrow_favor_non_raiser {
  import escrow_types.*
  import escrow_task(ARBITER_IS_WORKER = false, ARBITER_IS_POSTER = false,
                     AUTO_DEFAULT = FavorNonRaiser).*
}

module escrow_return_to_poster {
  import escrow_types.*
  import escrow_task(ARBITER_IS_WORKER = false, ARBITER_IS_POSTER = false,
                     AUTO_DEFAULT = ReturnToPoster).*
}

module escrow_favor_dispute_raiser {
  import escrow_types.*
  import escrow_task(ARBITER_IS_WORKER = false, ARBITER_IS_POSTER = false,
                     AUTO_DEFAULT = FavorDisputeRaiser).*
}
