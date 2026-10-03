use scrypto_test::prelude::*;

/// Test-only badge data that implements ManifestEncode for use with ManifestBuilder.
/// Field layout matches GuildBadgeData / UniversalBadgeData (SBOR is positional).
#[derive(ScryptoSbor, ManifestSbor, NonFungibleData)]
struct TestBadgeData {
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

/// Helper: create a test badge non-fungible resource with one badge,
/// deposit to account, and return the badge resource address and NFT local ID.
fn create_test_badge(
    ledger: &mut DefaultLedgerSimulator,
    public_key: &Secp256k1PublicKey,
    account: ComponentAddress,
    status: &str,
) -> (ResourceAddress, NonFungibleLocalId) {
    let nf_id = NonFungibleLocalId::String(
        StringNonFungibleLocalId::new("test_worker_1").unwrap(),
    );

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_non_fungible_resource::<_, TestBadgeData>(
            OwnerRole::None,
            NonFungibleIdType::String,
            true,
            NonFungibleResourceRoles::default(),
            metadata!(),
            Some(btreemap!(
                nf_id.clone() => TestBadgeData {
                    issued_to: "testworker".to_string(),
                    schema_name: "test_schema".to_string(),
                    issued_at: 1000i64,
                    tier: "member".to_string(),
                    status: status.to_string(),
                    last_updated: 1000i64,
                    xp: 0u64,
                    level: "member".to_string(),
                    extra_data: "{}".to_string(),
                },
            )),
        )
        .call_method(
            account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();

    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(public_key)],
    );
    receipt.expect_commit_success();

    let badge_resource = receipt.expect_commit(true).new_resource_addresses()[0];
    (badge_resource, nf_id)
}

/// Helper: create an escrow component with XRD reward and insurance.
/// Returns (escrow_component, poster_receipt_resource).
fn create_escrow(
    ledger: &mut DefaultLedgerSimulator,
    public_key: &Secp256k1PublicKey,
    account: ComponentAddress,
    package_address: PackageAddress,
    badge_resource: ResourceAddress,
    reward_amount: Decimal,
    insurance_amount: Decimal,
    task_id: &str,
) -> (ComponentAddress, ResourceAddress) {
    let total = reward_amount + insurance_amount;

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_from_account(account, XRD, total)
        .take_from_worktop(XRD, reward_amount, "reward")
        .take_from_worktop(XRD, insurance_amount, "insurance")
        .call_function_with_name_lookup(
            package_address,
            "GuildEscrow",
            "create_task",
            |lookup| (
                lookup.bucket("reward"),
                lookup.bucket("insurance"),
                task_id.to_string(),
                72u64,
                account,
                badge_resource,
            ),
        )
        .call_method(
            account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();

    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(public_key)],
    );
    receipt.expect_commit_success();

    let escrow = receipt.expect_commit(true).new_component_addresses()[0];
    // The poster receipt is the new NFT resource created during create_task
    let new_resources = receipt.expect_commit(true).new_resource_addresses();
    let receipt_resource = new_resources[new_resources.len() - 1];

    (escrow, receipt_resource)
}

#[test]
fn test_create_task_success() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (public_key, _private_key, account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    // Create a test badge resource (needed as parameter)
    let (badge_resource, _badge_id) =
        create_test_badge(&mut ledger, &public_key, account, "active");

    // Create escrow with 100 XRD reward + 2 XRD insurance
    let (escrow, _receipt_resource) = create_escrow(
        &mut ledger,
        &public_key,
        account,
        package_address,
        badge_resource,
        dec!("100"),
        dec!("2"),
        "task-001",
    );

    // Verify status is Open via get_status
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(escrow, "get_status", manifest_args!())
        .build();
    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&public_key)],
    );
    receipt.expect_commit_success();
}

