//! Ledger tests for the `NftSwap` blueprint (P7-02, task 90).
//!
//! Source-level tests at the bottom of this file run on the Mac
//! (`cargo test`, no `setup()` call — see CLAUDE.md "Scrypto on this Mac").
//! Every other test instantiates the ledger simulator and therefore only
//! runs in CI (`.github/workflows/scrypto.yml`) per the same note: the
//! wasm32 build `scrypto-test`'s ledger simulator needs fails locally on
//! this Mac (`blst` will not build for `wasm32-unknown-unknown` here).

use guild_marketplace_escrow::nft_swap::{Ask, Listing, ListingState, NftSwapConfig};
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
    let nf_id = NonFungibleLocalId::integer(asset_local_id);
    let seller_account = f.seller_account;
    let asset_resource = f.asset_resource;
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_non_fungibles_from_account(seller_account, asset_resource, indexset![nf_id])
        .take_all_from_worktop(asset_resource, "asset")
        .call_method_with_name_lookup(f.swap, "list", |lookup| {
            (seller_account, lookup.bucket("asset"), asks.clone(), expires_at)
        })
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

#[test]
fn test_extend_listing_pushes_expiry_by_30_days() {
    let mut f = setup();
    let now = current_instant(&mut f);
    let expiry = Instant::new(now.seconds_since_unix_epoch + 7 * 24 * 60 * 60);
    let asks = vec![Ask::Fungible { resource: f.payment_token, amount: dec!("100") }];
    list_asset(&mut f, 1, asks, expiry).expect_commit_success();

    extend_listing(&mut f, 1).expect_commit_success();

    let listing = fetch_listing(&mut f, 1);
    assert_eq!(
        listing.expires_at.seconds_since_unix_epoch,
        expiry.seconds_since_unix_epoch + 30 * 24 * 60 * 60,
        "extend adds exactly 30 days from the PRIOR expires_at when that is still in the future"
    );

    // A second extension is still allowed — the S2 ceiling only bounds
    // `list`, never `extend_listing`.
    extend_listing(&mut f, 1).expect_commit_success();
    let listing = fetch_listing(&mut f, 1);
    assert_eq!(
        listing.expires_at.seconds_since_unix_epoch,
        expiry.seconds_since_unix_epoch + 60 * 24 * 60 * 60
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
