import { GATEWAY, SCHEMAS, BADGE_NFT } from "./constants";
import { XRD_ADDRESS } from "./radix";
import type { BadgeInfo } from "./types";
import { addXrd, gteXrd } from "./xrd-decimal";

// ── Gateway request bounds ───────────────────────────────────────────────────
//
// Every fetch in this module used to run unbounded. That is worse than it
// sounds, because almost every reader here wraps its fetch in
// `try/catch → return null` — and a catch only runs once a promise SETTLES. A
// connection that hangs rather than fails never reaches the handler, so the
// careful null-means-unknown behaviour these functions are built around never
// fires and the caller waits forever instead. The failure mode is not a slow
// page, it is a wedged one: on a request path that is a tied-up handler, and on
// the reconcile cron (`15,45 * * * *`) it is a job that never returns.
//
// ONE read bound rather than a tier per call site, deliberately. Several of
// these readers serve BOTH a request path and the cron — `resolveTasksKvStore`
// and `readXrdPostingFrozen` are each reached from an API route and from
// escrow-confirm's readers — so a tighter "web" tier would either silently
// tighten the cron too or force a second copy of the same reader. A single
// number that is defensible everywhere beats a tier system that is wrong
// somewhere.
export const GATEWAY_READ_TIMEOUT_MS = 15_000;

// Submitting is not reading, and it fails differently. `submitNotarizedTransaction`
// returns `false` on any transport failure, and its caller treats false as
// "submit_rejected" and stops — so an abort turns "we do not know" into a
// definite wrong answer while the payer's transaction may well be committing.
// Bounded much more loosely for that reason: the cost of waiting is a slow
// settlement, the cost of aborting early is a false rejection on a money path.
//
// ⚠️ This does NOT fix the underlying gap, and must not be read as doing so:
// the pre-existing `catch → false` already collapses unknown into rejected.
// The real fix is for the caller to poll the intent hash before concluding
// rejection — duplicate submits are explicitly safe (the Gateway 2xxs them) —
// and that belongs in the x402 facilitator, not here. See the PR discussion.
export const GATEWAY_SUBMIT_TIMEOUT_MS = 30_000;

export async function fetchEntityDetails(address: string) {
  const resp = await fetch(`${GATEWAY}/state/entity/details`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      addresses: [address],
      aggregation_level: "Vault",
      opt_ins: { non_fungible_include_nfids: true },
    }),
    signal: AbortSignal.timeout(GATEWAY_READ_TIMEOUT_MS),
  });
  if (!resp.ok) return null;
  return resp.json();
}

/**
 * Best-effort XRD balance for an account, summed across its XRD vaults.
 * Callers MUST treat the return values distinctly:
 *   • null  → unknown (Gateway hiccup / unexpected shape) — do NOT block on it
 *   • 0     → confirmed empty (a never-funded account has no XRD resource)
 *   • >0    → the balance
 * Used by the mint page to nudge a 0-XRD wallet before its tx fails on the fee.
 */
export async function fetchXrdBalance(address: string): Promise<number | null> {
  try {
    const data = await fetchEntityDetails(address);
    if (!data) return null;
    const fungibles = data.items?.[0]?.fungible_resources?.items ?? [];
    const xrd = fungibles.find((r: any) => r.resource_address === XRD_ADDRESS);
    if (!xrd) return 0;
    let total = 0;
    for (const v of xrd.vaults?.items ?? []) {
      const amt = Number(v?.amount);
      if (Number.isFinite(amt)) total += amt;
    }
    return total;
  } catch {
    return null;
  }
}

/**
 * Has this Member-badge local id (`<guild_member_name>`) ever been minted?
 * `/state/non-fungible/data` answers 200 with `non_fungible_ids: []` for an
 * id that does not exist and `[{…}]` for one that does (verified live
 * 2026-09-24). `revoke_badge` never burns, so "minted once" = "taken forever".
 * Returns null when the Gateway could not be asked — callers fail closed.
 */
export async function isBadgeLocalIdMinted(localId: string, badgeResource: string = BADGE_NFT): Promise<boolean | null> {
  try {
    const data = await fetchNftData(badgeResource, [localId])
    if (!data || !Array.isArray(data.non_fungible_ids)) return null
    return data.non_fungible_ids.length > 0
  } catch {
    return null
  }
}

export async function fetchNftData(resourceAddress: string, nfIds: string[]) {
  const resp = await fetch(`${GATEWAY}/state/non-fungible/data`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      resource_address: resourceAddress,
      non_fungible_ids: nfIds,
    }),
    signal: AbortSignal.timeout(GATEWAY_READ_TIMEOUT_MS),
  });
  if (!resp.ok) return null;
  return resp.json();
}

export function parseBadgeFields(nfId: string, fields: any[]): BadgeInfo {
  const g = (i: number) => fields[i]?.value || fields[i]?.fields?.[0]?.value || "-";
  return {
    id: nfId,
    issued_to: g(0),
    schema_name: g(1),
    issued_at: parseInt(g(2)) || 0,
    tier: g(3),
    status: g(4),
    last_updated: parseInt(g(5)) || 0,
    xp: parseInt(g(6)) || 0,
    level: g(7),
    extra_data: g(8),
  };
}

/**
 * Discriminated badge lookup. `ok: false` means the GATEWAY failed (network
 * error, non-200, or an unreadable NFT we know exists) — the holder's badge
 * state is UNKNOWABLE, which is not the same as badgeless. `ok: true` with
 * `badge: null` is a confirmed no-badge (the account's vaults were read and
 * hold none). Callers that render a "mint one" nudge must branch on `ok`
 * first — a gateway blip shown as "no badge" tells a badge-holder to re-mint
 * (frontend audit 2026-07-17, Theme C).
 */
export async function loadUserBadgeResult(
  address: string,
  badgeResource: string
): Promise<{ ok: true; badge: BadgeInfo | null } | { ok: false }> {
  try {
    const data = await fetchEntityDetails(address);
    if (!data) return { ok: false };

    const nfResources = data.items?.[0]?.non_fungible_resources?.items || [];
    const badgeRes = nfResources.find(
      (r: any) => r.resource_address === badgeResource
    );
    if (!badgeRes) return { ok: true, badge: null };

    const nfIds = badgeRes.vaults?.items?.[0]?.items || [];
    if (nfIds.length === 0) return { ok: true, badge: null };

    const nftData = await fetchNftData(badgeResource, [nfIds[0]]);
    if (!nftData) return { ok: false };

    const nft = nftData.non_fungible_ids?.[0];
    // The badge NFT provably exists (its id came out of the vault) — failing
    // to read its data is a lookup failure, not a badgeless account.
    if (!nft?.data?.programmatic_json?.fields) return { ok: false };

    return { ok: true, badge: parseBadgeFields(nfIds[0], nft.data.programmatic_json.fields) };
  } catch (e) {
    console.error("Badge load error:", e);
    return { ok: false };
  }
}

/**
 * Lenient form — flattens gateway failure to null ("treat as badgeless").
 * Correct only where fail-closed is the desired semantics (authz gates:
 * claim gate, submissions route). UI that nudges minting must use
 * loadUserBadgeResult instead. Non-fungible badges only — the /admin operator
 * badge is fungible and goes through holdsFungibleBadgeResult below.
 */
export async function loadUserBadge(
  address: string,
  badgeResource: string
): Promise<BadgeInfo | null> {
  const result = await loadUserBadgeResult(address, badgeResource);
  return result.ok ? result.badge : null;
}

/**
 * Every badge schema declared in `src/lib/schemas.ts` (SCHEMAS), checked
 * independently over the SAME address — the strict form for a page that must
 * never assert "no badge" off a partial read.
 *
 * `lookupAllBadges` (below) already scans every schema, but it swallows a
 * per-schema Gateway failure into an empty array — indistinguishable from a
 * genuinely badgeless account. That is fine for the admin lookup tool (a
 * human re-runs it), but a public profile page rendering "No badge found for
 * this address" off a Gateway hiccup is a false claim to a badge holder
 * during an outage — the exact failure `loadUserBadgeResult`'s own docblock
 * warns about, just spread across N schemas instead of one.
 *
 * So this keeps the ok/fail split PER SCHEMA: `badges` lists only schemas
 * that came back `ok: true` with a real badge (a confirmed positive, always
 * safe to show); `complete` is false if ANY schema's read failed, which is
 * the caller's signal that an empty `badges` array does NOT mean "confirmed
 * badgeless" — it means "ask again", and the honest render is neither a
 * badge nor a "no badge" claim.
 *
 * Every resource address checked here is `SCHEMAS[key].badge` — traced to
 * the on-chain addresses schemas.ts declares, never a DB value.
 */
export interface StrictBadgeLookup {
  badges: { schema: string; badge: BadgeInfo }[];
  /** False if ANY schema's Gateway read failed — see the note above. */
  complete: boolean;
}

