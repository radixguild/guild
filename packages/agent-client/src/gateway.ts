import { MAINNET_XRD } from './config.js';

// Read-only Babylon Gateway NFT resolvers for the worker. These hit the Gateway
// directly (/state/entity/details + /state/non-fungible/data) rather than the
// guild-app /api/v1 surface, so the agent can read its own badge + receipts
// without an authenticated session. Field shapes are a faithful port of the
// PROVEN guild-app readers (guild-saas/guild-app/src/lib/gateway.ts:
// fetchEntityDetails, fetchNftData, findClaimReceiptId). The only delta: the
// agent version takes `gatewayBaseUrl` as a parameter (guild-app hardcodes its
// GATEWAY const) so it threads through GuildClientConfig.gatewayBaseUrl.

/** Minimal slice of /state/entity/details we read (Vault aggregation + nfids). */
interface EntityDetailsResponse {
  items?: {
    non_fungible_resources?: {
      items?: {
        resource_address?: string;
        vaults?: { items?: { items?: string[] }[] };
      }[];
    };
  }[];
}

/** Minimal slice of /state/non-fungible/data we read (programmatic_json fields). */
interface NonFungibleDataResponse {
  non_fungible_ids?: {
    data?: { programmatic_json?: { fields?: { field_name?: string; value?: string }[] } };
  }[];
}

/** POST /state/entity/details for one address, Vault aggregation + nfids opt-in. */
async function fetchEntityDetails(
  gatewayBaseUrl: string,
  address: string
): Promise<EntityDetailsResponse | null> {
  const resp = await fetch(`${gatewayBaseUrl}/state/entity/details`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      addresses: [address],
      aggregation_level: 'Vault',
      opt_ins: { non_fungible_include_nfids: true },
    }),
  });
  return resp.ok ? ((await resp.json()) as EntityDetailsResponse) : null;
}

