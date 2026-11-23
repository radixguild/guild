//! Ledger tests for the `NftSwap` blueprint (P7-02, task 90).
//!
//! Source-level tests at the bottom of this file run on the Mac
//! (`cargo test`, no `setup()` call — see CLAUDE.md "Scrypto on this Mac").
//! Every other test instantiates the ledger simulator and therefore only
//! runs in CI (`.github/workflows/scrypto.yml`) per the same note: the
//! wasm32 build `scrypto-test`'s ledger simulator needs fails locally on
//! this Mac (`blst` will not build for `wasm32-unknown-unknown` here).

use guild_marketplace_escrow_v2::nft_swap::{Ask, CancelledEvent, Listing, ListingState, NftSwapConfig};
use scrypto_test::prelude::*;

struct Fixture {
    ledger: DefaultLedgerSimulator,
    /// Only used to sign the instantiate transaction in `setup()` — kept on
    /// the fixture (unread elsewhere) so a future test can act as the owner
    /// without a fixture change, same convention as the escrow's own
    /// `Fixture.owner_pk`.
    #[allow(dead_code)]
    owner_pk: Secp256k1PublicKey,
    owner_account: ComponentAddress,
    seller_pk: Secp256k1PublicKey,
    seller_account: ComponentAddress,
    buyer_pk: Secp256k1PublicKey,
    buyer_account: ComponentAddress,
    swap: ComponentAddress,
    owner_badge: ResourceAddress,
    royalty_admin_badge: ResourceAddress,
    listing_receipt_resource: ResourceAddress,
    /// The seller's NFT collection — ids 1, 2, 3 minted into `seller_account`
    /// (`create_non_fungible_resource`'s standard fixture shape). This is
    /// what gets LISTED.
    asset_resource: ResourceAddress,
    /// A fungible token funded to `buyer_account`, used for `Ask::Fungible`
    /// payments.
    payment_token: ResourceAddress,
    /// A SECOND, distinct NFT collection — ids 1, 2, 3 minted into
    /// `buyer_account` — used as the resource for `Ask::NonFungible`
    /// payments. Distinct from `asset_resource` so a resource-mismatch
    /// assertion in `fill` can never accidentally pass by aliasing.
    swap_nft_resource: ResourceAddress,
}

fn setup() -> Fixture {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (owner_pk, _, owner_account) = ledger.new_allocated_account();
    let (seller_pk, _, seller_account) = ledger.new_allocated_account();
    let (buyer_pk, _, buyer_account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    let asset_resource = ledger.create_non_fungible_resource(seller_account);
    let payment_token = ledger.create_fungible_resource(dec!("1000000"), 18, buyer_account);
    let swap_nft_resource = ledger.create_non_fungible_resource(buyer_account);

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_function(package_address, "NftSwap", "instantiate", manifest_args!())
        .call_method(
            owner_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&owner_pk)],
    );
    receipt.expect_commit_success();
    let commit = receipt.expect_commit(true);
    let swap = commit.new_component_addresses()[0];
    // new_resource_addresses order on instantiate, mirroring the escrow:
    // 0 owner_badge, 1 royalty_admin_badge, 2 internal_minter, 3 listing_receipt_manager
    let owner_badge = commit.new_resource_addresses()[0];
    let royalty_admin_badge = commit.new_resource_addresses()[1];
    let listing_receipt_resource = commit.new_resource_addresses()[3];

    Fixture {
        ledger,
        owner_pk,
        owner_account,
        seller_pk,
        seller_account,
        buyer_pk,
        buyer_account,
        swap,
        owner_badge,
        royalty_admin_badge,
        listing_receipt_resource,
        asset_resource,
        payment_token,
        swap_nft_resource,
    }
}

fn current_instant(f: &mut Fixture) -> Instant {
    Instant::new(f.ledger.get_current_proposer_timestamp_ms() / 1000)
}

/// A safe default expiry — 7 days out, comfortably inside the 30-day S2
/// ceiling.
fn default_expiry(f: &mut Fixture) -> Instant {
    let now = current_instant(f);
    Instant::new(now.seconds_since_unix_epoch + 7 * 24 * 60 * 60)
}

/// Advance ledger time forward by `secs` seconds via a single round advance
/// (same shape as the escrow suite's `advance_time_by_secs`).
fn advance_time_by_secs(ledger: &mut DefaultLedgerSimulator, secs: i64) {
    let current_ms = ledger.get_current_proposer_timestamp_ms();
    let current_round = ledger.get_consensus_manager_state().round.number();
    ledger
        .advance_to_round_at_timestamp(Round::of(current_round + 1), current_ms + secs * 1000)
        .expect_commit_success();
}

/// List `asset_resource` local id `asset_local_id`, owned by the seller, for
/// `asks`, expiring at `expires_at`. First listing in a fresh fixture is
/// always id=1.
fn list_asset(
    f: &mut Fixture,
    asset_local_id: u64,
    asks: Vec<Ask>,
    expires_at: Instant,
) -> TransactionReceipt {
    let seller_account = f.seller_account;
    let signers = vec![NonFungibleGlobalId::from_public_key(&f.seller_pk)];
    list_asset_advanced(f, seller_account, seller_account, asset_local_id, asks, expires_at, signers)
}

/// General form of `list_asset`: withdraw the NFT from `from_account`, pin
/// `seller` as the payee, deposit the listing receipt back to
/// `from_account`, and sign with `signers`. The seller owner check makes
/// `seller` and `signers` matter: the transaction must satisfy `seller`'s
/// owner role.
fn list_asset_advanced(
    f: &mut Fixture,
    from_account: ComponentAddress,
    seller: ComponentAddress,
    asset_local_id: u64,
    asks: Vec<Ask>,
    expires_at: Instant,
    signers: Vec<NonFungibleGlobalId>,
) -> TransactionReceipt {
    let nf_id = NonFungibleLocalId::integer(asset_local_id);
    let asset_resource = f.asset_resource;
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_non_fungibles_from_account(from_account, asset_resource, indexset![nf_id])
        .take_all_from_worktop(asset_resource, "asset")
        .call_method_with_name_lookup(f.swap, "list", |lookup| {
            (seller, lookup.bucket("asset"), asks.clone(), expires_at)
        })
        .call_method(
            from_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger.execute_manifest(manifest, signers)
}

/// Decode the single `CancelledEvent` a successful `cancel` emitted.
fn cancelled_event(f: &Fixture, receipt: &TransactionReceipt) -> CancelledEvent {
    let events: Vec<CancelledEvent> = receipt
        .expect_commit_success()
        .application_events
        .iter()
        .filter(|(id, _)| f.ledger.is_event_name_equal::<CancelledEvent>(id))
        .map(|(_, data)| scrypto_decode::<CancelledEvent>(data).expect("CancelledEvent decodes"))
        .collect();
    assert_eq!(events.len(), 1, "exactly one CancelledEvent");
    events.into_iter().next().unwrap()
}

fn fill_with_fungible(f: &mut Fixture, listing_id: u64, alternative: u8, amount: Decimal) -> TransactionReceipt {
    let buyer_account = f.buyer_account;
    let payment_token = f.payment_token;
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_from_account(buyer_account, payment_token, amount)
        .take_from_worktop(payment_token, amount, "payment")
        .call_method_with_name_lookup(f.swap, "fill", |lookup| {
            (listing_id, alternative, lookup.bucket("payment"))
        })
        .call_method(
            buyer_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.buyer_pk)],
    )
}

fn fill_with_fungible_resource(
    f: &mut Fixture,
    listing_id: u64,
    alternative: u8,
    resource: ResourceAddress,
    amount: Decimal,
    from_account: ComponentAddress,
    from_pk: Secp256k1PublicKey,
    to_account: ComponentAddress,
) -> TransactionReceipt {
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_from_account(from_account, resource, amount)
        .take_from_worktop(resource, amount, "payment")
        .call_method_with_name_lookup(f.swap, "fill", |lookup| {
            (listing_id, alternative, lookup.bucket("payment"))
        })
        .call_method(
            to_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger
        .execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&from_pk)])
}

fn fill_with_nft(
    f: &mut Fixture,
    listing_id: u64,
    alternative: u8,
    nft_resource: ResourceAddress,
    nft_local_id: u64,
    from_account: ComponentAddress,
    from_pk: Secp256k1PublicKey,
    to_account: ComponentAddress,
) -> TransactionReceipt {
    let id = NonFungibleLocalId::integer(nft_local_id);
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_non_fungibles_from_account(from_account, nft_resource, indexset![id])
        .take_all_from_worktop(nft_resource, "payment")
        .call_method_with_name_lookup(f.swap, "fill", |lookup| {
            (listing_id, alternative, lookup.bucket("payment"))
        })
        .call_method(
            to_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger
        .execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&from_pk)])
}

