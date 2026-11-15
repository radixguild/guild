use scrypto::prelude::*;

// P7-02 (task 90): a standalone blueprint in this SAME package, own module.
// Deliberately NOT wired into anything below — no shared struct, no shared
// helper, no touched method. See src/nft_swap.rs's own header for what it
// implements and which rulings it follows.
pub mod nft_swap;

// ── Config view + state types ────────────────────────────────────────────────

#[derive(ScryptoSbor, Clone, Debug, PartialEq)]
pub struct AcceptedTokenConfig {
    pub min_amount: Decimal,
    pub frozen: bool,
}

#[derive(ScryptoSbor, ManifestSbor, Clone, Debug, PartialEq)]
/// What `auto_resolve_dispute` pays when the window lapses and nobody judged.
///
/// ⚠️ VARIANT ORDER IS AN ON-CHAIN ENCODING. These are SBOR-encoded by INDEX —
/// `SplitEvenly` is `Enum<1u8>` in every instantiate manifest and in the signed
/// parameter sheet. **New variants go at the END, always.** Reordering or
/// inserting silently re-points every manifest that names a variant by index,
/// including ones already written down in runbooks.
///
/// Wave B W1 (operator ruling 2026-08-29: *"a few set dropdown options — 50/50
/// and whatever else works"*) makes this a curated SET the owner picks from at
/// runtime via `set_dispute_auto_resolve_default`, rather than a value welded in
/// at instantiate. The set is deliberately small: each variant is a stance on
/// who carries the loss when NOBODY showed up, and a marketplace with eight
/// answers to that has no answer.
pub enum AutoResolveDefault {
    /// Whoever raised wins. ⚠️ On PULL either party can raise and the first
    /// raise locks the other out, so this is a first-raiser RACE — its fairness
    /// depends on an arbiter SLA nobody has promised. Reversed as the deploy
    /// default by DB-1 for exactly that reason. Kept selectable, not deleted.
    FavorDisputeRaiser,
    /// 50/50 of the reward; insurance home whole to the poster. The deployed
    /// default — neutral on mutual abandonment, and the only variant that pays
    /// no more than honest approval does.
    SplitEvenly,
    /// Everything back to the poster.
    ReturnToPoster,
    /// Whoever raised LOSES. Wave B W1: the anti-stonewall stance — it removes
    /// the incentive to raise a dispute speculatively and wait out the clock.
    ///
    /// 🔴 DO NOT SELECT THIS ALONE. It is only coherent shipped WITH auto-release
    /// (W2) and submission validation (P4-3): on its own it hands a stonewalling
    /// POSTER a free win, because a worker whose only escape is raising a dispute
    /// now loses by raising it. The operator ruled all three together for that
    /// reason. The variant exists here from stage 3 so the enum shape is settled
    /// in one swap; selecting it is a stage-6 action.
    FavorNonRaiser,
}

#[derive(ScryptoSbor, Clone, Debug, PartialEq)]
pub enum TaskState {
    Open,
    Claimed,
    Submitted,
    Disputed,
    Released,
    Refunded,
}

#[derive(ScryptoSbor, Clone, Debug, PartialEq)]
pub enum DisputeParty {
    Poster,
    Worker,
}

/// Distribution choice for resolve_dispute. Arbiter fee comes off the
/// insurance vault BEFORE distribution; the remaining insurance follows
/// the same ruling as the reward.
#[derive(ScryptoSbor, ManifestSbor, Clone, Debug, PartialEq)]
pub enum DisputeRuling {
    PayWorker,
    RefundPoster,
    /// worker_pct + poster_pct must sum to exactly 1.
    Split { worker_pct: Decimal, poster_pct: Decimal },
}

#[derive(ScryptoSbor, Clone)]
pub struct TaskInfo {
    pub poster: ComponentAddress,
    pub reward_token: ResourceAddress,
    pub reward_amount: Decimal,
    pub insurance_amount: Decimal,
    pub arbiter_fee_pct: Decimal,
    pub work_brief_hash: Hash,
    pub created_at: Instant,
    pub state: TaskState,
    pub claimer_badge_id: Option<NonFungibleLocalId>,
    pub claim_deadline: Option<Instant>,
    /// The bond this task's claimer actually posted, in the task's REWARD
    /// TOKEN, pinned at `claim_task`. Pinned rather than recomputed because
    /// `claim_bond_pct/floor/cap` are owner-settable: recomputing at settlement
    /// would let a later tune change what a worker gets back, which is the
    /// retroactivity class already fixed for dispute terms.
    pub claim_bond_amount: Option<Decimal>,
    pub claimer_is_agent: bool,
    pub submit_evidence_hash: Option<Hash>,
    pub submitted_at: Option<Instant>,
    /// Wave B W2: `submitted_at + review_window_secs`, PINNED at submit_task —
    /// same non-retroactivity discipline as `claim_bond_amount` and the dispute
    /// terms: a later tune of `review_window_secs` never moves a deadline a
    /// poster is already reviewing under. After it, `release_after_review_timeout`
    /// is callable by anyone; `raise_dispute` stays available right up until
    /// someone actually fires the release (first-to-commit, by design — the
    /// window is the poster's floor, not their cutoff).
    pub review_deadline: Option<Instant>,
    // Local-id of the currently-active claim_receipt for this task (None when
    // no live claim). Distinct from task_id so re-claim after expire / cancel
    // doesn't collide with the orphan receipt left in the previous worker's
    // wallet. submit_task verifies the receipt against this field.
    pub current_claim_receipt_id: Option<u64>,
    // Worker's global account address, captured at claim_task time. Needed
    // for resolve_dispute / auto_resolve_dispute to deposit worker_share
    // directly (claim_receipt is burned at submit_task so we can't look up
    // worker via ClaimReceiptData by then).
    pub worker_account: Option<ComponentAddress>,
    // Set at raise_dispute time. `disputed_at` is read by
    // auto_resolve_dispute on EVERY variant — it is what gates the
    // window-elapsed assert. `dispute_raised_by` is the raiser-sensitive one,
    // branched on by `FavorDisputeRaiser` and its mirror `FavorNonRaiser` and
    // ignored by the rest. Both also feed the DisputeRaised event.
    pub disputed_at: Option<Instant>,
    pub dispute_raised_by: Option<DisputeParty>,
    pub dispute_evidence_hash: Option<Hash>,
    /// The auto-resolve window and default ruling AS THEY STOOD when the
    /// dispute was raised. `None` on any task that has never been disputed.
    /// Read by `auto_resolve_dispute` in preference to live config — see the
    /// pin comment in `raise_dispute`.
    pub dispute_auto_resolve_secs: Option<u64>,
    pub dispute_auto_resolve_default: Option<AutoResolveDefault>,
    // ── PULL entitlements (docs/design/escrow-pull-redesign.md) ──────────────
    // Settled-but-unwithdrawn amounts. Settlement CREDITS these and moves the
    // funds into a settlement vault; the entitled party later WITHDRAWS against
    // a credential. Nothing is ever returned to a settlement caller, which is
    // what closes BUG-7, M4 and the anonymous auto_resolve drain.
    //
    // TWO LANES — reward+insurance in one, the claim bond in the other. A
    // single settlement can credit BOTH, to DIFFERENT parties, in one call:
    // `cancel_task_by_poster_after_claim` gives the poster reward+insurance AND
    // returns the worker their bond. One Decimal per party cannot carry two
    // independently-owed amounts, and the two are owed on different terms — a
    // bond can be forfeited to the house or split to an `expire_claim` caller,
    // which is never true of a reward.
    //
    // ⚠️ The lanes are NO LONGER a split by RESOURCE, and the text here said
    // they were until W4. `reward` and `insurance` are still forced to the same
    // token at create_task (`assert_eq!(insurance.resource_address(),
    // reward_token, …)`) — but the bond is no longer forced to XRD. claim_task
    // now asserts `assert_eq!(claim_bond.resource_address(), task.reward_token,
    // …)` and sizes it with `required_bond` (pct of reward, clamped by
    // `claim_bond_floor`/`claim_bond_cap`), replacing the flat `claim_bond_xrd`.
    // So BOTH lanes are pinned to the task's reward_token — `Vault::new(
    // reward_token)` twice in create_task — and therefore ALWAYS hold the same
    // resource, not merely the same one in production. The two-lane structure
    // survived the change; only its justification moved, to the paragraph
    // above. Separate is deliberate, not vestigial.
    //
    // Phase 2 shipped a single-lane version and it was WRONG — for a reason
    // that W4 has since retired: the mixed put failed with InvalidDropAccess,
    // and the tripwire's conservation assertion summed 1 XRD with 110 of
    // another token as though the units agreed. Production never noticed
    // because production rewards ARE XRD; the suite's non-XRD reward token is
    // the only reason CI could see it at all. That specific failure can no
    // longer occur now that both lanes share a resource — but merging them
    // would still lose the poster/worker split above, so the two lanes stand on
    // their own feet rather than on this history.
    //
    // ⚠️ The create_task and claim_task references above were bare LINE NUMBERS
    // — "(:611)" and "(:800)" — until 2026-08-29, and both were already wrong [cite-exempt: quoting the anti-pattern]
    // before this file was last edited: :611 pointed at `task_receipt_manager`. [cite-exempt: quoting the anti-pattern]
    // A line number in a comment rots silently on the next insertion above it,
    // and rots WORST in exactly this block — the one every reader is sent to
    // when they need to understand why the two lanes exist. Cite the code by
    // its content, not its address; grep finds it and grep cannot go stale.
    //
    // Invariants, ASSERTED (see assert_conservation) — each within one lane,
    // and BOTH vaults hold the task's reward_token:
    //   worker_entitled      + poster_entitled      == settlement vault
    //   worker_bond_entitled + poster_bond_entitled == bond settlement vault
    //
    // There is deliberately no arbiter lane: `resolve_dispute` hands the fee
    // straight back to the arbiter who called it, on the same caller-is-payee
    // grounds that leave `submit_task` alone. See resolve_dispute's doc.
    pub worker_entitled: Decimal,
    pub poster_entitled: Decimal,
    pub worker_bond_entitled: Decimal,
    pub poster_bond_entitled: Decimal,
}

/// Which party a withdrawal belongs to. Carried on WithdrawalEvent so the
/// off-chain reconciler can tell a settled task from a collected one — under
/// pull, `Released` no longer means the money moved (see redesign §5c).
// ManifestSbor is required as of Wave B stage 4: `push_entitlement` takes this
// as a method ARGUMENT, so a caller must be able to encode it in a manifest.
// The other lifecycle enums that cross the manifest boundary (AutoResolveDefault,
// DisputeRuling) already carry it; this one did not, because until now it was
// internal-only.
#[derive(ScryptoSbor, ManifestSbor, Clone, Debug, PartialEq)]
pub enum EntitledParty {
    Worker,
    Poster,
}

/// Which resource a credit or withdrawal moved.
///
/// This is NOT redundant with a resource address, and that is the whole reason
/// it exists: since W4 the claim bond is denominated in the task's reward token
/// too, so BOTH lanes always carry the same resource and a single
/// `withdraw_poster` can emit two WithdrawalEvents identical in (task_id,
/// party, resource) and differing only in amount. Any off-chain consumer keying
/// or de-duplicating on those three fields would silently drop one leg. The
/// lane is the discriminator; the resource is bookkeeping.
///
/// It was already this way in practice before W4 — production rewards ARE XRD,
/// so an XRD bond collided with them anyway — but that was a coincidence of the
/// live parameters. Now it is guaranteed by an assert, which makes reading
/// `lane` mandatory rather than merely prudent.
#[derive(ScryptoSbor, Clone, Debug, PartialEq)]
pub enum EntitlementLane {
    /// The task's reward token — reward and insurance.
    Reward,
    /// The claim bond, when a settlement awards it — same resource as
    /// `Reward` since W4, which is exactly why this discriminator exists.
    Bond,
}

#[derive(ScryptoSbor, NonFungibleData, Clone)]
pub struct TaskReceiptData {
    pub task_id: u64,
    pub poster: ComponentAddress,
}

#[derive(ScryptoSbor, NonFungibleData, Clone)]
pub struct ClaimReceiptData {
    pub task_id: u64,
    pub worker: ComponentAddress,
    pub is_agent: bool,
}

/// The Wave B arbiter badge's non-fungible data — L3(b)'s identity field, and
/// the MINT CONTRACT for the ceremony: the fresh non-transferable arbiter
/// resource passed as the write-once `arbiter_badge_resource` must carry
/// EXACTLY this data shape, or `resolve_dispute`'s decode panics and every
/// arbiter ruling bricks until a component swap. One field, deliberately:
/// extra fields are extra ways for the mint manifest and this struct to
/// disagree.
///
/// `assigned_account` is who this badge was issued to. It is what the L6(c)
/// self-dealing guard compares against the task's pinned `worker_account` —
/// see the guard in `resolve_dispute` for why the WORKER side is the only
/// side that comparison can honestly cover.
// ManifestSbor as well as ScryptoSbor: the MINT happens off-component (the
// badge pre-exists the instantiate manifest), so whoever builds that manifest
// — the ceremony runbook, the test fixture — needs to manifest-encode this.
#[derive(ScryptoSbor, ManifestSbor, NonFungibleData, Clone)]
pub struct ArbiterBadgeData {
    pub assigned_account: ComponentAddress,
}

#[derive(ScryptoSbor)]
pub struct EscrowConfig {
    pub worker_badge_resource: ResourceAddress,
    pub arbiter_badge_resource: ResourceAddress,
    pub agent_badge_resource: Option<ResourceAddress>,
    pub max_arbiter_fee_pct: Decimal,
    pub human_submit_deadline_secs: u64,
    pub agent_submit_deadline_secs: u64,
    pub dispute_auto_resolve_secs: u64,
    /// D-P3: grace window after `claim_deadline` during which ONLY the worker
    /// may act. `expire_claim` refuses until `deadline + expire_grace_secs`.
    pub expire_grace_secs: u64,
    pub dispute_auto_resolve_default: AutoResolveDefault,
    pub min_insurance_fraction: Decimal,
    pub claim_bond_pct: Decimal,
    pub claim_bond_floor: Decimal,
    pub claim_bond_cap: Decimal,
    /// Absent until stage 5a shipped the field; exposing a tunable the config
    /// view hides makes every off-chain reader re-derive it from events.
    pub expire_bounty_pct: Decimal,
    pub review_window_secs: u64,
}

