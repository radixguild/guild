use scrypto::prelude::*;

// ── NFT swap — an atomic listing, not a task escrow (P7-02, task 90) ─────────
//
// Implements docs/design/nft-swap.md §3-§5 as a STANDALONE blueprint in this
// SAME Scrypto package. It shares the receipt-NFT + internal-minter +
// royalty-dial PATTERNS with `guild_marketplace_escrow` (copied, not
// refactored into a common module — the task instruction is explicit: do not
// touch the live escrow's behaviour). None of the task machinery (claim bond,
// insurance, review window, dispute/arbiter) applies: a swap has no time gap
// between payment and asset, so Radix atomicity is the whole guarantee.
//
// RULINGS this file implements (task 90 DELIVER section, which AMENDS the
// design doc's still-open §8 decide-boxes — the doc is `status: proposal`
// and its boxes were never checked):
//   S1a — the ask model is `Fungible{resource, amount} | NonFungible{resource,
//         id}`, and `list` takes `Vec<Ask>` as an AnyOf (the buyer names which
//         alternative they fill).
//   S2  — expiry is MANDATORY (this reverses the doc's S2a "optional,
//         default none" recommendation). `list` asserts `expires_at` is in
//         the future and at most 30 days out; `extend_listing` adds exactly
//         30 days per call and carries its OWN royalty entry, separate from
//         `fill`'s.
//   S3a — `fill` and `extend_listing` both start their royalty at `Xrd(0)`,
//         `updatable`; every other method is `Free, locked`.
//   S4a — same custody shape as the escrow: owner badge is the royalty
//         claimer, a separate royalty-admin badge is the setter/locker.
//   S6a — self-fill is allowed. `fill` takes no caller-identity proof at
//         all, so there is nothing to check here — the absence of a guard
//         IS the ruling.

// ── Types ──────────────────────────────────────────────────────────────────

/// One alternative a seller will accept. `list` stores `Vec<Ask>` as an
/// AnyOf: the buyer picks ONE alternative index at `fill` time and must
/// present exactly that alternative's payment — no partial fills, no change
/// (nft-swap.md §2 "Partial fills / change: never").
///
/// `ManifestSbor` because this crosses the manifest boundary as a `list`
/// argument, same reason `DisputeRuling` carries it in the escrow.
#[derive(ScryptoSbor, ManifestSbor, Clone, Debug, PartialEq)]
pub enum Ask {
    Fungible { resource: ResourceAddress, amount: Decimal },
    NonFungible { resource: ResourceAddress, id: NonFungibleLocalId },
}

#[derive(ScryptoSbor, Clone, Debug, PartialEq)]
pub enum ListingState {
    Listed,
    Filled,
    Cancelled,
}

#[derive(ScryptoSbor, Clone)]
pub struct Listing {
    /// Global account, pinned at `list` — the ONLY destination
    /// `withdraw_proceeds` will ever pay. A caller-supplied payee is safe
    /// here for the same reason it is in the escrow's `create_task`: `list`
    /// consumes the seller's own asset in the same call that reads `seller`,
    /// so a wrong value can only misdirect the designator's own proceeds.
    pub seller: ComponentAddress,
    pub asset_resource: ResourceAddress,
    pub asset_id: NonFungibleLocalId,
    /// ≥1 alternatives (AnyOf). Never empty — `list` asserts it.
    pub asks: Vec<Ask>,
    pub created_at: Instant,
    /// MANDATORY (S2). No `Option` — a `Listing` with no expiry cannot be
    /// constructed at all, which is the state-shape argument this repo
    /// prefers over a runtime check nothing else enforces.
    pub expires_at: Instant,
    pub state: ListingState,
    /// Index into `asks` of the alternative that filled it. `Some` iff
    /// `state == Filled`.
    pub filled_with: Option<u8>,
    pub proceeds_withdrawn: bool,
}

/// The seller's credential — required to `cancel`, `extend_listing` and
/// `withdraw_proceeds`. Local id = listing id, mirroring `TaskReceiptData`.
/// `seller` is carried on the NFT data for an off-chain reader's
/// convenience; the METHODS below read `Listing.seller` (the live,
/// authoritative copy) rather than decoding this, exactly as the escrow
/// reads `TaskInfo.poster` rather than `TaskReceiptData.poster`.
#[derive(ScryptoSbor, NonFungibleData, Clone)]
pub struct ListingReceiptData {
    pub listing_id: u64,
    pub seller: ComponentAddress,
}