fn cancel_listing(f: &mut Fixture, listing_id: u64) -> TransactionReceipt {
    let id = NonFungibleLocalId::integer(listing_id);
    let listing_receipt_resource = f.listing_receipt_resource;
    let seller_account = f.seller_account;
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            seller_account,
            listing_receipt_resource,
            indexset![id],
        )
        .pop_from_auth_zone("receipt")
        .call_method_with_name_lookup(f.swap, "cancel", |lookup| (lookup.proof("receipt"),))
        .call_method(
            seller_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.seller_pk)],
    )
}

fn extend_listing(f: &mut Fixture, listing_id: u64) -> TransactionReceipt {
    let id = NonFungibleLocalId::integer(listing_id);
    let listing_receipt_resource = f.listing_receipt_resource;
    let seller_account = f.seller_account;
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            seller_account,
            listing_receipt_resource,
            indexset![id],
        )
        .pop_from_auth_zone("receipt")
        .call_method_with_name_lookup(f.swap, "extend_listing", |lookup| (lookup.proof("receipt"),))
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.seller_pk)],
    )
}

fn withdraw_proceeds(f: &mut Fixture, listing_id: u64) -> TransactionReceipt {
    let id = NonFungibleLocalId::integer(listing_id);
    let listing_receipt_resource = f.listing_receipt_resource;
    let seller_account = f.seller_account;
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            seller_account,
            listing_receipt_resource,
            indexset![id],
        )
        .pop_from_auth_zone("receipt")
        .call_method_with_name_lookup(f.swap, "withdraw_proceeds", |lookup| {
            (lookup.proof("receipt"),)
        })
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.seller_pk)],
    )
}

fn burn_listing_receipt(f: &mut Fixture, listing_id: u64) -> TransactionReceipt {
    let id = NonFungibleLocalId::integer(listing_id);
    let listing_receipt_resource = f.listing_receipt_resource;
    let seller_account = f.seller_account;
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_non_fungibles_from_account(seller_account, listing_receipt_resource, indexset![id])
        .take_all_from_worktop(listing_receipt_resource, "receipt")
        .call_method_with_name_lookup(f.swap, "burn_listing_receipt", |lookup| {
            (lookup.bucket("receipt"),)
        })
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.seller_pk)],
    )
}

/// Set an account's DEFAULT deposit rule — used to prove `withdraw_proceeds`
/// reverts (rather than stranding the entitlement) when the seller's own
/// account refuses the deposit, and recovers once the rule is lifted.
fn set_default_deposit_rule(
    ledger: &mut DefaultLedgerSimulator,
    account: ComponentAddress,
    pk: &Secp256k1PublicKey,
    rule: DefaultDepositRule,
) {
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(account, "set_default_deposit_rule", manifest_args!(rule))
        .build();
    ledger
        .execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(pk)])
        .expect_commit_success();
}

/// Call a receipt-gated method (`cancel`, `extend_listing`,
/// `withdraw_proceeds`) as ANY account, presenting a Proof of
/// `receipt_resource` local id `local_id` from that account. Whatever the call
/// returns is deposited back into the CALLER's account, so a test can see if a
/// method hands anything to the caller rather than to the pinned seller.
fn call_with_receipt_proof(
    f: &mut Fixture,
    method: &str,
    receipt_resource: ResourceAddress,
    local_id: u64,
    account: ComponentAddress,
    pk: Secp256k1PublicKey,
) -> TransactionReceipt {
    let id = NonFungibleLocalId::integer(local_id);
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(account, receipt_resource, indexset![id])
        .pop_from_auth_zone("receipt")
        .call_method_with_name_lookup(f.swap, method, |lookup| (lookup.proof("receipt"),))
        .call_method(account, "deposit_batch", manifest_args!(ManifestExpression::EntireWorktop))
        .build();
    f.ledger
        .execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&pk)])
}

/// Move the listing receipt for `listing_id` from the seller to `to` — the
/// "receipt sold, phished or stolen" precondition for the F-008 tests.
fn transfer_receipt(f: &mut Fixture, listing_id: u64, to: ComponentAddress) {
    let id = NonFungibleLocalId::integer(listing_id);
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_non_fungibles_from_account(f.seller_account, f.listing_receipt_resource, indexset![id])
        .try_deposit_entire_worktop_or_abort(to, None)
        .build();
    f.ledger
        .execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&f.seller_pk)])
        .expect_commit_success();
}

/// A manifest that starts with a Proof of 1 `badge` from the owner account
/// (the fixture deposits both instantiate badges there).
fn badge_proof_manifest(f: &Fixture, badge: ResourceAddress) -> ManifestBuilder {
    ManifestBuilder::new().lock_fee_from_faucet().call_method(
        f.owner_account,
        "create_proof_of_amount",
        manifest_args!(badge, dec!("1")),
    )
}

fn set_swap_royalty(f: &mut Fixture, badge: Option<ResourceAddress>, method: &str, amount: RoyaltyAmount) -> TransactionReceipt {
    let builder = match badge {
        Some(b) => badge_proof_manifest(f, b),
        None => ManifestBuilder::new().lock_fee_from_faucet(),
    };
    let manifest = builder.set_component_royalty(f.swap, method, amount).build();
    f.ledger
        .execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)])
}

fn fetch_listing(f: &mut Fixture, listing_id: u64) -> Listing {
    let out: Option<Listing> = f
        .ledger
        .call_method(f.swap, "get_listing", manifest_args!(listing_id))
        .expect_commit_success()
        .output(1);
    out.expect("listing missing")
}

fn fetch_proceeds(f: &mut Fixture, listing_id: u64) -> Option<(ResourceAddress, Decimal)> {
    f.ledger
        .call_method(f.swap, "get_proceeds", manifest_args!(listing_id))
        .expect_commit_success()
        .output(1)
}

fn fetch_config(f: &mut Fixture) -> NftSwapConfig {
    f.ledger
        .call_method(f.swap, "get_config", manifest_args!())
        .expect_commit_success()
        .output(1)
}

// ── instantiate ──────────────────────────────────────────────────────────────

#[test]
fn test_instantiate_creates_component_and_badges() {
    let mut f = setup();
    assert_eq!(f.ledger.get_component_balance(f.owner_account, f.owner_badge), dec!("1"));
    assert_eq!(
        f.ledger.get_component_balance(f.owner_account, f.royalty_admin_badge),
        dec!("1")
    );
    let cfg = fetch_config(&mut f);
    assert_eq!(cfg.listing_receipt_resource, f.listing_receipt_resource);
    assert_eq!(cfg.max_listing_horizon_secs, 30 * 24 * 60 * 60);
    assert_eq!(cfg.extension_secs, 30 * 24 * 60 * 60);
}

// ── list ─────────────────────────────────────────────────────────────────────

#[test]
fn test_list_fungible_ask_succeeds() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();

    let listing = fetch_listing(&mut f, 1);
    assert_eq!(listing.state, ListingState::Listed);
    assert_eq!(listing.seller, f.seller_account);
    assert_eq!(listing.asset_resource, f.asset_resource);
    assert_eq!(listing.expires_at, expiry);
    assert_eq!(
        f.ledger.get_component_balance(f.seller_account, f.asset_resource),
        dec!("2"),
        "the listed NFT left the seller's account (started with 3, now 2)"
    );
}

#[test]
fn test_list_nonfungible_ask_succeeds() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::NonFungible {
        resource: f.swap_nft_resource,
        id: NonFungibleLocalId::integer(1),
    }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    let listing = fetch_listing(&mut f, 1);
    assert_eq!(listing.state, ListingState::Listed);
}

#[test]
fn test_list_anyof_multiple_asks_succeeds() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![
        Ask::Fungible { resource: f.payment_token, amount: dec!("100") },
        Ask::NonFungible { resource: f.swap_nft_resource, id: NonFungibleLocalId::integer(2) },
    ];
    list_asset(&mut f, 1, asks.clone(), expiry).expect_commit_success();
    let listing = fetch_listing(&mut f, 1);
    assert_eq!(listing.asks, asks);
}

#[test]
fn test_list_rejects_empty_asks() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    list_asset(&mut f, 1, vec![], expiry)
        .expect_commit_failure_containing_error("at least one ask alternative is required");
}

#[test]
fn test_list_rejects_duplicate_asks() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![
        Ask::Fungible { resource: f.payment_token, amount: dec!("100") },
        Ask::Fungible { resource: f.payment_token, amount: dec!("100") },
    ];
    list_asset(&mut f, 1, asks, expiry)
        .expect_commit_failure_containing_error("duplicate ask alternatives are not allowed");
}

