/**
 * Dispute Resolution Service — Phase 4
 *
 * Full dispute lifecycle:
 *   raise → assign arbiter → evidence → decide → execute → (appeal)
 *
 * Integrates with: insurance (arbiter payment), arbiter (pool management),
 * escrow (locking/releasing), trust score (reputation impact).
 */

const arbiterService = require("./arbiter");
const insurance = require("./insurance");

let db;

function init(dbModule) {
  db = dbModule;
  arbiterService.init(dbModule);
  insurance.init(dbModule);
}

function raw() {
  if (!db) throw new Error("Dispute service not initialized — call init(db) first");
  return db._raw();
}

// ── Timeline helper ──

function addTimelineEvent(disputeId, eventType, actorTgId, description) {
  raw().prepare(
    "INSERT INTO dispute_timeline (dispute_id, event_type, actor_tg_id, description) VALUES (?, ?, ?, ?)"
  ).run(disputeId, eventType, actorTgId, (description || "").slice(0, 500));
}

// ── Core lifecycle ──

/**
 * Raise a dispute on a bounty.
 * Locks the bounty, auto-assigns an arbiter.
 * Wrapped in transaction to prevent duplicate disputes.
 */
function raiseDispute(bountyId, raisedByTgId, reason, desiredOutcome) {
  if (!reason || reason.length < 10) return { error: "reason_too_short", detail: "Reason must be at least 10 characters" };
  if (reason.length > 2000) reason = reason.slice(0, 2000);

  const d = raw();
  const bounty = d.prepare("SELECT * FROM bounties WHERE id = ?").get(bountyId);
  if (!bounty) return { error: "bounty_not_found" };

  if (!["assigned", "submitted", "verified"].includes(bounty.status)) {
    return { error: "invalid_status", detail: "Can only dispute assigned/submitted/verified bounties (current: " + bounty.status + ")" };
  }

  if (raisedByTgId !== bounty.creator_tg_id && raisedByTgId !== bounty.assignee_tg_id) {
    return { error: "not_a_party", detail: "Only the task creator or assignee can raise a dispute" };
  }

  const raisedAgainstTgId = raisedByTgId === bounty.creator_tg_id
    ? bounty.assignee_tg_id
    : bounty.creator_tg_id;

  const insRecord = d.prepare(
    "SELECT fee_amount FROM insurance_pool WHERE bounty_id = ? AND status = 'held'"
  ).get(bountyId);

  // Transaction: check for existing + lock bounty + create dispute atomically
  let disputeId;
  const doRaise = d.transaction(() => {
    const existing = d.prepare(
      "SELECT id FROM disputes WHERE bounty_id = ? AND status NOT IN ('final','cancelled')"
    ).get(bountyId);
    if (existing) throw new Error("DISPUTE_EXISTS:" + existing.id);

    d.prepare("UPDATE bounties SET status = 'disputed' WHERE id = ?").run(bountyId);

    const result = d.prepare(`
      INSERT INTO disputes (bounty_id, raised_by_tg_id, raised_against_tg_id, reason, desired_outcome, insurance_fee_xrd, status)
      VALUES (?, ?, ?, ?, ?, ?, 'open')
    `).run(bountyId, raisedByTgId, raisedAgainstTgId, reason, desiredOutcome || null, insRecord?.fee_amount || 0);

    disputeId = result.lastInsertRowid;
    addTimelineEvent(disputeId, "raised", raisedByTgId, "Dispute raised: " + reason.slice(0, 200));
  });

  try {
    doRaise();
  } catch (e) {
    if (e.message.startsWith("DISPUTE_EXISTS:")) {
      return { error: "dispute_exists", disputeId: parseInt(e.message.split(":")[1]) };
    }
    return { error: "db_error", detail: e.message };
  }

  // Auto-assign arbiter (outside transaction — non-critical if it fails)
  const assignment = assignArbiter(disputeId);

  return {
    ok: true,
    disputeId,
    bountyId,
    raisedBy: raisedByTgId,
    raisedAgainst: raisedAgainstTgId,
    arbiter: assignment.ok ? assignment.arbiterTgId : null,
    arbiterError: assignment.error || null,
  };
}

