'use strict';
// What an /api/agent/* read may show (2026-10-06).
//
// The agent routes are the bot's only internet-reachable HTTP surface, and until this
// file they returned raw table rows: every *_tg_id (task creators, assignees, project
// leads, contributors, applicants) next to wallet addresses, so any key with tasks:read
// could join a Telegram account to a wallet, and read every applicant's pitch.
//
// Each projection below is an ALLOWLIST: a column added to a table later stays private
// until someone adds it here. No projection carries a *_tg_id. An application's
// applicant address and pitch are shown only to the agent that created the task.
// Field names are unchanged, so the response shape is otherwise what it was.

const TASK_FIELDS = [
  "id", "title", "description", "description_long", "reward_xrd", "reward_xp", "status",
  "creator_address", "assignee_address", "github_issue", "github_pr", "proposal_id",
  "created_at", "assigned_at", "submitted_at", "verified_at", "paid_at", "paid_tx",
  "category", "difficulty", "deadline", "acceptance_criteria", "tags", "skills_required",
  "priority", "platform_fee_pct", "fee_collected_xrd", "cancelled_at", "cancel_reason", "source",
  "onchain_task_id", "escrow_verified", "escrow_component", "approval_type", "approval_repo",
  "approval_pr", "approval_criteria", "approval_branch", "auto_released_at", "claimed_by_agent",
  "escrow_version", "group_id", "insurance_fee_xrd", "insurance_fee_pct", "insurance_status",
  "depends_on", "blocks", "is_blocked", "funded",
];
const MATCH_FIELDS = ["match_score", "matched_skills", "missing_skills"];
const MILESTONE_FIELDS = [
  "id", "bounty_id", "title", "description", "percentage", "amount_xrd", "status",
  "submitted_at", "verified_at", "paid_at", "paid_tx",
];
const APPLICATION_FIELDS = ["id", "bounty_id", "status", "estimated_hours", "created_at"];
const APPLICATION_FIELDS_FOR_CREATOR = [...APPLICATION_FIELDS, "applicant_address", "pitch"];
const PROPOSAL_FIELDS = [
  "id", "title", "type", "options", "status", "parent_id", "round", "created_at", "ends_at",
  "min_votes", "stage", "category", "group_id",
];
const GROUP_FIELDS = [
  "id", "name", "description", "icon", "lead_address", "status", "created_at", "charter",
  "budget_monthly", "budget_spent", "sunset_date", "sunset_alert_sent", "project_status",
  "proposal_id", "total_budget_xrd", "budget_spent_xrd", "shipped_at", "ledger_hash",
];
const CONTRIBUTOR_FIELDS = ["tasks", "completed", "earned_xrd"];
const ACTIVE_TASK_FIELDS = ["id", "title", "reward_xrd", "status", "deadline"];
const BLOCKED_TASK_FIELDS = ["id", "title", "waiting_on"];
const KEY_FIELDS = [
  "id", "name", "scopes", "rate_limit_per_hour", "daily_budget_xrd", "enabled", "created_at", "last_used_at",
];
const ACTIVITY_FIELDS = ["id", "agent_key_id", "agent_name", "action", "params", "result", "created_at"];

function pick(row, fields) {
  if (!row || typeof row !== "object") return row;
  const out = {};
  for (const f of fields) if (Object.prototype.hasOwnProperty.call(row, f)) out[f] = row[f];
  return out;
}
const list = (rows, fields) => (Array.isArray(rows) ? rows.map((r) => pick(r, fields)) : rows);

const task = (row) => pick(row, TASK_FIELDS);
const matchedTask = (row) => pick(row, [...TASK_FIELDS, ...MATCH_FIELDS]);

/** GET /api/agent/tasks/:id — viewerIsCreator: the calling agent created this task. */
function taskDetail(detail, { viewerIsCreator = false } = {}) {
  if (!detail) return detail;
  return {
    ...task(detail),
    milestones: list(detail.milestones || [], MILESTONE_FIELDS),
    applications: list(detail.applications || [], viewerIsCreator ? APPLICATION_FIELDS_FOR_CREATOR : APPLICATION_FIELDS),
  };
}

const proposal = (row) => pick(row, PROPOSAL_FIELDS);

/** GET /api/agent/projects/:id — services/project.js getFullProjectStatus, both shapes. */
function projectStatus(status) {
  if (!status) return status;
  const out = { group: pick(status.group, GROUP_FIELDS), pipeline: status.pipeline, progress: status.progress };
  if ("budget" in status) out.budget = status.budget;
  if ("contributors" in status) out.contributors = list(status.contributors, CONTRIBUTOR_FIELDS);
  if ("activeTasks" in status) out.activeTasks = list(status.activeTasks, ACTIVE_TASK_FIELDS);
  if ("blockedTasks" in status) out.blockedTasks = list(status.blockedTasks, BLOCKED_TASK_FIELDS);
  out.tasks = list(status.tasks || [], TASK_FIELDS);
  return out;
}

const key = (row) => pick(row, KEY_FIELDS);
const activity = (row) => pick(row, ACTIVITY_FIELDS);

module.exports = { task, matchedTask, taskDetail, proposal, projectStatus, key, activity };