/** POST /state/non-fungible/data for specific local ids of one resource. */
async function fetchNftData(
  gatewayBaseUrl: string,
  resourceAddress: string,
  nfIds: string[]
): Promise<NonFungibleDataResponse | null> {
  const resp = await fetch(`${gatewayBaseUrl}/state/non-fungible/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resource_address: resourceAddress,
      non_fungible_ids: nfIds,
    }),
  });
  return resp.ok ? ((await resp.json()) as NonFungibleDataResponse) : null;
}

/** Held local ids of `resource` in an entity-details payload (empty if none). */
function heldLocalIds(data: EntityDetailsResponse | null, resource: string): string[] {
  const nfRes = data?.items?.[0]?.non_fungible_resources?.items?.find(
    r => r.resource_address === resource
  );
  return nfRes?.vaults?.items?.[0]?.items ?? [];
}

/**
 * First local id of `badgeResource` held by `account`, or null. Used to populate
 * GUILD_AGENT_BADGE_LOCAL_ID at provisioning time and to assert the agent holds
 * the gating badge before it claims. The Guild Member badge's local id is
 * string-derived (`guild_member_<sanitized_username>`), NOT `#N#`, so this
 * returns the raw NonFungibleLocalId string verbatim.
 *
 * Pin `badgeResource` to the Member badge (resource_rdx1n22rq94…) for the pilot,
 * NOT the dormant GAGENT agent badge.
 */
export async function resolveBadgeLocalId(
  account: string,
  badgeResource: string,
  gatewayBaseUrl: string
): Promise<string | null> {
  const data = await fetchEntityDetails(gatewayBaseUrl, account);
  const nfIds = heldLocalIds(data, badgeResource);
  return nfIds.length ? nfIds[0] : null;
}

/**
 * The worker's Claim Receipt local id (the u64 `submit_task` consumes) for a
 * given on-chain task, or null if the worker holds no live receipt for it.
 *
 * A worker may hold stale receipts from expired claims, so this matches on the
 * receipt's ClaimReceiptData.task_id rather than assuming one receipt. NOTE: the
 * Claim Receipt local id (`#N#`) is NOT the task_id — submit_task needs the
 * local id, extracted here via /#(\d+)#/. Faithful port of guild-app
 * findClaimReceiptId. Pin `claimReceiptResource` to vNext resource_rdx1n2x2epej…
 * (== GuildClientConfig.claimReceiptResource).
 *
 * Doubles as the worker's submit dedup + indexing-lag guard: a null result means
 * "no live receipt → submit already settled, or not yet indexed → retry".
 */
export async function resolveClaimReceiptId(
  account: string,
  claimReceiptResource: string,
  onChainTaskId: number,
  gatewayBaseUrl: string
): Promise<number | null> {
  const data = await fetchEntityDetails(gatewayBaseUrl, account);
  const nfIds = heldLocalIds(data, claimReceiptResource);
  for (const nfId of nfIds) {
    const nft = await fetchNftData(gatewayBaseUrl, claimReceiptResource, [nfId]);
    const fields = nft?.non_fungible_ids?.[0]?.data?.programmatic_json?.fields ?? [];
    const tid = fields.find(f => f?.field_name === 'task_id')?.value;
    if (tid !== undefined && Number(tid) === onChainTaskId) {
      const m = /#(\d+)#/.exec(nfId);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

// ── Doctor probes (read-only; injectable fetch for tests) ────────────────────

export interface GatewayStatus {
  network: string;
  epoch: number;
  stateVersion: number;
}

/** POST /status/gateway-status → ledger network/epoch/state_version, or null. */
export async function fetchGatewayStatus(
  gatewayBaseUrl: string,
  fetchFn: typeof fetch = fetch
): Promise<GatewayStatus | null> {
  try {
    const resp = await fetchFn(`${gatewayBaseUrl}/status/gateway-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      ledger_state?: { network?: string; epoch?: number; state_version?: number };
    };
    const ls = json.ledger_state;
    if (!ls || typeof ls.epoch !== 'number' || typeof ls.state_version !== 'number') return null;
    return { network: ls.network ?? 'unknown', epoch: ls.epoch, stateVersion: ls.state_version };
  } catch {
    return null;
  }
}

/**
 * The account's XRD balance via /state/entity/page/fungibles, or null when the
 * Gateway can't be read. A NEVER-funded virtual account 404s on state reads —
 * that maps to 0 (the account exists as an address; it just holds nothing yet).
 * "XRD absent from the FIRST page while more pages exist" maps to null, not 0:
 * a capped agent account never has >100 fungibles, but a wrong 0 on an exotic
 * account would fail funding checks closed with a lie — unknown is honest.
 */
export async function fetchXrdBalance(
  account: string,
  gatewayBaseUrl: string,
  fetchFn: typeof fetch = fetch
): Promise<number | null> {
  try {
    const resp = await fetchFn(`${gatewayBaseUrl}/state/entity/page/fungibles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: account }),
    });
    if (resp.status === 404) return 0;
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      items?: { resource_address?: string; amount?: string }[];
      next_cursor?: string | null;
    };
    const amount = (json.items ?? []).find(i => i.resource_address === MAINNET_XRD)?.amount;
    if (amount === undefined) return json.next_cursor ? null : 0;
    const n = Number(amount);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * The account's XRD balance as the Gateway's own DECIMAL STRING — for money
 * arithmetic (sweep.ts), where `fetchXrdBalance`'s `number` would round an 18dp
 * Decimal. Same contract otherwise: "0" when the account does not exist yet or
 * holds no XRD, null when the answer is UNKNOWN (transport error, non-2xx, a
 * malformed amount, or XRD not on the first page of a paginated response). Null
 * must never be read as zero by a caller deciding whether to move money.
 */
export async function fetchXrdBalanceExact(
  account: string,
  gatewayBaseUrl: string,
  fetchFn: typeof fetch = fetch
): Promise<string | null> {
  try {
    const resp = await fetchFn(`${gatewayBaseUrl}/state/entity/page/fungibles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: account }),
    });
    if (resp.status === 404) return '0';
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      items?: { resource_address?: string; amount?: string }[];
      next_cursor?: string | null;
    };
    const amount = (json.items ?? []).find(i => i.resource_address === MAINNET_XRD)?.amount;
    if (amount === undefined) return json.next_cursor ? null : '0';
    return /^\d+(\.\d{1,18})?$/.test(amount) ? amount : null;
  } catch {
    return null;
  }
}

/**
 * True when `escrowComponent` exists on-ledger and has the shape the client
 * claims against (a `tasks` KeyValueStore field) — the doctor's "am I pointed
 * at a real escrow component" probe. Uses the same resolver the claim pin uses.
 */
export async function probeEscrowComponent(
  escrowComponent: string,
  gatewayBaseUrl: string
): Promise<boolean> {
  // ⚠️ This used to be `resolveTasksKvStore(...) !== null` alone — i.e. "does a
  // tasks KVStore exist". EVERY escrow component ever deployed satisfies that,
  // including retired ones, so after the 2026-08-17 PULL cutover a client still
  // pointed at the retired PUSH component probed GREEN and `guild-worker doctor`
  // printed the dead address as "live and has the expected shape". The client's
  // other net failed the same way: claim_bond_xrd is 10 on both components, so
  // assertClaimBondMatchesChain matched too. Nothing could detect the drift.
  //
  // The probe now discriminates on BLUEPRINT SHAPE, which is mutually exclusive
  // by construction: PULL removed `heartbeat_fee_xrd` (DB-3) and added
  // `expire_grace_secs` (DB-4). A retired push component now fails this probe.
  const fields = await readComponentFieldNames(escrowComponent, gatewayBaseUrl);
  if (fields === null) return false;
  if (fields.includes('heartbeat_fee_xrd')) return false; // a PUSH-era component
  if (!fields.includes('expire_grace_secs')) return false; // not the PULL shape
  return (await resolveTasksKvStore(escrowComponent, gatewayBaseUrl)) !== null;
}

/** Field names of a component's top-level state, or null if unreadable. */
async function readComponentFieldNames(
  address: string,
  gatewayBaseUrl: string
): Promise<string[] | null> {
  try {
    const resp = await fetch(`${gatewayBaseUrl}/state/entity/details`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: [address] }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      items?: { details?: { state?: { fields?: { field_name?: string }[] } } }[];
    };
    const fields = json?.items?.[0]?.details?.state?.fields;
    if (!Array.isArray(fields)) return null;
    return fields.map(f => f?.field_name).filter((n): n is string => typeof n === 'string');
  } catch {
    return null;
  }
}

// ── Dispute auto-resolve ruling (settlement routing) ─────────────────────────

/** The component's configured ruling for a lapsed, un-arbitrated dispute. */
export type AutoResolveDefault = 'FavorDisputeRaiser' | 'SplitEvenly' | 'ReturnToPoster';

/**
 * Read `dispute_auto_resolve_default` from the escrow component's state.
 *
 * This is the ruling `auto_resolve_dispute` will actually apply — under PULL to
 * the REWARD only (the insurance premium always returns to the poster). The
 * finalize manifest no longer routes anything, so nothing SIGNS off this value
 * any more; it remains the honest way to REPORT or predict a settlement before
 * triggering it. Returns null when it can't be read; callers deriving
 * expectations MUST fail closed on null rather than assume a default.
 */
export async function readDisputeAutoResolveDefault(
  escrowComponent: string,
  gatewayBaseUrl: string
): Promise<AutoResolveDefault | null> {
  try {
    const resp = await fetch(`${gatewayBaseUrl}/state/entity/details`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: [escrowComponent] }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      items?: { details?: { state?: { fields?: { field_name?: string; variant_name?: string }[] } } }[];
    };
    const fields = json?.items?.[0]?.details?.state?.fields;
    if (!Array.isArray(fields)) return null;
    const variant = fields.find(f => f?.field_name === 'dispute_auto_resolve_default')?.variant_name;
    return variant === 'FavorDisputeRaiser' ||
      variant === 'SplitEvenly' ||
      variant === 'ReturnToPoster'
      ? variant
      : null;
  } catch {
    return null;
  }
}

// ── On-chain task-state read (claim pin) ─────────────────────────────────────

/** TaskState variants from the escrow blueprint (guild-marketplace-escrow). */
export type OnChainTaskState =
  | 'Open'
  | 'Claimed'
  | 'Submitted'
  | 'Disputed'
  | 'Released'
  | 'Refunded';

const TASK_STATES: ReadonlySet<string> = new Set([
  'Open',
  'Claimed',
  'Submitted',
  'Disputed',
  'Released',
  'Refunded',
]);

// The `tasks` KeyValueStore address is a field of the (immutable) component
// state, so cache it per component for the process lifetime.
const tasksKvStoreCache = new Map<string, string>();

async function resolveTasksKvStore(
  escrowComponent: string,
  gatewayBaseUrl: string,
  fetchFn: typeof fetch = fetch
): Promise<string | null> {
  const cached = tasksKvStoreCache.get(escrowComponent);
  if (cached) return cached;
  try {
    const resp = await fetchFn(`${gatewayBaseUrl}/state/entity/details`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: [escrowComponent] }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      items?: { details?: { state?: { fields?: { field_name?: string; value?: string }[] } } }[];
    };
    const fields = json?.items?.[0]?.details?.state?.fields;
    if (!Array.isArray(fields)) return null;
    const addr = fields.find(f => f?.field_name === 'tasks')?.value;
    if (typeof addr !== 'string' || !addr.startsWith('internal_keyvaluestore_')) return null;
    tasksKvStoreCache.set(escrowComponent, addr);
    return addr;
  } catch {
    return null;
  }
}

/**
 * The task's CURRENT on-chain TaskState on `escrowComponent`, or null when it
 * can't be read (Gateway hiccup / unknown key on THIS component / odd shape).
 * `null` means "unknown", NEVER "gone".
 *
 * The worker uses this as its claim PIN: it only bonds on a task that is
 * verifiably `Open` on the CONFIGURED escrow component. on_chain_task_id
 * numbering is per-component (ids collide across escrow cutovers), so reading
 * the state against config.escrowComponent both confirms the task is still
 * claimable AND pins the claim to the right component — without it a stale or
 * cross-component id could send a claim that reverts on the blueprint's
 * `must be Open` assert and burn the claim bond. A standing --loop bonds real
 * XRD unattended, so it treats unknown (null) as "don't bond this cycle" and
 * retries next cycle (the task stays claimable). Faithful port of guild-app
 * readEscrowTaskState.
 */
export async function readTaskState(
  onChainTaskId: number,
  escrowComponent: string,
  gatewayBaseUrl: string
): Promise<OnChainTaskState | null> {
  const kvStore = await resolveTasksKvStore(escrowComponent, gatewayBaseUrl);
  if (!kvStore) return null;
  try {
    const resp = await fetch(`${gatewayBaseUrl}/state/key-value-store/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key_value_store_address: kvStore,
        keys: [{ key_json: { kind: 'U64', value: String(onChainTaskId) } }],
      }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      entries?: {
        value?: {
          programmatic_json?: { fields?: { field_name?: string; variant_name?: string }[] };
        };
      }[];
    };
    const fields = json?.entries?.[0]?.value?.programmatic_json?.fields;
    if (!Array.isArray(fields)) return null;
    const variant = fields.find(f => f?.field_name === 'state')?.variant_name;
    return typeof variant === 'string' && TASK_STATES.has(variant)
      ? (variant as OnChainTaskState)
      : null;
  } catch {
    return null;
  }
}

// ── On-chain claim-bond read (bond cross-check) ──────────────────────────────

// `claim_bond_xrd` is set at instantiate and never reassigned (the blueprint's
// only writes are in the constructor), so cache it per component for the
// process lifetime — same rationale as tasksKvStoreCache above. Only VERIFIED
// values are cached; an unreadable component is retried on the next call.
const claimBondCache = new Map<string, string>();

/**
 * The escrow component's deployed `claim_bond_xrd`, as the EXACT decimal
 * string the Gateway reports (a Scrypto `Decimal` — 18dp fixed-point, never
 * parsed to `number`, which would corrupt it).
 *
 * ⚠️ LEGACY (pre-Wave-B) shape. Wave B W4 replaced the flat `claim_bond_xrd`
 * component field with the proportional `claim_bond_pct`/`claim_bond_floor`/
 * `claim_bond_cap` trio (see `readOnChainClaimBondParams` below) — a
 * component that has been through the swap ceremony no longer has this field
 * at all. This reader is kept, unchanged, as the FALLBACK for a component
 * that has not: `resolveClaimBond` (tx.ts) tries the proportional shape
 * first and only calls this when that trio is not readable.
 *
 * Returns null when it can't be read (Gateway hiccup / unknown component /
 * unexpected shape / non-decimal value / the field genuinely does not exist
 * on a Wave-B component). `null` means "unknown", NEVER a default — callers
 * gating real XRD on this MUST fail closed on it, the same rule
 * readDisputeAutoResolveDefault and the retired heartbeat economics reader
 * follow.
 */
export async function readOnChainClaimBondXrd(
  escrowComponent: string,
  gatewayBaseUrl: string
): Promise<string | null> {
  const cached = claimBondCache.get(escrowComponent);
  if (cached !== undefined) return cached;
  try {
    const resp = await fetch(`${gatewayBaseUrl}/state/entity/details`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: [escrowComponent] }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      items?: { details?: { state?: { fields?: { field_name?: string; value?: string }[] } } }[];
    };
    const fields = json?.items?.[0]?.details?.state?.fields;
    if (!Array.isArray(fields)) return null;
    const value = fields.find(f => f?.field_name === 'claim_bond_xrd')?.value;
    // The blueprint asserts claim_bond_xrd >= 0 at instantiate, so anything
    // that isn't a plain non-negative decimal string is a shape we do not
    // understand — unreadable, never a guess.
    if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) return null;
    claimBondCache.set(escrowComponent, value);
    return value;
  } catch {
    return null;
  }
}

