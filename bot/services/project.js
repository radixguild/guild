/**
 * Project Pipeline Service — Phase 6
 *
 * End-to-end flow: idea → temp check → proposal → vote → breakdown → build → ship
 *
 * Connects governance (proposals, voting) with the task market (Phase 5) and
 * records completed projects in the ledger for accountability.
 */

const crypto = require("crypto");

let db;

function init(dbModule) {
  db = dbModule;
}

function raw() {
  if (!db) throw new Error("Project service not initialized — call init(db) first");
  return db._raw();
}

// ── Pipeline stage transitions ──

const VALID_TRANSITIONS = {
  idea:       ["temp_check", "cancelled"],
  temp_check: ["proposed", "cancelled"],
  proposed:   ["approved", "cancelled"],
  approved:   ["active", "cancelled"],
  active:     ["review", "cancelled"],
  review:     ["shipped", "active"],  // can go back to active if issues found
  shipped:    [],
  cancelled:  [],
};

function advanceStage(groupId, newStage) {
  const d = raw();
  const group = d.prepare("SELECT * FROM working_groups WHERE id = ?").get(groupId);
  if (!group) return { error: "group_not_found" };

  const current = group.project_status || "idea";
  const allowed = VALID_TRANSITIONS[current] || [];
  if (!allowed.includes(newStage)) {
    return { error: "invalid_transition", detail: "Cannot go from '" + current + "' to '" + newStage + "'" };
  }

  d.prepare("UPDATE working_groups SET project_status = ? WHERE id = ?").run(newStage, groupId);
  return { ok: true, from: current, to: newStage };
}

// ── Project breakdown (batch task creation) ──

/**
 * Create multiple tasks for a project at once.
 * tasks: [{ title, skills, reward_xrd, criteria, difficulty, deadline_days, depends_on_indices, phase }]
 *   depends_on_indices: array of 0-based indices into THIS array (resolved to bounty IDs after creation)
 */
function breakdownProject(groupId, tasks) {
  const d = raw();
  const group = d.prepare("SELECT * FROM working_groups WHERE id = ?").get(groupId);
  if (!group) return { error: "group_not_found" };

  if (!tasks || tasks.length === 0) return { error: "no_tasks" };
  if (tasks.length > 50) return { error: "too_many_tasks", detail: "Max 50 tasks per breakdown" };

  const createdIds = [];
  let totalBudget = 0;

  const doBreakdown = d.transaction(() => {
    // First pass: create all bounties
    for (const task of tasks) {
      const reward = task.reward_xrd || 0;
      const deadlineSec = task.deadline_days
        ? Math.floor(Date.now() / 1000) + (task.deadline_days * 86400)
        : null;

      const result = d.prepare(
        "INSERT INTO bounties (title, description, reward_xrd, creator_tg_id, group_id, skills_required, acceptance_criteria, difficulty, deadline, category, escrow_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 4)"
      ).run(
        task.title, task.description || null, reward,
        group.lead_tg_id, groupId,
        task.skills || null, task.criteria || null,
        task.difficulty || "medium", deadlineSec, task.category || "general"
      );
      createdIds.push(result.lastInsertRowid);
      totalBudget += reward;
    }

    // Second pass: set up dependencies (using indices into tasks array → resolved IDs)
    for (let i = 0; i < tasks.length; i++) {
      const depIndices = tasks[i].depends_on_indices || [];
      for (const depIdx of depIndices) {
        if (depIdx >= 0 && depIdx < createdIds.length && depIdx !== i) {
          // Direct SQL — addDependency does validation we don't need inside a transaction
          const bountyId = createdIds[i];
          const depBountyId = createdIds[depIdx];

          const bounty = d.prepare("SELECT depends_on FROM bounties WHERE id = ?").get(bountyId);
          const dep = d.prepare("SELECT blocks FROM bounties WHERE id = ?").get(depBountyId);
          const currentDeps = JSON.parse(bounty?.depends_on || "[]");
          const currentBlocks = JSON.parse(dep?.blocks || "[]");

          if (!currentDeps.includes(depBountyId)) currentDeps.push(depBountyId);
          if (!currentBlocks.includes(bountyId)) currentBlocks.push(bountyId);

          d.prepare("UPDATE bounties SET depends_on = ?, is_blocked = 1 WHERE id = ?")
            .run(JSON.stringify(currentDeps), bountyId);
          d.prepare("UPDATE bounties SET blocks = ? WHERE id = ?")
            .run(JSON.stringify(currentBlocks), depBountyId);
        }
      }
    }

    // Update project budget — only advance to 'active' if currently 'approved'
    const currentStatus = group.project_status || "idea";
    const validForActive = VALID_TRANSITIONS[currentStatus] || [];
    const newStatus = validForActive.includes("active") ? "active" : currentStatus;
    d.prepare("UPDATE working_groups SET total_budget_xrd = ?, project_status = ? WHERE id = ?")
      .run(totalBudget, newStatus, groupId);
  });

  try {
    doBreakdown();
  } catch (e) {
    return { error: "db_error", detail: e.message };
  }

  return {
    ok: true,
    groupId,
    taskIds: createdIds,
    taskCount: createdIds.length,
    totalBudget,
  };
}

