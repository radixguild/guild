const GATEWAY = process.env.RADIX_GATEWAY || "https://mainnet.radixdlt.com";
const BADGE_NFT = process.env.BADGE_NFT || "resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl";
// One env name per component. ESCROW_COMPONENT means ONE thing in this bot: the
// live component escrow-watcher.js watches (default Wave B). Until 2026-10-01
// this file and tx-signer.js ALSO read ESCROW_COMPONENT, defaulting it to the
// retired V1 escrow — so setting it for the watcher, as the watcher's own
// startup warning asks, silently repointed these V1 readers at the live PULL
// component. The retired V1 now has its own name.
const ESCROW_V1_COMPONENT = process.env.ESCROW_V1_COMPONENT || "component_rdx1cp8mwwe2pkrrtm05p7txgygf9y9uuwx6p87djkda8stk8nuwpyg56r";
const ESCROW_V3_COMPONENT = process.env.ESCROW_V3_COMPONENT || "component_rdx1czcjn322rhzvu4gwkculx6qvguv2erqu38mschwqkjyqtdpvpcex9s";
// The live guild-saas PULL escrow — the address escrow-watcher.js watches via
// ESCROW_COMPONENT; this file reads it as ESCROW_PULL_COMPONENT. Updated
// 2026-09-13 for the Wave B cutover; the prior component (…akd82f) was retired
// in place that day.
const ESCROW_PULL_COMPONENT = process.env.ESCROW_PULL_COMPONENT || "component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly";
const ESCROW_VERSION = process.env.ESCROW_VERSION || "v2"; // "v2" or "v3"
const XRD_RESOURCE = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd";

// Hard ceiling on every Gateway call. Without this, a slow/hung Gateway during a
// traffic burst serializes behind the single-threaded long-poller and can wedge
// the whole bot. AbortController turns "slow" into a fast, catchable failure.
const GATEWAY_TIMEOUT_MS = parseInt(process.env.GATEWAY_TIMEOUT_MS) || 5000;

/**
 * 🔴 `signal: ctrl.signal` used to sit AFTER `...opts`, which silently threw
 * away any AbortSignal the caller passed. That was not cosmetic: the escrow
 * watcher built a 30-second controller for its /stream/transactions page
 * fetch, passed it in, and got the 5-second default instead — so a perfectly
 * healthy but slow paged read aborted at 5s, raised "fetch error: This
 * operation was aborted", and cleared on the next poll. Half the 2026-09-17
 * flap pairs came from here.
 *
 * Now: a caller's signal is COMBINED with the timeout rather than dropped
 * (either one aborts), and a caller that genuinely needs a longer ceiling
 * says so with `timeoutMs` instead of building its own controller.
 *
 * @param {string} url
 * @param {RequestInit & {timeoutMs?: number}} opts
 */
async function fetchWithTimeout(url, opts = {}) {
  const { timeoutMs, signal: callerSignal, ...rest } = opts;
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : GATEWAY_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  // AbortSignal.any is Node >= 20; the box runs 22. Fall back to the timeout
  // alone rather than throwing on an older runtime — dropping a caller signal
  // is what this fix is about, but crashing the bot over it would be worse.
  const signal = callerSignal && typeof AbortSignal.any === "function"
    ? AbortSignal.any([ctrl.signal, callerSignal])
    : ctrl.signal;
  try {
    return await fetch(url, { ...rest, signal });
  } finally {
    clearTimeout(timer);
  }
}