/**
 * The escrow component's LIVE `claim_bond_pct` / `claim_bond_floor` /
 * `claim_bond_cap` — Wave B W4's proportional claim-bond parameters
 * (`required_bond` in lib.rs: `pct * reward`, clamped to `[floor, cap]`).
 * Read the same way `readOnChainClaimBondXrd` reads the legacy flat field:
 * exact Decimal strings off the component's top-level state, never parsed to
 * `number`.
 *
 * ⚠️ DELIBERATELY NOT CACHED, unlike `claimBondCache` above. `claim_bond_xrd`
 * was genuinely instantiate-only (the blueprint's only writes were in the
 * constructor) — these three are NOT: lib.rs exposes an owner setter
 * (`ClaimBondParamsUpdatedEvent`) so the operator can retune them live. A
 * process-lifetime cache here would let a standing `--loop` worker keep
 * pricing bonds against a value the owner already changed, which is exactly
 * the unpriced-risk class this whole file exists to close.
 *
 * Returns null unless ALL THREE fields are present and well-formed
 * non-negative decimal strings — a partial read (e.g. `pct` readable but
 * `floor` not) is exactly as unusable as no read at all, so this never
 * returns a partial result for a caller to guess the rest of.
 */
export async function readOnChainClaimBondParams(
  escrowComponent: string,
  gatewayBaseUrl: string
): Promise<{ pct: string; floor: string; cap: string } | null> {
  try {
    const resp = await fetch(`${gatewayBaseUrl}/state/entity/details`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: [escrowComponent] }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      items?: { details?: { state?: { fields?: { field_name?: string; value?: string }[] } } }[];
    };
    const fields = json?.items?.[0]?.details?.state?.fields;
    if (!Array.isArray(fields)) return null;
    const decimal = (name: string): string | null => {
      const v = fields.find(f => f?.field_name === name)?.value;
      return typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? v : null;
    };
    const pct = decimal('claim_bond_pct');
    const floor = decimal('claim_bond_floor');
    const cap = decimal('claim_bond_cap');
    if (pct === null || floor === null || cap === null) return null;
    return { pct, floor, cap };
  } catch {
    return null;
  }
}