#[derive(ScryptoSbor, Clone, Debug, PartialEq)]
pub struct NftSwapConfig {
    pub listing_receipt_resource: ResourceAddress,
    /// The S2 ceiling `list` enforces on `expires_at`, in seconds. Also the
    /// exact amount `extend_listing` adds per call — see the constant's own
    /// comment for why one number serves both.
    pub max_listing_horizon_secs: u64,
    pub extension_secs: u64,
}

// ── Events ───────────────────────────────────────────────────────────────────

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct NftSwapInstantiatedEvent {
    pub owner_badge_resource: ResourceAddress,
    pub royalty_admin_badge_resource: ResourceAddress,
    pub listing_receipt_resource: ResourceAddress,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct ListedEvent {
    pub listing_id: u64,
    pub seller: ComponentAddress,
    pub asset_resource: ResourceAddress,
    pub asset_id: NonFungibleLocalId,
    pub asks: Vec<Ask>,
    pub expires_at: Instant,
}

/// No `buyer` field, unlike the design note's sketch (§4 row for `fill`).
/// `fill` takes no caller-identity Proof and returns the asset bucket
/// straight to the manifest — the component genuinely does not know who
/// deposits it, the same reason `push_entitlement` in the escrow cannot name
/// a caller either. Recording a field this method cannot honestly populate
/// would be worse than omitting it.
#[derive(ScryptoSbor, ScryptoEvent)]
pub struct FilledEvent {
    pub listing_id: u64,
    pub alternative: u8,
    pub resource: ResourceAddress,
    pub amount: Decimal,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct CancelledEvent {
    pub listing_id: u64,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct ExtendedEvent {
    pub listing_id: u64,
    pub expires_at: Instant,
}

#[derive(ScryptoSbor, ScryptoEvent)]
pub struct ProceedsWithdrawnEvent {
    pub listing_id: u64,
    pub resource: ResourceAddress,
    pub amount: Decimal,
    pub destination: ComponentAddress,
}

// ── Blueprint ────────────────────────────────────────────────────────────────

#[blueprint]
#[events(
    NftSwapInstantiatedEvent,
    ListedEvent,
    FilledEvent,
    CancelledEvent,
    ExtendedEvent,
    ProceedsWithdrawnEvent
)]
mod nft_swap_blueprint {
    enable_method_auth! {
        methods {
            list => PUBLIC;
            fill => PUBLIC;
            cancel => PUBLIC;
            extend_listing => PUBLIC;
            withdraw_proceeds => PUBLIC;
            burn_listing_receipt => PUBLIC;
            get_listing => PUBLIC;
            get_config => PUBLIC;
            get_proceeds => PUBLIC;
        }
    }

    struct NftSwap {
        listings: KeyValueStore<u64, Listing>,
        /// Holds exactly the one escrowed NFT while `Listed`, empty
        /// otherwise. A generic `Vault` (not a persisted `NonFungibleVault`
        /// field) so `put`/`take_all` match the rest of this file's style;
        /// `.as_non_fungible()` gives the typed view where one is needed.
        asset_vaults: KeyValueStore<u64, Vault>,
        /// Created lazily AT FILL, not eagerly at `list` like the escrow's
        /// settlement vaults — unlike a task's reward token (fixed at
        /// create_task), a listing's payment resource is not known until the
        /// buyer picks an alternative.
        proceeds_vaults: KeyValueStore<u64, Vault>,
        next_listing_id: u64,
        listing_receipt_manager: NonFungibleResourceManager,
        internal_minter_vault: Vault,
    }

    impl NftSwap {
        /// Mints owner + royalty-admin + internal-minter badges exactly as
        /// `guild_marketplace_escrow::instantiate` does (same three-badge
        /// shape, same reasoning — see that method's doc for the
        /// `Updatable` OwnerRole trade-off, which applies unchanged here).
        /// Creates the listing-receipt resource. Returns `(component,
        /// owner_badge, royalty_admin_badge)` — the deploy manifest must
        /// route BOTH badge buckets, same as the escrow.
        pub fn instantiate() -> (Global<NftSwap>, Bucket, Bucket) {
            let owner_badge: Bucket = ResourceBuilder::new_fungible(OwnerRole::None)
                .divisibility(DIVISIBILITY_NONE)
                .metadata(metadata!(
                    init {
                        "name" => "Guild NFT Swap Owner Badge", locked;
                        "description" => "Royalty-claim authority for guild-nft-swap", locked;
                    }
                ))
                .mint_initial_supply(1)
                .into();
            let owner_badge_address = owner_badge.resource_address();

            let royalty_admin_badge: Bucket = ResourceBuilder::new_fungible(OwnerRole::None)
                .divisibility(DIVISIBILITY_NONE)
                .metadata(metadata!(
                    init {
                        "name" => "Guild NFT Swap Royalty Admin Badge", locked;
                        "description" => "Royalty dial + lock authority for guild-nft-swap (fill, extend_listing only — every other method is Free, locked forever)", locked;
                    }
                ))
                .mint_initial_supply(1)
                .into();
            let royalty_admin_address = royalty_admin_badge.resource_address();

            let internal_minter: Bucket = ResourceBuilder::new_fungible(OwnerRole::None)
                .divisibility(DIVISIBILITY_NONE)
                .metadata(metadata!(
                    init {
                        "name" => "Guild NFT Swap Internal Minter", locked;
                    }
                ))
                .mint_initial_supply(1)
                .into();
            let internal_minter_address = internal_minter.resource_address();

            let listing_receipt_manager = ResourceBuilder::new_integer_non_fungible::<ListingReceiptData>(
                OwnerRole::Fixed(rule!(require(owner_badge_address))),
            )
            .metadata(metadata!(
                init {
                    "name" => "Guild NFT Swap Listing Receipt", locked;
                    "description" => "Proves listing ownership; required to cancel, extend or withdraw proceeds", locked;
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
            let listing_receipt_resource = listing_receipt_manager.address();

            let component = Self {
                listings: KeyValueStore::new(),
                asset_vaults: KeyValueStore::new(),
                proceeds_vaults: KeyValueStore::new(),
                next_listing_id: 1,
                listing_receipt_manager,
                internal_minter_vault: Vault::with_bucket(internal_minter),
            }
            .instantiate()
            .prepare_to_globalize(OwnerRole::Updatable(rule!(require(
                owner_badge_address
            ))))
            // S3a / S4a: `fill` and `extend_listing` are the only two
            // updatable, XRD-denominated dials, both starting at 0 — the
            // same "structure now, tune later" posture as the escrow's
            // `create_task` dial. Every other method is Free and LOCKED
            // forever: none of them should ever be taxable (listing your
            // own asset, cancelling it, collecting your own proceeds,
            // reading state).
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
                    fill => Xrd(Decimal::ZERO), updatable;
                    extend_listing => Xrd(Decimal::ZERO), updatable;
                    list => Free, locked;
                    cancel => Free, locked;
                    withdraw_proceeds => Free, locked;
                    burn_listing_receipt => Free, locked;
                    get_listing => Free, locked;
                    get_config => Free, locked;
                    get_proceeds => Free, locked;
                }
            })
            .globalize();

            Runtime::emit_event(NftSwapInstantiatedEvent {
                owner_badge_resource: owner_badge_address,
                royalty_admin_badge_resource: royalty_admin_address,
                listing_receipt_resource,
            });

            (component, owner_badge, royalty_admin_badge)
        }

        /// List one NFT for sale against ≥1 ask alternatives. Mints the
        /// listing receipt to the CALLER (a transferable bearer credential,
        /// same convention as the escrow's task receipt) and escrows the
        /// asset. Every alternative is validated up front so a listing can
        /// never sit un-fillable by construction (a zero-amount ask, a
        /// duplicate alternative, an amount the resource cannot express).
        pub fn list(
            &mut self,
            seller: ComponentAddress,
            asset: NonFungibleBucket,
            asks: Vec<Ask>,
            expires_at: Instant,
        ) -> Bucket {
            assert_eq!(asset.amount(), Decimal::ONE, "listing must escrow exactly one NFT");
            assert!(!asks.is_empty(), "at least one ask alternative is required");

            for (i, ask) in asks.iter().enumerate() {
                match ask {
                    Ask::Fungible { resource, amount } => {
                        assert!(*amount > Decimal::ZERO, "fungible ask amount must be positive");
                        let divisibility = Self::token_divisibility(*resource);
                        assert_eq!(
                            *amount,
                            amount
                                .checked_round(divisibility as i32, RoundingMode::ToZero)
                                .expect("ask amount rounding overflowed"),
                            "fungible ask amount exceeds the resource's divisibility"
                        );
                    }
                    Ask::NonFungible { .. } => {}
                }
                assert!(
                    !asks[(i + 1)..].contains(ask),
                    "duplicate ask alternatives are not allowed"
                );
            }

            // PAYEE PIN, same argument as create_task's poster check: list
            // consumes the seller's own asset in this same call, so a wrong
            // value can only misdirect the designator's own proceeds later.
            assert!(
                seller
                    .as_node_id()
                    .entity_type()
                    .is_some_and(|t| t.is_global_account()),
                "seller must be a global account address"
            );

            let now = Clock::current_time_rounded_to_seconds();
            assert!(
                expires_at.seconds_since_unix_epoch > now.seconds_since_unix_epoch,
                "expires_at must be in the future"
            );
            let max_expiry_secs = now
                .seconds_since_unix_epoch
                .checked_add(MAX_LISTING_HORIZON_SECS)
                .expect("expiry horizon overflow");
            assert!(
                expires_at.seconds_since_unix_epoch <= max_expiry_secs,
                "expires_at must be at most 30 days out (S2 — mandatory expiry ceiling)"
            );

            let listing_id = self.next_listing_id;
            self.next_listing_id = self.next_listing_id.checked_add(1).expect("listing_id overflow");

            let asset_resource = asset.resource_address();
            let asset_id = asset.non_fungible_local_id();

            self.asset_vaults.insert(listing_id, Vault::with_bucket(asset.into()));

            self.listings.insert(
                listing_id,
                Listing {
                    seller,
                    asset_resource,
                    asset_id: asset_id.clone(),
                    asks: asks.clone(),
                    created_at: now,
                    expires_at,
                    state: ListingState::Listed,
                    filled_with: None,
                    proceeds_withdrawn: false,
                },
            );

            let receipt: Bucket = self
                .internal_minter_vault
                .as_fungible()
                .authorize_with_amount(dec!("1"), || {
                    self.listing_receipt_manager.mint_non_fungible(
                        &NonFungibleLocalId::integer(listing_id),
                        ListingReceiptData { listing_id, seller },
                    )
                })
                .into();

            Runtime::emit_event(ListedEvent {
                listing_id,
                seller,
                asset_resource,
                asset_id,
                asks,
                expires_at,
            });

            self.assert_conservation(listing_id);

            receipt
        }

        /// Fill a listing with the alternative at index `alternative`.
        /// PUBLIC and unauthenticated by design (S6a — self-fill allowed,
        /// and there is no caller identity to check even if it were not):
        /// anyone whose payment matches an alternative EXACTLY gets the
        /// asset, atomically, in this transaction. The payment moves into a
        /// per-listing proceeds vault rather than straight to the seller —
        /// see nft-swap.md §4's "why the payment goes to a vault" note: a
        /// seller's account rules must never be able to abort a buyer's
        /// fill.
        pub fn fill(&mut self, listing_id: u64, alternative: u8, payment: Bucket) -> NonFungibleBucket {
            let ask = {
                let listing = self.listings.get(&listing_id).expect("listing not found");
                assert_eq!(listing.state, ListingState::Listed, "listing is not Listed");
                let now = Clock::current_time_rounded_to_seconds();
                assert!(
                    now.seconds_since_unix_epoch < listing.expires_at.seconds_since_unix_epoch,
                    "listing has expired"
                );
                let idx = alternative as usize;
                assert!(idx < listing.asks.len(), "alternative index out of range");
                listing.asks[idx].clone()
            };

            match &ask {
                Ask::Fungible { resource, amount } => {
                    assert_eq!(payment.resource_address(), *resource, "payment resource does not match the chosen alternative");
                    assert_eq!(payment.amount(), *amount, "payment amount does not match the chosen alternative");
                }
                Ask::NonFungible { resource, id } => {
                    assert_eq!(payment.resource_address(), *resource, "payment resource does not match the chosen alternative");
                    assert_eq!(payment.amount(), Decimal::ONE, "payment must be exactly the one NFT the alternative names");
                    let paid_id = payment.as_non_fungible().non_fungible_local_id();
                    assert_eq!(&paid_id, id, "payment NFT id does not match the chosen alternative");
                }
            }

            let resource = payment.resource_address();
            let amount = payment.amount();
            // Created HERE, lazily — the listing's ask list can name several
            // different resources and only the FILLED one ever needs a
            // vault. Never overwritten: `Listed -> Filled` is a one-way
            // transition, so this insert cannot collide with an existing
            // vault for the same listing_id.
            self.proceeds_vaults.insert(listing_id, Vault::with_bucket(payment));

            {
                let mut listing = self.listings.get_mut(&listing_id).unwrap();
                listing.state = ListingState::Filled;
                listing.filled_with = Some(alternative);
            }

            let asset_bucket = self
                .asset_vaults
                .get_mut(&listing_id)
                .expect("asset vault missing — list() pins it")
                .take_all();
            let asset: NonFungibleBucket = asset_bucket.as_non_fungible();

            Runtime::emit_event(FilledEvent { listing_id, alternative, resource, amount });

            self.assert_conservation(listing_id);

            asset
        }

        /// Cancel a `Listed` listing at ANY time, including after expiry —
        /// an expired listing is not fillable but its asset must never be
        /// stranded, so cancel stays open regardless of the clock. Returns
        /// the asset to whoever presents the listing receipt; the receipt
        /// itself is not burned (retire it with `burn_listing_receipt`).
        pub fn cancel(&mut self, receipt: Proof) -> NonFungibleBucket {
            let listing_id = self.listing_id_from_receipt(receipt);

            {
                let mut listing = self.listings.get_mut(&listing_id).expect("listing not found");
                assert_eq!(listing.state, ListingState::Listed, "listing is not Listed");
                listing.state = ListingState::Cancelled;
            }

            let asset_bucket = self
                .asset_vaults
                .get_mut(&listing_id)
                .expect("asset vault missing — list() pins it")
                .take_all();
            let asset: NonFungibleBucket = asset_bucket.as_non_fungible();

            Runtime::emit_event(CancelledEvent { listing_id });
            self.assert_conservation(listing_id);

            asset
        }

        /// S2: pushes `expires_at` out by exactly 30 days from
        /// `max(now, current expires_at)` — the `max` means an already-
        /// expired-but-not-yet-cancelled Listed listing extends from NOW,
        /// not from its stale deadline, so one call always buys a full 30
        /// days of fillability rather than however much of the old window
        /// happened to remain. `Listed` only: a Filled or Cancelled listing
        /// has nothing left to extend. Carries its OWN royalty entry
        /// (`extend_listing`), separate from `fill`'s — the ruling's whole
        /// point is that repeated free extensions would be a spam vector a
        /// shared dial with `fill` could not price independently.
        pub fn extend_listing(&mut self, receipt: Proof) {
            let listing_id = self.listing_id_from_receipt(receipt);

            let mut listing = self.listings.get_mut(&listing_id).expect("listing not found");
            assert_eq!(listing.state, ListingState::Listed, "listing is not Listed");

            let now = Clock::current_time_rounded_to_seconds();
            let base = now.seconds_since_unix_epoch.max(listing.expires_at.seconds_since_unix_epoch);
            let new_expiry = Instant::new(
                base.checked_add(THIRTY_DAYS_SECS).expect("expiry extension overflow"),
            );
            listing.expires_at = new_expiry;
            drop(listing);

            Runtime::emit_event(ExtendedEvent { listing_id, expires_at: new_expiry });
        }

        /// Pull the filled proceeds into the pinned seller account. Refuses
        /// unless `Filled` and not already withdrawn — the idempotent
        /// refusal on a second call. If the seller's account rejects the
        /// deposit (a third-party-deposit-denying rule, say), this whole
        /// call reverts and the entitlement survives untouched: the seller
        /// fixes their account and retries, out only a fee — same recovery
        /// shape as the escrow's `withdraw_worker`/`withdraw_poster`.
        pub fn withdraw_proceeds(&mut self, receipt: Proof) {
            let listing_id = self.listing_id_from_receipt(receipt);

            let seller = {
                let listing = self.listings.get(&listing_id).expect("listing not found");
                assert_eq!(listing.state, ListingState::Filled, "listing is not Filled");
                assert!(!listing.proceeds_withdrawn, "proceeds already withdrawn");
                listing.seller
            };

            let funds = self
                .proceeds_vaults
                .get_mut(&listing_id)
                .expect("proceeds vault missing on a Filled listing")
                .take_all();
            let resource = funds.resource_address();
            let amount = funds.amount();

            let mut account: Global<Account> = seller.into();
            account.try_deposit_or_abort(funds, None);

            self.listings.get_mut(&listing_id).unwrap().proceeds_withdrawn = true;

            Runtime::emit_event(ProceedsWithdrawnEvent {
                listing_id,
                resource,
                amount,
                destination: seller,
            });

            self.assert_conservation(listing_id);
        }

        /// Retire a spent listing receipt. Only once the listing is
        /// terminal AND — for a `Filled` listing — nothing is left
        /// withdrawable, mirroring `burn_task_receipt`'s guard exactly: the
        /// receipt is the only credential that can `cancel`,
        /// `extend_listing` or `withdraw_proceeds`, and burning it early
        /// strands everything behind it permanently.
        pub fn burn_listing_receipt(&mut self, receipt: Bucket) {
            assert_eq!(
                receipt.resource_address(),
                self.listing_receipt_manager.address(),
                "wrong receipt resource"
            );
            assert_eq!(receipt.amount(), dec!("1"), "must present exactly 1 receipt");

            let local_id = receipt.as_non_fungible().non_fungible_local_id();
            let listing_id = Self::listing_id_from_local_id(&local_id);

            if let Some(listing) = self.listings.get(&listing_id) {
                let state = listing.state.clone();
                let withdrawn = listing.proceeds_withdrawn;
                drop(listing);
                match state {
                    ListingState::Listed => Runtime::panic(
                        "cannot burn the receipt while the listing is still Listed — cancel first"
                            .to_string(),
                    ),
                    ListingState::Filled => assert!(
                        withdrawn,
                        "cannot burn the receipt while proceeds are still owed — withdraw first"
                    ),
                    ListingState::Cancelled => {}
                }
            }

            self.internal_minter_vault.as_fungible().authorize_with_amount(dec!("1"), || {
                receipt.burn();
            });
        }

        // ── Views ────────────────────────────────────────────────────────

        pub fn get_listing(&self, listing_id: u64) -> Option<Listing> {
            self.listings.get(&listing_id).map(|l| l.clone())
        }

        pub fn get_config(&self) -> NftSwapConfig {
            NftSwapConfig {
                listing_receipt_resource: self.listing_receipt_manager.address(),
                max_listing_horizon_secs: MAX_LISTING_HORIZON_SECS as u64,
                extension_secs: THIRTY_DAYS_SECS as u64,
            }
        }

        /// `(resource, amount)` currently held in the listing's proceeds
        /// vault. `None` before a fill (the vault does not exist yet — see
        /// the "created lazily" note on `fill`) and after a successful
        /// withdrawal drains it to zero, so a caller cannot tell "never
        /// filled" apart from "filled and withdrawn" from this view alone —
        /// `get_listing`'s `state` + `proceeds_withdrawn` is the
        /// disambiguator, same division of labour as the escrow's
        /// `get_settlement_balances` next to `get_entitlements`.
        pub fn get_proceeds(&self, listing_id: u64) -> Option<(ResourceAddress, Decimal)> {
                self.proceeds_vaults
                    .get(&listing_id)
                    .map(|v| (v.resource_address(), v.amount()))
        }

        // ── Internal helpers ─────────────────────────────────────────────

        /// A fungible resource's divisibility. Panics on a non-fungible,
        /// same contract as the escrow's `token_divisibility` — nothing
        /// here should ever route a `Fungible` ask through a non-fungible
        /// resource.
        fn token_divisibility(resource: ResourceAddress) -> u8 {
            match ResourceManager::from(resource).resource_type() {
                ResourceType::Fungible { divisibility } => divisibility,
                ResourceType::NonFungible { .. } => panic!("ask resource must be fungible"),
            }
        }

        /// Resolve a listing id from a receipt Proof, asserting its
        /// resource first. `skip_checking` is safe immediately after that
        /// assert, same pattern as `cancel_task`/`withdraw_poster` in the
        /// escrow.
        fn listing_id_from_receipt(&self, receipt: Proof) -> u64 {
            assert_eq!(
                receipt.resource_address(),
                self.listing_receipt_manager.address(),
                "wrong receipt resource"
            );
            let local_id = receipt
                .skip_checking()
                .as_non_fungible()
                .non_fungible_local_id();
            Self::listing_id_from_local_id(&local_id)
        }

        fn listing_id_from_local_id(local_id: &NonFungibleLocalId) -> u64 {
            match local_id {
                NonFungibleLocalId::Integer(i) => i.value() as u64,
                _ => Runtime::panic("listing receipt has non-integer local id".to_string()),
            }
        }

        /// The conservation invariant (nft-swap.md §3), ENFORCED after
        /// every mutation rather than merely documented — same discipline
        /// as the escrow's `assert_conservation`, and the same reason: a
        /// failed transaction here is far cheaper than the drift watcher
        /// finding it hours later.
        ///
        /// Three properties, one per listing:
        ///   1. The asset is held iff the listing is `Listed`.
        ///   2. The proceeds vault is non-empty iff `Filled` and not yet
        ///      withdrawn.
        ///   3. A `Filled` listing's `filled_with` names an alternative
        ///      whose resource equals the proceeds vault's resource.
        fn assert_conservation(&self, listing_id: u64) {
            let listing = self.listings.get(&listing_id).expect("listing not found");
            let asset_held = self
                .asset_vaults
                .get(&listing_id)
                .map(|v| v.amount())
                .unwrap_or(Decimal::ZERO);
            let proceeds_amount = self
                .proceeds_vaults
                .get(&listing_id)
                .map(|v| v.amount())
                .unwrap_or(Decimal::ZERO);

            match listing.state {
                ListingState::Listed => {
                    assert_eq!(
                        asset_held,
                        Decimal::ONE,
                        "conservation: a Listed listing must hold exactly its asset"
                    );
                    assert_eq!(
                        proceeds_amount,
                        Decimal::ZERO,
                        "conservation: a Listed listing must have no proceeds"
                    );
                }
                ListingState::Filled => {
                    assert_eq!(
                        asset_held,
                        Decimal::ZERO,
                        "conservation: a Filled listing must not still hold the asset"
                    );
                    if listing.proceeds_withdrawn {
                        assert_eq!(
                            proceeds_amount,
                            Decimal::ZERO,
                            "conservation: withdrawn proceeds must leave the vault empty"
                        );
                    } else {
                        assert!(
                            proceeds_amount > Decimal::ZERO,
                            "conservation: a Filled, unwithdrawn listing must hold proceeds"
                        );
                        let idx = listing
                            .filled_with
                            .expect("conservation: a Filled listing must record filled_with")
                            as usize;
                        let ask_resource = match &listing.asks[idx] {
                            Ask::Fungible { resource, .. } => *resource,
                            Ask::NonFungible { resource, .. } => *resource,
                        };
                        let proceeds_resource = self
                            .proceeds_vaults
                            .get(&listing_id)
                            .expect("proceeds vault missing on a Filled listing")
                            .resource_address();
                        assert_eq!(
                            proceeds_resource, ask_resource,
                            "conservation: proceeds resource must match the filled alternative"
                        );
                    }
                }
                ListingState::Cancelled => {
                    assert_eq!(
                        asset_held,
                        Decimal::ZERO,
                        "conservation: a Cancelled listing must not still hold the asset"
                    );
                }
            }
        }
    }
}

/// S2's mandatory ceiling AND `extend_listing`'s per-call amount are both 30
/// days, deliberately expressed as one constant: what `list` will accept
/// outright is exactly what one `extend_listing` call adds, so a listing
/// extended from any starting point never reaches further ahead than a
/// fresh listing could have been given.
const MAX_LISTING_HORIZON_SECS: i64 = THIRTY_DAYS_SECS;
const THIRTY_DAYS_SECS: i64 = 30 * 24 * 60 * 60;
