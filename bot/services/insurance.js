/**
 * Insurance Pool Service — Phase 3
 *
 * Manages the dispute insurance mechanism:
 * - Tiered fee calculation based on bounty reward
 * - Fee collection into the insurance pool on bounty claim
 * - Release to treasury on successful completion (no dispute)
 * - Payment to arbiter on dispute resolution
 * - Refund on cancellation before claim
 */

const TIERS = [
  { min: 0,    max: 100,   key: "insurance_fee_tier_0_100",    fallback: 15 },
  { min: 100,  max: 500,   key: "insurance_fee_tier_100_500",  fallback: 10 },
  { min: 500,  max: 2000,  key: "insurance_fee_tier_500_2000", fallback: 7 },
  { min: 2000, max: Infinity, key: "insurance_fee_tier_2000_plus", fallback: 5 },
];

let db; // injected via init()

function init(dbModule) {
  db = dbModule;
}

function getDb() {
  if (!db) throw new Error("Insurance service not initialized — call init(db) first");
  return db;
}

/**
 * Calculate the insurance fee for a given reward amount.
 * Reads tier percentages from platform_config (owner-tuneable).
 */
function calculateInsuranceFee(rewardXrd) {
  if (!rewardXrd || rewardXrd <= 0) return { fee_pct: 0, fee_amount: 0, net_to_worker: 0 };

  const config = getDb().getPlatformConfig();
  let feePct = 10; // ultimate fallback

  for (const tier of TIERS) {
    if (rewardXrd > tier.min && rewardXrd <= tier.max) {
      const parsed = parseFloat(config[tier.key]);
      feePct = isFinite(parsed) ? parsed : tier.fallback;
      break;
    }
  }

  const feeAmount = Math.round(rewardXrd * (feePct / 100) * 100) / 100; // 2 decimal places
  return {
    fee_pct: feePct,
    fee_amount: feeAmount,
    net_to_worker: Math.round((rewardXrd - feeAmount) * 100) / 100,
  };
}

/**
 * Collect insurance fee for a bounty (or milestone).
 * Inserts a record into insurance_pool and updates the bounty.
 * Idempotent — returns error if already collected.
 */
function collectInsuranceFee(bountyId, milestoneId = null) {
  const d = getDb();
  const bounty = d.getBounty(bountyId);
  if (!bounty) return { error: "bounty_not_found" };

  // Idempotency guard
  if (bounty.insurance_status && bounty.insurance_status !== "none") {
    return { error: "already_collected" };
  }

  // For milestones, calculate fee on the milestone's share, not the full bounty
  let amount = bounty.reward_xrd;
  if (milestoneId) {
    const milestone = d.getMilestoneById(milestoneId);
    if (milestone) {
      amount = bounty.reward_xrd * (milestone.percentage / 100);
    }
  }

  const { fee_pct, fee_amount } = calculateInsuranceFee(amount);
  if (fee_amount <= 0) return { error: "zero_fee" };

  const rawDb = d._raw();
  const now = Math.floor(Date.now() / 1000);

  // Wrap all writes in a transaction for atomicity
  const doCollect = rawDb.transaction(() => {
    rawDb.prepare(
      "INSERT INTO insurance_pool (bounty_id, milestone_id, fee_amount, status, collected_at) VALUES (?, ?, ?, 'held', ?)"
    ).run(bountyId, milestoneId, fee_amount, now);

    rawDb.prepare(
      "UPDATE bounties SET insurance_fee_xrd = ?, insurance_fee_pct = ?, insurance_status = 'collected' WHERE id = ?"
    ).run(fee_amount, fee_pct, bountyId);

    rawDb.prepare(
      "UPDATE platform_config SET value = CAST(CAST(value AS REAL) + ? AS TEXT), updated_at = ? WHERE key = 'insurance_pool_balance'"
    ).run(fee_amount, now);
  });

  try {
    doCollect();
  } catch (e) {
    return { error: "db_error", detail: e.message };
  }

  return { ok: true, bountyId, milestoneId, fee_pct, fee_amount };
}