// Like fetchWithTimeout but the abort window ALSO covers reading the response
// body. fetchWithTimeout alone disarms its timer as soon as headers arrive, so
// a Gateway that stalls mid-body could still hang a caller for minutes; here
// the timer stays live until the body is fully read.
//
// Takes the same `timeoutMs` / caller-`signal` options as fetchWithTimeout.
// On a non-2xx the (bounded) body text comes back as `text`, so a caller can
// report what the Gateway said without doing its own unbounded read.
async function fetchJsonWithTimeout(url, opts = {}) {
  const { timeoutMs, signal: callerSignal, ...rest } = opts;
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : GATEWAY_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const signal = callerSignal && typeof AbortSignal.any === "function"
    ? AbortSignal.any([ctrl.signal, callerSignal])
    : ctrl.signal;
  try {
    const resp = await fetch(url, { ...rest, signal });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, status: resp.status, body: null, text };
    }
    const body = await resp.json(); // timer still armed — a stalled body aborts too
    return { ok: true, status: resp.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Reject if `promise` has not settled within `ms`. For reads a signal can't reach. */
function withDeadline(promise, ms, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Short-lived badge cache. The hottest path (badge gate on every vote/command)
// re-queries the same wallets repeatedly during a burst; a small TTL collapses
// that to one Gateway round-trip per wallet per window. Trade-off: a just-minted
// badge can take up to the TTL to be seen (mint already has chain propagation lag).
const BADGE_CACHE_TTL_MS = parseInt(process.env.BADGE_CACHE_TTL_MS) || 30000;
const BADGE_CACHE_MAX = parseInt(process.env.BADGE_CACHE_MAX) || 2000;
// How old a cached read may be and still stand in for a failed one. Until 2026-10-06 a
// Gateway that stayed down served the last read however old it was, so a badge moved or
// burned long before still passed the gates. Default 10 × TTL; 0 turns stale serving off.
const _staleMaxEnv = parseInt(process.env.BADGE_CACHE_STALE_MAX_MS);
const BADGE_CACHE_STALE_MAX_MS = Number.isFinite(_staleMaxEnv) && _staleMaxEnv >= 0 ? _staleMaxEnv : BADGE_CACHE_TTL_MS * 10;
const _badgeCache = new Map(); // radixAddress -> { at, data } — successful reads only

// Swallows a Gateway error as "no badge" — gates must not use it; use getBadgeResult.
async function hasBadge(radixAddress) {
  try {
    const badge = await getBadgeData(radixAddress);
    return badge !== null && badge.status === "active";
  } catch (e) {
    console.error("[Gateway] hasBadge error:", e.message);
    return false;
  }
}

async function getBadgeData(radixAddress) {
  const res = await getBadgeResult(radixAddress);
  // Degrades a failed read to null — fine for "show my badge", wrong for anything
  // that must not say "no badge" when it means "couldn't look" (use getBadgeResult).
  return res.error ? null : res.data;
}

// Same read as getBadgeData, but keeps the difference between "no badge"
// ({ data: null }) and "the Gateway didn't answer" ({ error: true }).
async function getBadgeResult(radixAddress) {
  const cached = _badgeCache.get(radixAddress);
  if (cached && Date.now() - cached.at < BADGE_CACHE_TTL_MS) return { data: cached.data };
  const res = await _getBadgeDataUncached(radixAddress);
  if (res.error) {
    // Gateway blip/timeout: never cache the failure (a cached error-null would
    // tell real badge holders "no badge" for the whole TTL). Serve a stale
    // entry while it is younger than BADGE_CACHE_STALE_MAX_MS; otherwise report
    // the error for this one call.
    if (cached && Date.now() - cached.at < BADGE_CACHE_STALE_MAX_MS) return { data: cached.data };
    return { error: true };
  }
  if (_badgeCache.size >= BADGE_CACHE_MAX) {
    // Bounded memory: keys are attacker-controllable via the public badge API,
    // so evict oldest-inserted once the cap is reached.
    _badgeCache.delete(_badgeCache.keys().next().value);
  }
  _badgeCache.set(radixAddress, { at: Date.now(), data: res.data });
  return { data: res.data };
}

// Returns { data } on a definitive read (data may be null = genuinely no badge)
// or { error: true } on any Gateway failure — the two must not be conflated.
async function _getBadgeDataUncached(radixAddress) {
  try {
    const r1 = await fetchJsonWithTimeout(`${GATEWAY}/state/entity/details`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        addresses: [radixAddress],
        aggregation_level: "Vault",
        opt_ins: { non_fungible_include_nfids: true },
      }),
    });
    if (!r1.ok) return { error: true };
    const nfResources = r1.body.items?.[0]?.non_fungible_resources?.items || [];
    const badgeRes = nfResources.find((r) => r.resource_address === BADGE_NFT);
    if (!badgeRes) return { data: null };

    const nfIds = badgeRes.vaults?.items?.[0]?.items || [];
    if (nfIds.length === 0) return { data: null };

    const r2 = await fetchJsonWithTimeout(`${GATEWAY}/state/non-fungible/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource_address: BADGE_NFT,
        non_fungible_ids: [nfIds[0]],
      }),
    });
    if (!r2.ok) return { error: true };
    const nft = r2.body.non_fungible_ids?.[0];
    if (!nft?.data?.programmatic_json?.fields) return { data: null };

    const f = nft.data.programmatic_json.fields;
    const g = (i) => f[i]?.value || f[i]?.fields?.[0]?.value || "-";

    return {
      data: {
        id: nfIds[0],
        issued_to: g(0),
        schema: g(1),
        tier: g(3),
        status: g(4),
        xp: parseInt(g(6)) || 0,
        level: g(7),
      },
    };
  } catch (e) {
    console.error("[Gateway] getBadgeData error:", e.message);
    return { error: true };
  }
}

// ── Escrow On-Chain Reads ────────────────────────────────

/**
 * Fetch raw component state fields from Gateway.
 * Shared by both V2 and V3 readers.
 */
async function fetchComponentState(component) {
  const r = await fetchJsonWithTimeout(`${GATEWAY}/state/entity/details`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      addresses: [component || ESCROW_V1_COMPONENT],
      aggregation_level: "Vault",
      opt_ins: { explicit_metadata: ["name"] },
    }),
  });
  if (!r.ok) {
    console.error("[Gateway] fetchComponentState HTTP", r.status);
    return null;
  }
  return r.body.items?.[0]?.details?.state?.fields || null;
}

/**
 * Read TaskEscrow V2 component state.
 * V2 struct layout:
 *   0: task_vaults (KVS), 1: tasks (KVS), 2: fee_vault, 3: minter_vault,
 *   4: receipt_manager, 5: badge_resource, 6: next_id, 7: fee_pct,
 *   8: min_deposit, 9: total_tasks, 10: total_completed, 11: total_cancelled,
 *   12: total_escrowed, 13: total_released
 */
function parseEscrowV2(state) {
  const g = (i) => state[i]?.value || "0";
  return {
    next_id: parseInt(g(6)) || 1,
    fee_pct: g(7),
    min_deposit: g(8),
    total_tasks: parseInt(g(9)) || 0,
    total_completed: parseInt(g(10)) || 0,
    total_cancelled: parseInt(g(11)) || 0,
    total_escrowed: g(12),
    total_released: g(13),
    version: "v2",
  };
}

/**
 * Read TaskEscrow V3 component state.
 * V3 struct layout:
 *   0: task_vaults (KVS), 1: tasks (KVS), 2: fee_vaults (KVS),
 *   3: accepted_tokens (KVS), 4: accepted_token_list (Vec),
 *   5: minter_vault, 6: receipt_manager, 7: badge_resource,
 *   8: next_id, 9: fee_pct, 10: total_tasks, 11: total_completed,
 *   12: total_cancelled
 * Note: V3 has no total_escrowed/total_released — those are returned as "N/A"
 */
function parseEscrowV3(state) {
  const g = (i) => state[i]?.value || "0";
  // accepted_token_list is a Vec at index 4 — try to read its elements
  const tokenListField = state[4];
  const tokenCount = tokenListField?.elements?.length || 0;
  return {
    next_id: parseInt(g(8)) || 1,
    fee_pct: g(9),
    min_deposit: "per-token", // V3 uses per-token minimums in accepted_tokens KVS
    total_tasks: parseInt(g(10)) || 0,
    total_completed: parseInt(g(11)) || 0,
    total_cancelled: parseInt(g(12)) || 0,
    total_escrowed: "N/A",    // V3 doesn't track aggregate — would need vault reads
    total_released: "N/A",
    accepted_token_count: tokenCount,
    version: "v3",
  };
}

/**
 * Read TaskEscrow component state. Auto-detects V2/V3 based on ESCROW_VERSION env.
 * Returns: { total_tasks, total_completed, total_cancelled, fee_pct, next_id, version, ... }
 */
async function getEscrowStats() {
  try {
    const state = await fetchComponentState(ESCROW_V1_COMPONENT);
    if (!state) return null;

    const parsed = ESCROW_VERSION === "v3" ? parseEscrowV3(state) : parseEscrowV2(state);
    return {
      ...parsed,
      component: ESCROW_V1_COMPONENT,
      source: "on-chain",
    };
  } catch (e) {
    console.error("[Gateway] getEscrowStats error:", e.message);
    return null;
  }
}

/**
 * Extract a named field from a Gateway receipt event's programmatic JSON.
 * Same contract as escrow-watcher.js field(): NEVER positional — a positional
 * read against a changed struct silently returns the WRONG field, not an error.
 * Returns the raw `.value` (string) or undefined.
 */
function field(fields, name) {
  const f = (fields || []).find((x) => x.field_name === name);
  return f ? f.value : undefined;
}

/**
 * Parse a TaskCreatedEvent's fields by escrow version.
 *
 * V1 layout: [task_id, amount, creator]                — XRD-only, positional
 * V3 layout: [task_id, amount, resource, creator]      — multi-token, positional
 * PULL (4):  parsed BY FIELD NAME (struct: task_id, poster, reward_token,
 *            reward_amount, insurance_amount, arbiter_fee_pct, work_brief_hash
 *            — guild-saas escrow lib.rs TaskCreatedEvent)
 *
 * Returns { task_id, amount, creator, resource } or null if fields can't be parsed.
 */
function parseTaskCreatedEvent(fields, version) {
  if (!Array.isArray(fields) || fields.length === 0) return null;
  if (version === 4) {
    // PULL generation — field-name lookups only; missing names → null, never
    // a positional guess.
    const task_id = parseInt(field(fields, "task_id"));
    const amount = field(fields, "reward_amount");
    const resource = field(fields, "reward_token");
    const creator = field(fields, "poster");
    if (!task_id || !amount || !resource || !creator) return null;
    return { task_id, amount, resource, creator };
  }
  if (version === 3) {
    if (fields.length < 4) return null;
    return {
      task_id: parseInt(fields[0]?.value),
      amount: fields[1]?.value || null,
      resource: fields[2]?.value || null,
      creator: fields[3]?.value || null,
    };
  }
  // V1 / V2 — XRD only, no resource field
  if (fields.length < 3) return null;
  return {
    task_id: parseInt(fields[0]?.value),
    amount: fields[1]?.value || null,
    resource: XRD_RESOURCE,
    creator: fields[2]?.value || null,
  };
}

/**
 * Verify a transaction actually deposited into a known TaskEscrow component
 * (V1, V3, or the live PULL escrow) and extract the on-chain TaskCreatedEvent
 * fields.
 *
 * Returns:
 *   success → { verified: true, event: "TaskCreated", task_id, amount, creator, resource, escrow_version, escrow_component, tx_hash }
 *   failure → { verified: false, reason }
 *
 * The caller MUST cross-check amount/creator/resource against the bounty being
 * funded — this function only confirms the TX is committed, hit a known escrow
 * component, and emitted a parseable TaskCreatedEvent.
 */
async function verifyEscrowTx(txHash, opts = {}) {
  // Allow callers (or tests) to override the gateway fetcher.
  const fetcher = opts.fetcher || fetchWithTimeout;
  try {
    const resp = await fetcher(`${GATEWAY}/transaction/committed-details`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent_hash: txHash,
        opt_ins: {
          receipt_events: true,
          affected_global_entities: true,
          balance_changes: true,
        },
      }),
    });
    if (!resp.ok) {
      console.error("[Gateway] verifyEscrowTx HTTP", resp.status);
      return { verified: false, reason: "gateway_error" };
    }
    // Bounded: fetchWithTimeout's timer is already cleared by the time headers
    // arrive, so without this a stalled body leaves the caller's funding
    // confirmation hanging forever instead of failing as "error".
    const data = await withDeadline(resp.json(), GATEWAY_TIMEOUT_MS, "committed-details body read timed out");
    const tx = data.transaction;

    if (!tx) return { verified: false, reason: "tx_not_found" };
    if (tx.transaction_status !== "CommittedSuccess") {
      return { verified: false, reason: "tx_failed", status: tx.transaction_status };
    }

    // Identify which escrow component (PULL, V3, or V1) was hit. We accept any
    // — the bounty's escrow_version determines whether this is the right one.
    // PULL is checked FIRST, so a V1 setting mistakenly pointed at the PULL
    // address can never let the V1 branch below claim a PULL tx and parse it
    // positionally. (Before 2026-10-01 that mistake was the DEFAULT outcome of
    // setting ESCROW_COMPONENT for the watcher; the V1 var is now its own name.)
    const entities = tx.affected_global_entities || [];
    let escrowComponent = null;
    let escrowVersion = null;
    if (entities.includes(ESCROW_PULL_COMPONENT)) {
      escrowComponent = ESCROW_PULL_COMPONENT;
      escrowVersion = 4;
    } else if (entities.includes(ESCROW_V3_COMPONENT)) {
      escrowComponent = ESCROW_V3_COMPONENT;
      escrowVersion = 3;
    } else if (entities.includes(ESCROW_V1_COMPONENT)) {
      escrowComponent = ESCROW_V1_COMPONENT;
      escrowVersion = 1;
    } else {
      return { verified: false, reason: "escrow_not_involved" };
    }

    // Find a TaskCreatedEvent emitted by that specific component.
    const events = tx.receipt?.events || [];
    const createEvent = events.find(e =>
      e.name === "TaskCreatedEvent" &&
      e.emitter?.entity?.entity_address === escrowComponent
    );

    if (!createEvent) {
      return { verified: false, reason: "no_task_created_event" };
    }

    const parsed = parseTaskCreatedEvent(createEvent.data?.fields || [], escrowVersion);
    if (!parsed || !parsed.task_id) {
      return { verified: false, reason: "event_parse_failed" };
    }

    return {
      verified: true,
      event: "TaskCreated",
      task_id: parsed.task_id,
      amount: parsed.amount,
      creator: parsed.creator,
      resource: parsed.resource,
      escrow_version: escrowVersion,
      escrow_component: escrowComponent,
      tx_hash: txHash,
    };
  } catch (e) {
    console.error("[Gateway] verifyEscrowTx error:", e.message);
    return { verified: false, reason: "error", message: e.message };
  }
}

module.exports = {
  hasBadge,
  getBadgeData,
  getBadgeResult,
  getEscrowStats,
  verifyEscrowTx,
  parseTaskCreatedEvent,
  fetchWithTimeout,
  fetchJsonWithTimeout,
  ESCROW_V1_COMPONENT,
  ESCROW_V3_COMPONENT,
  ESCROW_PULL_COMPONENT,
  XRD_RESOURCE,
};