#[test]
fn test_list_rejects_zero_amount_ask() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: Decimal::ZERO }];
    list_asset(&mut f, 1, asks, expiry)
        .expect_commit_failure_containing_error("fungible ask amount must be positive");
}

#[test]
fn test_list_rejects_expiry_too_far() {
    let mut f = setup();
    let now = current_instant(&mut f);
    let too_far = Instant::new(now.seconds_since_unix_epoch + 31 * 24 * 60 * 60);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, too_far)
        .expect_commit_failure_containing_error("at most 30 days out");
}

#[test]
fn test_list_rejects_expiry_in_past() {
    let mut f = setup();
    let now = current_instant(&mut f);
    let past = Instant::new(now.seconds_since_unix_epoch - 1);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, past)
        .expect_commit_failure_containing_error("expires_at must be in the future");
}

// ── fill ─────────────────────────────────────────────────────────────────────

#[test]
fn test_fill_fungible_alternative_delivers_asset_and_credits_proceeds() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();

    let buyer_asset_before = f.ledger.get_component_balance(f.buyer_account, f.asset_resource);
    fill_with_fungible(&mut f, 1, 0, dec!("100")).expect_commit_success();

    // Asset delivered ATOMICALLY, in the same transaction.
    assert_eq!(
        f.ledger.get_component_balance(f.buyer_account, f.asset_resource) - buyer_asset_before,
        dec!("1")
    );

    let listing = fetch_listing(&mut f, 1);
    assert_eq!(listing.state, ListingState::Filled);
    assert_eq!(listing.filled_with, Some(0));

    let proceeds = fetch_proceeds(&mut f, 1).expect("proceeds must be credited");
    assert_eq!(proceeds, (f.payment_token, dec!("100")));
}

#[test]
fn test_fill_nonfungible_alternative_succeeds() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::NonFungible {
        resource: f.swap_nft_resource,
        id: NonFungibleLocalId::integer(1),
    }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();

    let swap_nft_resource = f.swap_nft_resource;
    let buyer_account = f.buyer_account;
    let buyer_pk = f.buyer_pk;
    fill_with_nft(&mut f, 1, 0, swap_nft_resource, 1, buyer_account, buyer_pk, buyer_account)
        .expect_commit_success();

    let listing = fetch_listing(&mut f, 1);
    assert_eq!(listing.state, ListingState::Filled);
    let proceeds = fetch_proceeds(&mut f, 1).expect("proceeds must be credited");
    assert_eq!(proceeds, (f.swap_nft_resource, dec!("1")));
}

#[test]
fn test_fill_wrong_resource_reverts() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();

    // Pay with the wrong (NFT) resource against a Fungible alternative.
    let swap_nft_resource = f.swap_nft_resource;
    let buyer_account = f.buyer_account;
    let buyer_pk = f.buyer_pk;
    fill_with_nft(&mut f, 1, 0, swap_nft_resource, 1, buyer_account, buyer_pk, buyer_account)
        .expect_commit_failure_containing_error("payment resource does not match");
}

#[test]
fn test_fill_wrong_amount_reverts() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();

    fill_with_fungible(&mut f, 1, 0, dec!("50"))
        .expect_commit_failure_containing_error("payment amount does not match");
}

#[test]
fn test_fill_wrong_nft_id_reverts() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::NonFungible {
        resource: f.swap_nft_resource,
        id: NonFungibleLocalId::integer(1),
    }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();

    // Buyer presents id 2 (owns it) against an alternative that names id 1.
    let swap_nft_resource = f.swap_nft_resource;
    let buyer_account = f.buyer_account;
    let buyer_pk = f.buyer_pk;
    fill_with_nft(&mut f, 1, 0, swap_nft_resource, 2, buyer_account, buyer_pk, buyer_account)
        .expect_commit_failure_containing_error("payment NFT id does not match");
}

#[test]
fn test_fill_expired_reverts() {
    let mut f = setup();
    let now = current_instant(&mut f);
    let expiry = Instant::new(now.seconds_since_unix_epoch + 3600);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();

    advance_time_by_secs(&mut f.ledger, 3601);

    fill_with_fungible(&mut f, 1, 0, dec!("100"))
        .expect_commit_failure_containing_error("listing has expired");
}

#[test]
fn test_fill_invalid_alternative_index_reverts() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();

    fill_with_fungible(&mut f, 1, 1, dec!("100"))
        .expect_commit_failure_containing_error("alternative index out of range");
}

/// S6a: the seller may fill their own listing. Not a special case in the
/// blueprint — `fill` takes no identity proof at all — so this test just
/// proves the ledger-level mechanics (seller pays from their OWN account)
/// go through cleanly.
#[test]
fn test_fill_self_fill_succeeds() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();

    // Fund the SELLER with the payment token and have them fill their own
    // listing.
    let fund = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_from_account(f.buyer_account, f.payment_token, dec!("100"))
        .try_deposit_entire_worktop_or_abort(f.seller_account, None)
        .build();
    f.ledger
        .execute_manifest(fund, vec![NonFungibleGlobalId::from_public_key(&f.buyer_pk)])
        .expect_commit_success();

    let payment_token = f.payment_token;
    let seller_account = f.seller_account;
    let seller_pk = f.seller_pk;
    fill_with_fungible_resource(
        &mut f,
        1,
        0,
        payment_token,
        dec!("100"),
        seller_account,
        seller_pk,
        seller_account,
    )
    .expect_commit_success();

    let listing = fetch_listing(&mut f, 1);
    assert_eq!(listing.state, ListingState::Filled);
}

// ── cancel ───────────────────────────────────────────────────────────────────

#[test]
fn test_cancel_before_expiry_returns_asset_to_seller() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();

    let before = f.ledger.get_component_balance(f.seller_account, f.asset_resource);
    cancel_listing(&mut f, 1).expect_commit_success();
    assert_eq!(f.ledger.get_component_balance(f.seller_account, f.asset_resource) - before, dec!("1"));

    let listing = fetch_listing(&mut f, 1);
    assert_eq!(listing.state, ListingState::Cancelled);
}

#[test]
fn test_cancel_after_expiry_still_succeeds() {
    let mut f = setup();
    let now = current_instant(&mut f);
    let expiry = Instant::new(now.seconds_since_unix_epoch + 3600);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();

    advance_time_by_secs(&mut f.ledger, 3601);

    // Expired listings are unfillable but never stranded — cancel stays open.
    cancel_listing(&mut f, 1).expect_commit_success();
    let listing = fetch_listing(&mut f, 1);
    assert_eq!(listing.state, ListingState::Cancelled);
}

#[test]
fn test_cancel_after_filled_reverts() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    fill_with_fungible(&mut f, 1, 0, dec!("100")).expect_commit_success();

    cancel_listing(&mut f, 1).expect_commit_failure_containing_error("listing is not Listed");
}

// ── extend_listing ───────────────────────────────────────────────────────────

/// v2 (13 Oct I-1): an extension resets the expiry to `now + 30 days`, the
/// ceiling `list` enforces — never further. v1 added 30 days per call with no
/// cap (this test used to assert +60 days after two calls). A second call at
/// the same moment, or two calls in one transaction, are refused; a call a
/// day later moves the ceiling by that day.
#[test]
fn test_extend_listing_resets_to_the_30_day_ceiling_and_no_further() {
    const DAY: i64 = 24 * 60 * 60;
    let mut f = setup();
    let now = current_instant(&mut f);
    let expiry = Instant::new(now.seconds_since_unix_epoch + 7 * DAY);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();

    extend_listing(&mut f, 1).expect_commit_success();
    assert_eq!(
        fetch_listing(&mut f, 1).expires_at.seconds_since_unix_epoch,
        now.seconds_since_unix_epoch + 30 * DAY,
        "extend sets the expiry to now + 30 days"
    );

    extend_listing(&mut f, 1)
        .expect_commit_failure_containing_error("listing already expires at the 30-day ceiling");

    // A day later: two extensions in ONE transaction (v1 reached +60 days this
    // way). The second call fails, so the whole transaction reverts.
    advance_time_by_secs(&mut f.ledger, DAY);
    let id = NonFungibleLocalId::integer(1);
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            f.seller_account,
            f.listing_receipt_resource,
            indexset![id.clone()],
        )
        .pop_from_auth_zone("receipt_a")
        .call_method_with_name_lookup(f.swap, "extend_listing", |lookup| (lookup.proof("receipt_a"),))
        .create_proof_from_account_of_non_fungibles(
            f.seller_account,
            f.listing_receipt_resource,
            indexset![id],
        )
        .pop_from_auth_zone("receipt_b")
        .call_method_with_name_lookup(f.swap, "extend_listing", |lookup| (lookup.proof("receipt_b"),))
        .build();
    f.ledger
        .execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&f.seller_pk)])
        .expect_commit_failure_containing_error("listing already expires at the 30-day ceiling");
    assert_eq!(
        fetch_listing(&mut f, 1).expires_at.seconds_since_unix_epoch,
        now.seconds_since_unix_epoch + 30 * DAY,
        "the reverted double extension moved nothing"
    );

    extend_listing(&mut f, 1).expect_commit_success();
    assert_eq!(
        fetch_listing(&mut f, 1).expires_at.seconds_since_unix_epoch,
        now.seconds_since_unix_epoch + DAY + 30 * DAY,
        "a day later the ceiling has moved by that day, and no more"
    );
}