/**
 * Which claim-bond SHAPE `escrowComponent` currently deploys — proportional
 * (Wave B) or flat (pre-Wave-B) — without needing a specific task in hand.
 * For callers that only want to know "roughly how much should this account
 * hold" (doctor's funding preflight, onboard's guided walk): the proportional
 * FLOOR is the cheapest a real claim could ever cost on that component; the
 * actual bond for any given task is `>= floor` and depends on that task's
 * reward, which this reader has no task to compute against.
 *
 * `null` when NEITHER shape is readable — same fail-closed posture as
 * `resolveClaimBond` (tx.ts), which this composes the same two reads for.
 */
export type ClaimBondBasis =
  | { mode: 'proportional'; pct: string; floor: string; cap: string }
  | { mode: 'flat'; amountXrd: string };

export async function readOnChainClaimBondBasis(
  escrowComponent: string,
  gatewayBaseUrl: string
): Promise<ClaimBondBasis | null> {
  const params = await readOnChainClaimBondParams(escrowComponent, gatewayBaseUrl);
  if (params !== null) return { mode: 'proportional', ...params };
  const flat = await readOnChainClaimBondXrd(escrowComponent, gatewayBaseUrl);
  if (flat !== null) return { mode: 'flat', amountXrd: flat };
  return null;
}