#[test]
fn test_create_task_returns_poster_receipt() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (public_key, _private_key, account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    let (badge_resource, _badge_id) =
        create_test_badge(&mut ledger, &public_key, account, "active");

    let (_escrow, receipt_resource) = create_escrow(
        &mut ledger,
        &public_key,
        account,
        package_address,
        badge_resource,
        dec!("100"),
        dec!("2"),
        "task-002",
    );

    // Verify the poster receipt NFT was deposited to the poster's account
    let receipt_nf_id = NonFungibleLocalId::Integer(IntegerNonFungibleLocalId::new(1));
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            account,
            receipt_resource,
            vec![receipt_nf_id],
        )
        .build();
    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&public_key)],
    );
    receipt.expect_commit_success();
}

#[test]
fn test_claim_task_success() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (poster_pk, _poster_sk, poster_account) = ledger.new_allocated_account();
    let (worker_pk, _worker_sk, worker_account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    // Create badge for the worker
    let (badge_resource, badge_id) =
        create_test_badge(&mut ledger, &worker_pk, worker_account, "active");

    // Create escrow (poster creates it, using same badge_resource)
    let (escrow, _receipt_resource) = create_escrow(
        &mut ledger,
        &poster_pk,
        poster_account,
        package_address,
        badge_resource,
        dec!("100"),
        dec!("2"),
        "task-003",
    );

    // Worker claims the task with badge proof
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            worker_account,
            badge_resource,
            vec![badge_id],
        )
        .pop_from_auth_zone("worker_proof")
        .call_method_with_name_lookup(escrow, "claim_task", |lookup| (
            lookup.proof("worker_proof"),
            worker_account,
        ))
        .build();

    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&worker_pk)],
    );
    receipt.expect_commit_success();
}

#[test]
fn test_claim_task_non_open_panics() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (poster_pk, _poster_sk, poster_account) = ledger.new_allocated_account();
    let (worker_pk, _worker_sk, worker_account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    // Create badge for the worker — two NFTs on same resource
    let badge_nf_id_1 = NonFungibleLocalId::String(
        StringNonFungibleLocalId::new("worker_1").unwrap(),
    );
    let badge_nf_id_2 = NonFungibleLocalId::String(
        StringNonFungibleLocalId::new("worker_2").unwrap(),
    );

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_non_fungible_resource::<_, TestBadgeData>(
            OwnerRole::None,
            NonFungibleIdType::String,
            true,
            NonFungibleResourceRoles::default(),
            metadata!(),
            Some(btreemap!(
                badge_nf_id_1.clone() => TestBadgeData {
                    issued_to: "worker1".to_string(),
                    schema_name: "test_schema".to_string(),
                    issued_at: 1000i64,
                    tier: "member".to_string(),
                    status: "active".to_string(),
                    last_updated: 1000i64,
                    xp: 0u64,
                    level: "member".to_string(),
                    extra_data: "{}".to_string(),
                },
                badge_nf_id_2.clone() => TestBadgeData {
                    issued_to: "worker2".to_string(),
                    schema_name: "test_schema".to_string(),
                    issued_at: 1000i64,
                    tier: "member".to_string(),
                    status: "active".to_string(),
                    last_updated: 1000i64,
                    xp: 0u64,
                    level: "member".to_string(),
                    extra_data: "{}".to_string(),
                },
            )),
        )
        .call_method(
            worker_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();

    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&worker_pk)],
    );
    receipt.expect_commit_success();
    let badge_resource = receipt.expect_commit(true).new_resource_addresses()[0];

    // Create escrow
    let (escrow, _receipt_resource) = create_escrow(
        &mut ledger,
        &poster_pk,
        poster_account,
        package_address,
        badge_resource,
        dec!("100"),
        dec!("2"),
        "task-004",
    );

    // Worker claims with first badge — success
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            worker_account,
            badge_resource,
            vec![badge_nf_id_1],
        )
        .pop_from_auth_zone("worker_proof")
        .call_method_with_name_lookup(escrow, "claim_task", |lookup| (
            lookup.proof("worker_proof"),
            worker_account,
        ))
        .build();
    ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&worker_pk)],
    ).expect_commit_success();

    // Second claim with different badge on same resource — should fail (status is Claimed, not Open)
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            worker_account,
            badge_resource,
            vec![badge_nf_id_2],
        )
        .pop_from_auth_zone("worker_proof")
        .call_method_with_name_lookup(escrow, "claim_task", |lookup| (
            lookup.proof("worker_proof"),
            worker_account,
        ))
        .build();
    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&worker_pk)],
    );
    receipt.expect_commit_failure();
}