// ── Enhanced project status ──

function getFullProjectStatus(groupId) {
  const d = raw();
  const group = d.prepare("SELECT * FROM working_groups WHERE id = ?").get(groupId);
  if (!group) return null;

  const tasks = d.prepare("SELECT * FROM bounties WHERE group_id = ? ORDER BY id").all(groupId);
  if (tasks.length === 0) return { group, tasks: [], progress: null, pipeline: group.project_status || "idea" };

  const completed = tasks.filter(t => t.status === "paid");
  const inProgress = tasks.filter(t => ["assigned", "submitted", "verified"].includes(t.status));
  const blocked = tasks.filter(t => t.is_blocked && t.status === "open");
  const open = tasks.filter(t => t.status === "open" && !t.is_blocked);
  const disputed = tasks.filter(t => t.status === "disputed");
  const cancelled = tasks.filter(t => t.status === "cancelled");

  const totalBudget = tasks.reduce((s, t) => s + (t.reward_xrd || 0), 0);
  const spent = completed.reduce((s, t) => s + (t.reward_xrd || 0), 0);
  const totalInsurance = tasks.reduce((s, t) => s + (t.insurance_fee_xrd || 0), 0);

  // Contributor breakdown
  const contribMap = {};
  for (const t of tasks.filter(t => t.assignee_tg_id)) {
    const key = t.assignee_tg_id;
    if (!contribMap[key]) contribMap[key] = { tg_id: key, tasks: 0, completed: 0, earned_xrd: 0 };
    contribMap[key].tasks++;
    if (t.status === "paid") {
      contribMap[key].completed++;
      contribMap[key].earned_xrd += t.reward_xrd || 0;
    }
  }
  const contributors = Object.values(contribMap);

  // Active tasks (for quick view)
  const activeTasks = inProgress.map(t => ({
    id: t.id, title: t.title, reward_xrd: t.reward_xrd,
    assignee_tg_id: t.assignee_tg_id, status: t.status,
    deadline: t.deadline,
  }));

  const blockedTasks = blocked.map(t => {
    const deps = JSON.parse(t.depends_on || "[]");
    return { id: t.id, title: t.title, waiting_on: deps };
  });

  return {
    group,
    pipeline: group.project_status || "idea",
    progress: {
      total_tasks: tasks.length,
      completed: completed.length,
      in_progress: inProgress.length,
      blocked: blocked.length,
      open: open.length,
      disputed: disputed.length,
      cancelled: cancelled.length,
      progress_pct: tasks.length > 0 ? Math.round((completed.length / tasks.length) * 100) : 0,
    },
    budget: {
      total: totalBudget,
      spent,
      remaining: totalBudget - spent,
      insurance: totalInsurance,
    },
    contributors,
    activeTasks,
    blockedTasks,
    tasks,
  };
}

// ── Completion + Ledger ──

function checkProjectCompletion(groupId) {
  const d = raw();
  const tasks = d.prepare("SELECT * FROM bounties WHERE group_id = ?").all(groupId);
  if (tasks.length === 0) return { complete: false, reason: "no_tasks" };

  const allDone = tasks.every(t => ["paid", "cancelled"].includes(t.status));
  const completed = tasks.filter(t => t.status === "paid").length;
  const cancelled = tasks.filter(t => t.status === "cancelled").length;

  // Require at least one paid task — 100% cancelled is not "complete"
  const isComplete = allDone && completed > 0;

  return {
    complete: isComplete,
    total: tasks.length,
    completed,
    cancelled,
    remaining: tasks.length - completed - cancelled,
    reason: allDone && completed === 0 ? "all_cancelled" : undefined,
  };
}

function computeDeliverableHash(groupId) {
  const d = raw();
  const tasks = d.prepare("SELECT * FROM bounties WHERE group_id = ? AND status = 'paid' ORDER BY id").all(groupId);
  const urls = tasks
    .map(t => t.github_pr || t.github_issue || "")
    .filter(Boolean)
    .sort();
  if (urls.length === 0) return null;
  return crypto.createHash("sha256").update(urls.join("\n")).digest("hex");
}