/**
 * A task's `reward_token` / `reward_amount`, as committed at `create_task` and
 * never mutated after (TaskInfo has no reward setter) — the input the Wave B
 * proportional bond formula (`required_bond`) is a function of. Read from the
 * same `tasks` KeyValueStore entry `readTaskState` / `readOnChainWorkBriefHash`
 * / `readWorkerEntitlement` already read; this just pulls two different fields
 * off it.
 *
 * `reward_token` is a `ResourceAddress`, which the Gateway renders as
 * `{ kind: "Reference", value: "resource_rdx1…" }` — a DIFFERENT shape from
 * every Decimal/enum field this file otherwise reads (confirmed against
 * `@radixdlt/babylon-gateway-api-sdk`'s generated
 * `ProgrammaticScryptoSborValueReference` model — `kind`, `value`, no `hex`;
 * the same kind of shape-verification `readOnChainWorkBriefHash`'s doc
 * describes for `Bytes`). `reward_amount` is a plain Decimal string, read the
 * same way every other Decimal in this file is.
 *
 * Returns null when it can't be read (Gateway hiccup, unknown key on THIS
 * component, or either field missing/malformed) — `null` means "unknown",
 * NEVER a guess: sizing a real-money bond off an unverified reward is exactly
 * the unpriced risk EXTERNAL-V1-FRAMEWORK P4-5 exists to close.
 */