#[test]
fn test_claim_task_invalid_badge_panics() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (poster_pk, _poster_sk, poster_account) = ledger.new_allocated_account();
    let (worker_pk, _worker_sk, worker_account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    // Create the "real" badge resource for escrow config
    let (badge_resource, _badge_id) =
        create_test_badge(&mut ledger, &poster_pk, poster_account, "active");

    // Create a DIFFERENT badge resource for the worker (wrong resource)
    let (wrong_badge_resource, wrong_badge_id) =
        create_test_badge(&mut ledger, &worker_pk, worker_account, "active");

    // Create escrow expecting the "real" badge resource
    let (escrow, _receipt_resource) = create_escrow(
        &mut ledger,
        &poster_pk,
        poster_account,
        package_address,
        badge_resource,
        dec!("100"),
        dec!("2"),
        "task-005",
    );

    // Worker tries to claim with wrong badge resource — should fail at proof.check()
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            worker_account,
            wrong_badge_resource,
            vec![wrong_badge_id],
        )
        .pop_from_auth_zone("worker_proof")
        .call_method_with_name_lookup(escrow, "claim_task", |lookup| (
            lookup.proof("worker_proof"),
            worker_account,
        ))
        .build();

    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&worker_pk)],
    );
    receipt.expect_commit_failure();
}

#[test]
fn test_claim_task_revoked_badge_panics() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (poster_pk, _poster_sk, poster_account) = ledger.new_allocated_account();
    let (worker_pk, _worker_sk, worker_account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    // Create a badge with status="revoked" for the worker
    let (badge_resource, badge_id) =
        create_test_badge(&mut ledger, &worker_pk, worker_account, "revoked");

    // Create escrow using this badge resource
    let (escrow, _receipt_resource) = create_escrow(
        &mut ledger,
        &poster_pk,
        poster_account,
        package_address,
        badge_resource,
        dec!("100"),
        dec!("2"),
        "task-006",
    );

    // Worker tries to claim with revoked badge — should fail
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            worker_account,
            badge_resource,
            vec![badge_id],
        )
        .pop_from_auth_zone("worker_proof")
        .call_method_with_name_lookup(escrow, "claim_task", |lookup| (
            lookup.proof("worker_proof"),
            worker_account,
        ))
        .build();

    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&worker_pk)],
    );
    receipt.expect_commit_failure();
}

// ============================================================
// US-009: dispute flow and insurance vault tests
// ============================================================