#[test]
fn test_extend_listing_rejects_when_not_listed() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    cancel_listing(&mut f, 1).expect_commit_success();

    extend_listing(&mut f, 1).expect_commit_failure_containing_error("listing is not Listed");
}

// ── withdraw_proceeds ────────────────────────────────────────────────────────

#[test]
fn test_withdraw_proceeds_deposits_to_seller() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    fill_with_fungible(&mut f, 1, 0, dec!("100")).expect_commit_success();

    let before = f.ledger.get_component_balance(f.seller_account, f.payment_token);
    withdraw_proceeds(&mut f, 1).expect_commit_success();
    assert_eq!(
        f.ledger.get_component_balance(f.seller_account, f.payment_token) - before,
        dec!("100")
    );

    let listing = fetch_listing(&mut f, 1);
    assert!(listing.proceeds_withdrawn);
    assert_eq!(fetch_proceeds(&mut f, 1), Some((f.payment_token, Decimal::ZERO)));
}

#[test]
fn test_withdraw_proceeds_refuses_twice() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    fill_with_fungible(&mut f, 1, 0, dec!("100")).expect_commit_success();

    withdraw_proceeds(&mut f, 1).expect_commit_success();
    withdraw_proceeds(&mut f, 1).expect_commit_failure_containing_error("proceeds already withdrawn");
}

#[test]
fn test_withdraw_proceeds_deposit_refusal_then_retry_after_rule_lifted() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    fill_with_fungible(&mut f, 1, 0, dec!("100")).expect_commit_success();

    set_default_deposit_rule(
        &mut f.ledger,
        f.seller_account,
        &f.seller_pk,
        DefaultDepositRule::Reject,
    );

    // The whole transaction reverts — the entitlement survives untouched.
    withdraw_proceeds(&mut f, 1).expect_commit_failure();
    let listing = fetch_listing(&mut f, 1);
    assert!(!listing.proceeds_withdrawn, "a reverted deposit must not mark proceeds withdrawn");
    assert_eq!(fetch_proceeds(&mut f, 1), Some((f.payment_token, dec!("100"))), "proceeds are untouched after the abort");

    set_default_deposit_rule(
        &mut f.ledger,
        f.seller_account,
        &f.seller_pk,
        DefaultDepositRule::Accept,
    );
    withdraw_proceeds(&mut f, 1).expect_commit_success();
    let listing = fetch_listing(&mut f, 1);
    assert!(listing.proceeds_withdrawn);
}

// ── burn_listing_receipt ─────────────────────────────────────────────────────

#[test]
fn test_burn_listing_receipt_after_cancel_succeeds() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    cancel_listing(&mut f, 1).expect_commit_success();

    burn_listing_receipt(&mut f, 1).expect_commit_success();
    assert_eq!(f.ledger.get_component_balance(f.seller_account, f.listing_receipt_resource), Decimal::ZERO);
}

#[test]
fn test_burn_listing_receipt_refuses_while_listed() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();

    burn_listing_receipt(&mut f, 1)
        .expect_commit_failure_containing_error("while the listing is still Listed");
}

#[test]
fn test_burn_listing_receipt_refuses_while_filled_unwithdrawn() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    fill_with_fungible(&mut f, 1, 0, dec!("100")).expect_commit_success();

    burn_listing_receipt(&mut f, 1)
        .expect_commit_failure_containing_error("proceeds are still owed");

    withdraw_proceeds(&mut f, 1).expect_commit_success();
    burn_listing_receipt(&mut f, 1).expect_commit_success();
}

// ── v2 (23 Nov pre-deploy review): state machine, boundaries, receipts ──────

#[test]
fn test_fill_twice_reverts() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    fill_with_fungible(&mut f, 1, 0, dec!("100")).expect_commit_success();

    let before = f.ledger.get_component_balance(f.buyer_account, f.payment_token);
    fill_with_fungible(&mut f, 1, 0, dec!("100")).expect_commit_failure_containing_error("listing is not Listed");
    assert_eq!(f.ledger.get_component_balance(f.buyer_account, f.payment_token), before, "the second buyer paid nothing");
    assert_eq!(fetch_proceeds(&mut f, 1), Some((f.payment_token, dec!("100"))), "proceeds hold one payment only");
}

#[test]
fn test_fill_after_cancel_reverts() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    cancel_listing(&mut f, 1).expect_commit_success();

    fill_with_fungible(&mut f, 1, 0, dec!("100")).expect_commit_failure_containing_error("listing is not Listed");
    assert!(fetch_proceeds(&mut f, 1).is_none());
}

#[test]
fn test_cancel_twice_reverts() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    cancel_listing(&mut f, 1).expect_commit_success();
    cancel_listing(&mut f, 1).expect_commit_failure_containing_error("listing is not Listed");
}

#[test]
fn test_withdraw_proceeds_before_fill_reverts() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    withdraw_proceeds(&mut f, 1).expect_commit_failure_containing_error("listing is not Filled");
}

#[test]
fn test_withdraw_proceeds_after_cancel_reverts() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    cancel_listing(&mut f, 1).expect_commit_success();
    withdraw_proceeds(&mut f, 1).expect_commit_failure_containing_error("listing is not Filled");
}

/// `fill` requires `now < expires_at`: one second before the expiry fills, AT
/// the expiry does not. Two identical listings so each side of the boundary
/// gets its own.
#[test]
fn test_fill_expiry_boundary_is_exclusive() {
    let mut f = setup();
    let now = current_instant(&mut f);
    let expiry = Instant::new(now.seconds_since_unix_epoch + 3600);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks.clone(), expiry).expect_commit_success();
    list_asset(&mut f, 2, asks, expiry).expect_commit_success();

    advance_time_by_secs(&mut f.ledger, 3599);
    fill_with_fungible(&mut f, 1, 0, dec!("100")).expect_commit_success();

    advance_time_by_secs(&mut f.ledger, 1);
    fill_with_fungible(&mut f, 2, 0, dec!("100")).expect_commit_failure_containing_error("listing has expired");
}

#[test]
fn test_list_accepts_expiry_exactly_at_the_30_day_ceiling() {
    let mut f = setup();
    let now = current_instant(&mut f);
    let ceiling = Instant::new(now.seconds_since_unix_epoch + 30 * 24 * 60 * 60);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks.clone(), ceiling).expect_commit_success();

    let one_over = Instant::new(ceiling.seconds_since_unix_epoch + 1);
    list_asset(&mut f, 2, asks, one_over).expect_commit_failure_containing_error("at most 30 days out");
}

#[test]
fn test_list_rejects_amount_beyond_divisibility() {
    let mut f = setup();
    let two_dp = f.ledger.create_fungible_resource(dec!("1000"), 2, f.buyer_account);
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: two_dp, amount: dec!("1.005") }];
    list_asset(&mut f, 1, asks, expiry)
        .expect_commit_failure_containing_error("fungible ask amount exceeds the resource's divisibility");
}

/// No change is ever given: paying MORE than the ask is refused like paying
/// less (`test_fill_wrong_amount_reverts` covers less).
#[test]
fn test_fill_overpayment_reverts() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();

    let before = f.ledger.get_component_balance(f.buyer_account, f.payment_token);
    fill_with_fungible(&mut f, 1, 0, dec!("150")).expect_commit_failure_containing_error("payment amount does not match");
    assert_eq!(f.ledger.get_component_balance(f.buyer_account, f.payment_token), before);
}