// ── Events ───────────────────────────────────────────────────────────────────

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct EscrowInstantiatedEvent {
    pub owner_badge_resource: ResourceAddress,
    pub royalty_admin_badge_resource: ResourceAddress,
    pub worker_badge_resource: ResourceAddress,
    pub arbiter_badge_resource: ResourceAddress,
    pub agent_badge_resource: Option<ResourceAddress>,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct TokenWhitelistedEvent {
    pub resource: ResourceAddress,
    pub min_amount: Decimal,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct TokenRemovedEvent { pub resource: ResourceAddress }

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct TokenFrozenEvent { pub resource: ResourceAddress }

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct TokenUnfrozenEvent { pub resource: ResourceAddress }

// ── Wave B: owner-tuning events ──────────────────────────────────────────────
// Every setter emits. A config change that moves no money still changes what
// the component will DO with the next task's money, so it must be as auditable
// from the ledger as a settlement is — otherwise the only record of a tune is
// the operator's word for it.

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct DisputeAutoResolveDefaultUpdatedEvent { pub default: AutoResolveDefault }

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct DisputeAutoResolveSecsUpdatedEvent { pub secs: u64 }

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct HumanSubmitDeadlineUpdatedEvent { pub secs: u64 }

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct AgentSubmitDeadlineUpdatedEvent { pub secs: u64 }

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct MinInsuranceFractionUpdatedEvent { pub fraction: Decimal }

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct MaxArbiterFeePctUpdatedEvent { pub pct: Decimal }

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct ExpireGraceSecsUpdatedEvent { pub secs: u64 }

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct ClaimBondParamsUpdatedEvent {
    pub claim_bond_pct: Decimal,
    pub claim_bond_floor: Decimal,
    pub claim_bond_cap: Decimal,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct ExpireBountyPctUpdatedEvent { pub pct: Decimal }

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct ReviewWindowSecsUpdatedEvent { pub secs: u64 }

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct ForfeitedBondsWithdrawnEvent { pub resource: ResourceAddress, pub amount: Decimal }

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct TaskCreatedEvent {
    pub task_id: u64,
    pub poster: ComponentAddress,
    pub reward_token: ResourceAddress,
    pub reward_amount: Decimal,
    pub insurance_amount: Decimal,
    pub arbiter_fee_pct: Decimal,
    pub work_brief_hash: Hash,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct TaskCancelledEvent { pub task_id: u64 }

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct TaskClaimedEvent {
    pub task_id: u64,
    pub claimer_badge_id: NonFungibleLocalId,
    pub is_agent: bool,
    pub claim_deadline: Instant,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct ClaimExpiredEvent {
    pub task_id: u64,
    pub forfeited_bond_amount: Decimal,
    pub bounty_paid: Decimal,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct TaskCancelledAfterClaimEvent {
    pub task_id: u64,
    pub bond_returned_to: ComponentAddress,
    pub bond_amount: Decimal,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct WorkSubmittedEvent {
    pub task_id: u64,
    pub evidence_hash: Hash,
    pub submitted_at: Instant,
    /// W2: when the poster's review window lapses and anyone may call
    /// `release_after_review_timeout`. In the event so watchers can show a
    /// countdown without a state read. Additive field — the live bot's
    /// watcher parses events by field NAME, never by index.
    pub review_deadline: Instant,
}

/// Emitted by every settlement path once it has recorded the split. Under
/// pull this — not TaskReleasedEvent — is the event that says how much each
/// party is OWED. TaskReleased/TaskRefunded continue to mean "the task reached
/// a terminal state", which is no longer the same thing as "the money moved".
/// Both lanes are always reported, including the zeros, so no consumer has to
/// infer an absent lane from a missing field. One lane legitimately reads zero
/// — a task whose bond params are zero settles with an empty bond lane — and a
/// reader that treated that as "no event" would drop a real settlement off the
/// money-path rail the reconciler and drift watcher read.
///
/// ⚠️ This used to justify itself with "`expire_claim` credits ONLY the bond".
/// Under DB-4 that is false: `expire_claim` credits NEITHER lane — it forfeits
/// the bond to the caller's bounty plus the house vault and, as its own body
/// says, deliberately emits no settlement event at all. The rule above is
/// right; the example was not.
#[derive(ScryptoSbor, ScryptoEvent)]
pub struct SettlementCreditedEvent {
    pub task_id: u64,
    pub worker_entitled: Decimal,
    pub poster_entitled: Decimal,
    pub worker_bond_entitled: Decimal,
    pub poster_bond_entitled: Decimal,
}

/// Emitted when an entitled party actually collects. The off-chain layer is
/// blind to collection without this — see redesign §5c.
#[derive(ScryptoSbor, ScryptoEvent)]
pub struct WithdrawalEvent {
    pub task_id: u64,
    pub party: EntitledParty,
    /// Read this, not `resource`, to tell the two legs apart — see EntitlementLane.
    pub lane: EntitlementLane,
    pub resource: ResourceAddress,
    pub amount: Decimal,
    /// PAYEE PIN: the account these funds were deposited into. Fixed at
    /// `create_task` (poster) / `claim_task` (worker) and NEVER chosen by the
    /// caller, so the off-chain layer can audit payee correctness straight from
    /// the event stream without a state read.
    pub destination: ComponentAddress,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct TaskReleasedEvent {
    pub task_id: u64,
    pub ruling: String,
    pub arbiter_fee: Decimal,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct TaskRefundedEvent {
    pub task_id: u64,
    pub arbiter_fee: Decimal,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct DisputeRaisedEvent {
    pub task_id: u64,
    pub raised_by: DisputeParty,
    pub dispute_evidence_hash: Option<Hash>,
    /// The terms this dispute was raised UNDER, emitted so an observer can see
    /// them from the ledger alone rather than having to trust that config had
    /// not moved. `Some` on every dispute raised since the pin shipped.
    pub dispute_auto_resolve_secs: Option<u64>,
    pub dispute_auto_resolve_default: Option<AutoResolveDefault>,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct DisputeResolvedEvent {
    pub task_id: u64,
    pub ruling: DisputeRuling,
    pub arbiter_fee: Decimal,
    pub worker_amount: Decimal,
    pub poster_amount: Decimal,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct DisputeAutoResolvedEvent {
    pub task_id: u64,
    pub default_ruling: DisputeRuling,
    pub worker_amount: Decimal,
    pub poster_amount: Decimal,
}

// ── Blueprint ────────────────────────────────────────────────────────────────

// Guild marketplace escrow — mid-claim lifecycle (PR 2.3 over PR 2.2).
//
// State machine: Open <-> Claimed -> Submitted -> Released | Refunded
//                          ^   |
//                          |   v
//                      expire_claim (Claimed -> Open, bond forfeited)
//                      cancel_after_claim (Claimed -> Refunded, bond to worker)
// (Disputed branch lands in PR 2.4 per docs/ESCROW-DESIGN.md §4.)
//
// Auth, as it actually stands after PULL + DB-3 — the older version of this
// note listed cancel/approve/cancel_after_claim as bucket-burns, which PULL
// changed and nobody updated:
//   • bucket-burn: `submit_task` only (the claim_receipt is consumed there).
//   • Proof, NOT burned: `cancel_task`, `approve_and_release`,
//     `cancel_task_by_poster_after_claim` — the task_receipt is retained
//     because its holder still needs it to `withdraw_poster`, and it is
//     retired later by `burn_task_receipt`.
//   • PUBLIC, time-gated: `expire_claim`.
// No method between claim and submit requires the claim_receipt to be
// PRESENTED as a Proof any more: DB-3 removed `heartbeat`, which was the only
// reason it was ever a re-usable Proof rather than a one-shot bucket. Its DATA
// is still read in between — `cancel_task_by_poster_after_claim` resolves the
// worker address from it — and on the expire / cancel-after-claim paths it is
// left orphaned in the worker's wallet rather than burned.
#[blueprint]
#[events(
    EscrowInstantiatedEvent,
    TokenWhitelistedEvent,
    TokenRemovedEvent,
    TokenFrozenEvent,
    TokenUnfrozenEvent,
    ForfeitedBondsWithdrawnEvent,
    TaskCreatedEvent,
    TaskCancelledEvent,
    TaskClaimedEvent,
    ClaimExpiredEvent,
    TaskCancelledAfterClaimEvent,
    WorkSubmittedEvent,
    TaskReleasedEvent,
    TaskRefundedEvent,
    DisputeRaisedEvent,
    DisputeResolvedEvent,
    DisputeAutoResolvedEvent,
    // PULL (phase 1 added the structs, phase 2 is the first code to EMIT them).
    // Omitting them here is not a compile error and not a check error — it is a
    // runtime BlueprintPayloadDoesNotExist on every settlement, which is why
    // phase 1 could be green while inert. Any new event must be added here.
    SettlementCreditedEvent,
    WithdrawalEvent,
    // Wave B owner-tuning events. Per the warning above: registering here is
    // NOT optional — omission compiles and checks green, then fails at runtime.
    DisputeAutoResolveDefaultUpdatedEvent,
    DisputeAutoResolveSecsUpdatedEvent,
    HumanSubmitDeadlineUpdatedEvent,
    AgentSubmitDeadlineUpdatedEvent,
    MinInsuranceFractionUpdatedEvent,
    MaxArbiterFeePctUpdatedEvent,
    ExpireGraceSecsUpdatedEvent,
    ClaimBondParamsUpdatedEvent,
    ExpireBountyPctUpdatedEvent,
    ReviewWindowSecsUpdatedEvent
)]
mod guild_marketplace_escrow {
    enable_method_auth! {
        methods {
            // Owner-gated configuration
            add_accepted_token => restrict_to: [OWNER];
            remove_accepted_token => restrict_to: [OWNER];
            freeze_token => restrict_to: [OWNER];
            unfreeze_token => restrict_to: [OWNER];
            withdraw_forfeited_bonds => restrict_to: [OWNER];
            // Wave B tuning surface — see the setter block's rationale.
            set_dispute_auto_resolve_default => restrict_to: [OWNER];
            set_dispute_auto_resolve_secs => restrict_to: [OWNER];
            set_human_submit_deadline_secs => restrict_to: [OWNER];
            set_agent_submit_deadline_secs => restrict_to: [OWNER];
            set_min_insurance_fraction => restrict_to: [OWNER];
            set_max_arbiter_fee_pct => restrict_to: [OWNER];
            set_expire_grace_secs => restrict_to: [OWNER];
            set_claim_bond_params => restrict_to: [OWNER];
            set_expire_bounty_pct => restrict_to: [OWNER];
            set_review_window_secs => restrict_to: [OWNER];

            // Task lifecycle (auth happens inside via bucket-burn or Proof check)
            create_task => PUBLIC;
            cancel_task => PUBLIC;
            claim_task => PUBLIC;
            expire_claim => PUBLIC;
            cancel_task_by_poster_after_claim => PUBLIC;
            submit_task => PUBLIC;
            approve_and_release => PUBLIC;
            // W2: PUBLIC + zero auth like auto_resolve_dispute and for the
            // same reason — a credentialed finalizer can be stalled by the
            // party it exists to protect against. Time-gated inside.
            release_after_review_timeout => PUBLIC;
            raise_dispute => PUBLIC;
            resolve_dispute => PUBLIC;
            auto_resolve_dispute => PUBLIC;

            // PULL withdrawals — PUBLIC because the auth is the Proof checked
            // inside, same convention as the lifecycle methods above.
            withdraw_worker => PUBLIC;
            withdraw_poster => PUBLIC;
            burn_task_receipt => PUBLIC;
            // PUBLIC and unauth'd BY DESIGN — the destination is read from
            // state, never from the caller. See the method's own note.
            push_entitlement => PUBLIC;

            // Public views
            get_accepted_tokens => PUBLIC;
            get_config => PUBLIC;
            get_task_info => PUBLIC;
            get_task_balances => PUBLIC;
            get_forfeited_bond_amount => PUBLIC;
            get_entitlements => PUBLIC;
            get_bond_entitlements => PUBLIC;
            get_settlement_balances => PUBLIC;
        }
    }

    struct Escrow {
        // Config (set at instantiate, owner-mutable only via dedicated methods)
        accepted_tokens: KeyValueStore<ResourceAddress, AcceptedTokenConfig>,
        accepted_token_addresses: Vec<ResourceAddress>,

        worker_badge_resource: ResourceAddress,
        arbiter_badge_resource: ResourceAddress,
        agent_badge_resource: Option<ResourceAddress>,
        max_arbiter_fee_pct: Decimal,
        human_submit_deadline_secs: u64,
        agent_submit_deadline_secs: u64,
        dispute_auto_resolve_secs: u64,
        expire_grace_secs: u64,
        dispute_auto_resolve_default: AutoResolveDefault,
        min_insurance_fraction: Decimal,
        // Wave B W4: the bond is a PERCENTAGE of the task's reward, floored and
        // capped, denominated in the task's own reward token. It replaces a flat
        // `claim_bond_xrd`, which at XRD ~$0.0009 was worth about ONE CENT and
        // therefore deterred nothing — the mechanism existed on paper only.
        claim_bond_pct: Decimal,
        claim_bond_floor: Decimal,
        claim_bond_cap: Decimal,
        /// The share of a forfeited bond paid to whoever calls `expire_claim`.
        /// Proportional, not flat: the flat 1 XRD it replaces was worth about a
        /// TENTH OF A CENT, which is why nobody ever collected it in the 27
        /// hours one sat open on mainnet. That was a pricing failure, not a
        /// design failure — the mechanism is right, the number was inert.
        /// Flat is also actively wrong now: one unit of a stablecoin is $1,
        /// which on a $0.50 task exceeds the whole task.
        expire_bounty_pct: Decimal,
        /// Wave B W2: how long a poster has to review submitted work before
        /// ANYONE may finalize the release (`release_after_review_timeout`).
        /// Pinned onto the task at submit; this field only governs FUTURE
        /// submissions. Bounds 1–30d: a zero window would make every submit
        /// instantly releasable — the auto-on-delivery settlement mode is a
        /// separate future decision (intent-settlement design), not a value
        /// this dial may reach by accident.
        review_window_secs: u64,

        // Task storage
        tasks: KeyValueStore<u64, TaskInfo>,
        task_reward_vaults: KeyValueStore<u64, Vault>,
        task_insurance_vaults: KeyValueStore<u64, Vault>,
        task_claim_bond_vaults: KeyValueStore<u64, Vault>,
        // PULL: settled funds awaiting withdrawal. Funds move here at settlement
        // and leave only via withdraw_* against a credential.
        // See docs/design/escrow-pull-redesign.md §4.
        //
        // TWO lanes because a Vault holds ONE resource and a task holds two.
        // Both are created EAGERLY and RESOURCE-PINNED in create_task rather
        // than lazily from the first bucket credited: that way a mis-routed
        // credit fails on its FIRST put with a named resource error, instead of
        // silently defining the lane's resource and then blowing up on the
        // second put — at settlement, on a real user's transaction. The lazy
        // version is what shipped in phase 2 and is exactly how the reward
        // token and the XRD bond ended up in one vault.
        task_settlement_vaults: KeyValueStore<u64, Vault>,
        // The bond lane. Same RESOURCE as the reward lane since stage 5a (the
        // bond is denominated in task.reward_token), but a separate vault:
        // what a party is owed and what they staked are different facts, and
        // only the lane split still tells them apart.
        task_bond_settlement_vaults: KeyValueStore<u64, Vault>,
        next_task_id: u64,
        // Monotonic id for claim_receipts so a re-claim after expire / cancel
        // doesn't collide with the orphan receipt still in the previous
        // worker's wallet (resource manager rejects duplicate local_id mints).
        next_claim_receipt_id: u64,

        // Receipt resources (minted via internal minter badge)
        task_receipt_manager: NonFungibleResourceManager,
        claim_receipt_manager: NonFungibleResourceManager,
        internal_minter_vault: Vault,

        // The house's share of forfeited claim bonds accumulates here — after
        // DB-3 removed the heartbeat fee, `expire_claim`'s remainder (bond less
        // the caller bounty) is its ONLY source, so it stays empty until a
        // claim actually expires unworked.
        // Owner-claimable via withdraw_forfeited_bonds, which takes the
        // resource to drain.
        // W6a: a Vault holds ONE resource, and the bond's resource is now the
        // task's reward token, which varies per task. A single XRD vault cannot
        // hold non-XRD forfeitures, so this is keyed by resource.
        forfeited_claim_bonds_vaults: KeyValueStore<ResourceAddress, Vault>,
    }

    impl Escrow {
        /// Instantiate the escrow. Mints owner badge + royalty-admin badge +
        /// internal minter badge. Creates the task-receipt and claim-receipt
        /// non-fungible resources. Returns `(component, owner_badge,
        /// royalty_admin_badge)` — the deploy manifest must route BOTH badge
        /// buckets; they are separate authorities by design (DB-2).
        pub fn instantiate(
            worker_badge_resource: ResourceAddress,
            arbiter_badge_resource: ResourceAddress,
            agent_badge_resource: Option<ResourceAddress>,
            max_arbiter_fee_pct: Decimal,
            human_submit_deadline_secs: u64,
            agent_submit_deadline_secs: u64,
            dispute_auto_resolve_secs: u64,
            expire_grace_secs: u64,
            dispute_auto_resolve_default: AutoResolveDefault,
            min_insurance_fraction: Decimal,
            claim_bond_pct: Decimal,
            claim_bond_floor: Decimal,
            claim_bond_cap: Decimal,
            expire_bounty_pct: Decimal,
            review_window_secs: u64,
        ) -> (Global<Escrow>, Bucket, Bucket) {
            // Param validation
            assert!(
                max_arbiter_fee_pct >= Decimal::ZERO && max_arbiter_fee_pct <= dec!("0.5"),
                "max_arbiter_fee_pct must be in [0, 0.5]"
            );
            assert!(
                min_insurance_fraction >= Decimal::ZERO && min_insurance_fraction <= dec!("1"),
                "min_insurance_fraction must be in [0, 1]"
            );
            assert!(human_submit_deadline_secs > 0, "human_submit_deadline_secs must be positive");
            assert!(agent_submit_deadline_secs > 0, "agent_submit_deadline_secs must be positive");
            assert!(dispute_auto_resolve_secs > 0, "dispute_auto_resolve_secs must be positive");
            // D-P3: zero is a legitimate configuration (it restores the old
            // first-to-commit behaviour), so this is deliberately not `> 0`.
            // The default is 3600; the safety argument is the grace window's
            // existence at instantiation, not a runtime floor.
            assert!(
                expire_grace_secs <= 86_400,
                "expire_grace_secs must be at most 24h — a longer window strands the poster"
            );
            assert!(
                claim_bond_pct >= Decimal::ZERO && claim_bond_pct <= Decimal::ONE,
                "claim_bond_pct must be between 0 and 1"
            );
            assert!(claim_bond_floor >= Decimal::ZERO, "claim_bond_floor must be non-negative");
            assert!(
                claim_bond_cap >= claim_bond_floor,
                "claim_bond_cap must be >= claim_bond_floor"
            );
            assert!(
                expire_bounty_pct >= Decimal::ZERO && expire_bounty_pct <= Decimal::ONE,
                "expire_bounty_pct must be between 0 and 1"
            );
            assert!(
                (86_400..=2_592_000).contains(&review_window_secs),
                "review_window_secs must be between 1 and 30 days"
            );

            // Mint owner badge
            let owner_badge: Bucket = ResourceBuilder::new_fungible(OwnerRole::None)
                .divisibility(DIVISIBILITY_NONE)
                .metadata(metadata!(
                    init {
                        "name" => "Guild Marketplace Escrow Owner Badge", locked;
                        "description" => "Operator authority for token-whitelist + forfeited-bond withdrawal on guild-marketplace-escrow", locked;
                    }
                ))
                .mint_initial_supply(1)
                .into();
            let owner_badge_address = owner_badge.resource_address();

            // Mint royalty-admin badge — supply 1, returned beside the owner
            // badge. It holds ONLY the royalty dial + lock authority (DB-2,
            // sitting 2026-08-06): it can move the create_task royalty and lock
            // entries, and can NOT claim accrued royalties (the owner does).
            // Separate from the owner badge so the dial can live on a dedicated
            // seed without carrying token-whitelist or bond-withdrawal power.
            let royalty_admin_badge: Bucket = ResourceBuilder::new_fungible(OwnerRole::None)
                .divisibility(DIVISIBILITY_NONE)
                .metadata(metadata!(
                    init {
                        "name" => "Guild Marketplace Escrow Royalty Admin Badge", locked;
                        "description" => "Royalty dial + lock authority for guild-marketplace-escrow. Poster-side create_task royalty only; worker-leg entries are locked Free forever at instantiation.", locked;
                    }
                ))
                .mint_initial_supply(1)
                .into();
            let royalty_admin_address = royalty_admin_badge.resource_address();

            // Mint internal minter badge (held in component, authorizes receipt mint/burn)
            let internal_minter: Bucket = ResourceBuilder::new_fungible(OwnerRole::None)
                .divisibility(DIVISIBILITY_NONE)
                .metadata(metadata!(
                    init {
                        "name" => "Guild Marketplace Escrow Internal Minter", locked;
                    }
                ))
                .mint_initial_supply(1)
                .into();
            let internal_minter_address = internal_minter.resource_address();

            // Task receipt resource (one minted per create_task)
            let task_receipt_manager =
                ResourceBuilder::new_integer_non_fungible::<TaskReceiptData>(OwnerRole::Fixed(
                    rule!(require(owner_badge_address)),
                ))
                .metadata(metadata!(
                    init {
                        "name" => "Guild Marketplace Task Receipt", locked;
                        "description" => "Proves task ownership; required to cancel or approve a task", locked;
                    }
                ))
                .mint_roles(mint_roles!(
                    minter => rule!(require(internal_minter_address));
                    minter_updater => rule!(deny_all);
                ))
                .burn_roles(burn_roles!(
                    burner => rule!(require(internal_minter_address));
                    burner_updater => rule!(deny_all);
                ))
                .non_fungible_data_update_roles(non_fungible_data_update_roles!(
                    non_fungible_data_updater => rule!(deny_all);
                    non_fungible_data_updater_updater => rule!(deny_all);
                ))
                .create_with_no_initial_supply();

            // Claim receipt resource (one minted per claim_task, burned on submit)
            let claim_receipt_manager =
                ResourceBuilder::new_integer_non_fungible::<ClaimReceiptData>(OwnerRole::Fixed(
                    rule!(require(owner_badge_address)),
                ))
                .metadata(metadata!(
                    init {
                        "name" => "Guild Marketplace Claim Receipt", locked;
                        "description" => "Proves task claim; required to submit work", locked;
                    }
                ))
                .mint_roles(mint_roles!(
                    minter => rule!(require(internal_minter_address));
                    minter_updater => rule!(deny_all);
                ))
                .burn_roles(burn_roles!(
                    burner => rule!(require(internal_minter_address));
                    burner_updater => rule!(deny_all);
                ))
                .non_fungible_data_update_roles(non_fungible_data_update_roles!(
                    non_fungible_data_updater => rule!(deny_all);
                    non_fungible_data_updater_updater => rule!(deny_all);
                ))
                .create_with_no_initial_supply();

            let component = Self {
                accepted_tokens: KeyValueStore::new(),
                accepted_token_addresses: Vec::new(),
                worker_badge_resource,
                arbiter_badge_resource,
                agent_badge_resource,
                max_arbiter_fee_pct,
                human_submit_deadline_secs,
                agent_submit_deadline_secs,
                dispute_auto_resolve_secs,
                expire_grace_secs,
                dispute_auto_resolve_default,
                min_insurance_fraction,
                claim_bond_pct,
                claim_bond_floor,
                claim_bond_cap,
                expire_bounty_pct,
                review_window_secs,
                tasks: KeyValueStore::new(),
                task_reward_vaults: KeyValueStore::new(),
                task_insurance_vaults: KeyValueStore::new(),
                task_claim_bond_vaults: KeyValueStore::new(),
                task_settlement_vaults: KeyValueStore::new(),
                task_bond_settlement_vaults: KeyValueStore::new(),
                next_task_id: 1,
                next_claim_receipt_id: 1,
                task_receipt_manager,
                claim_receipt_manager,
                internal_minter_vault: Vault::with_bucket(internal_minter),
                forfeited_claim_bonds_vaults: KeyValueStore::new(),
            }
            .instantiate()
            // ── Wave B stage 2 (L5): Fixed → Updatable ──────────────────────
            //
            // WHY. The owner badge lives in a hot account today (TM-INT-1). The
            // real fix is moving it behind an AccessController — and with
            // `Fixed`, that move is impossible without another full component
            // swap. `Updatable` is what makes the custody fix reachable by a
            // signed transaction instead of a re-instantiation, which is the
            // same argument as the setters: structure now, so values and
            // arrangements stay changeable later.
            //
            // 🔴 THE TRADE-OFF, STATED PLAINLY — it is NOT a null security
            // delta, and an earlier analysis of mine called it one.
            // `Updatable` lets the owner REASSIGN ownership. So a compromised
            // owner badge can re-point the owner rule at itself and lock the
            // real operator out PERMANENTLY; under `Fixed`, recovering the badge
            // recovers control. That widens the blast radius of exactly the hot-
            // account risk this change exists to fix, for the window between
            // this swap and the AccessController actually being adopted.
            //
            // The trade is: accept a larger blast radius on badge compromise, in
            // exchange for the only cheap path to eliminating the hot-account
            // exposure entirely. That is a custody-philosophy call over
            // whole-component authority, and it was bigdev's to make.
            // ✅ RULED 2026-08-30 (operator): UPDATABLE STANDS. The trade-off
            // above was accepted with the ruling, not overlooked — keep this
            // block so the acceptance stays legible to the audit. The follow-on
            // obligation it creates is the AccessController adoption itself
            // (the key-rotation directive), which closes the widened window.
            .prepare_to_globalize(OwnerRole::Updatable(rule!(require(
                owner_badge_address
            ))))
            // ── Component royalties — the Shape-B revenue dial (DB-2, sitting
            // 2026-08-06). Module ATTACHMENT is write-once at globalization; the
            // amounts are not: `create_task` is the single `updatable` entry
            // (poster-side dial, 0 at launch), movable via SET_COMPONENT_ROYALTY
            // under `royalty_setter`. Every other method is `Free, locked` —
            // locking is permanent, so "workers pay 0, forever" (claim_task /
            // submit_task / withdraw_worker) is chain-enforced rather than copy.
            // Exhaustiveness is COMPILER-enforced: this macro expands to a
            // struct literal over every blueprint method, so removing a row is
            // E0063, not a runtime gap (measured 2026-08-09 by removing one).
            // What the compiler does NOT enforce — and the source-scrape test
            // pins — is that create_task stays the ONLY `updatable` entry and
            // the worker legs stay `locked`: engine `set_royalty` will write any
            // UNLOCKED entry (radix-engine 1.3.1 royalty/package.rs:360-380). [cite-exempt: another crate, pinned by version]
            // Protocol ceiling per call: MAX_PER_FUNCTION_ROYALTY_IN_XRD =
            // 166.666… XRD (10 protocol-USD).
            .enable_component_royalties(component_royalties! {
                roles {
                    royalty_setter => rule!(require(royalty_admin_address));
                    royalty_setter_updater => rule!(deny_all);
                    royalty_locker => rule!(require(royalty_admin_address));
                    royalty_locker_updater => rule!(deny_all);
                    royalty_claimer => rule!(require(owner_badge_address));
                    royalty_claimer_updater => rule!(deny_all);
                },
                init {
                    // The dial. Poster-side only, 0 at launch, updatable (DB-2).
                    create_task => Xrd(Decimal::ZERO), updatable;
                    // Owner-gated configuration — never dialed.
                    add_accepted_token => Free, locked;
                    remove_accepted_token => Free, locked;
                    freeze_token => Free, locked;
                    unfreeze_token => Free, locked;
                    withdraw_forfeited_bonds => Free, locked;
                    // Wave B tuning setters. Free AND LOCKED: a royalty on
                    // config would let a future dial tax the operator for
                    // correcting a parameter, which is the opposite of the
                    // "make it easy to set" ruling these exist to serve.
                    set_dispute_auto_resolve_default => Free, locked;
                    set_dispute_auto_resolve_secs => Free, locked;
                    set_human_submit_deadline_secs => Free, locked;
                    set_agent_submit_deadline_secs => Free, locked;
                    set_min_insurance_fraction => Free, locked;
                    set_max_arbiter_fee_pct => Free, locked;
                    set_expire_grace_secs => Free, locked;
                    set_claim_bond_params => Free, locked;
                    set_expire_bounty_pct => Free, locked;
                    set_review_window_secs => Free, locked;
                    // Task lifecycle — the worker legs here are the on-ledger
                    // "workers pay 0, forever" promise.
                    cancel_task => Free, locked;
                    claim_task => Free, locked;
                    expire_claim => Free, locked;
                    cancel_task_by_poster_after_claim => Free, locked;
                    submit_task => Free, locked;
                    approve_and_release => Free, locked;
                    // A royalty here would tax the worker's escape from a
                    // silent poster. Locked Free like the other worker legs.
                    release_after_review_timeout => Free, locked;
                    raise_dispute => Free, locked;
                    resolve_dispute => Free, locked;
                    auto_resolve_dispute => Free, locked;
                    // PULL withdrawals — a royalty here would tax taking your
                    // own money. Locked Free.
                    withdraw_worker => Free, locked;
                    withdraw_poster => Free, locked;
                    burn_task_receipt => Free, locked;
                    // A royalty here would tax rescuing someone else's
                    // stranded money. Locked Free.
                    push_entitlement => Free, locked;
                    // Public views.
                    get_accepted_tokens => Free, locked;
                    get_config => Free, locked;
                    get_task_info => Free, locked;
                    get_task_balances => Free, locked;
                    get_forfeited_bond_amount => Free, locked;
                    get_entitlements => Free, locked;
                    get_bond_entitlements => Free, locked;
                    get_settlement_balances => Free, locked;
                }
            })
            .globalize();

            Runtime::emit_event(EscrowInstantiatedEvent {
                owner_badge_resource: owner_badge_address,
                royalty_admin_badge_resource: royalty_admin_address,
                worker_badge_resource,
                arbiter_badge_resource,
                agent_badge_resource,
            });

            (component, owner_badge, royalty_admin_badge)
        }

        // ── Owner-only config ────────────────────────────────────────────────

        /// Whitelist a reward token.
        ///
        /// 🔴 DIVISIBILITY IS A SAFETY GATE, NOT A FORMATTING DETAIL. Settlement
        /// paths that SPLIT — `credit_split_for_parties`, reached by
        /// `resolve_dispute` and `auto_resolve_dispute` — compute a percentage
        /// and then call `Vault::take()` with the result. If that amount is not
        /// representable at the token's divisibility, the call PANICS, and it
        /// panics on the dispute path, i.e. exactly when two parties are already
        /// in conflict over money. A dispute that cannot be resolved is the
        /// worst state this component has.
        ///
        /// The `take_all()` paths (`approve_and_release`,
        /// `cancel_task_by_poster_after_claim`) are unaffected — they move whole
        /// balances and never compute a share.
        ///
        /// ⚠️ THE FIX IS ROUNDING, NOT EXCLUSION — and the first draft of this
        /// guard got it backwards. Rejecting tokens below 18dp would reject
        /// **every USD-pegged token on Radix worth using**: measured
        /// 2026-08-29, xUSDC, hUSDC and hUSDT are all divisibility 6, and the
        /// only 18dp candidate (fUSD) is backed by XRD+LSULP and so carries the
        /// very exposure a stablecoin exists to remove. A guard that bans the
        /// entire candidate set is not a safety feature.
        ///
        /// So the panic is fixed where it happens — `credit_split_for_parties`
        /// now rounds the worker's share DOWN to the token's divisibility before
        /// taking it, which also preserves the existing dust property (the
        /// truncated remainder lands in the poster's share, never stranded).
        /// All this method needs to enforce is that the resource is fungible and
        /// divisible enough to express the per-token minimum at all.
        pub fn add_accepted_token(&mut self, resource: ResourceAddress, min_amount: Decimal) {
            assert!(min_amount >= Decimal::ZERO, "min_amount must be non-negative");
            assert!(self.accepted_tokens.get(&resource).is_none(), "token already whitelisted");
            let divisibility = Self::token_divisibility(resource);
            // A divisibility-0 token cannot express a split of an odd amount at
            // all: every share rounds to a whole unit and a 1-unit reward in a
            // 50/50 dispute pays the worker nothing. Reject the degenerate case
            // rather than discovering it in a live dispute.
            assert!(divisibility > 0, "reward token must be divisible");
            self.accepted_tokens.insert(resource, AcceptedTokenConfig { min_amount, frozen: false });
            self.accepted_token_addresses.push(resource);
            Runtime::emit_event(TokenWhitelistedEvent { resource, min_amount });
        }

        pub fn remove_accepted_token(&mut self, resource: ResourceAddress) {
            assert!(self.accepted_tokens.get(&resource).is_some(), "token not in whitelist");
            // Operator should freeze first, let in-flight tasks terminate, then remove.
            self.accepted_tokens.remove(&resource);
            self.accepted_token_addresses.retain(|r| r != &resource);
            Runtime::emit_event(TokenRemovedEvent { resource });
        }

        pub fn freeze_token(&mut self, resource: ResourceAddress) {
            let mut cfg = self.accepted_tokens.get_mut(&resource).expect("token not in whitelist");
            cfg.frozen = true;
            Runtime::emit_event(TokenFrozenEvent { resource });
        }

        pub fn unfreeze_token(&mut self, resource: ResourceAddress) {
            let mut cfg = self.accepted_tokens.get_mut(&resource).expect("token not in whitelist");
            cfg.frozen = false;
            Runtime::emit_event(TokenUnfrozenEvent { resource });
        }

        // ── Owner-gated setters (Wave B) ─────────────────────────────────────
        //
        // 🔑 WHY THESE EXIST. Before Wave B this component had ZERO setters:
        // every parameter was write-once at `instantiate`. That is why adjusting
        // a claim bond cost a full component swap — re-instantiate, migrate,
        // repoint the app — and why the last swap produced the collision-numbered
        // `on_chain_task_id` mess that migration 0010 exists to clean up.
        //
        // Operator ruling 2026-08-29: *"These figures are all made up for
        // testing… the average task $ will be free market, user-set — let's not
        // focus on this, just make it easy to set."* The consequence is a sorting
        // rule for everything this component holds: STRUCTURAL things (vaults,
        // resources, methods, invariants) can only change by redeploying, so they
        // must ride a swap; TUNABLE VALUES ship as placeholders and are corrected
        // by one signed owner transaction. These setters are what make that true.
        //
        // Every setter re-applies the SAME validation `instantiate` applies, so a
        // later tune can never reach a state a fresh deploy would have rejected.
        // None of them touches a vault, a task, or a settlement — they are pure
        // config writes, which is what keeps them out of the audit's hot path.
        //
        // ⚠️ NON-RETROACTIVITY IS A PROPERTY OF THE STATE SHAPE, NOT OF THESE
        // METHODS — and this comment asserted it before it was true.
        //
        // It originally read "these are deliberately NOT retro-active; a task
        // carries its own deadline and bond, captured at create/claim". That was
        // right about the bond and the claim deadline and WRONG about disputes:
        // `auto_resolve_dispute` read both the window and the DEFAULT RULING
        // live from config at settlement time, so an owner could change the
        // outcome of a dispute that was already running. Fixed by pinning both
        // onto the task at `raise_dispute`.
        //
        // The rule to hold when adding any future setter: a value that some
        // lifecycle method reads LIVE is retroactive by construction, whatever a
        // comment here says. Before making something settable, find every read
        // of it — if a read happens after the user committed, pin the value onto
        // the task at the moment they committed instead.
        //
        // Known and accepted, and this list is meant to be EXHAUSTIVE — if you
        // add a live-read setter, add it here in the same change:
        //
        // 1. `expire_grace_secs`, read live in `expire_claim`. It shifts a
        //    deadline by an hour and cannot change who is paid, so it is a
        //    timing nuisance rather than a settlement change — but it IS the
        //    same class, and it is listed here rather than left for someone to
        //    rediscover.
        //
        // 2. `expire_bounty_pct`, read live in `expire_claim` (the
        //    `forfeited_amount * self.expire_bounty_pct` bounty split). Added to
        //    this list 2026-09-01 after a review flagged its absence: unlike (1)
        //    it DOES move money, so it deserves the argument spelled out rather
        //    than the silence it had.
        //
        //    It is accepted, not pinned, because it cannot change what any
        //    COMMITTED party receives — which is the actual test the rule above
        //    states, and it is worth being precise about who is committed here:
        //      • The worker committed at `claim_task`. Their exposure is
        //        `take_all()` on the bond vault — a TOTAL forfeit at every value
        //        of this pct. Tuning it cannot make them lose more or less.
        //      • The poster is not a party to this split at all (DB-4 removed the
        //        poster credit precisely because it was farmable).
        //      • The bounty caller is not committed until they call, and they
        //        read the live value in their own transaction. For them a live
        //        read is CORRECT; a value pinned at some earlier worker's claim
        //        would be the surprising one.
        //    So the split is caller-vs-house only, and pinning it onto the task
        //    would import a stale rate rather than remove a retroactivity. If a
        //    future change ever makes the worker's forfeit partial, this entry
        //    stops being true and the value must be pinned at claim.

        /// The bond parameters, settable now that the fields exist. Deferred
        /// from stage 1 deliberately so field and setter would be reviewed in
        /// the same change rather than leaving an untestable method behind.
        ///
        /// ⚠️ NOT retroactive, and that is enforced by the state shape rather
        /// than by this comment: `claim_task` PINS `task.claim_bond_amount` at
        /// claim time and every settlement path reads the pin. A later tune
        /// cannot change what a worker already posted or gets back. This is the
        /// discipline the dispute-terms bug taught — find every read before
        /// making a value settable.
        pub fn set_claim_bond_params(
            &mut self,
            claim_bond_pct: Decimal,
            claim_bond_floor: Decimal,
            claim_bond_cap: Decimal,
        ) {
            assert!(
                claim_bond_pct >= Decimal::ZERO && claim_bond_pct <= Decimal::ONE,
                "claim_bond_pct must be between 0 and 1"
            );
            assert!(claim_bond_floor >= Decimal::ZERO, "claim_bond_floor must be non-negative");
            assert!(
                claim_bond_cap >= claim_bond_floor,
                "claim_bond_cap must be >= claim_bond_floor"
            );
            self.claim_bond_pct = claim_bond_pct;
            self.claim_bond_floor = claim_bond_floor;
            self.claim_bond_cap = claim_bond_cap;
            Runtime::emit_event(ClaimBondParamsUpdatedEvent {
                claim_bond_pct,
                claim_bond_floor,
                claim_bond_cap,
            });
        }

        pub fn set_expire_bounty_pct(&mut self, pct: Decimal) {
            assert!(
                pct >= Decimal::ZERO && pct <= Decimal::ONE,
                "expire_bounty_pct must be between 0 and 1"
            );
            self.expire_bounty_pct = pct;
            Runtime::emit_event(ExpireBountyPctUpdatedEvent { pct });
        }

        /// W2 (stage 6). Governs FUTURE submissions only — the deadline is
        /// pinned onto the task at submit_task, so tuning this never moves a
        /// review a poster is already inside. Same bounds as instantiate.
        pub fn set_review_window_secs(&mut self, secs: u64) {
            assert!(
                (86_400..=2_592_000).contains(&secs),
                "review_window_secs must be between 1 and 30 days"
            );
            self.review_window_secs = secs;
            Runtime::emit_event(ReviewWindowSecsUpdatedEvent { secs });
        }

        // ⚠️ Historical note kept: this block previously explained why
        // Those fields do not exist yet — the bond is still the write-once
        // `claim_bond_xrd`. Proportional bond sizing arrives with the bond flip
        // (Stage 5), which is the conservation-invariant work, and its setter
        // ships in that same change so the field and its setter are always
        // reviewed together. Adding a setter here for a field introduced two
        // stages later would put an untestable method in the isolated stage.

        pub fn set_dispute_auto_resolve_default(&mut self, default: AutoResolveDefault) {
            self.dispute_auto_resolve_default = default.clone();
            Runtime::emit_event(DisputeAutoResolveDefaultUpdatedEvent { default });
        }

        pub fn set_dispute_auto_resolve_secs(&mut self, secs: u64) {
            assert!(secs > 0, "dispute_auto_resolve_secs must be positive");
            self.dispute_auto_resolve_secs = secs;
            Runtime::emit_event(DisputeAutoResolveSecsUpdatedEvent { secs });
        }

        // ⚠️ These were ONE method, `set_submit_deadlines(human, agent)`, until
        // a sheet-conformance test rejected it: the sheet lists these as two
        // rows and the convention is `set_<arg>`, so a combined setter reads as
        // undisclosed. Splitting was the right resolution rather than teaching
        // the gate an exception — and it is better anyway. A combined setter
        // means you cannot tune one deadline without restating the other, which
        // is the opposite of "make it easy to set".
        pub fn set_human_submit_deadline_secs(&mut self, secs: u64) {
            assert!(secs > 0, "human_submit_deadline_secs must be positive");
            self.human_submit_deadline_secs = secs;
            Runtime::emit_event(HumanSubmitDeadlineUpdatedEvent { secs });
        }

        pub fn set_agent_submit_deadline_secs(&mut self, secs: u64) {
            assert!(secs > 0, "agent_submit_deadline_secs must be positive");
            self.agent_submit_deadline_secs = secs;
            Runtime::emit_event(AgentSubmitDeadlineUpdatedEvent { secs });
        }

        pub fn set_min_insurance_fraction(&mut self, fraction: Decimal) {
            assert!(
                fraction >= Decimal::ZERO && fraction <= Decimal::ONE,
                "min_insurance_fraction must be between 0 and 1"
            );
            self.min_insurance_fraction = fraction;
            Runtime::emit_event(MinInsuranceFractionUpdatedEvent { fraction });
        }

        pub fn set_max_arbiter_fee_pct(&mut self, pct: Decimal) {
            assert!(
                pct >= Decimal::ZERO && pct <= Decimal::ONE,
                "max_arbiter_fee_pct must be between 0 and 1"
            );
            self.max_arbiter_fee_pct = pct;
            Runtime::emit_event(MaxArbiterFeePctUpdatedEvent { pct });
        }

        pub fn set_expire_grace_secs(&mut self, secs: u64) {
            self.expire_grace_secs = secs;
            Runtime::emit_event(ExpireGraceSecsUpdatedEvent { secs });
        }

        pub fn withdraw_forfeited_bonds(&mut self, resource: ResourceAddress) -> Bucket {
            let mut vault = self
                .forfeited_claim_bonds_vaults
                .get_mut(&resource)
                .expect("no forfeited bonds in that resource");
            let amount = vault.amount();
            let bucket = vault.take_all();
            drop(vault);
            Runtime::emit_event(ForfeitedBondsWithdrawnEvent { resource, amount });
            bucket
        }

        // ── Task lifecycle ───────────────────────────────────────────────────

        /// Create a task. Returns the poster-receipt NFT as a Bucket.
        ///
        /// Reward + insurance MUST be the same resource (Q1 design decision —
        /// avoids cross-token rate questions). Insurance must be at least
        /// `min_insurance_fraction * reward`. arbiter_fee_pct must be ≤
        /// max_arbiter_fee_pct.
        pub fn create_task(
            &mut self,
            poster: ComponentAddress,
            reward: Bucket,
            insurance: Bucket,
            arbiter_fee_pct: Decimal,
            work_brief_hash: Hash,
        ) -> Bucket {
            let reward_token = reward.resource_address();
            assert_eq!(
                insurance.resource_address(),
                reward_token,
                "insurance must be in the same token as reward"
            );

            // Whitelist check
            let token_cfg = self
                .accepted_tokens
                .get(&reward_token)
                .expect("reward token not in whitelist");
            assert!(!token_cfg.frozen, "reward token is frozen; no new tasks");
            let min_amount = token_cfg.min_amount;
            drop(token_cfg);

            let reward_amount = reward.amount();
            let insurance_amount = insurance.amount();
            assert!(reward_amount >= min_amount, "reward below per-token minimum");

            // Insurance fraction check
            let required_insurance = reward_amount * self.min_insurance_fraction;
            assert!(
                insurance_amount >= required_insurance,
                "insurance below min_insurance_fraction of reward"
            );

            // Arbiter fee bounds
            assert!(
                arbiter_fee_pct >= Decimal::ZERO && arbiter_fee_pct <= self.max_arbiter_fee_pct,
                "arbiter_fee_pct out of allowed range [0, max_arbiter_fee_pct]"
            );

            // PAYEE PIN (poster side). Every poster-side withdrawal deposits
            // here, so this MUST be an account: a non-account address would make
            // `withdraw_poster` permanently unfulfillable — the entitlement
            // recorded, `assert_conservation` holding, and the money never coming
            // out. Failing at pin time puts the error in the designator's own
            // transaction, where they can still fix it.
            //
            // A caller-supplied payee is safe in a way a caller-supplied GATE is
            // not: `create_task` consumes the poster's reward and insurance in the
            // same call that reads `poster`, so a wrong value can only misdirect
            // the designator's OWN refund. Contrast M5, where the same
            // free-parameter-ness defeats the self-claim gate below.
            assert!(
                poster
                    .as_node_id()
                    .entity_type()
                    .is_some_and(|t| t.is_global_account()),
                "poster must be a global account address"
            );

            let task_id = self.next_task_id;
            self.next_task_id = self.next_task_id.checked_add(1).expect("task_id overflow");

            // Poster identity captured from caller — verified via
            // task_receipt ownership on cancel/approve paths.
            let created_at = Clock::current_time_rounded_to_seconds();

            // Take funds into per-task vaults
            self.task_reward_vaults.insert(task_id, Vault::with_bucket(reward));
            self.task_insurance_vaults.insert(task_id, Vault::with_bucket(insurance));

            // PULL settlement lanes, created empty and RESOURCE-PINNED here.
            // Pinning at creation is what makes a mis-routed credit fail loudly
            // and immediately: a bond bucket sent to the reward lane now hits a
            // vault that is already typed to `reward_token` and errors on the
            // first put, rather than defining the lane's resource by accident.
            // It also means the lanes always exist, so no withdrawal has to
            // reason about an absent vault — which is its own fund-lock risk on
            // the expire path, where the bond lane is credited and the reward
            // lane never is.
            self.task_settlement_vaults
                .insert(task_id, Vault::new(reward_token));
            // W4: the bond lane now holds the SAME token as the reward lane.
            // Still two vaults, because a settlement can award both at once and
            // the two entitlements must stay separately accounted — see the
            // TWO LANES note at the top of this file. Same resource, different
            // lanes; that is deliberate, not redundant.
            self.task_bond_settlement_vaults
                .insert(task_id, Vault::new(reward_token));

            let info = TaskInfo {
                poster,
                reward_token,
                reward_amount,
                insurance_amount,
                arbiter_fee_pct,
                work_brief_hash,
                created_at,
                state: TaskState::Open,
                claimer_badge_id: None,
                claim_deadline: None,
                claim_bond_amount: None,
                claimer_is_agent: false,
                submit_evidence_hash: None,
                submitted_at: None,
                review_deadline: None,
                current_claim_receipt_id: None,
                worker_account: None,
                disputed_at: None,
                dispute_raised_by: None,
                dispute_evidence_hash: None,
                // Pinned at raise_dispute, not here — a task that is never
                // disputed never acquires dispute terms.
                dispute_auto_resolve_secs: None,
                dispute_auto_resolve_default: None,
                worker_entitled: Decimal::ZERO,
                poster_entitled: Decimal::ZERO,
                worker_bond_entitled: Decimal::ZERO,
                poster_bond_entitled: Decimal::ZERO,
            };
            let poster_addr = info.poster;
            self.tasks.insert(task_id, info);

            // Mint the poster receipt
            let receipt: Bucket = self.internal_minter_vault.as_fungible().authorize_with_amount(
                dec!("1"),
                || {
                    self.task_receipt_manager.mint_non_fungible(
                        &NonFungibleLocalId::integer(task_id),
                        TaskReceiptData { task_id, poster: poster_addr },
                    )
                },
            ).into();

            Runtime::emit_event(TaskCreatedEvent {
                task_id,
                poster: poster_addr,
                reward_token,
                reward_amount,
                insurance_amount,
                arbiter_fee_pct,
                work_brief_hash,
            });

            receipt
        }

        /// Cancel an open (unclaimed) task. PULL: credits reward + insurance to
        /// the POSTER; returns nothing. Proof auth — only the receipt holder can
        /// cancel, and the receipt is NOT burned because they still need it to
        /// withdraw. Retire it with `burn_task_receipt` afterwards.
        ///
        /// **Converted per D-P1, reversing the spec's own first recommendation.**
        /// That recommendation weighed diff size against *today's* threat model,
        /// under which this method is safe: the caller has proven custody of the
        /// receipt that entitles them, so caller and payee are the same party —
        /// the same argument that correctly leaves `submit_task` alone.
        ///
        /// What breaks that argument is the roadmap, not the present. Audit §245
        /// already found "poster can drain the donor pool via `cancel_task`" as a
        /// CRITICAL for **community-funded tasks**, the next planned feature:
        /// once third parties contribute to a task's reward, the receipt holder
        /// is no longer the sole payee, and "caller == payee" silently stops
        /// being true while the code still assumes it. Converting now means that
        /// feature lands on a method that is already correct, instead of
        /// requiring a second money-path migration to fix.
        ///
        /// ⚠️ `submit_task` stays unconverted — but revisit it if sponsored or
        /// gasless claims land: a sponsor-posted bond must return to the SPONSOR,
        /// not to whoever holds the claim receipt. That is the same class of bug,
        /// one feature further out.
        pub fn cancel_task(&mut self, receipt: Proof) {
            assert_eq!(
                receipt.resource_address(),
                self.task_receipt_manager.address(),
                "wrong receipt resource"
            );

            // Safe to skip_checking: the resource address was just asserted.
            let local_id = receipt
                .skip_checking()
                .as_non_fungible()
                .non_fungible_local_id();
            let task_id = match &local_id {
                NonFungibleLocalId::Integer(i) => i.value() as u64,
                _ => Runtime::panic("receipt has non-integer local id".to_string()),
            };

            // Verify task exists + state
            {
                let mut task = self.tasks.get_mut(&task_id).expect("task not found");
                assert_eq!(task.state, TaskState::Open, "task must be Open to cancel");
                task.state = TaskState::Refunded;
            }

            // Drain vaults into the poster's entitlement
            let reward = self.task_reward_vaults.get_mut(&task_id).unwrap().take_all();
            let insurance = self.task_insurance_vaults.get_mut(&task_id).unwrap().take_all();

            self.credit_entitlement(task_id, EntitledParty::Poster, reward);
            self.credit_entitlement(task_id, EntitledParty::Poster, insurance);

            Runtime::emit_event(TaskCancelledEvent { task_id });
            self.emit_settlement_credited(task_id);
        }

        /// Claim a task. Takes a worker_badge Proof (NOT bucket-burn — guild
        /// membership badges are long-lived per SCRYPTO-AUTH-CONVENTION.md
        /// "when you can't burn"). claim_bond is held until submit. Returns the
        /// claim-receipt NFT.
        ///
        /// AUTH: Pattern 2 (Proof-based) — residual proof-replay risk is
        /// mitigated by the badge having to be re-presented for any subsequent
        /// task lifecycle action; agent badges also have their own recall
        /// kill-switch via the agent-badge-controller blueprint.
        pub fn claim_task(
            &mut self,
            task_id: u64,
            worker: ComponentAddress,
            worker_badge: Proof,
            claim_bond: Bucket,
        ) -> Bucket {
            // Auth: worker_badge must be from the configured worker or agent resource
            let badge_resource = worker_badge.resource_address();
            let is_agent = if let Some(agent_res) = self.agent_badge_resource {
                badge_resource == agent_res
            } else {
                false
            };
            if !is_agent {
                assert_eq!(
                    badge_resource, self.worker_badge_resource,
                    "worker_badge is neither a worker nor an agent badge"
                );
            }

            // Snapshot the claimer badge id (for ownership tracking)
            let claimer_badge_id = worker_badge
                .skip_checking()
                .as_non_fungible()
                .non_fungible_local_id();

            // PAYEE PIN (worker side). Same reasoning as `create_task`: every
            // worker-side withdrawal deposits here, and the claimer names the
            // account in the same call that consumes their own bond, so a wrong
            // value can only misdirect their own money.
            assert!(
                worker
                    .as_node_id()
                    .entity_type()
                    .is_some_and(|t| t.is_global_account()),
                "worker must be a global account address"
            );

            // ── The bond: same token as the reward, proportional to it ──────
            //
            // W4-mech. Denominating the bond in `task.reward_token` is what
            // dissolves the oracle problem: `bond = pct * reward` is then plain
            // same-resource arithmetic, on-chain, with no price feed anywhere.
            // A bond pinned to XRD while the reward is a stablecoin would need a
            // rate to compare them, and this blueprint has no oracle by design.
            let required_bond = {
                let task = self.tasks.get(&task_id).expect("task not found");
                assert_eq!(
                    claim_bond.resource_address(),
                    task.reward_token,
                    "claim_bond must be the task's reward token"
                );
                Self::required_bond(
                    task.reward_amount,
                    self.claim_bond_pct,
                    self.claim_bond_floor,
                    self.claim_bond_cap,
                    Self::token_divisibility(task.reward_token),
                )
            };
            assert_eq!(
                claim_bond.amount(),
                required_bond,
                "claim_bond amount does not match required"
            );

            // Verify state
            let mut task = self.tasks.get_mut(&task_id).expect("task not found");
            task.claim_bond_amount = Some(required_bond);
            assert_eq!(task.state, TaskState::Open, "task must be Open to claim");

            // Self-claim gate: the payout account may not be the poster's
            // account. This kills the naive one-account poster→worker loop that
            // gamed ledger-derived reputation, and the assert below is real —
            // proven to fire by test_self_claim_rejects.
            //
            // ⚠️ CORRECTED 2026-07-31. The previous comment here read "one person
            // with two accounts still needs a second operator-minted badge —
            // badge scarcity is the sybil gate." BOTH halves are false, and this
            // comment was read as ground truth by an agent and republished to
            // users in PR #268. Do not restore that wording.
            //   • Badges are NOT operator-minted. The Guild Member badge is
            //     PUBLIC-MINT: the manifest calls `public_mint` with a username
            //     and presents no proof and no badge. Cost is the network fee.
            //   • Badge scarcity is therefore NOT a sybil gate, and this assert
            //     is not one either: `poster` is a FREE PARAMETER of create_task
            //     and the `self-claim not allowed` assert immediately below is
            //     the ONLY place it is ever read for enforcement, so a decoy
            //     poster address disables the gate at zero cost (M5, Wave-B).
            //     (Named, not numbered, deliberately: this reference has been
            //     wrong twice — :711 → :727 → :935 — [cite-exempt: the incident record itself] because every edit to this
            //     file moves it. A line number in a comment is a fact with an
            //     expiry date.)
            // What this assert actually buys is an honest-mistake guard, not a
            // sybil defence. Do not cite it as one. See docs/PROJECT-STATE.md,
            // 2026-07-31 triage block.
            assert!(
                worker != task.poster,
                "self-claim not allowed: worker account must differ from poster"
            );

            // Compute deadline (enforced by expire_claim)
            let now = Clock::current_time_rounded_to_seconds();
            let deadline_secs = if is_agent {
                self.agent_submit_deadline_secs
            } else {
                self.human_submit_deadline_secs
            };
            let claim_deadline = Instant::new(
                now.seconds_since_unix_epoch
                    .checked_add(deadline_secs as i64)
                    .expect("claim deadline overflow"),
            );

            // Reserve a fresh claim_receipt id so a re-claim after expire
            // doesn't collide with an orphan still in the previous worker's
            // wallet.
            let claim_receipt_id = self.next_claim_receipt_id;
            self.next_claim_receipt_id = self
                .next_claim_receipt_id
                .checked_add(1)
                .expect("next_claim_receipt_id overflow");

            // Worker identity captured from caller — used by resolve_dispute
            // and auto_resolve_dispute to pay the worker after receipt burn.
            let worker_addr_for_task = worker;

            task.state = TaskState::Claimed;
            task.claimer_badge_id = Some(claimer_badge_id.clone());
            task.claim_deadline = Some(claim_deadline);
            task.claimer_is_agent = is_agent;
            task.current_claim_receipt_id = Some(claim_receipt_id);
            task.worker_account = Some(worker_addr_for_task);
            drop(task);

            // Take claim bond into per-task vault. Re-claim path replaces the
            // empty vault left by expire_claim.
            if self.task_claim_bond_vaults.get(&task_id).is_some() {
                self.task_claim_bond_vaults
                    .get_mut(&task_id)
                    .unwrap()
                    .put(claim_bond);
            } else {
                self.task_claim_bond_vaults
                    .insert(task_id, Vault::with_bucket(claim_bond));
            }

            // Mint the claim receipt
            let claim_receipt: Bucket = self
                .internal_minter_vault
                .as_fungible()
                .authorize_with_amount(dec!("1"), || {
                    self.claim_receipt_manager.mint_non_fungible(
                        &NonFungibleLocalId::integer(claim_receipt_id),
                        ClaimReceiptData {
                            task_id,
                            worker: worker_addr_for_task,
                            is_agent,
                        },
                    )
                })
                .into();

            Runtime::emit_event(TaskClaimedEvent {
                task_id,
                claimer_badge_id,
                is_agent,
                claim_deadline,
            });

            claim_receipt
        }

        // DB-3 (sitting 2026-08-06) removed `heartbeat` — the worker-pays-to-
        // keep-working leg. It charged `heartbeat_fee_xrd` out of the per-task
        // claim_bond vault, which at the live parameters (bond 10 / fee 5) made
        // one 24h extension cost half the bond and two burn it outright, with
        // nothing returned at submit. The cost never showed as an outflow from
        // the worker's own account, so an unattended agent could not see it.
        // No benchmark makes workers sign to keep working (D6/§5). A worker who
        // needs longer now negotiates off-chain and the poster re-posts, or the
        // deadline lapses into `expire_claim` below.

        /// Public — after a claim's deadline + grace has passed, anyone may
        /// call this to expire the claim. The forfeited claim_bond SPLITS
        /// (DB-4, sitting 2026-08-06): an `expire_bounty_pct` share of the bond
        /// is RETURNED to the caller, in the bond's own resource — the method
        /// is PUBLIC and someone must be paid to call it; the keeper is
        /// watch-only by decision — and the remainder goes to the operator's
        /// forfeited vault. NEVER the poster: crediting the
        /// poster pays them to author unsatisfiable briefs and farm the bond
        /// of every stranger who claims (the shape this replaces). The task
        /// returns to Open so a different worker can claim; reward + insurance
        /// stay locked in escrow. The orphan claim_receipt in the previous
        /// worker's wallet remains but is invalidated by
        /// current_claim_receipt_id being reset.
        ///
        /// The bounty bucket is the ONE deliberate return-to-caller in the
        /// PULL design: it is the caller's own earned fee, a fraction of the
        /// bond it is taken from and so never larger than it — not another
        /// party's settlement routed through them, which is the BUG-7 class
        /// PULL removed.
        /// Reopen a task whose claim deadline has passed, forfeiting the bond.
        /// PUBLIC — anyone may call, which is what makes the grace window
        /// necessary rather than merely nice.
        ///
        /// **D-P3 — the late-submit race (L3).** `submit_task` has no deadline
        /// check, so from `deadline + 1s` both a late `submit_task` and this
        /// method were valid and it was first-to-commit: the worker got their
        /// bond back, or **any bystander forfeited it for the price of gas**,
        /// with no badge or stake required. Requiring `now >= deadline +
        /// expire_grace_secs` converts that race into a window only the worker
        /// can act in. `submit_task` is deliberately left unchanged — the fix
        /// belongs on the permissionless method, not the authenticated one.
        ///
        /// **⚠️ D-P4 — SUPERSEDED by DB-4 (sitting 2026-08-06). Kept because it
        /// is the record of a reasoning error, not just an old rule.** D-P4
        /// routed the forfeited bond to the POSTER rather than the house, on
        /// the grounds that "profiting when a worker misses a deadline is the
        /// wrong incentive to bake into a marketplace we operate". It then
        /// dismissed the obvious objection — that this pays posters to engineer
        /// expiries — by arguing a poster has "no lever" because submission is
        /// permissionless for the claimer. **That argument was wrong.** A
        /// poster does not need a lever over any individual claim: they need
        /// only author briefs nobody can satisfy in time and collect a bond
        /// from every stranger who tries. Volume is the lever. The behaviour
        /// above is what actually ships: an `expire_bounty_pct` slice of the
        /// bond to whoever calls this, remainder to the house, and **nothing
        /// to the poster, ever** — asserted directly by
        /// `test_expired_bond_leaves_the_poster_nothing_to_withdraw`.
        pub fn expire_claim(&mut self, task_id: u64) -> Bucket {
            let grace = self.expire_grace_secs;
            {
                let mut task = self.tasks.get_mut(&task_id).expect("task not found");
                assert_eq!(task.state, TaskState::Claimed, "task must be Claimed to expire");

                let now = Clock::current_time_rounded_to_seconds();
                let deadline = task.claim_deadline.expect("Claimed must have deadline");
                assert!(
                    now.seconds_since_unix_epoch
                        >= deadline
                            .seconds_since_unix_epoch
                            .checked_add(grace as i64)
                            .expect("expire grace window overflow"),
                    "claim deadline + grace window has not passed yet"
                );

                // Reset to Open + clear claim metadata
                task.state = TaskState::Open;
                task.claimer_badge_id = None;
                task.claim_deadline = None;
                task.claimer_is_agent = false;
                task.current_claim_receipt_id = None;
                task.worker_account = None;
            }

            // Forfeit claim_bond -> caller bounty + operator vault (DB-4,
            // sitting 2026-08-06; replaces the D-P4 poster-credit, which was
            // permissionlessly farmable by the poster).
            let mut forfeited = self
                .task_claim_bond_vaults
                .get_mut(&task_id)
                .expect("claim_bond vault missing")
                .take_all();
            let forfeited_amount = forfeited.amount();
            let bond_resource = forfeited.resource_address();
            // Proportional (operator ruling 2026-08-29, against a recommendation
            // to cut the bounty entirely). Rounded DOWN to the token, so the
            // remainder always lands in the house vault and nothing is stranded
            // — the same truncation discipline as the settlement split.
            let bounty_amount = (forfeited_amount * self.expire_bounty_pct)
                .checked_round(
                    Self::token_divisibility(bond_resource) as i32,
                    RoundingMode::ToZero,
                )
                .expect("bounty rounding overflowed");
            let bounty = forfeited.take(bounty_amount);
            if self.forfeited_claim_bonds_vaults.get(&bond_resource).is_some() {
                self.forfeited_claim_bonds_vaults
                    .get_mut(&bond_resource)
                    .unwrap()
                    .put(forfeited);
            } else {
                self.forfeited_claim_bonds_vaults
                    .insert(bond_resource, Vault::with_bucket(forfeited));
            }

            Runtime::emit_event(ClaimExpiredEvent {
                task_id,
                forfeited_bond_amount: forfeited_amount,
                bounty_paid: bounty_amount,
            });
            // No emit_settlement_credited here: nothing was credited to any
            // party's entitlement — an unchanged snapshot would be noise the
            // reconciler ingests for nothing.

            bounty
        }

        /// Poster cancels a claimed (but not yet submitted) task.
        ///
        /// PULL: returns nothing. Reward + insurance are credited to the POSTER
        /// and the claim bond back to the WORKER whose claim is being cancelled
        /// — the worker did nothing wrong here, so their bond is theirs.
        ///
        /// The receipt becomes a `Proof` and is NOT burned: the poster still
        /// needs it to withdraw. Retire it with `burn_task_receipt` once the
        /// entitlement is zero.
        ///
        /// The bond entitlement is withdrawn via `withdraw_worker`, which
        /// authenticates on `claimer_badge_id` and pays out to `worker_account`.
        /// This method clears `current_claim_receipt_id` but deliberately leaves
        /// BOTH `claimer_badge_id` and `worker_account` intact — without the
        /// first the worker could never prove title to their own bond, and
        /// without the second there would be nowhere to pay it.
        pub fn cancel_task_by_poster_after_claim(
            &mut self,
            task_id: u64,
            receipt: Proof,
        ) {
            assert_eq!(
                receipt.resource_address(),
                self.task_receipt_manager.address(),
                "wrong receipt resource"
            );

            // Safe to skip_checking: the resource address was just asserted.
            let local_id = receipt
                .skip_checking()
                .as_non_fungible()
                .non_fungible_local_id();
            let receipt_task_id = match &local_id {
                NonFungibleLocalId::Integer(i) => i.value() as u64,
                _ => Runtime::panic("receipt has non-integer local id".to_string()),
            };
            assert_eq!(
                receipt_task_id, task_id,
                "receipt task_id does not match task_id arg"
            );

            // Look up worker before mutating state (for event emission)
            let active_receipt_id = {
                let mut task = self.tasks.get_mut(&task_id).expect("task not found");
                assert_eq!(
                    task.state,
                    TaskState::Claimed,
                    "task must be Claimed to cancel-after-claim"
                );
                let active_receipt_id = task
                    .current_claim_receipt_id
                    .expect("Claimed must have active claim_receipt_id");
                task.state = TaskState::Refunded;
                task.current_claim_receipt_id = None;
                // `worker_account` is deliberately NOT cleared, for the same
                // reason `claimer_badge_id` is not: this method credits the
                // worker's BOND below, and `worker_account` is the pinned payee
                // for it. Clearing it here stranded that bond permanently.
                // `Refunded` is terminal and `claim_task` requires `Open`, so the
                // retained value can never be re-read by a later claim.
                active_receipt_id
            };

            let claim_data: ClaimReceiptData = self
                .claim_receipt_manager
                .get_non_fungible_data(&NonFungibleLocalId::integer(active_receipt_id));
            let worker_addr = claim_data.worker;

            // Drain all three vaults into entitlements
            let reward = self.task_reward_vaults.get_mut(&task_id).unwrap().take_all();
            let insurance = self
                .task_insurance_vaults
                .get_mut(&task_id)
                .unwrap()
                .take_all();
            let bond = self
                .task_claim_bond_vaults
                .get_mut(&task_id)
                .unwrap()
                .take_all();
            let bond_amount = bond.amount();

            self.credit_entitlement(task_id, EntitledParty::Poster, reward);
            self.credit_entitlement(task_id, EntitledParty::Poster, insurance);
            self.credit_bond_entitlement(task_id, EntitledParty::Worker, bond);

            Runtime::emit_event(TaskCancelledAfterClaimEvent {
                task_id,
                bond_returned_to: worker_addr,
                bond_amount,
            });
            self.emit_settlement_credited(task_id);
        }

        /// Submit work for a claimed task. Burns claim_receipt (bucket-burn
        /// auth). Returns claim_bond to caller.
        pub fn submit_task(
            &mut self,
            task_id: u64,
            claim_receipt: Bucket,
            evidence_hash: Hash,
            brief_hash: Hash,
        ) {
            assert_eq!(
                claim_receipt.resource_address(),
                self.claim_receipt_manager.address(),
                "wrong claim receipt resource"
            );
            assert_eq!(claim_receipt.amount(), dec!("1"), "must present exactly 1 claim receipt");

            // ── W2+P4-3 submission validation (stage 6) ──────────────────────
            //
            // This method validated NOTHING about the submission itself, and
            // that emptiness is why timed release was ruled a faucet in
            // 2026-08-04 and auto-release was refused for four months. Two
            // asserts are what an escrow CAN check on-chain (it cannot judge
            // work):
            //
            // 1. The submission must commit evidence. A zero hash is not a
            //    commitment; with the review window (below) making poster
            //    silence mean release, "there was nothing to review" must be
            //    impossible by construction, not merely unlikely.
            assert!(
                evidence_hash != Hash([0u8; 32]),
                "submission must commit a non-zero evidence hash"
            );
            // 2. The submission names the brief it answers. This is the
            //    on-chain half of P4-3's keystone check (the app-side half
            //    verifies the brief BEFORE claiming): any client, ours or not,
            //    must present the work_brief_hash it built against, and a
            //    submission against a stale or wrong brief fails here instead
            //    of surfacing as a dispute. It does not authenticate the
            //    caller — the hash is readable on-chain — it proves the
            //    submitting client bound itself to the committed brief.
            {
                let task = self.tasks.get(&task_id).expect("task not found");
                assert!(
                    brief_hash == task.work_brief_hash,
                    "brief_hash does not match the task's committed work_brief_hash"
                );
            }

            let local_id = claim_receipt
                .as_non_fungible()
                .non_fungible_local_id();
            let receipt_id = match &local_id {
                NonFungibleLocalId::Integer(i) => i.value() as u64,
                _ => Runtime::panic("claim receipt has non-integer local id".to_string()),
            };

            // Verify state + receipt is the live one
            let mut task = self.tasks.get_mut(&task_id).expect("task not found");
            assert_eq!(task.state, TaskState::Claimed, "task must be Claimed to submit");
            assert_eq!(
                task.current_claim_receipt_id,
                Some(receipt_id),
                "claim_receipt is not the active one for this task"
            );

            let submitted_at = Clock::current_time_rounded_to_seconds();
            // W2: pin the review deadline NOW, from the config value in force
            // at submit — the same non-retroactivity discipline as the dispute
            // terms and the bond amount. After it, release is permissionless.
            let review_deadline = Instant::new(
                submitted_at
                    .seconds_since_unix_epoch
                    .checked_add(self.review_window_secs as i64)
                    .expect("review deadline overflow"),
            );
            task.state = TaskState::Submitted;
            task.submit_evidence_hash = Some(evidence_hash);
            task.submitted_at = Some(submitted_at);
            task.review_deadline = Some(review_deadline);
            task.current_claim_receipt_id = None;
            drop(task);

            // Burn claim receipt
            self.internal_minter_vault.as_fungible().authorize_with_amount(dec!("1"), || {
                claim_receipt.burn();
            });

            // 🔴 THE BOND NO LONGER LEAVES HERE — E1/E2, and this is the whole
            // point of the change.
            //
            // This method used to end `let bond = …take_all(); … bond`, handing
            // the claim bond straight back to whoever CALLED it. It never read
            // `task.worker_account`. Combined with a claim receipt that is a
            // transferable bearer instrument (`withdrawer=AllowAll`,
            // permanently — see the bearer-credential note), that meant anyone
            // holding a stolen receipt could submit any evidence hash they liked
            // and walk off with the real worker's bond. The receipt was the
            // authorisation AND the payee, which is the exact shape PULL removed
            // from the reward lane and left standing here.
            //
            // The bond now stays in its vault until a SETTLEMENT path decides
            // where it goes, and every such path credits it to a PINNED account
            // rather than returning a Bucket. Submitting work is no longer a
            // money-moving action at all.
            //
            // ⚠️ `invConservation` does NOT catch a regression here. A parallel
            // session measured that: conservation sums totals across lanes and
            // balances regardless of WHO called, so an adversarial submit still
            // conserves. It reddens `invSubmitOnlyByWorker` instead. If you are
            // tempted to lean on conservation to protect this, do not.
            Runtime::emit_event(WorkSubmittedEvent {
                task_id,
                evidence_hash,
                submitted_at,
                review_deadline,
            });
        }

        /// Poster approves submitted work + releases reward to worker, insurance
        /// back to poster. Burns the poster receipt (bucket-burn auth).
        /// Returns (reward_for_worker, insurance_for_poster).
        /// PULL: takes a Proof, returns nothing. The reward is credited to the
        /// WORKER and the insurance back to the POSTER; both are collected later
        /// via `withdraw_*`. Previously this returned `(reward, insurance)` to
        /// the caller and relied on the caller's manifest to route the reward to
        /// the worker — which is exactly what made a hostile or buggy manifest a
        /// theft vector.
        ///
        /// The receipt is NO LONGER BURNED here. Under pull it is a persistent
        /// entitlement key: the poster still needs it to withdraw the insurance.
        /// Retire it with `burn_task_receipt` once the entitlement is zero (that
        /// method refuses while the poster is still owed).
        pub fn approve_and_release(
            &mut self,
            receipt: Proof,
        ) {
            assert_eq!(
                receipt.resource_address(),
                self.task_receipt_manager.address(),
                "wrong receipt resource"
            );

            // Safe to skip_checking: the resource address was just asserted.
            let local_id = receipt
                .skip_checking()
                .as_non_fungible()
                .non_fungible_local_id();
            let task_id = match &local_id {
                NonFungibleLocalId::Integer(i) => i.value() as u64,
                _ => Runtime::panic("receipt has non-integer local id".to_string()),
            };

            // Verify state
            {
                let mut task = self.tasks.get_mut(&task_id).expect("task not found");
                assert_eq!(task.state, TaskState::Submitted, "task must be Submitted to release");
                task.state = TaskState::Released;
            }

            // Drain the escrow vaults into entitlements. Nothing returns to the
            // caller, so the caller's identity stops mattering to where value goes.
            let reward = self.task_reward_vaults.get_mut(&task_id).unwrap().take_all();
            let insurance = self.task_insurance_vaults.get_mut(&task_id).unwrap().take_all();

            self.credit_entitlement(task_id, EntitledParty::Worker, reward);
            self.credit_entitlement(task_id, EntitledParty::Poster, insurance);

            // E1/E2: the bond is held to settlement, so the happy path is where
            // an honest worker gets it back. Credited to the pinned worker
            // account, never returned to the caller — the caller here is the
            // POSTER, and handing them the worker's bond is precisely the bug
            // this stage exists to make impossible.
            let bond = self
                .task_claim_bond_vaults
                .get_mut(&task_id)
                .expect("claim_bond vault missing")
                .take_all();
            self.credit_bond_entitlement(task_id, EntitledParty::Worker, bond);

            Runtime::emit_event(TaskReleasedEvent {
                task_id,
                ruling: "PayWorker".to_string(),
                arbiter_fee: Decimal::ZERO,
            });
            self.emit_settlement_credited(task_id);
        }

        /// W2 (stage 6) — "on Guild, delivered work cannot be ghosted."
        ///
        /// PUBLIC, zero auth, time-gated — the mirror image of
        /// `auto_resolve_dispute`, and safe for the same PULL reason: it
        /// settles by CREDITING accounts pinned at create/claim and returns
        /// nothing, so the caller's identity does not matter. In practice the
        /// caller is the worker, from their own wallet, paying their own fee.
        ///
        /// Pays EXACTLY what `approve_and_release` pays — reward + held bond
        /// to the worker, insurance home to the poster. Not one unit more:
        /// silence is treated as approval, never as a judgement against the
        /// poster (the insurance moves only when an arbiter rules — the same
        /// asymmetry the auto-resolve path enforces).
        ///
        /// Interplay with disputes is FIRST-TO-COMMIT past the deadline, by
        /// design: `raise_dispute` needs `Submitted` and this method leaves
        /// `Released`, so a poster may still dispute after their window lapses
        /// — right up until someone actually fires this. The window is the
        /// poster's guaranteed review floor, not a cutoff on their remedy.
        /// (Same shape as the arbiter's post-lapse overrule on the auto path,
        /// measured live on task 3.)
        ///
        /// The faucet objection (2026-08-04, the reason this method was
        /// refused for four months) is answered by what now precedes it, not
        /// by anything here: `submit_task` requires a non-zero evidence
        /// commitment bound to the committed brief, disputes are LIVE so a
        /// poster's remedy is real, and the bond is held to settlement so a
        /// garbage submission stakes real value against the dispute ruling.
        pub fn release_after_review_timeout(&mut self, task_id: u64) {
            {
                let mut task = self.tasks.get_mut(&task_id).expect("task not found");
                assert_eq!(
                    task.state,
                    TaskState::Submitted,
                    "task must be Submitted to release on review timeout"
                );
                let deadline = task
                    .review_deadline
                    .expect("Submitted task has no review_deadline");
                let now = Clock::current_time_rounded_to_seconds();
                assert!(
                    now.seconds_since_unix_epoch >= deadline.seconds_since_unix_epoch,
                    "review window has not elapsed"
                );
                task.state = TaskState::Released;
            }

            // Identical settlement to approve_and_release: drain the escrow
            // vaults into entitlements, nothing to the caller.
            let reward = self.task_reward_vaults.get_mut(&task_id).unwrap().take_all();
            let insurance = self.task_insurance_vaults.get_mut(&task_id).unwrap().take_all();
            self.credit_entitlement(task_id, EntitledParty::Worker, reward);
            self.credit_entitlement(task_id, EntitledParty::Poster, insurance);
            let bond = self
                .task_claim_bond_vaults
                .get_mut(&task_id)
                .expect("claim_bond vault missing")
                .take_all();
            self.credit_bond_entitlement(task_id, EntitledParty::Worker, bond);

            Runtime::emit_event(TaskReleasedEvent {
                task_id,
                // Distinct ruling string so event consumers can tell a
                // poster's approval from a lapsed review without a state read.
                ruling: "ReviewTimeout".to_string(),
                arbiter_fee: Decimal::ZERO,
            });
            self.emit_settlement_credited(task_id);
        }

        // ── Dispute lifecycle ────────────────────────────────────────────────

        /// Poster or worker raises a dispute on a Submitted task. Proof-based
        /// auth (caller-id-on-Proof per SCRYPTO-AUTH-CONVENTION.md):
        /// - Poster: presents their task_receipt Proof (resource match +
        ///   local_id must equal task_id).
        /// - Worker: presents the worker_badge they originally claimed with
        ///   (resource must match worker_badge_resource OR agent_badge_resource
        ///   per claimer_is_agent; non-fungible local_id must equal the stored
        ///   claimer_badge_id). Done this way because submit_task already
        ///   burned the claim_receipt.
        pub fn raise_dispute(
            &mut self,
            task_id: u64,
            party_proof: Proof,
            evidence_hash: Option<Hash>,
        ) {
            let resource = party_proof.resource_address();

            let raised_by = {
                let task = self.tasks.get(&task_id).expect("task not found");
                assert_eq!(
                    task.state,
                    TaskState::Submitted,
                    "task must be Submitted to dispute"
                );

                if resource == self.task_receipt_manager.address() {
                    // Poster path: verify local_id matches task_id
                    let local_id = party_proof
                        .skip_checking()
                        .as_non_fungible()
                        .non_fungible_local_id();
                    match &local_id {
                        NonFungibleLocalId::Integer(i) => {
                            assert_eq!(
                                i.value() as u64,
                                task_id,
                                "task_receipt is for a different task"
                            );
                        }
                        _ => Runtime::panic("task_receipt has non-integer local id".to_string()),
                    }
                    DisputeParty::Poster
                } else {
                    let claimer_resource = if task.claimer_is_agent {
                        self.agent_badge_resource
                            .expect("claimer_is_agent but no agent_badge_resource configured")
                    } else {
                        self.worker_badge_resource
                    };
                    assert_eq!(
                        resource, claimer_resource,
                        "party_proof must be task_receipt or the claimer's badge"
                    );
                    // Worker path: verify badge id matches stored claimer_badge_id
                    let badge_id = party_proof
                        .skip_checking()
                        .as_non_fungible()
                        .non_fungible_local_id();
                    assert_eq!(
                        Some(badge_id),
                        task.claimer_badge_id,
                        "you are not the worker who claimed this task"
                    );
                    DisputeParty::Worker
                }
            };

            let now = Clock::current_time_rounded_to_seconds();
            let mut task = self.tasks.get_mut(&task_id).expect("task not found");
            task.state = TaskState::Disputed;
            task.disputed_at = Some(now);
            task.dispute_raised_by = Some(raised_by.clone());
            // 🔑 PIN THE TERMS AT RAISE TIME. Both of these used to be read
            // LIVE from config inside auto_resolve_dispute, which meant an
            // owner could change the window — or the RULING — of a dispute that
            // was already running, and decide its outcome after the fact. The
            // whole product promise is "the deal both sides see is the deal
            // that settles"; a config value read at settlement is not that.
            // Captured here, they are the terms in force when the raiser
            // committed, and no later setter can move them.
            let pinned_window = self.dispute_auto_resolve_secs;
            let pinned_default = self.dispute_auto_resolve_default.clone();
            task.dispute_auto_resolve_secs = Some(pinned_window);
            task.dispute_auto_resolve_default = Some(pinned_default.clone());
            task.dispute_evidence_hash = evidence_hash;
            drop(task);

            Runtime::emit_event(DisputeRaisedEvent {
                task_id,
                raised_by,
                dispute_evidence_hash: evidence_hash,
                dispute_auto_resolve_secs: Some(pinned_window),
                dispute_auto_resolve_default: Some(pinned_default),
            });
        }

        /// Arbiter resolves a disputed task. Auth: a PROOF of the arbiter badge
        /// (resource + amount checked inside, per SCRYPTO-AUTH-CONVENTION.md —
        /// the same shape as every other credentialed method here).
        /// Distribution:
        ///   arbiter_fee = arbiter_fee_pct * insurance_amount  (from insurance)
        ///   remaining_insurance = insurance_amount - arbiter_fee
        ///   Then per ruling, the REWARD-lane split (the bond follows the
        ///   reward ruling separately — see credit_split_for_parties):
        ///     PayWorker:    reward + remaining_insurance → worker
        ///     RefundPoster: reward + remaining_insurance → poster
        ///     Split{w,p}:   reward*w + rem_ins*w → worker;  reward*p + rem_ins*p → poster
        /// The worker and poster shares are CREDITED, never returned; the only
        /// bucket out is the arbiter fee, safe on the same caller-is-payee
        /// grounds as always: the caller just proved custody of the badge that
        /// entitles them.
        ///
        /// 🔴 PROOF, NOT BUCKET — Wave B ceremony-prep catch, 2026-09-01.
        /// This method took `arbiter_badge: Bucket` and handed it back, which
        /// worked only because the OLD badge was transferable. The Wave B
        /// badge is NON-TRANSFERABLE by ruling (sheet row 2: withdrawer
        /// DenyAll, forever) — a badge that can never leave its account can
        /// never be passed as a Bucket, so the bucket-form method was
        /// UNCALLABLE on the component this blueprint exists to ship: every
        /// arbiter ruling would have failed at the wallet, permanently,
        /// leaving auto-resolve as the only dispute exit. The ledger suite
        /// missed it because the fixture minted a default-transferable badge;
        /// the fixture now mints with the real mint contract's roles so a
        /// bucket-shaped regression fails in CI. Proof creation is not a
        /// withdrawal, so this form works under DenyAll — and the identity
        /// decode below reads the SAME ArbiterBadgeData either way.
        pub fn resolve_dispute(
            &mut self,
            task_id: u64,
            arbiter_badge: Proof,
            ruling: DisputeRuling,
        ) -> Bucket {
            // AUTH: deliberate deviation from SCRYPTO-AUTH-CONVENTION.md Pattern 2,
            // which pairs the resource check with `contains_owner(caller)`. There is
            // no per-unit or per-caller pin here BY DESIGN: the badge's mint_roles
            // are `require(owner_badge)`, not `deny_all`, so the operator can mint a
            // replacement unit to recover from a lost badge. Pinning a specific unit
            // or account would break that recovery path — the one path an arbiter
            // badge, being non-transferable, actually needs. What stops self-dealing
            // is not identity-of-unit but the `arbiter_account != worker_account`
            // assertion below (L6(c)). Do not "fix" this into a Pattern 2 pin.
            assert_eq!(
                arbiter_badge.resource_address(),
                self.arbiter_badge_resource,
                "wrong arbiter_badge resource"
            );
            // Safe to skip_checking: the resource address was just asserted.
            let arbiter_badge = arbiter_badge.skip_checking();
            assert_eq!(arbiter_badge.amount(), dec!("1"), "must present 1 arbiter_badge");

            // The badge's issued identity (L3(b)). Decodes ArbiterBadgeData —
            // that struct's doc is the mint contract; a badge minted with any
            // other data shape fails HERE, on the first ruling, not silently.
            let arbiter_account = arbiter_badge
                .as_non_fungible()
                .non_fungible::<ArbiterBadgeData>()
                .data()
                .assigned_account;

            // Validate ruling shape
            if let DisputeRuling::Split { worker_pct, poster_pct } = &ruling {
                assert!(
                    *worker_pct >= Decimal::ZERO && *poster_pct >= Decimal::ZERO,
                    "split percentages must be non-negative"
                );
                assert_eq!(
                    *worker_pct + *poster_pct,
                    dec!("1"),
                    "split worker_pct + poster_pct must equal 1"
                );
            }

            let mut task = self.tasks.get_mut(&task_id).expect("task not found");
            assert_eq!(
                task.state,
                TaskState::Disputed,
                "task must be Disputed to resolve"
            );

            // Validate worker_account exists (Disputed tasks must have one)
            let worker_account = task
                .worker_account
                .expect("Disputed task must have worker_account");

            // ── The self-dealing guard, in its NARROW form (L6 ruled (c),
            // 2026-08-30) ─────────────────────────────────────────────────────
            //
            // The arbiter may not rule on a dispute whose WORKER they are.
            // `worker_account` is the only party identity this comparison can
            // honestly cover: the claimer names it in the same call that
            // stakes their own bond, and every worker-side payout lands there
            // — so evading this guard means sending your own winnings to an
            // account you do not control, which is self-defeating.
            //
            // ⚠️ DELIBERATELY NOT COMPARED: `task.poster`. It is a
            // caller-supplied parameter bound to nothing (M5) — a decoy
            // poster address defeats a poster-side check for the cost of gas,
            // so shipping one would produce a guard that reads as a defence
            // in the audit and is not one (the DESIGN-REVIEW §18.9 item 3
            // analysis, and the reason L6 was ruled (c): poster is a payout
            // destination, not an identity). Poster-side self-dealing is OPEN
            // BY DESIGN and must be stated in the honesty copy, never claimed
            // closed. An arbiter-poster still cannot STEAL — settlement
            // credits only pinned accounts — they can only rule in a dispute
            // they funded.
            assert!(
                arbiter_account != worker_account,
                "self-dealing: the arbiter badge is assigned to this task's worker account"
            );

            let arbiter_fee_pct = task.arbiter_fee_pct;

            let new_state = match &ruling {
                DisputeRuling::RefundPoster => TaskState::Refunded,
                DisputeRuling::PayWorker | DisputeRuling::Split { .. } => TaskState::Released,
            };
            task.state = new_state.clone();
            drop(task);

            // The badge never enters this method (Proof-based since the
            // non-transferable Wave B badge made the bucket form uncallable);
            // only the fee leaves, to the caller who proved the badge.

            // Divisibility is read from the vault alongside the amount, in one
            // lookup, so the rounding below cannot drift from the resource it
            // is rounding for. The `18` fallback is unreachable in practice and
            // harmless when it is not: with no vault the amount is ZERO, and
            // rounding zero at any divisibility is zero.
            let (insurance_vault_amount, insurance_divisibility) = self
                .task_insurance_vaults
                .get(&task_id)
                .map(|v| (v.amount(), Self::token_divisibility(v.resource_address())))
                .unwrap_or((Decimal::ZERO, 18u8));
            let reward_vault_amount = self
                .task_reward_vaults
                .get(&task_id)
                .map(|v| v.amount())
                .unwrap_or(Decimal::ZERO);

            // 🔴 ROUND THE FEE DOWN TO THE TOKEN'S DIVISIBILITY BEFORE TAKING.
            //
            // Identical hazard to the one documented at length in
            // `credit_split_for_parties` — and this leg was the one that got
            // missed when that one was fixed. `arbiter_fee_pct` is a free 18dp
            // `Decimal` bounded only by `max_arbiter_fee_pct`, with no
            // granularity constraint at `create_task`, so the product routinely
            // carries more decimal places than the token can express: insurance
            // 33.333333 at a 1dp fee percentage is already 7dp against a 6dp
            // stablecoin. `Vault::take` PANICS on an unrepresentable amount, and
            // because `arbiter_fee_pct` is pinned per task and the vault balance
            // does not move while Disputed, EVERY retry panics identically —
            // `resolve_dispute` would be permanently dead for that task and the
            // only remaining exit is `auto_resolve_dispute`, i.e. the arbiter is
            // disenfranchised by arithmetic and the parties get the default
            // ruling instead of the judged one. A poster who prefers the default
            // can arrange that deliberately.
            //
            // ToZero rather than nearest, for the same reason as the split path:
            // whatever is shaved off the fee stays in the insurance vault and
            // flows into `remaining_insurance`, so it lands with the parties
            // rather than being created or stranded. `insurance_vault_amount`
            // came out of a vault and is therefore already representable, so the
            // subtraction below is representable too.
            let arbiter_fee = (insurance_vault_amount * arbiter_fee_pct)
                .checked_round(insurance_divisibility as i32, RoundingMode::ToZero)
                .expect("arbiter fee rounding overflowed");
            let remaining_insurance = insurance_vault_amount - arbiter_fee;

            // Take arbiter fee out of insurance vault
            let arbiter_share = {
                let mut ins = self.task_insurance_vaults.get_mut(&task_id).unwrap();
                ins.take(arbiter_fee)
            };

            // PULL: credit reward + remaining insurance per ruling. Nothing is
            // returned to the caller except the fee — the badge never enters the
            // method (it is a Proof since the non-transferable Wave B badge made
            // the Bucket form uncallable), so there is nothing to hand back.
            //
            // ARBITER-RULED, so the SAME ruling governs both legs: a human looked
            // at the work and decided. Transferring the poster's insurance premium
            // to the worker is a real finding against the poster, not a default.
            let (worker_amount, poster_amount) =
                self.credit_split_for_parties(
                    task_id,
                    &ruling,
                    &ruling,
                    reward_vault_amount,
                    remaining_insurance,
                );

            match new_state {
                TaskState::Released => {
                    Runtime::emit_event(TaskReleasedEvent {
                        task_id,
                        ruling: format!("{:?}", &ruling),
                        arbiter_fee,
                    });
                }
                TaskState::Refunded => {
                    Runtime::emit_event(TaskRefundedEvent { task_id, arbiter_fee });
                }
                _ => unreachable!(),
            }
            Runtime::emit_event(DisputeResolvedEvent {
                task_id,
                ruling,
                arbiter_fee,
                worker_amount,
                poster_amount,
            });
            self.emit_settlement_credited(task_id);

            arbiter_share
        }

        /// Public, time-gated. No auth — anyone may trigger after window.
        /// After dispute_auto_resolve_secs has elapsed since raise_dispute,
        /// applies the dispute_auto_resolve_default ruling.
        /// No arbiter fee is taken (no arbiter performed work).
        /// Worker + poster buckets are returned to the caller, who routes them
        /// via the transaction manifest (F-003: avoids try_deposit_or_abort).
        /// PULL: returns nothing. Stays `PUBLIC` — and under pull that is now
        /// safe, which is the point. Permissionless triggering is *required*
        /// (either party could otherwise stall the timeout forever), and it used
        /// to be in direct tension with safe settlement because the caller
        /// received both buckets. A stranger calling this now performs the
        /// accounting and receives nothing.
        pub fn auto_resolve_dispute(&mut self, task_id: u64) {
            let now = Clock::current_time_rounded_to_seconds();
            // Prefer the terms pinned at raise_dispute. The `unwrap_or` arms
            // exist only for tasks disputed BEFORE the pin shipped; on a fresh
            // component every disputed task carries its own, so the fallback is
            // unreachable in practice and deliberately not removed — a task
            // mid-dispute across an upgrade must still resolve.
            let (auto_default, auto_window) = {
                let task = self.tasks.get(&task_id).expect("task not found");
                (
                    task.dispute_auto_resolve_default
                        .clone()
                        .unwrap_or_else(|| self.dispute_auto_resolve_default.clone()),
                    task.dispute_auto_resolve_secs
                        .unwrap_or(self.dispute_auto_resolve_secs),
                )
            };

            let (raised_by, _worker_account, _poster_account) = {
                let task = self.tasks.get(&task_id).expect("task not found");
                assert_eq!(
                    task.state,
                    TaskState::Disputed,
                    "task must be Disputed to auto-resolve"
                );
                let disputed_at =
                    task.disputed_at.expect("Disputed must have disputed_at");
                assert!(
                    now.seconds_since_unix_epoch
                        >= disputed_at
                            .seconds_since_unix_epoch
                            .checked_add(auto_window as i64)
                            .expect("auto-resolve window overflow"),
                    "dispute auto-resolve window has not elapsed"
                );
                let raised_by = task
                    .dispute_raised_by
                    .clone()
                    .expect("Disputed must have dispute_raised_by");
                let worker_account = task
                    .worker_account
                    .expect("Disputed must have worker_account");
                (raised_by, worker_account, task.poster)
            };

            // Resolve the default ruling
            let ruling = match auto_default {
                AutoResolveDefault::FavorDisputeRaiser => match raised_by {
                    DisputeParty::Worker => DisputeRuling::PayWorker,
                    DisputeParty::Poster => DisputeRuling::RefundPoster,
                },
                AutoResolveDefault::SplitEvenly => DisputeRuling::Split {
                    worker_pct: dec!("0.5"),
                    poster_pct: dec!("0.5"),
                },
                AutoResolveDefault::ReturnToPoster => DisputeRuling::RefundPoster,
                // The mirror of FavorDisputeRaiser. See the variant's own note:
                // safe only alongside W2 + P4-3, which is why nothing selects it
                // before stage 6.
                AutoResolveDefault::FavorNonRaiser => match raised_by {
                    DisputeParty::Worker => DisputeRuling::RefundPoster,
                    DisputeParty::Poster => DisputeRuling::PayWorker,
                },
            };

            let new_state = match &ruling {
                DisputeRuling::RefundPoster => TaskState::Refunded,
                DisputeRuling::PayWorker | DisputeRuling::Split { .. } => TaskState::Released,
            };
            {
                let mut task = self.tasks.get_mut(&task_id).expect("task not found");
                task.state = new_state.clone();
            }

            // No arbiter fee on auto-resolve; full insurance + reward distribute per ruling
            let insurance_amount = self
                .task_insurance_vaults
                .get(&task_id)
                .map(|v| v.amount())
                .unwrap_or(Decimal::ZERO);
            let reward_amount = self
                .task_reward_vaults
                .get(&task_id)
                .map(|v| v.amount())
                .unwrap_or(Decimal::ZERO);

            // AUTO-resolve: NOBODY judged. The ruling governs the REWARD only;
            // the insurance premium goes back to the poster who paid it. This is
            // what stops disputing from out-earning honest completion — see the
            // block on `credit_split_for_parties`. That guarantee is
            // default-INDEPENDENT: it holds for every `AutoResolveDefault`
            // variant, which is the whole reason it is worth having.
            //
            // ⚠️ This used to end "It does not weaken D-P4: `FavorDisputeRaiser`
            // still decides who wins the reward." Stale on both halves. DB-1
            // (sitting 2026-08-06) REVERSED D-P4 and the deploy default is
            // `SplitEvenly` again — `FavorDisputeRaiser` is one selectable
            // variant of four, not what ships. And the reward is decided by
            // `auto_default` above, which is the value PINNED onto the task at
            // `raise_dispute`, not live config: a later
            // `set_dispute_auto_resolve_default` cannot move a dispute already
            // in flight.
            let (worker_amount, poster_amount) =
                self.credit_split_for_parties(
                    task_id,
                    &ruling,
                    &DisputeRuling::RefundPoster,
                    reward_amount,
                    insurance_amount,
                );

            match new_state {
                TaskState::Released => {
                    Runtime::emit_event(TaskReleasedEvent {
                        task_id,
                        ruling: format!("{:?}", &ruling),
                        arbiter_fee: Decimal::ZERO,
                    });
                }
                TaskState::Refunded => {
                    Runtime::emit_event(TaskRefundedEvent {
                        task_id,
                        arbiter_fee: Decimal::ZERO,
                    });
                }
                _ => unreachable!(),
            }
            Runtime::emit_event(DisputeAutoResolvedEvent {
                task_id,
                default_ruling: ruling,
                worker_amount,
                poster_amount,
            });
            self.emit_settlement_credited(task_id);
        }

        /// Internal helper: drains the per-task reward + insurance vaults and
        /// CREDITS the worker and poster entitlements per the dispute ruling.
        /// Returns `(worker_total, poster_total)` for event accounting only.
        ///
        /// 🔑 **No buckets leave this component.** The previous version returned
        /// `(worker_bucket, poster_bucket)` and its own doc comment said "No
        /// deposits are made — callers route the returned buckets", which is
        /// precisely the root cause: `auto_resolve_dispute` is PUBLIC, so an
        /// anonymous caller received BOTH shares and routed them anywhere. The
        /// ruling only ever governed the event's accounting.
        ///
        /// The poster's share remains the REMAINDER of the combined bucket
        /// rather than a separately-computed product. That is deliberate: it
        /// preserves the pre-pull semantics and makes a rounding leak
        /// impossible, since truncation on the worker's leg lands in the
        /// poster's share instead of stranding dust in the vault.
        /// The worker's share of one amount under one ruling. The poster's share
        /// is deliberately NOT computed here — it is the remainder, see below.
        /// A fungible resource's divisibility (decimal places it can express).
        /// Panics on a non-fungible, which is correct: nothing in this component
        /// should ever route a reward through a non-fungible resource.
        fn token_divisibility(resource: ResourceAddress) -> u8 {
            match ResourceManager::from(resource).resource_type() {
                ResourceType::Fungible { divisibility } => divisibility,
                ResourceType::NonFungible { .. } => {
                    panic!("reward token must be fungible")
                }
            }
        }

        /// `pct * reward`, clamped to [floor, cap], rounded DOWN to what the
        /// token can express.
        ///
        /// Rounding down matters for the same reason it does in the split path:
        /// the claimer must be able to present EXACTLY this amount, and an
        /// amount carrying more decimal places than the resource has cannot be
        /// taken from a bucket at all — it would make the task unclaimable
        /// rather than merely mispriced.
        ///
        /// The floor is applied BEFORE the cap so a floor above the cap is
        /// impossible to express; `instantiate` and the setter both assert
        /// `cap >= floor` anyway, so the clamp order is belt and braces.
        fn required_bond(
            reward: Decimal,
            pct: Decimal,
            floor: Decimal,
            cap: Decimal,
            divisibility: u8,
        ) -> Decimal {
            let raw = reward * pct;
            let clamped = if raw < floor {
                floor
            } else if raw > cap {
                cap
            } else {
                raw
            };
            clamped
                .checked_round(divisibility as i32, RoundingMode::ToZero)
                .expect("bond rounding overflowed")
        }

        fn worker_share(ruling: &DisputeRuling, amount: Decimal) -> Decimal {
            match ruling {
                DisputeRuling::PayWorker => amount,
                DisputeRuling::RefundPoster => Decimal::ZERO,
                DisputeRuling::Split { worker_pct, .. } => amount * *worker_pct,
            }
        }

        fn credit_split_for_parties(
            &mut self,
            task_id: u64,
            reward_ruling: &DisputeRuling,
            insurance_ruling: &DisputeRuling,
            reward_amount: Decimal,
            insurance_amount: Decimal,
        ) -> (Decimal, Decimal) {
            // TWO rulings, and they are the same one ONLY when a human judged.
            //
            // 🔴 They were a single ruling until 2026-08-01, and that made
            // disputing STRICTLY DOMINATE being approved for the worker:
            // `approve_and_release` pays the worker the reward and returns the
            // insurance to the poster, while a `PayWorker` ruling paid the worker
            // reward AND insurance — more than honest completion, on every task.
            // `raise_dispute` requires `Submitted` and `submit_task` sets it, so a
            // worker can submit and dispute in ONE manifest and the first raise
            // locks the counterparty out; with `FavorDisputeRaiser` as the
            // auto-resolve default they then simply win after the window.
            //
            // The previous `SplitEvenly` default hid this by accident — the same
            // strategy netted the worker half, i.e. strictly less than completing
            // honestly. D-P4 replaced that default for good reasons and removed
            // the accidental protection with it. Insurance is the poster's
            // premium, not a prize: on AUTO-resolve, where nobody judged, it goes
            // back to the poster and the dispute path pays exactly what approve
            // pays. Only an ARBITER-ruled `resolve_dispute` transfers it, because
            // there a human decided the poster was in the wrong.
            //
            // SITTING 2026-08-06 (DB-1): D-P4 itself was then REVERSED — the
            // deploy default is `SplitEvenly` again, ruled from the measured
            // payoff table (on PULL, EITHER party can raise and first raise
            // locks the other out, so FavorDisputeRaiser is a first-raiser race
            // whose guarantees depend on an arbiter SLA nobody has promised).
            // The two-ruling split below is default-independent and stays: it
            // is what keeps ANY default from paying more than approve does.
            let worker_reward = Self::worker_share(reward_ruling, reward_amount);
            let worker_ins = Self::worker_share(insurance_ruling, insurance_amount);

            // Drain reward + insurance vaults into local buckets
            let reward_bucket = self
                .task_reward_vaults
                .get_mut(&task_id)
                .unwrap()
                .take_all();
            let insurance_bucket = self
                .task_insurance_vaults
                .get_mut(&task_id)
                .unwrap()
                .take_all();

            // The poster's share is the REMAINDER of the combined bucket, never a
            // separately-computed product — truncation on the worker's leg lands
            // in the poster's share instead of stranding dust in the vault.
            let worker_total_raw = worker_reward + worker_ins;

            // Combine into one mixed bucket then split by amount
            let mut combined = reward_bucket;
            combined.put(insurance_bucket);

            // 🔴 ROUND DOWN TO THE TOKEN'S DIVISIBILITY BEFORE TAKING.
            // `worker_share` multiplies by a percentage, so on a `Split` ruling
            // the product routinely carries more decimal places than the token
            // can represent — Decimal is 18dp internally while every stablecoin
            // we would actually use is 6dp. `Bucket::take` with an
            // unrepresentable amount PANICS, and it would panic HERE: on the
            // dispute settlement path, i.e. precisely when two parties are
            // already fighting over the money. An unresolvable dispute is the
            // worst state this component can reach.
            //
            // Truncating (ToZero) rather than rounding to nearest is deliberate
            // and preserves the property documented above: whatever is shaved
            // off the worker's leg stays in `combined` and becomes the poster's
            // remainder. Nothing is created, nothing is stranded. The amounts
            // are non-negative here, so ToZero is floor.
            let divisibility = Self::token_divisibility(combined.resource_address());
            let worker_total = worker_total_raw
                .checked_round(divisibility as i32, RoundingMode::ToZero)
                .expect("worker share rounding overflowed");

            let worker_bucket = combined.take(worker_total);
            // Whatever remains in `combined` is the poster's share.
            let poster_total = combined.amount();

            self.credit_entitlement(task_id, EntitledParty::Worker, worker_bucket);
            self.credit_entitlement(task_id, EntitledParty::Poster, combined);

            // ── W5: the bond splits PROPORTIONALLY to the reward ruling ──────
            //
            // Operator ruling 2026-08-29, over a binary "any non-PayWorker
            // ruling forfeits the whole bond". Proportional reuses
            // `worker_share` unchanged — no new arithmetic — and it fits what
            // the bond is: a light anti-squat stake, not a penalty. A cliff
            // would punish a worker who was 40% right exactly as hard as one
            // who did nothing.
            //
            // Placed HERE, in the shared helper, rather than in each dispute
            // method: `resolve_dispute` and `auto_resolve_dispute` both route
            // through this, so the bond cannot end up following one ruling on
            // one path and a different one on the other. That divergence is the
            // kind of thing that only shows up in a real dispute.
            //
            // The REWARD ruling governs the bond, not the insurance ruling —
            // the bond is the worker's stake on the work, and the work is what
            // the reward ruling judged.
            let bond_bucket = self
                .task_claim_bond_vaults
                .get_mut(&task_id)
                .expect("claim_bond vault missing")
                .take_all();
            if bond_bucket.amount() > Decimal::ZERO {
                let bond_total = bond_bucket.amount();
                let mut bond_combined = bond_bucket;
                let worker_bond_raw = Self::worker_share(reward_ruling, bond_total);
                // Same truncation discipline as the reward split above: round
                // DOWN to the token, so the shaved remainder stays in the bucket
                // and becomes the poster's share. Nothing created, nothing
                // stranded — and on a 6dp stablecoin an unrounded percentage
                // would panic here exactly as it would there.
                let worker_bond = worker_bond_raw
                    .checked_round(
                        Self::token_divisibility(bond_combined.resource_address()) as i32,
                        RoundingMode::ToZero,
                    )
                    .expect("bond share rounding overflowed");
                let worker_bond_bucket = bond_combined.take(worker_bond);
                self.credit_bond_entitlement(task_id, EntitledParty::Worker, worker_bond_bucket);
                self.credit_bond_entitlement(task_id, EntitledParty::Poster, bond_combined);
            } else {
                // Nothing staked (bond params can legitimately be zero) — drop
                // the empty bucket rather than crediting a zero entitlement.
                bond_bucket.drop_empty();
            }

            (worker_total, poster_total)
        }

        // ── PULL withdrawals ─────────────────────────────────────────────────
        //
        // These are the ONLY way value leaves the component on the settlement
        // path. Each is PUBLIC because the auth is the Proof, checked inside —
        // the same convention every lifecycle method here already uses.
        //
        // Why a returned Bucket is safe here when it was not safe in
        // approve_and_release: the caller has proven they are the entitled
        // party, and receives exactly their own entitlement. A bad manifest can
        // therefore only harm the person who signed it. Under the old design a
        // bad (or hostile) manifest harmed the COUNTERPARTY, or — in
        // auto_resolve_dispute, which needs no credential at all — everyone.

        /// Worker collects BOTH lanes — reward and held bond, either possibly
        /// empty. One resource since stage 5a (the bond is denominated in the
        /// task's reward token), but still two lanes: what a party is owed and
        /// what they staked are different facts even when the token matches.
        ///
        /// Auth: the badge they claimed with, matched against the stored
        /// claimer_badge_id, exactly as raise_dispute does it (submit_task
        /// burned the claim_receipt, so the badge is what's left).
        ///
        /// ✅ **PAYEE PIN — this is what closes the bearer claim.** The badge
        /// decides WHO may trigger the withdrawal; `worker_account`, pinned at
        /// `claim_task`, decides WHERE the money goes. So a badge that is
        /// transferred, sold or stolen buys the holder nothing: they can trigger
        /// a payment to the real worker and pay the network fee for it.
        ///
        /// This matters because the Member badge is chain-verified TRANSFERABLE
        /// (`withdrawer=AllowAll`, `withdrawer_updater=DenyAll`, so it can never
        /// be retrofitted) AND public-mint. Under push the badge only had to be
        /// held for the single settlement transaction; under pull an entitlement
        /// can sit indefinitely, which is what turned a transient requirement
        /// into a durable bearer instrument.
        ///
        /// ⚠️ An earlier revision declined to pin, on the grounds that it "would
        /// break the agent lane's key rotation". That was misattributed: this
        /// method already asserts `claimer_badge_id`, the EXACT local id captured
        /// at claim, so an agent rotating to a FRESH badge was already stranded.
        /// Rotation only ever survived by physically moving the old badge — i.e.
        /// by the very transferability that was the vulnerability. Pinning leaves
        /// authorization untouched and adds one bounded operational rule: drain
        /// entitlements before decommissioning an account.
        pub fn withdraw_worker(&mut self, task_id: u64, badge: Proof) {
            let resource = badge.resource_address();
            {
                let task = self.tasks.get(&task_id).expect("task not found");
                let claimer_resource = if task.claimer_is_agent {
                    self.agent_badge_resource
                        .expect("claimer_is_agent but no agent_badge_resource configured")
                } else {
                    self.worker_badge_resource
                };
                assert_eq!(
                    resource, claimer_resource,
                    "badge must be the claimer's worker or agent badge"
                );
                // Safe to skip_checking: the resource address was just asserted.
                let badge_id = badge
                    .skip_checking()
                    .as_non_fungible()
                    .non_fungible_local_id();
                assert_eq!(
                    Some(badge_id),
                    task.claimer_badge_id,
                    "you are not the worker who claimed this task"
                );
            }

            let destination = self
                .tasks
                .get(&task_id)
                .expect("task not found")
                .worker_account
                .expect("no pinned worker account for this task");
            self.deposit_both_lanes(task_id, EntitledParty::Worker, destination)
        }

        /// Poster collects BOTH lanes into the pinned poster account.
        /// The bond leg is non-empty only when a dispute ruling awarded the
        /// poster part of the claim bond (W5's proportional split). An expired
        /// claim does NOT put anything here — see `expire_claim`.
        ///
        /// Auth: the task receipt, which under pull is a PERSISTENT entitlement
        /// key rather than a one-shot token — it is no longer burned at approve
        /// time. Retire it with burn_task_receipt once BOTH lanes are zero.
        ///
        /// ✅ **PAYEE PIN, poster side.** The receipt is a bearer instrument for
        /// exactly the same reason the badge is, and by omission rather than by
        /// decision: `task_receipt_manager` never calls `withdraw_roles!`, so it
        /// inherits the SDK default `withdrawer=AllowAll` /
        /// `withdrawer_updater=DenyAll`. "Task-scoped and not public-mint"
        /// measures the wrong property — public-mint governs FORGING a
        /// credential, transferability governs STEALING one, and only the second
        /// is the bearer exposure. Funds go to `task.poster`, pinned at
        /// `create_task`, so a stolen receipt cannot redirect them.
        pub fn withdraw_poster(&mut self, task_id: u64, receipt: Proof) {
            assert_eq!(
                receipt.resource_address(),
                self.task_receipt_manager.address(),
                "wrong receipt resource"
            );
            // Safe to skip_checking: the resource address was just asserted.
            let local_id = receipt
                .skip_checking()
                .as_non_fungible()
                .non_fungible_local_id();
            match &local_id {
                NonFungibleLocalId::Integer(i) => assert_eq!(
                    i.value() as u64,
                    task_id,
                    "task_receipt is for a different task"
                ),
                _ => Runtime::panic("task_receipt has non-integer local id".to_string()),
            }

            let destination = self.tasks.get(&task_id).expect("task not found").poster;
            self.deposit_both_lanes(task_id, EntitledParty::Poster, destination)
        }

        /// Deposit a settled entitlement into the party's PINNED account, on
        /// anyone's call. Wave B stage 4.
        ///
        /// WHY THIS EXISTS. PULL made collection a separate signed step, which
        /// closed BUG-7 but created a new failure with no recovery: a payee who
        /// never collects leaves settled funds sitting in the component
        /// FOREVER, and no one — not the counterparty, not the operator, not a
        /// stranger — could move them. That is not hypothetical. On mainnet task
        /// 1 the poster completed the entire walk and did not notice the Collect
        /// affordance; the product's answer was ~300 lines of extra lifecycle UI.
        /// Losing a credential is the worse version of the same thing: the
        /// claim receipt and worker badge are both transferable bearer
        /// instruments, and there is no admin override anywhere in this
        /// blueprint. Without this method, a lost badge means the money is gone.
        ///
        /// 🔑 WHY IT IS SAFE TO LEAVE PUBLIC AND UNAUTH'D. It takes no Proof and
        /// anyone may call it — because **the caller cannot influence where the
        /// money goes.** The destination is read from state (`worker_account`
        /// pinned at `claim_task`, `poster` pinned at `create_task`), exactly as
        /// `withdraw_worker`/`withdraw_poster` read it. There is no address
        /// parameter to abuse. That is the whole distinction from the
        /// caller-routed settlement PULL removed: this pushes to a pin, it does
        /// not route to a caller.
        ///
        /// What a hostile caller can achieve: paying a stranger their own money,
        /// at their own network-fee expense. The only real cost is a timing
        /// nuisance — forcing settlement into an account at a moment its owner
        /// did not choose. No floor or rate-limit guards that (L1): the
        /// `nothing to withdraw` assert in `deposit_both_lanes` already reverts
        /// the zero-value case before any account is touched, so there is no
        /// dust-spam to prevent.
        ///
        /// ⚠️ It cannot rescue a payee whose ACCOUNT rejects the deposit —
        /// `try_deposit_or_abort` aborts, same as the withdraw path. This
        /// recovers from a lost or unnoticed CREDENTIAL, not from an
        /// unreachable destination.
        pub fn push_entitlement(&mut self, task_id: u64, party: EntitledParty) {
            let destination = {
                let task = self.tasks.get(&task_id).expect("task not found");
                match party {
                    EntitledParty::Worker => task
                        .worker_account
                        .expect("no pinned worker account for this task"),
                    EntitledParty::Poster => task.poster,
                }
            };
            self.deposit_both_lanes(task_id, party, destination)
        }

        // There is deliberately no `withdraw_arbiter`, and no arbiter lane.
        //
        // `resolve_dispute` hands the fee straight back to the arbiter who
        // called it (see its doc), on the same caller-is-payee grounds that
        // leave `submit_task` alone — the caller has just proven custody of the
        // supply-1 badge that entitles them. `auto_resolve_dispute` takes no fee
        // at all. So nothing ever credited an arbiter entitlement: the field was
        // permanently zero, `withdraw_arbiter` could only ever panic on "nothing
        // to withdraw", and no test called it. Carrying three dead surfaces on a
        // money path through a refactor that was already adding two lanes is how
        // a later reader concludes arbiters are paid by pull. Removed instead.
        //
        // (Its auth was also weaker than it looked: it checked the badge
        // RESOURCE only, with no per-task binding — harmless while the lane was
        // always zero, and worth not resurrecting as-is.)

        /// Retire a spent task receipt.
        ///
        /// Refuses while the poster is owed anything in ANY lane, and while the
        /// task is not terminal — the receipt is the only credential that
        /// reaches `withdraw_poster`, `cancel_task`,
        /// `cancel_task_by_poster_after_claim` and `approve_and_release`, it is
        /// minted once per task under `NonFungibleLocalId::integer(task_id)`,
        /// and it cannot be re-minted. Burning it early strands everything
        /// behind it permanently.
        ///
        /// ⚠️ The lane guard is not paranoia — the two-lane split BROKE the
        /// original single-field version. It read `poster_entitled` alone, which
        /// was correct while `expire_claim` credited the bond there; the moment
        /// that credit moved to `poster_bond_entitled` the guard silently stopped
        /// firing on precisely the case it was written for, and the poster could
        /// burn the receipt while owed a bond AND with the full reward still
        /// escrowed. It reads `total_owed_to_poster` now so a third lane cannot
        /// bypass it the same way.
        ///
        /// The terminal-state assert closes a second, pre-existing variant: on
        /// an Open task both lanes are legitimately zero, so the entitlement
        /// guard alone would let the poster burn the receipt and strand the
        /// entire funded reward.
        pub fn burn_task_receipt(&mut self, receipt: Bucket) {
            assert_eq!(
                receipt.resource_address(),
                self.task_receipt_manager.address(),
                "wrong receipt resource"
            );
            assert_eq!(receipt.amount(), dec!("1"), "must present exactly 1 receipt");

            let local_id = receipt.as_non_fungible().non_fungible_local_id();
            let task_id = match &local_id {
                NonFungibleLocalId::Integer(i) => i.value() as u64,
                _ => Runtime::panic("task_receipt has non-integer local id".to_string()),
            };

            if let Some(task) = self.tasks.get(&task_id) {
                let state = task.state.clone();
                drop(task);
                // Entitlement guard FIRST, deliberately. Both guards reject an
                // expired-claim task, so whichever runs first is the one the
                // test can actually observe — and the lane guard is the one that
                // silently broke. Ordered this way, a regression to reading
                // `poster_entitled` alone falls through to the state guard and
                // changes the revert MESSAGE, which the test asserts on.
                assert_eq!(
                    self.total_owed_to_poster(task_id),
                    Decimal::ZERO,
                    "cannot burn the receipt while the poster is still owed — withdraw first"
                );
                assert!(
                    matches!(state, TaskState::Released | TaskState::Refunded),
                    "cannot burn the receipt before the task is terminal — it is the only credential that can settle or collect"
                );
            }

            self.internal_minter_vault.as_fungible().authorize_with_amount(dec!("1"), || {
                receipt.burn();
            });
        }

        /// Credit a party in the REWARD lane and move the funds into that lane's
        /// vault. The exact inverse of `take_lane`, and — with its bond twin —
        /// the ONLY way value enters the pull path. Every settlement method
        /// routes through one of the two instead of returning a Bucket to its
        /// caller. That is the whole fix: no method hands value to whoever
        /// invoked it.
        ///
        /// The deposit happens BEFORE the accounting, and unconditionally.
        /// Scrypto requires every Bucket to be consumed, so an early return on
        /// a zero amount would fail to compile at best and leak value at worst.
        fn credit_entitlement(
            &mut self,
            task_id: u64,
            party: EntitledParty,
            funds: Bucket,
        ) {
            let amount = funds.amount();

            // Fail here, named, rather than inside the vault. The pinned vault
            // would reject a foreign resource anyway, but its error does not say
            // which lane the caller meant.
            let expected = self
                .tasks
                .get(&task_id)
                .expect("task not found")
                .reward_token;
            assert_eq!(
                funds.resource_address(),
                expected,
                "reward-lane credit must be the task's reward token — a claim bond belongs in credit_bond_entitlement"
            );

            self.task_settlement_vaults
                .get_mut(&task_id)
                .expect("settlement vault missing — create_task pins it")
                .put(funds);

            if amount != Decimal::ZERO {
                let mut task = self.tasks.get_mut(&task_id).expect("task not found");
                match party {
                    EntitledParty::Worker => {
                        // PAYEE PIN invariant, enforced rather than argued: a
                        // worker entitlement is only ever non-zero in a terminal
                        // state, so `worker_account` is Some and frozen by then.
                        // The one method that nulls it from a non-terminal state
                        // is `expire_claim`, which credits NOBODY: it reopens the
                        // task and forfeits the bond to the caller's bounty plus
                        // the house vault, touching neither entitlement lane.
                        assert!(
                            task.worker_account.is_some(),
                            "cannot credit a worker with no pinned payout account"
                        );
                        task.worker_entitled += amount
                    }
                    EntitledParty::Poster => task.poster_entitled += amount,
                }
            }

            self.assert_conservation(task_id);
        }

        /// Credit a party in the BOND lane (the task's reward token, asserted
        /// below — the bond has not been XRD-denominated since W4).
        ///
        /// Reached from FIVE callsites across FOUR methods, not the two this
        /// comment used to claim. `cancel_task_by_poster_after_claim`,
        /// `approve_and_release` and `release_after_review_timeout` each return
        /// the whole bond to the worker, who did nothing wrong.
        /// `credit_split_for_parties` — the shared dispute helper behind
        /// `resolve_dispute` and `auto_resolve_dispute` — reaches BOTH arms,
        /// splitting the bond proportionally to the reward ruling (W5).
        ///
        /// ⚠️ It also said `expire_claim` awards the bond to the poster
        /// "(D-P4 — not to the house)". Both halves are now false: D-P4 was
        /// superseded by DB-4, and `expire_claim` does not call this method at
        /// all — it forfeits the bond to the caller's bounty plus the house
        /// vault, crediting no entitlement. The poster's bond entitlement has
        /// exactly ONE source, the `EntitledParty::Poster` arm below, and the
        /// only path that reaches it is a dispute ruling.
        fn credit_bond_entitlement(
            &mut self,
            task_id: u64,
            party: EntitledParty,
            funds: Bucket,
        ) {
            let amount = funds.amount();

            {
                let task = self.tasks.get(&task_id).expect("task not found");
                assert_eq!(
                    funds.resource_address(),
                    task.reward_token,
                    "bond-lane credit must be the task's reward token"
                );
            }

            self.task_bond_settlement_vaults
                .get_mut(&task_id)
                .expect("bond settlement vault missing — create_task pins it")
                .put(funds);

            if amount != Decimal::ZERO {
                let mut task = self.tasks.get_mut(&task_id).expect("task not found");
                match party {
                    EntitledParty::Worker => {
                        // Same PAYEE PIN invariant as the reward lane. This arm is
                        // the one `cancel_task_by_poster_after_claim` reaches, and
                        // that method used to clear `worker_account` immediately
                        // before getting here — which this assert would have caught.
                        assert!(
                            task.worker_account.is_some(),
                            "cannot credit a worker with no pinned payout account"
                        );
                        task.worker_bond_entitled += amount
                    }
                    EntitledParty::Poster => task.poster_bond_entitled += amount,
                }
            }

            self.assert_conservation(task_id);
        }

        /// The conservation invariant, ENFORCED rather than described.
        ///
        /// Both this file and the redesign doc previously claimed it was
        /// "asserted in every settlement path". It was asserted nowhere — there
        /// was no `assert` referencing a settlement vault anywhere in the file.
        /// A false claim of enforcement on a money path is worse than no claim,
        /// because it stops the next reader looking. So it is real now, and it
        /// runs on every credit and every withdrawal: accounting drift becomes a
        /// failed transaction instead of a silent divergence the drift watcher
        /// has to notice hours later.
        ///
        /// Two invariants, one per lane, each within a single resource. The
        /// pre-split version summed across resources, which is how a 1 XRD bond
        /// and 110 reward tokens came to be compared to one vault balance.
        fn assert_conservation(&self, task_id: u64) {
            let task = self.tasks.get(&task_id).expect("task not found");

            let reward_owed = task.worker_entitled + task.poster_entitled;
            let reward_held = self
                .task_settlement_vaults
                .get(&task_id)
                .expect("settlement vault missing — create_task pins it")
                .amount();
            assert_eq!(
                reward_owed, reward_held,
                "reward-lane conservation broken: entitlements do not match the vault"
            );

            let bond_owed = task.worker_bond_entitled + task.poster_bond_entitled;
            let bond_held = self
                .task_bond_settlement_vaults
                .get(&task_id)
                .expect("bond settlement vault missing — create_task pins it")
                .amount();
            assert_eq!(
                bond_owed, bond_held,
                "bond-lane conservation broken: entitlements do not match the vault"
            );
        }

        /// Everything the poster is owed across every lane. `burn_task_receipt`
        /// and any future lane-aware guard call this rather than reading a
        /// field, so adding a third lane cannot silently bypass the guard —
        /// which is exactly what the two-lane split did to the original
        /// single-field check.
        fn total_owed_to_poster(&self, task_id: u64) -> Decimal {
            self.tasks
                .get(&task_id)
                .map(|t| t.poster_entitled + t.poster_bond_entitled)
                .unwrap_or(Decimal::ZERO)
        }

        /// Emit the settlement snapshot once a method has finished crediting
        /// every party. Emitted ONCE per settlement, not once per credit, so
        /// the off-chain layer sees a complete split rather than partial states.
        fn emit_settlement_credited(&self, task_id: u64) {
            let task = self.tasks.get(&task_id).expect("task not found");
            Runtime::emit_event(SettlementCreditedEvent {
                task_id,
                worker_entitled: task.worker_entitled,
                poster_entitled: task.poster_entitled,
                worker_bond_entitled: task.worker_bond_entitled,
                poster_bond_entitled: task.poster_bond_entitled,
            });
        }

        /// Collect ONE lane for one party: zero the entitlement BEFORE taking
        /// the funds, take exactly that amount, emit.
        ///
        /// Zeroing first is deliberate. Scrypto has no reentrancy here, but the
        /// ordering makes the double-withdraw impossible to reintroduce by a
        /// later edit that adds a call between the two steps.
        ///
        /// Returns `None` — not an empty Bucket — when the party is owed nothing
        /// in this lane, and that choice is load-bearing twice over:
        ///
        ///  1. **It must not assert.** Either party can be owed in one lane and
        ///     not the other — a worker owed a reward on a zero-bond task, or a
        ///     poster owed a bond share from a dispute split but no reward. An
        ///     `amount > 0` assert down here would revert their whole legitimate
        ///     withdrawal. The `> 0` check belongs at the caller, against the
        ///     COMBINED total, and that is where it now lives.
        ///     (The old example here was "a poster owed only an expired bond" —
        ///     a state `expire_claim` has never been able to produce since DB-4.)
        ///  2. **An empty Bucket is not free.** Manifests that route through
        ///     `try_deposit_batch_or_abort` — the agent lane, and anything
        ///     sponsored — honour the recipient's `AllowExisting` deposit rule,
        ///     so an empty bucket of a token they have never held would abort an
        ///     otherwise valid withdrawal. It would also instantiate a permanent
        ///     zero-balance vault in their account on every settlement. `None`
        ///     puts nothing on the worktop and has neither problem.
        fn take_lane(
            &mut self,
            task_id: u64,
            party: EntitledParty,
            lane: EntitlementLane,
            destination: ComponentAddress,
        ) -> Option<Bucket> {
            let amount = {
                let task = self.tasks.get(&task_id).expect("task not found");
                match (&lane, &party) {
                    (EntitlementLane::Reward, EntitledParty::Worker) => task.worker_entitled,
                    (EntitlementLane::Reward, EntitledParty::Poster) => task.poster_entitled,
                    (EntitlementLane::Bond, EntitledParty::Worker) => task.worker_bond_entitled,
                    (EntitlementLane::Bond, EntitledParty::Poster) => task.poster_bond_entitled,
                }
            };

            if amount == Decimal::ZERO {
                return None;
            }

            {
                let mut task = self.tasks.get_mut(&task_id).expect("task not found");
                match (&lane, &party) {
                    (EntitlementLane::Reward, EntitledParty::Worker) => {
                        task.worker_entitled = Decimal::ZERO
                    }
                    (EntitlementLane::Reward, EntitledParty::Poster) => {
                        task.poster_entitled = Decimal::ZERO
                    }
                    (EntitlementLane::Bond, EntitledParty::Worker) => {
                        task.worker_bond_entitled = Decimal::ZERO
                    }
                    (EntitlementLane::Bond, EntitledParty::Poster) => {
                        task.poster_bond_entitled = Decimal::ZERO
                    }
                }
            }

            let funds = match lane {
                EntitlementLane::Reward => self
                    .task_settlement_vaults
                    .get_mut(&task_id)
                    .expect("settlement vault missing — create_task pins it")
                    .take(amount),
                EntitlementLane::Bond => self
                    .task_bond_settlement_vaults
                    .get_mut(&task_id)
                    .expect("bond settlement vault missing — create_task pins it")
                    .take(amount),
            };

            Runtime::emit_event(WithdrawalEvent {
                task_id,
                party,
                lane,
                resource: funds.resource_address(),
                amount,
                destination,
            });

            self.assert_conservation(task_id);

            Some(funds)
        }

        /// Collect both lanes for one party and DEPOSIT them into the pinned
        /// payee account, with the only "is anything owed" check in the whole
        /// withdrawal path.
        ///
        /// The deposit is not optional and cannot be moved to the manifest:
        /// Scrypto gives a blueprint no way to constrain where a RETURNED bucket
        /// goes (`ASSERT_WORKTOP_CONTAINS` is written by the withdrawer), so the
        /// only enforcement point for the payee pin is in here.
        ///
        /// F-003 does not come back. That lever needs ONE transaction to touch
        /// TWO parties' accounts, so A's deposit rule can abort B's settlement.
        /// Here every deposit goes to the caller-payee's own account, in their
        /// own transaction — `withdraw_worker` and `withdraw_poster` are separate
        /// methods over separate lanes. No transaction deposits into an account
        /// belonging to anyone but the party invoking it, so the lever has nobody
        /// to point at. An abort reverts the frame, so `take_lane`'s zeroing
        /// unwinds and the entitlement survives: the payee fixes their own
        /// deposit rule and retries, out only a fee.
        ///
        /// Deposited lane-by-lane rather than as a batch: an empty lane is `None`
        /// and is simply never offered, which preserves the `AllowExisting`
        /// reasoning above without needing to restate it.
        fn deposit_both_lanes(
            &mut self,
            task_id: u64,
            party: EntitledParty,
            destination: ComponentAddress,
        ) {
            let reward = self.take_lane(
                task_id,
                party.clone(),
                EntitlementLane::Reward,
                destination,
            );
            let bond = self.take_lane(task_id, party, EntitlementLane::Bond, destination);
            // Before any account is touched, so a "nothing owed" call reverts
            // without a partial deposit.
            assert!(
                reward.is_some() || bond.is_some(),
                "nothing to withdraw for this party on this task"
            );

            let mut account: Global<Account> = destination.into();
            if let Some(b) = reward {
                account.try_deposit_or_abort(b, None);
            }
            if let Some(b) = bond {
                account.try_deposit_or_abort(b, None);
            }
        }

        // ── Views ────────────────────────────────────────────────────────────

        /// REWARD lane `(worker, poster)` — settled in the task's reward token
        /// but not yet collected. A task can be Released with both non-zero;
        /// that is the state the off-chain layer must learn to represent.
        pub fn get_entitlements(&self, task_id: u64) -> (Decimal, Decimal) {
            let task = self.tasks.get(&task_id).expect("task not found");
            (task.worker_entitled, task.poster_entitled)
        }

        /// BOND lane `(worker, poster)` — settled claim bond, not yet
        /// collected. Non-zero for the worker after a cancel-after-claim, an
        /// approved release, a review-timeout release, or the worker's share of
        /// a dispute split; non-zero for the poster ONLY from that same dispute
        /// split. An expired claim credits neither — `expire_claim` pays the
        /// caller a bounty and sends the remainder to the house.
        ///
        /// A separate view rather than a wider tuple on purpose: each of these
        /// returns exactly one resource, so no caller can add two of them
        /// together. Summing across resources is the arithmetic that produced
        /// this whole class of bug.
        pub fn get_bond_entitlements(&self, task_id: u64) -> (Decimal, Decimal) {
            let task = self.tasks.get(&task_id).expect("task not found");
            (task.worker_bond_entitled, task.poster_bond_entitled)
        }

        /// `(reward_lane_held, bond_lane_held)` — what the two settlement vaults
        /// ACTUALLY hold, which is the denominator the entitlement views lack.
        ///
        /// Without this the conservation invariants are unverifiable from
        /// outside: `get_task_balances` reports only the pre-settlement escrow
        /// vaults, which read zero once a task has settled. With it the drift
        /// watcher can check owed-vs-held every 30 minutes without a trace.
        pub fn get_settlement_balances(&self, task_id: u64) -> (Decimal, Decimal) {
            let reward = self
                .task_settlement_vaults
                .get(&task_id)
                .map(|v| v.amount())
                .unwrap_or(Decimal::ZERO);
            let bond = self
                .task_bond_settlement_vaults
                .get(&task_id)
                .map(|v| v.amount())
                .unwrap_or(Decimal::ZERO);
            (reward, bond)
        }

        pub fn get_accepted_tokens(&self) -> Vec<(ResourceAddress, AcceptedTokenConfig)> {
            self.accepted_token_addresses
                .iter()
                .filter_map(|r| self.accepted_tokens.get(r).map(|cfg| (*r, cfg.clone())))
                .collect()
        }

        pub fn get_config(&self) -> EscrowConfig {
            EscrowConfig {
                worker_badge_resource: self.worker_badge_resource,
                arbiter_badge_resource: self.arbiter_badge_resource,
                agent_badge_resource: self.agent_badge_resource,
                max_arbiter_fee_pct: self.max_arbiter_fee_pct,
                human_submit_deadline_secs: self.human_submit_deadline_secs,
                agent_submit_deadline_secs: self.agent_submit_deadline_secs,
                dispute_auto_resolve_secs: self.dispute_auto_resolve_secs,
                expire_grace_secs: self.expire_grace_secs,
                dispute_auto_resolve_default: self.dispute_auto_resolve_default.clone(),
                min_insurance_fraction: self.min_insurance_fraction,
                claim_bond_pct: self.claim_bond_pct,
                claim_bond_floor: self.claim_bond_floor,
                claim_bond_cap: self.claim_bond_cap,
                expire_bounty_pct: self.expire_bounty_pct,
                review_window_secs: self.review_window_secs,
            }
        }

        pub fn get_task_info(&self, task_id: u64) -> Option<TaskInfo> {
            self.tasks.get(&task_id).map(|t| t.clone())
        }

        /// (reward_amount, insurance_amount, claim_bond_amount) — zeros for
        /// vaults that don't exist for this task_id.
        pub fn get_task_balances(&self, task_id: u64) -> (Decimal, Decimal, Decimal) {
            let reward = self
                .task_reward_vaults
                .get(&task_id)
                .map(|v| v.amount())
                .unwrap_or(Decimal::ZERO);
            let insurance = self
                .task_insurance_vaults
                .get(&task_id)
                .map(|v| v.amount())
                .unwrap_or(Decimal::ZERO);
            let bond = self
                .task_claim_bond_vaults
                .get(&task_id)
                .map(|v| v.amount())
                .unwrap_or(Decimal::ZERO);
            (reward, insurance, bond)
        }

        /// Amount of `resource` held in the forfeited-bonds vaults — the
        /// house's share of expired claim bonds (the remainder after
        /// `expire_claim` pays the caller bounty), and after DB-3 the only thing
        /// that ever lands here. Takes a resource because W4 denominates the
        /// bond in the task's reward token, so forfeitures are keyed by resource
        /// rather than pooled in one XRD vault; an unused resource reads zero.
        /// Owner-only `withdraw_forfeited_bonds` drains it; this view lets the
        /// operator check the balance non-destructively.
        pub fn get_forfeited_bond_amount(&self, resource: ResourceAddress) -> Decimal {
            self.forfeited_claim_bonds_vaults
                .get(&resource)
                .map(|v| v.amount())
                .unwrap_or(Decimal::ZERO)
        }
    }
}
