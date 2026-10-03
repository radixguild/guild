/**
 * Shared verify-fund validator. Used by:
 *   - POST /api/bounties/:id/verify-fund (web dashboard, in services/api.js)
 *   - /bounty fund <id> <tx>          (TG bot, in index.js)
 *
 * The job is to confirm an on-chain TaskCreatedEvent matches the bounty being
 * funded along *every* axis the off-chain ledger needs to bind, then link the
 * bounty row to the on-chain task atomically.
 *
 * Closes:
 *   C3 (api.js verify-fund tx_hash poisoning)
 *   C5 (index.js /bounty fund parity)
 *
 * Specifically prevents:
 *   - amount mismatch (1 XRD on-chain → 1000 XRD bounty marked funded)
 *   - resource mismatch (1 xUSDC → XRD bounty)
 *   - creator mismatch (an unrelated wallet's deposit attributed to a bounty)
 *   - V1 deposit linked to V3 bounty (or vice-versa)
 *   - reuse of the same tx_hash across bounties (replay)
 *   - reuse of the same on-chain task_id across bounties
 *   - re-funding an already-funded bounty
 */

const { verifyEscrowTx, XRD_RESOURCE } = require("./gateway");
const { findConflictingLink } = require("./bounty-linkage");

// Decimal compare tolerance — the gateway returns amount as string, the DB
// stores REAL. Sub-millisat precision drift is fine; reject anything more.
const AMOUNT_EPSILON = 0.00001;

function amountsMatch(a, b) {
  const fa = parseFloat(a);
  const fb = parseFloat(b);
  if (!isFinite(fa) || !isFinite(fb)) return false;
  return Math.abs(fa - fb) < AMOUNT_EPSILON;
}

/**
 * @param {object} db                 — the bot/db.js module (exposes getBounty + _raw())
 * @param {number} bountyId
 * @param {string} txHash
 * @param {object} opts
 * @param {number|null} opts.actorTgId — for audit log (TG path); null on web
 * @param {string} opts.description    — line for bounty_transactions.description
 * @param {Function} opts.fetcher      — optional fetch override (tests)
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   error?: string,
 *   detail?: string,
 *   taskId?: number,
 *   amount?: string,
 *   escrowVersion?: number,
 *   creatorWarning?: string
 * }>}
 */
