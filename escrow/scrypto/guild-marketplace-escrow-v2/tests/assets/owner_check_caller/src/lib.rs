use scrypto::prelude::*;

// TEST-ONLY blueprint (see Cargo.toml). A GLOBAL component that forwards a
// call to NftSwap `list` or the escrow's `create_task` / `claim_task`, so the
// owner check those methods run sees THIS component as its global caller.
//
// What the tests use it for: `Runtime::assert_access_rule` checks the global
// caller's auth zone (radix-engine 1.3.1 `Authorization::auth_zone_stack_matches`).
// Through this component that is this component's own auth zone, not the
// transaction's, so the transaction's signature proofs are out of reach. A
// test can hand this component a proof (`owner_proof`), which it pushes onto
// its own auth zone before forwarding the call.

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
        pub fn list_via(
            &self,
            swap: ComponentAddress,
            seller: ComponentAddress,
            asset: NonFungibleBucket,
            asks: Vec<Ask>,
            expires_at: Instant,
            owner_proof: Option<Proof>,
        ) -> Bucket {
            Self::push(owner_proof);
            let swap: Global<AnyComponent> = swap.into();
            swap.call("list", &(seller, asset, asks, expires_at))
        }

        /// Escrow `create_task(poster, reward, insurance, fee, brief)`, called
        /// from here.
        pub fn create_task_via(
            &self,
            escrow: ComponentAddress,
            poster: ComponentAddress,
            reward: Bucket,
            insurance: Bucket,
            arbiter_fee_pct: Decimal,
            work_brief_hash: Hash,
            owner_proof: Option<Proof>,
        ) -> Bucket {
            Self::push(owner_proof);
            let escrow: Global<AnyComponent> = escrow.into();
            escrow.call(
                "create_task",
                &(poster, reward, insurance, arbiter_fee_pct, work_brief_hash),
            )
        }

        /// Escrow `claim_task(task_id, worker, worker_badge, claim_bond)`,
        /// called from here.
        pub fn claim_task_via(
            &self,
            escrow: ComponentAddress,
            task_id: u64,
            worker: ComponentAddress,
            worker_badge: Proof,
            claim_bond: Bucket,
            owner_proof: Option<Proof>,
        ) -> Bucket {
            Self::push(owner_proof);
            let escrow: Global<AnyComponent> = escrow.into();
            escrow.call("claim_task", &(task_id, worker, worker_badge, claim_bond))
        }

        fn push(owner_proof: Option<Proof>) {
            if let Some(proof) = owner_proof {
                LocalAuthZone::push(proof);
            }
        }
    }
}
