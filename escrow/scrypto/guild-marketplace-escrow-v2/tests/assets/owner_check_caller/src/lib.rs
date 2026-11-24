use scrypto::prelude::*;

// TEST-ONLY blueprint (see Cargo.toml). A GLOBAL component that forwards a
// call to NftSwap `list` or the escrow's `create_task` / `claim_task`, so the
// owner check those methods run sees THIS component as its global caller.
//
// What the tests use it for: `Runtime::assert_access_rule` checks the global
// caller's auth zone (radix-engine 1.3.1 `Authorization::auth_zone_stack_matches`).
// Through this component that is this component's own auth zone, not the
// transaction's, so the transaction's signature proofs are out of reach.
//
// Badges come in as BUCKETS, never as proofs. A proof passed into a component
// is marked restricted, and the engine then refuses to move it into that
// component's auth zone or on to another component ("Moving restricted proof
// downstream", radix-engine 1.3.1 `NonFungibleProofBlueprint::on_move`). So
// this component creates its own proofs from the badges it is handed, uses
// them, drops them, and returns the badges.

/// Mirror of `guild_marketplace_escrow_v2::nft_swap::Ask`: the same variants
/// in the same order with the same field types, so the bytes this component
/// forwards decode as NftSwap's own `Ask`.
#[derive(ScryptoSbor, ManifestSbor, Clone, Debug, PartialEq)]
pub enum Ask {
    Fungible { resource: ResourceAddress, amount: Decimal },
    NonFungible { resource: ResourceAddress, id: NonFungibleLocalId },
}

#[blueprint]
mod owner_check_caller {
    struct OwnerCheckCaller {}

    impl OwnerCheckCaller {
        pub fn instantiate() -> Global<OwnerCheckCaller> {
            Self {}
                .instantiate()
                .prepare_to_globalize(OwnerRole::None)
                .globalize()
        }

        /// NftSwap `list(seller, asset, asks, expires_at)`, called from here.
        /// With `owner_badge`, a proof of it sits in THIS component's auth
        /// zone during the call. Returns the listing receipt and the badge.
        pub fn list_via(
            &self,
            swap: ComponentAddress,
            seller: ComponentAddress,
            asset: NonFungibleBucket,
            asks: Vec<Ask>,
            expires_at: Instant,
            owner_badge: Option<Bucket>,
        ) -> (Bucket, Option<Bucket>) {
            Self::push_proof_of(&owner_badge);
            let swap: Global<AnyComponent> = swap.into();
            let receipt: Bucket = swap.call("list", &(seller, asset, asks, expires_at));
            LocalAuthZone::drop_regular_proofs();
            (receipt, owner_badge)
        }

        /// Escrow `create_task(poster, reward, insurance, fee, brief)`, called
        /// from here with nothing in this component's auth zone.
        pub fn create_task_via(
            &self,
            escrow: ComponentAddress,
            poster: ComponentAddress,
            reward: Bucket,
            insurance: Bucket,
            arbiter_fee_pct: Decimal,
            work_brief_hash: Hash,
        ) -> Bucket {
            let escrow: Global<AnyComponent> = escrow.into();
            escrow.call(
                "create_task",
                &(poster, reward, insurance, arbiter_fee_pct, work_brief_hash),
            )
        }

        /// Escrow `claim_task(task_id, worker, worker_badge, claim_bond)`,
        /// called from here. The worker-badge proof is created here from
        /// `worker_badge`. With `owner_badge`, a proof of it sits in THIS
        /// component's auth zone during the call. Returns the claim receipt,
        /// the worker badge and the owner badge.
        pub fn claim_task_via(
            &self,
            escrow: ComponentAddress,
            task_id: u64,
            worker: ComponentAddress,
            worker_badge: Bucket,
            claim_bond: Bucket,
            owner_badge: Option<Bucket>,
        ) -> (Bucket, Bucket, Option<Bucket>) {
            Self::push_proof_of(&owner_badge);
            let badge_proof = worker_badge.create_proof_of_all();
            let escrow: Global<AnyComponent> = escrow.into();
            let receipt: Bucket =
                escrow.call("claim_task", &(task_id, worker, badge_proof, claim_bond));
            LocalAuthZone::drop_regular_proofs();
            (receipt, worker_badge, owner_badge)
        }

        fn push_proof_of(badge: &Option<Bucket>) {
            if let Some(badge) = badge {
                LocalAuthZone::push(badge.create_proof_of_all());
            }
        }
    }
}