async function validateAndLinkFunding(db, bountyId, txHash, opts = {}) {
  // The exported `db` module from bot/db.js exposes wrapper functions like
  // getBounty(), but does NOT expose .prepare / .transaction directly — those
  // come from the raw better-sqlite3 instance via _raw(). Many existing call
  // sites do `db.prepare(...)` and silently fail (most wrapped in try/catch).
  // We use _raw() consistently here so this helper actually writes.
  const raw = typeof db._raw === "function" ? db._raw() : db;

  const bounty = db.getBounty ? db.getBounty(bountyId)
                              : raw.prepare("SELECT * FROM bounties WHERE id = ?").get(bountyId);
  if (!bounty) return { ok: false, error: "not_found" };

  if (bounty.funded) {
    return { ok: false, error: "already_funded" };
  }

  if (!txHash || typeof txHash !== "string" || txHash.length < 16) {
    return { ok: false, error: "tx_hash_required" };
  }

  // Refuse a tx_hash that was already consumed by ANY bounty — defense before
  // the DB UNIQUE INDEX raises.
  const existingTx = raw.prepare(
    "SELECT bounty_id FROM bounty_transactions WHERE tx_hash = ? LIMIT 1"
  ).get(txHash);
  if (existingTx) {
    return { ok: false, error: "tx_hash_already_used", detail: `bounty #${existingTx.bounty_id}` };
  }

  const result = await verifyEscrowTx(txHash, { fetcher: opts.fetcher });
  if (!result.verified) {
    return { ok: false, error: "verification_failed", detail: result.reason };
  }
  if (!result.task_id) {
    return { ok: false, error: "event_parse_failed" };
  }

  // Refuse an on-chain task_id already linked to a different bounty ON THE
  // SAME escrow component. (The current row has !bounty.funded, so a positive
  // hit here means cross-row poisoning.) Task ids restart from 1 per component
  // generation, so an unscoped check would strand every new deposit whose id
  // collides with a legacy row — bounty-linkage.js owns the matching rule.
  const existingLink = findConflictingLink(raw, result.task_id, result.escrow_component, bountyId);
  if (existingLink) {
    return {
      ok: false,
      error: "onchain_task_already_linked",
      detail: `task ${result.task_id} → bounty #${existingLink.id}`,
    };
  }

  // Amount must match what the bounty advertised.
  if (!amountsMatch(result.amount, bounty.reward_xrd)) {
    return {
      ok: false,
      error: "amount_mismatch",
      detail: `on-chain ${result.amount} ≠ bounty ${bounty.reward_xrd}`,
    };
  }

  // Resource must match. Today every bounty is XRD; once V3 multi-token bounties
  // ship, swap the comparand for bounty.resource.
  const expectedResource = bounty.resource || XRD_RESOURCE;
  if (result.resource && result.resource !== expectedResource) {
    return {
      ok: false,
      error: "resource_mismatch",
      detail: `on-chain ${result.resource} ≠ expected ${expectedResource}`,
    };
  }

  // Escrow version must match. NULL on bounty = legacy (V1 default); 3 = V3.
  const bountyVersion = bounty.escrow_version || 1;
  if (result.escrow_version !== bountyVersion) {
    return {
      ok: false,
      error: "escrow_version_mismatch",
      detail: `on-chain V${result.escrow_version} ≠ bounty V${bountyVersion}`,
    };
  }

  // Creator binding. Strict when bounty.creator_address is set; soft (warn-only)
  // for legacy rows that pre-date the migration so we don't strand them.
  let creatorWarning = null;
  if (bounty.creator_address) {
    if (result.creator !== bounty.creator_address) {
      return {
        ok: false,
        error: "creator_mismatch",
        detail: `on-chain ${result.creator} ≠ bounty ${bounty.creator_address}`,
      };
    }
  } else {
    creatorWarning = `legacy bounty #${bountyId} has no creator_address — accepting tx without creator binding`;
    console.warn("[escrow-funding] " + creatorWarning + " (on-chain creator=" + result.creator + ")");
  }

  // All checks passed. Atomic update: link the bounty + insert the transaction
  // in a single SQLite transaction so either both happen or neither does.
  const description = opts.description || "Escrow deposit verified on-chain";
  const tx = raw.transaction(() => {
    raw.prepare(
      "UPDATE bounties SET onchain_task_id = ?, escrow_component = ?, escrow_verified = 1, funded = 1 WHERE id = ?"
    ).run(result.task_id, result.escrow_component, bountyId);

    raw.prepare(
      "INSERT INTO bounty_transactions (bounty_id, tx_type, amount_xrd, tx_hash, description, actor_tg_id, verified_onchain, onchain_task_id, escrow_component) VALUES (?, 'deposit', ?, ?, ?, ?, 1, ?, ?)"
    ).run(
      bountyId,
      parseFloat(result.amount) || 0,
      txHash,
      description,
      opts.actorTgId || null,
      result.task_id,
      result.escrow_component
    );
  });

  try {
    tx();
  } catch (e) {
    // The UNIQUE INDEX on tx_hash will fire if a concurrent caller raced us
    // between our prefetch and this insert. Surface as a clean error.
    if (/UNIQUE constraint/i.test(e.message)) {
      return { ok: false, error: "tx_hash_already_used", detail: "race" };
    }
    throw e;
  }

  return {
    ok: true,
    taskId: result.task_id,
    amount: result.amount,
    escrowVersion: result.escrow_version,
    creatorWarning,
  };
}

module.exports = { validateAndLinkFunding, amountsMatch };