/// A Proof (or Bucket) of a look-alike resource carrying an integer local id
/// is refused by every receipt-gated method before the id is read. The
/// seller's own asset collection stands in for the look-alike: it has integer
/// ids and the seller still holds #2.
#[test]
fn test_lookalike_receipt_is_refused_everywhere() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();

    let fake = f.asset_resource;
    let seller = f.seller_account;
    let seller_pk = f.seller_pk;
    for method in ["cancel", "extend_listing", "withdraw_proceeds"] {
        call_with_receipt_proof(&mut f, method, fake, 2, seller, seller_pk)
            .expect_commit_failure_containing_error("wrong receipt resource");
    }

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_non_fungibles_from_account(seller, fake, indexset![NonFungibleLocalId::integer(2)])
        .take_all_from_worktop(fake, "receipt")
        .call_method_with_name_lookup(f.swap, "burn_listing_receipt", |lookup| (lookup.bucket("receipt"),))
        .build();
    f.ledger
        .execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&seller_pk)])
        .expect_commit_failure_containing_error("wrong receipt resource");

    assert_eq!(fetch_listing(&mut f, 1).state, ListingState::Listed);
}

/// v2 (F-008). A third party holding the listing receipt (sold, phished,
/// stolen) can trigger `cancel`, but the asset goes to the PINNED seller —
/// nothing reaches the caller.
#[test]
fn test_f008_cancel_by_receipt_holder_delivers_to_the_pinned_seller() {
    let mut f = setup();
    let (third_pk, _, third) = f.ledger.new_allocated_account();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    transfer_receipt(&mut f, 1, third);

    let seller_before = f.ledger.get_component_balance(f.seller_account, f.asset_resource);
    let receipt_resource = f.listing_receipt_resource;
    let r = call_with_receipt_proof(&mut f, "cancel", receipt_resource, 1, third, third_pk);
    r.expect_commit_success();
    let event = cancelled_event(&f, &r);
    assert_eq!(event.listing_id, 1);
    assert_eq!(event.destination, f.seller_account, "CancelledEvent names the pinned seller, not the caller");

    assert_eq!(fetch_listing(&mut f, 1).state, ListingState::Cancelled);
    assert_eq!(
        f.ledger.get_component_balance(f.seller_account, f.asset_resource) - seller_before,
        dec!("1"),
        "the asset is back with the pinned seller"
    );
    assert_eq!(
        f.ledger.get_component_balance(third, f.asset_resource),
        Decimal::ZERO,
        "the receipt holder received nothing"
    );
}

/// Same property for proceeds (unchanged from v1, now pinned by a test): the
/// receipt holder's withdraw pays the pinned seller.
#[test]
fn test_withdraw_proceeds_by_receipt_holder_pays_the_pinned_seller() {
    let mut f = setup();
    let (third_pk, _, third) = f.ledger.new_allocated_account();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    fill_with_fungible(&mut f, 1, 0, dec!("100")).expect_commit_success();
    transfer_receipt(&mut f, 1, third);

    let seller_before = f.ledger.get_component_balance(f.seller_account, f.payment_token);
    let receipt_resource = f.listing_receipt_resource;
    call_with_receipt_proof(&mut f, "withdraw_proceeds", receipt_resource, 1, third, third_pk)
        .expect_commit_success();

    assert_eq!(f.ledger.get_component_balance(f.seller_account, f.payment_token) - seller_before, dec!("100"));
    assert_eq!(f.ledger.get_component_balance(third, f.payment_token), Decimal::ZERO);
}

/// v2 (F-008): `cancel` now deposits into the seller's account, so a seller
/// account that refuses deposits makes `cancel` revert. The listing must
/// stay Listed with the asset in escrow, and cancel must work once the rule
/// is lifted.
#[test]
fn test_cancel_deposit_refusal_then_retry_after_rule_lifted() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();

    set_default_deposit_rule(&mut f.ledger, f.seller_account, &f.seller_pk, DefaultDepositRule::Reject);
    cancel_listing(&mut f, 1).expect_commit_failure();
    assert_eq!(fetch_listing(&mut f, 1).state, ListingState::Listed, "a reverted cancel changes nothing");
    let vaults = f.ledger.get_component_vaults(f.swap, f.asset_resource);
    assert_eq!(vaults.len(), 1);
    assert_eq!(f.ledger.inspect_vault_balance(vaults[0]), Some(dec!("1")), "the asset is still in escrow");

    set_default_deposit_rule(&mut f.ledger, f.seller_account, &f.seller_pk, DefaultDepositRule::Accept);
    let before = f.ledger.get_component_balance(f.seller_account, f.asset_resource);
    cancel_listing(&mut f, 1).expect_commit_success();
    assert_eq!(f.ledger.get_component_balance(f.seller_account, f.asset_resource) - before, dec!("1"));
}

/// v2 (F-008): a hollow listing (asset recalled) deposits nothing on cancel,
/// so even a seller account that refuses every deposit can close it.
#[test]
fn test_cancel_hollow_listing_succeeds_even_when_seller_refuses_deposits() {
    let mut f = setup();
    let recallable = f.ledger.create_non_fungible_resource_with_roles(
        NonFungibleResourceRoles {
            recall_roles: recall_roles! {
                recaller => rule!(allow_all);
                recaller_updater => rule!(deny_all);
            },
            ..Default::default()
        },
        f.seller_account,
    );
    f.asset_resource = recallable;
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();

    let vaults = f.ledger.get_component_vaults(f.swap, recallable);
    let recall = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .recall_non_fungibles(InternalAddress::new_or_panic(vaults[0].0), [NonFungibleLocalId::integer(1)])
        .try_deposit_entire_worktop_or_abort(f.owner_account, None)
        .build();
    f.ledger.execute_manifest(recall, vec![]).expect_commit_success();

    set_default_deposit_rule(&mut f.ledger, f.seller_account, &f.seller_pk, DefaultDepositRule::Reject);
    let seller_before = f.ledger.get_component_balance(f.seller_account, recallable);
    let r = cancel_listing(&mut f, 1);
    r.expect_commit_success();
    assert_eq!(fetch_listing(&mut f, 1).state, ListingState::Cancelled);
    assert_eq!(
        f.ledger.get_component_balance(f.seller_account, recallable),
        seller_before,
        "a hollow cancel deposits nothing to the seller"
    );
    assert_eq!(cancelled_event(&f, &r).destination, f.seller_account, "the event still names the pin");
}

/// A NonFungible ask that names a FUNGIBLE resource is accepted by `list`
/// (13 Oct review L-2, not fixed) but can never be filled: the fill reverts
/// and the buyer keeps their tokens. The seller can still cancel.
#[test]
fn test_nonfungible_ask_on_a_fungible_resource_is_unfillable_without_loss() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::NonFungible { resource: f.payment_token, id: NonFungibleLocalId::integer(1) }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();

    let before = f.ledger.get_component_balance(f.buyer_account, f.payment_token);
    fill_with_fungible(&mut f, 1, 0, dec!("1")).expect_commit_failure();
    assert_eq!(f.ledger.get_component_balance(f.buyer_account, f.payment_token), before);
    assert_eq!(fetch_listing(&mut f, 1).state, ListingState::Listed);
    cancel_listing(&mut f, 1).expect_commit_success();
}

/// `alternative` is a `u8`, and `list` does not cap the ask count (review
/// L-1, not fixed): a listing with 257 asks is accepted, index 255 fills, and
/// index 256 cannot even be named. Pins today's behaviour so a cap shows up
/// as a deliberate test change.
#[test]
fn test_list_accepts_more_than_256_asks_but_only_256_are_addressable() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks: Vec<Ask> = (1..=257u32)
        .map(|i| Ask::Fungible { resource: f.payment_token, amount: Decimal::from(i) })
        .collect();
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    assert_eq!(fetch_listing(&mut f, 1).asks.len(), 257);

    fill_with_fungible(&mut f, 1, 255, dec!("256")).expect_commit_success();
    assert_eq!(fetch_listing(&mut f, 1).filled_with, Some(255));
}

/// A frozen asset vault (the issuer holds the freezer role) blocks BOTH fill
/// and cancel — custody waits on the issuer — and nothing moves until it is
/// unfrozen. The buyer's failed fill costs them nothing.
#[test]
fn test_frozen_asset_vault_blocks_fill_and_cancel_until_unfrozen() {
    let mut f = setup();
    let freezable = f.ledger.create_non_fungible_resource_with_roles(
        NonFungibleResourceRoles {
            freeze_roles: freeze_roles! {
                freezer => rule!(allow_all);
                freezer_updater => rule!(deny_all);
            },
            ..Default::default()
        },
        f.seller_account,
    );
    f.asset_resource = freezable;
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();

    let vault = InternalAddress::new_or_panic(f.ledger.get_component_vaults(f.swap, freezable)[0].0);
    let freeze = ManifestBuilder::new().lock_fee_from_faucet().freeze_withdraw(vault).build();
    f.ledger.execute_manifest(freeze, vec![]).expect_commit_success();

    let before = f.ledger.get_component_balance(f.buyer_account, f.payment_token);
    fill_with_fungible(&mut f, 1, 0, dec!("100")).expect_commit_failure();
    assert_eq!(f.ledger.get_component_balance(f.buyer_account, f.payment_token), before);
    cancel_listing(&mut f, 1).expect_commit_failure();
    assert_eq!(fetch_listing(&mut f, 1).state, ListingState::Listed);

    let unfreeze = ManifestBuilder::new().lock_fee_from_faucet().unfreeze_withdraw(vault).build();
    f.ledger.execute_manifest(unfreeze, vec![]).expect_commit_success();
    cancel_listing(&mut f, 1).expect_commit_success();
    assert_eq!(fetch_listing(&mut f, 1).state, ListingState::Cancelled);
}