/**
 * Assign an arbiter to a dispute.
 * Only allowed for open/assigned/reviewing/needs_admin disputes (not decided/appealed/final).
 */
function assignArbiter(disputeId) {
  const d = raw();
  const dispute = d.prepare("SELECT * FROM disputes WHERE id = ?").get(disputeId);
  if (!dispute) return { error: "dispute_not_found" };

  // Status guard: prevent overwriting arbiters on decided/appealed/final disputes
  if (!["open", "assigned", "reviewing", "needs_admin"].includes(dispute.status)) {
    return { error: "invalid_status", detail: "Cannot assign arbiter to " + dispute.status + " dispute" };
  }

  const eligible = arbiterService.getEligibleArbiters(
    dispute.bounty_id, dispute.raised_by_tg_id, dispute.raised_against_tg_id
  );

  if (eligible.length === 0) {
    d.prepare("UPDATE disputes SET status = 'needs_admin' WHERE id = ?").run(disputeId);
    addTimelineEvent(disputeId, "escalated", null, "No eligible arbiters — escalated to admin");
    return { error: "no_eligible_arbiters" };
  }

  const chosen = eligible[0];
  const config = db.getPlatformConfig();
  const deadlineDays = parseInt(config.dispute_arbiter_deadline_days || "7");
  const now = Math.floor(Date.now() / 1000);
  const deadline = now + (deadlineDays * 86400);

  // Free previous arbiter if reassigning
  const prevArbiter = dispute.arbiter_tg_id;

  // Wrap in transaction to prevent race conditions
  const doAssign = d.transaction(() => {
    d.prepare(`
      UPDATE disputes SET arbiter_tg_id = ?, arbiter_assigned_at = ?, arbiter_deadline = ?, status = 'assigned'
      WHERE id = ? AND status IN ('open', 'assigned', 'reviewing', 'needs_admin')
    `).run(chosen.tg_id, now, deadline, disputeId);
  });

  try {
    doAssign();
  } catch (e) {
    return { error: "db_error", detail: e.message };
  }

  // Free previous arbiter outside transaction (non-critical)
  if (prevArbiter && prevArbiter !== chosen.tg_id) {
    arbiterService.markAvailable(prevArbiter);
  }
  arbiterService.markBusy(chosen.tg_id);
  addTimelineEvent(disputeId, "assigned", chosen.tg_id, "Arbiter assigned (deadline: " + deadlineDays + " days)");

  return { ok: true, arbiterTgId: chosen.tg_id, deadline };
}

/**
 * Add evidence to a dispute.
 */
function addEvidence(disputeId, submittedByTgId, evidenceType, content, description) {
  const d = raw();
  const dispute = d.prepare("SELECT * FROM disputes WHERE id = ?").get(disputeId);
  if (!dispute) return { error: "dispute_not_found" };

  if (!["open", "assigned", "reviewing"].includes(dispute.status)) {
    return { error: "dispute_closed", detail: "Cannot add evidence to a " + dispute.status + " dispute" };
  }

  const allowed = [dispute.raised_by_tg_id, dispute.raised_against_tg_id, dispute.arbiter_tg_id];
  if (!allowed.includes(submittedByTgId)) {
    return { error: "not_authorized", detail: "Only dispute parties or the arbiter can submit evidence" };
  }

  if (!["text", "url", "screenshot", "document"].includes(evidenceType)) {
    return { error: "invalid_type", detail: "Evidence type must be: text, url, screenshot, or document" };
  }

  // Limit content length
  if (content && content.length > 4000) content = content.slice(0, 4000);

  const result = d.prepare(
    "INSERT INTO dispute_evidence (dispute_id, submitted_by_tg_id, evidence_type, content, description) VALUES (?, ?, ?, ?, ?)"
  ).run(disputeId, submittedByTgId, evidenceType, content, (description || "").slice(0, 500));

  addTimelineEvent(disputeId, "evidence_added", submittedByTgId, evidenceType + " evidence submitted");

  return { ok: true, evidenceId: result.lastInsertRowid };
}