function shipProject(groupId, outcomeNotes) {
  const d = raw();
  const group = d.prepare("SELECT * FROM working_groups WHERE id = ?").get(groupId);
  if (!group) return { error: "group_not_found" };

  // Validate stage transition — must be in 'review' or 'active' to ship
  const current = group.project_status || "idea";
  const allowed = VALID_TRANSITIONS[current] || [];
  if (!allowed.includes("shipped") && current !== "active") {
    return { error: "invalid_stage", detail: "Cannot ship from '" + current + "' stage. Must be in 'review' or 'active'" };
  }

  const completion = checkProjectCompletion(groupId);
  if (!completion.complete) {
    return { error: "not_complete", detail: completion.remaining + " tasks not yet resolved (paid or cancelled)" };
  }

  const tasks = d.prepare("SELECT * FROM bounties WHERE group_id = ?").all(groupId);
  const completed = tasks.filter(t => t.status === "paid");
  const cancelled = tasks.filter(t => t.status === "cancelled");
  const totalSpent = completed.reduce((s, t) => s + (t.reward_xrd || 0), 0);
  const totalInsurance = tasks.reduce((s, t) => s + (t.insurance_fee_xrd || 0), 0);

  // Disputes count
  const disputeCount = d.prepare(
    "SELECT COUNT(*) as c FROM disputes WHERE bounty_id IN (SELECT id FROM bounties WHERE group_id = ?)"
  ).get(groupId).c;

  // Contributors
  const contribMap = {};
  for (const t of completed) {
    if (!t.assignee_tg_id) continue;
    if (!contribMap[t.assignee_tg_id]) contribMap[t.assignee_tg_id] = { tg_id: t.assignee_tg_id, tasks: 0, earned_xrd: 0 };
    contribMap[t.assignee_tg_id].tasks++;
    contribMap[t.assignee_tg_id].earned_xrd += t.reward_xrd || 0;
  }

  // Deliverables
  const deliverables = completed
    .filter(t => t.github_pr || t.github_issue)
    .map(t => ({ type: t.github_pr ? "pr" : "issue", url: t.github_pr || t.github_issue, task_id: t.id }));

  const hash = computeDeliverableHash(groupId);
  const now = Math.floor(Date.now() / 1000);
  const createdDates = tasks.map(t => t.created_at).filter(d => typeof d === "number" && d > 0);
  const startDate = createdDates.length > 0 ? Math.min(...createdDates) : now;
  const actualDays = Math.max(1, Math.ceil((now - startDate) / 86400));

  const doShip = d.transaction(() => {
    // Record ledger entry
    d.prepare(`
      INSERT INTO project_ledger (group_id, title, description, total_budget_xrd, total_spent_xrd,
        total_insurance_xrd, total_disputes, contributor_count, task_count, tasks_completed,
        tasks_cancelled, start_date, ship_date, actual_duration_days, deliverables,
        deliverable_hash, contributors, outcome_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      groupId, group.name, group.description,
      group.total_budget_xrd ?? totalSpent, totalSpent, totalInsurance, disputeCount,
      Object.keys(contribMap).length, tasks.length, completed.length, cancelled.length,
      startDate, now, actualDays,
      JSON.stringify(deliverables), hash,
      JSON.stringify(Object.values(contribMap)),
      outcomeNotes || null
    );

    // Update project status
    d.prepare("UPDATE working_groups SET project_status = 'shipped', shipped_at = ?, ledger_hash = ?, budget_spent_xrd = ? WHERE id = ?")
      .run(now, hash, totalSpent, groupId);
  });

  try {
    doShip();
  } catch (e) {
    return { error: "db_error", detail: e.message };
  }

  return {
    ok: true,
    groupId,
    title: group.name,
    tasks_completed: completed.length,
    tasks_cancelled: cancelled.length,
    total_spent: totalSpent,
    total_insurance: totalInsurance,
    disputes: disputeCount,
    contributors: Object.values(contribMap),
    deliverable_count: deliverables.length,
    deliverable_hash: hash,
    actual_days: actualDays,
  };
}

// ── Ledger queries ──

function getLedgerEntries(limit = 20) {
  return raw().prepare("SELECT * FROM project_ledger ORDER BY ship_date DESC LIMIT ?").all(limit);
}

function getLedgerEntry(groupId) {
  return raw().prepare("SELECT * FROM project_ledger WHERE group_id = ? ORDER BY ship_date DESC").get(groupId);
}

module.exports = {
  init,
  advanceStage,
  breakdownProject,
  getFullProjectStatus,
  checkProjectCompletion,
  computeDeliverableHash,
  shipProject,
  getLedgerEntries,
  getLedgerEntry,
};