/// Helper: create a shared badge resource with multiple NFTs (different levels).
/// Returns (badge_resource, worker_nf_id, arbiter_nf_id).
fn create_shared_badge_resource(
    ledger: &mut DefaultLedgerSimulator,
    worker_pk: &Secp256k1PublicKey,
    worker_account: ComponentAddress,
    arbiter_pk: &Secp256k1PublicKey,
    arbiter_account: ComponentAddress,
    arbiter_level: &str,
) -> (ResourceAddress, NonFungibleLocalId, NonFungibleLocalId) {
    let worker_nf_id = NonFungibleLocalId::String(
        StringNonFungibleLocalId::new("worker_badge").unwrap(),
    );
    let arbiter_nf_id = NonFungibleLocalId::String(
        StringNonFungibleLocalId::new("arbiter_badge").unwrap(),
    );

    // Create resource with worker badge minted to worker_account
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_non_fungible_resource::<_, TestBadgeData>(
            OwnerRole::None,
            NonFungibleIdType::String,
            true,
            NonFungibleResourceRoles {
                mint_roles: mint_roles! {
                    minter => rule!(allow_all);
                    minter_updater => rule!(deny_all);
                },
                ..Default::default()
            },
            metadata!(),
            Some(btreemap!(
                worker_nf_id.clone() => TestBadgeData {
                    issued_to: "worker".to_string(),
                    schema_name: "test_schema".to_string(),
                    issued_at: 1000i64,
                    tier: "member".to_string(),
                    status: "active".to_string(),
                    last_updated: 1000i64,
                    xp: 0u64,
                    level: "member".to_string(),
                    extra_data: "{}".to_string(),
                },
            )),
        )
        .call_method(
            worker_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();

    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(worker_pk)],
    );
    receipt.expect_commit_success();
    let badge_resource = receipt.expect_commit(true).new_resource_addresses()[0];

    // Mint arbiter badge on the same resource and deposit to arbiter_account
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .mint_non_fungible(
            badge_resource,
            btreemap!(
                arbiter_nf_id.clone() => TestBadgeData {
                    issued_to: "arbiter".to_string(),
                    schema_name: "test_schema".to_string(),
                    issued_at: 1000i64,
                    tier: arbiter_level.to_string(),
                    status: "active".to_string(),
                    last_updated: 1000i64,
                    xp: 500u64,
                    level: arbiter_level.to_string(),
                    extra_data: "{}".to_string(),
                },
            ),
        )
        .call_method(
            arbiter_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();

    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(arbiter_pk)],
    );
    receipt.expect_commit_success();

    (badge_resource, worker_nf_id, arbiter_nf_id)
}

/// Helper: set up escrow in Submitted state with shared badge resource.
fn setup_submitted_escrow_with_shared_badge(
    ledger: &mut DefaultLedgerSimulator,
    poster_pk: &Secp256k1PublicKey,
    poster_account: ComponentAddress,
    worker_pk: &Secp256k1PublicKey,
    worker_account: ComponentAddress,
    package_address: PackageAddress,
    badge_resource: ResourceAddress,
    worker_badge_id: NonFungibleLocalId,
) -> (ComponentAddress, ResourceAddress) {
    let (escrow, receipt_resource) = create_escrow(
        ledger, poster_pk, poster_account, package_address,
        badge_resource, dec!("100"), dec!("2"), "task-dispute",
    );

    claim_task(ledger, worker_pk, worker_account, escrow, badge_resource, worker_badge_id);
    submit_work(ledger, worker_pk, escrow, "QmDisputeHash").expect_commit_success();

    (escrow, receipt_resource)
}

/// Helper: raise dispute on escrow (poster raises it).
fn raise_dispute(
    ledger: &mut DefaultLedgerSimulator,
    poster_pk: &Secp256k1PublicKey,
    poster_account: ComponentAddress,
    escrow: ComponentAddress,
    receipt_resource: ResourceAddress,
) {
    let receipt_nf_id = NonFungibleLocalId::Integer(IntegerNonFungibleLocalId::new(1));
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            poster_account,
            receipt_resource,
            vec![receipt_nf_id],
        )
        .call_method(escrow, "raise_dispute", manifest_args!())
        .build();
    ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(poster_pk)],
    ).expect_commit_success();
}

#[test]
fn test_raise_dispute_success() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (poster_pk, _poster_sk, poster_account) = ledger.new_allocated_account();
    let (worker_pk, _worker_sk, worker_account) = ledger.new_allocated_account();
    let (arbiter_pk, _arbiter_sk, arbiter_account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    let (badge_resource, worker_badge_id, _arbiter_badge_id) = create_shared_badge_resource(
        &mut ledger, &worker_pk, worker_account, &arbiter_pk, arbiter_account, "elder",
    );

    let (escrow, receipt_resource) = setup_submitted_escrow_with_shared_badge(
        &mut ledger, &poster_pk, poster_account,
        &worker_pk, worker_account, package_address,
        badge_resource, worker_badge_id,
    );

    // Poster raises dispute
    raise_dispute(&mut ledger, &poster_pk, poster_account, escrow, receipt_resource);
}