/**
 * Arbiter requests clarification from a party.
 */
function requestClarification(disputeId, arbiterTgId, targetTgId, question) {
  const d = raw();
  const dispute = d.prepare("SELECT * FROM disputes WHERE id = ?").get(disputeId);
  if (!dispute) return { error: "dispute_not_found" };
  if (dispute.arbiter_tg_id !== arbiterTgId) return { error: "not_arbiter" };

  // Validate target is a dispute party
  if (targetTgId !== dispute.raised_by_tg_id && targetTgId !== dispute.raised_against_tg_id) {
    return { error: "invalid_target", detail: "Can only request clarification from dispute parties" };
  }

  if (dispute.status === "assigned") {
    d.prepare("UPDATE disputes SET status = 'reviewing' WHERE id = ?").run(disputeId);
  }

  addTimelineEvent(disputeId, "clarification_requested", arbiterTgId,
    "Asked user " + targetTgId + ": " + (question || "").slice(0, 200));

  return { ok: true, targetTgId, question };
}

/**
 * Arbiter makes a decision.
 * decision: full_release | full_return | split | mediated
 * Wrapped in transaction for atomicity.
 */
function makeDecision(disputeId, arbiterTgId, decision, splitPct, notes) {
  const d = raw();
  const dispute = d.prepare("SELECT * FROM disputes WHERE id = ?").get(disputeId);
  if (!dispute) return { error: "dispute_not_found" };
  if (dispute.arbiter_tg_id !== arbiterTgId) return { error: "not_arbiter" };

  if (!["assigned", "reviewing"].includes(dispute.status)) {
    return { error: "invalid_status", detail: "Dispute must be assigned/reviewing to decide (current: " + dispute.status + ")" };
  }

  if (!notes || notes.length < 10) return { error: "notes_required", detail: "Decision reasoning must be at least 10 characters" };

  const validDecisions = ["full_release", "full_return", "split", "mediated"];
  if (!validDecisions.includes(decision)) {
    return { error: "invalid_decision", detail: "Must be: " + validDecisions.join(", ") };
  }

  if (decision === "split") {
    if (!splitPct || isNaN(splitPct) || splitPct < 1 || splitPct > 99) {
      return { error: "invalid_split", detail: "Split percentage must be 1-99 (% to worker)" };
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const bounty = d.prepare("SELECT * FROM bounties WHERE id = ?").get(dispute.bounty_id);

  // Transaction: record decision + execute escrow + pay arbiter + update reputation
  const doDecide = d.transaction(() => {
    d.prepare(`
      UPDATE disputes SET decision = ?, decision_split_pct = ?, decision_notes = ?, decision_at = ?, status = 'decided'
      WHERE id = ?
    `).run(decision, splitPct || null, notes, now, disputeId);

    // Execute escrow decision inline (within same transaction)
    switch (decision) {
      case "full_release":
        d.prepare("UPDATE bounties SET status = 'paid', paid_at = ? WHERE id = ?").run(now, bounty.id);
        break;
      case "full_return":
        d.prepare("UPDATE bounties SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'dispute_full_return' WHERE id = ?")
          .run(now, bounty.id);
        break;
      case "split": {
        const workerPct = splitPct;
        const workerAmount = Math.round(bounty.reward_xrd * (workerPct / 100) * 100) / 100;
        const creatorAmount = Math.round((bounty.reward_xrd - workerAmount) * 100) / 100;
        d.prepare("UPDATE bounties SET status = 'paid', paid_at = ? WHERE id = ?").run(now, bounty.id);
        addTimelineEvent(disputeId, "resolved", null,
          "Split: " + workerAmount + " XRD to worker (" + workerPct + "%), " + creatorAmount + " XRD to creator");
        break;
      }
      case "mediated":
        d.prepare("UPDATE bounties SET status = 'paid', paid_at = ? WHERE id = ?").run(now, bounty.id);
        break;
    }

    d.prepare("UPDATE disputes SET resolved_at = ? WHERE id = ?").run(now, disputeId);
  });

  try {
    doDecide();
  } catch (e) {
    return { error: "db_error", detail: e.message };
  }

  // Non-transactional side effects (OK if these fail independently)
  insurance.payArbiter(disputeId, arbiterTgId, dispute.bounty_id);
  arbiterService.recordOutcome(arbiterTgId, "handled");
  arbiterService.markAvailable(arbiterTgId);
  applyReputationImpact(dispute.bounty_id, decision);

  addTimelineEvent(disputeId, "decision_made", arbiterTgId,
    decision + (splitPct ? " (" + splitPct + "% to worker)" : "") + " — " + notes.slice(0, 100));

  // Check if appeal is available
  const config = db.getPlatformConfig();
  const appealMinXrd = parseFloat(config.dispute_appeal_min_xrd || "500");
  const appealWindowDays = parseInt(config.dispute_appeal_window_days || "3");
  const canAppeal = bounty && bounty.reward_xrd >= appealMinXrd;

  return {
    ok: true,
    decision,
    splitPct: splitPct || null,
    canAppeal,
    appealWindowDays: canAppeal ? appealWindowDays : 0,
  };
}

/**
 * File an appeal against a dispute decision.
 * Wrapped in transaction.
 */
function fileAppeal(disputeId, appellantTgId) {
  const d = raw();
  const dispute = d.prepare("SELECT * FROM disputes WHERE id = ?").get(disputeId);
  if (!dispute) return { error: "dispute_not_found" };
  if (dispute.status !== "decided") return { error: "not_decided", detail: "Can only appeal decided disputes" };

  if (appellantTgId !== dispute.raised_by_tg_id && appellantTgId !== dispute.raised_against_tg_id) {
    return { error: "not_a_party" };
  }

  const config = db.getPlatformConfig();
  const windowDays = parseInt(config.dispute_appeal_window_days || "3");
  const now = Math.floor(Date.now() / 1000);
  if (!dispute.decision_at) {
    return { error: "no_decision_timestamp", detail: "Dispute has no decision timestamp" };
  }
  if (now - dispute.decision_at > windowDays * 86400) {
    return { error: "appeal_window_expired", detail: "Appeal window (" + windowDays + " days) has expired" };
  }

  const bounty = d.prepare("SELECT * FROM bounties WHERE id = ?").get(dispute.bounty_id);
  const appealMinXrd = parseFloat(config.dispute_appeal_min_xrd || "500");
  if (!bounty || bounty.reward_xrd < appealMinXrd) {
    return { error: "below_minimum", detail: "Appeals only available for bounties >= " + appealMinXrd + " XRD" };
  }

  const appealFeePct = parseFloat(config.dispute_appeal_fee_pct || "5");
  const appealFee = Math.round(bounty.reward_xrd * (appealFeePct / 100) * 100) / 100;

  const eligible = arbiterService.getEligibleArbiters(
    dispute.bounty_id, dispute.raised_by_tg_id, dispute.raised_against_tg_id
  ).filter(a => a.tg_id !== dispute.arbiter_tg_id);

  if (eligible.length < 3) {
    return { error: "insufficient_panel", detail: "Need 3 eligible arbiters for appeal panel, only " + eligible.length + " available" };
  }

  const panel = eligible.slice(0, 3);
  const panelIds = JSON.stringify(panel.map(a => a.tg_id));

  const doAppeal = d.transaction(() => {
    // Re-check status inside transaction to prevent double-appeal
    const fresh = d.prepare("SELECT status FROM disputes WHERE id = ?").get(disputeId);
    if (fresh.status !== "decided") throw new Error("ALREADY_APPEALED");

    d.prepare(`
      UPDATE disputes SET
        appeal_status = 'filed', appeal_filed_by_tg_id = ?, appeal_filed_at = ?,
        appeal_fee_xrd = ?, appeal_panel_ids = ?, status = 'appealed'
      WHERE id = ?
    `).run(appellantTgId, now, appealFee, panelIds, disputeId);
  });

  try {
    doAppeal();
  } catch (e) {
    if (e.message === "ALREADY_APPEALED") return { error: "already_appealed" };
    return { error: "db_error", detail: e.message };
  }

  panel.forEach(a => arbiterService.markBusy(a.tg_id));
  addTimelineEvent(disputeId, "appeal_filed", appellantTgId,
    "Appeal filed (fee: " + appealFee + " XRD). Panel: " + panel.map(a => a.tg_id).join(", "));

  return { ok: true, appealFee, panelIds: panel.map(a => a.tg_id) };
}

/**
 * Record appeal panel decisions. Majority wins (2 of 3).
 * panelDecisions: [{ arbiter_tg_id, decision, split_pct?, notes }]
 */
function decideAppeal(disputeId, panelDecisions) {
  const d = raw();
  const dispute = d.prepare("SELECT * FROM disputes WHERE id = ?").get(disputeId);
  if (!dispute) return { error: "dispute_not_found" };
  if (dispute.status !== "appealed") return { error: "not_appealed" };

  if (!Array.isArray(panelDecisions) || panelDecisions.length !== 3) {
    return { error: "need_3_decisions" };
  }

  // Validate panel members match the assigned panel
  const expectedPanel = JSON.parse(dispute.appeal_panel_ids || "[]");
  const validDecisionTypes = ["full_release", "full_return", "split", "mediated"];
  for (const pd of panelDecisions) {
    if (!expectedPanel.includes(pd.arbiter_tg_id)) {
      return { error: "invalid_panel_member", detail: "Arbiter " + pd.arbiter_tg_id + " is not on the appeal panel" };
    }
    if (!validDecisionTypes.includes(pd.decision)) {
      return { error: "invalid_decision", detail: "Panel decision must be: " + validDecisionTypes.join(", ") };
    }
  }

  // Find true majority: group by decision, need 2+ votes
  const voteCounts = {};
  for (const pd of panelDecisions) {
    voteCounts[pd.decision] = (voteCounts[pd.decision] || 0) + 1;
  }
  const majorityEntry = Object.entries(voteCounts).find(([, count]) => count >= 2);

  // If no 2-vote majority exists (all 3 differ), uphold original
  const majorityDecision = majorityEntry ? majorityEntry[0] : null;
  const overturned = majorityDecision && majorityDecision !== dispute.decision;

  const now = Math.floor(Date.now() / 1000);
  let finalDecision = dispute.decision;

  const doAppealDecide = d.transaction(() => {
    if (overturned) {
      const majorityVote = panelDecisions.find(pd => pd.decision === majorityDecision);
      finalDecision = majorityDecision;

      d.prepare(`
        UPDATE disputes SET
          appeal_status = 'decided', appeal_decision = ?, appeal_decision_split_pct = ?,
          appeal_decision_notes = ?, appeal_decided_at = ?, status = 'final'
        WHERE id = ?
      `).run(majorityDecision, majorityVote.split_pct || null,
        majorityVote.notes || "Appeal overturned original decision", now, disputeId);

      // Reverse: restore bounty to disputed, update decision, re-execute
      d.prepare("UPDATE bounties SET status = 'disputed' WHERE id = ?").run(dispute.bounty_id);
      d.prepare("UPDATE disputes SET decision = ?, decision_split_pct = ? WHERE id = ?")
        .run(majorityDecision, majorityVote.split_pct || null, disputeId);

      // Execute new decision inline
      const bounty = d.prepare("SELECT * FROM bounties WHERE id = ?").get(dispute.bounty_id);
      if (bounty) {
        switch (majorityDecision) {
          case "full_release":
            d.prepare("UPDATE bounties SET status = 'paid', paid_at = ? WHERE id = ?").run(now, bounty.id);
            break;
          case "full_return":
            d.prepare("UPDATE bounties SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'appeal_full_return' WHERE id = ?")
              .run(now, bounty.id);
            break;
          case "split":
            d.prepare("UPDATE bounties SET status = 'paid', paid_at = ? WHERE id = ?").run(now, bounty.id);
            break;
          case "mediated":
            d.prepare("UPDATE bounties SET status = 'paid', paid_at = ? WHERE id = ?").run(now, bounty.id);
            break;
        }
      }
      d.prepare("UPDATE disputes SET resolved_at = ? WHERE id = ?").run(now, disputeId);
    } else {
      // Uphold original
      d.prepare(`
        UPDATE disputes SET
          appeal_status = 'decided', appeal_decision = ?, appeal_decision_notes = ?,
          appeal_decided_at = ?, status = 'final'
        WHERE id = ?
      `).run(dispute.decision, "Original decision upheld on appeal", now, disputeId);
    }
  });

  try {
    doAppealDecide();
  } catch (e) {
    return { error: "db_error", detail: e.message };
  }

  // Side effects outside transaction
  if (overturned) {
    arbiterService.recordOutcome(dispute.arbiter_tg_id, "overturned");
    arbiterService.adjustReputation(dispute.arbiter_tg_id, -10);
    addTimelineEvent(disputeId, "appeal_decided", null,
      "Appeal OVERTURNED. New decision: " + majorityDecision);
  } else {
    arbiterService.recordOutcome(dispute.arbiter_tg_id, "upheld");
    arbiterService.adjustReputation(dispute.arbiter_tg_id, 3);
    addTimelineEvent(disputeId, "appeal_decided", null,
      "Appeal UPHELD. Original decision stands.");
  }

  // Free panel
  expectedPanel.forEach(id => {
    arbiterService.markAvailable(id);
    arbiterService.adjustReputation(id, 2);
  });

  return { ok: true, overturned, decision: finalDecision };
}

// ── Reputation impact (simplified) ──

function applyReputationImpact(bountyId, decision) {
  const d = raw();
  const bounty = d.prepare("SELECT * FROM bounties WHERE id = ?").get(bountyId);
  if (!bounty) return;

  if (decision === "full_release") {
    // Work was valid — creator loses (frivolous dispute), worker gains
    adjustTrustScore(bounty.creator_tg_id, -10);
    adjustTrustScore(bounty.assignee_tg_id, 5);
  } else if (decision === "full_return") {
    // Work not delivered — worker loses, creator gains
    adjustTrustScore(bounty.assignee_tg_id, -15);
    adjustTrustScore(bounty.creator_tg_id, 3);
  }
  // split and mediated: no reputation change (reasonable disagreement)
}

/**
 * Adjust trust score for a user. Uses atomic UPDATE where possible.
 * Clamped to [-100, 100] range.
 */
function adjustTrustScore(tgId, delta) {
  if (!tgId || typeof delta !== "number" || !Number.isFinite(delta)) return;
  const d = raw();
  const key = "trust_delta_" + tgId;
  const now = Math.floor(Date.now() / 1000);
  // Atomic upsert with clamping: MIN(100, MAX(-100, current + delta))
  const updated = d.prepare(
    "UPDATE platform_config SET value = CAST(MIN(100, MAX(-100, CAST(value AS REAL) + ?)) AS TEXT), updated_at = ? WHERE key = ?"
  ).run(delta, now, key);
  if (updated.changes === 0) {
    const clamped = Math.max(-100, Math.min(100, delta));
    d.prepare("INSERT OR IGNORE INTO platform_config (key, value) VALUES (?, ?)").run(key, String(clamped));
  }
}

// ── Queries ──

function getDispute(id) {
  return raw().prepare("SELECT * FROM disputes WHERE id = ?").get(id);
}

/**
 * The Telegram id of the OTHER disputant relative to `tgId` — i.e. the
 * counterparty, never the arbiter. Returns null if the dispute doesn't
 * exist or `tgId` isn't one of its two parties (e.g. it's the arbiter, or
 * a stale/mismatched id) — callers must treat null as "cannot notify",
 * never guess a fallback recipient.
 */
function getOtherPartyTgId(disputeId, tgId) {
  const dispute = getDispute(disputeId);
  if (!dispute) return null;
  if (dispute.raised_by_tg_id === tgId) return dispute.raised_against_tg_id;
  if (dispute.raised_against_tg_id === tgId) return dispute.raised_by_tg_id;
  return null;
}

function getDisputesByBounty(bountyId) {
  return raw().prepare("SELECT * FROM disputes WHERE bounty_id = ? ORDER BY created_at DESC").all(bountyId);
}

function getDisputeEvidence(disputeId) {
  return raw().prepare("SELECT * FROM dispute_evidence WHERE dispute_id = ? ORDER BY created_at ASC").all(disputeId);
}

function getDisputeTimeline(disputeId) {
  return raw().prepare("SELECT * FROM dispute_timeline WHERE dispute_id = ? ORDER BY created_at ASC").all(disputeId);
}

function getOpenDisputes() {
  return raw().prepare(
    "SELECT d.*, b.title as bounty_title, b.reward_xrd FROM disputes d LEFT JOIN bounties b ON d.bounty_id = b.id WHERE d.status NOT IN ('final','cancelled') ORDER BY d.created_at DESC"
  ).all();
}

function getAllDisputes(limit = 50) {
  return raw().prepare(
    "SELECT d.*, b.title as bounty_title, b.reward_xrd FROM disputes d LEFT JOIN bounties b ON d.bounty_id = b.id ORDER BY d.created_at DESC LIMIT ?"
  ).all(Math.min(limit, 200));
}

function getDisputeStats() {
  const d = raw();
  return {
    open: d.prepare("SELECT COUNT(*) as c FROM disputes WHERE status IN ('open','assigned','reviewing')").get().c,
    decided: d.prepare("SELECT COUNT(*) as c FROM disputes WHERE status = 'decided'").get().c,
    appealed: d.prepare("SELECT COUNT(*) as c FROM disputes WHERE status = 'appealed'").get().c,
    final: d.prepare("SELECT COUNT(*) as c FROM disputes WHERE status = 'final'").get().c,
    cancelled: d.prepare("SELECT COUNT(*) as c FROM disputes WHERE status = 'cancelled'").get().c,
    total: d.prepare("SELECT COUNT(*) as c FROM disputes").get().c,
  };
}

/**
 * Check for overdue disputes (arbiter didn't decide within deadline).
 * Includes both 'assigned' and 'reviewing' status.
 */
function checkOverdueDisputes() {
  const d = raw();
  const now = Math.floor(Date.now() / 1000);

  const overdue = d.prepare(
    "SELECT * FROM disputes WHERE status IN ('assigned', 'reviewing') AND arbiter_deadline IS NOT NULL AND arbiter_deadline < ?"
  ).all(now);

  const results = [];
  for (const dispute of overdue) {
    arbiterService.adjustReputation(dispute.arbiter_tg_id, -5);
    arbiterService.updateAvailability(dispute.arbiter_tg_id, "unavailable");

    addTimelineEvent(dispute.id, "arbiter_timeout", dispute.arbiter_tg_id,
      "Arbiter timed out — reassigning");

    const reassign = assignArbiter(dispute.id);
    results.push({
      disputeId: dispute.id,
      timedOutArbiter: dispute.arbiter_tg_id,
      reassigned: reassign.ok || false,
      newArbiter: reassign.arbiterTgId || null,
    });
  }

  return results;
}

/**
 * Get full dispute detail (for API/dashboard).
 */
function getDisputeDetail(id) {
  const dispute = getDispute(id);
  if (!dispute) return null;

  const evidence = getDisputeEvidence(id);
  const timeline = getDisputeTimeline(id);
  const bounty = raw().prepare("SELECT * FROM bounties WHERE id = ?").get(dispute.bounty_id);
  const arbiter = dispute.arbiter_tg_id ? arbiterService.getArbiterStats(dispute.arbiter_tg_id) : null;

  return { ...dispute, evidence, timeline, bounty, arbiter };
}

module.exports = {
  init,
  raiseDispute,
  assignArbiter,
  addEvidence,
  requestClarification,
  makeDecision,
  fileAppeal,
  decideAppeal,
  getDispute,
  getOtherPartyTgId,
  getDisputesByBounty,
  getDisputeEvidence,
  getDisputeTimeline,
  getOpenDisputes,
  getAllDisputes,
  getDisputeStats,
  getDisputeDetail,
  checkOverdueDisputes,
  adjustTrustScore,
};