export interface OnChainTaskReward {
  rewardToken: string;
  rewardAmount: string;
}

export async function readOnChainTaskReward(
  onChainTaskId: number,
  escrowComponent: string,
  gatewayBaseUrl: string
): Promise<OnChainTaskReward | null> {
  const kvStore = await resolveTasksKvStore(escrowComponent, gatewayBaseUrl);
  if (!kvStore) return null;
  try {
    const resp = await fetch(`${gatewayBaseUrl}/state/key-value-store/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key_value_store_address: kvStore,
        keys: [{ key_json: { kind: 'U64', value: String(onChainTaskId) } }],
      }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      entries?: {
        value?: {
          programmatic_json?: {
            fields?: { field_name?: string; kind?: string; value?: string }[];
          };
        };
      }[];
    };
    const fields = json?.entries?.[0]?.value?.programmatic_json?.fields;
    if (!Array.isArray(fields)) return null;
    const tokenField = fields.find(f => f?.field_name === 'reward_token');
    if (!tokenField || tokenField.kind !== 'Reference' || typeof tokenField.value !== 'string') {
      return null;
    }
    // Same anchored shape as manifests.ts's validateAddress — belt and braces
    // against an odd/hostile value flowing into a later Address(...) literal.
    if (!/^resource_rdx[a-z0-9]{20,}$/.test(tokenField.value)) return null;
    const amountValue = fields.find(f => f?.field_name === 'reward_amount')?.value;
    if (typeof amountValue !== 'string' || !/^\d+(\.\d+)?$/.test(amountValue)) return null;
    return { rewardToken: tokenField.value, rewardAmount: amountValue };
  } catch {
    return null;
  }
}

// A fungible resource's divisibility is immutable once the resource exists
// (no protocol-level setter), so — unlike the tunable claim-bond params above
// — caching it for the process lifetime is safe. Same rationale as
// tasksKvStoreCache / claimBondCache.
const divisibilityCache = new Map<string, number>();

/**
 * A fungible resource's on-chain divisibility (0-18 decimal places), or null
 * when it can't be determined — the resource is unreadable, or (mirroring the
 * blueprint's own `token_divisibility`, which panics on a non-fungible) not a
 * fungible resource at all. The Wave B bond formula rounds to exactly this
 * many places (`checked_round(divisibility, RoundingMode::ToZero)`); a wrong
 * divisibility either strands the bond as dust the resource can't express or
 * rounds it to the wrong amount, so `null` here MUST fail the caller closed,
 * never fall back to an assumed value (not even 18 — XRD's own divisibility
 * is read the same way as any other token, deliberately, so there is exactly
 * one code path to get right rather than a hardcoded special case).
 */
export async function readTokenDivisibility(
  resourceAddress: string,
  gatewayBaseUrl: string
): Promise<number | null> {
  const cached = divisibilityCache.get(resourceAddress);
  if (cached !== undefined) return cached;
  try {
    const resp = await fetch(`${gatewayBaseUrl}/state/entity/details`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: [resourceAddress] }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      items?: { details?: { type?: string; divisibility?: number } }[];
    };
    const details = json?.items?.[0]?.details;
    if (!details || details.type !== 'FungibleResource') return null;
    const d = details.divisibility;
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 18) return null;
    divisibilityCache.set(resourceAddress, d);
    return d;
  } catch {
    return null;
  }
}


// ── On-chain work-brief hash read (P4-3 keystone check) ──────────────────────

/**
 * A task's committed `work_brief_hash` on `escrowComponent`, as the exact
 * lowercase hex the Gateway reports, or null when it can't be read.
 *
 * `work_brief_hash` is a Scrypto `Hash` (lib.rs's `TaskInfo.work_brief_hash`
 * field) — a transparent `[u8;32]` (same note as manifests.ts's
 * `validateHashHex`), which SBOR-encodes as `Array<U8>`. The Gateway renders
 * that specially: `programmatic_json` gives
 * it `kind: "Bytes"` with the bytes under a `hex` STRING field — NOT `value`,
 * unlike every Decimal/enum/bool field read elsewhere in this file. Confirmed
 * against `@radixdlt/babylon-gateway-api-sdk`'s generated
 * `ProgrammaticScryptoSborValueBytes` model (`kind`, `element_kind`, `hex`);
 * nothing in this codebase decoded a Hash-shaped field before this reader, so
 * there was no prior call site to copy the shape from.
 *
 * This is the chain's answer to "what work brief did create_task commit to",
 * against which the claimer's own `workBriefHash(...)` (work-brief.ts) is
 * cross-checked before any claim is signed (EXTERNAL-V1-FRAMEWORK P4-3 — the
 * keystone check: bind the text the agent read to the money it stakes).
 *
 * `null` means "unknown", NEVER a guess (Gateway hiccup / unknown key on THIS
 * component / an unexpected shape) — callers gating real XRD on this MUST
 * fail closed, the same rule readOnChainClaimBondXrd and
 * readDisputeAutoResolveDefault follow.
 */
export async function readOnChainWorkBriefHash(
  onChainTaskId: number,
  escrowComponent: string,
  gatewayBaseUrl: string,
  fetchFn: typeof fetch = fetch
): Promise<string | null> {
  const kvStore = await resolveTasksKvStore(escrowComponent, gatewayBaseUrl, fetchFn);
  if (!kvStore) return null;
  try {
    const resp = await fetchFn(`${gatewayBaseUrl}/state/key-value-store/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key_value_store_address: kvStore,
        keys: [{ key_json: { kind: 'U64', value: String(onChainTaskId) } }],
      }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      entries?: {
        value?: {
          programmatic_json?: {
            fields?: { field_name?: string; kind?: string; hex?: string }[];
          };
        };
      }[];
    };
    const fields = json?.entries?.[0]?.value?.programmatic_json?.fields;
    if (!Array.isArray(fields)) return null;
    const field = fields.find(f => f?.field_name === 'work_brief_hash');
    // Only a well-formed Bytes(64 hex) is unambiguous — an unrecognised shape
    // is unreadable, never a guess (same posture as readOnChainClaimBondXrd's
    // decimal-shape check).
    if (!field || field.kind !== 'Bytes' || typeof field.hex !== 'string') return null;
    if (!/^[0-9a-fA-F]{64}$/.test(field.hex)) return null;
    return field.hex.toLowerCase();
  } catch {
    return null;
  }
}