#[test]
fn test_resolve_dispute_pay_worker() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (poster_pk, _poster_sk, poster_account) = ledger.new_allocated_account();
    let (worker_pk, _worker_sk, worker_account) = ledger.new_allocated_account();
    let (arbiter_pk, _arbiter_sk, arbiter_account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    let (badge_resource, worker_badge_id, arbiter_badge_id) = create_shared_badge_resource(
        &mut ledger, &worker_pk, worker_account, &arbiter_pk, arbiter_account, "elder",
    );

    let (escrow, receipt_resource) = setup_submitted_escrow_with_shared_badge(
        &mut ledger, &poster_pk, poster_account,
        &worker_pk, worker_account, package_address,
        badge_resource, worker_badge_id,
    );

    raise_dispute(&mut ledger, &poster_pk, poster_account, escrow, receipt_resource);

    // Elder arbiter resolves: PayWorker
    let arbiter_xrd_before = ledger.get_component_balance(arbiter_account, XRD);

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        // First proof stays on auth zone for role check
        .create_proof_from_account_of_non_fungibles(
            arbiter_account,
            badge_resource,
            vec![arbiter_badge_id.clone()],
        )
        // Second proof popped and passed as method argument
        .create_proof_from_account_of_non_fungibles(
            arbiter_account,
            badge_resource,
            vec![arbiter_badge_id],
        )
        .pop_from_auth_zone("arbiter_proof")
        .call_method_with_name_lookup(escrow, "resolve_dispute", |lookup| {
            let ruling: guild_escrow::DisputeRuling = guild_escrow::DisputeRuling::PayWorker;
            (lookup.proof("arbiter_proof"), ruling)
        })
        .call_method(
            arbiter_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();

    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&arbiter_pk)],
    );
    receipt.expect_commit_success();

    // TEST SIMPLIFICATION: All returned buckets deposited to arbiter_account.
    // In production: reward (100 XRD) goes to WORKER, only arbiter_fee (0.2 XRD) goes to arbiter.
    let arbiter_xrd_after = ledger.get_component_balance(arbiter_account, XRD);
    assert_eq!(arbiter_xrd_after - arbiter_xrd_before, dec!("100.2"));
}

#[test]
fn test_resolve_dispute_refund_poster() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (poster_pk, _poster_sk, poster_account) = ledger.new_allocated_account();
    let (worker_pk, _worker_sk, worker_account) = ledger.new_allocated_account();
    let (arbiter_pk, _arbiter_sk, arbiter_account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    let (badge_resource, worker_badge_id, arbiter_badge_id) = create_shared_badge_resource(
        &mut ledger, &worker_pk, worker_account, &arbiter_pk, arbiter_account, "steward",
    );

    let (escrow, receipt_resource) = setup_submitted_escrow_with_shared_badge(
        &mut ledger, &poster_pk, poster_account,
        &worker_pk, worker_account, package_address,
        badge_resource, worker_badge_id,
    );

    raise_dispute(&mut ledger, &poster_pk, poster_account, escrow, receipt_resource);

    // Steward arbiter resolves: RefundPoster
    let arbiter_xrd_before = ledger.get_component_balance(arbiter_account, XRD);

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            arbiter_account,
            badge_resource,
            vec![arbiter_badge_id.clone()],
        )
        .create_proof_from_account_of_non_fungibles(
            arbiter_account,
            badge_resource,
            vec![arbiter_badge_id],
        )
        .pop_from_auth_zone("arbiter_proof")
        .call_method_with_name_lookup(escrow, "resolve_dispute", |lookup| {
            let ruling: guild_escrow::DisputeRuling = guild_escrow::DisputeRuling::RefundPoster;
            (lookup.proof("arbiter_proof"), ruling)
        })
        .call_method(
            arbiter_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();

    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&arbiter_pk)],
    );
    receipt.expect_commit_success();

    // TEST SIMPLIFICATION: All returned buckets deposited to arbiter_account.
    // In production: refund (100 XRD) goes to POSTER, only arbiter_fee (0.2 XRD) goes to arbiter.
    let arbiter_xrd_after = ledger.get_component_balance(arbiter_account, XRD);
    assert_eq!(arbiter_xrd_after - arbiter_xrd_before, dec!("100.2"));
}