/// The PAYMENT token's issuer recalls the proceeds out of the proceeds vault
/// after a fill. Nothing strands: `withdraw_proceeds` still completes (paying
/// zero), the listing reaches its terminal state, and the receipt burns.
#[test]
fn test_recalled_proceeds_still_let_the_listing_terminate() {
    let mut f = setup();
    let create = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_fungible_resource(
            OwnerRole::None,
            true,
            18u8,
            FungibleResourceRoles {
                recall_roles: recall_roles! {
                    recaller => rule!(allow_all);
                    recaller_updater => rule!(deny_all);
                },
                ..Default::default()
            },
            metadata!(),
            Some(dec!("1000")),
        )
        .try_deposit_entire_worktop_or_abort(f.buyer_account, None)
        .build();
    let created = f.ledger.execute_manifest(create, vec![]);
    let token = created.expect_commit(true).new_resource_addresses()[0];

    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    let buyer = f.buyer_account;
    let buyer_pk = f.buyer_pk;
    fill_with_fungible_resource(&mut f, 1, 0, token, dec!("100"), buyer, buyer_pk, buyer).expect_commit_success();

    let vault = InternalAddress::new_or_panic(f.ledger.get_component_vaults(f.swap, token)[0].0);
    let recall = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .recall(vault, dec!("100"))
        .try_deposit_entire_worktop_or_abort(f.owner_account, None)
        .build();
    f.ledger.execute_manifest(recall, vec![]).expect_commit_success();
    assert_eq!(fetch_proceeds(&mut f, 1), Some((token, Decimal::ZERO)));

    withdraw_proceeds(&mut f, 1).expect_commit_success();
    assert!(fetch_listing(&mut f, 1).proceeds_withdrawn);
    burn_listing_receipt(&mut f, 1).expect_commit_success();
}

// ── v2 (23 Nov review): royalty dials and locked roles, read back by behaviour ─

/// The two dials start at 0 and only the royalty-admin badge moves them; a
/// moved dial actually charges.
#[test]
fn test_royalty_dials_are_admin_only_and_charge() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks.clone(), expiry).expect_commit_success();
    list_asset(&mut f, 2, asks, expiry).expect_commit_success();

    let r = fill_with_fungible(&mut f, 1, 0, dec!("100"));
    r.expect_commit_success();
    assert_eq!(r.fee_summary.total_royalty_cost_in_xrd, Decimal::ZERO, "fill ships at 0");

    let owner_badge = f.owner_badge;
    let admin_badge = f.royalty_admin_badge;
    for method in ["fill", "extend_listing"] {
        set_swap_royalty(&mut f, None, method, RoyaltyAmount::Xrd(dec!("1")))
            .expect_commit_failure_containing_error("Unauthorized");
        set_swap_royalty(&mut f, Some(owner_badge), method, RoyaltyAmount::Xrd(dec!("1")))
            .expect_commit_failure_containing_error("Unauthorized");
        set_swap_royalty(&mut f, Some(admin_badge), method, RoyaltyAmount::Xrd(dec!("1"))).expect_commit_success();
    }

    let r = fill_with_fungible(&mut f, 2, 0, dec!("100"));
    r.expect_commit_success();
    assert_eq!(r.fee_summary.total_royalty_cost_in_xrd, dec!("1"), "a dialed fill royalty charges");

    let mut f2 = setup();
    let expiry = default_expiry(&mut f2);
    let asks = vec![Ask::Fungible { resource: f2.payment_token, amount: dec!("100") }];
    list_asset(&mut f2, 1, asks, expiry).expect_commit_success();
    let admin_badge = f2.royalty_admin_badge;
    set_swap_royalty(&mut f2, Some(admin_badge), "extend_listing", RoyaltyAmount::Xrd(dec!("1"))).expect_commit_success();
    let r = extend_listing(&mut f2, 1);
    r.expect_commit_success();
    assert_eq!(r.fee_summary.total_royalty_cost_in_xrd, dec!("1"), "a dialed extend royalty charges");
}

/// Every other method is Free and LOCKED at the engine level, even against
/// the royalty-admin badge — in particular `cancel` and `withdraw_proceeds`,
/// so no royalty can ever trap an asset or proceeds.
#[test]
fn test_free_methods_are_locked_even_for_the_admin() {
    let mut f = setup();
    let admin_badge = f.royalty_admin_badge;
    for method in [
        "list",
        "cancel",
        "withdraw_proceeds",
        "burn_listing_receipt",
        "get_listing",
        "get_config",
        "get_proceeds",
    ] {
        set_swap_royalty(&mut f, Some(admin_badge), method, RoyaltyAmount::Xrd(dec!("1")))
            .expect_commit_failure_containing_error("KeyValueEntryLocked");
    }
}

/// Only the owner badge claims royalties; the admin badge cannot.
#[test]
fn test_royalty_claim_is_owner_only() {
    let mut f = setup();
    let admin_badge = f.royalty_admin_badge;
    let owner_badge = f.owner_badge;
    let owner = f.owner_account;
    let manifest = badge_proof_manifest(&f, admin_badge)
        .claim_component_royalties(f.swap)
        .try_deposit_entire_worktop_or_abort(owner, None)
        .build();
    f.ledger
        .execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)])
        .expect_commit_failure_containing_error("Unauthorized");

    let manifest = badge_proof_manifest(&f, owner_badge)
        .claim_component_royalties(f.swap)
        .try_deposit_entire_worktop_or_abort(owner, None)
        .build();
    f.ledger
        .execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)])
        .expect_commit_success();
}

/// Both instantiate badges are fixed supply: no one, not even a holder,
/// can mint more.
#[test]
fn test_instantiate_badges_cannot_be_minted() {
    let mut f = setup();
    for badge in [f.owner_badge, f.royalty_admin_badge] {
        let manifest = badge_proof_manifest(&f, badge)
            .mint_fungible(badge, dec!("1"))
            .try_deposit_entire_worktop_or_abort(f.owner_account, None)
            .build();
        f.ledger
            .execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)])
            .expect_commit_failure();
        assert_eq!(f.ledger.get_component_balance(f.owner_account, badge), dec!("1"));
    }
}

/// The listing receipt can be neither burned outside `burn_listing_receipt`
/// (burner = the component's internal minter only) nor recalled by the
/// owner badge (recaller defaults to deny_all).
#[test]
fn test_listing_receipt_cannot_be_burned_directly_or_recalled_by_the_owner() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    let receipt_resource = f.listing_receipt_resource;

    let burn = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_non_fungibles_from_account(f.seller_account, receipt_resource, indexset![NonFungibleLocalId::integer(1)])
        .burn_all_from_worktop(receipt_resource)
        .build();
    f.ledger
        .execute_manifest(burn, vec![NonFungibleGlobalId::from_public_key(&f.seller_pk)])
        .expect_commit_failure();

    let vault = InternalAddress::new_or_panic(f.ledger.get_component_vaults(f.seller_account, receipt_resource)[0].0);
    let owner_badge = f.owner_badge;
    let recall = badge_proof_manifest(&f, owner_badge)
        .recall_non_fungibles(vault, [NonFungibleLocalId::integer(1)])
        .try_deposit_entire_worktop_or_abort(f.owner_account, None)
        .build();
    f.ledger
        .execute_manifest(recall, vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)])
        .expect_commit_failure();

    assert_eq!(f.ledger.get_component_balance(f.seller_account, receipt_resource), dec!("1"));
}

// ── Local verification: source-level tests, no ledger (CLAUDE.md) ────────────