/**
 * Release insurance fee to treasury — called when bounty completes without dispute.
 * Processes ALL held records for the bounty (milestone support).
 */
function releaseToTreasury(bountyId) {
  const rawDb = getDb()._raw();
  const now = Math.floor(Date.now() / 1000);

  const records = rawDb.prepare(
    "SELECT * FROM insurance_pool WHERE bounty_id = ? AND status = 'held'"
  ).all(bountyId);
  if (records.length === 0) return { error: "no_held_fee", bountyId };

  let totalReleased = 0;
  const doRelease = rawDb.transaction(() => {
    for (const record of records) {
      rawDb.prepare(
        "UPDATE insurance_pool SET status = 'released_to_treasury', released_at = ? WHERE id = ?"
      ).run(now, record.id);
      totalReleased += record.fee_amount;
    }

    // Decrement pool balance (fee moves from pool to treasury)
    rawDb.prepare(
      "UPDATE platform_config SET value = CAST(MAX(0, CAST(value AS REAL) - ?) AS TEXT), updated_at = ? WHERE key = 'insurance_pool_balance'"
    ).run(totalReleased, now);

    rawDb.prepare(
      "UPDATE bounties SET insurance_status = 'released_to_treasury' WHERE id = ?"
    ).run(bountyId);
  });

  try {
    doRelease();
  } catch (e) {
    return { error: "db_error", detail: e.message };
  }

  return { ok: true, amount: totalReleased };
}

/**
 * Pay arbiter from insurance pool — called when dispute is resolved.
 * Processes ALL held records for the bounty.
 */
function payArbiter(disputeId, arbiterTgId, bountyId) {
  if (!disputeId || !arbiterTgId || !bountyId) {
    return { error: "missing_params", detail: "disputeId, arbiterTgId, and bountyId are all required" };
  }
  const rawDb = getDb()._raw();
  const now = Math.floor(Date.now() / 1000);

  const records = rawDb.prepare(
    "SELECT * FROM insurance_pool WHERE bounty_id = ? AND status = 'held'"
  ).all(bountyId);
  if (records.length === 0) return { error: "no_held_fee", bountyId };

  let totalPaid = 0;
  const doPay = rawDb.transaction(() => {
    for (const record of records) {
      rawDb.prepare(
        "UPDATE insurance_pool SET status = 'paid_to_arbiter', released_at = ?, arbiter_tg_id = ?, dispute_id = ? WHERE id = ?"
      ).run(now, arbiterTgId, disputeId, record.id);
      totalPaid += record.fee_amount;
    }

    // Decrement pool balance
    rawDb.prepare(
      "UPDATE platform_config SET value = CAST(MAX(0, CAST(value AS REAL) - ?) AS TEXT), updated_at = ? WHERE key = 'insurance_pool_balance'"
    ).run(totalPaid, now);

    rawDb.prepare(
      "UPDATE bounties SET insurance_status = 'paid_to_arbiter' WHERE id = ?"
    ).run(bountyId);
  });

  try {
    doPay();
  } catch (e) {
    return { error: "db_error", detail: e.message };
  }

  return { ok: true, amount: totalPaid, arbiterTgId };
}

/**
 * Refund insurance fee — called when bounty is cancelled before any work starts.
 * Processes ALL held records for the bounty.
 */
