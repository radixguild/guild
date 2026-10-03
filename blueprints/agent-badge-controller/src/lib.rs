use scrypto::prelude::*;

#[derive(ScryptoSbor, NonFungibleData, Clone)]
pub struct AgentBadgeData {
    pub agent_name: String,
    pub radix_address: String,
    pub issued_at: i64,
    pub spending_limit_per_task: Decimal,
    pub daily_spending_cap: Decimal,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct AgentBadgeMintedEvent {
    pub badge_id: u64,
    pub agent_name: String,
    pub radix_address: String,
    pub spending_limit_per_task: Decimal,
    pub daily_spending_cap: Decimal,
}

// Factory + ID allocator for Guild agent badges.
//
// Owns badge minting (centralised next_badge_id allocation, consistent data shape,
// event emission). Recall is NOT a blueprint method — it's a manifest-level engine
// instruction (`recall_non_fungibles` on the vault holding the badge), gated by the
// owner badge proof + the `recall_roles` config baked into the resource at creation.
// Badge data is fully immutable post-mint; no soft "revoked" status flag — the kill
// switch is the recall itself (badge absent from agent vault).
//
// One-shot deployment: operator calls instantiate(), banks the owner badge, then
// uses the component for mints and direct manifests for recalls.
#[blueprint]
#[events(AgentBadgeMintedEvent)]
// PQC: The OWNER role badge is fungible and authorizes mint_agent_badge.
// Ownership is gated by secp256k1 account keys (quantum-vulnerable via Shor's).
// When Radix supports PQ account keys, the OwnerRole::Fixed rule auto-inherits
// the new key type — no migration needed in this blueprint. The badge resource
// itself uses OwnerRole::None (immutable metadata, recall via engine
// instruction), so no direct upgrade path is required.
mod agent_badge_controller {
    enable_method_auth! {
        methods {
            mint_agent_badge => restrict_to: [OWNER];
            get_agent_badge_resource => PUBLIC;
            get_next_badge_id => PUBLIC;
            get_total_minted => PUBLIC;
        }
    }

    struct AgentBadgeController {
        agent_badge_resource: ResourceAddress,
        agent_badge_manager: NonFungibleResourceManager,
        next_badge_id: u64,
        total_minted: u64,
    }

    impl AgentBadgeController {
        /// Instantiate the controller.
        ///
        /// Creates:
        /// - the recallable AgentBadge resource (engine-level kill switch enabled via recall_roles)
        /// - a one-of owner badge that gates mint, metadata-update, burn, and recall
        ///
        /// Returns (component, owner_badge). Operator must securely vault the owner badge —
        /// it is the recall authority. There is no recovery if it is lost.
        pub fn instantiate() -> (Global<AgentBadgeController>, Bucket) {
            // The badge's minter role must be the COMPONENT, not the owner
            // badge: caller proofs do not propagate into the component's call
            // frame (Babylon auth-zone isolation), so an owner-badge minter
            // rule makes mint_agent_badge permanently Unauthorized. Operator
            // gating stays at the method layer (restrict_to: [OWNER]).
            let (address_reservation, component_address) =
                Runtime::allocate_component_address(AgentBadgeController::blueprint_id());

            let owner_badge = ResourceBuilder::new_fungible(OwnerRole::None)
                .divisibility(DIVISIBILITY_NONE)
                .metadata(metadata!(
                    init {
                        "name" => "Agent Badge Controller Owner", locked;
                        "description" => "Operator authority for minting and recalling Guild agent badges", locked;
                    }
                ))
                .mint_initial_supply(1);

            let owner_badge_address = owner_badge.resource_address();

            let agent_badge_manager =
                ResourceBuilder::new_integer_non_fungible::<AgentBadgeData>(OwnerRole::Fixed(
                    rule!(require(owner_badge_address)),
                ))
                .metadata(metadata!(
                    init {
                        "name" => "Guild Agent Badge", locked;
                        "description" => "Recallable identity badge for Guild agents — engine-level kill switch", locked;
                        "symbol" => "GAGENT", locked;
                    }
                ))
                .recall_roles(recall_roles!(
                    recaller => rule!(require(owner_badge_address));
                    recaller_updater => rule!(deny_all);
                ))
                .withdraw_roles(withdraw_roles!(
                    withdrawer => rule!(deny_all);
                    withdrawer_updater => rule!(deny_all);
                ))
                .deposit_roles(deposit_roles!(
                    depositor => rule!(allow_all);
                    depositor_updater => rule!(deny_all);
                ))
                .mint_roles(mint_roles!(
                    minter => rule!(require(global_caller(component_address)));
                    minter_updater => rule!(deny_all);
                ))
                .burn_roles(burn_roles!(
                    burner => rule!(require(owner_badge_address));
                    burner_updater => rule!(deny_all);
                ))
                .non_fungible_data_update_roles(non_fungible_data_update_roles!(
                    non_fungible_data_updater => rule!(deny_all);
                    non_fungible_data_updater_updater => rule!(deny_all);
                ))
                .create_with_no_initial_supply();

            let agent_badge_resource = agent_badge_manager.address();

            let component = Self {
                agent_badge_resource,
                agent_badge_manager,
                next_badge_id: 1,
                total_minted: 0,
            }
            .instantiate()
            .prepare_to_globalize(OwnerRole::Fixed(rule!(require(owner_badge_address))))
            .with_address(address_reservation)
            .globalize();

            (component, owner_badge.into())
        }

        /// Mint a new agent badge.
        ///
        /// Returns the badge as a Bucket; manifest must deposit it to the agent's account.
        /// Caller must present owner badge proof.
        pub fn mint_agent_badge(
            &mut self,
            agent_name: String,
            radix_address: String,
            spending_limit_per_task: Decimal,
            daily_spending_cap: Decimal,
        ) -> Bucket {
            assert!(!agent_name.is_empty(), "agent_name must not be empty");
            assert!(!radix_address.is_empty(), "radix_address must not be empty");
            assert!(
                spending_limit_per_task > Decimal::ZERO,
                "spending_limit_per_task must be positive"
            );
            assert!(
                daily_spending_cap > Decimal::ZERO,
                "daily_spending_cap must be positive"
            );
            assert!(
                daily_spending_cap >= spending_limit_per_task,
                "daily_spending_cap must be >= spending_limit_per_task"
            );

            let badge_id = self.next_badge_id;
            self.next_badge_id = self
                .next_badge_id
                .checked_add(1)
                .expect("badge_id overflow");
            self.total_minted = self
                .total_minted
                .checked_add(1)
                .expect("total_minted overflow");

            let now = Clock::current_time_rounded_to_seconds().seconds_since_unix_epoch;

            let badge = self.agent_badge_manager.mint_non_fungible(
                &NonFungibleLocalId::integer(badge_id),
                AgentBadgeData {
                    agent_name: agent_name.clone(),
                    radix_address: radix_address.clone(),
                    issued_at: now,
                    spending_limit_per_task,
                    daily_spending_cap,
                },
            );

            Runtime::emit_event(AgentBadgeMintedEvent {
                badge_id,
                agent_name,
                radix_address,
                spending_limit_per_task,
                daily_spending_cap,
            });

            badge.into()
        }

        pub fn get_agent_badge_resource(&self) -> ResourceAddress {
            self.agent_badge_resource
        }

        pub fn get_next_badge_id(&self) -> u64 {
            self.next_badge_id
        }

        pub fn get_total_minted(&self) -> u64 {
            self.total_minted
        }
    }
}