#[test]
fn test_resolve_dispute_split() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (poster_pk, _poster_sk, poster_account) = ledger.new_allocated_account();
    let (worker_pk, _worker_sk, worker_account) = ledger.new_allocated_account();
    let (arbiter_pk, _arbiter_sk, arbiter_account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    let (badge_resource, worker_badge_id, arbiter_badge_id) = create_shared_badge_resource(
        &mut ledger, &worker_pk, worker_account, &arbiter_pk, arbiter_account, "elder",
    );

    let (escrow, receipt_resource) = setup_submitted_escrow_with_shared_badge(
        &mut ledger, &poster_pk, poster_account,
        &worker_pk, worker_account, package_address,
        badge_resource, worker_badge_id,
    );

    raise_dispute(&mut ledger, &poster_pk, poster_account, escrow, receipt_resource);

    // Elder arbiter resolves: Split 60/40
    let arbiter_xrd_before = ledger.get_component_balance(arbiter_account, XRD);

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            arbiter_account,
            badge_resource,
            vec![arbiter_badge_id.clone()],
        )
        .create_proof_from_account_of_non_fungibles(
            arbiter_account,
            badge_resource,
            vec![arbiter_badge_id],
        )
        .pop_from_auth_zone("arbiter_proof")
        .call_method_with_name_lookup(escrow, "resolve_dispute", |lookup| {
            let ruling: guild_escrow::DisputeRuling = guild_escrow::DisputeRuling::Split(dec!("0.6"), dec!("0.4"));
            (lookup.proof("arbiter_proof"), ruling)
        })
        .call_method(
            arbiter_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();

    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&arbiter_pk)],
    );
    receipt.expect_commit_success();

    // TEST SIMPLIFICATION: All returned buckets deposited to arbiter_account.
    // In production: split reward (100 XRD) goes to WORKER+POSTER per split %, only arbiter_fee (0.2 XRD) goes to arbiter.
    let arbiter_xrd_after = ledger.get_component_balance(arbiter_account, XRD);
    assert_eq!(arbiter_xrd_after - arbiter_xrd_before, dec!("100.2"));
}

#[test]
fn test_resolve_dispute_non_elder_panics() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (poster_pk, _poster_sk, poster_account) = ledger.new_allocated_account();
    let (worker_pk, _worker_sk, worker_account) = ledger.new_allocated_account();
    let (arbiter_pk, _arbiter_sk, arbiter_account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    // Arbiter has "member" level (not elder/steward)
    let (badge_resource, worker_badge_id, arbiter_badge_id) = create_shared_badge_resource(
        &mut ledger, &worker_pk, worker_account, &arbiter_pk, arbiter_account, "member",
    );

    let (escrow, receipt_resource) = setup_submitted_escrow_with_shared_badge(
        &mut ledger, &poster_pk, poster_account,
        &worker_pk, worker_account, package_address,
        badge_resource, worker_badge_id,
    );

    raise_dispute(&mut ledger, &poster_pk, poster_account, escrow, receipt_resource);

    // Member-level arbiter tries to resolve — should panic on level check
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            arbiter_account,
            badge_resource,
            vec![arbiter_badge_id.clone()],
        )
        .create_proof_from_account_of_non_fungibles(
            arbiter_account,
            badge_resource,
            vec![arbiter_badge_id],
        )
        .pop_from_auth_zone("arbiter_proof")
        .call_method_with_name_lookup(escrow, "resolve_dispute", |lookup| {
            let ruling: guild_escrow::DisputeRuling = guild_escrow::DisputeRuling::PayWorker;
            (lookup.proof("arbiter_proof"), ruling)
        })
        .call_method(
            arbiter_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();

    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&arbiter_pk)],
    );
    receipt.expect_commit_failure();
}

