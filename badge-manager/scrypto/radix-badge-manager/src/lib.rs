use scrypto::prelude::*;

// ============================================================
// SHARED TYPES
// ============================================================

/// Universal badge data — works for any DAO, any use case.
#[derive(ScryptoSbor, NonFungibleData, Clone)]
pub struct UniversalBadgeData {
    /// Who this badge was issued to
    pub issued_to: String,
    /// Schema name (e.g. "guild_member", "guild_role")
    pub schema_name: String,
    /// When minted (unix seconds)
    pub issued_at: i64,
    /// Current tier
    #[mutable]
    pub tier: String,
    /// Lifecycle status: active, revoked
    #[mutable]
    pub status: String,
    /// Last update timestamp
    #[mutable]
    pub last_updated: i64,
    /// Experience points (gamification)
    #[mutable]
    pub xp: u64,
    /// Human-readable level name
    #[mutable]
    pub level: String,
    /// JSON string for domain-specific data
    #[mutable]
    pub extra_data: String,
}

// ============================================================
// EVENTS
// ============================================================

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct BadgeMintedEvent {
    pub badge_id: NonFungibleLocalId,
    pub issued_to: String,
    pub tier: String,
    pub schema_name: String,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct BadgeRevokedEvent {
    pub badge_id: NonFungibleLocalId,
    pub reason: String,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct TierUpgradedEvent {
    pub badge_id: NonFungibleLocalId,
    pub old_tier: String,
    pub new_tier: String,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct XpUpdatedEvent {
    pub badge_id: NonFungibleLocalId,
    pub new_xp: u64,
    pub new_level: String,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct ManagerCreatedEvent {
    pub manager_address: ComponentAddress,
    pub schema_name: String,
    pub created_at: i64,
}

// ============================================================
// BADGE MANAGER BLUEPRINT
// ============================================================

#[blueprint]
#[events(BadgeMintedEvent, BadgeRevokedEvent, TierUpgradedEvent, XpUpdatedEvent)]
mod badge_manager {
    enable_method_auth! {
        roles {
            admin => updatable_by: [OWNER];
        },
        methods {
            // Public reads
            get_badge_info => PUBLIC;
            get_badge_resource => PUBLIC;
            get_schema_name => PUBLIC;
            get_valid_tiers => PUBLIC;
            get_stats => PUBLIC;
            // Public mint (if enabled)
            public_mint => PUBLIC;
            // Admin writes
            mint_badge => restrict_to: [admin, OWNER];
            revoke_badge => restrict_to: [admin, OWNER];
            update_tier => restrict_to: [admin, OWNER];
            update_xp => restrict_to: [admin, OWNER];
            update_extra_data => restrict_to: [admin, OWNER];
        }
    }

    struct BadgeManager {
        minter_vault: Vault,
        badge_resource: ResourceManager,
        schema_name: String,
        valid_tiers: Vec<String>,
        default_tier: String,
        free_mint_enabled: bool,
        total_minted: u64,
        total_revoked: u64,
    }

    impl BadgeManager {
        /// Instantiate a badge manager. ALL params are primitive types.
        pub fn instantiate(
            schema_name: String,
            valid_tiers: Vec<String>,
            default_tier: String,
            free_mint_enabled: bool,
            badge_name: String,
            badge_description: String,
            dapp_definition: GlobalAddress,
            owner_badge_address: ResourceAddress,
        ) -> Global<BadgeManager> {
            // Internal minter badge
            let minter_badge = ResourceBuilder::new_fungible(OwnerRole::None)
                .divisibility(DIVISIBILITY_NONE)
                .metadata(metadata!(
                    init {
                        "name" => "Badge Manager Internal Minter", locked;
                    }
                ))
                .mint_initial_supply(1);

            let minter_address = minter_badge.resource_address();

            // NonFungible badge resource
            let badge_resource = ResourceBuilder::new_string_non_fungible::<UniversalBadgeData>(
                OwnerRole::Updatable(rule!(require(owner_badge_address))),
            )
            .metadata(metadata!(
                init {
                    "name" => badge_name, locked;
                    "description" => badge_description, locked;
                    "dapp_definitions" => vec![dapp_definition], locked;
                }
            ))
            .mint_roles(mint_roles!(
                minter => rule!(require(minter_address));
                minter_updater => rule!(deny_all);
            ))
            .burn_roles(burn_roles!(
                burner => rule!(require(minter_address));
                burner_updater => rule!(deny_all);
            ))
            .non_fungible_data_update_roles(non_fungible_data_update_roles!(
                non_fungible_data_updater => rule!(require(minter_address));
                non_fungible_data_updater_updater => rule!(deny_all);
            ))
            .create_with_no_initial_supply();

            Self {
                minter_vault: Vault::with_bucket(minter_badge.into()),
                badge_resource: badge_resource.into(),
                schema_name,
                valid_tiers,
                default_tier,
                free_mint_enabled,
                total_minted: 0u64,
                total_revoked: 0u64,
            }
            .instantiate()
            .prepare_to_globalize(OwnerRole::Fixed(rule!(require(owner_badge_address))))
            .enable_component_royalties(component_royalties! {
                init {
                    public_mint => Free, locked;
                    mint_badge => Xrd(1.into()), updatable;
                    revoke_badge => Xrd(dec!("0.5")), updatable;
                    update_tier => Xrd(dec!("0.25")), updatable;
                    update_xp => Xrd(dec!("0.1")), updatable;
                    update_extra_data => Xrd(dec!("0.1")), updatable;
                    get_badge_info => Free, locked;
                    get_badge_resource => Free, locked;
                    get_schema_name => Free, locked;
                    get_valid_tiers => Free, locked;
                    get_stats => Free, locked;
                }
            })
            .globalize()
        }

        /// Free mint — anyone can call. Mints with default tier + member level.
        pub fn public_mint(&mut self, username: String) -> Bucket {
            assert!(self.free_mint_enabled, "Free minting is disabled for this manager");
            assert!(!username.is_empty(), "Username cannot be empty");
            assert!(username.len() <= 64, "Username too long (max 64 chars)");
            self.internal_mint(username, self.default_tier.clone())
        }

        /// Admin mint — specify tier.
        pub fn mint_badge(&mut self, username: String, tier: String) -> Bucket {
            assert!(self.valid_tiers.contains(&tier), "Invalid tier");
            self.internal_mint(username, tier)
        }

        /// Revoke a badge.
        pub fn revoke_badge(&mut self, badge_id: NonFungibleLocalId, reason: String) {
            let now = Clock::current_time_rounded_to_seconds().seconds_since_unix_epoch;
            self.minter_vault.as_fungible().authorize_with_amount(1, || {
                self.badge_resource.update_non_fungible_data(&badge_id, "status", "revoked".to_string());
                self.badge_resource.update_non_fungible_data(&badge_id, "tier", "revoked".to_string());
                self.badge_resource.update_non_fungible_data(&badge_id, "last_updated", now);
            });
            self.total_revoked += 1;
            Runtime::emit_event(BadgeRevokedEvent { badge_id, reason });
        }

        /// Update tier.
        pub fn update_tier(&mut self, badge_id: NonFungibleLocalId, new_tier: String) {
            assert!(self.valid_tiers.contains(&new_tier), "Invalid tier");
            let data: UniversalBadgeData = self.badge_resource.get_non_fungible_data(&badge_id);
            let old_tier = data.tier;
            let now = Clock::current_time_rounded_to_seconds().seconds_since_unix_epoch;
            self.minter_vault.as_fungible().authorize_with_amount(1, || {
                self.badge_resource.update_non_fungible_data(&badge_id, "tier", new_tier.clone());
                self.badge_resource.update_non_fungible_data(&badge_id, "last_updated", now);
            });
            Runtime::emit_event(TierUpgradedEvent { badge_id, old_tier, new_tier });
        }

        /// Update XP and auto-calculate level.
        pub fn update_xp(&mut self, badge_id: NonFungibleLocalId, new_xp: u64) {
            let new_level = match new_xp {
                0..=99 => "member",
                100..=499 => "contributor",
                500..=1999 => "builder",
                2000..=9999 => "steward",
                _ => "elder",
            }.to_string();
            let now = Clock::current_time_rounded_to_seconds().seconds_since_unix_epoch;
            self.minter_vault.as_fungible().authorize_with_amount(1, || {
                self.badge_resource.update_non_fungible_data(&badge_id, "xp", new_xp);
                self.badge_resource.update_non_fungible_data(&badge_id, "level", new_level.clone());
                self.badge_resource.update_non_fungible_data(&badge_id, "last_updated", now);
            });
            Runtime::emit_event(XpUpdatedEvent { badge_id, new_xp, new_level });
        }

        /// Update extra data JSON.
        pub fn update_extra_data(&mut self, badge_id: NonFungibleLocalId, extra_data: String) {
            let now = Clock::current_time_rounded_to_seconds().seconds_since_unix_epoch;
            self.minter_vault.as_fungible().authorize_with_amount(1, || {
                self.badge_resource.update_non_fungible_data(&badge_id, "extra_data", extra_data);
                self.badge_resource.update_non_fungible_data(&badge_id, "last_updated", now);
            });
        }

        /// Get badge data by ID.
        pub fn get_badge_info(&self, badge_id: NonFungibleLocalId) -> UniversalBadgeData {
            self.badge_resource.get_non_fungible_data(&badge_id)
        }

        /// Get the badge resource address.
        pub fn get_badge_resource(&self) -> ResourceAddress {
            self.badge_resource.address()
        }

        /// Get schema name.
        pub fn get_schema_name(&self) -> String {
            self.schema_name.clone()
        }

        /// Get valid tiers.
        pub fn get_valid_tiers(&self) -> Vec<String> {
            self.valid_tiers.clone()
        }

        /// Get manager stats.
        pub fn get_stats(&self) -> (u64, u64) {
            (self.total_minted, self.total_revoked)
        }

        // -- Internal --

        fn internal_mint(&mut self, username: String, tier: String) -> Bucket {
            let now = Clock::current_time_rounded_to_seconds().seconds_since_unix_epoch;

            // Username IS the NFT ID — duplicates naturally prevented by Scrypto
            let sanitized = username.to_lowercase()
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
                .collect::<String>();
            assert!(!sanitized.is_empty(), "Username must contain valid characters");

            let id = StringNonFungibleLocalId::new(
                format!("{}_{}", self.schema_name, sanitized)
            ).expect("Invalid NFT ID — username may already be taken");
            let local_id = NonFungibleLocalId::String(id);

            let badge = self.minter_vault.as_fungible().authorize_with_amount(1, || {
                self.badge_resource.mint_non_fungible(
                    &local_id,
                    UniversalBadgeData {
                        issued_to: username.clone(),
                        schema_name: self.schema_name.clone(),
                        issued_at: now,
                        tier: tier.clone(),
                        status: "active".to_string(),
                        last_updated: now,
                        xp: 0u64,
                        level: "member".to_string(),
                        extra_data: "{}".to_string(),
                    },
                )
            });

            self.total_minted += 1;

            Runtime::emit_event(BadgeMintedEvent {
                badge_id: local_id,
                issued_to: username,
                tier,
                schema_name: self.schema_name.clone(),
            });

            badge
        }
    }
}

// ============================================================
// BADGE FACTORY BLUEPRINT
// ============================================================

#[blueprint]
#[events(ManagerCreatedEvent)]
mod badge_factory {
    use super::badge_manager::BadgeManager;
    enable_method_auth! {
        roles {
            factory_admin => updatable_by: [OWNER];
        },
        methods {
            create_manager => PUBLIC;
            get_manager_count => PUBLIC;
            get_factory_info => PUBLIC;
            pause_factory => restrict_to: [factory_admin, OWNER];
            unpause_factory => restrict_to: [factory_admin, OWNER];
        }
    }

    struct BadgeFactory {
        managers: Vec<ComponentAddress>,
        total_managers: u64,
        paused: bool,
    }

    impl BadgeFactory {
        pub fn instantiate() -> (Global<BadgeFactory>, Bucket) {
            let owner_badge = ResourceBuilder::new_fungible(OwnerRole::None)
                .divisibility(DIVISIBILITY_NONE)
                .metadata(metadata!(
                    init {
                        "name" => "Badge Factory Owner", locked;
                        "description" => "Owner badge for Badge Factory", locked;
                    }
                ))
                .mint_initial_supply(1);

            let component = Self {
                managers: Vec::new(),
                total_managers: 0u64,
                paused: false,
            }
            .instantiate()
            .prepare_to_globalize(OwnerRole::Fixed(
                rule!(require(owner_badge.resource_address())),
            ))
            .metadata(metadata!(
                init {
                    "name" => "Radix Badge Factory", locked;
                    "description" => "Permissionless badge infrastructure for Radix", locked;
                }
            ))
            .enable_component_royalties(component_royalties! {
                init {
                    create_manager => Xrd(5.into()), updatable;
                    get_manager_count => Free, locked;
                    get_factory_info => Free, locked;
                    pause_factory => Free, locked;
                    unpause_factory => Free, locked;
                }
            })
            .globalize();

            (component, owner_badge.into())
        }

        /// Create a new badge manager. Returns (manager, admin_badge).
        /// All params are primitive types — no custom structs cross the boundary.
        pub fn create_manager(
            &mut self,
            schema_name: String,
            valid_tiers: Vec<String>,
            default_tier: String,
            free_mint_enabled: bool,
            badge_name: String,
            badge_description: String,
            dapp_definition: GlobalAddress,
        ) -> (Global<BadgeManager>, Bucket) {
            assert!(!self.paused, "Factory is paused");
            assert!(!schema_name.is_empty(), "Schema name required");
            assert!(!valid_tiers.is_empty(), "Need at least one tier");
            assert!(valid_tiers.contains(&default_tier), "Default tier must be in valid_tiers");

            // Create admin badge for the caller
            let admin_badge = ResourceBuilder::new_fungible(OwnerRole::None)
                .divisibility(DIVISIBILITY_NONE)
                .metadata(metadata!(
                    init {
                        "name" => format!("{} Admin", badge_name), locked;
                    }
                ))
                .mint_initial_supply(1);

            let admin_address = admin_badge.resource_address();

            // Instantiate manager with primitives only
            let manager = BadgeManager::instantiate(
                schema_name.clone(),
                valid_tiers,
                default_tier,
                free_mint_enabled,
                badge_name,
                badge_description,
                dapp_definition,
                admin_address,
            );

            let manager_address: ComponentAddress = manager.address().into();
            self.managers.push(manager_address);
            self.total_managers += 1;

            let now = Clock::current_time_rounded_to_seconds().seconds_since_unix_epoch;
            Runtime::emit_event(ManagerCreatedEvent {
                manager_address,
                schema_name,
                created_at: now,
            });

            (manager, admin_badge.into())
        }

        pub fn get_manager_count(&self) -> u64 {
            self.total_managers
        }

        pub fn get_factory_info(&self) -> (u64, bool) {
            (self.total_managers, self.paused)
        }

        pub fn pause_factory(&mut self) {
            self.paused = true;
        }

        pub fn unpause_factory(&mut self) {
            self.paused = false;
        }
    }
}
