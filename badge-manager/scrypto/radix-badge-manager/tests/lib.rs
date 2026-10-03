use scrypto_test::prelude::*;

#[test]
fn test_factory_instantiate() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (public_key, _private_key, account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_function(package_address, "BadgeFactory", "instantiate", manifest_args!())
        .call_method(account, "deposit_batch", manifest_args!(ManifestExpression::EntireWorktop))
        .build();

    let receipt = ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&public_key)]);
    receipt.expect_commit_success();

    let factory = receipt.expect_commit(true).new_component_addresses()[0];
    println!("Factory: {:?}", factory);
}

#[test]
fn test_create_manager() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (public_key, _private_key, account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    // Instantiate factory
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_function(package_address, "BadgeFactory", "instantiate", manifest_args!())
        .call_method(account, "deposit_batch", manifest_args!(ManifestExpression::EntireWorktop))
        .build();
    let receipt = ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&public_key)]);
    receipt.expect_commit_success();
    let factory = receipt.expect_commit(true).new_component_addresses()[0];

    // Find the factory owner badge
    let owner_badge = receipt.expect_commit(true).new_resource_addresses()[0];

    // Create manager
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(account, "create_proof_of_amount", manifest_args!(owner_badge, dec!("1")))
        .call_method(
            factory,
            "create_manager",
            manifest_args!(
                "guild_member".to_string(),
                vec!["member".to_string(), "contributor".to_string(), "builder".to_string(), "steward".to_string(), "elder".to_string()],
                "member".to_string(),
                true,
                "Test Badge".to_string(),
                "A test badge".to_string(),
                GlobalAddress::from(account)
            ),
        )
        .call_method(account, "deposit_batch", manifest_args!(ManifestExpression::EntireWorktop))
        .build();

    let receipt = ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&public_key)]);
    println!("{:?}", receipt);
    receipt.expect_commit_success();
}

// Helper: set up factory + manager, return addresses
fn setup_with_manager() -> (DefaultLedgerSimulator, Secp256k1PublicKey, ComponentAddress, ComponentAddress, ResourceAddress, ComponentAddress) {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (public_key, _private_key, account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    // Factory
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_function(package_address, "BadgeFactory", "instantiate", manifest_args!())
        .call_method(account, "deposit_batch", manifest_args!(ManifestExpression::EntireWorktop))
        .build();
    let receipt = ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&public_key)]);
    receipt.expect_commit_success();
    let factory = receipt.expect_commit(true).new_component_addresses()[0];
    let owner_badge = receipt.expect_commit(true).new_resource_addresses()[0];

    // Manager
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(account, "create_proof_of_amount", manifest_args!(owner_badge, dec!("1")))
        .call_method(
            factory,
            "create_manager",
            manifest_args!(
                "test_schema".to_string(),
                vec!["member".to_string(), "contributor".to_string(), "builder".to_string(), "steward".to_string(), "elder".to_string()],
                "member".to_string(),
                true,
                "Test Badge".to_string(),
                "A test badge".to_string(),
                GlobalAddress::from(account)
            ),
        )
        .call_method(account, "deposit_batch", manifest_args!(ManifestExpression::EntireWorktop))
        .build();
    let receipt = ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&public_key)]);
    receipt.expect_commit_success();
    let manager = receipt.expect_commit(true).new_component_addresses()[0];

    (ledger, public_key, account, factory, owner_badge, manager)
}

#[test]
fn test_public_mint() {
    let (mut ledger, public_key, account, _, _, manager) = setup_with_manager();

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(manager, "public_mint", manifest_args!("testuser".to_string()))
        .call_method(account, "deposit_batch", manifest_args!(ManifestExpression::EntireWorktop))
        .build();

    let receipt = ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&public_key)]);
    receipt.expect_commit_success();
}