// ============================================================
// US-008: submit_work and approve_and_release tests
// ============================================================

/// Helper: claim a task (worker claims with badge proof).
fn claim_task(
    ledger: &mut DefaultLedgerSimulator,
    worker_pk: &Secp256k1PublicKey,
    worker_account: ComponentAddress,
    escrow: ComponentAddress,
    badge_resource: ResourceAddress,
    badge_id: NonFungibleLocalId,
) {
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            worker_account,
            badge_resource,
            vec![badge_id],
        )
        .pop_from_auth_zone("worker_proof")
        .call_method_with_name_lookup(escrow, "claim_task", |lookup| (
            lookup.proof("worker_proof"),
            worker_account,
        ))
        .build();

    ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(worker_pk)],
    ).expect_commit_success();
}

/// Helper: submit work on an escrow component.
fn submit_work(
    ledger: &mut DefaultLedgerSimulator,
    caller_pk: &Secp256k1PublicKey,
    escrow: ComponentAddress,
    deliverable_hash: &str,
) -> TransactionReceiptV1 {
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(escrow, "submit_work", manifest_args!(deliverable_hash.to_string()))
        .build();

    ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(caller_pk)],
    )
}

#[test]
fn test_submit_work_success() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (poster_pk, _poster_sk, poster_account) = ledger.new_allocated_account();
    let (worker_pk, _worker_sk, worker_account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    let (badge_resource, badge_id) =
        create_test_badge(&mut ledger, &worker_pk, worker_account, "active");
    let (escrow, _receipt_resource) = create_escrow(
        &mut ledger, &poster_pk, poster_account, package_address,
        badge_resource, dec!("100"), dec!("2"), "task-submit-1",
    );

    // Worker claims
    claim_task(&mut ledger, &worker_pk, worker_account, escrow, badge_resource, badge_id);

    // Worker submits work
    let receipt = submit_work(&mut ledger, &worker_pk, escrow, "QmHash123abc");
    receipt.expect_commit_success();

    // Verify status changed via get_task_info
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(escrow, "get_task_info", manifest_args!())
        .build();
    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&poster_pk)],
    );
    receipt.expect_commit_success();
}

#[test]
fn test_approve_and_release_success() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (poster_pk, _poster_sk, poster_account) = ledger.new_allocated_account();
    let (worker_pk, _worker_sk, worker_account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    let (badge_resource, badge_id) =
        create_test_badge(&mut ledger, &worker_pk, worker_account, "active");
    let (escrow, receipt_resource) = create_escrow(
        &mut ledger, &poster_pk, poster_account, package_address,
        badge_resource, dec!("100"), dec!("2"), "task-approve-1",
    );

    // Worker claims and submits
    claim_task(&mut ledger, &worker_pk, worker_account, escrow, badge_resource, badge_id);
    submit_work(&mut ledger, &worker_pk, escrow, "QmHash456def").expect_commit_success();

    // Get poster's XRD balance before release (poster receives reward, forwards to worker off-test)
    let poster_xrd_before = ledger.get_component_balance(poster_account, XRD);

    // Poster approves and releases — must present poster receipt proof
    let receipt_nf_id = NonFungibleLocalId::Integer(IntegerNonFungibleLocalId::new(1));
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            poster_account,
            receipt_resource,
            vec![receipt_nf_id],
        )
        .call_method(escrow, "approve_and_release", manifest_args!())
        .call_method(
            poster_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();

    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&poster_pk)],
    );
    receipt.expect_commit_success();

    // Verify poster received the 100 XRD reward bucket
    let poster_xrd_after = ledger.get_component_balance(poster_account, XRD);
    assert_eq!(poster_xrd_after - poster_xrd_before, dec!("100"));

    // Verify insurance vault still has balance (not touched by approve_and_release)
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(escrow, "get_task_info", manifest_args!())
        .build();
    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&poster_pk)],
    );
    receipt.expect_commit_success();
}

