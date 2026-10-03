//! # guild-escrow — DEPRECATED 2026-05-23
//!
//! Superseded by [`guild_marketplace_escrow`](../../guild-marketplace-escrow/src/lib.rs).
//! See [`README.md`](../README.md) for the audit-driven rationale and the
//! migration table.
//!
//! This crate is retained as an audit-time snapshot and is **not** part of
//! the default scrypto CI matrix. Do not modify; do not consume from new
//! components.

use scrypto::prelude::*;

// ============================================================
// ENUMS
// ============================================================

/// Task lifecycle status within the escrow component.
#[derive(ScryptoSbor, Clone, PartialEq, Debug)]
pub enum TaskStatus {
    Open,
    Claimed,
    Submitted,
    Approved,
    Disputed,
    Released,
    Refunded,
}

/// Ruling options for dispute resolution by an elder/steward arbiter.
#[derive(ScryptoSbor, ManifestSbor, Clone, Debug)]
pub enum DisputeRuling {
    PayWorker,
    RefundPoster,
    Split(Decimal, Decimal),
}

// ============================================================
// NON-FUNGIBLE DATA
// ============================================================

/// Mirror of UniversalBadgeData from badge-manager for reading badge NFT data.
/// Field order and types must match exactly (SBOR is positional).
#[derive(ScryptoSbor, NonFungibleData)]
pub struct GuildBadgeData {
    pub issued_to: String,
    pub schema_name: String,
    pub issued_at: i64,
    #[mutable]
    pub tier: String,
    #[mutable]
    pub status: String,
    #[mutable]
    pub last_updated: i64,
    #[mutable]
    pub xp: u64,
    #[mutable]
    pub level: String,
    #[mutable]
    pub extra_data: String,
}

/// Receipt NFT given to task poster on escrow creation.
/// Used as proof of poster identity for approve/release operations.
#[derive(ScryptoSbor, NonFungibleData)]
pub struct PosterReceipt {
    pub task_id: String,
    pub reward_amount: Decimal,
    pub insurance_amount: Decimal,
}