export async function loadAllBadgesStrict(address: string): Promise<StrictBadgeLookup> {
  const perSchema = await Promise.all(
    Object.entries(SCHEMAS).map(async ([schema, cfg]) => ({
      schema,
      result: await loadUserBadgeResult(address, cfg.badge),
    })),
  );

  const badges: { schema: string; badge: BadgeInfo }[] = [];
  let complete = true;
  for (const { schema, result } of perSchema) {
    if (!result.ok) {
      complete = false;
      continue;
    }
    if (result.badge) badges.push({ schema, badge: result.badge });
  }
  return { badges, complete };
}

/**
 * Does `address` hold at least 1 of the FUNGIBLE resource `badgeResource`,
 * summed across its vaults?
 *
 * The NFT readers above only look at `non_fungible_resources`, so they can
 * never see a fungible badge. ADMIN_BADGE is fungible (supply 1, divisibility
 * 0), which is why the /admin gate denied the one account that holds it until
 * this existed (found 2026-09-23).
 *
 * Reads `/state/entity/page/fungible-vaults/`, which answers for one resource.
 * `fungible_resources` from fetchEntityDetails is a paged list of EVERY
 * fungible the account holds, airdrops included, so a badge past the first
 * page would read as not held.
 *
 * Same contract as loadUserBadgeResult: `ok: false` is UNKNOWN (non-2xx,
 * including the 400 the Gateway returns when the resource is not fungible;
 * transport failure; timeout; a shape we cannot read), never "not held".
 * `ok: true, held: false` is a confirmed read: no vault, or vaults below 1 (an
 * emptied vault stays behind at "0"). Amounts are compared as exact 18dp
 * decimals, not JS numbers: Number("0.999999999999999999") is 1.
 */
export async function holdsFungibleBadgeResult(
  address: string,
  badgeResource: string,
): Promise<{ ok: true; held: boolean } | { ok: false }> {
  // readFungibleVaultTotal sums in exact 18dp Radix Decimal arithmetic (any
  // fungible, not just XRD) and reads a non-decimal amount as unknown.
  const read = await readFungibleVaultTotal(address, badgeResource);
  if (!read) return { ok: false };
  if (gteXrd(read.total, "1")) return { ok: true, held: true };
  // More vaults on a later page could make up the rest: not a confirmed no.
  if (!read.complete) return { ok: false };
  return { ok: true, held: false };
}

// ── Escrow transaction event reading (server-side: escrow-confirm endpoint) ──
//
// Reads a committed tx's emitted events to capture / verify escrow lifecycle
// state on-chain. Defensive about where the event FIELDS live
// (data.programmatic_json.fields vs data.fields; field_name/value), but strict
// (fail-closed) on the emitter address — if the live Gateway shape differs,
// verification fails safe and the smoke test will surface it.

async function fetchTxDetails(
  intentHash: string,
): Promise<{ events: unknown[]; confirmedAt: Date | null } | null> {
  try {
    const resp = await fetch(`${GATEWAY}/transaction/committed-details`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent_hash: intentHash,
        opt_ins: { receipt_events: true },
      }),
      signal: AbortSignal.timeout(GATEWAY_READ_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const status = json?.transaction?.transaction_status;
    if (status && status !== "CommittedSuccess") return null;
    const events = json?.transaction?.receipt?.events ?? null;
    if (!events) return null;
    // The tx's consensus timestamp — the same clock the blueprint reads for
    // its event timestamps (e.g. disputed_at). Best-effort, NOT fail-closed:
    // verification never hinges on it, so an unparseable shape degrades to
    // null rather than rejecting a committed event.
    const ts = json?.transaction?.confirmed_at;
    const confirmedAt =
      typeof ts === "string" && !Number.isNaN(Date.parse(ts)) ? new Date(ts) : null;
    return { events, confirmedAt };
  } catch {
    return null;
  }
}

async function fetchTxEvents(intentHash: string): Promise<unknown[] | null> {
  return (await fetchTxDetails(intentHash))?.events ?? null;
}

function findEventFields(
  events: unknown[],
  name: string,
  emitter: string,
): any[] | null {
  for (const ev of events as any[]) {
    if (ev?.name !== name) continue;
    // Fail CLOSED on the emitter pin: the event must verifiably come from OUR
    // escrow component. A missing/unexpected emitter shape rejects the event —
    // a look-alike event (same name + task_id) emitted by another component
    // must never verify, even if the Gateway payload shape drifts.
    const em = ev?.emitter?.entity?.entity_address;
    if (em !== emitter) continue;
    const fields = ev?.data?.programmatic_json?.fields ?? ev?.data?.fields;
    if (Array.isArray(fields)) return fields;
  }
  return null;
}