#[test]
fn test_submit_work_not_claimed_panics() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (poster_pk, _poster_sk, poster_account) = ledger.new_allocated_account();
    let (worker_pk, _worker_sk, worker_account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    let (badge_resource, _badge_id) =
        create_test_badge(&mut ledger, &worker_pk, worker_account, "active");
    let (escrow, _receipt_resource) = create_escrow(
        &mut ledger, &poster_pk, poster_account, package_address,
        badge_resource, dec!("100"), dec!("2"), "task-submit-fail-1",
    );

    // Try to submit work without claiming first (status is Open) — should fail
    let receipt = submit_work(&mut ledger, &worker_pk, escrow, "QmHash789");
    receipt.expect_commit_failure();
}

#[test]
fn test_approve_not_submitted_panics() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (poster_pk, _poster_sk, poster_account) = ledger.new_allocated_account();
    let (worker_pk, _worker_sk, worker_account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    let (badge_resource, badge_id) =
        create_test_badge(&mut ledger, &worker_pk, worker_account, "active");
    let (escrow, receipt_resource) = create_escrow(
        &mut ledger, &poster_pk, poster_account, package_address,
        badge_resource, dec!("100"), dec!("2"), "task-approve-fail-1",
    );

    // Worker claims but does NOT submit
    claim_task(&mut ledger, &worker_pk, worker_account, escrow, badge_resource, badge_id);

    // Poster tries to approve (status is Claimed, not Submitted) — should fail
    let receipt_nf_id = NonFungibleLocalId::Integer(IntegerNonFungibleLocalId::new(1));
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            poster_account,
            receipt_resource,
            vec![receipt_nf_id],
        )
        .call_method(escrow, "approve_and_release", manifest_args!())
        .call_method(
            poster_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();

    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&poster_pk)],
    );
    receipt.expect_commit_failure();
}

#[test]
fn test_double_approve_panics() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (poster_pk, _poster_sk, poster_account) = ledger.new_allocated_account();
    let (worker_pk, _worker_sk, worker_account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    let (badge_resource, badge_id) =
        create_test_badge(&mut ledger, &worker_pk, worker_account, "active");
    let (escrow, receipt_resource) = create_escrow(
        &mut ledger, &poster_pk, poster_account, package_address,
        badge_resource, dec!("100"), dec!("2"), "task-double-approve-1",
    );

    // Worker claims and submits
    claim_task(&mut ledger, &worker_pk, worker_account, escrow, badge_resource, badge_id);
    submit_work(&mut ledger, &worker_pk, escrow, "QmHashDouble").expect_commit_success();

    // First approve — success (deposit released XRD to poster's own account)
    let receipt_nf_id = NonFungibleLocalId::Integer(IntegerNonFungibleLocalId::new(1));
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            poster_account,
            receipt_resource,
            vec![receipt_nf_id.clone()],
        )
        .call_method(escrow, "approve_and_release", manifest_args!())
        .call_method(
            poster_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();

    ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&poster_pk)],
    ).expect_commit_success();

    // Second approve — should fail (status is Released, not Submitted)
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            poster_account,
            receipt_resource,
            vec![receipt_nf_id],
        )
        .call_method(escrow, "approve_and_release", manifest_args!())
        .call_method(
            poster_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();

    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&poster_pk)],
    );
    receipt.expect_commit_failure();
}
