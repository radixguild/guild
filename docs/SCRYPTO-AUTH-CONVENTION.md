<!-- status: live
     verified: 2026-10-03 (the References list ONLY: it now says which sources are unpublished and
     where. The 2026-09-30 stamp below said the architecture-2026-05 links pointed at archive/;
     they did not until this pass. Nothing else re-checked.)
     verified: 2026-09-30 (link paths only: the architecture-2026-05 links point at archive/, where those files moved; nothing else re-checked)
     verified: 2026-08-15 (the three patterns are still the project's working convention and
     are actively cited from blueprint source — escrow/scrypto/guild-marketplace-escrow/
     src/lib.rs names this file by path at `claim_task` to justify its Proof-not-Bucket
     choice, and the "AUTH: Pattern 2" comment convention is in live use there.)
     ⚠️ The "Where each pattern applies (post-Wave-1 state)" table below was NOT re-verified
     and is known incomplete: it predates guild-marketplace-escrow and does not list it at
     all, while it does list blueprints that are deprecated (guild-escrow) or live in other
     repos (task-escrow-v3-canonical, conviction-voting/CV2 — parked). Read that table as a
     Wave-1 snapshot, not as an index of this repo.
     supersedes: none (pre-dates the header rule) -->

# Scrypto Auth Convention

Project-wide authorization convention for Guild's Scrypto blueprints. Every blueprint follows these three patterns. Deviations require an inline `// AUTH:` comment explaining why.

## Why this exists

The 2026-05-23 pre-audit sweep surfaced a recurring class of authorization issues across all 4 audited blueprints (6 Medium findings, see audit reports). The class:

> **Proof-vs-bucket auth bypass.** A method checks that a passed `Proof` is for the correct resource address, but does not verify that the caller actually holds the badge. A third party who obtains a proof (via a compromised wallet, a delegated proof, or a signed-but-unbroadcast manifest) can pass it to satisfy the check.

The fix is not per-finding patches. It's a project-wide convention applied to every blueprint: how authorization works depends on what the method does, and there are three answers — one per method shape.

## The three patterns

| Method shape | Pattern | When |
|---|---|---|
| **One-shot, state-changing, badge-as-credential** | Bucket-burn | Most write methods. The badge is a use-once token: claiming a task, submitting work, redeeming a receipt. |
| **View, soft-assertion, badge-as-identity** | Caller-identity on Proof | Read methods that need to know "is this caller the badge owner." Doesn't change state. |
| **Public method only safe via trusted relayer** | `VERIFY_PARENT` | `public_mint`-style methods where the on-chain action is fine but only when initiated from a known relayer transaction. |

---

## Pattern 1 — Bucket-burn for one-shot methods

### When to use

The method:
- Changes state (mints, burns, transfers, advances a state machine).
- Treats the badge as a single-use credential (claim, submit, redeem).
- Does NOT need the badge to persist after the method returns.

### Rule

Take the badge as a `Bucket`. Verify the resource address. Burn the bucket inside the method.

### Why it works

A `Bucket` can only be constructed from a `Vault` you own. Burning consumes the resource — the same badge cannot satisfy two calls. Proof-replay is impossible because there is no proof; the badge itself was destroyed.

### Code template

```rust
// ❌ Vulnerable: any party with a Proof can call this
pub fn submit_work(&mut self, badge_proof: Proof, work_hash: Hash) {
    badge_proof.check(self.badge_resource);
    // … change state
}

// ✅ Bucket-burn: the badge is consumed, cannot be replayed
pub fn submit_work(&mut self, badge_bucket: Bucket, work_hash: Hash) {
    assert_eq!(
        badge_bucket.resource_address(),
        self.badge_resource,
        "wrong badge resource"
    );
    // Optional: inspect NFT data before burning
    let nft = badge_bucket.as_non_fungible().non_fungible::<BadgeData>();
    assert!(nft.data().level >= 1, "badge level too low");
    badge_bucket.burn();
    // … change state
}
```

### When you can't burn

Some flows need the badge to persist for the user (e.g., guild membership badges are long-lived; burning one to claim a task is unacceptable UX). In those cases, use **Pattern 2** (caller-identity check) and accept the residual proof-replay risk, documented inline:

```rust
// AUTH: cannot bucket-burn — membership badge is long-lived.
// Caller-identity check on Proof is the next-best mitigation.
```

---

## Pattern 2 — Caller-identity on Proof for view / soft-assertion methods

### When to use

The method:
- Does NOT change state, OR changes state but the badge cannot be burned (see above).
- Needs to verify the caller is the badge owner, not just that the badge exists somewhere.
- Returns data or performs an assertion based on caller identity.

### Rule

Take the badge as a `Proof`. Verify the resource address AND verify the `Proof` was created by the caller's component address.

### Code template

```rust
pub fn get_user_stats(&self, badge_proof: Proof) -> UserStats {
    let checked = badge_proof.check(self.badge_resource);
    // Verify the Proof's creator matches the caller's address
    let caller = Runtime::actor().as_method().unwrap_or_else(|| {
        Runtime::panic("must be called from a method context")
    });
    let proof_owner = checked.contains_owner(caller);
    assert!(proof_owner, "Proof must be created by the caller");
    let nft = checked.as_non_fungible().non_fungible::<BadgeData>();
    UserStats {
        user_id: nft.local_id().clone(),
        xp: nft.data().xp,
        // …
    }
}
```

### Limits

