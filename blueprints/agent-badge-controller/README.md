# agent-badge-controller

Scrypto package providing the **Guild Agent Badge** primitive — a recallable non-fungible identity badge for Guild agents. The engine-level kill switch behind Path A of the badge recall plan (`docs/research/badge-recall-agent-control.md` — that research set deliberately stayed in the archived `guild-public` repo and was not folded here). Folded into guild-saas from guild-public on 2026-08-14 (slice A).

## What it does

`AgentBadgeController` is a single-component blueprint that owns:

- **Mint authority** for a recallable `AgentBadge` resource (`symbol: GAGENT`)
- **Monotonic `next_badge_id`** allocation (integer NFLId)
- **Badge metadata schema** (`agent_name`, `radix_address`, spending caps, issued_at — all immutable post-mint)

It does **not** own the recall operation itself. Recall is a manifest-level engine instruction (`recall_non_fungibles`) on the vault holding the badge, gated by the owner badge proof — see [Recall flow](#recall-flow) below. Badge data has no mutable status field; the kill switch is the recall itself (badge absent from agent vault).

## Resource role configuration

The `AgentBadge` resource is created with:

| Role | Rule | Why |
|---|---|---|
| `recaller` | `require(owner_badge)` | Only operator can recall |
| `recaller_updater` | `deny_all` | Recall authority is immutable |
| `withdrawer` | `deny_all` | Agent cannot transfer badge to evade recall |
| `withdrawer_updater` | `deny_all` | Non-transferability is permanent |
| `depositor` | `allow_all` | Mint flow can deposit to any account |
| `minter` | `require(owner_badge)` | Only operator can mint new badges |
| `burner` | `require(owner_badge)` | Only operator can burn |
| `non_fungible_data_updater` | `deny_all` | Badge data is immutable post-mint |

All `*_updater` roles are `deny_all` — the role configuration is permanently locked at creation.

## Build

```bash
# From this directory
cargo build --release --target wasm32-unknown-unknown
```

⚠️ **macOS users**: this hits the bulk-memory WASM issue on Rust >= 1.82 (see the repo `CLAUDE.md` §Scrypto — ledger builds/tests run on Linux CI only). Build on Linux (or a Docker container with `rust:1.81-bookworm`). The old `docs/operations/scrypto-build-matrix.md` link died in guild-public's 2026-08-12 history scrub.

## Test

```bash
cargo test --release
```

Tests use `scrypto-test`'s `LedgerSimulator` — same caveat re: Mac/Linux.

## Deploy (one-time, mainnet)

The deployment is a single `instantiate()` call. The TX returns:

- A `Global<AgentBadgeController>` component address
- A 1-of fungible owner badge (the recall authority) deposited to your operator account

```text
CALL_FUNCTION
  PackageAddress("<package_address>")
  "AgentBadgeController"
  "instantiate"
;
CALL_METHOD
  Address("<operator_account>")
  "deposit_batch"
  Expression("ENTIRE_WORKTOP")
;
```

After deployment, persist the following to operator env (`bot/.env`):

```bash
AGENT_BADGE_CONTROLLER=<component_address>     # for mint manifests
AGENT_BADGE_RESOURCE=<agent_badge_resource>    # for Gateway badge-presence queries
AGENT_BADGE_OWNER=<owner_badge_resource>       # for proof creation in manifests
AGENT_BADGE_OWNER_ACCOUNT=<operator_account>   # account that holds the owner badge
```

(The deploy script in PR 2 will print these for you and offer to write to `.env`.)

## Mint flow

Mint manifests are owner-gated. Build via `mintAgentBadgeManifest` (see `guild-app/src/lib/manifests.ts` once PR 2 lands):

```text
CALL_METHOD Address(<operator_account>) "create_proof_of_amount"
  Address(<AGENT_BADGE_OWNER>) Decimal("1");
CALL_METHOD Address(<AGENT_BADGE_CONTROLLER>) "mint_agent_badge"
  "<agent_name>" "<agent_radix_address>" Decimal("<spend_per_task>") Decimal("<daily_cap>");
CALL_METHOD Address(<agent_radix_address>) "deposit_batch"
  Expression("ENTIRE_WORKTOP");
```

The component allocates the next monotonic `badge_id` (1, 2, 3, …) and emits `AgentBadgeMintedEvent`. The bot reads the event from the TX receipt to record the badge_id in `agent_profiles.agent_badge_local_id`.

## Recall flow

Single manifest, single operator action — present the owner badge proof, recall the
badge from the agent's vault, burn it so it can't be redeposited:

```text
CALL_METHOD Address(<operator_account>) "create_proof_of_amount"
  Address(<AGENT_BADGE_OWNER>) Decimal("1");
RECALL_NON_FUNGIBLES_FROM_VAULT
  Address(<agent_vault_address>)
  Array<NonFungibleLocalId>(NonFungibleLocalId("#42#"));
BURN_RESOURCE Bucket(<recalled>);
```

`<agent_vault_address>` is the **internal vault** that holds the agent's badge — must be
discovered via Gateway `/state/entity/details` on the agent's account. PR 2's deploy +
recall scripts handle that lookup automatically.

After commit, the agent's vault is empty — any subsequent badge proof check by Guild
API fails closed. Bot's auth-gate cache (PR 4) detects the absence within 5 min and
flips `agent_profiles.is_active = 0`.

## Why not recall inside the blueprint?

In scrypto 1.3.1, `recall_non_fungible` is **not** exposed as a `ResourceManager` method. Recall is purely a manifest-level engine instruction on a vault address (`recall_non_fungibles(vault, ids)`). The blueprint owns the resource configuration and mint policy; the engine itself enforces the recall when the owner badge proof is presented in the manifest.

## Versioning

- `scrypto` 1.3.1 (Cuttlefish-compatible)
- Match the version used in sibling `radix-badge-manager` package
