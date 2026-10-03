/**
 * Arbiter Service — Phase 4
 *
 * Manages the arbiter pool for dispute resolution:
 * - Registration (badge + 30-day age requirement)
 * - Availability toggling
 * - Conflict-of-interest filtering for assignment
 * - Stats and reputation tracking
 */

let db;

function init(dbModule) {
  db = dbModule;
}

function raw() {
  if (!db) throw new Error("Arbiter service not initialized — call init(db) first");
  return db._raw();
}

/**
 * Register a user as an arbiter.
 * Requirements: active badge, 30+ day member.
 */
function registerArbiter(tgId, badgeId, radixAddress, specialtyTags = null) {
  const d = raw();
  const existing = d.prepare("SELECT * FROM arbiters WHERE tg_id = ?").get(tgId);
  if (existing) {
    if (existing.active) return { error: "already_registered" };
    // Reactivate
    d.prepare("UPDATE arbiters SET active = 1, availability = 'available', badge_id = ?, radix_address = ?, specialty_tags = ? WHERE tg_id = ?")
      .run(badgeId, radixAddress, specialtyTags, tgId);
    return { ok: true, reactivated: true };
  }

  // Check account age (30 days)
  const user = d.prepare("SELECT * FROM users WHERE tg_id = ?").get(tgId);
  if (!user) return { error: "not_registered" };
  const ageDays = (Date.now() / 1000 - user.registered_at) / 86400;
  if (ageDays < 30) return { error: "too_new", days: Math.floor(ageDays), required: 30 };

  d.prepare(
    "INSERT INTO arbiters (tg_id, badge_id, radix_address, specialty_tags) VALUES (?, ?, ?, ?)"
  ).run(tgId, badgeId, radixAddress, specialtyTags);

  return { ok: true };
}

/**
 * Update arbiter availability.
 */
function updateAvailability(tgId, status) {
  if (!["available", "busy", "unavailable"].includes(status)) return { error: "invalid_status" };
  const result = raw().prepare(
    "UPDATE arbiters SET availability = ? WHERE tg_id = ? AND active = 1"
  ).run(status, tgId);
  return result.changes > 0 ? { ok: true } : { error: "not_found" };
}

/**
 * Get stats for a specific arbiter.
 */
function getArbiterStats(tgId) {
  const arbiter = raw().prepare("SELECT * FROM arbiters WHERE tg_id = ?").get(tgId);
  if (!arbiter) return null;
  return {
    tg_id: arbiter.tg_id,
    badge_id: arbiter.badge_id,
    radix_address: arbiter.radix_address,
    active: !!arbiter.active,
    availability: arbiter.availability,
    reputation_score: arbiter.reputation_score,
    total_handled: arbiter.total_handled,
    total_upheld: arbiter.total_upheld,
    total_overturned: arbiter.total_overturned,
    specialty_tags: arbiter.specialty_tags,
    registered_at: arbiter.registered_at,
    last_dispute_at: arbiter.last_dispute_at,
  };
}

/**
 * Get eligible arbiters for a specific dispute.
 * Filters out: parties, bounty creator, voters on related proposal, anyone with active disputes as party.
 */
function getEligibleArbiters(bountyId, raisedByTgId, raisedAgainstTgId) {
  const d = raw();
  const bounty = d.prepare("SELECT * FROM bounties WHERE id = ?").get(bountyId);
  if (!bounty) return [];

  // Base pool: active + available
  let arbiters = d.prepare(
    "SELECT * FROM arbiters WHERE active = 1 AND availability = 'available'"
  ).all();

  // Exclude parties
  const excludeIds = new Set([raisedByTgId, raisedAgainstTgId, bounty.creator_tg_id]);
  if (bounty.assignee_tg_id) excludeIds.add(bounty.assignee_tg_id);

  // Exclude voters on related proposal (if any)
  if (bounty.proposal_id) {
    const voters = d.prepare("SELECT tg_id FROM votes WHERE proposal_id = ?").all(bounty.proposal_id);
    voters.forEach(v => excludeIds.add(v.tg_id));
  }

  // Exclude anyone who is a party in an active dispute
  const activeParties = d.prepare(
    "SELECT raised_by_tg_id, raised_against_tg_id FROM disputes WHERE status IN ('open','assigned','reviewing')"
  ).all();
  activeParties.forEach(dp => {
    excludeIds.add(dp.raised_by_tg_id);
    excludeIds.add(dp.raised_against_tg_id);
  });

  arbiters = arbiters.filter(a => !excludeIds.has(a.tg_id));

  // Sort: highest reputation first, then least loaded
  arbiters.sort((a, b) => {
    if (b.reputation_score !== a.reputation_score) return b.reputation_score - a.reputation_score;
    return a.total_handled - b.total_handled;
  });

  return arbiters;
}

/**
 * Get the full arbiter pool (for display).
 */
function getArbiterPool() {
  return raw().prepare(
    "SELECT * FROM arbiters WHERE active = 1 ORDER BY reputation_score DESC, total_handled DESC"
  ).all();
}

/**
 * Deactivate an arbiter (can reactivate later via registerArbiter).
 */
function deactivateArbiter(tgId) {
  const result = raw().prepare(
    "UPDATE arbiters SET active = 0, availability = 'unavailable' WHERE tg_id = ?"
  ).run(tgId);
  return result.changes > 0 ? { ok: true } : { error: "not_found" };
}

/**
 * Update arbiter reputation. Clamped to [0, 100].
 */
function adjustReputation(tgId, delta) {
  if (!tgId || typeof delta !== "number" || !Number.isFinite(delta)) return { error: "invalid_params" };
  const result = raw().prepare(
    "UPDATE arbiters SET reputation_score = MIN(100, MAX(0, reputation_score + ?)) WHERE tg_id = ?"
  ).run(delta, tgId);
  return result.changes > 0 ? { ok: true } : { error: "not_found" };
}

/**
 * Increment handled/upheld/overturned counters.
 */
function recordOutcome(tgId, outcome) {
  const d = raw();
  if (outcome === "handled") {
    d.prepare("UPDATE arbiters SET total_handled = total_handled + 1, last_dispute_at = ? WHERE tg_id = ?")
      .run(Math.floor(Date.now() / 1000), tgId);
  } else if (outcome === "upheld") {
    d.prepare("UPDATE arbiters SET total_upheld = total_upheld + 1 WHERE tg_id = ?").run(tgId);
  } else if (outcome === "overturned") {
    d.prepare("UPDATE arbiters SET total_overturned = total_overturned + 1 WHERE tg_id = ?").run(tgId);
  }
}

/**
 * Mark arbiter as busy (during dispute assignment) or free (after resolution).
 */
function markBusy(tgId) {
  raw().prepare("UPDATE arbiters SET availability = 'busy' WHERE tg_id = ?").run(tgId);
}
function markAvailable(tgId) {
  raw().prepare("UPDATE arbiters SET availability = 'available' WHERE tg_id = ? AND active = 1").run(tgId);
}

module.exports = {
  init,
  registerArbiter,
  updateAvailability,
  getArbiterStats,
  getEligibleArbiters,
  getArbiterPool,
  deactivateArbiter,
  adjustReputation,
  recordOutcome,
  markBusy,
  markAvailable,
};