function refundInsurance(bountyId) {
  const rawDb = getDb()._raw();
  const now = Math.floor(Date.now() / 1000);

  const records = rawDb.prepare(
    "SELECT * FROM insurance_pool WHERE bounty_id = ? AND status = 'held'"
  ).all(bountyId);
  if (records.length === 0) return { error: "no_held_fee", bountyId };

  let totalRefunded = 0;
  const doRefund = rawDb.transaction(() => {
    for (const record of records) {
      rawDb.prepare(
        "UPDATE insurance_pool SET status = 'refunded', released_at = ? WHERE id = ?"
      ).run(now, record.id);
      totalRefunded += record.fee_amount;
    }

    // Decrease pool balance (floor at 0)
    rawDb.prepare(
      "UPDATE platform_config SET value = CAST(MAX(0, CAST(value AS REAL) - ?) AS TEXT), updated_at = ? WHERE key = 'insurance_pool_balance'"
    ).run(totalRefunded, now);

    rawDb.prepare(
      "UPDATE bounties SET insurance_status = 'refunded' WHERE id = ?"
    ).run(bountyId);
  });

  try {
    doRefund();
  } catch (e) {
    return { error: "db_error", detail: e.message };
  }

  return { ok: true, amount: totalRefunded };
}

/**
 * Get aggregate pool statistics.
 */
function getPoolStats() {
  try {
    const rawDb = getDb()._raw();

    const balance = rawDb.prepare(
      "SELECT COALESCE(value, '0') as v FROM platform_config WHERE key = 'insurance_pool_balance'"
    ).get();

    const collected = rawDb.prepare(
      "SELECT COALESCE(SUM(fee_amount), 0) as total FROM insurance_pool"
    ).get();

    const released = rawDb.prepare(
      "SELECT COALESCE(SUM(fee_amount), 0) as total FROM insurance_pool WHERE status = 'released_to_treasury'"
    ).get();

    const paidToArbiters = rawDb.prepare(
      "SELECT COALESCE(SUM(fee_amount), 0) as total FROM insurance_pool WHERE status = 'paid_to_arbiter'"
    ).get();

    const refunded = rawDb.prepare(
      "SELECT COALESCE(SUM(fee_amount), 0) as total FROM insurance_pool WHERE status = 'refunded'"
    ).get();

    const held = rawDb.prepare(
      "SELECT COUNT(*) as count, COALESCE(SUM(fee_amount), 0) as amount FROM insurance_pool WHERE status = 'held'"
    ).get();

    const bal = parseFloat(balance?.v || "0");
    return {
      total_balance: Number.isFinite(bal) ? bal : 0,
      total_collected: collected.total,
      total_released_to_treasury: released.total,
      total_paid_to_arbiters: paidToArbiters.total,
      total_refunded: refunded.total,
      active_held_count: held.count,
      active_held_amount: held.amount,
    };
  } catch (e) {
    console.error("[Insurance] getPoolStats error:", e.message);
    return { error: "db_error", detail: e.message };
  }
}

/**
 * Get pool transaction history.
 */
function getPoolHistory(limit = 50) {
  try {
    const rawDb = getDb()._raw();
    const safeLimit = Math.max(1, Math.min(parseInt(limit) || 50, 200));
    return rawDb.prepare(`
      SELECT ip.*, b.title as bounty_title, b.reward_xrd as bounty_reward
      FROM insurance_pool ip
      LEFT JOIN bounties b ON ip.bounty_id = b.id
      ORDER BY ip.collected_at DESC
      LIMIT ?
    `).all(safeLimit);
  } catch (e) {
    console.error("[Insurance] getPoolHistory error:", e.message);
    return [];
  }
}

/**
 * Get insurance details for a specific bounty.
 */
function getInsuranceForBounty(bountyId) {
  try {
    const rawDb = getDb()._raw();
    return rawDb.prepare(
      "SELECT * FROM insurance_pool WHERE bounty_id = ? ORDER BY collected_at DESC"
    ).all(bountyId);
  } catch (e) {
    console.error("[Insurance] getInsuranceForBounty error:", e.message);
    return [];
  }
}

module.exports = {
  init,
  calculateInsuranceFee,
  collectInsuranceFee,
  releaseToTreasury,
  payArbiter,
  refundInsurance,
  getPoolStats,
  getPoolHistory,
  getInsuranceForBounty,
};