/// Mirrors `test_every_scrypto_event_is_registered_in_the_events_attribute`
/// in tests/lib.rs, scoped to `src/nft_swap.rs`. Runs locally in
/// microseconds — no `setup()` call.
#[test]
fn test_every_nft_swap_event_is_registered_in_the_events_attribute() {
    const SRC: &str = include_str!("../src/nft_swap.rs");
    let lines: Vec<&str> = SRC.lines().collect();

    let mut declared: Vec<String> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if !line.contains("ScryptoEvent") {
            continue;
        }
        for next in lines.iter().skip(i + 1).take(4) {
            if let Some(rest) = next.trim().strip_prefix("pub struct ") {
                let name: String = rest
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect();
                if !name.is_empty() {
                    declared.push(name);
                }
                break;
            }
        }
    }

    let start = SRC
        .find("#[events(")
        .expect("nft_swap blueprint must carry an #[events(...)] attribute");
    let end = start
        + SRC[start..]
            .find(")]")
            .expect("unterminated #[events(...)] attribute");
    let registered = &SRC[start..end];

    assert!(
        declared.len() >= 5,
        "event scrape found only {} ScryptoEvent structs — the PARSER is broken, \
         not the blueprint. Fix the scrape before trusting this test again.",
        declared.len()
    );

    let missing: Vec<&String> = declared
        .iter()
        .filter(|name| !registered.contains(name.as_str()))
        .collect();
    assert!(
        missing.is_empty(),
        "these ScryptoEvent structs are declared but NOT registered in #[events(...)]. \
         Emitting any of them panics at runtime with BlueprintPayloadDoesNotExist: {:?}",
        missing
    );
}

/// Guards the "mints its own badges" contract stated throughout this file
/// and nft-swap.md §4: `instantiate` takes ZERO parameters. If a future
/// change adds one (e.g. to accept a pre-existing owner badge rule), this
/// test is the tripwire that forces the doc comments explaining why it
/// mints its own to be revisited in the same change.
#[test]
fn test_nft_swap_instantiate_takes_no_parameters() {
    const SRC: &str = include_str!("../src/nft_swap.rs");
    const HEAD: &str = "pub fn instantiate(";
    let start = SRC.find(HEAD).expect("nft_swap blueprint must declare `pub fn instantiate(`");
    let open = start + HEAD.len();
    let close = SRC[open..].find(')').expect("unterminated instantiate parameter list");
    let params = SRC[open..open + close].trim();
    assert!(
        params.is_empty(),
        "instantiate() was expected to take no parameters (mints its own owner + \
         royalty-admin + internal-minter badges, exactly like the escrow) but found: {:?}",
        params
    );
}


// ── v2 (13 Oct F-005): recall-then-fill, and the recorded roles ─────────────

/// U-2(c). The asset's issuer recalls the listed NFT out of the component's
/// asset vault while the listing is Listed. v1's `fill` then took the buyer's
/// full payment and returned an empty bucket. v2 refuses the fill (the buyer
/// keeps their tokens), and the seller can still close the hollow listing.
#[test]
fn test_u2c_recall_then_fill_is_refused() {
    let mut f = setup();
    let recallable = f.ledger.create_non_fungible_resource_with_roles(
        NonFungibleResourceRoles {
            recall_roles: recall_roles! {
                recaller => rule!(allow_all);
                recaller_updater => rule!(deny_all);
            },
            ..Default::default()
        },
        f.seller_account,
    );
    f.asset_resource = recallable;
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    let listing = fetch_listing(&mut f, 1);
    assert!(listing.asset_recallable, "a recall role that is not deny_all is recorded");
    assert!(!listing.asset_burnable);

    // The recall, straight from the component's vault.
    let vaults = f.ledger.get_component_vaults(f.swap, recallable);
    assert_eq!(vaults.len(), 1, "exactly one vault holds the listed NFT");
    let recall = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .recall_non_fungibles(
            InternalAddress::new_or_panic(vaults[0].0),
            [NonFungibleLocalId::integer(1)],
        )
        .try_deposit_entire_worktop_or_abort(f.owner_account, None)
        .build();
    f.ledger.execute_manifest(recall, vec![]).expect_commit_success();

    let buyer_before = f.ledger.get_component_balance(f.buyer_account, f.payment_token);
    fill_with_fungible(&mut f, 1, 0, dec!("100"))
        .expect_commit_failure_containing_error("the listed NFT is no longer in escrow");
    assert_eq!(
        f.ledger.get_component_balance(f.buyer_account, f.payment_token),
        buyer_before,
        "the buyer paid nothing"
    );
    assert_eq!(fetch_listing(&mut f, 1).state, ListingState::Listed);
    assert!(fetch_proceeds(&mut f, 1).is_none());

    // A hollow listing cannot be extended (conservation), but can be closed.
    extend_listing(&mut f, 1)
        .expect_commit_failure_containing_error("conservation: a Listed listing must hold exactly its asset");
    cancel_listing(&mut f, 1).expect_commit_success();
    assert_eq!(fetch_listing(&mut f, 1).state, ListingState::Cancelled);
}

/// F-005 record: an NFT created with no recall or burn roles reads as locked
/// (radix-engine defaults both roles and their updaters to deny_all), and a
/// burnable one is recorded as burnable.
#[test]
fn test_v2_list_records_recall_and_burn_roles() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks.clone(), expiry).expect_commit_success();
    let plain = fetch_listing(&mut f, 1);
    assert!(!plain.asset_recallable, "the fixture NFT has no recall role");
    assert!(!plain.asset_burnable, "the fixture NFT has no burn role");

    let burnable = f.ledger.create_non_fungible_resource_with_roles(
        NonFungibleResourceRoles {
            burn_roles: burn_roles! {
                burner => rule!(allow_all);
                burner_updater => rule!(deny_all);
            },
            ..Default::default()
        },
        f.seller_account,
    );
    f.asset_resource = burnable;
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    let listing = fetch_listing(&mut f, 2);
    assert!(listing.asset_burnable);
    assert!(!listing.asset_recallable);
}

// ── v2 seller owner check: `list` must prove control of the pinned seller ───

/// The F-008 follow-up. Pinning an account the transaction does not control
/// (here: the buyer's allocated account, signed only by the seller) is
/// refused. Before the check this listed fine and the buyer's account would
/// have received the asset on cancel.
#[test]
fn test_owner_check_list_rejects_someone_elses_account() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    let (seller, other) = (f.seller_account, f.buyer_account);
    let signers = vec![NonFungibleGlobalId::from_public_key(&f.seller_pk)];
    list_asset_advanced(&mut f, seller, other, 1, asks, expiry, signers)
        .expect_commit_failure_containing_error("AssertAccessRuleFailed");
    assert_eq!(
        f.ledger.get_component_balance(f.seller_account, f.asset_resource),
        dec!("3"),
        "the NFT never left the seller"
    );
}

/// The typo case: a valid preallocated address whose key did not sign.
#[test]
fn test_owner_check_list_rejects_an_unsigned_preallocated_account() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    let (stranger_pk, _) = f.ledger.new_key_pair();
    let stranger =
        ComponentAddress::preallocated_account_from_public_key(&PublicKey::Secp256k1(stranger_pk));
    let seller = f.seller_account;
    let signers = vec![NonFungibleGlobalId::from_public_key(&f.seller_pk)];
    list_asset_advanced(&mut f, seller, stranger, 1, asks, expiry, signers)
        .expect_commit_failure_containing_error("AssertAccessRuleFailed");
}

/// Allocated account pinned by its own signer: the fixture's normal path,
/// asserted explicitly here.
#[test]
fn test_owner_check_list_accepts_own_allocated_account() {
    let mut f = setup();
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();
    assert_eq!(fetch_listing(&mut f, 1).seller, f.seller_account);
}

/// A preallocated Secp256k1 account that already exists on ledger (the
/// faucet deposit in `new_preallocated_account` created it), listing from
/// itself and signing with its own key.
#[test]
fn test_owner_check_list_accepts_own_preallocated_account_already_on_ledger() {
    let mut f = setup();
    let (pre_pk, _, pre) = f.ledger.new_preallocated_account();
    let move_nft = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_non_fungibles_from_account(f.seller_account, f.asset_resource, indexset![NonFungibleLocalId::integer(1)])
        .try_deposit_entire_worktop_or_abort(pre, None)
        .build();
    f.ledger
        .execute_manifest(move_nft, vec![NonFungibleGlobalId::from_public_key(&f.seller_pk)])
        .expect_commit_success();

    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    let signers = vec![NonFungibleGlobalId::from_public_key(&pre_pk)];
    list_asset_advanced(&mut f, pre, pre, 1, asks, expiry, signers).expect_commit_success();
    assert_eq!(fetch_listing(&mut f, 1).seller, pre);
}