Caller-identity on Proof is **not as strong as bucket-burn**. The check verifies the *immediate caller* but cannot detect a transaction-level proof-passing chain. Use bucket-burn whenever burning is acceptable; fall back to caller-identity only when it isn't.

---

## Pattern 3 — `VERIFY_PARENT` for relayer-only public methods

### When to use

The method:
- Is intentionally `PUBLIC` (anyone can call it conceptually).
- Should only be invoked from a transaction signed by a trusted relayer or from a specific parent component.
- Example: `public_mint` on a free-mint badge — anyone can be minted *for*, but a relayer signs the actual transaction (rate-limit, captcha, anti-bot).

### Rule

In `enable_method_auth!`, declare the method `PUBLIC verify_parent: rule!(...)` with a rule that requires the relayer's badge (or a specific component address).

### Code template

```rust
enable_method_auth! {
    methods {
        public_mint => PUBLIC verify_parent: rule!(require(relayer_badge_address));
        // … other methods
    }
}
```

If no relayer model exists yet, restrict to OWNER until one does:

```rust
enable_method_auth! {
    methods {
        public_mint => restrict_to: [OWNER];
    }
}
```

### Why not just `restrict_to: [relayer]`

`restrict_to` checks the **direct caller**. `VERIFY_PARENT` checks the **transaction's parent context**. A subintent or composed manifest can have a different direct caller than the transaction signer; `VERIFY_PARENT` catches the actual signer's intent.

---

## Where each pattern applies (post-Wave-1 state)

| Blueprint | Method | Pattern | Audit finding |
|---|---|---|---|
| `agent-badge-controller` | `mint_agent_badge` | OWNER-only (no badge needed) | — |
| `agent-badge-controller` | `recall` (manifest-level) | OWNER proof in manifest | — |
| `task-escrow-v3-canonical` | `claim_task` | Bucket-burn | F-004 |
| `task-escrow-v3-canonical` | `submit_task` | Bucket-burn | F-004 |
| `task-escrow-v3-canonical` | `cancel_task` | Bucket-burn | F-003 |
| `task-escrow-v3-canonical` | `force_cancel` | OWNER-only + verifier | F-005 |
| `task-escrow-v3-canonical` | `expire_task` | OWNER-only + verifier | F-006 |
| `task-escrow-v3-canonical` | `release_task` | Verifier role + creator check | — |
| `task-escrow-v3-canonical` | `resolve_dispute` (ported) | Bucket-burn (arbiter badge) | — |
| `task-escrow-v3-canonical` | `get_status` / view methods | Caller-identity on Proof | — |
| `guild-escrow` | (entire blueprint deprecated post-Wave 2) | — | — |
| `radix-badge-manager` | `public_mint` | `VERIFY_PARENT` with relayer | F-001 |
| `radix-badge-manager` | `mint_badge` (admin) | restrict_to: [admin, OWNER] | — |
| `radix-badge-manager` | `revoke_badge` (admin) | restrict_to: [admin, OWNER] | — |
| `radix-badge-manager` | `update_xp`, `update_tier` (admin) | restrict_to: [admin, OWNER] | — |
| `radix-badge-manager` | View methods (badge data) | PUBLIC (no auth needed) | — |
| `conviction-voting` | `stake` | Bucket-burn (governance badge) | TBD post-audit |
| `conviction-voting` | `unstake` | Caller-identity on Proof | TBD post-audit |
| `conviction-voting` | View methods | PUBLIC | — |

---

## Migration checklist (per blueprint)

When applying this convention to an existing blueprint:

1. **Inventory every method** that takes a `Proof` parameter.
2. **Classify each**: write (bucket-burn) / view (caller-identity) / public-but-relayer-only (`VERIFY_PARENT`).
3. **Update method signatures** for bucket-burn methods (`Proof` → `Bucket`).
4. **Update `enable_method_auth!`** for any role rule changes.
5. **Update tests** — bucket-burn tests need to pass a `Bucket`, not create a `Proof`. Add a test that ensures the badge is actually burned after the call.
6. **Update manifests** — TS manifest builders must `WITHDRAW` the badge from the user's account and pass it as a `Bucket`, not as a `Proof`.
7. **Update bot / app callers** — any JS/TS code calling these methods via manifests needs to follow the new manifest pattern.
8. **Add an inline `// AUTH: Pattern N` comment** above each method documenting which pattern is in use.
9. **Re-run pre-audit harness** — confirm the finding the convention addresses is resolved.

---

## Deviations

If you must deviate from this convention, leave an inline `// AUTH:` comment explaining why on the line above the method declaration. Document the residual risk. Examples:

```rust
// AUTH: Cannot bucket-burn — membership badge is long-lived (UX requirement).
// Caller-identity-on-Proof is the next-best mitigation. Residual risk: chained
// proof-passing within a single transaction. Mitigated by short-lived nonces
// elsewhere in the flow.
pub fn cast_vote(&mut self, badge_proof: Proof, proposal_id: u64, choice: Choice) {
    // …
}
```

The PR review must reference this deviation comment.

---

## References

- Scan reports: the 2026-05-23 in-house scrypto scan — a scan, not an audit (4 reports, 6 Medium findings of this class; reports not published)
- Architecture: `ARCHITECTURE.md` §5a, from the 2026-05 architecture set (`docs/archive/architecture-2026-05/`, in the private repository this one was exported from)
- Options analysis: `OPTIONS.md` Q4, same set
- Ignition role-hierarchy patterns: the scan kit's reference notes (not published), §Pattern 1
- CaviarNine HyperStake authorization patterns: the scan kit's reference notes (not published)