// ============================================================
// EVENTS
// ============================================================

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct TaskCreatedEvent {
    pub task_id: String,
    pub reward_amount: Decimal,
    pub insurance_amount: Decimal,
    pub dispute_window_hours: u64,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct TaskClaimedEvent {
    pub task_id: String,
    pub worker_address: ComponentAddress,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct WorkSubmittedEvent {
    pub task_id: String,
    pub deliverable_hash: String,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct EscrowReleasedEvent {
    pub task_id: String,
    pub amount: Decimal,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct DisputeRaisedEvent {
    pub task_id: String,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct DisputeResolvedEvent {
    pub task_id: String,
    pub ruling: DisputeRuling,
    pub arbiter_fee: Decimal,
}

// ============================================================
// GUILD ESCROW BLUEPRINT
// ============================================================

#[blueprint]
#[events(
    TaskCreatedEvent,
    TaskClaimedEvent,
    WorkSubmittedEvent,
    EscrowReleasedEvent,
    DisputeRaisedEvent,
    DisputeResolvedEvent
)]
mod guild_escrow {
    enable_method_auth! {
        roles {
            poster => updatable_by: [OWNER];
            worker => updatable_by: [OWNER];
            arbiter => updatable_by: [OWNER];
        },
        methods {
            // Public — badge required but anyone with a valid badge can call
            claim_task => PUBLIC;
            // Worker only
            submit_work => restrict_to: [worker, OWNER];
            // Poster only
            approve_and_release => restrict_to: [poster, OWNER];
            // Poster or worker can raise disputes
            raise_dispute => restrict_to: [poster, worker, OWNER];
            // Elder/steward arbiter only
            resolve_dispute => restrict_to: [arbiter, OWNER];
            // Public reads
            get_status => PUBLIC;
            get_task_info => PUBLIC;
        }
    }

    struct GuildEscrow {
        /// Vault holding the task reward XRD
        reward_vault: Vault,
        /// Vault holding the insurance fee XRD
        insurance_vault: Vault,
        /// Off-chain task identifier
        task_id: String,
        /// Address of the task poster
        poster_address: ComponentAddress,
        /// Address of the worker (set on claim)
        worker_address: Option<ComponentAddress>,
        /// Current task status
        status: TaskStatus,
        /// Dispute window duration in hours (stored for off-chain use; no on-ledger auto-approval).
        dispute_window_hours: u64,
        /// Timestamp when work was submitted
        submitted_at: Option<Instant>,
        /// Hash of the deliverable (set on submission)
        deliverable_hash: Option<String>,
        /// Guild badge NFT resource address for proof validation
        badge_resource: ResourceAddress,
    }

    impl GuildEscrow {
        /// Instantiate a new escrow component with reward and insurance deposits.
        /// Returns the globalized component and a poster receipt NFT bucket.
        pub fn create_task(
            reward: Bucket,
            insurance: Bucket,
            task_id: String,
            dispute_window_hours: u64,
            poster_address: ComponentAddress,
            badge_resource: ResourceAddress,
        ) -> (Global<GuildEscrow>, Bucket) {
            // Validate reward bucket contains XRD and is non-empty
            assert!(
                reward.resource_address() == XRD,
                "Reward must be XRD"
            );
            assert!(
                reward.amount() > Decimal::ZERO,
                "Reward must be non-empty"
            );
            assert!(
                insurance.resource_address() == XRD,
                "Insurance must be XRD"
            );

            let reward_amount = reward.amount();
            let insurance_amount = insurance.amount();

            // Create poster receipt NFT — serves as proof of poster identity
            let receipt = ResourceBuilder::new_integer_non_fungible::<PosterReceipt>(
                OwnerRole::None,
            )
            .metadata(metadata!(
                init {
                    "name" => "Guild Escrow Poster Receipt", locked;
                    "description" => "Receipt proving task poster identity for escrow operations", locked;
                }
            ))
            .mint_initial_supply(vec![(
                IntegerNonFungibleLocalId::new(1u64),
                PosterReceipt {
                    task_id: task_id.clone(),
                    reward_amount,
                    insurance_amount,
                },
            )]);

            let receipt_resource = receipt.resource_address();

            let component = Self {
                reward_vault: Vault::with_bucket(reward),
                insurance_vault: Vault::with_bucket(insurance),
                task_id: task_id.clone(),
                poster_address,
                worker_address: None,
                status: TaskStatus::Open,
                dispute_window_hours,
                submitted_at: None,
                deliverable_hash: None,
                badge_resource,
            }
            .instantiate()
            .prepare_to_globalize(OwnerRole::None)
            .roles(roles!(
                poster => rule!(require(receipt_resource));
                worker => rule!(allow_all);
                arbiter => rule!(require(badge_resource));
            ))
            .globalize();

            Runtime::emit_event(TaskCreatedEvent {
                task_id,
                reward_amount,
                insurance_amount,
                dispute_window_hours,
            });

            (component, receipt.into())
        }

        /// Claim an open task. Caller must present a valid, non-revoked Guild badge proof.
        pub fn claim_task(&mut self, worker_proof: Proof, worker_address: ComponentAddress) {
            assert!(
                self.status == TaskStatus::Open,
                "Task must be in Open status to claim"
            );

            // Validate the proof is from the Guild badge NFT resource
            let checked_proof = worker_proof.check(self.badge_resource);
            assert!(
                checked_proof.amount() > Decimal::ZERO,
                "Valid Guild badge required to claim tasks"
            );

            // Read badge data to verify it is not revoked
            let nf_ids = checked_proof.as_non_fungible().non_fungible_local_ids();
            let nf_id = nf_ids.into_iter().next()
                .expect("Badge proof must contain at least one NFT");
            let nf_rm: NonFungibleResourceManager = self.badge_resource.into();
            let badge_data: GuildBadgeData = nf_rm.get_non_fungible_data(&nf_id);
            assert!(
                badge_data.status != "revoked",
                "Revoked badges cannot claim tasks"
            );

            self.worker_address = Some(worker_address);
            self.status = TaskStatus::Claimed;

            Runtime::emit_event(TaskClaimedEvent {
                task_id: self.task_id.clone(),
                worker_address,
            });
        }

        /// Submit work deliverable hash. Only callable by the assigned worker.
        pub fn submit_work(&mut self, deliverable_hash: String) {
            assert!(
                self.status == TaskStatus::Claimed,
                "Task must be in Claimed status to submit work"
            );

            self.deliverable_hash = Some(deliverable_hash.clone());
            self.submitted_at = Some(Clock::current_time_rounded_to_minutes());
            self.status = TaskStatus::Submitted;

            Runtime::emit_event(WorkSubmittedEvent {
                task_id: self.task_id.clone(),
                deliverable_hash,
            });
        }

        /// Approve the submission and release escrowed reward. Only callable by poster.
        pub fn approve_and_release(&mut self) -> Bucket {
            assert!(
                self.status == TaskStatus::Submitted,
                "Task must be in Submitted status to approve"
            );

            self.status = TaskStatus::Released;
            let reward = self.reward_vault.take_all();

            Runtime::emit_event(EscrowReleasedEvent {
                task_id: self.task_id.clone(),
                amount: reward.amount(),
            });

            reward
        }

        /// Raise a dispute on a submitted task. Callable by poster or worker.
        pub fn raise_dispute(&mut self) {
            assert!(
                self.status == TaskStatus::Submitted,
                "Task must be in Submitted status to dispute"
            );

            self.status = TaskStatus::Disputed;

            Runtime::emit_event(DisputeRaisedEvent {
                task_id: self.task_id.clone(),
            });
        }

        /// Resolve a dispute. Only callable by elder/steward badge holder.
        pub fn resolve_dispute(
            &mut self,
            arbiter_proof: Proof,
            ruling: DisputeRuling,
        ) -> (Bucket, Option<Bucket>) {
            assert!(
                self.status == TaskStatus::Disputed,
                "Task must be in Disputed status to resolve"
            );

            // Validate arbiter has a valid Guild badge with elder or steward level
            let checked_proof = arbiter_proof.check(self.badge_resource);
            assert!(
                checked_proof.amount() > Decimal::ZERO,
                "Valid Guild badge required to resolve disputes"
            );

            // Read badge data to verify arbiter is elder or steward
            let nf_ids = checked_proof.as_non_fungible().non_fungible_local_ids();
            let nf_id = nf_ids.into_iter().next()
                .expect("Arbiter proof must contain at least one NFT");
            let nf_rm: NonFungibleResourceManager = self.badge_resource.into();
            let badge_data: GuildBadgeData = nf_rm.get_non_fungible_data(&nf_id);
            assert!(
                badge_data.level == "elder" || badge_data.level == "steward",
                "Only elder or steward badge holders can resolve disputes"
            );

            // Pay arbiter fee from insurance (10% of insurance vault)
            let arbiter_fee_amount = self.insurance_vault.amount() * dec!("0.1");
            let arbiter_fee = self.insurance_vault.take(arbiter_fee_amount);

            let reward_bucket = match ruling.clone() {
                DisputeRuling::PayWorker => {
                    self.status = TaskStatus::Released;
                    self.reward_vault.take_all()
                }
                DisputeRuling::RefundPoster => {
                    self.status = TaskStatus::Refunded;
                    self.reward_vault.take_all()
                }
                DisputeRuling::Split(worker_pct, _poster_pct) => {
                    assert!(
                        worker_pct + _poster_pct == dec!("1"),
                        "Split percentages must sum to 1"
                    );
                    self.status = TaskStatus::Released;
                    // Return the full vault; splitting happens at the manifest level
                    // by taking worker_pct for worker and remainder for poster
                    self.reward_vault.take_all()
                }
            };

            Runtime::emit_event(DisputeResolvedEvent {
                task_id: self.task_id.clone(),
                ruling,
                arbiter_fee: arbiter_fee_amount,
            });

            (reward_bucket, Some(arbiter_fee))
        }

        /// Get current task status.
        pub fn get_status(&self) -> TaskStatus {
            self.status.clone()
        }

        /// Get full task information.
        pub fn get_task_info(&self) -> (String, ComponentAddress, Option<ComponentAddress>, TaskStatus, Decimal, Decimal, u64) {
            (
                self.task_id.clone(),
                self.poster_address,
                self.worker_address,
                self.status.clone(),
                self.reward_vault.amount(),
                self.insurance_vault.amount(),
                self.dispute_window_hours,
            )
        }
    }
}