function u64Field(fields: any[], fieldName: string): number | null {
  const f = fields.find((x) => x?.field_name === fieldName);
  const v = f?.value;
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Read a Scrypto Decimal event field as a numeric string (e.g. "10.5"). */
function decimalField(fields: any[], fieldName: string): string | null {
  const f = fields.find((x) => x?.field_name === fieldName);
  const v = f?.value;
  return typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? v : null;
}

/**
 * Read a Scrypto enum event field's variant name (programmatic JSON puts
 * `variant_name` on the field object, e.g. raised_by: DisputeParty::Poster →
 * { field_name: "raised_by", variant_name: "Poster", … }). Defensive: null on
 * any unexpected shape.
 */
function enumVariantField(fields: any[], fieldName: string): string | null {
  const f = fields.find((x) => x?.field_name === fieldName);
  const v = f?.variant_name;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Read a ResourceAddress field — the same anchored shape readTaskRewardInfo accepts. */
function resourceAddressField(fields: any[], fieldName: string): string | null {
  const v = fields.find((x) => x?.field_name === fieldName)?.value;
  return typeof v === "string" && /^resource_rdx[a-z0-9]{20,}$/.test(v) ? v : null;
}

/**
 * Read a create_task tx's TaskCreatedEvent. `taskId` is the critical capture —
 * claim/submit/approve all key off it, so this returns null if it can't be read.
 * `rewardAmount` + `rewardToken` are what the tx actually escrowed: the create
 * confirm refuses to link a row whose advertised reward differs, and refuses
 * when either is null (src/lib/funded-reward.ts). `insuranceAmount` is the
 * on-chain insurance deposit — the auto-resolve finalize flow needs it to route
 * the raiser's insurance leg with the EXACT on-chain decimal (null tolerated by
 * the confirm route, fatal for finalize).
 */
export async function readEscrowTaskCreated(
  intentHash: string,
  escrowComponent: string,
): Promise<{
  taskId: number;
  rewardAmount: string | null;
  rewardToken: string | null;
  insuranceAmount: string | null;
} | null> {
  const events = await fetchTxEvents(intentHash);
  if (!events) return null;
  const fields = findEventFields(events, "TaskCreatedEvent", escrowComponent);
  if (!fields) return null;
  const taskId = u64Field(fields, "task_id");
  if (taskId === null) return null;
  return {
    taskId,
    rewardAmount: decimalField(fields, "reward_amount"),
    rewardToken: resourceAddressField(fields, "reward_token"),
    insuranceAmount: decimalField(fields, "insurance_amount"),
  };
}

/**
 * Read a raise_dispute tx's DisputeRaisedEvent → which party raised it.
 * The auto-resolve finalize flow keys the payout off this under a
 * FavorDisputeRaiser default (the live component reads SplitEvenly — see
 * `disputeRaisedBy` below), so it goes through the same fail-closed emitter pin as
 * every reader here and returns null for any variant outside the blueprint's
 * DisputeParty enum.
 *
 * `confirmedAt` is the tx's consensus timestamp — the on-chain disputed_at the
 * blueprint's 72h auto-resolve window keys off. Best-effort (null tolerated):
 * the dispute confirm persists it for display countdowns and falls back to
 * confirm time; only raisedBy/task_id/emitter are fail-closed.
 */
export async function readDisputeRaised(
  intentHash: string,
  escrowComponent: string,
  expectedTaskId: number,
): Promise<{ raisedBy: "Poster" | "Worker"; confirmedAt: Date | null } | null> {
  const details = await fetchTxDetails(intentHash);
  if (!details) return null;
  const fields = findEventFields(details.events, "DisputeRaisedEvent", escrowComponent);
  if (!fields) return null;
  if (u64Field(fields, "task_id") !== expectedTaskId) return null;
  const raisedBy = enumVariantField(fields, "raised_by");
  if (raisedBy !== "Poster" && raisedBy !== "Worker") return null;
  return { raisedBy, confirmedAt: details.confirmedAt };
}

/**
 * Read an auto_resolve_dispute tx's DisputeAutoResolvedEvent → the EXACT
 * on-chain settlement amounts (decimal strings; "0" is a valid share). The
 * confirm route writes the ledger rows from these verified amounts — never
 * from DB-recorded values. Null if either amount can't be read exactly.
 */
export async function readDisputeAutoResolved(
  intentHash: string,
  escrowComponent: string,
  expectedTaskId: number,
): Promise<{ workerAmount: string; posterAmount: string } | null> {
  const events = await fetchTxEvents(intentHash);
  if (!events) return null;
  const fields = findEventFields(events, "DisputeAutoResolvedEvent", escrowComponent);
  if (!fields) return null;
  if (u64Field(fields, "task_id") !== expectedTaskId) return null;
  const workerAmount = decimalField(fields, "worker_amount");
  const posterAmount = decimalField(fields, "poster_amount");
  if (workerAmount === null || posterAmount === null) return null;
  return { workerAmount, posterAmount };
}

/**
 * The ARBITER's ruling — `resolve_dispute` (lib.rs, its `pub fn` declaration),
 * not the 72h timeout.
 *
 * ⚠️ THIS EXISTS BECAUSE THE ARBITER PATH WAS UNBOOKKEEPABLE. `resolve_dispute`
 * emits DisputeResolvedEvent (lib.rs, right after its Released/Refunded match)
 * alongside TaskReleasedEvent or
 * TaskRefundedEvent. Nothing read DisputeResolvedEvent, and TaskReleasedEvent
 * maps to kind `approve`, whose ALLOWED_FROM excludes `disputed` — so a real
 * arbiter ruling classified as `superseded` and the resync counted it as
 * `reflected`. The row stayed `disputed` forever and the resync reported
 * success. The AUTO path booked correctly; only the human lever did not.
 *
 * Shape is deliberately the same as readDisputeAutoResolved plus the fee, so
 * one confirm handler serves both settlement routes and they cannot drift.
 */
export async function readDisputeResolved(
  intentHash: string,
  escrowComponent: string,
  expectedTaskId: number,
): Promise<{ workerAmount: string; posterAmount: string; arbiterFee: string } | null> {
  const events = await fetchTxEvents(intentHash);
  if (!events) return null;
  const fields = findEventFields(events, "DisputeResolvedEvent", escrowComponent);
  if (!fields) return null;
  if (u64Field(fields, "task_id") !== expectedTaskId) return null;
  const workerAmount = decimalField(fields, "worker_amount");
  const posterAmount = decimalField(fields, "poster_amount");
  const arbiterFee = decimalField(fields, "arbiter_fee");
  if (workerAmount === null || posterAmount === null) return null;
  return { workerAmount, posterAmount, arbiterFee: arbiterFee ?? "0" };
}

/** The component's configured ruling for a lapsed, un-arbitrated dispute. */
export type AutoResolveDefault =
  | "FavorDisputeRaiser"
  | "SplitEvenly"
  | "ReturnToPoster";

/**
 * Read `dispute_auto_resolve_default` from the escrow component's state.
 *
 * `raise_dispute` pins this value onto the task, and auto_resolve_dispute applies
 * the default ruling pinned when the dispute was raised — a later change to this
 * field does not move a dispute already raised. Under PULL the finalize manifest
 * routes nothing (the component credits both sides internally), so this value is
 * for reporting or predicting a settlement, not for routing one. Returns null when
 * the field can't be read (Gateway hiccup /
 * unexpected shape); callers MUST fail closed on null rather than assume a
 * default, because assuming is the bug.
 */
/**
 * The resource a component's OWNER role actually requires, read from the
 * component itself.
 *
 * ⚠️ THIS EXISTS BECAUSE THE CONSTANT WAS WRONG TWICE. Four Escrow components
 * have been deployed (v1, the push-era `…cr690h`, the retired PULL `…cz468e`,
 * and the live Wave B `…czka54`), each with its own owner badge — and the
 * badges are fungible, supply 1, and carry BYTE-IDENTICAL `name` and
 * `description` metadata (re-read for the PULL and Wave B badges 2026-09-16).
 * Nothing on a badge says which component it opens. A wallet shows
 * indistinguishable rows, and a hardcoded address survives a cutover looking perfectly healthy:
 * `deploy-escrow` carried the DEAD v1 badge across two of them, so its
 * owner-gated control built a manifest that could only fail `Unauthorized`
 * after the operator had already signed.
 *
 * So the badge is DERIVED from the target, never pinned. A pinned owner badge
 * is a latent cutover bug by construction.
 *
 * Returns null — never a guess — if the shape is anything other than a single
 * `Require(Resource)` rule. Callers MUST fail closed: an owner-gated manifest
 * built on an unknown badge is exactly the tx that burns a fee to learn nothing.
 */
export async function readComponentOwnerBadge(
  componentAddress: string,
): Promise<string | null> {
  const json = await fetchEntityDetails(componentAddress);
  const rule = json?.items?.[0]?.details?.role_assignments?.owner?.rule;
  if (rule?.type !== "Protected") return null;
  const proofRule = rule?.access_rule?.proof_rule;
  // Only a bare `Require(Resource)` is unambiguous. AnyOf/AllOf/CountOf name
  // several resources and there is no single right answer to return.
  if (proofRule?.type !== "Require") return null;
  const requirement = proofRule?.requirement;
  if (requirement?.type !== "Resource") return null;
  const resource = requirement?.resource;
  if (typeof resource !== "string" || !resource.startsWith("resource_rdx1")) {
    return null;
  }
  return resource;
}

export async function readDisputeAutoResolveDefault(
  escrowComponent: string,
): Promise<AutoResolveDefault | null> {
  const details = await fetchEntityDetails(escrowComponent);
  const fields = details?.items?.[0]?.details?.state?.fields;
  if (!Array.isArray(fields)) return null;
  const variant = fields.find(
    (f: { field_name?: string }) => f?.field_name === "dispute_auto_resolve_default",
  )?.variant_name;
  return variant === "FavorDisputeRaiser" ||
    variant === "SplitEvenly" ||
    variant === "ReturnToPoster"
    ? variant
    : null;
}

/** Verify a committed escrow tx emitted `eventName` for `expectedTaskId`. */
export async function verifyEscrowEvent(
  intentHash: string,
  eventName: string,
  escrowComponent: string,
  expectedTaskId: number,
): Promise<boolean> {
  const events = await fetchTxEvents(intentHash);
  if (!events) return false;
  const fields = findEventFields(events, eventName, escrowComponent);
  return fields ? u64Field(fields, "task_id") === expectedTaskId : false;
}

// ── Live on-chain task state (escrow `tasks` KeyValueStore) ──────────────────
//
// The readers above verify what happened in a SPECIFIC tx. This reads a task's
// CURRENT on-chain state straight from the component's `tasks` KeyValueStore —
// the source of truth for "is this task still Open?". Two callers rely on it:
//   • the claim-time guard — don't send a claim tx that will revert on the
//     blueprint's `must be Open` assert (src/lib.rs) and burn the lock fee
//     when a stale DB row still shows a cancelled/settled task as claimable;
//   • the drift watcher — compare live chain state against the DB status.

/** The escrow blueprint's TaskState enum (guild-marketplace-escrow src/lib.rs). */
export type OnChainTaskState =
  | "Open"
  | "Claimed"
  | "Submitted"
  | "Disputed"
  | "Released"
  | "Refunded";

const ON_CHAIN_TASK_STATES: ReadonlySet<string> = new Set([
  "Open",
  "Claimed",
  "Submitted",
  "Disputed",
  "Released",
  "Refunded",
]);

// Per-component cache of the `tasks` KeyValueStore address. That mapping is a
// field of the instantiated component state — immutable for a given component —
// so caching for the process/page lifetime is safe and saves a Gateway
// round-trip on every state read (the drift watcher reads many in a loop).
const tasksKvStoreCache = new Map<string, string>();

async function resolveTasksKvStore(
  escrowComponent: string,
): Promise<string | null> {
  const cached = tasksKvStoreCache.get(escrowComponent);
  if (cached) return cached;
  try {
    const resp = await fetch(`${GATEWAY}/state/entity/details`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addresses: [escrowComponent] }),
      signal: AbortSignal.timeout(GATEWAY_READ_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const fields = json?.items?.[0]?.details?.state?.fields;
    if (!Array.isArray(fields)) return null;
    const addr = fields.find((f: any) => f?.field_name === "tasks")?.value;
    // Fail closed on the shape: only accept an internal KV-store address.
    if (typeof addr !== "string" || !addr.startsWith("internal_keyvaluestore_")) {
      return null;
    }
    tasksKvStoreCache.set(escrowComponent, addr);
    return addr;
  } catch {
    return null;
  }
}

/**
 * Read a task's CURRENT on-chain TaskState from the escrow component's `tasks`
 * KeyValueStore. Returns the variant name (Open / Claimed / … / Refunded), or
 * `null` when it can't be read — a Gateway hiccup, an unknown key (no such task
 * on THIS component), or an unexpected shape.
 *
 * `null` means "unknown", NEVER "gone": callers must not treat an unreadable
 * state as terminal. The claim guard proceeds on null (the on-chain assert is
 * still the final gate — worst case one racy fee, not a blocked queue); the
 * drift watcher skips on null (a transient Gateway failure must not fabricate
 * drift). The `onChainTaskId` numbering is per-component, so the caller is
 * responsible for confirming the id belongs to `escrowComponent` (ids collide
 * across component cutovers — see the drift watcher's fund-tx pin).
 */
export async function readEscrowTaskState(
  onChainTaskId: number,
  escrowComponent: string,
): Promise<OnChainTaskState | null> {
  // Thin wrapper over readEscrowTaskInfo (below) so the KV-read + state-parse +
  // fail-open contract live in exactly one place — the two must never diverge
  // (this function's result IS readEscrowTaskInfo().state).
  return (await readEscrowTaskInfo(onChainTaskId, escrowComponent))?.state ?? null;
}

/** The subset of on-chain TaskInfo the worker-truth UI surfaces (P2). */
export interface OnChainTaskInfo {
  state: OnChainTaskState;
  /**
   * Submit-by deadline for a Claimed task (set at claim = claim_time +
   * submit_deadline_secs). After it, `expire_claim` is PUBLIC and forfeits the
   * worker's claim bond. Null unless the task is currently Claimed.
   */
  claimDeadline: Date | null;
  /**
   * Wave B stage 6: `submitted_at + review_window_secs`, pinned onto the task
   * at `submit_task` — null unless the task is currently Submitted. After it,
   * `release_after_review_timeout` is PUBLIC and callable by anyone; it pays
   * exactly what an approval would. Absent (null) on a pre-Wave-B component,
   * same "unset field reads as unset, not as urgent" posture as claimDeadline.
   */
  reviewDeadline: Date | null;
  /**
   * The party that raised a live dispute. Null unless a dispute is live.
   *
   * ⚠️ CORRECTED 2026-08-25. This comment said "under the deployed
   * FavorDisputeRaiser default they win reward + insurance". Both halves were
   * wrong, and the wrong version propagated into an operator-facing alert:
   *   • The live component reads dispute_auto_resolve_default = SplitEvenly
   *     (chain-read at component_rdx1cz468eqyr0fklyrlcsznadrwfnqnesw37vlm9j0xmq2s7427akd82f).
   *     The Wave B component live since 2026-09-13 also reads SplitEvenly
   *     (re-read 2026-09-16), but the "set once at instantiate(), no setter"
   *     half no longer holds: Wave B added the OWNER-only
   *     `set_dispute_auto_resolve_default`. It moves the live default, never a
   *     dispute already pinned at raise_dispute.
   *   • The ruling governs the REWARD ONLY. The insurance leg is hard-coded
   *     RefundPoster regardless of the ruling (`auto_resolve_dispute` passes
   *     `&DisputeRuling::RefundPoster` for insurance) — an explicit
   *     anti-strict-dominance fix, because a prior version paid the worker MORE
   *     than honest approval. So no ruling ever "wins reward + insurance".
   * `raisedBy` only decides the outcome under FavorDisputeRaiser, which is not
   * what is deployed. Do not infer a payout from this field alone.
   */
  disputeRaisedBy: "poster" | "worker" | null;
  /**
   * When the live dispute was raised (on-chain `disputed_at`, a TaskInfo field). The
   * auto-resolve window is measured from THIS instant, so it is what a watcher
   * needs to compute time-remaining before `auto_resolve_dispute` becomes
   * callable by anyone.
   *
   * Null unless a dispute is live. Read from the task's own struct rather than
   * from the raising tx, deliberately: a dispute raised by a hand-built
   * manifest has no DB row and no known intent hash, and that is precisely the
   * case a bad-faith dispute takes.
   */
  disputedAt: Date | null;
  /**
   * PULL entitlements — settled-but-unwithdrawn amounts, per party per lane
   * (redesign §5c). Exact decimal STRINGS: these are money and must never be
   * parsed through a JS number.
   *
   * ⚠️ All four are `"0"` on a PRE-PULL component, which carries no such
   * fields — an absent field reads as `"0"`, identical to a
   * settled-and-collected task. (The live Wave B component does carry them;
   * the warning still applies to any retired component the app reads.) So a
   * zero here means "nothing owed OR this component doesn't do entitlements",
   * and only `entitlementsPresent` tells them apart. Anything that alerts on
   * outstanding money (chunk E) MUST gate on that flag, or it will report
   * all-clear against such a component forever and look like it is working.
   */
  entitlements: {
    workerReward: string;
    posterReward: string;
    workerBond: string;
    posterBond: string;
  };
  /**
   * Whether this component's TaskInfo actually carries the entitlement fields —
   * i.e. it is a post-pull deployment. False against the currently-deployed
   * escrow. Distinguishes "owes nothing" from "cannot say".
   */
  entitlementsPresent: boolean;
  /**
   * The worker's payee pin, captured at claim_task and never chosen by a
   * caller. This is the account a withdrawal must deposit into, so it is what
   * lets the off-chain layer audit payee correctness. Null when unclaimed.
   */
  workerAccount: string | null;
  /** The poster's account — the other payee pin. */
  posterAccount: string | null;
  /**
   * Local id of the badge that claimed this task, needed to build the worker's
   * withdraw proof. Null when unclaimed.
   */
  claimerBadgeId: string | null;
  /**
   * Whether the badge that claimed this task was an AGENT badge rather than the
   * Guild member badge — `TaskInfo.claimer_is_agent`, set at `claim_task` from
   * whichever resource the claimer presented.
   *
   * ⚠️ Read because `withdraw_worker` asserts the presented badge is the
   * claimer's resource (lib.rs, its "badge must be the claimer's worker or
   * agent badge" assert), choosing between
   * `worker_badge_resource` and `agent_badge_resource` off exactly this flag.
   * The withdraw manifest has to name a resource, so guessing it wrong is a
   * guaranteed on-chain revert that costs the worker a fee to be told no.
   * Chunk D did not read it because nothing needed it yet; chunk G is the first
   * caller that cannot be correct without it.
   *
   * Defaults to `false` when the field is absent (pre-pull components predate
   * neither this field nor the agent lane — it has existed since claim_task —
   * but an unreadable shape must not silently become "agent").
   */
  claimerIsAgent: boolean;
  /**
   * What `create_task` escrowed — `reward_amount` (exact decimal string) and
   * `reward_token`. Fixed at creation; the reward vault holds exactly this
   * until a transition out of Open/Claimed/Submitted/Disputed drains it. The
   * drift watcher compares it to the reward the board advertises
   * (src/lib/funded-reward.ts). Null = unreadable, never zero.
   */
  rewardAmount: string | null;
  rewardToken: string | null;
}

/**
 * Read the fuller on-chain TaskInfo (state + claim_deadline + dispute_raised_by)
 * from the escrow component's `tasks` KV store — the SAME entry
 * readEscrowTaskState reads, additionally parsing the two Option fields the P2
 * worker-truth surfaces need. Both are Option enums in the SBOR
 * programmatic_json: `Some` carries the value in `fields[0]`, `None` = unset.
 *   • claim_deadline → Some.fields[0] is the Instant's seconds_since_unix_epoch
 *     as an I64 string.
 *   • dispute_raised_by → Some.fields[0] is a DisputeParty enum whose
 *     variant_name is "Poster" or "Worker".
 *
 * Returns null when the entry can't be read (Gateway hiccup / unknown key on
 * THIS component / unexpected shape). `null` means "unknown", never a state —
 * callers fail open (show nothing) rather than assert anything from it.
 */
export async function readEscrowTaskInfo(
  onChainTaskId: number,
  escrowComponent: string,
): Promise<OnChainTaskInfo | null> {
  const kvStore = await resolveTasksKvStore(escrowComponent);
  if (!kvStore) return null;
  try {
    const resp = await fetch(`${GATEWAY}/state/key-value-store/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key_value_store_address: kvStore,
        keys: [{ key_json: { kind: "U64", value: String(onChainTaskId) } }],
      }),
      signal: AbortSignal.timeout(GATEWAY_READ_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const fields = json?.entries?.[0]?.value?.programmatic_json?.fields;
    if (!Array.isArray(fields)) return null;

    const stateVariant = fields.find((f: any) => f?.field_name === "state")?.variant_name;
    if (typeof stateVariant !== "string" || !ON_CHAIN_TASK_STATES.has(stateVariant)) return null;

    let claimDeadline: Date | null = null;
    const cd = fields.find((f: any) => f?.field_name === "claim_deadline");
    if (cd?.variant_name === "Some") {
      const secs = Number(cd?.fields?.[0]?.value);
      // Guard the arithmetic: only a finite, positive epoch becomes a Date.
      if (Number.isFinite(secs) && secs > 0) claimDeadline = new Date(secs * 1000);
    }

    // Wave B stage 6 field — absent (undefined) on a pre-Wave-B component,
    // which `fields.find` already reads as "not Some", same as an unset
    // Option on a component that has the field. Same guard as claim_deadline.
    let reviewDeadline: Date | null = null;
    const rd = fields.find((f: any) => f?.field_name === "review_deadline");
    if (rd?.variant_name === "Some") {
      const secs = Number(rd?.fields?.[0]?.value);
      if (Number.isFinite(secs) && secs > 0) reviewDeadline = new Date(secs * 1000);
    }

    let disputeRaisedBy: "poster" | "worker" | null = null;
    const dr = fields.find((f: any) => f?.field_name === "dispute_raised_by");
    if (dr?.variant_name === "Some") {
      const party = dr?.fields?.[0]?.variant_name;
      if (party === "Poster") disputeRaisedBy = "poster";
      else if (party === "Worker") disputeRaisedBy = "worker";
    }

    let disputedAt: Date | null = null;
    const da = fields.find((f: any) => f?.field_name === "disputed_at");
    if (da?.variant_name === "Some") {
      const secs = Number(da?.fields?.[0]?.value);
      // Same guard as claim_deadline: only a finite, positive epoch is a Date.
      // A garbled value must read null (unknown) rather than 1970 (long overdue),
      // because this feeds an urgency calculation.
      if (Number.isFinite(secs) && secs > 0) disputedAt = new Date(secs * 1000);
    }

    // ── PULL entitlements + payee pins, from the SAME entry (redesign §11b D).
    // Four extra fields.find() calls and ZERO extra round-trips: they are plain
    // TaskInfo struct fields sitting in the object already parsed above.
    //
    // Deliberately NOT read via the `get_entitlements` view method — that needs
    // /transaction/preview, which exists nowhere in this repo, and would ripple
    // into the ingestion, watcher and UI chunks for no gain over reading state
    // that is already in hand.
    const ENTITLEMENT_FIELDS = [
      "worker_entitled",
      "poster_entitled",
      "worker_bond_entitled",
      "poster_bond_entitled",
    ] as const;
    // Presence is decided by whether the field EXISTS, not by its value — a
    // pre-pull component has no such field, and reading its absence as "0" would
    // be indistinguishable from a fully-collected task.
    const entitlementsPresent = ENTITLEMENT_FIELDS.every((name) =>
      fields.some((f: any) => f?.field_name === name),
    );
    const entitlement = (name: string): string => decimalField(fields, name) ?? "0";

    const wa = fields.find((f: any) => f?.field_name === "worker_account");
    const workerAccount =
      wa?.variant_name === "Some" && typeof wa?.fields?.[0]?.value === "string"
        ? wa.fields[0].value
        : null;

    const posterRaw = fields.find((f: any) => f?.field_name === "poster")?.value;
    const posterAccount = typeof posterRaw === "string" ? posterRaw : null;

    const cb = fields.find((f: any) => f?.field_name === "claimer_badge_id");
    const claimerBadgeId =
      cb?.variant_name === "Some" && typeof cb?.fields?.[0]?.value === "string"
        ? cb.fields[0].value
        : null;

    // Bool comes through programmatic_json as the literal `true`/`false`, but
    // SBOR bools have also been seen serialised as the STRINGS "true"/"false"
    // depending on the encoder — accept both and treat everything else as
    // false, so an unexpected shape can never read as "agent" and send the
    // worker's withdrawal at a resource the component will reject.
    const ciaRaw = fields.find((f: any) => f?.field_name === "claimer_is_agent")?.value;
    const claimerIsAgent = ciaRaw === true || ciaRaw === "true";

    return {
      state: stateVariant as OnChainTaskState,
      claimDeadline,
      reviewDeadline,
      disputeRaisedBy,
      disputedAt,
      entitlements: {
        workerReward: entitlement("worker_entitled"),
        posterReward: entitlement("poster_entitled"),
        workerBond: entitlement("worker_bond_entitled"),
        posterBond: entitlement("poster_bond_entitled"),
      },
      entitlementsPresent,
      workerAccount,
      posterAccount,
      claimerBadgeId,
      claimerIsAgent,
      // Same entry, zero extra round-trips — plain TaskInfo fields.
      rewardAmount: decimalField(fields, "reward_amount"),
      rewardToken: resourceAddressField(fields, "reward_token"),
    };
  } catch {
    return null;
  }
}

/**
 * What one party is still owed, PER LANE — never as one number.
 *
 * ⚠️ This function used to return `reward + bond` as a single decimal string,
 * and both callers labelled that total "XRD". The blueprint splits these into
 * two separate view methods for precisely that reason (`lib.rs`,
 * `get_entitlements` / `get_bond_entitlements`):
 *
 *   "A separate view rather than a wider tuple on purpose: each of these returns
 *    exactly one resource, so no caller can add two of them together. Summing
 *    across resources is the arithmetic that produced this whole class of bug."
 *
 * The reward lane is denominated in the TASK'S REWARD TOKEN; the bond lane is
 * always XRD. They are only interchangeable because this app currently pins the
 * reward token to XRD — and `add_accepted_token` exists on the component, so
 * that is a live assumption, not a law. Returning a pair makes the addition
 * unrepresentable rather than merely discouraged, which is the same move the
 * blueprint made.
 *
 * ⚠️ Returns null — NOT a zero pair — when the component carries no entitlement
 * fields. A caller that alerts on "> 0" would otherwise be permanently silent
 * against a pre-pull component and read as healthy. Null forces the
 * caller to decide what "cannot say" means for it.
 */
export interface PartyOutstanding {
  /** REWARD lane — the task's reward token, which is not guaranteed to be XRD. */
  reward: string;
  /** BOND lane — always XRD; the claim bond is XRD by blueprint assertion. */
  bondXrd: string;
}

export function outstandingForParty(
  info: OnChainTaskInfo,
  party: "worker" | "poster",
): PartyOutstanding | null {
  if (!info.entitlementsPresent) return null;
  return party === "worker"
    ? { reward: info.entitlements.workerReward, bondXrd: info.entitlements.workerBond }
    : { reward: info.entitlements.posterReward, bondXrd: info.entitlements.posterBond };
}

/** The live on-chain claim facts the reconciler needs to heal a lost claim. */
export interface OnChainClaimInfo {
  /** Current TaskState variant, or null if the task entry is absent/unparseable. */
  state: OnChainTaskState | null;
  /**
   * The worker's payout account (TaskState.worker_account) — the SOLE assignee
   * source when healing a claim. `Some` in every worker-retaining state —
   * Claimed, Submitted, Disputed, Released, and a dispute-loss Refunded — i.e.
   * whenever there is a worker the escrow pays / paid / would pay; the
   * blueprint clears it to `None` ONLY in `expire_claim`, which reopens the
   * task. (`cancel_task_by_poster_after_claim` used to clear it too; under PULL
   * it deliberately keeps it as the payee of the worker's credited bond, and
   * the task is terminal.) So it can never name the wrong worker. null here on an absent / None / non-`account_`
   * shape.
   */
  workerAccount: string | null;
  /**
   * The LIVE claim receipt's local id (TaskState.current_claim_receipt_id) —
   * `Some` iff a claim is currently active (set at claim; cleared on submit /
   * expire / cancel-after-claim). The user-actor claim confirm requires the
   * caller to hold exactly this NFT: expire_claim does NOT burn the previous
   * worker's receipt, so matching a receipt on task_id alone would accept the
   * orphan from an expired claim. null on absent / None / unparseable.
   */
  currentClaimReceiptId: number | null;
}

/**
 * Read a task's live claim facts (state + worker_account) from the escrow
 * component's `tasks` KV store — the reconciler's claim-heal source.
 *
 * Unlike the fail-OPEN readers above, this THROWS on a Gateway TRANSPORT failure
 * (KV-store address unresolvable, or a non-2xx data response). The reconciler
 * relies on that: a transient read must abort the run so the keeper cron HOLDS
 * its cursor and retries — NOT silently resolve to null and let the cursor
 * advance past an unhealed claim (which would forfeit the auto-heal forever). A
 * 2xx with an absent/None entry is a real data condition (unknown task on this
 * component, or a cleared claim) and returns nulls, never a throw.
 */
export async function readOnChainClaimInfo(
  onChainTaskId: number,
  escrowComponent: string,
): Promise<OnChainClaimInfo> {
  const kvStore = await resolveTasksKvStore(escrowComponent);
  if (!kvStore) {
    throw new Error(
      `readOnChainClaimInfo: could not resolve tasks KV store for ${escrowComponent}`,
    );
  }
  const resp = await fetch(`${GATEWAY}/state/key-value-store/data`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key_value_store_address: kvStore,
      keys: [{ key_json: { kind: "U64", value: String(onChainTaskId) } }],
    }),
    signal: AbortSignal.timeout(GATEWAY_READ_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(
      `readOnChainClaimInfo: Gateway /state/key-value-store/data HTTP ${resp.status}`,
    );
  }
  const json = await resp.json();
  const fields = json?.entries?.[0]?.value?.programmatic_json?.fields;
  if (!Array.isArray(fields)) {
    return { state: null, workerAccount: null, currentClaimReceiptId: null };
  }
  const stateVariant = fields.find((f: any) => f?.field_name === "state")?.variant_name;
  const state =
    typeof stateVariant === "string" && ON_CHAIN_TASK_STATES.has(stateVariant)
      ? (stateVariant as OnChainTaskState)
      : null;
  // Option<ComponentAddress>: Some carries the account Reference in fields[0].
  const wa = fields.find((f: any) => f?.field_name === "worker_account");
  const addr = wa?.variant_name === "Some" ? wa?.fields?.[0]?.value : null;
  const workerAccount =
    typeof addr === "string" && addr.startsWith("account_") ? addr : null;
  // Option<u64>: Some carries the receipt local id as a U64 value string.
  const cr = fields.find((f: any) => f?.field_name === "current_claim_receipt_id");
  let currentClaimReceiptId: number | null = null;
  if (cr?.variant_name === "Some") {
    const n = Number(cr?.fields?.[0]?.value);
    if (Number.isInteger(n) && n >= 0) currentClaimReceiptId = n;
  }
  return { state, workerAccount, currentClaimReceiptId };
}

/**
 * Whether `account` currently holds the claim-receipt NFT with local id
 * `receiptId`, across all of that resource's vaults. A pure holding check —
 * the caller pairs it with the task's live `current_claim_receipt_id`
 * (readOnChainClaimInfo) to prove ACTIVE claimership: receipt local ids are
 * minted from a component-global counter and never reused, so resource +
 * local id uniquely identify the live receipt. Returns false on an unreadable
 * account (fail closed — same posture as findClaimReceiptId).
 */
export async function holdsClaimReceipt(
  account: string,
  claimReceiptResource: string,
  receiptId: number,
): Promise<boolean> {
  const data = await fetchEntityDetails(account);
  const nfRes = data?.items?.[0]?.non_fungible_resources?.items?.find(
    (r: any) => r.resource_address === claimReceiptResource,
  );
  const vaults: any[] = nfRes?.vaults?.items ?? [];
  return vaults.some((v: any) => (v?.items ?? []).includes(`#${receiptId}#`));
}

/**
 * Find the worker's Claim Receipt local id (the u64 submit_task needs) for a
 * given on-chain task, matched on the receipt's ClaimReceiptData.task_id.
 * Used client-side by the submit flow ONLY. It is NOT an authz source: a
 * task_id match can hit an ORPHAN receipt from an expired claim (expire_claim
 * resets current_claim_receipt_id without burning the old NFT), so the
 * claim-confirm authz instead reads the live current_claim_receipt_id and
 * checks holdsClaimReceipt on exactly that id. (For the submit flow the
 * on-chain `current_claim_receipt_id == receipt_id` assert is the final gate —
 * a stale pick costs one reverted tx, never a wrong submit.)
 */
export async function findClaimReceiptId(
  account: string,
  claimReceiptResource: string,
  onChainTaskId: number,
): Promise<number | null> {
  const data = await fetchEntityDetails(account);
  const nfRes = data?.items?.[0]?.non_fungible_resources?.items?.find(
    (r: any) => r.resource_address === claimReceiptResource,
  );
  const nfIds: string[] = nfRes?.vaults?.items?.[0]?.items ?? [];
  for (const nfId of nfIds) {
    const nftData = await fetchNftData(claimReceiptResource, [nfId]);
    const fields = nftData?.non_fungible_ids?.[0]?.data?.programmatic_json?.fields ?? [];
    const tid = fields.find((f: any) => f?.field_name === "task_id")?.value;
    if (tid !== undefined && Number(tid) === onChainTaskId) {
      const m = String(nfId).match(/#(\d+)#/);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

export async function lookupAllBadges(address: string): Promise<BadgeInfo[]> {
  try {
    const data = await fetchEntityDetails(address);
    if (!data) return [];

    const nfResources = data.items?.[0]?.non_fungible_resources?.items || [];
    const badges: BadgeInfo[] = [];

    for (const [, schema] of Object.entries(SCHEMAS)) {
      const res = nfResources.find(
        (r: any) => r.resource_address === schema.badge
      );
      if (!res) continue;

      const nfIds = res.vaults?.items?.[0]?.items || [];
      for (const nfId of nfIds) {
        const nftData = await fetchNftData(schema.badge, [nfId]);
        if (!nftData) continue;

        const nft = nftData.non_fungible_ids?.[0];
        if (!nft?.data?.programmatic_json?.fields) continue;

        badges.push(parseBadgeFields(nfId, nft.data.programmatic_json.fields));
      }
    }

    return badges;
  } catch (e) {
    console.error("Badge lookup error:", e);
    return [];
  }
}

// ── x402 payment settlement (non-sponsored) ──────────────────────────────────
//
// Track 1 facilitator support (see src/lib/x402/). Submits a client-signed,
// notarized payment TX and reads the committed receipt's fungible balance
// changes so the facilitator can assert the exact deposit landed at payTo.
//
// Why submit-then-assert rather than preview-then-submit: /transaction/preview
// does not exist in this repo (see the note on readEscrowTaskInfo), and in
// NON-SPONSORED mode the CLIENT pays the gas — there is no facilitator fee
// liability, so optimistic submit is safe. The committed receipt is the proof.
// Sponsored mode (facilitator pays gas) is Track 2 and MUST preview first.

export interface FungibleBalanceChange {
  entity: string;
  resource: string;
  change: string; // human decimal string, e.g. "-0.05" / "100"
}

/** Submit a notarized transaction hex. Returns true on 2xx (accepted, incl.
 *  duplicate), false on rejection/transport error. */
export async function submitNotarizedTransaction(notarizedHex: string): Promise<boolean> {
  try {
    const resp = await fetch(`${GATEWAY}/transaction/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notarized_transaction_hex: notarizedHex }),
      signal: AbortSignal.timeout(GATEWAY_SUBMIT_TIMEOUT_MS),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export interface NonFungibleBalanceChange {
  entity: string;
  resource: string;
  added: string[];
  removed: string[];
}

/** Read a committed tx's status + fungible balance changes. null on transport
 *  failure or non-2xx; `status` is "Pending" until the ledger commits it. */
export async function fetchTxFungibleChanges(
  intentHash: string,
): Promise<{ status: string; changes: FungibleBalanceChange[] } | null> {
  const all = await fetchTxBalanceChanges(intentHash);
  return all && { status: all.status, changes: all.fungible };
}

/**
 * The Gateway's `intent_status` for a transaction: "CommittedSuccess",
 * "CommittedFailure", "Pending", "CommitPendingOutcomeUnknown",
 * "PermanentlyRejected", "LikelyButNotCertainRejection" or "Unknown" (never
 * seen). Lets a caller tell "not landed yet" from "failed" from "the Gateway is
 * down" (null) — committed-details alone answers all three with a non-2xx.
 */
export async function readTxIntentStatus(intentHash: string): Promise<string | null> {
  try {
    const resp = await fetch(`${GATEWAY}/transaction/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent_hash: intentHash }),
      signal: AbortSignal.timeout(GATEWAY_READ_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    return typeof json?.intent_status === "string" ? json.intent_status : null;
  } catch {
    return null;
  }
}

/**
 * A committed tx's status + BOTH kinds of balance change — fungible (XRD moved)
 * and non-fungible (which local ids landed where). The non-fungible half is
 * what proves a badge mint reached a given account; the shape
 * (`non_fungible_balance_changes: [{entity_address, resource_address, added,
 * removed}]`) was read off real Member-badge mints on mainnet 2026-09-24.
 * null on transport failure or non-2xx.
 */
export async function fetchTxBalanceChanges(
  intentHash: string,
): Promise<{ status: string; fungible: FungibleBalanceChange[]; nonFungible: NonFungibleBalanceChange[] } | null> {
  try {
    const resp = await fetch(`${GATEWAY}/transaction/committed-details`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent_hash: intentHash, opt_ins: { balance_changes: true } }),
      signal: AbortSignal.timeout(GATEWAY_READ_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const status = json?.transaction?.transaction_status ?? "Unknown";
    const changes = json?.transaction?.balance_changes;
    const rawF = changes?.fungible_balance_changes ?? [];
    const fungible: FungibleBalanceChange[] = (Array.isArray(rawF) ? rawF : []).map((c: any) => ({
      entity: c?.entity_address,
      resource: c?.resource_address,
      change: String(c?.balance_change),
    }));
    const rawN = changes?.non_fungible_balance_changes ?? [];
    const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const nonFungible: NonFungibleBalanceChange[] = (Array.isArray(rawN) ? rawN : []).map((c: any) => ({
      entity: c?.entity_address,
      resource: c?.resource_address,
      added: ids(c?.added),
      removed: ids(c?.removed),
    }));
    return { status, fungible, nonFungible };
  } catch {
    return null;
  }
}

/**
 * Where one non-fungible is now. `/state/non-fungible/location` OMITS an id
 * that was never minted (verified 2026-09-24 with a probe id), so absence is a
 * confirmed "not minted"; a present id reports its owning vault's global
 * ancestor — the account that holds it. null when the Gateway could not be
 * asked: callers fail closed.
 */
export async function readNonFungibleHolder(
  resourceAddress: string,
  localId: string,
): Promise<{ minted: false } | { minted: true; burned: boolean; holder: string | null } | null> {
  try {
    const resp = await fetch(`${GATEWAY}/state/non-fungible/location`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource_address: resourceAddress, non_fungible_ids: [localId] }),
      signal: AbortSignal.timeout(GATEWAY_READ_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const items = json?.non_fungible_ids;
    if (!Array.isArray(items)) return null;
    const item = items.find((i: any) => i?.non_fungible_id === localId);
    if (!item) return { minted: false };
    const holder = item.owning_vault_global_ancestor_address;
    return { minted: true, burned: item.is_burned === true, holder: typeof holder === "string" ? holder : null };
  } catch {
    return null;
  }
}

/**
 * An account's exact total of one fungible, summed across its vaults as an
 * 18-dp decimal string (never a JS number). `complete: false` when the vault
 * list continues on a later page — the total is then a lower bound. null when
 * the Gateway could not be asked or an amount was not a decimal.
 */
export async function readFungibleVaultTotal(
  address: string,
  resourceAddress: string,
): Promise<{ total: string; complete: boolean } | null> {
  try {
    const resp = await fetch(`${GATEWAY}/state/entity/page/fungible-vaults/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, resource_address: resourceAddress }),
      signal: AbortSignal.timeout(GATEWAY_READ_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data?.items)) return null;
    const total: string = data.items.reduce(
      (sum: string, vault: { amount?: unknown }) => addXrd(sum, String(vault?.amount)),
      "0",
    );
    return { total, complete: !data.next_cursor };
  } catch (e) {
    console.error("Fungible vault read error:", e);
    return null;
  }
}

// ── Wave B claim-bond reads (ported from packages/agent-client, 2026-09-02) ───
//
// 🔴 WHY THESE EXIST. The web claim path built its manifest from the constant
// `ESCROW_CLAIM_BOND_XRD` (the floor, XRD, default 76.45) because the pre-Wave-B
// component carried a flat `claim_bond_xrd` field. Wave B DELETES that field:
// the bond is `clamp(reward * pct, floor, cap)` denominated in the task's own
// `reward_token`. A constant cannot express that, and the ceremony would have
// made every claim from the site revert on `claim_bond amount does not match
// required` — failing safe, but with the product unable to take a claim.
//
// The amount must therefore be DERIVED from live chain state at claim time.
// There is deliberately no fallback constant and no override: a guessed bond is
// either a reverted transaction (too small) or real money bonded on an
// unverified number (too large). Every reader below returns null rather than a
// default, and the caller fails closed.

/** `claim_bond_pct/floor/cap` off the component. Null if the component predates
 *  Wave B (the fields do not exist) or the Gateway is unreadable. */
export async function readClaimBondParams(
  escrowComponent: string,
): Promise<{ pct: string; floor: string; cap: string } | null> {
  try {
    const resp = await fetch(`${GATEWAY}/state/entity/details`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addresses: [escrowComponent] }),
      signal: AbortSignal.timeout(GATEWAY_READ_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      items?: { details?: { state?: { fields?: { field_name?: string; value?: string }[] } } }[];
    };
    const fields = json?.items?.[0]?.details?.state?.fields;
    if (!Array.isArray(fields)) return null;
    const decimal = (name: string): string | null => {
      const v = fields.find((f) => f?.field_name === name)?.value;
      return typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? v : null;
    };
    const pct = decimal("claim_bond_pct");
    const floor = decimal("claim_bond_floor");
    const cap = decimal("claim_bond_cap");
    if (pct === null || floor === null || cap === null) return null;
    return { pct, floor, cap };
  } catch {
    return null;
  }
}

/** A task's `reward_token` + `reward_amount` — the basis the bond is a share of. */
export async function readTaskRewardInfo(
  onChainTaskId: number,
  escrowComponent: string,
): Promise<{ rewardToken: string; rewardAmount: string } | null> {
  const kvStore = await resolveTasksKvStore(escrowComponent);
  if (!kvStore) return null;
  try {
    const resp = await fetch(`${GATEWAY}/state/key-value-store/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key_value_store_address: kvStore,
        keys: [{ key_json: { kind: "U64", value: String(onChainTaskId) } }],
      }),
      signal: AbortSignal.timeout(GATEWAY_READ_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      entries?: {
        value?: { programmatic_json?: { fields?: { field_name?: string; kind?: string; value?: string }[] } };
      }[];
    };
    const fields = json?.entries?.[0]?.value?.programmatic_json?.fields;
    if (!Array.isArray(fields)) return null;
    const tokenField = fields.find((f) => f?.field_name === "reward_token");
    if (!tokenField || tokenField.kind !== "Reference" || typeof tokenField.value !== "string") {
      return null;
    }
    // Same anchored shape as manifests.ts's validateAddress — belt and braces
    // against an odd/hostile value flowing into a later Address(...) literal.
    if (!/^resource_rdx[a-z0-9]{20,}$/.test(tokenField.value)) return null;
    const amountValue = fields.find((f) => f?.field_name === "reward_amount")?.value;
    if (typeof amountValue !== "string" || !/^\d+(\.\d+)?$/.test(amountValue)) return null;
    return { rewardToken: tokenField.value, rewardAmount: amountValue };
  } catch {
    return null;
  }
}

const divisibilityCache = new Map<string, number>();

/** A fungible resource's divisibility, so the bond can be rounded to something
 *  the ledger will actually accept. Cached: it is immutable per resource. */
export async function readTokenDivisibility(resourceAddress: string): Promise<number | null> {
  const cached = divisibilityCache.get(resourceAddress);
  if (cached !== undefined) return cached;
  try {
    const resp = await fetch(`${GATEWAY}/state/entity/details`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addresses: [resourceAddress] }),
      signal: AbortSignal.timeout(GATEWAY_READ_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      items?: { details?: { type?: string; divisibility?: number } }[];
    };
    const details = json?.items?.[0]?.details;
    if (!details || details.type !== "FungibleResource") return null;
    const d = details.divisibility;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 18) return null;
    divisibilityCache.set(resourceAddress, d);
    return d;
  } catch {
    return null;
  }
}

// ── XRD posting-freeze read (W3) ─────────────────────────────────────────────
// `create_task` asserts the reward token's AcceptedTokenConfig.frozen is false
// (escrow lib.rs `freeze_token`/`unfreeze_token`), so while XRD is frozen every
// new-task funding tx reverts at the wallet. The UI reads this flag LIVE so the
// swap-ceremony unfreeze needs no app deploy — never hardcode it.

/**
 * POST a Gateway state read; if the plain (unpinned) attempt fails — non-ok
 * response or a thrown/aborted fetch — retry it ONCE pinned at the last-known
 * ledger tip's `state_version`. During a network halt the Gateway answers an
 * unpinned read with a staleness 500 but answers the identical read pinned
 * (see `readLedgerTip`'s docstring for why last-known-tip is the safe value
 * to pin at). The retry is skipped — not attempted — when no tip has ever
 * been read successfully (cold start during an outage), since there is then
 * nothing correct to pin to.
 *
 * Returns the parsed JSON body of whichever attempt succeeded, or `null` if
 * both failed. Callers keep their own shape/field validation on the result —
 * this only decides whether a second, pinned attempt is worth making.
 */
async function postGatewayPinnedOnHalt(
  path: string,
  body: Record<string, unknown>,
): Promise<{ json: any } | null> {
  const post = async (b: Record<string, unknown>): Promise<{ json: any } | null> => {
    try {
      const resp = await fetch(`${GATEWAY}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(b),
        signal: AbortSignal.timeout(GATEWAY_READ_TIMEOUT_MS),
      });
      if (!resp.ok) return null;
      return { json: await resp.json() };
    } catch {
      return null;
    }
  };

  const first = await post(body);
  if (first) return first;

  const tip = await readLedgerTip();
  if (!tip) return null;

  return post({ ...body, at_ledger_state: { state_version: tip.stateVersion } });
}

/** Per-component cache of the `accepted_tokens` KeyValueStore address — an
 *  immutable field of the instantiated component state, same contract as
 *  tasksKvStoreCache above. */
const acceptedTokensKvStoreCache = new Map<string, string>();

async function resolveAcceptedTokensKvStore(
  escrowComponent: string,
): Promise<string | null> {
  const cached = acceptedTokensKvStoreCache.get(escrowComponent);
  if (cached) return cached;
  const result = await postGatewayPinnedOnHalt("/state/entity/details", {
    addresses: [escrowComponent],
  });
  if (!result) return null;
  const fields = result.json?.items?.[0]?.details?.state?.fields;
  if (!Array.isArray(fields)) return null;
  const addr = fields.find((f: any) => f?.field_name === "accepted_tokens")?.value;
  if (typeof addr !== "string" || !addr.startsWith("internal_keyvaluestore_")) {
    return null;
  }
  acceptedTokensKvStoreCache.set(escrowComponent, addr);
  return addr;
}

/** How long a definitive frozen/unfrozen answer is served without re-reading
 *  the chain. Short on purpose: the unfreeze at the swap ceremony must show up
 *  within a minute, not a deploy. */
export const POSTING_FROZEN_CACHE_MS = 30_000;

const postingFrozenCache = new Map<string, { frozen: boolean; readAt: number }>();

/** Test-only: the module-level cache would otherwise leak state across cases. */
export function __resetPostingFrozenCacheForTests() {
  postingFrozenCache.clear();
  acceptedTokensKvStoreCache.clear();
}

/**
 * Whether XRD posting is frozen on the escrow — the `frozen` bool of the
 * component's `accepted_tokens` KVS entry for XRD.
 *
 * Returns `null` for UNKNOWN (Gateway hiccup, unexpected shape, or no XRD
 * entry at all). Callers fail OPEN on null — render the normal affordance and
 * let the on-chain assert stay the backstop — because a transient read failure
 * must not fabricate a "posting is paused" notice sitewide. Only definitive
 * booleans are cached; unknowns retry on the next call.
 *
 * BOTH Gateway reads this makes (the `accepted_tokens` KVS-address lookup in
 * `resolveAcceptedTokensKvStore`, and the KVS entry read here) go through
 * `postGatewayPinnedOnHalt`: unpinned first (normal operation, unchanged),
 * and if that fails, ONE retry pinned at `readLedgerTip()`'s last-known
 * state_version. This exists because the Gateway rejects an unpinned read
 * with a staleness 500 while the network is halted, but answers the same
 * read once it is pinned — measured directly against mainnet during the
 * 2026-08-31 halt (unpinned: 500; pinned at 557840622: `{"frozen":true,...}`).
 * Without the retry, a halt makes this permanently UNKNOWN — not "frozen",
 * which is at least a determinable, correct answer the Gateway is willing to
 * give. The null-fails-open contract above is unchanged for reads that stay
 * genuinely unanswerable (no tip ever cached, or the pinned retry also fails).
 */
export async function readXrdPostingFrozen(
  escrowComponent: string,
): Promise<boolean | null> {
  const cached = postingFrozenCache.get(escrowComponent);
  if (cached && Date.now() - cached.readAt < POSTING_FROZEN_CACHE_MS) {
    return cached.frozen;
  }
  const kvStore = await resolveAcceptedTokensKvStore(escrowComponent);
  if (!kvStore) return null;
  const result = await postGatewayPinnedOnHalt("/state/key-value-store/data", {
    key_value_store_address: kvStore,
    keys: [{ key_json: { kind: "Reference", value: XRD_ADDRESS } }],
  });
  if (!result) return null;
  const fields = result.json?.entries?.[0]?.value?.programmatic_json?.fields;
  if (!Array.isArray(fields)) return null;
  const frozenField = fields.find((f: any) => f?.field_name === "frozen");
  if (typeof frozenField?.value !== "boolean") return null;
  postingFrozenCache.set(escrowComponent, {
    frozen: frozenField.value,
    readAt: Date.now(),
  });
  return frozenField.value;
}

// ── Network halt detection (runtime, not build-time) ──────────────────────────
//
// WHY THIS IS NOT A BUILD FLAG. `NEXT_PUBLIC_FEATURE_*` values are baked at
// build time; flipping one needs `npm run build` + launch-check + `pm2 restart`.
// That is the right shape for a permanent fuse and the WRONG shape for an
// emergency switch — in an incident the deploy chain is exactly what you cannot
// assume is healthy. So this is read per request.
//
// WHAT IT DETECTS. The mainnet Gateway reports the ledger tip it has seen. A
// running network advances that tip every few seconds; a HALTED one freezes it
// (2026-08-31: state_version 557840622, proposer_round_timestamp 21:19:06Z, and
// it did not move for hours). So tip AGE is the signal, not an error rate —
// which is the point: "the network is stopped" and "our Gateway call failed"
// are different facts and must not collapse into one.

/** Tip older than this ⇒ treat the network as halted. Mainnet rounds land in
 *  seconds and epochs turn over in minutes, so ten minutes is far outside
 *  normal jitter while still catching a halt in the same coffee break. */
export const NETWORK_HALT_AFTER_SECONDS = Number(
  process.env.GUILD_HALT_AFTER_SECONDS ?? 600,
);

/** Server-side cache TTL for the tip read. Bursts of page loads must not fan
 *  out to the Gateway; ten seconds keeps the banner near-live regardless. */
export const LEDGER_TIP_CACHE_MS = 10_000;

/** Wall-clock bound on the tip probe.
 *
 * ⚠️ RETIRED as an independent value 2026-09-02, when the halt detector (#476)
 * and the fetch-timeout sweep (#482) met on main. It had been declared
 * separately as 15_000 — the same number as GATEWAY_READ_TIMEOUT_MS, for the
 * same reason, in the same file. Two constants holding one value is precisely
 * how they drift: someone tunes the read bound, the probe silently keeps the
 * old one, and nothing goes red.
 *
 * The tip probe is a read; it takes the read bound. The alias remains so the
 * name still resolves and reads as deliberate rather than deleted — prefer
 * GATEWAY_READ_TIMEOUT_MS at any new call site. */
export const GATEWAY_PROBE_TIMEOUT_MS = GATEWAY_READ_TIMEOUT_MS;

export interface LedgerTip {
  stateVersion: number;
  /** Consensus timestamp of the tip round, ISO-8601. */
  tipIso: string;
  /** Seconds between the tip timestamp and the moment of the read. */
  ageSeconds: number;
  /** True when this is a remembered value served because the live read failed. */
  stale: boolean;
}

let ledgerTipCache: { tip: LedgerTip; readAt: number } | null = null;

/** Test-only: the module-level cache would otherwise leak state across cases. */
export function __resetLedgerTipCacheForTests() {
  ledgerTipCache = null;
}

/**
 * Read the Gateway's ledger tip.
 *
 * READ-FAILURE BEHAVIOUR IS DELIBERATE AND IS THE HARD PART. Three options were
 * available and two of them are wrong:
 *
 *   • fail CLOSED (unknown ⇒ halted) — any Gateway hiccup darkens the site with
 *     a "the network is stopped" claim that is not true. The banner would cry
 *     wolf and then be ignored, or removed.
 *   • fail OPEN (unknown ⇒ running) — a halt is silently missed for exactly as
 *     long as the Gateway is also unreachable, which is precisely when a halt
 *     is most likely.
 *   • LAST-KNOWN VALUE — keep serving the last successful read, marked `stale`.
 *
 * Last-known is the only safe default: it neither invents a halt nor forgets
 * one. With no successful read ever (cold start during an outage) it returns
 * null, and callers fail OPEN on null — the same posture `readXrdPostingFrozen`
 * takes, for the same reason: a first-load hiccup must not fabricate a
 * sitewide incident notice.
 *
 * Note the age of a STALE tip keeps growing with wall-clock time, which is
 * correct — if we cannot reach the Gateway and the last tip we saw is now an
 * hour old, "something is wrong" is the honest reading either way.
 */
export async function readLedgerTip(): Promise<LedgerTip | null> {
  const now = Date.now();
  if (ledgerTipCache && now - ledgerTipCache.readAt < LEDGER_TIP_CACHE_MS) {
    return ledgerTipCache.tip;
  }
  try {
    const resp = await fetch(`${GATEWAY}/status/gateway-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      // A HUNG connection never settles, so the try/catch below never runs and
      // the last-known fallback never fires — the detector would sit waiting
      // instead of reporting a halt. That is precisely backwards for a probe
      // whose whole job is behaving well when the Gateway is sick, and this
      // one is on a per-request web path, so a hang ties up a request handler
      // rather than a background job. Bounded so a stuck socket degrades to
      // exactly the failure this function already handles well.
      signal: AbortSignal.timeout(GATEWAY_READ_TIMEOUT_MS),
    });
    if (!resp.ok) return staleLedgerTip(now);
    const json = await resp.json();
    const ledger = json?.ledger_state;
    const stateVersion = ledger?.state_version;
    const tipIso = ledger?.proposer_round_timestamp;
    if (typeof stateVersion !== "number" || typeof tipIso !== "string") {
      return staleLedgerTip(now);
    }
    const tipMs = Date.parse(tipIso);
    if (Number.isNaN(tipMs)) return staleLedgerTip(now);
    const tip: LedgerTip = {
      stateVersion,
      tipIso,
      ageSeconds: Math.max(0, Math.round((now - tipMs) / 1000)),
      stale: false,
    };
    ledgerTipCache = { tip, readAt: now };
    return tip;
  } catch {
    return staleLedgerTip(now);
  }
}

/** Re-serve the last good tip with its age recomputed against now. Returns null
 *  when nothing has ever been read successfully. */
function staleLedgerTip(now: number): LedgerTip | null {
  if (!ledgerTipCache) return null;
  const tipMs = Date.parse(ledgerTipCache.tip.tipIso);
  return {
    ...ledgerTipCache.tip,
    ageSeconds: Math.max(0, Math.round((now - tipMs) / 1000)),
    stale: true,
  };
}

/** Whether the operator has pulled the manual lever, independent of the chain.
 *  Read per request so it takes effect without a rebuild — that is the whole
 *  point of it not being a NEXT_PUBLIC_ flag. */
export function operatorHaltEngaged(): boolean {
  const raw = process.env.GUILD_HALT;
  return raw === "1" || raw === "true";
}