/// Preallocated accounts that have never been used (no transaction has
/// touched the address before `list`), for BOTH key types. The pinned
/// account's key co-signs; the NFT comes from the fixture seller. `list`
/// succeeds, and `cancel` then delivers the asset to the new account, so the
/// pin is a real, working account.
#[test]
fn test_owner_check_list_accepts_never_used_preallocated_accounts() {
    let mut f = setup();
    let (secp_pk, _) = f.ledger.new_key_pair();
    let (ed_pk, _) = f.ledger.new_ed25519_key_pair();
    let cases = [
        (
            ComponentAddress::preallocated_account_from_public_key(&PublicKey::Secp256k1(secp_pk)),
            NonFungibleGlobalId::from_public_key(&secp_pk),
        ),
        (
            ComponentAddress::preallocated_account_from_public_key(&PublicKey::Ed25519(ed_pk)),
            NonFungibleGlobalId::from_public_key(&ed_pk),
        ),
    ];
    let seller = f.seller_account;
    for (i, (fresh, fresh_badge)) in cases.into_iter().enumerate() {
        let listing_id = (i + 1) as u64;
        let expiry = default_expiry(&mut f);
        let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
        let signers = vec![NonFungibleGlobalId::from_public_key(&f.seller_pk), fresh_badge];
        list_asset_advanced(&mut f, seller, fresh, listing_id, asks, expiry, signers).expect_commit_success();
        assert_eq!(fetch_listing(&mut f, listing_id).seller, fresh);

        // Listing receipt went to the fixture seller (`from_account`).
        let r = cancel_listing(&mut f, listing_id);
        r.expect_commit_success();
        assert_eq!(cancelled_event(&f, &r).destination, fresh);
        assert_eq!(
            f.ledger.get_component_balance(fresh, f.asset_resource),
            dec!("1"),
            "cancel delivered the asset to the never-used preallocated account"
        );
    }
}

/// The pinned account's key alone is not enough when the NFT comes from a
/// different account: withdrawing still needs that account's owner. This
/// pins down that the new check did not loosen anything else.
#[test]
fn test_owner_check_preallocated_signer_alone_cannot_list_someone_elses_nft() {
    let mut f = setup();
    let (fresh_pk, _) = f.ledger.new_key_pair();
    let fresh = ComponentAddress::preallocated_account_from_public_key(&PublicKey::Secp256k1(fresh_pk));
    let expiry = default_expiry(&mut f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    let seller = f.seller_account;
    let signers = vec![NonFungibleGlobalId::from_public_key(&fresh_pk)];
    list_asset_advanced(&mut f, seller, fresh, 1, asks, expiry, signers)
        .expect_commit_failure_containing_error("Unauthorized");
}

// ── v2 seller owner check: securified accounts (owner-badge proof) ─────────

/// Create a never-used preallocated Secp256k1 account, `securify` it, and
/// park the returned owner badge in the fixture seller's account. After this
/// the account's OWNER rule is `require(ACCOUNT_OWNER_BADGE:<bytes of the
/// account address>)` (radix-engine 1.3.1 `SecurifiedAccount::securify` via
/// `AccountBlueprint::securify`), so its original key no longer controls it
/// and a proof of that badge does. Returns the account, its original key and
/// the badge's local id.
fn new_securified_account(f: &mut Fixture) -> (ComponentAddress, Secp256k1PublicKey, NonFungibleLocalId) {
    let (pk, _) = f.ledger.new_key_pair();
    let account = ComponentAddress::preallocated_account_from_public_key(&PublicKey::Secp256k1(pk));
    let seller_account = f.seller_account;
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(account, "securify", manifest_args!())
        .call_method(
            seller_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger
        .execute_manifest(
            manifest,
            vec![
                NonFungibleGlobalId::from_public_key(&pk),
                NonFungibleGlobalId::from_public_key(&f.seller_pk),
            ],
        )
        .expect_commit_success();
    let badge_id = NonFungibleLocalId::bytes(account.as_node_id().0).unwrap();
    (account, pk, badge_id)
}

/// What a `list` transaction presents for the pinned seller's owner badge.
enum BadgeProof {
    /// No badge proof at all.
    Absent,
    /// A proof of this owner badge (held by the fixture seller), made with
    /// `create_proof_from_account_of_non_fungibles`, which leaves it in the
    /// transaction's auth zone.
    InAuthZone(NonFungibleLocalId),
    /// The same proof, popped off the auth zone into a named manifest proof
    /// before `list` runs: it exists in the transaction, but not where
    /// `assert_access_rule` looks.
    PoppedOff(NonFungibleLocalId),
}

/// List `asset_resource` id `asset_local_id` from the fixture seller with
/// `seller` pinned, presenting `badge` first. The listing receipt goes back
/// to the fixture seller.
fn list_with_badge_proof(
    f: &mut Fixture,
    seller: ComponentAddress,
    asset_local_id: u64,
    badge: BadgeProof,
    signers: Vec<NonFungibleGlobalId>,
) -> TransactionReceipt {
    let from_account = f.seller_account;
    let asset_resource = f.asset_resource;
    let expiry = default_expiry(f);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    let builder = ManifestBuilder::new().lock_fee_from_faucet();
    let builder = match badge {
        BadgeProof::Absent => builder,
        BadgeProof::InAuthZone(id) => {
            builder.create_proof_from_account_of_non_fungibles(from_account, ACCOUNT_OWNER_BADGE, indexset![id])
        }
        BadgeProof::PoppedOff(id) => builder
            .create_proof_from_account_of_non_fungibles(from_account, ACCOUNT_OWNER_BADGE, indexset![id])
            .pop_from_auth_zone("badge_proof"),
    };
    let manifest = builder
        .withdraw_non_fungibles_from_account(
            from_account,
            asset_resource,
            indexset![NonFungibleLocalId::integer(asset_local_id)],
        )
        .take_all_from_worktop(asset_resource, "asset")
        .call_method_with_name_lookup(f.swap, "list", |lookup| {
            (seller, lookup.bucket("asset"), asks.clone(), expiry)
        })
        // Named proofs only: `drop_all_proofs` (DropAllProofs) also drops the
        // auth zone's SIGNATURE proofs (radix-engine 1.3.1
        // `AuthZoneBlueprint::drop_proofs`), and `deposit_batch` below needs
        // the fixture seller's signature.
        .drop_named_proofs()
        .call_method(
            from_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger.execute_manifest(manifest, signers)
}

/// Securified account, success path. The pinned account's OWNER rule is its
/// owner badge; the badge sits in the fixture seller's account, and the
/// transaction puts a proof of it in the auth zone. Only the fixture seller
/// signs (the securified account's original key does not). `cancel` then
/// delivers the asset to the securified account.
#[test]
fn test_owner_check_list_accepts_securified_account_with_owner_badge_proof() {
    let mut f = setup();
    let (secured, _original_pk, badge_id) = new_securified_account(&mut f);
    let signers = vec![NonFungibleGlobalId::from_public_key(&f.seller_pk)];
    list_with_badge_proof(&mut f, secured, 1, BadgeProof::InAuthZone(badge_id), signers)
        .expect_commit_success();
    assert_eq!(fetch_listing(&mut f, 1).seller, secured);

    let r = cancel_listing(&mut f, 1);
    r.expect_commit_success();
    assert_eq!(cancelled_event(&f, &r).destination, secured);
    assert_eq!(
        f.ledger.get_component_balance(secured, f.asset_resource),
        dec!("1"),
        "cancel delivered the asset to the securified account"
    );
}

/// Securified account, refusal paths, each failing the owner check:
/// 1. the account's ORIGINAL key signs but no badge proof is presented
///    (securify replaced the key rule, so the key alone no longer controls
///    the account);
/// 2. a proof of a DIFFERENT securified account's owner badge is presented;
/// 3. the right badge's proof exists in the transaction but was popped off
///    the auth zone into a named proof before `list`.
/// The NFT stays with the fixture seller throughout.
#[test]
fn test_owner_check_list_refuses_securified_account_without_its_badge_in_the_auth_zone() {
    let mut f = setup();
    let (secured, original_pk, badge_id) = new_securified_account(&mut f);
    let (_other, _, other_badge_id) = new_securified_account(&mut f);
    let seller_sig = NonFungibleGlobalId::from_public_key(&f.seller_pk);

    let key_only = vec![seller_sig.clone(), NonFungibleGlobalId::from_public_key(&original_pk)];
    list_with_badge_proof(&mut f, secured, 1, BadgeProof::Absent, key_only)
        .expect_commit_failure_containing_error("AssertAccessRuleFailed");

    list_with_badge_proof(&mut f, secured, 1, BadgeProof::InAuthZone(other_badge_id), vec![seller_sig.clone()])
        .expect_commit_failure_containing_error("AssertAccessRuleFailed");

    list_with_badge_proof(&mut f, secured, 1, BadgeProof::PoppedOff(badge_id), vec![seller_sig])
        .expect_commit_failure_containing_error("AssertAccessRuleFailed");

    assert_eq!(
        f.ledger.get_component_balance(f.seller_account, f.asset_resource),
        dec!("3"),
        "the NFT never left the seller"
    );
}