#[test]
fn test_public_mint_empty_username_fails() {
    let (mut ledger, public_key, account, _, _, manager) = setup_with_manager();

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(manager, "public_mint", manifest_args!("".to_string()))
        .call_method(account, "deposit_batch", manifest_args!(ManifestExpression::EntireWorktop))
        .build();

    let receipt = ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&public_key)]);
    receipt.expect_commit_failure();
}

#[test]
fn test_public_mint_long_username_fails() {
    let (mut ledger, public_key, account, _, _, manager) = setup_with_manager();

    let long_name = "a".repeat(65);
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(manager, "public_mint", manifest_args!(long_name))
        .call_method(account, "deposit_batch", manifest_args!(ManifestExpression::EntireWorktop))
        .build();

    let receipt = ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&public_key)]);
    receipt.expect_commit_failure();
}

#[test]
fn test_get_schema_name() {
    let (mut ledger, public_key, _, _, _, manager) = setup_with_manager();

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(manager, "get_schema_name", manifest_args!())
        .build();

    let receipt = ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&public_key)]);
    receipt.expect_commit_success();
}

#[test]
fn test_get_valid_tiers() {
    let (mut ledger, public_key, _, _, _, manager) = setup_with_manager();

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(manager, "get_valid_tiers", manifest_args!())
        .build();

    let receipt = ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&public_key)]);
    receipt.expect_commit_success();
}

#[test]
fn test_get_stats_after_mint() {
    let (mut ledger, public_key, account, _, _, manager) = setup_with_manager();

    // Mint a badge first
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(manager, "public_mint", manifest_args!("user1".to_string()))
        .call_method(account, "deposit_batch", manifest_args!(ManifestExpression::EntireWorktop))
        .build();
    ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&public_key)])
        .expect_commit_success();

    // Check stats
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(manager, "get_stats", manifest_args!())
        .build();
    let receipt = ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&public_key)]);
    receipt.expect_commit_success();
}

#[test]
fn test_factory_pause_unpause() {
    let (mut ledger, public_key, account, factory, owner_badge, _) = setup_with_manager();

    // Pause
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(account, "create_proof_of_amount", manifest_args!(owner_badge, dec!("1")))
        .call_method(factory, "pause_factory", manifest_args!())
        .build();
    ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&public_key)])
        .expect_commit_success();

    // Unpause
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(account, "create_proof_of_amount", manifest_args!(owner_badge, dec!("1")))
        .call_method(factory, "unpause_factory", manifest_args!())
        .build();
    ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&public_key)])
        .expect_commit_success();
}

#[test]
fn test_duplicate_username_fails() {
    let (mut ledger, public_key, account, _, _, manager) = setup_with_manager();

    // First mint — should succeed
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(manager, "public_mint", manifest_args!("alice".to_string()))
        .call_method(account, "deposit_batch", manifest_args!(ManifestExpression::EntireWorktop))
        .build();
    ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&public_key)])
        .expect_commit_success();

    // Second mint with same username — should fail (NFT ID already exists)
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(manager, "public_mint", manifest_args!("alice".to_string()))
        .call_method(account, "deposit_batch", manifest_args!(ManifestExpression::EntireWorktop))
        .build();
    let receipt = ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&public_key)]);
    receipt.expect_commit_failure();
}

#[test]
fn test_case_insensitive_duplicate_fails() {
    let (mut ledger, public_key, account, _, _, manager) = setup_with_manager();

    // Mint "Alice"
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(manager, "public_mint", manifest_args!("Alice".to_string()))
        .call_method(account, "deposit_batch", manifest_args!(ManifestExpression::EntireWorktop))
        .build();
    ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&public_key)])
        .expect_commit_success();

    // Mint "alice" (lowercase) — should fail (same ID after sanitization)
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(manager, "public_mint", manifest_args!("alice".to_string()))
        .call_method(account, "deposit_batch", manifest_args!(ManifestExpression::EntireWorktop))
        .build();
    let receipt = ledger.execute_manifest(manifest, vec![NonFungibleGlobalId::from_public_key(&public_key)]);
    receipt.expect_commit_failure();
}