// ── Worker settlement entitlement (P3-1: the withdraw precondition) ──────────

/**
 * What the escrow currently owes the worker on one task, plus the payee pins
 * needed to build a withdrawal proof.
 *
 * `entitlementsPresent` is decided by whether the TaskInfo carries the
 * entitlement FIELDS at all, never by their values. A pre-pull component has no
 * such fields, and reading their absence as "0" would be indistinguishable from
 * a fully-collected task — the app makes exactly this distinction
 * (guild-app src/lib/gateway.ts ENTITLEMENT_FIELDS) and so must the CLI, or a
 * `withdraw` pointed at a push component would report "nothing owed" instead of
 * "this component cannot do entitlements".
 *
 * Amounts stay EXACT DECIMAL STRINGS. They are Scrypto `Decimal` (18dp fixed
 * point); `Number()` on those does not round, it invents digits.
 */
export interface WorkerEntitlement {
  /** Reward lane owed to the worker, exact decimal string. */
  reward: string;
  /** Claim-bond lane owed to the worker (non-empty after a poster cancel). */
  bond: string;
  /** The account `withdraw_worker` will deposit into — pinned at claim_task. */
  workerAccount: string | null;
  /** Local id of the badge that claimed, which the withdrawal must prove. */
  claimerBadgeId: string | null;
  /** Whether the claim used the AGENT badge rather than the Member badge. */
  claimerIsAgent: boolean;
  /** False on a pre-pull component: "cannot say", not "owes nothing". */
  entitlementsPresent: boolean;
}

const ENTITLEMENT_FIELDS = [
  'worker_entitled',
  'poster_entitled',
  'worker_bond_entitled',
  'poster_bond_entitled',
] as const;

interface KvField {
  field_name?: string;
  /**
   * NOT always a string. `programmatic_json` renders a Scrypto `bool` as a
   * JSON boolean and a `Decimal` as a string, so typing this `string` is what
   * let `value === 'true'` look correct while never matching a real Bool.
   */
  value?: string | boolean;
  variant_name?: string;
  fields?: { value?: string }[];
}

/** A `Some(x)` optional's inner string, or null for `None` / an odd shape. */
function optionalString(fields: KvField[], name: string): string | null {
  const f = fields.find(x => x?.field_name === name);
  if (f?.variant_name !== 'Some') return null;
  const inner = f.fields?.[0]?.value;
  return typeof inner === 'string' ? inner : null;
}

/**
 * Read the worker's entitlement for `onChainTaskId` on `escrowComponent`.
 * Returns null when it cannot be read — Gateway hiccup, unknown key on THIS
 * component, or an unexpected shape. `null` is "unknown", NEVER "zero": a
 * caller about to skip a withdrawal must not treat an unreadable chain as an
 * empty one.
 */
export async function readWorkerEntitlement(
  onChainTaskId: number,
  escrowComponent: string,
  gatewayBaseUrl: string,
  fetchFn: typeof fetch = fetch
): Promise<WorkerEntitlement | null> {
  const kvStore = await resolveTasksKvStore(escrowComponent, gatewayBaseUrl, fetchFn);
  if (!kvStore) return null;
  try {
    const resp = await fetchFn(`${gatewayBaseUrl}/state/key-value-store/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key_value_store_address: kvStore,
        keys: [{ key_json: { kind: 'U64', value: String(onChainTaskId) } }],
      }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      entries?: { value?: { programmatic_json?: { fields?: KvField[] } } }[];
    };
    const fields = json?.entries?.[0]?.value?.programmatic_json?.fields;
    if (!Array.isArray(fields)) return null;

    const entitlementsPresent = ENTITLEMENT_FIELDS.every(name =>
      fields.some(f => f?.field_name === name)
    );
    // Validate the SHAPE, as guild-app's decimalField does: a malformed value
    // normalises to '0' rather than being echoed verbatim into a log line or a
    // WithdrawResult. isPositiveDecimal re-validates independently, so the
    // collect/refuse decision was never at risk — this keeps what we PRINT
    // honest too.
    const decimal = (name: string): string => {
      const v = fields.find(f => f?.field_name === name)?.value;
      return typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? v : '0';
    };
    // Bool comes through programmatic_json as the literal true/false, but SBOR
    // bools have also been seen serialised as the STRINGS "true"/"false"
    // depending on the encoder — accept both and treat everything else as
    // false, so an unexpected shape can never read as "agent" and send the
    // worker's withdrawal at a resource the component will reject.
    // ⚠️ This ACCEPTS BOTH deliberately. An earlier cut compared only to the
    // string, which can never match the Gateway's actual encoding (verified
    // live: kind "Bool", value `false`), so every agent-claimed task would have
    // resolved against the Member badge. It survived a live read because the
    // task read against happened to be member-claimed — false either way.
    const ciaRaw = fields.find(f => f?.field_name === 'claimer_is_agent')?.value;

    return {
      reward: decimal('worker_entitled'),
      bond: decimal('worker_bond_entitled'),
      workerAccount: optionalString(fields, 'worker_account'),
      claimerBadgeId: optionalString(fields, 'claimer_badge_id'),
      claimerIsAgent: ciaRaw === true || ciaRaw === 'true',
      entitlementsPresent,
    };
  } catch {
    return null;
  }
}

/**
 * True for a decimal string strictly greater than zero, at full 18dp precision.
 *
 * FAITHFUL PORT of guild-app `isPositiveDecimal` (src/lib/escrow-drift.ts), and
 * deliberately identical rather than "equivalent": that function's own comment
 * records that a second copy is how two definitions of "is anything owed" drift
 * into disagreeing. The CLI must answer that question exactly as the drift
 * watcher and the withdraw UI do, or an agent would skip a withdrawal the
 * watcher is simultaneously alerting on.
 *
 * `Number()` is unusable here: these are Scrypto `Decimal`s (18dp fixed point)
 * and float conversion invents digits rather than rounding.
 */
export function isPositiveDecimal(v: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(v)) return false;
  const [whole, frac = ''] = v.split('.');
  return BigInt(whole + frac.padEnd(18, '0').slice(0, 18)) > BigInt(0);
}
